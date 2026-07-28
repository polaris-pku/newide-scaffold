import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION, type TaskCreateRequest } from '../../src/core';
import {
  TaskExecutionLoop,
  type TaskExecutionLoopExecutors,
} from '../../src/app/task-execution-loop';
import { TaskProcessor } from '../../src/app/task-processor';
import {
  SqliteCoordinationStore,
  type CoordinationStateCommit,
  type CoordinationStateStore,
  type PersistedCoordinationEvent,
  type PersistedFullCheckpoint,
  type PersistedTaskAggregate,
  type RunEvidenceStore,
  type RunStageEvidence,
  type RunStageEvidenceInput,
  type RunStageEvidenceReference,
  type TaskCursorInput,
} from '../../src/persistence';

describe('TaskExecutionLoop', () => {
  it('runs the finite non-Council path and atomically completes delivery', async () => {
    const fixture = createFixture();
    begin(fixture.processor, selectInput, 'single_agent');

    const completed = await fixture.loop.run({ task_id: 'task_loop', run_id: 'run_loop' });

    expect(fixture.calls).toEqual(['select_agent', 'execute_agent', 'gate', 'deliver']);
    expect(completed).toMatchObject({
      task: { status: 'completed', owner_agent_id: 'agent_a' },
      run_history: [{ run_id: 'run_loop', status: 'completed', session_id: 'session_primary' }],
      final_output: {
        artifact_refs: ['artifact_primary_changeset'],
        files_written: ['/workspace/result.ts'],
      },
    });
    expect(fixture.store.getTaskAggregate('task_loop')?.runtime_state).toMatchObject({
      resume_cursor: 'done',
      cursor_input: { cursor: 'done' },
    });
    expect(fixture.store.getTaskAggregate('task_loop')?.runtime_state).not.toHaveProperty(
      'current_run_id',
    );
  });

  it('refuses a legacy cursor projection that has no matching typed input', async () => {
    const fixture = createFixture();
    begin(fixture.processor, selectInput, 'single_agent');
    fixture.processor.recordRunEvent('run_loop', {
      event_id: 'event_legacy_market',
      event_type: 'market.selected',
      subject_id: 'run_loop',
      run_id: 'run_loop',
      task_id: 'task_loop',
      payload: { winner_agent_id: 'agent_a' },
      created_at: '2026-07-19T04:01:00.000Z',
      schema_version: SCHEMA_VERSION,
    });

    await expect(fixture.loop.run({ task_id: 'task_loop', run_id: 'run_loop' })).rejects.toThrow(
      /no cursor input matching execute_agent/i,
    );
    expect(fixture.calls).toEqual([]);
  });

  it('runs Council only for a structured escalation and passes its artifact to gate', async () => {
    const fixture = createFixture({ requestCouncil: true });
    begin(fixture.processor, selectInput, 'single_agent');

    await fixture.loop.run({ task_id: 'task_loop', run_id: 'run_loop' });

    expect(fixture.calls).toEqual(['select_agent', 'execute_agent', 'council', 'gate', 'deliver']);
    expect(fixture.inputs.council).toMatchObject({
      cursor: 'council',
      trigger: 'agent_request',
      primary_evidence_ref: 'memory://run_loop/execute_agent',
    });
    expect(fixture.inputs.gate).toEqual({
      cursor: 'gate',
      subject_ref: 'artifact_council_changeset',
      phase: 'post_council',
      changeset_ref: 'artifact_council_changeset',
      expected_sha256: 'c'.repeat(64),
    });
    expect(fixture.inputs.deliver).toEqual({
      cursor: 'deliver',
      changeset_ref: 'artifact_council_changeset',
      expected_sha256: 'c'.repeat(64),
    });
  });

  it('forces Council for Council mode without parsing model text', async () => {
    const fixture = createFixture();
    begin(fixture.processor, selectInput, 'council');

    await fixture.loop.run({ task_id: 'task_loop', run_id: 'run_loop' });

    expect(fixture.calls).toContain('council');
    expect(fixture.inputs.council).toMatchObject({ trigger: 'explicit_mode' });
  });

  it('persists a manual Council override before labeling the Council trigger', async () => {
    const fixture = createFixture();
    begin(fixture.processor, selectInput, 'single_agent');

    await fixture.loop.run({
      task_id: 'task_loop',
      run_id: 'run_loop',
      council_override: true,
    });

    expect(fixture.inputs.council).toMatchObject({ trigger: 'persistent_override' });
    expect(fixture.store.getTaskAggregate('task_loop')?.runtime_state.diagnostics).toMatchObject({
      council_override: true,
    });
    expect(
      fixture.store
        .listEvents('task_loop')
        .find((event) => event.event_type === 'task.council_override_set'),
    ).toBeDefined();
  });

  it('observes a Council override persisted while the primary handler is running', async () => {
    const fixture = createFixture({ overrideDuringExecute: true });
    begin(fixture.processor, selectInput, 'single_agent');

    await fixture.loop.run({ task_id: 'task_loop', run_id: 'run_loop' });

    expect(fixture.inputs.council).toMatchObject({ trigger: 'persistent_override' });
  });

  it('recomputes the Council branch after an override wins a revision conflict', async () => {
    const fixture = createFixture({ overrideDuringExecuteCommit: true });
    begin(fixture.processor, selectInput, 'single_agent');

    await fixture.loop.run({ task_id: 'task_loop', run_id: 'run_loop' });

    expect(fixture.inputs.council).toMatchObject({ trigger: 'persistent_override' });
    expect(
      fixture.store
        .listEvents('task_loop')
        .filter(
          (event) =>
            event.event_type === 'handler.completed' &&
            event.payload.cursor === 'execute_agent',
        ),
    ).toHaveLength(1);
  });

  it('keeps the stage active when the coordination commit fails', async () => {
    const fixture = createFixture({ coordinationFailureAt: 'execute_agent' });
    begin(fixture.processor, selectInput, 'single_agent');

    await expect(
      fixture.loop.run({ task_id: 'task_loop', run_id: 'run_loop' }),
    ).rejects.toThrow(/coordination commit failed/i);

    expect(fixture.store.getTaskAggregate('task_loop')).toMatchObject({
      task: { status: 'running' },
      runs: [{ status: 'running' }],
      runtime_state: {
        resume_cursor: 'execute_agent',
        cursor_input: { cursor: 'execute_agent', winner_agent_id: 'agent_a' },
        diagnostics: {
          active_stage: {
            cursor: 'execute_agent',
            invocation_id: 'invocation_execute_agent',
          },
        },
      },
    });
    expect(
      fixture.store
        .listEvents('task_loop')
        .some((event) => event.event_type === 'handler.failed'),
    ).toBe(false);
  });

  it('persists a failed terminal state and stops downstream stages when a handler throws', async () => {
    const fixture = createFixture({ failAt: 'execute_agent' });
    begin(fixture.processor, selectInput, 'single_agent');

    const failed = await fixture.loop.run({ task_id: 'task_loop', run_id: 'run_loop' });

    expect(fixture.calls).toEqual(['select_agent', 'execute_agent']);
    expect(failed).toMatchObject({
      task: { status: 'failed' },
      error: { code: 'stage_execution_failed', message: 'execute failed' },
      run_history: [{ run_id: 'run_loop', status: 'failed' }],
    });
    expect(fixture.store.getTaskAggregate('task_loop')?.runtime_state).toMatchObject({
      resume_cursor: 'done',
      cursor_input: { cursor: 'done' },
      artifact_refs: expect.arrayContaining(['memory://run_loop/execute_agent.failure']),
    });
    expect(
      await fixture.evidenceStore.readFailure({
        run_id: 'run_loop',
        stage: 'execute_agent',
      }),
    ).toMatchObject({
      evidence: {
        status: 'failed',
        code: 'stage_execution_failed',
        message: 'execute failed',
      },
    });
  });

  it('fails the active stage when evidence cannot be persisted', async () => {
    const fixture = createFixture({ evidenceFailureAt: 'execute_agent' });
    begin(fixture.processor, selectInput, 'single_agent');

    const failed = await fixture.loop.run({ task_id: 'task_loop', run_id: 'run_loop' });

    expect(fixture.calls).toEqual(['select_agent', 'execute_agent']);
    expect(failed).toMatchObject({
      task: { status: 'failed' },
      error: {
        code: 'stage_evidence_write_failed',
        message: 'evidence write failed',
        details: { cursor: 'execute_agent' },
      },
    });
    const events = fixture.store.listEvents('task_loop');
    const eventTypes = events.map((event) => event.event_type);
    expect(eventTypes).toContain('handler.failed');
    expect(events).not.toContainEqual(
      expect.objectContaining({
        event_type: 'handler.completed',
        payload: expect.objectContaining({ cursor: 'execute_agent' }),
      }),
    );
    expect(
      await fixture.evidenceStore.readStage({
        run_id: 'run_loop',
        stage: 'execute_agent',
      }),
    ).toBeUndefined();
  });

  it('rejects a Gate executor that attempts to substitute the bound changeset', async () => {
    const fixture = createFixture({ substituteAtGate: true });
    begin(fixture.processor, selectInput, 'single_agent');

    const failed = await fixture.loop.run({ task_id: 'task_loop', run_id: 'run_loop' });

    expect(fixture.calls).toEqual(['select_agent', 'execute_agent', 'gate']);
    expect(failed).toMatchObject({
      task: { status: 'failed' },
      error: { code: 'stage_execution_failed', message: expect.stringMatching(/substitut/i) },
    });
  });

  it('records contract failure separately from an already persisted result evidence', async () => {
    const fixture = createFixture({ invalidFinalOutput: true });
    begin(fixture.processor, selectInput, 'single_agent');

    const failed = await fixture.loop.run({ task_id: 'task_loop', run_id: 'run_loop' });

    expect(failed).toMatchObject({
      task: { status: 'failed' },
      error: { code: 'stage_execution_failed', message: expect.stringMatching(/workspace/i) },
    });
    const failureEvidence = await fixture.evidenceStore.readFailure({
      run_id: 'run_loop',
      stage: 'deliver',
    });
    expect(failureEvidence).toMatchObject({
      evidence: {
        status: 'failed',
        result_evidence_ref: {
          uri: 'memory://run_loop/deliver',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(fixture.store.getTaskAggregate('task_loop')?.runtime_state.artifact_refs).toEqual(
      expect.arrayContaining(['memory://run_loop/deliver', failureEvidence?.uri]),
    );
  });

  it('continues from a persisted gate cursor without rerunning upstream stages', async () => {
    const fixture = createFixture();
    begin(fixture.processor, selectInput, 'single_agent');
    advanceProcessorToGate(fixture.processor);

    await fixture.loop.run({ task_id: 'task_loop', run_id: 'run_loop' });

    expect(fixture.calls).toEqual(['gate', 'deliver']);
  });
});

interface FixtureOptions {
  requestCouncil?: boolean;
  failAt?: TaskCursorInput['cursor'];
  evidenceFailureAt?: TaskCursorInput['cursor'];
  substituteAtGate?: boolean;
  overrideDuringExecute?: boolean;
  overrideDuringExecuteCommit?: boolean;
  coordinationFailureAt?: TaskCursorInput['cursor'];
  invalidFinalOutput?: boolean;
}

function createFixture(options: FixtureOptions = {}): {
  store: SqliteCoordinationStore;
  processor: TaskProcessor;
  loop: TaskExecutionLoop;
  evidenceStore: MemoryEvidenceStore;
  calls: string[];
  inputs: Partial<Record<TaskCursorInput['cursor'], TaskCursorInput>>;
} {
  const store = new SqliteCoordinationStore(':memory:');
  let conflictInjected = false;
  const interceptingStore = new InterceptingCoordinationStore(store, (input) => {
    const completedCursor = handlerCompletedCursor(input);
    if (options.coordinationFailureAt && completedCursor === options.coordinationFailureAt) {
      throw new Error('database unavailable during coordination commit');
    }
    if (completedCursor === 'execute_agent' && options.overrideDuringExecuteCommit && !conflictInjected) {
      conflictInjected = true;
      new TaskProcessor(store, conflictClock()).setCouncilOverride('run_loop');
    }
  });
  const processor = new TaskProcessor(interceptingStore, deterministicClock());
  const calls: string[] = [];
  const inputs: Partial<Record<TaskCursorInput['cursor'], TaskCursorInput>> = {};
  const execute = <TInput extends TaskCursorInput, TResult>(
    cursor: TInput['cursor'],
    result: TResult,
  ) =>
    vi.fn(async (context: { cursor_input: TInput }): Promise<TResult> => {
      calls.push(cursor);
      inputs[cursor] = context.cursor_input;
      if (cursor === 'execute_agent' && options.overrideDuringExecute) {
        processor.setCouncilOverride('run_loop');
      }
      if (options.failAt === cursor) throw new Error(`${cursor.replace('_agent', '')} failed`);
      return result;
    });
  const executors: TaskExecutionLoopExecutors = {
    select_agent: {
      execute: execute('select_agent', {
        winner_agent_id: 'agent_a',
        evidence: { winner_agent_id: 'agent_a' },
      }),
    },
    execute_agent: {
      execute: execute('execute_agent', {
        changeset_ref: 'artifact_primary_changeset',
        expected_sha256: 'd'.repeat(64),
        agent_id: 'agent_a',
        session_id: 'session_primary',
        evidence: { response: 'implementation complete' },
        ...(options.requestCouncil
          ? { escalation_request: { type: 'request_council' as const, reason: 'review needed' } }
          : {}),
      }),
    },
    council: {
      execute: execute('council', {
        changeset_ref: 'artifact_council_changeset',
        expected_sha256: 'c'.repeat(64),
        evidence: { quality: 'verified' },
      }),
    },
    gate: {
      execute: execute('gate', {
        evidence: { status: 'skipped' },
        ...(options.substituteAtGate
          ? { changeset_ref: 'artifact_substituted', expected_sha256: 'e'.repeat(64) }
          : {}),
      }),
    },
    deliver: {
      execute: vi.fn(async (context) => {
        calls.push('deliver');
        inputs.deliver = context.cursor_input;
        return {
          final_output: {
            artifact_ref: context.cursor_input.changeset_ref,
            sha256: context.cursor_input.expected_sha256,
            workspace_path: options.invalidFinalOutput ? '' : '/workspace/result.ts',
          },
          evidence: { files_written: ['result.ts'] },
        };
      }),
    },
  };
  const evidenceStore = new MemoryEvidenceStore(options.evidenceFailureAt);
  return {
    store,
    processor,
    evidenceStore,
    loop: new TaskExecutionLoop({
      processor,
      evidence_store: evidenceStore,
      executors,
      create_invocation_id: (cursor) => `invocation_${cursor}`,
    }),
    calls,
    inputs,
  };
}

class InterceptingCoordinationStore implements CoordinationStateStore {
  constructor(
    private readonly inner: CoordinationStateStore,
    private readonly beforeCommit: (input: CoordinationStateCommit) => void,
  ) {}

  commitState(input: CoordinationStateCommit): PersistedCoordinationEvent[] {
    this.beforeCommit(input);
    return this.inner.commitState(input);
  }

  getTaskAggregate(taskId: string): PersistedTaskAggregate | undefined {
    return this.inner.getTaskAggregate(taskId);
  }

  listTaskAggregates(): PersistedTaskAggregate[] {
    return this.inner.listTaskAggregates();
  }

  listEvents(taskId: string, afterSequence?: number): PersistedCoordinationEvent[] {
    return this.inner.listEvents(taskId, afterSequence);
  }

  getLatestCheckpoint(taskId: string): PersistedFullCheckpoint | undefined {
    return this.inner.getLatestCheckpoint(taskId);
  }

  close(): void {
    this.inner.close();
  }
}

function handlerCompletedCursor(
  input: CoordinationStateCommit,
): TaskCursorInput['cursor'] | undefined {
  const event = input.events.find((candidate) => candidate.event_type === 'handler.completed');
  const cursor = event?.payload.cursor;
  return typeof cursor === 'string' ? (cursor as TaskCursorInput['cursor']) : undefined;
}

function conflictClock(): { now: () => string; createEventId: () => string } {
  let sequence = 0;
  return {
    now: () => `2026-07-19T04:30:${String(sequence).padStart(2, '0')}.000Z`,
    createEventId: () => `conflict_event_${String(++sequence)}`,
  };
}

function advanceProcessorToGate(processor: TaskProcessor): void {
  processor.startStage({
    run_id: 'run_loop',
    expected_cursor: 'select_agent',
    invocation_id: 'invocation_resume_select',
  });
  processor.advanceStage({
    run_id: 'run_loop',
    expected_cursor: 'select_agent',
    invocation_id: 'invocation_resume_select',
    evidence_ref: { uri: 'memory://setup/select', sha256: '1'.repeat(64) },
    next_input: { cursor: 'execute_agent', winner_agent_id: 'agent_a' },
  });
  processor.startStage({
    run_id: 'run_loop',
    expected_cursor: 'execute_agent',
    invocation_id: 'invocation_resume_execute',
  });
  processor.advanceStage({
    run_id: 'run_loop',
    expected_cursor: 'execute_agent',
    invocation_id: 'invocation_resume_execute',
    evidence_ref: { uri: 'memory://setup/execute', sha256: '2'.repeat(64) },
    next_input: {
      cursor: 'gate',
      subject_ref: 'artifact_existing',
      phase: 'post_primary',
      changeset_ref: 'artifact_existing',
      expected_sha256: 'd'.repeat(64),
    },
  });
}

class MemoryEvidenceStore implements RunEvidenceStore {
  private readonly values = new Map<string, RunStageEvidence>();

  constructor(private readonly failureAt?: TaskCursorInput['cursor']) {}

  async writeStage(input: RunStageEvidenceInput): Promise<RunStageEvidenceReference> {
    if (input.stage === this.failureAt) throw new Error('evidence write failed');
    const reference = {
      uri: `memory://${input.run_id}/${input.stage}`,
      sha256: String(input.stage.length).padStart(64, '0'),
    };
    this.values.set(`${input.run_id}:${input.stage}`, { ...reference, evidence: input.evidence });
    return reference;
  }

  async writeFailure(input: RunStageEvidenceInput): Promise<RunStageEvidenceReference> {
    const reference = {
      uri: `memory://${input.run_id}/${input.stage}.failure`,
      sha256: String(`${input.stage}.failure`.length).padStart(64, '0'),
    };
    this.values.set(`${input.run_id}:${input.stage}:failure`, {
      ...reference,
      evidence: input.evidence,
    });
    return reference;
  }

  async readStage(
    input: Pick<RunStageEvidenceInput, 'run_id' | 'stage'>,
  ): Promise<RunStageEvidence | undefined> {
    return this.values.get(`${input.run_id}:${input.stage}`);
  }

  async readFailure(
    input: Pick<RunStageEvidenceInput, 'run_id' | 'stage'>,
  ): Promise<RunStageEvidence | undefined> {
    return this.values.get(`${input.run_id}:${input.stage}:failure`);
  }
}

const taskRequest: TaskCreateRequest = {
  spec: 'Execute a durable task flow',
  completion_criteria: ['All stages are durable'],
};

const selectInput: TaskCursorInput = {
  cursor: 'select_agent',
  seed: 'seed_loop',
  candidate_ids: ['agent_a', 'agent_b'],
};

function begin(
  processor: TaskProcessor,
  cursorInput: TaskCursorInput,
  mode: 'single_agent' | 'council',
): void {
  processor.beginRun({
    task_id: 'task_loop',
    run_id: 'run_loop',
    task_request: taskRequest,
    workspace_path: '/workspace',
    mode,
    cursor_input: cursorInput,
  });
}

function deterministicClock(): {
  now: () => string;
  createEventId: () => string;
} {
  let sequence = 0;
  return {
    now: () => `2026-07-19T04:00:${String(sequence).padStart(2, '0')}.000Z`,
    createEventId: () => `loop_event_${String(++sequence)}`,
  };
}
