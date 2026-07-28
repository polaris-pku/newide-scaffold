import type { Event, RiskLevel, SchemaVersion, TaskBudget, TaskStatus } from '../core';
import type { RunSnapshot } from '../protocol/run-snapshot';

export type PersistedRunMode = 'single_agent' | 'council';
export type PersistedRunStatus =
  | 'created'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskResumeCursor =
  | 'select_agent'
  | 'execute_agent'
  | 'council'
  | 'gate'
  | 'deliver'
  | 'mailbox_wait'
  | 'done';

export type TaskCouncilTrigger = 'explicit_mode' | 'persistent_override' | 'agent_request';

export type TaskCursorInput =
  | {
      cursor: 'select_agent';
      seed: string;
      candidate_ids: string[];
      market_evidence_ref?: string;
    }
  | {
      cursor: 'execute_agent';
      winner_agent_id: string;
      execution_evidence_ref?: string;
    }
  | {
      cursor: 'council';
      trigger: TaskCouncilTrigger;
      primary_evidence_ref?: string;
      candidate_manifest_ref?: string;
    }
  | {
      cursor: 'gate';
      subject_ref: string;
      phase: string;
      changeset_ref: string;
      expected_sha256: string;
    }
  | {
      cursor: 'deliver';
      changeset_ref: string;
      expected_sha256: string;
    }
  | {
      cursor: 'mailbox_wait';
      delivery_ids: string[];
      waiting_reason: string;
    }
  | {
      cursor: 'done';
    };

export function parseTaskCursorInput(value: unknown): TaskCursorInput {
  if (!isRecord(value) || typeof value.cursor !== 'string') {
    throw new Error('Task cursor input must be an object with a cursor');
  }
  switch (value.cursor) {
    case 'select_agent': {
      const marketEvidenceRef = optionalString(value.market_evidence_ref, 'market_evidence_ref');
      return {
        cursor: value.cursor,
        seed: requireString(value.seed, 'seed'),
        candidate_ids: requireStringArray(value.candidate_ids, 'candidate_ids'),
        ...(marketEvidenceRef ? { market_evidence_ref: marketEvidenceRef } : {}),
      };
    }
    case 'execute_agent': {
      const executionEvidenceRef = optionalString(
        value.execution_evidence_ref,
        'execution_evidence_ref',
      );
      return {
        cursor: value.cursor,
        winner_agent_id: requireString(value.winner_agent_id, 'winner_agent_id'),
        ...(executionEvidenceRef ? { execution_evidence_ref: executionEvidenceRef } : {}),
      };
    }
    case 'council': {
      if (!isTaskCouncilTrigger(value.trigger)) {
        throw new Error(`Invalid Council cursor trigger: ${String(value.trigger)}`);
      }
      const primaryEvidenceRef = optionalString(value.primary_evidence_ref, 'primary_evidence_ref');
      const candidateManifestRef = optionalString(
        value.candidate_manifest_ref,
        'candidate_manifest_ref',
      );
      return {
        cursor: value.cursor,
        trigger: value.trigger,
        ...(primaryEvidenceRef ? { primary_evidence_ref: primaryEvidenceRef } : {}),
        ...(candidateManifestRef ? { candidate_manifest_ref: candidateManifestRef } : {}),
      };
    }
    case 'gate': {
      const subjectRef = requireString(value.subject_ref, 'subject_ref');
      const changesetRef = requireString(value.changeset_ref, 'changeset_ref');
      if (subjectRef !== changesetRef) {
        throw new Error('Task Gate cursor subject_ref must equal changeset_ref');
      }
      return {
        cursor: value.cursor,
        subject_ref: subjectRef,
        phase: requireString(value.phase, 'phase'),
        changeset_ref: changesetRef,
        expected_sha256: requireSha256(value.expected_sha256, 'expected_sha256'),
      };
    }
    case 'deliver':
      return {
        cursor: value.cursor,
        changeset_ref: requireString(value.changeset_ref, 'changeset_ref'),
        expected_sha256: requireSha256(value.expected_sha256, 'expected_sha256'),
      };
    case 'mailbox_wait':
      return {
        cursor: value.cursor,
        delivery_ids: requireStringArray(value.delivery_ids, 'delivery_ids'),
        waiting_reason: requireString(value.waiting_reason, 'waiting_reason'),
      };
    case 'done':
      return { cursor: value.cursor };
    default:
      throw new Error(`Unsupported Task cursor input: ${value.cursor}`);
  }
}

function isTaskCouncilTrigger(value: unknown): value is TaskCouncilTrigger {
  return value === 'explicit_mode' || value === 'persistent_override' || value === 'agent_request';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Task cursor input ${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireString(value, field);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Task cursor input ${field} must be a string array`);
  }
  return [...value];
}

function requireSha256(value: unknown, field: string): string {
  const hash = requireString(value, field);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Task cursor input ${field} must be a lowercase SHA256`);
  }
  return hash;
}

export interface PersistedTaskError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PersistedTaskFinalOutput {
  artifact_ref: string;
  sha256: string;
  workspace_path: string;
}

export interface PersistedTaskState {
  task_id: string;
  parent_id?: string;
  status: TaskStatus;
  owner_agent_id?: string;
  role_id?: string;
  risk_level: RiskLevel;
  spec: string;
  completion_criteria: string[];
  affected_paths: string[];
  budget?: TaskBudget;
  workspace_path: string;
  warnings: string[];
  final_output?: PersistedTaskFinalOutput;
  error?: PersistedTaskError;
  revision: number;
  created_at: string;
  updated_at: string;
  schema_version: SchemaVersion;
}

export interface PersistedRunState {
  run_id: string;
  task_id: string;
  status: PersistedRunStatus;
  mode: PersistedRunMode;
  workspace_path: string;
  session_id?: string;
  restarted_from_run_id?: string;
  snapshot?: RunSnapshot;
  error?: PersistedTaskError;
  revision: number;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
  schema_version: SchemaVersion;
}

export interface PersistedTaskRuntimeState {
  task_id: string;
  current_run_id?: string;
  resume_cursor: TaskResumeCursor;
  cursor_input?: TaskCursorInput;
  waiting_on: Record<string, unknown>[];
  interrupt_state?: Record<string, unknown>;
  artifact_refs: string[];
  diagnostics: Record<string, unknown>;
  updated_at: string;
  schema_version: SchemaVersion;
}

export interface PersistedCoordinationEvent extends Event {
  sequence: number;
}

export interface PersistedCheckpointMessage {
  message_id: string;
  role: string;
  content: string;
  turn: number;
  artifact_refs: string[];
  created_at: string;
}

export interface PersistedFullCheckpoint {
  checkpoint_id: string;
  parent_checkpoint_id?: string;
  task_id: string;
  run_id: string;
  agent_id: string;
  session_id?: string;
  trigger: 'manual' | 'periodic' | 'shutdown' | 'blocked' | 'escalated';
  resume_cursor: TaskResumeCursor;
  message_thread: PersistedCheckpointMessage[];
  mechanical_snapshot: {
    base_commit: string;
    snapshot_commit?: string;
    worktree_path: string;
    branch: string;
    modified_files: string[];
    diff_artifact_id?: string;
    test_artifact_ids?: string[];
  };
  semantic_handoff: {
    done: string[];
    in_progress: string[];
    blocked_on: string[];
    assumptions: string[];
    next_steps: string[];
    known_risks: string[];
  };
  interrupt_state?: Record<string, unknown>;
  artifact_refs: string[];
  validity_status: 'valid' | 'invalid' | 'superseded';
  created_at: string;
  schema_version: SchemaVersion;
}

export interface CoordinationStateCommit {
  expected_task_revision?: number;
  task: PersistedTaskState;
  run?: PersistedRunState;
  runtime_state: PersistedTaskRuntimeState;
  checkpoint?: PersistedFullCheckpoint;
  events: Event[];
}

export interface PersistedTaskAggregate {
  task: PersistedTaskState;
  runs: PersistedRunState[];
  runtime_state: PersistedTaskRuntimeState;
  events: PersistedCoordinationEvent[];
}

export interface CoordinationStateStore {
  commitState(input: CoordinationStateCommit): PersistedCoordinationEvent[];
  getTaskAggregate(taskId: string): PersistedTaskAggregate | undefined;
  listTaskAggregates(): PersistedTaskAggregate[];
  listEvents(taskId: string, afterSequence?: number): PersistedCoordinationEvent[];
  getLatestCheckpoint(taskId: string): PersistedFullCheckpoint | undefined;
  close(): void;
}
