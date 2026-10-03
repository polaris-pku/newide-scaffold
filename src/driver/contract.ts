import type {
  ArtifactRef,
  ContextPackRef,
  DriverId,
  DriverSessionId,
  RunId,
  SchemaVersion,
  TaskId,
  Timestamp,
} from '../core';

export interface DriverCapabilities {
  supports_acp_extension: boolean;
  supports_structured_output: boolean;
  supports_session_load: boolean;
  supports_tool_events: boolean;
  supports_permission_events: boolean;
}

export interface DriverPrompt {
  task_id: TaskId;
  run_id: RunId;
  prompt: string;
  workspace_path?: string;
  session_id?: DriverSessionId;
  context_pack_ref?: ContextPackRef;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface DriverToolEvent {
  tool_event_id: string;
  tool_name: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  summary: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

/** Incremental event emitted by a driver while a prompt is running. */
export interface DriverStreamEvent {
  schema_version: string;
  event_type: string;
  payload?: unknown;
  task_id?: TaskId;
  run_id?: RunId;
  role_id?: string;
  session_id?: DriverSessionId;
  sequence?: number;
  created_at?: Timestamp;
}

export type DriverStreamEventListener = (event: DriverStreamEvent) => void;

export interface DriverError {
  code: string;
  message: string;
  retryable: boolean;
}

export type DriverRunStatus = 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

/**
 * Driver 自报的逐次调用 token 用量（对应 ACP `PromptResponse.usage`）。
 *
 * 字段**全部可选**是刻意的：这是外部驱动的载荷，形状不受本仓控制（ACP 侧标注为
 * UNSTABLE），历史驱动可能一个字段都不给。读的一侧必须容忍缺字段——绝不能因为
 * 用量缺失把一次成功的驱动调用判成失败。
 *
 * 这是一条**独立于 `driver_context_usage`（上下文占用）与 `driver_billed_usage`
 * （Claude session 刮取）的计费口径**：它 per-invocation、随结果一起到达，不依赖
 * `~/.claude` 可读、也不依赖 adapter 是否发 `usage_update` 事件。
 */
export interface DriverUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  thought_tokens?: number;
  cached_read_tokens?: number;
  cached_write_tokens?: number;
}

export interface DriverRunResult {
  driver_run_result_id: string;
  session_id: DriverSessionId;
  status: DriverRunStatus;
  response?: string;
  artifacts: ArtifactRef[];
  transcript_ref: ArtifactRef;
  tool_events: DriverToolEvent[];
  /**
   * 驱动自报的 token 用量。
   *
   * 这个字段一直在 stdout 的结果 JSON 里到达进程（`JSON.parse` 后原样返回，
   * `assertDriverRunResult` 也不拒绝额外字段），但本仓契约过去没有声明它，
   * 于是**数据到了就被丢掉**——在 `src/driver/` 里搜 `usage` 一个命中都没有。
   */
  usage?: DriverUsage;
  diagnostics: {
    driver_id: DriverId;
    duration_ms: number;
    notes: string[];
    /** Normalized six-field report retained by the production Agent facade. */
    driver_report?: unknown;
  };
  error?: DriverError;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface DriverRuntimeHandle {
  driver_id: DriverId;
  session_id: DriverSessionId;
  capabilities: DriverCapabilities;
  sendPrompt(input: DriverPrompt): Promise<DriverRunResult>;
  interrupt(reason: string, runId?: RunId): Promise<void>;
  collectTranscript(): Promise<ArtifactRef>;
  subscribeToEvents?(listener: DriverStreamEventListener): () => void;
}
