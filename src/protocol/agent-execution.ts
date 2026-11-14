import type {
  ArtifactId,
  ArtifactRef,
  ContextPackId,
  DriverRunResultId,
  RoleId,
  RunId,
  SchemaVersion,
  TaskBudget,
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
  /** Resume an interrupted native turn; do not resend the initial memory/context package. */
  resume_session?: boolean;
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
  /** Per-run capability gate for the top-level Agent's Council request tool. */
  allow_agent_council?: boolean;
  /**
   * 阶段 2：由 stage executor 依据 mode/cursor/task_request 显式冻结/选择的执行引擎。
   * 缺省按 `legacy` 解释（旧行为）；禁止 facade 从 `context_policy` 反推。
   */
  execution_engine?: 'legacy' | 'role_autonomy';
  /** 恢复链上一 Run id（role-loop 只读继承/冻结记录回溯用；legacy 路径忽略）。 */
  restarted_from_run_id?: RunId;
  /** 任务完成标准（role-loop 的 finish 证据校验需要；legacy 路径可忽略）。 */
  completion_criteria?: string[];
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
  /** Set when the top-level Agent explicitly requested Council escalation. */
  council_request?: { reason?: string };
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

/** role 引擎冻结计划（与 app 的 RoleFrozenPolicyPlan 结构一致，避免 protocol→app 依赖）。 */
export interface RoleFreezePlanInput {
  limits: {
    max_dispatches: number;
    max_role_rounds: number;
    role_token_budget: number;
    wall_clock_seconds: number;
    dispatch_timeout_ms: number;
  };
  deadline_at: string;
  frozen_at: string;
  max_tool_calls: number;
  routing: { driver_id?: string; profile_id?: string };
  /** 阶段 3 开关（默认关闭；与预算一起在 Journal init 行冻结）。 */
  evidence_only?: boolean;
  buffer_v2?: boolean;
}

export interface AgentExecutionOptions {
  signal?: AbortSignal;
  onDriverEvent?: DriverStreamEventListener;
  /**
   * 阶段 2 role 自主循环的请求侧输入：TaskBudget（只收紧）与 stage 选路算好的冻结计划。
   * 只有显式 `execution_engine='role_autonomy'` 的请求会读取；legacy 路径忽略。
   */
  role_autonomy?: {
    task_budget?: TaskBudget;
    freeze_plan?: RoleFreezePlanInput;
  };
}

export interface AgentExecutionFacade {
  runAgent(
    input: AgentExecutionRequest,
    options?: AgentExecutionOptions,
  ): Promise<AgentExecutionResult>;
}
