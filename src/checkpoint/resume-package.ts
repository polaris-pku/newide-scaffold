import type {
  MailboxStateStore,
  PersistedCheckpointMessage,
  PersistedFullCheckpoint,
  PersistedMailboxDelivery,
  PersistedRunMode,
  PersistedTaskAggregate,
  TaskCursorInput,
  TaskResumeCursor,
} from '../persistence';
import { parseTaskCursorInput } from '../persistence';
import type { FileAnchor } from './file-anchor';

export interface ResumePackageMailbox {
  pending_deliveries: PersistedMailboxDelivery[];
}

export interface ResumePackage {
  task_id: string;
  checkpoint_id: string;
  interrupted_run_id: string;
  mode: PersistedRunMode;
  resume_cursor: TaskResumeCursor;
  cursor_input: TaskCursorInput;
  session_id?: string;
  workspace_path: string;
  artifact_refs: string[];
  message_thread: PersistedCheckpointMessage[];
  mailbox: ResumePackageMailbox;
  file_anchor: FileAnchor;
  interrupt_state?: Record<string, unknown>;
  task_request: {
    spec: string;
    role_id?: string;
    parent_task_id?: string;
    risk_level: PersistedTaskAggregate['task']['risk_level'];
    affected_paths: string[];
    completion_criteria: string[];
    budget?: PersistedTaskAggregate['task']['budget'];
  };
}

export interface BuildResumePackageInput {
  aggregate: PersistedTaskAggregate;
  checkpoint: PersistedFullCheckpoint;
  mailboxStore?: Pick<MailboxStateStore, 'listReplayableMailboxDeliveries'>;
}

export class ResumePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumePackageError';
  }
}

/**
 * Build a ResumePackage from the latest full checkpoint + runtime state.
 * Requires a reconstructible cursor_input; never silently falls back to restart.
 */
export function buildResumePackage(input: BuildResumePackageInput): ResumePackage {
  const { aggregate, checkpoint } = input;
  if (checkpoint.task_id !== aggregate.task.task_id) {
    throw new ResumePackageError(
      `Checkpoint ${checkpoint.checkpoint_id} does not belong to task ${aggregate.task.task_id}`,
    );
  }
  const interruptedRun = aggregate.runs.find((run) => run.run_id === checkpoint.run_id);
  if (!interruptedRun) {
    throw new ResumePackageError(
      `Checkpoint run ${checkpoint.run_id} was not found for task ${checkpoint.task_id}`,
    );
  }

  const cursorInput = resolveResumeCursorInput(aggregate, checkpoint);
  const pendingDeliveries =
    input.mailboxStore
      ?.listReplayableMailboxDeliveries()
      .map((envelope) => envelope.delivery) ?? [];

  const mechanical = checkpoint.mechanical_snapshot;
  // recoverable means workspace content can actually be restored, so a usable
  // snapshot commit is required — Git metadata alone only describes the state.
  const recoverable =
    !mechanical.base_commit.startsWith('unavailable:') && Boolean(mechanical.snapshot_commit);

  return {
    task_id: aggregate.task.task_id,
    checkpoint_id: checkpoint.checkpoint_id,
    interrupted_run_id: checkpoint.run_id,
    mode: interruptedRun.mode,
    resume_cursor: checkpoint.resume_cursor,
    cursor_input: cursorInput,
    ...(checkpoint.session_id || interruptedRun.session_id
      ? { session_id: checkpoint.session_id ?? interruptedRun.session_id }
      : {}),
    workspace_path: aggregate.task.workspace_path,
    artifact_refs: [...checkpoint.artifact_refs],
    message_thread: checkpoint.message_thread.map((entry) => ({ ...entry })),
    mailbox: { pending_deliveries: pendingDeliveries },
    file_anchor: {
      base_commit: mechanical.base_commit,
      ...(mechanical.snapshot_commit ? { snapshot_commit: mechanical.snapshot_commit } : {}),
      worktree_path: mechanical.worktree_path,
      branch: mechanical.branch,
      modified_files: [...mechanical.modified_files],
      recoverable,
    },
    ...(checkpoint.interrupt_state ? { interrupt_state: { ...checkpoint.interrupt_state } } : {}),
    task_request: {
      spec: aggregate.task.spec,
      ...(aggregate.task.role_id ? { role_id: aggregate.task.role_id } : {}),
      ...(aggregate.task.parent_id ? { parent_task_id: aggregate.task.parent_id } : {}),
      risk_level: aggregate.task.risk_level,
      affected_paths: [...aggregate.task.affected_paths],
      completion_criteria: [...aggregate.task.completion_criteria],
      ...(aggregate.task.budget ? { budget: { ...aggregate.task.budget } } : {}),
    },
  };
}

export function resolveResumeCursorInput(
  aggregate: PersistedTaskAggregate,
  checkpoint: PersistedFullCheckpoint,
): TaskCursorInput {
  const candidates: Array<TaskCursorInput | undefined> = [
    checkpoint.cursor_input,
    aggregate.runtime_state.cursor_input,
    synthesizeCursorInput(checkpoint.resume_cursor, aggregate, checkpoint.run_id),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = parseTaskCursorInput(candidate);
      if (parsed.cursor !== checkpoint.resume_cursor) {
        continue;
      }
      return parsed;
    } catch {
      continue;
    }
  }
  throw new ResumePackageError(
    `Cannot rebuild cursor_input for resume at ${checkpoint.resume_cursor}; refusing silent restart`,
  );
}

export function synthesizeCursorInput(
  resumeCursor: TaskResumeCursor,
  aggregate: PersistedTaskAggregate,
  runId: string,
): TaskCursorInput | undefined {
  switch (resumeCursor) {
    case 'select_agent':
      return {
        cursor: 'select_agent',
        seed: runId,
        candidate_ids: [],
      };
    case 'execute_agent': {
      const winner =
        aggregate.task.owner_agent_id ??
        readDiagString(aggregate, 'winner_agent_id') ??
        readLatestAgentId(aggregate);
      if (!winner) return undefined;
      return { cursor: 'execute_agent', winner_agent_id: winner };
    }
    case 'council':
      return {
        cursor: 'council',
        trigger: 'persistent_override',
      };
    case 'gate': {
      const changeset =
        readDiagString(aggregate, 'changeset_ref') ??
        aggregate.runtime_state.artifact_refs.at(-1) ??
        checkpointArtifactFallback(aggregate);
      const sha = readDiagString(aggregate, 'expected_sha256') ?? '0'.repeat(64);
      if (!changeset) return undefined;
      return {
        cursor: 'gate',
        subject_ref: changeset,
        phase: 'post_primary',
        changeset_ref: changeset,
        expected_sha256: sha,
      };
    }
    case 'deliver': {
      const changeset =
        readDiagString(aggregate, 'changeset_ref') ?? aggregate.runtime_state.artifact_refs.at(-1);
      const sha = readDiagString(aggregate, 'expected_sha256') ?? '0'.repeat(64);
      if (!changeset) return undefined;
      return {
        cursor: 'deliver',
        changeset_ref: changeset,
        expected_sha256: sha,
      };
    }
    case 'mailbox_wait':
      return {
        cursor: 'mailbox_wait',
        delivery_ids: [],
        waiting_reason: 'resume_from_checkpoint',
      };
    case 'done':
      return { cursor: 'done' };
    default:
      return undefined;
  }
}

function checkpointArtifactFallback(aggregate: PersistedTaskAggregate): string | undefined {
  return aggregate.runtime_state.artifact_refs[0];
}

function readDiagString(aggregate: PersistedTaskAggregate, key: string): string | undefined {
  const value = aggregate.runtime_state.diagnostics[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readLatestAgentId(aggregate: PersistedTaskAggregate): string | undefined {
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const payload = aggregate.events[index]?.payload;
    if (!payload || typeof payload !== 'object') continue;
    const agentId = (payload as Record<string, unknown>).agent_id;
    if (typeof agentId === 'string' && agentId.length > 0) return agentId;
  }
  return undefined;
}
