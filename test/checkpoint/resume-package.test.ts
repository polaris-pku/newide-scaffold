import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core';
import {
  buildResumePackage,
  buildSafepointCheckpoint,
  ResumePackageError,
} from '../../src/checkpoint';
import {
  SqliteCoordinationStore,
  type PersistedFullCheckpoint,
  type PersistedTaskAggregate,
} from '../../src/persistence';
import { TaskProcessor } from '../../src/app/task-processor';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('ResumePackage', () => {
  it('builds a package with cursor/session/workspace/artifact/mailbox/file_anchor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-resume-pkg-'));
    const store = new SqliteCoordinationStore(path.join(root, 'coordination.sqlite'));
    const processor = new TaskProcessor(store, { mailboxStore: store });

    try {
      processor.beginRun({
        task_id: 'task_pkg',
        run_id: 'run_pkg',
        task_request: {
          spec: 'Build resume package',
          completion_criteria: ['package exists'],
        },
        workspace_path: root,
        mode: 'single_agent',
        session_id: 'session_pkg',
        cursor_input: {
          cursor: 'select_agent',
          seed: 'run_pkg',
          candidate_ids: ['agent_a'],
        },
      });
      processor.startStage({
        run_id: 'run_pkg',
        expected_cursor: 'select_agent',
        invocation_id: 'inv_select',
      });
      processor.advanceStage({
        run_id: 'run_pkg',
        expected_cursor: 'select_agent',
        invocation_id: 'inv_select',
        evidence_ref: { uri: 'file:///evidence/select.json', sha256: 'b'.repeat(64) },
        next_input: {
          cursor: 'execute_agent',
          winner_agent_id: 'agent_a',
        },
        artifact_refs: ['artifact_select'],
      });
      processor.startStage({
        run_id: 'run_pkg',
        expected_cursor: 'execute_agent',
        invocation_id: 'inv_exec',
      });
      processor.advanceStage({
        run_id: 'run_pkg',
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

      // Force interrupt recovery path.
      const snapshots = processor.recoverInterruptedTasks();
      expect(snapshots[0]?.task.status).toBe('blocked');

      const pkg = processor.buildResumePackage('task_pkg');
      expect(pkg).toMatchObject({
        task_id: 'task_pkg',
        interrupted_run_id: 'run_pkg',
        session_id: 'session_pkg',
        workspace_path: root,
        resume_cursor: 'gate',
        cursor_input: {
          cursor: 'gate',
          changeset_ref: 'artifact_gate',
        },
      });
      expect(pkg.file_anchor.worktree_path).toBeTruthy();
      expect(Array.isArray(pkg.mailbox.pending_deliveries)).toBe(true);
      expect(pkg.artifact_refs).toContain('artifact_gate');
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses resume when cursor_input cannot be reconstructed', () => {
    const aggregate = fakeAggregate({
      resume_cursor: 'gate',
      artifact_refs: [],
    });
    const checkpoint = fakeCheckpoint({
      resume_cursor: 'gate',
      artifact_refs: [],
    });
    expect(() => buildResumePackage({ aggregate, checkpoint })).toThrow(ResumePackageError);
  });

  it('persists cursor_input on safepoint checkpoints', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-safepoint-'));
    const store = new SqliteCoordinationStore(path.join(root, 'coordination.sqlite'));
    const processor = new TaskProcessor(store);

    try {
      processor.beginRun({
        task_id: 'task_safe',
        run_id: 'run_safe',
        task_request: {
          spec: 'Safepoint',
          completion_criteria: ['ok'],
        },
        workspace_path: root,
        mode: 'single_agent',
        cursor_input: {
          cursor: 'select_agent',
          seed: 'run_safe',
          candidate_ids: ['agent_a'],
        },
      });
      const aggregate = store.getTaskAggregate('task_safe')!;
      const checkpoint = buildSafepointCheckpoint({
        aggregate,
        run_id: 'run_safe',
        trigger: 'periodic',
      });
      expect(checkpoint.cursor_input).toEqual({
        cursor: 'select_agent',
        seed: 'run_safe',
        candidate_ids: ['agent_a'],
      });
      expect(checkpoint.mechanical_snapshot.worktree_path).toContain(root);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fakeAggregate(input: {
  resume_cursor: PersistedFullCheckpoint['resume_cursor'];
  artifact_refs: string[];
}): PersistedTaskAggregate {
  return {
    task: {
      task_id: 'task_fake',
      status: 'blocked',
      risk_level: 'low',
      spec: 'fake',
      completion_criteria: [],
      affected_paths: [],
      workspace_path: '/tmp',
      warnings: [],
      revision: 2,
      created_at: '2026-07-27T00:00:00.000Z',
      updated_at: '2026-07-27T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    },
    runs: [
      {
        run_id: 'run_fake',
        task_id: 'task_fake',
        status: 'interrupted',
        mode: 'single_agent',
        workspace_path: '/tmp',
        revision: 2,
        created_at: '2026-07-27T00:00:00.000Z',
        updated_at: '2026-07-27T00:00:00.000Z',
        schema_version: SCHEMA_VERSION,
      },
    ],
    runtime_state: {
      task_id: 'task_fake',
      resume_cursor: input.resume_cursor,
      waiting_on: [],
      artifact_refs: input.artifact_refs,
      diagnostics: {},
      updated_at: '2026-07-27T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    },
    events: [],
  };
}

function fakeCheckpoint(input: {
  resume_cursor: PersistedFullCheckpoint['resume_cursor'];
  artifact_refs: string[];
}): PersistedFullCheckpoint {
  return {
    checkpoint_id: 'checkpoint_fake',
    task_id: 'task_fake',
    run_id: 'run_fake',
    agent_id: 'coordinator',
    trigger: 'blocked',
    resume_cursor: input.resume_cursor,
    message_thread: [],
    mechanical_snapshot: {
      base_commit: 'unavailable:git_unavailable',
      worktree_path: '/tmp',
      branch: 'unavailable',
      modified_files: [],
    },
    semantic_handoff: {
      done: [],
      in_progress: [input.resume_cursor],
      blocked_on: ['blocked'],
      assumptions: [],
      next_steps: [],
      known_risks: [],
    },
    artifact_refs: input.artifact_refs,
    validity_status: 'valid',
    created_at: '2026-07-27T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
