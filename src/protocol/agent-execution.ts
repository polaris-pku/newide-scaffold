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
  instruction: string;
  workspace_path?: string;
  session_id?: string;
  input_artifact_refs: ArtifactId[];
  context_policy: string;
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
