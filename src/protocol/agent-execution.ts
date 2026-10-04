import type {
  ArtifactId,
  ArtifactRef,
  ContextPackId,
  DriverRunResultId,
  RoleId,
  RunId,
  SchemaVersion,
  TaskId,
  Timestamp,
} from '../core';
import type { DriverStreamEventListener, DriverToolEvent } from '../driver/contract';

export const AGENT_EXECUTION_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;

export type AgentExecutionStatus = (typeof AGENT_EXECUTION_STATUSES)[number];
export type AgentRunId = string;
export type AgentExecutionDiagnostics = Record<string, unknown>;

export interface AgentExecutionRequest {
  task_id: TaskId;
  run_id: RunId;
  role_id: RoleId;
  participant_id?: string;
  council_seat?: 'proposer' | 'reviewer' | 'synthesizer';
  council_seat_index?: number;
  instruction: string;
  /** Clean task instruction forwarded to the delegated Driver, without Host-only guidance. */
  driver_instruction?: string;
  workspace_path?: string;
  session_id?: string;
  /** Pending Mailbox Delivery injected into this role's task-scoped turn. */
  mailbox_delivery_id?: string;
  input_artifact_refs: ArtifactId[];
  context_policy: string;
  /**
   * 这次执行在**面板/观测**那一侧属于哪个 run。
   *
   * 与 `run_id` 分开是因为它们在 council 下真的不同：每个席位每一相位都拿
   * `${run_id}_${phaseId}`（`createId('council_phase')`）当执行身份——相位之间必须隔离，
   * 否则信箱幂等键、driver 会话记账会互相撞车——而面板看的是**任务那个 run**。
   * 在飞状态（`activity`）按这个字段归集；缺它就退回 `run_id`（单 agent 路径两者相同）。
   */
  activity_run_id?: RunId;
  /** RFC §1.2 memory ablation; applied by production Agent execution facade. */
  memory_ablation?: 'B0' | 'B1' | 'B2' | 'B3' | 'B4';
  schema_version: SchemaVersion;
}

export interface AgentExecutionResult {
  agent_run_id: AgentRunId;
  agent_id?: string;
  role_id: RoleId;
  context_pack_ref: ContextPackId;
  driver_run_result_id: DriverRunResultId;
  artifact_refs: ArtifactRef[];
  transcript_ref: ArtifactRef;
  session_id: string;
  response: string;
  tool_events: DriverToolEvent[];
  diagnostics: AgentExecutionDiagnostics;
  status: AgentExecutionStatus;
  memory_buffer_ref?: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface AgentExecutionOptions {
  signal?: AbortSignal;
  onDriverEvent?: DriverStreamEventListener;
}

export interface AgentExecutionFacade {
  runAgent(
    input: AgentExecutionRequest,
    options?: AgentExecutionOptions,
  ): Promise<AgentExecutionResult>;
}
