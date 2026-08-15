/**
 * Run trajectory span model.
 *
 * 轨迹系统仿照 DeepSeek Harness 的会话事件流：落盘只存线性 append-only 记录
 * （每条记录是 span 的 start / end / point），并行结构在复盘阶段由
 * parent_span_id + parallel_group_id 重建，不直接持久化并行结构。
 */
import { SCHEMA_VERSION, type RunId, type SchemaVersion, type TaskId, type Timestamp } from '../core';

/** Trajectory span kinds aligned with the system's event vocabulary. */
export type TrajectorySpanKind =
  | 'run'
  | 'task.run'
  | 'driver.run'
  | 'driver.turn'
  | 'driver.tool'
  | 'council.session'
  | 'gate.eval'
  | 'memory.retrieve'
  | 'memory.extract'
  | 'agent.execution'
  | 'agent.message'
  | 'checkpoint'
  | 'artifact'
  | 'merge'
  | 'hook'
  | 'market'
  | 'worktree'
  | 'system'
  | 'event';

export type TrajectorySpanStatus = 'ok' | 'error' | 'timeout' | 'cancelled' | 'open';

/**
 * Record lifecycle phase.
 * - `start` / `end` are the two halves of a lifecycle span, paired by span_id.
 * - `point` is a single-shot record with no pairing (e.g. checkpoint.saved).
 */
export type TrajectorySpanPhase = 'start' | 'end' | 'point';

/** One append-only trajectory record, persisted as one JSON line. */
export interface TrajectorySpanRecord {
  span_id: string;
  run_id?: RunId;
  task_id?: TaskId;
  parent_span_id?: string;
  /** Siblings sharing the same group id were observed running in parallel. */
  parallel_group_id?: string;
  kind: TrajectorySpanKind;
  phase: TrajectorySpanPhase;
  agent_id?: string;
  status?: TrajectorySpanStatus;
  started_at?: Timestamp;
  ended_at?: Timestamp;
  duration_ms?: number;
  /** Bounded human-readable summary; full content stays in artifacts/audit. */
  summary?: string;
  payload?: Record<string, unknown>;
  /** Event id of the source Event that produced this record, when available. */
  source_event_id?: string;
  /** Per-run monotonically increasing order. */
  sequence: number;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

/** Lifecycle span merged from its start/end records; point records pass through. */
export interface MergedTrajectorySpan {
  span_id: string;
  kind: TrajectorySpanKind;
  phase: 'span' | 'point';
  run_id?: RunId;
  task_id?: TaskId;
  parent_span_id?: string;
  parallel_group_id?: string;
  agent_id?: string;
  status?: TrajectorySpanStatus;
  started_at?: Timestamp;
  ended_at?: Timestamp;
  duration_ms?: number;
  summary?: string;
  payload?: Record<string, unknown>;
  sequence: number;
  created_at: Timestamp;
}

export const TRAJECTORY_SCHEMA_VERSION: SchemaVersion = SCHEMA_VERSION;
