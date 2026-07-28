import {
  SCHEMA_VERSION,
  createId,
  type Event,
  type EventType,
  type TaskCreateRequest,
} from '../core';
import {
  assertTaskRunStartTransition,
  assertTaskStatusTransition,
} from '../coordinator/task-state-machine';
import {
  parseTaskCursorInput,
  type CoordinationStateStore,
  type PersistedRunMode,
  type PersistedRunState,
  type PersistedTaskAggregate,
  type PersistedCoordinationEvent,
  type PersistedTaskFinalOutput,
  type PersistedFullCheckpoint,
  type PersistedTaskState,
  type RunStageEvidenceReference,
  type TaskCursorInput,
  type TaskResumeCursor,
} from '../persistence';
import type { RunSnapshot } from '../protocol/run-snapshot';
import { projectRunEventSource } from '../protocol/run-event';
import { taskSnapshotSchema, type TaskSnapshot } from '../protocol/task-snapshot';
import type { AppRunEvent } from './run-registry';
import { projectTaskSnapshot, type TaskRunFact } from './task-snapshot-projector';

export interface TaskProcessorOptions {
  now?: () => string;
  createEventId?: () => string;
}

export interface BeginTaskRunInput {
  task_id: string;
  run_id: string;
  task_request: TaskCreateRequest;
  workspace_path: string;
  mode: PersistedRunMode;
  session_id?: string;
  restarted_from_run_id?: string;
  resume_checkpoint_id?: string;
  requested_resume_cursor?: TaskResumeCursor;
  cursor_input?: TaskCursorInput;
  run_intent?: BeginTaskRunIntent;
  task_created_event?: Event;
  run_created_event?: Event;
  run_started_event?: Event;
}

export type BeginTaskRunIntent =
  | { type: 'create' }
  | {
      type: 'checkpoint_resume';
      strategy: 'from_checkpoint' | 'restart_from_beginning';
    }
  | { type: 'council_refinement' };

export interface StartTaskStageInput {
  run_id: string;
  expected_cursor: TaskResumeCursor;
  invocation_id: string;
  event?: Event;
}

export interface AdvanceTaskStageInput extends StartTaskStageInput {
  evidence_ref: RunStageEvidenceReference;
  next_input: TaskCursorInput;
  council_override_input?: Extract<TaskCursorInput, { cursor: 'council' }>;
  artifact_refs?: string[];
  owner_agent_id?: string;
  session_id?: string;
  final_output?: PersistedTaskFinalOutput;
  warnings?: string[];
}

export interface FailTaskStageInput extends StartTaskStageInput {
  error: { code: string; message: string; details?: Record<string, unknown> };
  evidence_ref?: RunStageEvidenceReference;
  artifact_refs?: string[];
  owner_agent_id?: string;
  session_id?: string;
}

export interface TaskStageCommitResult {
  snapshot: TaskSnapshot;
  committed_events: PersistedCoordinationEvent[];
}

export interface TaskRunExecutionState {
  task_id: string;
  run_id: string;
  mode: PersistedRunMode;
  task_request: TaskCreateRequest;
  workspace_path: string;
  resume_cursor: TaskResumeCursor;
  cursor_input?: TaskCursorInput;
  council_override: boolean;
}

export interface FinishTaskRunInput {
  run_id: string;
  status: 'completed' | 'failed' | 'cancelled';
  snapshot?: RunSnapshot;
  final_output?: PersistedTaskFinalOutput;
  warnings?: string[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
  event?: Event;
}

export interface TaskLaunchContext {
  task_request: TaskCreateRequest;
  workspace_path: string;
  session_id?: string;
}

export interface TaskResumeContext extends TaskLaunchContext {
  checkpoint_id: string;
  resume_cursor: TaskResumeCursor;
  mode: PersistedRunMode;
  interrupted_run_id: string;
}

export class TaskProcessorTaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} was not found in the coordination store`);
    this.name = 'TaskProcessorTaskNotFoundError';
  }
}

export class TaskProcessorRunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} was not found in the coordination store`);
    this.name = 'TaskProcessorRunNotFoundError';
  }
}

export class TaskEventCursorNotFoundError extends Error {
  constructor(
    readonly taskId: string,
    readonly eventId: string,
  ) {
    super(`Task ${taskId} event cursor ${eventId} was not found`);
    this.name = 'TaskEventCursorNotFoundError';
  }
}

export class TaskProcessorStageCommitError extends Error {
  constructor(
    readonly operation: string,
    readonly originalError: unknown,
  ) {
    super(`Task coordination commit failed during ${operation}: ${errorMessage(originalError)}`);
    this.name = 'TaskProcessorStageCommitError';
  }
}

export class TaskProcessor {
  private readonly now: () => string;
  private readonly createEventId: () => string;

  constructor(
    private readonly store: CoordinationStateStore,
    options: TaskProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createEventId = options.createEventId ?? (() => createId('event'));
  }

  beginRun(input: BeginTaskRunInput): TaskSnapshot {
    const existing = this.store.getTaskAggregate(input.task_id);
    const activeRun = existing?.runs.find((run) => isActiveRun(run));
    if (activeRun) {
      throw new Error(`Task ${input.task_id} already has active run ${activeRun.run_id}`);
    }
    if (existing) {
      assertImmutableTaskDefinition(existing.task, input.task_request, input.workspace_path);
    }
    const runIntent = input.run_intent ?? { type: 'create' as const };
    const cursorInput = input.cursor_input ?? defaultCursorInput(input.run_id);
    assertBeginRunIntent(
      existing,
      input,
      cursorInput,
      runIntent,
      existing ? this.store.getLatestCheckpoint(input.task_id) : undefined,
    );

    const timestamp = this.now();
    const task: PersistedTaskState = existing
      ? (() => {
          const {
            final_output: _previousFinalOutput,
            error: _previousError,
            ...previousTask
          } = existing.task;
          return {
            ...previousTask,
            status: 'running',
            warnings: [],
            revision: existing.task.revision + 1,
            updated_at: timestamp,
          };
        })()
      : {
          task_id: input.task_id,
          ...(input.task_request.parent_task_id
            ? { parent_id: input.task_request.parent_task_id }
            : {}),
          status: 'running',
          ...(input.task_request.role_id ? { role_id: input.task_request.role_id } : {}),
          risk_level: input.task_request.risk_level ?? 'low',
          spec: input.task_request.spec,
          completion_criteria: [...input.task_request.completion_criteria],
          affected_paths: [...(input.task_request.affected_paths ?? [])],
          ...(input.task_request.budget ? { budget: { ...input.task_request.budget } } : {}),
          workspace_path: input.workspace_path,
          warnings: [],
          revision: 1,
          created_at: timestamp,
          updated_at: timestamp,
          schema_version: SCHEMA_VERSION,
        };
    const run: PersistedRunState = {
      run_id: input.run_id,
      task_id: input.task_id,
      status: 'running',
      mode: input.mode,
      workspace_path: input.workspace_path,
      ...(input.session_id ? { session_id: input.session_id } : {}),
      ...(input.restarted_from_run_id
        ? { restarted_from_run_id: input.restarted_from_run_id }
        : {}),
      revision: 1,
      started_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
      schema_version: SCHEMA_VERSION,
    };
    const events = [
      ...(existing
        ? []
        : [
            input.task_created_event ??
              this.createEvent('task.created', input.task_id, input.task_id, input.run_id, {
                spec: input.task_request.spec,
                risk_level: input.task_request.risk_level ?? 'low',
              }),
          ]),
      input.run_created_event ??
        this.createEvent('run.created', input.run_id, input.task_id, input.run_id, {
          mode: input.mode,
        }),
      input.run_started_event ??
        this.createEvent('run.started', input.run_id, input.task_id, input.run_id, {
          mode: input.mode,
        }),
    ];

    this.store.commitState({
      ...(existing ? { expected_task_revision: existing.task.revision } : {}),
      task,
      run,
      runtime_state: {
        task_id: input.task_id,
        current_run_id: input.run_id,
        resume_cursor: cursorInput.cursor,
        cursor_input: cursorInput,
        waiting_on: [],
        artifact_refs: [],
        diagnostics: {
          mode: input.mode,
          run_intent: runIntent.type,
          ...(runIntent.type === 'checkpoint_resume'
            ? { resume_strategy: runIntent.strategy }
            : {}),
          ...(input.resume_checkpoint_id
            ? { resume_checkpoint_id: input.resume_checkpoint_id }
            : {}),
          ...(input.requested_resume_cursor
            ? { requested_resume_cursor: input.requested_resume_cursor }
            : {}),
        },
        updated_at: timestamp,
        schema_version: SCHEMA_VERSION,
      },
      events,
    });
    return this.getTaskSnapshot(input.task_id);
  }

  startStage(input: StartTaskStageInput): TaskStageCommitResult {
    const aggregate = this.requireAggregateForRun(input.run_id);
    const run = requireRun(aggregate, input.run_id);
    assertActiveStageTarget(aggregate, run, input.expected_cursor);
    if (readActiveStage(aggregate.runtime_state.diagnostics)) {
      throw new Error(`Run ${input.run_id} already has an active stage invocation`);
    }

    const timestamp = input.event?.created_at ?? this.now();
    const event =
      input.event ??
      this.createEvent('handler.started', input.run_id, aggregate.task.task_id, input.run_id, {
        cursor: input.expected_cursor,
        invocation_id: input.invocation_id,
      });
    assertStageEvent(event, 'handler.started', aggregate.task.task_id, input.run_id);
    const committed = this.store.commitState({
      expected_task_revision: aggregate.task.revision,
      task: {
        ...aggregate.task,
        revision: aggregate.task.revision + 1,
        updated_at: timestamp,
      },
      run: {
        ...run,
        revision: run.revision + 1,
        updated_at: timestamp,
      },
      runtime_state: {
        ...aggregate.runtime_state,
        diagnostics: {
          ...aggregate.runtime_state.diagnostics,
          active_stage: {
            cursor: input.expected_cursor,
            invocation_id: input.invocation_id,
            started_at: timestamp,
            started_event_id: event.event_id,
          },
        },
        updated_at: timestamp,
      },
      events: [event],
    });
    return {
      snapshot: this.getTaskSnapshot(aggregate.task.task_id),
      committed_events: committed,
    };
  }

  advanceStage(input: AdvanceTaskStageInput): TaskStageCommitResult {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return this.advanceStageOnce(input);
      } catch (error) {
        if (
          error instanceof TaskProcessorStageCommitError &&
          isRevisionConflict(error.originalError) &&
          attempt < 3
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error('Unreachable stage commit retry state');
  }

  private advanceStageOnce(input: AdvanceTaskStageInput): TaskStageCommitResult {
    const aggregate = this.requireAggregateForRun(input.run_id);
    const run = requireRun(aggregate, input.run_id);
    assertActiveStageTarget(aggregate, run, input.expected_cursor);
    assertInvocation(aggregate, input.expected_cursor, input.invocation_id);
    assertEvidenceReference(input.evidence_ref);
    const nextInput = parseTaskCursorInput(resolveStageNextInput(aggregate, input));
    assertCursorTransition(input.expected_cursor, nextInput.cursor);
    assertChangesetIdentity(
      aggregate.runtime_state.cursor_input,
      nextInput,
      input.final_output,
    );
    const completing = nextInput.cursor === 'done';
    if (completing && !input.final_output) {
      throw new Error('Advancing deliver to done requires final_output');
    }
    if (completing) assertFinalOutputEvidence(input.final_output!);

    const timestamp = input.event?.created_at ?? this.now();
    const event =
      input.event ??
      this.createEvent('handler.completed', input.run_id, aggregate.task.task_id, input.run_id, {
        cursor: input.expected_cursor,
        invocation_id: input.invocation_id,
        next_cursor: nextInput.cursor,
        evidence_ref: input.evidence_ref.uri,
        evidence_sha256: input.evidence_ref.sha256,
      });
    assertStageEvent(event, 'handler.completed', aggregate.task.task_id, input.run_id);
    if (aggregate.events.some((candidate) => candidate.event_id === event.event_id)) {
      throw new Error(`Stage event ${event.event_id} already exists`);
    }
    const terminalEvent = completing
      ? this.createEvent('run.completed', input.run_id, aggregate.task.task_id, input.run_id, {
          status: 'completed',
          final_artifact_ref: input.final_output?.artifact_ref,
        })
      : undefined;
    if (completing) assertTaskStatusTransition(aggregate.task.status, 'completed');

    const { active_stage: _activeStage, ...diagnosticsWithoutActiveStage } =
      aggregate.runtime_state.diagnostics;
    const stageEvidence = readStageEvidence(diagnosticsWithoutActiveStage);
    const artifactRefs = appendUnique(aggregate.runtime_state.artifact_refs, [
      input.evidence_ref.uri,
      ...(input.artifact_refs ?? []),
    ]);
    const task: PersistedTaskState = {
      ...aggregate.task,
      ...(input.owner_agent_id
        ? { owner_agent_id: input.owner_agent_id }
        : nextInput.cursor === 'execute_agent'
          ? { owner_agent_id: nextInput.winner_agent_id }
          : {}),
      ...(completing
        ? {
            status: 'completed' as const,
            warnings: [...(input.warnings ?? [])],
            final_output: { ...input.final_output! },
          }
        : {}),
      revision: aggregate.task.revision + 1,
      updated_at: timestamp,
    };
    const nextRun: PersistedRunState = {
      ...run,
      ...(input.session_id ? { session_id: input.session_id } : {}),
      ...(completing ? { status: 'completed' as const, completed_at: timestamp } : {}),
      revision: run.revision + 1,
      updated_at: timestamp,
    };
    const runtimeState = {
      ...aggregate.runtime_state,
      ...(!completing ? { current_run_id: input.run_id } : {}),
      resume_cursor: nextInput.cursor,
      cursor_input: nextInput,
      waiting_on: [],
      artifact_refs: artifactRefs,
      diagnostics: {
        ...diagnosticsWithoutActiveStage,
        stage_evidence: {
          ...stageEvidence,
          [input.expected_cursor]: { ...input.evidence_ref },
        },
        last_completed_stage: input.expected_cursor,
        last_completed_invocation_id: input.invocation_id,
      },
      updated_at: timestamp,
    };
    if (completing) delete runtimeState.current_run_id;

    let committed: PersistedCoordinationEvent[];
    try {
      committed = this.store.commitState({
        expected_task_revision: aggregate.task.revision,
        task,
        run: nextRun,
        runtime_state: runtimeState,
        events: [event, ...(terminalEvent ? [terminalEvent] : [])],
      });
    } catch (error) {
      throw new TaskProcessorStageCommitError('handler.completed', error);
    }
    return {
      snapshot: this.getTaskSnapshot(aggregate.task.task_id),
      committed_events: committed,
    };
  }

  failStage(input: FailTaskStageInput): TaskStageCommitResult {
    const aggregate = this.requireAggregateForRun(input.run_id);
    const run = requireRun(aggregate, input.run_id);
    assertActiveStageTarget(aggregate, run, input.expected_cursor);
    assertInvocation(aggregate, input.expected_cursor, input.invocation_id);
    if (input.evidence_ref) assertEvidenceReference(input.evidence_ref);
    assertTaskStatusTransition(aggregate.task.status, 'failed');

    const timestamp = input.event?.created_at ?? this.now();
    const event =
      input.event ??
      this.createEvent('handler.failed', input.run_id, aggregate.task.task_id, input.run_id, {
        cursor: input.expected_cursor,
        invocation_id: input.invocation_id,
        code: input.error.code,
        message: input.error.message,
      });
    assertStageEvent(event, 'handler.failed', aggregate.task.task_id, input.run_id);
    const terminalEvent = this.createEvent(
      'run.failed',
      input.run_id,
      aggregate.task.task_id,
      input.run_id,
      { status: 'failed', code: input.error.code, message: input.error.message },
    );
    const { active_stage: _activeStage, ...diagnosticsWithoutActiveStage } =
      aggregate.runtime_state.diagnostics;
    const { current_run_id: _currentRunId, ...runtimeWithoutCurrentRun } = aggregate.runtime_state;
    const artifactRefs = appendUnique(aggregate.runtime_state.artifact_refs, [
      ...(input.evidence_ref ? [input.evidence_ref.uri] : []),
      ...(input.artifact_refs ?? []),
    ]);
    const committed = this.store.commitState({
      expected_task_revision: aggregate.task.revision,
      task: {
        ...aggregate.task,
        status: 'failed',
        ...(input.owner_agent_id ? { owner_agent_id: input.owner_agent_id } : {}),
        error: { ...input.error },
        revision: aggregate.task.revision + 1,
        updated_at: timestamp,
      },
      run: {
        ...run,
        status: 'failed',
        ...(input.session_id ? { session_id: input.session_id } : {}),
        error: { ...input.error },
        revision: run.revision + 1,
        completed_at: timestamp,
        updated_at: timestamp,
      },
      runtime_state: {
        ...runtimeWithoutCurrentRun,
        resume_cursor: 'done',
        cursor_input: { cursor: 'done' },
        waiting_on: [],
        artifact_refs: artifactRefs,
        diagnostics: {
          ...diagnosticsWithoutActiveStage,
          failed_stage: input.expected_cursor,
          failed_invocation_id: input.invocation_id,
          ...(input.evidence_ref ? { failed_stage_evidence: { ...input.evidence_ref } } : {}),
        },
        updated_at: timestamp,
      },
      events: [event, terminalEvent],
    });
    return {
      snapshot: this.getTaskSnapshot(aggregate.task.task_id),
      committed_events: committed,
    };
  }

  getRunExecutionState(runId: string): TaskRunExecutionState {
    const aggregate = this.requireAggregateForRun(runId);
    const run = requireRun(aggregate, runId);
    return {
      task_id: aggregate.task.task_id,
      run_id: runId,
      mode: run.mode,
      task_request: {
        spec: aggregate.task.spec,
        ...(aggregate.task.role_id ? { role_id: aggregate.task.role_id } : {}),
        ...(aggregate.task.parent_id ? { parent_task_id: aggregate.task.parent_id } : {}),
        risk_level: aggregate.task.risk_level,
        affected_paths: [...aggregate.task.affected_paths],
        completion_criteria: [...aggregate.task.completion_criteria],
        ...(aggregate.task.budget ? { budget: { ...aggregate.task.budget } } : {}),
      },
      workspace_path: aggregate.task.workspace_path,
      resume_cursor: aggregate.runtime_state.resume_cursor,
      ...(aggregate.runtime_state.cursor_input
        ? { cursor_input: aggregate.runtime_state.cursor_input }
        : {}),
      council_override: aggregate.runtime_state.diagnostics.council_override === true,
    };
  }

  setCouncilOverride(runId: string): TaskStageCommitResult {
    const aggregate = this.requireAggregateForRun(runId);
    const run = requireRun(aggregate, runId);
    assertActiveRunOwnership(aggregate, run);
    if (!['select_agent', 'execute_agent'].includes(aggregate.runtime_state.resume_cursor)) {
      throw new Error(
        `Council override is too late at ${aggregate.runtime_state.resume_cursor}; it must be requested before Gate`,
      );
    }
    if (aggregate.runtime_state.diagnostics.council_override === true) {
      return {
        snapshot: projectAggregate(aggregate),
        committed_events: [],
      };
    }

    const timestamp = this.now();
    const event = this.createEvent(
      'task.council_override_set',
      runId,
      aggregate.task.task_id,
      runId,
      { council_override: true },
    );
    const committed = this.store.commitState({
      expected_task_revision: aggregate.task.revision,
      task: {
        ...aggregate.task,
        revision: aggregate.task.revision + 1,
        updated_at: timestamp,
      },
      run: {
        ...run,
        revision: run.revision + 1,
        updated_at: timestamp,
      },
      runtime_state: {
        ...aggregate.runtime_state,
        diagnostics: {
          ...aggregate.runtime_state.diagnostics,
          council_override: true,
          council_override_event_id: event.event_id,
        },
        updated_at: timestamp,
      },
      events: [event],
    });
    return {
      snapshot: this.getTaskSnapshot(aggregate.task.task_id),
      committed_events: committed,
    };
  }

  recordRunEvent(runId: string, event: Event): TaskSnapshot {
    const aggregate = this.requireAggregateForRun(runId);
    if (aggregate.events.some((candidate) => candidate.event_id === event.event_id)) {
      return projectAggregate(aggregate);
    }
    const run = requireRun(aggregate, runId);
    if (!isActiveRun(run)) throw new Error(`Run ${runId} is already ${run.status}`);
    if (event.task_id !== aggregate.task.task_id || event.run_id !== runId) {
      throw new Error(`Event ${event.event_id} does not belong to run ${runId}`);
    }

    const timestamp = event.created_at || this.now();
    const selectedAgent = readPayloadString(event.payload, 'winner_agent_id');
    const sessionId = run.session_id ?? readPayloadString(event.payload, 'session_id');
    const artifactRefs = appendUnique(
      aggregate.runtime_state.artifact_refs,
      readPayloadStringArray(event.payload, 'artifact_refs'),
    );
    const nextCursor = cursorAfterEvent(
      event.event_type,
      event.payload,
      run.mode,
      aggregate.runtime_state.resume_cursor,
    );
    const cursorMoved = nextCursor !== aggregate.runtime_state.resume_cursor;
    const hasActiveStage = readActiveStage(aggregate.runtime_state.diagnostics) !== undefined;
    const shouldProjectCursor = cursorMoved && !hasActiveStage;
    const { cursor_input: _legacyCursorInput, ...runtimeWithoutCursorInput } =
      aggregate.runtime_state;
    this.store.commitState({
      expected_task_revision: aggregate.task.revision,
      task: {
        ...aggregate.task,
        ...(selectedAgent ? { owner_agent_id: selectedAgent } : {}),
        revision: aggregate.task.revision + 1,
        updated_at: timestamp,
      },
      run: {
        ...run,
        ...(sessionId ? { session_id: sessionId } : {}),
        revision: run.revision + 1,
        updated_at: timestamp,
      },
      runtime_state: {
        ...(shouldProjectCursor ? runtimeWithoutCursorInput : aggregate.runtime_state),
        resume_cursor: shouldProjectCursor
          ? nextCursor
          : aggregate.runtime_state.resume_cursor,
        artifact_refs: artifactRefs,
        diagnostics: {
          ...aggregate.runtime_state.diagnostics,
          ...(shouldProjectCursor ? { legacy_cursor_projection: true } : {}),
          ...(cursorMoved && hasActiveStage
            ? { legacy_cursor_projection_suppressed: true }
            : {}),
          last_event_id: event.event_id,
          last_event_type: event.event_type,
        },
        updated_at: timestamp,
      },
      events: [event],
    });
    return this.getTaskSnapshot(aggregate.task.task_id);
  }

  recoverInterruptedTasks(): TaskSnapshot[] {
    return this.store
      .listTaskAggregates()
      .filter((aggregate) => aggregate.runs.some((run) => isActiveRun(run)))
      .map((aggregate) => this.recoverInterruptedTask(aggregate));
  }

  finishRun(input: FinishTaskRunInput): TaskSnapshot {
    const aggregate = this.requireAggregateForRun(input.run_id);
    const run = requireRun(aggregate, input.run_id);
    if (!isActiveRun(run)) {
      if (run.status === input.status) return projectAggregate(aggregate);
      throw new Error(`Run ${input.run_id} already reached ${run.status}`);
    }
    assertTaskStatusTransition(aggregate.task.status, input.status);

    const timestamp = input.event?.created_at ?? this.now();
    const warnings = input.warnings ?? councilWarnings(input.snapshot);
    const error = input.error ?? firstSnapshotError(input.snapshot);
    const terminalEvent =
      input.event ??
      this.createEvent(
        input.status === 'completed'
          ? 'run.completed'
          : input.status === 'failed'
            ? 'run.failed'
            : 'run.cancelled',
        input.run_id,
        aggregate.task.task_id,
        input.run_id,
        {
          status: input.status,
          ...(error ? { code: error.code, message: error.message } : {}),
        },
      );
    const snapshotSessionId =
      input.snapshot?.run?.session_id ?? input.snapshot?.final_output?.session_id;
    const artifactRefs = appendUnique(
      aggregate.runtime_state.artifact_refs,
      input.snapshot?.final_output?.artifact_refs ?? [],
    );

    const {
      final_output: _previousFinalOutput,
      error: _previousTaskError,
      ...taskWithoutTerminalOutput
    } = aggregate.task;
    const { error: _previousRunError, ...runWithoutError } = run;
    const { current_run_id: _currentRunId, ...runtimeWithoutCurrentRun } = aggregate.runtime_state;

    this.store.commitState({
      expected_task_revision: aggregate.task.revision,
      task: {
        ...taskWithoutTerminalOutput,
        status: input.status,
        warnings: [...warnings],
        ...(input.status === 'completed' && input.final_output
          ? { final_output: { ...input.final_output } }
          : {}),
        ...(error ? { error: { ...error } } : {}),
        revision: aggregate.task.revision + 1,
        updated_at: timestamp,
      },
      run: {
        ...runWithoutError,
        status: input.status,
        ...(snapshotSessionId ? { session_id: snapshotSessionId } : {}),
        ...(input.snapshot ? { snapshot: input.snapshot } : {}),
        ...(error ? { error: { ...error } } : {}),
        revision: run.revision + 1,
        completed_at: timestamp,
        updated_at: timestamp,
      },
      runtime_state: {
        ...runtimeWithoutCurrentRun,
        resume_cursor: 'done',
        cursor_input: { cursor: 'done' },
        waiting_on: [],
        artifact_refs: artifactRefs,
        diagnostics: {
          ...aggregate.runtime_state.diagnostics,
          terminal_status: input.status,
          terminal_event_id: terminalEvent.event_id,
        },
        updated_at: timestamp,
      },
      events: [terminalEvent],
    });
    return this.getTaskSnapshot(aggregate.task.task_id);
  }

  getTaskSnapshot(taskId: string): TaskSnapshot {
    const aggregate = this.store.getTaskAggregate(taskId);
    if (!aggregate) throw new TaskProcessorTaskNotFoundError(taskId);
    return projectAggregate(aggregate);
  }

  listTaskSnapshots(): TaskSnapshot[] {
    return this.store.listTaskAggregates().map(projectAggregate);
  }

  listTaskEvents(taskId: string, afterEventId?: string): AppRunEvent[] {
    const aggregate = this.store.getTaskAggregate(taskId);
    if (!aggregate) throw new TaskProcessorTaskNotFoundError(taskId);
    const events = afterEventId
      ? (() => {
          const cursorIndex = aggregate.events.findIndex((event) => event.event_id === afterEventId);
          if (cursorIndex < 0) throw new TaskEventCursorNotFoundError(taskId, afterEventId);
          return aggregate.events.slice(cursorIndex + 1);
        })()
      : aggregate.events;
    return events.map((event) => ({
      event_id: event.event_id,
      sequence: event.sequence,
      run_id: event.run_id ?? event.subject_id,
      task_id: event.task_id ?? taskId,
      type: event.event_type,
      source: projectRunEventSource(event.event_type),
      created_at: event.created_at,
      payload: { ...event.payload },
      schema_version: event.schema_version,
    }));
  }

  getRunSnapshot(runId: string): RunSnapshot | undefined {
    const aggregate = this.store
      .listTaskAggregates()
      .find((candidate) => candidate.runs.some((run) => run.run_id === runId));
    return aggregate?.runs.find((run) => run.run_id === runId)?.snapshot;
  }

  getTaskLaunchContext(taskId: string): TaskLaunchContext {
    const aggregate = this.store.getTaskAggregate(taskId);
    if (!aggregate) throw new TaskProcessorTaskNotFoundError(taskId);
    const latestSession = aggregate.runs.find((run) => run.session_id)?.session_id;
    return {
      task_request: {
        spec: aggregate.task.spec,
        ...(aggregate.task.role_id ? { role_id: aggregate.task.role_id } : {}),
        ...(aggregate.task.parent_id ? { parent_task_id: aggregate.task.parent_id } : {}),
        risk_level: aggregate.task.risk_level,
        affected_paths: [...aggregate.task.affected_paths],
        completion_criteria: [...aggregate.task.completion_criteria],
        ...(aggregate.task.budget ? { budget: { ...aggregate.task.budget } } : {}),
      },
      workspace_path: aggregate.task.workspace_path,
      ...(latestSession ? { session_id: latestSession } : {}),
    };
  }

  getTaskResumeContext(taskId: string): TaskResumeContext {
    const aggregate = this.store.getTaskAggregate(taskId);
    if (!aggregate) throw new TaskProcessorTaskNotFoundError(taskId);
    const checkpoint = this.store.getLatestCheckpoint(taskId);
    if (!checkpoint) throw new Error(`Task ${taskId} has no valid full checkpoint`);
    const interruptedRun = requireRun(aggregate, checkpoint.run_id);
    const launch = this.getTaskLaunchContext(taskId);
    const sessionId = checkpoint.session_id ?? interruptedRun.session_id ?? launch.session_id;
    return {
      ...launch,
      ...(sessionId ? { session_id: sessionId } : {}),
      checkpoint_id: checkpoint.checkpoint_id,
      resume_cursor: checkpoint.resume_cursor,
      mode: interruptedRun.mode,
      interrupted_run_id: interruptedRun.run_id,
    };
  }

  private requireAggregateForRun(runId: string): PersistedTaskAggregate {
    const aggregate = this.store
      .listTaskAggregates()
      .find((candidate) => candidate.runs.some((run) => run.run_id === runId));
    if (!aggregate) throw new TaskProcessorRunNotFoundError(runId);
    return aggregate;
  }

  private recoverInterruptedTask(aggregate: PersistedTaskAggregate): TaskSnapshot {
    const run = aggregate.runs.find((candidate) => isActiveRun(candidate));
    if (!run) return projectAggregate(aggregate);
    assertTaskStatusTransition(aggregate.task.status, 'blocked');

    const timestamp = this.now();
    const reason = 'The backend process ended before the active run reached a terminal state.';
    const interruptState = {
      type: 'process_interrupted',
      reason,
      interrupted_run_id: run.run_id,
    };
    const checkpointId = createId('checkpoint');
    const latestCheckpoint = this.store.getLatestCheckpoint(aggregate.task.task_id);
    const checkpoint: PersistedFullCheckpoint = {
      checkpoint_id: checkpointId,
      ...(latestCheckpoint ? { parent_checkpoint_id: latestCheckpoint.checkpoint_id } : {}),
      task_id: aggregate.task.task_id,
      run_id: run.run_id,
      agent_id:
        readLatestEventString(aggregate, 'agent_id') ??
        aggregate.task.owner_agent_id ??
        aggregate.task.role_id ??
        'coordinator',
      ...(run.session_id ? { session_id: run.session_id } : {}),
      trigger: 'blocked',
      resume_cursor: aggregate.runtime_state.resume_cursor,
      message_thread: aggregate.events.map((event, index) => ({
        message_id: event.event_id,
        role: projectRunEventSource(event.event_type),
        content: event.event_type,
        turn: index + 1,
        artifact_refs: readPayloadStringArray(event.payload, 'artifact_refs'),
        created_at: event.created_at,
      })),
      mechanical_snapshot: {
        base_commit: 'unknown',
        worktree_path: aggregate.task.workspace_path,
        branch: 'runtime-recovery',
        modified_files: [],
      },
      semantic_handoff: {
        done: aggregate.events.map((event) => event.event_type),
        in_progress: [aggregate.runtime_state.resume_cursor],
        blocked_on: ['backend process interrupted'],
        assumptions: [],
        next_steps: [`resume ${aggregate.runtime_state.resume_cursor}`],
        known_risks: ['unfinished action will be re-executed'],
      },
      interrupt_state: interruptState,
      artifact_refs: [...aggregate.runtime_state.artifact_refs],
      validity_status: 'valid',
      created_at: timestamp,
      schema_version: SCHEMA_VERSION,
    };
    const runInterrupted = this.createEvent(
      'run.interrupted',
      run.run_id,
      aggregate.task.task_id,
      run.run_id,
      { reason, resume_cursor: aggregate.runtime_state.resume_cursor },
    );
    const taskBlocked = this.createEvent(
      'task.blocked',
      aggregate.task.task_id,
      aggregate.task.task_id,
      run.run_id,
      { reason, interrupted_run_id: run.run_id },
    );
    const checkpointSaved = this.createEvent(
      'checkpoint.saved',
      checkpointId,
      aggregate.task.task_id,
      run.run_id,
      { checkpoint_id: checkpointId, resume_cursor: aggregate.runtime_state.resume_cursor },
    );
    const { current_run_id: _currentRunId, ...runtimeWithoutCurrentRun } = aggregate.runtime_state;

    this.store.commitState({
      expected_task_revision: aggregate.task.revision,
      task: {
        ...aggregate.task,
        status: 'blocked',
        revision: aggregate.task.revision + 1,
        updated_at: timestamp,
      },
      run: {
        ...run,
        status: 'interrupted',
        revision: run.revision + 1,
        completed_at: timestamp,
        updated_at: timestamp,
      },
      runtime_state: {
        ...runtimeWithoutCurrentRun,
        interrupt_state: interruptState,
        diagnostics: {
          ...aggregate.runtime_state.diagnostics,
          interrupted_run_id: run.run_id,
          recovery_checkpoint_id: checkpointId,
        },
        updated_at: timestamp,
      },
      checkpoint,
      events: [runInterrupted, taskBlocked, checkpointSaved],
    });
    return this.getTaskSnapshot(aggregate.task.task_id);
  }

  private createEvent(
    eventType: EventType,
    subjectId: string,
    taskId: string,
    runId: string,
    payload: Record<string, unknown>,
  ): Event {
    return {
      event_id: this.createEventId(),
      event_type: eventType,
      subject_id: subjectId,
      run_id: runId,
      task_id: taskId,
      payload,
      created_at: this.now(),
      schema_version: SCHEMA_VERSION,
    };
  }
}

function projectAggregate(aggregate: PersistedTaskAggregate): TaskSnapshot {
  const projected = projectTaskSnapshot({
    task_id: aggregate.task.task_id,
    task_request: {
      spec: aggregate.task.spec,
      ...(aggregate.task.role_id ? { role_id: aggregate.task.role_id } : {}),
      ...(aggregate.task.parent_id ? { parent_task_id: aggregate.task.parent_id } : {}),
      risk_level: aggregate.task.risk_level,
      affected_paths: [...aggregate.task.affected_paths],
      completion_criteria: [...aggregate.task.completion_criteria],
      ...(aggregate.task.budget ? { budget: { ...aggregate.task.budget } } : {}),
    },
    created_at: aggregate.task.created_at,
    runs: aggregate.runs.map(toRunFact),
  });
  const waitingReason = readWaitingReason(aggregate);
  return taskSnapshotSchema.parse({
    ...projected,
    revision: aggregate.task.revision,
    task: {
      ...projected.task,
      status: aggregate.task.status,
      ...(aggregate.task.owner_agent_id ? { owner_agent_id: aggregate.task.owner_agent_id } : {}),
      updated_at: aggregate.task.updated_at,
    },
    ...(waitingReason ? { waiting_reason: waitingReason } : {}),
    warnings: [...aggregate.task.warnings],
    ...(aggregate.task.error ? { error: { ...aggregate.task.error } } : {}),
    ...(!projected.final_output && aggregate.task.final_output
      ? {
          final_output: {
            artifact_refs: [aggregate.task.final_output.artifact_ref],
            files_written: [aggregate.task.final_output.workspace_path],
            changed_files: [],
            sha256: aggregate.task.final_output.sha256,
          },
        }
      : {}),
  });
}

function toRunFact(run: PersistedRunState): TaskRunFact {
  return {
    run_id: run.run_id,
    task_id: run.task_id,
    status: run.status === 'created' ? 'running' : run.status,
    mode: run.mode,
    restartable: run.status !== 'running' && run.status !== 'created',
    ...(run.session_id ? { session_id: run.session_id } : {}),
    ...(run.started_at ? { started_at: run.started_at } : {}),
    ...(run.completed_at ? { completed_at: run.completed_at } : {}),
    ...(run.error ? { error: { ...run.error } } : {}),
    revision: run.revision,
    ...(run.snapshot ? { snapshot: run.snapshot } : {}),
  };
}

function requireRun(aggregate: PersistedTaskAggregate, runId: string): PersistedRunState {
  const run = aggregate.runs.find((candidate) => candidate.run_id === runId);
  if (!run) throw new TaskProcessorRunNotFoundError(runId);
  return run;
}

function assertImmutableTaskDefinition(
  task: PersistedTaskState,
  request: TaskCreateRequest,
  workspacePath: string,
): void {
  if (
    task.spec !== request.spec ||
    task.workspace_path !== workspacePath ||
    task.parent_id !== request.parent_task_id ||
    task.role_id !== request.role_id ||
    task.risk_level !== (request.risk_level ?? 'low') ||
    JSON.stringify(task.completion_criteria) !== JSON.stringify(request.completion_criteria) ||
    JSON.stringify(task.affected_paths) !== JSON.stringify(request.affected_paths ?? []) ||
    JSON.stringify(task.budget) !== JSON.stringify(request.budget)
  ) {
    throw new Error(`Task ${task.task_id} definition cannot change between runs`);
  }
}

function isActiveRun(run: PersistedRunState): boolean {
  return run.status === 'created' || run.status === 'running';
}

const CURSOR_TRANSITIONS: Readonly<Record<TaskResumeCursor, readonly TaskResumeCursor[]>> = {
  select_agent: ['execute_agent'],
  execute_agent: ['council', 'gate'],
  council: ['gate'],
  gate: ['deliver'],
  deliver: ['done'],
  mailbox_wait: [],
  done: [],
};

function defaultCursorInput(runId: string): TaskCursorInput {
  return {
    cursor: 'select_agent',
    seed: runId,
    candidate_ids: [],
  };
}

function resolveStageNextInput(
  aggregate: PersistedTaskAggregate,
  input: AdvanceTaskStageInput,
): TaskCursorInput {
  const overrideRequested = aggregate.runtime_state.diagnostics.council_override === true;
  if (
    overrideRequested &&
    input.expected_cursor === 'execute_agent' &&
    input.next_input.cursor === 'gate' &&
    !input.council_override_input
  ) {
    throw new Error('Council override requires a Council input before execute_agent can advance');
  }
  if (!input.council_override_input) return input.next_input;
  if (
    input.expected_cursor !== 'execute_agent' ||
    input.next_input.cursor !== 'gate' ||
    input.council_override_input.trigger !== 'persistent_override'
  ) {
    throw new Error(
      'Council override input is only valid for execute_agent -> gate with persistent_override',
    );
  }
  return overrideRequested
    ? input.council_override_input
    : input.next_input;
}

function assertBeginRunIntent(
  existing: PersistedTaskAggregate | undefined,
  input: BeginTaskRunInput,
  cursorInput: TaskCursorInput,
  intent: BeginTaskRunIntent,
  latestCheckpoint: PersistedFullCheckpoint | undefined,
): void {
  parseTaskCursorInput(cursorInput);
  if (intent.type === 'create') {
    if (existing) {
      throw new Error(
        `Create run intent cannot restart existing Task ${input.task_id}; use checkpoint resume or Council refinement`,
      );
    }
    if (cursorInput.cursor !== 'select_agent') {
      throw new Error(`Fresh Task ${input.task_id} must begin at select_agent`);
    }
    if (input.resume_checkpoint_id || input.requested_resume_cursor) {
      throw new Error('Create run intent cannot include checkpoint resume fields');
    }
    return;
  }
  if (!existing) {
    throw new Error(
      `Run intent ${intent.type} requires an existing Task ${input.task_id}`,
    );
  }

  if (intent.type === 'council_refinement') {
    assertTaskRunStartTransition(existing.task.status, intent.type);
    if (input.mode !== 'council' || cursorInput.cursor !== 'select_agent') {
      throw new Error('Council refinement must use Council mode and begin at select_agent');
    }
    if (
      input.resume_checkpoint_id ||
      input.requested_resume_cursor ||
      input.restarted_from_run_id
    ) {
      throw new Error('Council refinement cannot include checkpoint resume lineage');
    }
    return;
  }

  if (
    !latestCheckpoint ||
    input.resume_checkpoint_id !== latestCheckpoint.checkpoint_id ||
    input.requested_resume_cursor !== latestCheckpoint.resume_cursor
  ) {
    throw new Error(
      `Task ${input.task_id} checkpoint resume must match its latest checkpoint and requested cursor`,
    );
  }
  assertTaskRunStartTransition(existing.task.status, intent.type);
  if (input.restarted_from_run_id !== latestCheckpoint.run_id) {
    throw new Error(
      `Task ${input.task_id} restarted_from_run_id must match checkpoint run ${latestCheckpoint.run_id}`,
    );
  }
  const interruptedRun = existing.runs.find(
    (candidate) => candidate.run_id === latestCheckpoint.run_id,
  );
  if (!interruptedRun || interruptedRun.status !== 'interrupted') {
    throw new Error(
      `Task ${input.task_id} checkpoint source Run ${latestCheckpoint.run_id} must be interrupted`,
    );
  }
  if (input.mode !== interruptedRun.mode) {
    throw new Error('Checkpoint resume must preserve the interrupted Run mode');
  }
  if (
    (intent.strategy === 'from_checkpoint' &&
      cursorInput.cursor !== latestCheckpoint.resume_cursor) ||
    (intent.strategy === 'restart_from_beginning' && cursorInput.cursor !== 'select_agent')
  ) {
    throw new Error(
      `Checkpoint resume cursor does not match strategy ${intent.strategy}`,
    );
  }
}

function assertFinalOutputEvidence(output: PersistedTaskFinalOutput): void {
  if (
    !output.artifact_ref ||
    !output.workspace_path ||
    !/^[a-f0-9]{64}$/.test(output.sha256)
  ) {
    throw new Error(
      'Final output requires a non-empty artifact, workspace path, and lowercase SHA256',
    );
  }
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof Error && /\brevision conflict\b/i.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertChangesetIdentity(
  currentInput: TaskCursorInput | undefined,
  nextInput: TaskCursorInput,
  finalOutput: PersistedTaskFinalOutput | undefined,
): void {
  if (currentInput?.cursor === 'gate' && nextInput.cursor === 'deliver') {
    if (
      nextInput.changeset_ref !== currentInput.changeset_ref ||
      nextInput.expected_sha256 !== currentInput.expected_sha256
    ) {
      throw new Error('Gate changeset identity cannot change during delivery handoff');
    }
  }
  if (currentInput?.cursor === 'deliver' && nextInput.cursor === 'done') {
    if (
      finalOutput?.artifact_ref !== currentInput.changeset_ref ||
      finalOutput.sha256 !== currentInput.expected_sha256
    ) {
      throw new Error('Final output identity must match the bound delivery changeset and hash');
    }
  }
}

function assertActiveRunOwnership(aggregate: PersistedTaskAggregate, run: PersistedRunState): void {
  if (!isActiveRun(run)) throw new Error(`Run ${run.run_id} is already ${run.status}`);
  if (aggregate.task.status !== 'running') {
    throw new Error(`Task ${aggregate.task.task_id} is ${aggregate.task.status}`);
  }
  if (aggregate.runtime_state.current_run_id !== run.run_id) {
    throw new Error(`Run ${run.run_id} is not the current run for Task ${aggregate.task.task_id}`);
  }
}

function assertActiveStageTarget(
  aggregate: PersistedTaskAggregate,
  run: PersistedRunState,
  expectedCursor: TaskResumeCursor,
): void {
  assertActiveRunOwnership(aggregate, run);
  if (aggregate.runtime_state.resume_cursor !== expectedCursor) {
    throw new Error(
      `Run ${run.run_id} cursor mismatch: expected ${expectedCursor}, current ${aggregate.runtime_state.resume_cursor}`,
    );
  }
  if (aggregate.runtime_state.cursor_input?.cursor !== expectedCursor) {
    throw new Error(`Run ${run.run_id} has no matching cursor input for ${expectedCursor}`);
  }
}

function assertCursorTransition(current: TaskResumeCursor, next: TaskResumeCursor): void {
  if (!CURSOR_TRANSITIONS[current].includes(next)) {
    throw new Error(`Invalid task cursor transition: ${current} -> ${next}`);
  }
}

function assertEvidenceReference(reference: RunStageEvidenceReference): void {
  if (!reference.uri || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
    throw new Error('Stage evidence reference requires a URI and lowercase SHA256');
  }
}

function assertInvocation(
  aggregate: PersistedTaskAggregate,
  expectedCursor: TaskResumeCursor,
  invocationId: string,
): void {
  const active = readActiveStage(aggregate.runtime_state.diagnostics);
  if (!active) {
    throw new Error(
      `Run ${aggregate.runtime_state.current_run_id ?? 'unknown'} has no active stage`,
    );
  }
  if (active.cursor !== expectedCursor || active.invocation_id !== invocationId) {
    throw new Error(
      `Stage invocation mismatch: expected ${expectedCursor}/${invocationId}, current ${active.cursor}/${active.invocation_id}`,
    );
  }
}

function readActiveStage(
  diagnostics: Record<string, unknown>,
): { cursor: TaskResumeCursor; invocation_id: string } | undefined {
  const value = diagnostics.active_stage;
  if (!value || typeof value !== 'object') return undefined;
  const cursor = Reflect.get(value, 'cursor');
  const invocationId = Reflect.get(value, 'invocation_id');
  if (!isTaskResumeCursor(cursor) || typeof invocationId !== 'string' || !invocationId) {
    throw new Error('Persisted active_stage diagnostics are invalid');
  }
  return { cursor, invocation_id: invocationId };
}

function readStageEvidence(
  diagnostics: Record<string, unknown>,
): Partial<Record<TaskResumeCursor, RunStageEvidenceReference>> {
  const value = diagnostics.stage_evidence;
  return value && typeof value === 'object'
    ? (value as Partial<Record<TaskResumeCursor, RunStageEvidenceReference>>)
    : {};
}

function isTaskResumeCursor(value: unknown): value is TaskResumeCursor {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(CURSOR_TRANSITIONS, value)
  );
}

function assertStageEvent(event: Event, expectedType: string, taskId: string, runId: string): void {
  if (event.event_type !== expectedType) {
    throw new Error(`Stage event must have type ${expectedType}`);
  }
  if (event.task_id !== taskId || event.run_id !== runId) {
    throw new Error(`Stage event ${event.event_id} does not belong to run ${runId}`);
  }
}

function cursorAfterEvent(
  eventType: string,
  payload: Record<string, unknown>,
  mode: PersistedRunMode,
  current: TaskResumeCursor,
): TaskResumeCursor {
  if (eventType === 'market.selected') return 'execute_agent';
  if (
    eventType === 'agent.execution_requested' ||
    eventType === 'memory.context_pack_built' ||
    eventType === 'driver.session_started'
  ) {
    return 'execute_agent';
  }
  if (eventType === 'agent.execution_completed' || eventType === 'driver.run_result') {
    return 'gate';
  }
  if (
    eventType.startsWith('council.') &&
    !['council.completed', 'council.decision'].includes(eventType)
  ) {
    return 'council';
  }
  if (eventType === 'council.completed' || eventType === 'council.decision') return 'gate';
  if (eventType === 'gate.result') {
    return mode === 'council' && payload.phase === 'pre_council' ? 'council' : 'deliver';
  }
  if (
    eventType === 'artifact.selected' ||
    eventType === 'artifact.delivered' ||
    eventType === 'worktree.materialized' ||
    eventType === 'checkpoint.saved'
  ) {
    return 'deliver';
  }
  return current;
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPayloadStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function appendUnique(current: readonly string[], additions: readonly string[]): string[] {
  return [...new Set([...current, ...additions])];
}

function readLatestEventString(
  aggregate: PersistedTaskAggregate,
  key: string,
): string | undefined {
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index];
    if (!event) continue;
    const value = readPayloadString(event.payload, key);
    if (value) return value;
  }
  return undefined;
}

function councilWarnings(snapshot: RunSnapshot | undefined): string[] {
  const result = snapshot?.council?.result;
  if (!result || typeof result !== 'object') return [];
  const warnings = Reflect.get(result, 'warnings');
  return Array.isArray(warnings)
    ? warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
}

function firstSnapshotError(
  snapshot: RunSnapshot | undefined,
): FinishTaskRunInput['error'] | undefined {
  const error = snapshot?.errors[0];
  return error
    ? {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: { ...error.details } } : {}),
      }
    : undefined;
}

function readWaitingReason(aggregate: PersistedTaskAggregate): string | undefined {
  if (
    !['waiting_help', 'waiting_input', 'pending_gate', 'pending_council', 'blocked'].includes(
      aggregate.task.status,
    )
  ) {
    return undefined;
  }
  const reason = aggregate.runtime_state.interrupt_state?.reason;
  return typeof reason === 'string' && reason.length > 0
    ? reason
    : 'Task is waiting for a persisted runtime condition.';
}
