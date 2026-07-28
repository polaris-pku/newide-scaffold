import { createId, type TaskCreateRequest } from '../core';
import type {
  PersistedRunMode,
  PersistedTaskFinalOutput,
  RunEvidenceStore,
  RunStageEvidenceReference,
  TaskCouncilTrigger,
  TaskCursorInput,
  TaskResumeCursor,
} from '../persistence';
import {
  TaskProcessorStageCommitError,
  type TaskProcessor,
  type TaskRunExecutionState,
  type TaskStageCommitResult,
} from './task-processor';
import type { TaskSnapshot } from '../protocol/task-snapshot';

type CursorInput<TCursor extends TaskResumeCursor> = Extract<TaskCursorInput, { cursor: TCursor }>;

export interface TaskStageExecutionContext<TCursor extends TaskResumeCursor> {
  task_id: string;
  run_id: string;
  mode: PersistedRunMode;
  task_request: TaskCreateRequest;
  workspace_path: string;
  cursor_input: CursorInput<TCursor>;
}

export interface CouncilEscalationRequest {
  type: 'request_council';
  reason?: string;
}

interface StageResult {
  evidence: Record<string, unknown>;
  artifact_refs?: string[];
}

interface StageAdvanceMetadata {
  owner_agent_id?: string;
  session_id?: string;
  final_output?: PersistedTaskFinalOutput;
  warnings?: string[];
  council_override_input?: Extract<TaskCursorInput, { cursor: 'council' }>;
}

export interface SelectAgentStageResult extends StageResult {
  winner_agent_id: string;
}

export interface ExecuteAgentStageResult extends StageResult {
  changeset_ref: string;
  expected_sha256: string;
  agent_id?: string;
  session_id?: string;
  escalation_request?: CouncilEscalationRequest;
}

export interface CouncilStageResult extends StageResult {
  changeset_ref: string;
  expected_sha256: string;
}

export type GateStageResult = StageResult;

export interface DeliverStageResult extends StageResult {
  final_output: PersistedTaskFinalOutput;
  warnings?: string[];
}

export interface SelectAgentStageExecutor {
  execute(context: TaskStageExecutionContext<'select_agent'>): Promise<SelectAgentStageResult>;
}

export interface ExecuteAgentStageExecutor {
  execute(context: TaskStageExecutionContext<'execute_agent'>): Promise<ExecuteAgentStageResult>;
}

export interface CouncilStageExecutor {
  execute(context: TaskStageExecutionContext<'council'>): Promise<CouncilStageResult>;
}

export interface GateStageExecutor {
  execute(context: TaskStageExecutionContext<'gate'>): Promise<GateStageResult>;
}

export interface DeliverStageExecutor {
  execute(context: TaskStageExecutionContext<'deliver'>): Promise<DeliverStageResult>;
}

export interface TaskExecutionLoopExecutors {
  select_agent: SelectAgentStageExecutor;
  execute_agent: ExecuteAgentStageExecutor;
  council: CouncilStageExecutor;
  gate: GateStageExecutor;
  deliver: DeliverStageExecutor;
}

export interface TaskExecutionLoopOptions {
  processor: TaskProcessor;
  evidence_store: RunEvidenceStore;
  executors: TaskExecutionLoopExecutors;
  create_invocation_id?: (cursor: TaskResumeCursor) => string;
}

export interface RunTaskExecutionInput {
  task_id: string;
  run_id: string;
  council_override?: boolean;
}

export class TaskExecutionLoop {
  private readonly processor: TaskProcessor;
  private readonly evidenceStore: RunEvidenceStore;
  private readonly executors: TaskExecutionLoopExecutors;
  private readonly createInvocationId: (cursor: TaskResumeCursor) => string;

  constructor(options: TaskExecutionLoopOptions) {
    this.processor = options.processor;
    this.evidenceStore = options.evidence_store;
    this.executors = options.executors;
    this.createInvocationId =
      options.create_invocation_id ?? ((cursor) => createId(`invocation_${cursor}`));
  }

  async run(input: RunTaskExecutionInput): Promise<TaskSnapshot> {
    const initialState = this.processor.getRunExecutionState(input.run_id);
    assertRunTaskIdentity(initialState, input.task_id);
    if (input.council_override === true) {
      this.processor.setCouncilOverride(input.run_id);
    }
    for (;;) {
      const state = this.processor.getRunExecutionState(input.run_id);
      assertRunTaskIdentity(state, input.task_id);
      const cursorInput = requireCursorInput(state);
      if (cursorInput.cursor === 'done' || cursorInput.cursor === 'mailbox_wait') {
        return this.processor.getTaskSnapshot(input.task_id);
      }

      const result = await this.executeStage(state, cursorInput);
      if (result.snapshot.task.status !== 'running') return result.snapshot;
    }
  }

  private async executeStage(
    state: TaskRunExecutionState,
    cursorInput: Exclude<TaskCursorInput, { cursor: 'done' | 'mailbox_wait' }>,
  ): Promise<TaskStageCommitResult> {
    const invocationId = this.createInvocationId(cursorInput.cursor);
    this.processor.startStage({
      run_id: state.run_id,
      expected_cursor: cursorInput.cursor,
      invocation_id: invocationId,
    });

    try {
      switch (cursorInput.cursor) {
        case 'select_agent': {
          const result = await this.executors.select_agent.execute(
            stageContext(state, cursorInput),
          );
          return await this.persistAndAdvance(state, cursorInput.cursor, invocationId, result, {
            cursor: 'execute_agent',
            winner_agent_id: result.winner_agent_id,
          });
        }
        case 'execute_agent': {
          const result = await this.executors.execute_agent.execute(
            stageContext(state, cursorInput),
          );
          assertChangesetResult(result, 'Primary Agent');
          const evidence = await this.writeEvidence(state.run_id, cursorInput.cursor, result);
          const trigger = councilTrigger(state.mode, result.escalation_request);
          const nextInput: TaskCursorInput = trigger
            ? {
                cursor: 'council',
                trigger,
                primary_evidence_ref: evidence.uri,
                candidate_manifest_ref: result.changeset_ref,
              }
            : {
                cursor: 'gate',
                subject_ref: result.changeset_ref,
                phase: 'post_primary',
                changeset_ref: result.changeset_ref,
                expected_sha256: result.expected_sha256,
              };
          return this.advanceWithEvidence(
            state,
            cursorInput.cursor,
            invocationId,
            evidence,
            nextInput,
            result,
            {
              ...(result.agent_id ? { owner_agent_id: result.agent_id } : {}),
              ...(result.session_id ? { session_id: result.session_id } : {}),
              ...(!trigger
                ? {
                    council_override_input: {
                      cursor: 'council' as const,
                      trigger: 'persistent_override' as const,
                      primary_evidence_ref: evidence.uri,
                      candidate_manifest_ref: result.changeset_ref,
                    },
                  }
                : {}),
            },
          );
        }
        case 'council': {
          const result = await this.executors.council.execute(stageContext(state, cursorInput));
          assertChangesetResult(result, 'Council');
          return await this.persistAndAdvance(state, cursorInput.cursor, invocationId, result, {
            cursor: 'gate',
            subject_ref: result.changeset_ref,
            phase: 'post_council',
            changeset_ref: result.changeset_ref,
            expected_sha256: result.expected_sha256,
          });
        }
        case 'gate': {
          const result = await this.executors.gate.execute(stageContext(state, cursorInput));
          assertGateResultIdentity(result, cursorInput);
          return await this.persistAndAdvance(state, cursorInput.cursor, invocationId, result, {
            cursor: 'deliver',
            changeset_ref: cursorInput.changeset_ref,
            expected_sha256: cursorInput.expected_sha256,
          });
        }
        case 'deliver': {
          const result = await this.executors.deliver.execute(stageContext(state, cursorInput));
          const evidence = await this.writeEvidence(state.run_id, cursorInput.cursor, result);
          return this.advanceWithEvidence(
            state,
            cursorInput.cursor,
            invocationId,
            evidence,
            { cursor: 'done' },
            result,
            {
              final_output: result.final_output,
              ...(result.warnings ? { warnings: result.warnings } : {}),
            },
          );
        }
      }
    } catch (error) {
      if (error instanceof TaskProcessorStageCommitError) throw error;
      const failureError = error instanceof StageAdvanceError ? error.originalError : error;
      const failure = stageFailure(failureError, cursorInput.cursor);
      const resultEvidence = error instanceof StageAdvanceError ? error.evidenceRef : undefined;
      const failureEvidence =
        error instanceof StageEvidenceWriteError
          ? undefined
          : await this.writeFailureEvidence(
              state.run_id,
              cursorInput.cursor,
              failure,
              resultEvidence,
            );
      return this.processor.failStage({
        run_id: state.run_id,
        expected_cursor: cursorInput.cursor,
        invocation_id: invocationId,
        error: failure,
        ...(failureEvidence ? { evidence_ref: failureEvidence } : {}),
        ...(resultEvidence ? { artifact_refs: [resultEvidence.uri] } : {}),
      });
    }
  }

  private async persistAndAdvance(
    state: TaskRunExecutionState,
    cursor: 'select_agent' | 'council' | 'gate',
    invocationId: string,
    result: StageResult,
    nextInput: TaskCursorInput,
  ): Promise<TaskStageCommitResult> {
    const evidence = await this.writeEvidence(state.run_id, cursor, result);
    return this.advanceWithEvidence(state, cursor, invocationId, evidence, nextInput, result);
  }

  private advanceWithEvidence(
    state: TaskRunExecutionState,
    cursor: Exclude<TaskResumeCursor, 'done' | 'mailbox_wait'>,
    invocationId: string,
    evidence: RunStageEvidenceReference,
    nextInput: TaskCursorInput,
    result: StageResult,
    metadata: StageAdvanceMetadata = {},
  ): TaskStageCommitResult {
    try {
      return this.processor.advanceStage({
        run_id: state.run_id,
        expected_cursor: cursor,
        invocation_id: invocationId,
        evidence_ref: evidence,
        next_input: nextInput,
        ...(metadata.council_override_input
          ? { council_override_input: metadata.council_override_input }
          : {}),
        ...(metadata.owner_agent_id ? { owner_agent_id: metadata.owner_agent_id } : {}),
        ...(metadata.session_id ? { session_id: metadata.session_id } : {}),
        ...(metadata.final_output ? { final_output: metadata.final_output } : {}),
        ...(metadata.warnings ? { warnings: metadata.warnings } : {}),
        ...(result.artifact_refs ? { artifact_refs: result.artifact_refs } : {}),
      });
    } catch (error) {
      if (error instanceof TaskProcessorStageCommitError) throw error;
      throw new StageAdvanceError(error, evidence);
    }
  }

  private writeEvidence(runId: string, cursor: TaskResumeCursor, result: StageResult) {
    return this.evidenceStore
      .writeStage({
        run_id: runId,
        stage: cursor,
        evidence: result.evidence,
      })
      .catch((error: unknown) => {
        throw new StageEvidenceWriteError(error);
      });
  }

  private async writeFailureEvidence(
    runId: string,
    cursor: TaskResumeCursor,
    failure: { code: string; message: string; details: Record<string, unknown> },
    resultEvidence?: RunStageEvidenceReference,
  ): Promise<RunStageEvidenceReference | undefined> {
    try {
      return await this.evidenceStore.writeFailure({
        run_id: runId,
        stage: cursor,
        evidence: {
          status: 'failed',
          ...failure,
          ...(resultEvidence ? { result_evidence_ref: resultEvidence } : {}),
        },
      });
    } catch {
      return undefined;
    }
  }
}

function assertRunTaskIdentity(state: TaskRunExecutionState, taskId: string): void {
  if (state.task_id !== taskId) {
    throw new Error(`Run ${state.run_id} does not belong to Task ${taskId}`);
  }
}

class StageEvidenceWriteError extends Error {
  constructor(readonly originalError: unknown) {
    super(errorMessage(originalError));
    this.name = 'StageEvidenceWriteError';
  }
}

class StageAdvanceError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly evidenceRef: RunStageEvidenceReference,
  ) {
    super(errorMessage(originalError));
    this.name = 'StageAdvanceError';
  }
}

function stageContext<TCursor extends Exclude<TaskResumeCursor, 'done' | 'mailbox_wait'>>(
  state: TaskRunExecutionState,
  cursorInput: CursorInput<TCursor>,
): TaskStageExecutionContext<TCursor> {
  return {
    task_id: state.task_id,
    run_id: state.run_id,
    mode: state.mode,
    task_request: state.task_request,
    workspace_path: state.workspace_path,
    cursor_input: cursorInput,
  };
}

function requireCursorInput(state: TaskRunExecutionState): TaskCursorInput {
  if (!state.cursor_input || state.cursor_input.cursor !== state.resume_cursor) {
    throw new Error(`Run ${state.run_id} has no cursor input matching ${state.resume_cursor}`);
  }
  return state.cursor_input;
}

function councilTrigger(
  mode: PersistedRunMode,
  escalation: CouncilEscalationRequest | undefined,
): TaskCouncilTrigger | undefined {
  if (mode === 'council') return 'explicit_mode';
  return escalation?.type === 'request_council' ? 'agent_request' : undefined;
}

function assertChangesetResult(
  result: { changeset_ref: string; expected_sha256: string },
  source: string,
): void {
  if (!result.changeset_ref || !/^[a-f0-9]{64}$/.test(result.expected_sha256)) {
    throw new Error(`${source} returned an invalid changeset identity`);
  }
}

function assertGateResultIdentity(result: GateStageResult, input: CursorInput<'gate'>): void {
  const returnedRef = Reflect.get(result, 'changeset_ref');
  const returnedHash = Reflect.get(result, 'expected_sha256');
  if (
    (returnedRef !== undefined && returnedRef !== input.changeset_ref) ||
    (returnedHash !== undefined && returnedHash !== input.expected_sha256)
  ) {
    throw new Error('Gate executor cannot substitute the bound changeset identity');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stageFailure(
  error: unknown,
  cursor: TaskResumeCursor,
): { code: string; message: string; details: Record<string, unknown> } {
  return {
    code:
      error instanceof StageEvidenceWriteError
        ? 'stage_evidence_write_failed'
        : 'stage_execution_failed',
    message: errorMessage(error),
    details: { cursor },
  };
}
