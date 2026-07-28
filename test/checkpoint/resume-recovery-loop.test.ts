import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TaskExecutionLoop,
  type TaskExecutionLoopExecutors,
} from '../../src/app/task-execution-loop';
import { TaskProcessor } from '../../src/app/task-processor';
import { buildResumePackage, ResumePackageError } from '../../src/checkpoint';
import {
  FileRunEvidenceStore,
  SqliteCoordinationStore,
  type TaskCursorInput,
} from '../../src/persistence';

/**
 * Manual-path analogue: kill process → recover → from_checkpoint resume → continue from cursor.
 */
describe('resume recovery loop (kill → recover → resume)', () => {
  it('resumes at gate and does not re-run select_agent or execute_agent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-resume-loop-'));
    const dbPath = path.join(root, 'coordination.sqlite');
    const runsRoot = path.join(root, 'runs');
    const workspace = root;

    const seedStore = new SqliteCoordinationStore(dbPath);
    const seedProcessor = new TaskProcessor(seedStore);
    try {
      seedProcessor.beginRun({
        task_id: 'task_kill_resume',
        run_id: 'run_interrupted',
        task_request: {
          spec: 'Survive process restart',
          completion_criteria: ['resume from gate'],
        },
        workspace_path: workspace,
        mode: 'single_agent',
        session_id: 'session_survive',
        cursor_input: {
          cursor: 'select_agent',
          seed: 'run_interrupted',
          candidate_ids: ['agent_a'],
        },
      });
      advanceToGate(seedProcessor, 'run_interrupted');
      expect(seedStore.getTaskAggregate('task_kill_resume')?.runtime_state.resume_cursor).toBe(
        'gate',
      );
    } finally {
      seedStore.close();
    }

    // Simulate process death: reopen DB and recover active runs.
    const store = new SqliteCoordinationStore(dbPath);
    const processor = new TaskProcessor(store, { mailboxStore: store });
    const recovered = processor.recoverInterruptedTasks();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.task.status).toBe('blocked');

    const resumePackage = processor.buildResumePackage('task_kill_resume');
    expect(resumePackage).toMatchObject({
      interrupted_run_id: 'run_interrupted',
      session_id: 'session_survive',
      resume_cursor: 'gate',
      cursor_input: {
        cursor: 'gate',
        changeset_ref: 'artifact_gate',
        expected_sha256: 'a'.repeat(64),
      },
    });
    expect(resumePackage.file_anchor.worktree_path).toBeTruthy();

    const calls: string[] = [];
    const executors = trackingExecutors(calls);
    const evidenceStore = new FileRunEvidenceStore({ root: runsRoot });
    const loop = new TaskExecutionLoop({
      processor,
      evidence_store: evidenceStore,
      executors,
    });

    processor.beginRun({
      task_id: 'task_kill_resume',
      run_id: 'run_resumed',
      task_request: resumePackage.task_request,
      workspace_path: resumePackage.workspace_path,
      mode: resumePackage.mode,
      session_id: resumePackage.session_id,
      run_intent: { type: 'checkpoint_resume', strategy: 'from_checkpoint' },
      restarted_from_run_id: resumePackage.interrupted_run_id,
      resume_checkpoint_id: resumePackage.checkpoint_id,
      requested_resume_cursor: resumePackage.resume_cursor,
      cursor_input: resumePackage.cursor_input,
    });

    expect(store.getTaskAggregate('task_kill_resume')?.runtime_state).toMatchObject({
      current_run_id: 'run_resumed',
      resume_cursor: 'gate',
      cursor_input: { cursor: 'gate' },
      diagnostics: {
        resume_strategy: 'from_checkpoint',
        resume_checkpoint_id: resumePackage.checkpoint_id,
      },
    });

    const completed = await loop.run({
      task_id: 'task_kill_resume',
      run_id: 'run_resumed',
    });

    expect(calls).toEqual(['gate', 'deliver']);
    expect(calls).not.toContain('select_agent');
    expect(calls).not.toContain('execute_agent');
    expect(completed).toMatchObject({
      task: { status: 'completed' },
      run_history: expect.arrayContaining([
        expect.objectContaining({ run_id: 'run_resumed', status: 'completed' }),
        expect.objectContaining({ run_id: 'run_interrupted', status: 'interrupted' }),
      ]),
    });

    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('refuses silent restart when cursor_input cannot be rebuilt', () => {
    const store = new SqliteCoordinationStore(':memory:');
    const processor = new TaskProcessor(store);
    processor.beginRun({
      task_id: 'task_no_cursor',
      run_id: 'run_no_cursor',
      task_request: {
        spec: 'Broken legacy projection',
        completion_criteria: ['fail loudly'],
      },
      workspace_path: '/tmp/no-cursor',
      mode: 'single_agent',
    });
    // Project to gate via legacy event, then leave no reconstructible changeset.
    processor.recordRunEvent('run_no_cursor', {
      event_id: 'event_legacy_exec',
      event_type: 'agent.execution_completed',
      subject_id: 'agent_x',
      task_id: 'task_no_cursor',
      run_id: 'run_no_cursor',
      payload: { agent_id: 'agent_x' },
      created_at: '2026-07-27T10:00:00.000Z',
      schema_version: 'v0',
    });
    processor.recoverInterruptedTasks();
    const latest = store.getLatestCheckpoint('task_no_cursor')!;
    // Force an unusable gate cursor_input off the package path by clearing artifacts
    // and cursor_input on the in-memory aggregate view used by buildResumePackage.
    const aggregate = store.getTaskAggregate('task_no_cursor')!;
    expect(() =>
      processor.beginRun({
        task_id: 'task_no_cursor',
        run_id: 'run_bad_resume',
        task_request: {
          spec: 'Broken legacy projection',
          completion_criteria: ['fail loudly'],
        },
        workspace_path: '/tmp/no-cursor',
        mode: 'single_agent',
        run_intent: { type: 'checkpoint_resume', strategy: 'from_checkpoint' },
        restarted_from_run_id: latest.run_id,
        resume_checkpoint_id: latest.checkpoint_id,
        requested_resume_cursor: latest.resume_cursor,
        // Default cursor_input is select_agent; must not silently restart.
      }),
    ).toThrow(/cursor does not match strategy from_checkpoint/i);

    // If someone forces from_checkpoint at gate without reconstructible input, package build fails.
    const bareAggregate = {
      ...aggregate,
      runtime_state: {
        ...aggregate.runtime_state,
        artifact_refs: [],
        resume_cursor: 'gate' as const,
      },
    };
    const bareCheckpoint = {
      ...latest,
      resume_cursor: 'gate' as const,
      artifact_refs: [],
      cursor_input: undefined,
    };
    expect(() =>
      buildResumePackage({ aggregate: bareAggregate, checkpoint: bareCheckpoint }),
    ).toThrow(ResumePackageError);

    store.close();
  });
});

function advanceToGate(processor: TaskProcessor, runId: string): void {
  processor.startStage({
    run_id: runId,
    expected_cursor: 'select_agent',
    invocation_id: 'inv_select',
  });
  processor.advanceStage({
    run_id: runId,
    expected_cursor: 'select_agent',
    invocation_id: 'inv_select',
    evidence_ref: { uri: 'file:///evidence/select.json', sha256: 'b'.repeat(64) },
    next_input: { cursor: 'execute_agent', winner_agent_id: 'agent_a' },
    artifact_refs: ['artifact_select'],
  });
  processor.startStage({
    run_id: runId,
    expected_cursor: 'execute_agent',
    invocation_id: 'inv_exec',
  });
  processor.advanceStage({
    run_id: runId,
    expected_cursor: 'execute_agent',
    invocation_id: 'inv_exec',
    evidence_ref: { uri: 'file:///evidence/exec.json', sha256: 'c'.repeat(64) },
    next_input: {
      cursor: 'gate',
      subject_ref: 'artifact_gate',
      phase: 'post_primary',
      changeset_ref: 'artifact_gate',
      expected_sha256: 'a'.repeat(64),
    },
    artifact_refs: ['artifact_gate'],
  });
}

function trackingExecutors(calls: string[]): TaskExecutionLoopExecutors {
  const track = <T>(cursor: TaskCursorInput['cursor'], result: T) =>
    vi.fn(async () => {
      calls.push(cursor);
      return result;
    });
  return {
    select_agent: {
      execute: track('select_agent', {
        winner_agent_id: 'agent_a',
        evidence: { winner_agent_id: 'agent_a' },
      }),
    },
    execute_agent: {
      execute: track('execute_agent', {
        changeset_ref: 'artifact_should_not_run',
        expected_sha256: 'd'.repeat(64),
        evidence: {},
      }),
    },
    council: {
      execute: track('council', {
        changeset_ref: 'artifact_council',
        expected_sha256: 'c'.repeat(64),
        evidence: {},
      }),
    },
    gate: {
      execute: track('gate', { evidence: { verdict: 'pass' } }),
    },
    deliver: {
      execute: vi.fn(async (context) => {
        calls.push('deliver');
        return {
          final_output: {
            artifact_ref: context.cursor_input.changeset_ref,
            sha256: context.cursor_input.expected_sha256,
            workspace_path: context.workspace_path,
          },
          evidence: { delivered: true },
        };
      }),
    },
  };
}
