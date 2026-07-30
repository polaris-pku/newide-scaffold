import { SCHEMA_VERSION, createId } from '../core';
import { projectRunEventSource } from '../protocol/run-event';
import type {
  PersistedFullCheckpoint,
  PersistedTaskAggregate,
  TaskCursorInput,
  TaskResumeCursor,
} from '../persistence';
import { captureFileAnchor } from './file-anchor';
import { synthesizeCursorInput } from './resume-package';

export type SafepointTrigger = PersistedFullCheckpoint['trigger'];

export interface BuildSafepointCheckpointInput {
  aggregate: PersistedTaskAggregate;
  run_id: string;
  trigger: SafepointTrigger;
  parent_checkpoint_id?: string;
  resume_cursor?: TaskResumeCursor;
  cursor_input?: TaskCursorInput;
  interrupt_state?: Record<string, unknown>;
  now?: string;
  checkpoint_id?: string;
  /**
   * Reuse this snapshot instead of capturing the current workspace.
   *
   * Crash recovery runs after the fact: the disk may have been touched since the crash,
   * and everything the interrupted run did past the last safepoint was mid-stage anyway.
   * The last safepoint's snapshot already matches the stage boundary the resume cursor
   * points at, so inheriting it is both safer and more faithful than re-capturing.
   */
  inherit_mechanical_snapshot?: PersistedFullCheckpoint['mechanical_snapshot'];
}

/**
 * Build a full checkpoint suitable for stage/wait/block/shutdown safepoints.
 */
export function buildSafepointCheckpoint(
  input: BuildSafepointCheckpointInput,
): PersistedFullCheckpoint {
  const { aggregate, run_id: runId } = input;
  const run = aggregate.runs.find((candidate) => candidate.run_id === runId);
  if (!run) {
    throw new Error(`Cannot build safepoint: run ${runId} not found`);
  }

  const resumeCursor = input.resume_cursor ?? aggregate.runtime_state.resume_cursor;
  const cursorInput =
    input.cursor_input ??
    (aggregate.runtime_state.cursor_input?.cursor === resumeCursor
      ? aggregate.runtime_state.cursor_input
      : undefined) ??
    synthesizeCursorInput(resumeCursor, aggregate, runId);

  const timestamp = input.now ?? new Date().toISOString();
  const checkpointId = input.checkpoint_id ?? createId('checkpoint');
  // An inherited snapshot wins: re-capturing after a crash would pin the checkpoint to
  // post-crash disk state and silently destroy the last restorable content.
  const inheritedSnapshot = input.inherit_mechanical_snapshot?.snapshot_commit
    ? input.inherit_mechanical_snapshot
    : undefined;
  // Label the snapshot with the checkpoint id so its ref survives gc until resume.
  const anchor = inheritedSnapshot
    ? {
        base_commit: inheritedSnapshot.base_commit,
        snapshot_commit: inheritedSnapshot.snapshot_commit,
        worktree_path: inheritedSnapshot.worktree_path,
        branch: inheritedSnapshot.branch,
        modified_files: inheritedSnapshot.modified_files,
        recoverable: true,
      }
    : captureFileAnchor(aggregate.task.workspace_path, { label: checkpointId });
  const agentId =
    readLatestAgentId(aggregate) ??
    aggregate.task.owner_agent_id ??
    aggregate.task.role_id ??
    'coordinator';

  return {
    checkpoint_id: checkpointId,
    ...(input.parent_checkpoint_id ? { parent_checkpoint_id: input.parent_checkpoint_id } : {}),
    task_id: aggregate.task.task_id,
    run_id: runId,
    agent_id: agentId,
    ...(run.session_id ? { session_id: run.session_id } : {}),
    trigger: input.trigger,
    resume_cursor: resumeCursor,
    ...(cursorInput ? { cursor_input: cursorInput } : {}),
    message_thread: aggregate.events.map((event, index) => ({
      message_id: event.event_id,
      role: projectRunEventSource(event.event_type),
      content: event.event_type,
      turn: index + 1,
      artifact_refs: readStringArray(event.payload, 'artifact_refs'),
      created_at: event.created_at,
    })),
    mechanical_snapshot: {
      base_commit: anchor.base_commit,
      ...(anchor.snapshot_commit ? { snapshot_commit: anchor.snapshot_commit } : {}),
      worktree_path: anchor.worktree_path,
      branch: anchor.branch,
      modified_files: anchor.modified_files,
    },
    semantic_handoff: {
      done: aggregate.events.map((event) => event.event_type),
      in_progress: [resumeCursor],
      blocked_on:
        input.trigger === 'blocked' && input.interrupt_state?.type === 'process_interrupted'
          ? ['backend process interrupted']
          : input.trigger === 'blocked' || input.trigger === 'shutdown'
            ? [input.trigger]
            : [],
      assumptions: [],
      next_steps: [`resume ${resumeCursor}`],
      known_risks: anchor.recoverable
        ? input.trigger === 'blocked' && input.interrupt_state?.type === 'process_interrupted'
          ? ['unfinished action will be re-executed']
          : []
        : ['file anchor unavailable; workspace path only'],
    },
    ...(input.interrupt_state ? { interrupt_state: input.interrupt_state } : {}),
    artifact_refs: [...aggregate.runtime_state.artifact_refs],
    validity_status: 'valid',
    created_at: timestamp,
    schema_version: SCHEMA_VERSION,
  };
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

function readStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
