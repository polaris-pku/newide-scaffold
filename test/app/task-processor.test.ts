import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type Event, type TaskCreateRequest } from '../../src/core';
import { TaskProcessor } from '../../src/app/task-processor';
import { SqliteCoordinationStore, type TaskCursorInput } from '../../src/persistence';
import type { RunSnapshot } from '../../src/protocol/run-snapshot';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('TaskProcessor', () => {
  it('begins a run and advances only through finite resume cursors', () => {
    const { processor, store } = createProcessor();
    const started = processor.beginRun({
      task_id: 'task_processor',
      run_id: 'run_processor',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
    });

    expect(started).toMatchObject({
      task: { task_id: 'task_processor', status: 'running' },
      current_run: { run_id: 'run_processor', status: 'running' },
    });
    expect(store.getTaskAggregate('task_processor')?.runtime_state.resume_cursor).toBe(
      'select_agent',
    );

    processor.recordRunEvent(
      'run_processor',
      event('event_market', 'market.selected', {
        winner_agent_id: 'role_ts_engineer',
      }),
    );
    expect(store.getTaskAggregate('task_processor')).toMatchObject({
      task: { owner_agent_id: 'role_ts_engineer' },
      runtime_state: {
        resume_cursor: 'execute_agent',
        diagnostics: {
          legacy_cursor_projection: true,
          last_event_id: 'event_market',
        },
      },
      events: [
        { event_type: 'task.created' },
        { event_type: 'run.created' },
        { event_type: 'run.started' },
        { event_id: 'event_market', event_type: 'market.selected' },
      ],
    });
    expect(store.getTaskAggregate('task_processor')?.runtime_state).not.toHaveProperty(
      'cursor_input',
    );

    processor.recordRunEvent(
      'run_processor',
      event('event_agent_done', 'agent.execution_completed'),
    );
    expect(store.getTaskAggregate('task_processor')?.runtime_state.resume_cursor).toBe('gate');
    expect(processor.listTaskEvents('task_processor', 'event_market')).toEqual([
      expect.objectContaining({
        event_id: 'event_agent_done',
        type: 'agent.execution_completed',
        source: 'agent',
      }),
    ]);
    expect(() => processor.listTaskEvents('task_processor', 'event_unknown')).toThrow(
      /event cursor/i,
    );
    store.close();
  });

  it('replays the full task event history when subscribe has no cursor', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_replay',
      run_id: 'run_replay',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
    });
    processor.recordRunEvent(
      'run_replay',
      stageEvent('event_market_replay', 'market.selected', 'task_replay', 'run_replay'),
    );

    expect(processor.listTaskEvents('task_replay')).toEqual([
      expect.objectContaining({ type: 'task.created' }),
      expect.objectContaining({ type: 'run.created' }),
      expect.objectContaining({ type: 'run.started' }),
      expect.objectContaining({
        event_id: 'event_market_replay',
        type: 'market.selected',
      }),
    ]);
    store.close();
  });

  it('persists a completed snapshot that survives a new processor instance', () => {
    const { databasePath, processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_restart',
      run_id: 'run_restart',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
    });

    const completed = processor.finishRun({
      run_id: 'run_restart',
      status: 'completed',
      snapshot: terminalSnapshot('run_restart', 'task_restart', 'single_agent'),
      final_output: {
        artifact_ref: 'artifact_final',
        sha256: 'b'.repeat(64),
        workspace_path: '/workspace/result.ts',
      },
    });
    expect(completed).toMatchObject({
      task: { status: 'completed' },
      run_history: [{ run_id: 'run_restart', status: 'completed' }],
      final_output: {
        artifact_refs: ['artifact_final'],
        files_written: ['/workspace/result.ts'],
      },
    });
    expect(completed.current_run).toBeUndefined();
    expect(store.getTaskAggregate('task_restart')?.runtime_state.cursor_input).toEqual({
      cursor: 'done',
    });
    store.close();

    const reopenedStore = new SqliteCoordinationStore(databasePath);
    const restartedProcessor = new TaskProcessor(reopenedStore, deterministicClock());
    expect(restartedProcessor.getTaskSnapshot('task_restart')).toEqual(completed);
    reopenedStore.close();
  });

  it('starts a Council run under the same completed Task without duplicating the Task', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_council',
      run_id: 'run_first',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
    });
    processor.finishRun({
      run_id: 'run_first',
      status: 'completed',
      snapshot: terminalSnapshot('run_first', 'task_council', 'single_agent'),
      final_output: {
        artifact_ref: 'artifact_first',
        sha256: 'c'.repeat(64),
        workspace_path: '/workspace/result.ts',
      },
    });

    expect(() =>
      processor.beginRun({
        task_id: 'task_council',
        run_id: 'run_illegal_restart',
        task_request: taskRequest,
        workspace_path: '/workspace',
        mode: 'council',
      }),
    ).toThrow(/run intent|create.*existing|refinement/i);

    const council = processor.beginRun({
      task_id: 'task_council',
      run_id: 'run_council',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'council',
      run_intent: { type: 'council_refinement' },
      cursor_input: {
        cursor: 'select_agent',
        seed: 'council-seed',
        candidate_ids: ['agent_a', 'agent_b'],
      },
    });

    expect(council).toMatchObject({
      task: { task_id: 'task_council', status: 'running' },
      current_run: { run_id: 'run_council', mode: 'council', status: 'running' },
      run_history: [{ run_id: 'run_first', status: 'completed' }],
    });
    expect(store.listTaskAggregates()).toHaveLength(1);
    expect(store.getTaskAggregate('task_council')?.runtime_state).toMatchObject({
      current_run_id: 'run_council',
      resume_cursor: 'select_agent',
      cursor_input: {
        cursor: 'select_agent',
        seed: 'council-seed',
        candidate_ids: ['agent_a', 'agent_b'],
      },
    });
    store.close();
  });

  it('starts a durable stage without moving its cursor and advances evidence atomically', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_stage',
      run_id: 'run_stage',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
      cursor_input: selectInput,
    });

    const started = processor.startStage({
      run_id: 'run_stage',
      expected_cursor: 'select_agent',
      invocation_id: 'invocation_select',
    });
    expect(started.committed_events).toEqual([
      expect.objectContaining({
        event_type: 'handler.started',
        payload: expect.objectContaining({
          cursor: 'select_agent',
          invocation_id: 'invocation_select',
        }),
      }),
    ]);
    expect(store.getTaskAggregate('task_stage')?.runtime_state).toMatchObject({
      resume_cursor: 'select_agent',
      cursor_input: selectInput,
      diagnostics: {
        active_stage: {
          cursor: 'select_agent',
          invocation_id: 'invocation_select',
        },
      },
    });

    const nextInput: TaskCursorInput = {
      cursor: 'execute_agent',
      winner_agent_id: 'agent_a',
      execution_evidence_ref: 'file:///evidence/select_agent.json',
    };
    const advanced = processor.advanceStage({
      run_id: 'run_stage',
      expected_cursor: 'select_agent',
      invocation_id: 'invocation_select',
      evidence_ref: {
        uri: 'file:///evidence/select_agent.json',
        sha256: 'a'.repeat(64),
      },
      next_input: nextInput,
    });
    expect(advanced.committed_events).toEqual([
      expect.objectContaining({
        event_type: 'handler.completed',
        payload: expect.objectContaining({
          cursor: 'select_agent',
          next_cursor: 'execute_agent',
          evidence_ref: 'file:///evidence/select_agent.json',
        }),
      }),
    ]);
    expect(store.getTaskAggregate('task_stage')).toMatchObject({
      task: { owner_agent_id: 'agent_a' },
      runtime_state: {
        resume_cursor: 'execute_agent',
        cursor_input: nextInput,
        artifact_refs: ['file:///evidence/select_agent.json'],
        diagnostics: {
          stage_evidence: {
            select_agent: {
              uri: 'file:///evidence/select_agent.json',
              sha256: 'a'.repeat(64),
            },
          },
        },
      },
    });
    expect(store.getTaskAggregate('task_stage')?.runtime_state.diagnostics).not.toHaveProperty(
      'active_stage',
    );
    store.close();
  });

  it('records legacy events without projecting the cursor while a handler is active', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_active_legacy',
      run_id: 'run_active_legacy',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
      cursor_input: selectInput,
    });
    processor.startStage({
      run_id: 'run_active_legacy',
      expected_cursor: 'select_agent',
      invocation_id: 'invocation_active_legacy',
    });

    processor.recordRunEvent(
      'run_active_legacy',
      stageEvent(
        'event_active_legacy_market',
        'market.selected',
        'task_active_legacy',
        'run_active_legacy',
      ),
    );

    expect(store.getTaskAggregate('task_active_legacy')?.runtime_state).toMatchObject({
      resume_cursor: 'select_agent',
      cursor_input: selectInput,
      diagnostics: {
        active_stage: {
          cursor: 'select_agent',
          invocation_id: 'invocation_active_legacy',
        },
        legacy_cursor_projection_suppressed: true,
      },
    });
    expect(
      store
        .listEvents('task_active_legacy')
        .find((event) => event.event_id === 'event_active_legacy_market'),
    ).toBeDefined();
    store.close();
  });

  it('rolls back a stage advance when its event id already exists', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_duplicate_event',
      run_id: 'run_duplicate_event',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
      cursor_input: selectInput,
      run_started_event: stageEvent(
        'event_duplicate',
        'run.started',
        'task_duplicate_event',
        'run_duplicate_event',
      ),
    });
    processor.startStage({
      run_id: 'run_duplicate_event',
      expected_cursor: 'select_agent',
      invocation_id: 'invocation_duplicate',
    });
    const before = store.getTaskAggregate('task_duplicate_event');

    expect(() =>
      processor.advanceStage({
        run_id: 'run_duplicate_event',
        expected_cursor: 'select_agent',
        invocation_id: 'invocation_duplicate',
        evidence_ref: {
          uri: 'file:///evidence/duplicate.json',
          sha256: 'b'.repeat(64),
        },
        next_input: {
          cursor: 'execute_agent',
          winner_agent_id: 'agent_a',
        },
        event: stageEvent(
          'event_duplicate',
          'handler.completed',
          'task_duplicate_event',
          'run_duplicate_event',
        ),
      }),
    ).toThrow();
    expect(store.getTaskAggregate('task_duplicate_event')).toEqual(before);
    store.close();
  });

  it('rejects a cursor jump before committing any stage completion', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_invalid_cursor',
      run_id: 'run_invalid_cursor',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
      cursor_input: selectInput,
    });
    processor.startStage({
      run_id: 'run_invalid_cursor',
      expected_cursor: 'select_agent',
      invocation_id: 'invocation_invalid_cursor',
    });
    const before = store.getTaskAggregate('task_invalid_cursor');

    expect(() =>
      processor.advanceStage({
        run_id: 'run_invalid_cursor',
        expected_cursor: 'select_agent',
        invocation_id: 'invocation_invalid_cursor',
        evidence_ref: {
          uri: 'file:///evidence/invalid.json',
          sha256: 'e'.repeat(64),
        },
        next_input: {
          cursor: 'gate',
          subject_ref: 'artifact_invalid',
          phase: 'post_primary',
          changeset_ref: 'artifact_invalid',
          expected_sha256: 'e'.repeat(64),
        },
      }),
    ).toThrow(/select_agent -> gate/);
    expect(store.getTaskAggregate('task_invalid_cursor')).toEqual(before);
    store.close();
  });

  it('rejects a non-select cursor for a fresh Task without matching resume lineage', () => {
    const { processor, store } = createProcessor();

    expect(() =>
      processor.beginRun({
        task_id: 'task_fresh_gate',
        run_id: 'run_fresh_gate',
        task_request: taskRequest,
        workspace_path: '/workspace',
        mode: 'single_agent',
        cursor_input: gateInput('artifact_fresh', 'f'.repeat(64)),
      }),
    ).toThrow(/fresh task.*select_agent/i);
    expect(store.getTaskAggregate('task_fresh_gate')).toBeUndefined();
    store.close();
  });

  it('rejects a non-select cursor for an existing Task without its latest checkpoint', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_existing_gate',
      run_id: 'run_existing_first',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
    });
    processor.finishRun({
      run_id: 'run_existing_first',
      status: 'completed',
      final_output: {
        artifact_ref: 'artifact_existing_first',
        sha256: 'f'.repeat(64),
        workspace_path: '/workspace/result.ts',
      },
    });

    expect(() =>
      processor.beginRun({
        task_id: 'task_existing_gate',
        run_id: 'run_existing_second',
        task_request: taskRequest,
        workspace_path: '/workspace',
        mode: 'single_agent',
        run_intent: { type: 'checkpoint_resume', strategy: 'from_checkpoint' },
        cursor_input: gateInput('artifact_existing_first', 'f'.repeat(64)),
      }),
    ).toThrow(/latest checkpoint/i);
    expect(store.getTaskAggregate('task_existing_gate')?.runs).toHaveLength(1);
    store.close();
  });

  it('allows a non-select resume only when cursor and latest checkpoint match', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_checkpoint_gate',
      run_id: 'run_checkpoint_first',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
    });
    processor.recordRunEvent(
      'run_checkpoint_first',
      stageEvent(
        'event_checkpoint_agent_done',
        'agent.execution_completed',
        'task_checkpoint_gate',
        'run_checkpoint_first',
      ),
    );
    processor.recoverInterruptedTasks();
    const checkpoint = store.getLatestCheckpoint('task_checkpoint_gate');
    expect(checkpoint?.resume_cursor).toBe('gate');
    if (!checkpoint) throw new Error('Expected recovery checkpoint');

    expect(() =>
      processor.beginRun({
        task_id: 'task_checkpoint_gate',
        run_id: 'run_checkpoint_wrong_lineage',
        task_request: taskRequest,
        workspace_path: '/workspace',
        mode: 'single_agent',
        run_intent: { type: 'checkpoint_resume', strategy: 'from_checkpoint' },
        restarted_from_run_id: 'run_not_checkpoint_source',
        resume_checkpoint_id: checkpoint.checkpoint_id,
        requested_resume_cursor: 'gate',
        cursor_input: gateInput('artifact_checkpoint', 'f'.repeat(64)),
      }),
    ).toThrow(/restarted_from_run_id.*checkpoint/i);

    processor.beginRun({
      task_id: 'task_checkpoint_gate',
      run_id: 'run_checkpoint_second',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
      run_intent: { type: 'checkpoint_resume', strategy: 'from_checkpoint' },
      restarted_from_run_id: 'run_checkpoint_first',
      resume_checkpoint_id: checkpoint.checkpoint_id,
      requested_resume_cursor: 'gate',
      cursor_input: gateInput('artifact_checkpoint', 'f'.repeat(64)),
    });

    expect(store.getTaskAggregate('task_checkpoint_gate')?.runtime_state).toMatchObject({
      current_run_id: 'run_checkpoint_second',
      resume_cursor: 'gate',
      cursor_input: gateInput('artifact_checkpoint', 'f'.repeat(64)),
    });

    processor.finishRun({
      run_id: 'run_checkpoint_second',
      status: 'completed',
      final_output: {
        artifact_ref: 'artifact_checkpoint',
        sha256: 'f'.repeat(64),
        workspace_path: '/workspace/result.ts',
      },
    });
    expect(() =>
      processor.beginRun({
        task_id: 'task_checkpoint_gate',
        run_id: 'run_checkpoint_replay',
        task_request: taskRequest,
        workspace_path: '/workspace',
        mode: 'single_agent',
        run_intent: { type: 'checkpoint_resume', strategy: 'from_checkpoint' },
        restarted_from_run_id: 'run_checkpoint_first',
        resume_checkpoint_id: checkpoint.checkpoint_id,
        requested_resume_cursor: 'gate',
        cursor_input: gateInput('artifact_checkpoint', 'f'.repeat(64)),
      }),
    ).toThrow(/blocked|replay/i);
    store.close();
  });

  it('persists a Council override once and exposes it to execution state', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_override',
      run_id: 'run_override',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
      cursor_input: selectInput,
    });

    const first = processor.setCouncilOverride('run_override');
    const second = processor.setCouncilOverride('run_override');

    expect(first.committed_events).toEqual([
      expect.objectContaining({ event_type: 'task.council_override_set' }),
    ]);
    expect(second.committed_events).toEqual([]);
    expect(processor.getRunExecutionState('run_override').council_override).toBe(true);
    expect(store.getTaskAggregate('task_override')?.runtime_state.diagnostics).toMatchObject({
      council_override: true,
    });
    expect(
      store
        .listEvents('task_override')
        .filter((event) => event.event_type === 'task.council_override_set'),
    ).toHaveLength(1);

    store.close();
  });

  it('rejects a Council override after primary execution has reached Gate', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_override_late',
      run_id: 'run_override_late',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
      cursor_input: selectInput,
    });
    advanceProcessorToGate(
      processor,
      'run_override_late',
      'artifact_override_late',
      '1'.repeat(64),
    );

    expect(() => processor.setCouncilOverride('run_override_late')).toThrow(/too late|gate/i);
    expect(store.getTaskAggregate('task_override_late')?.runtime_state.diagnostics).not.toHaveProperty(
      'council_override',
    );
    store.close();
  });

  it('does not allow Processor callers to bypass a persisted Council override', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_override_bypass',
      run_id: 'run_override_bypass',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
      cursor_input: selectInput,
    });
    processor.startStage({
      run_id: 'run_override_bypass',
      expected_cursor: 'select_agent',
      invocation_id: 'invocation_override_select',
    });
    processor.advanceStage({
      run_id: 'run_override_bypass',
      expected_cursor: 'select_agent',
      invocation_id: 'invocation_override_select',
      evidence_ref: evidenceRef('override_select'),
      next_input: { cursor: 'execute_agent', winner_agent_id: 'agent_a' },
    });
    processor.setCouncilOverride('run_override_bypass');
    processor.startStage({
      run_id: 'run_override_bypass',
      expected_cursor: 'execute_agent',
      invocation_id: 'invocation_override_execute',
    });

    expect(() =>
      processor.advanceStage({
        run_id: 'run_override_bypass',
        expected_cursor: 'execute_agent',
        invocation_id: 'invocation_override_execute',
        evidence_ref: evidenceRef('override_execute'),
        next_input: gateInput('artifact_override_bypass', '2'.repeat(64)),
      }),
    ).toThrow(/Council override.*Council input/i);
    expect(store.getTaskAggregate('task_override_bypass')?.runtime_state).toMatchObject({
      resume_cursor: 'execute_agent',
      diagnostics: { council_override: true },
    });
    store.close();
  });

  it('binds the Gate changeset through delivery and rejects final output substitution', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_identity',
      run_id: 'run_identity',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
      cursor_input: selectInput,
    });
    advanceProcessorToGate(processor, 'run_identity', 'artifact_bound', '1'.repeat(64));
    processor.startStage({
      run_id: 'run_identity',
      expected_cursor: 'gate',
      invocation_id: 'invocation_gate_identity',
    });

    expect(() =>
      processor.advanceStage({
        run_id: 'run_identity',
        expected_cursor: 'gate',
        invocation_id: 'invocation_gate_identity',
        evidence_ref: evidenceRef('gate_identity'),
        next_input: {
          cursor: 'deliver',
          changeset_ref: 'artifact_substituted',
          expected_sha256: '2'.repeat(64),
        },
      }),
    ).toThrow(/gate.*identity/i);

    processor.advanceStage({
      run_id: 'run_identity',
      expected_cursor: 'gate',
      invocation_id: 'invocation_gate_identity',
      evidence_ref: evidenceRef('gate_identity'),
      next_input: {
        cursor: 'deliver',
        changeset_ref: 'artifact_bound',
        expected_sha256: '1'.repeat(64),
      },
    });
    processor.startStage({
      run_id: 'run_identity',
      expected_cursor: 'deliver',
      invocation_id: 'invocation_deliver_identity',
    });
    expect(() =>
      processor.advanceStage({
        run_id: 'run_identity',
        expected_cursor: 'deliver',
        invocation_id: 'invocation_deliver_identity',
        evidence_ref: evidenceRef('deliver_identity'),
        next_input: { cursor: 'done' },
        final_output: {
          artifact_ref: 'artifact_substituted',
          sha256: '2'.repeat(64),
          workspace_path: '/workspace/result.ts',
        },
      }),
    ).toThrow(/final output.*identity/i);
    expect(store.getTaskAggregate('task_identity')?.task.status).toBe('running');
    store.close();
  });

  it('blocks interrupted active runs once and saves a resumable full checkpoint', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_processor',
      run_id: 'run_processor',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
    });
    processor.recordRunEvent(
      'run_processor',
      event('event_agent_done', 'agent.execution_completed', {
        agent_id: 'role_ts_engineer@agent_1',
        session_id: 'session_resume',
        artifact_refs: ['artifact_partial'],
      }),
    );

    const recovered = processor.recoverInterruptedTasks();
    expect(recovered).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ task_id: 'task_processor', status: 'blocked' }),
        run_history: [
          expect.objectContaining({
            run_id: 'run_processor',
            status: 'interrupted',
            session_id: 'session_resume',
          }),
        ],
        waiting_reason: 'The backend process ended before the active run reached a terminal state.',
      }),
    ]);
    const checkpoint = store.getLatestCheckpoint('task_processor');
    expect(checkpoint).toMatchObject({
      checkpoint_id: expect.stringMatching(/^checkpoint_/),
      task_id: 'task_processor',
      run_id: 'run_processor',
      agent_id: 'role_ts_engineer@agent_1',
      session_id: 'session_resume',
      trigger: 'blocked',
      resume_cursor: 'gate',
      artifact_refs: ['artifact_partial'],
      validity_status: 'valid',
      mechanical_snapshot: { worktree_path: '/workspace' },
      semantic_handoff: {
        in_progress: ['gate'],
        blocked_on: ['backend process interrupted'],
      },
    });
    expect(checkpoint?.message_thread.map((message) => message.content)).toContain(
      'agent.execution_completed',
    );
    const revision = store.getTaskAggregate('task_processor')?.task.revision;
    expect(processor.recoverInterruptedTasks()).toEqual([]);
    expect(store.getTaskAggregate('task_processor')?.task.revision).toBe(revision);
    store.close();
  });
});

const taskRequest: TaskCreateRequest = {
  spec: 'Persist the Task processor lifecycle',
  role_id: 'role_ts_engineer',
  risk_level: 'medium',
  affected_paths: ['src/app/**'],
  completion_criteria: ['State survives restart'],
};

const selectInput: TaskCursorInput = {
  cursor: 'select_agent',
  seed: 'seed_processor',
  candidate_ids: ['agent_a', 'agent_b'],
};

function createProcessor(): {
  databasePath: string;
  store: SqliteCoordinationStore;
  processor: TaskProcessor;
} {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-task-processor-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'coordination.sqlite');
  const store = new SqliteCoordinationStore(databasePath);
  return {
    databasePath,
    store,
    processor: new TaskProcessor(store, deterministicClock()),
  };
}

function deterministicClock(): {
  now: () => string;
  createEventId: () => string;
} {
  let sequence = 0;
  return {
    now: () => `2026-07-19T03:00:${String(sequence).padStart(2, '0')}.000Z`,
    createEventId: () => `processor_event_${String(++sequence)}`,
  };
}

function event(eventId: string, eventType: string, payload: Record<string, unknown> = {}): Event {
  return {
    event_id: eventId,
    event_type: eventType,
    subject_id: 'run_processor',
    run_id: 'run_processor',
    task_id: 'task_processor',
    payload,
    created_at: '2026-07-19T03:01:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function stageEvent(eventId: string, eventType: string, taskId: string, runId: string): Event {
  return {
    event_id: eventId,
    event_type: eventType,
    subject_id: runId,
    run_id: runId,
    task_id: taskId,
    payload: {},
    created_at: '2026-07-19T03:01:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function gateInput(changesetRef: string, expectedSha256: string): TaskCursorInput {
  return {
    cursor: 'gate',
    subject_ref: changesetRef,
    phase: 'post_primary',
    changeset_ref: changesetRef,
    expected_sha256: expectedSha256,
  };
}

function evidenceRef(stage: string): { uri: string; sha256: string } {
  return {
    uri: `file:///evidence/${stage}.json`,
    sha256: 'a'.repeat(64),
  };
}

function advanceProcessorToGate(
  processor: TaskProcessor,
  runId: string,
  changesetRef: string,
  expectedSha256: string,
): void {
  processor.startStage({
    run_id: runId,
    expected_cursor: 'select_agent',
    invocation_id: 'invocation_select_setup',
  });
  processor.advanceStage({
    run_id: runId,
    expected_cursor: 'select_agent',
    invocation_id: 'invocation_select_setup',
    evidence_ref: evidenceRef('select_setup'),
    next_input: { cursor: 'execute_agent', winner_agent_id: 'agent_a' },
  });
  processor.startStage({
    run_id: runId,
    expected_cursor: 'execute_agent',
    invocation_id: 'invocation_execute_setup',
  });
  processor.advanceStage({
    run_id: runId,
    expected_cursor: 'execute_agent',
    invocation_id: 'invocation_execute_setup',
    evidence_ref: evidenceRef('execute_setup'),
    next_input: gateInput(changesetRef, expectedSha256),
  });
}

function terminalSnapshot(
  runId: string,
  taskId: string,
  mode: 'single_agent' | 'council',
): RunSnapshot {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    task_id: taskId,
    mode,
    status: 'completed',
    current: { stage: 'delivery', active_node_code: 'N18' },
    run: {
      run_id: runId,
      task_id: taskId,
      status: 'completed',
      mode,
      session_id: 'session_restart',
      event_ids: [],
      started_at: '2026-07-19T03:00:00.000Z',
      completed_at: '2026-07-19T03:02:00.000Z',
    },
    timeline: [],
    agent_runs: [],
    artifacts: [{ artifact_id: 'artifact_final' }],
    gates: [],
    errors: [],
    final_output: {
      status: 'completed',
      artifact_refs: ['artifact_final'],
      files_written: ['/workspace/result.ts'],
      changed_files: ['result.ts'],
      session_id: 'session_restart',
    },
  };
}
