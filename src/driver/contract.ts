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

export interface DriverRunResult {
  driver_run_result_id: string;
  session_id: DriverSessionId;
  status: DriverRunStatus;
  response?: string;
  artifacts: ArtifactRef[];
  transcript_ref: ArtifactRef;
  tool_events: DriverToolEvent[];
  diagnostics: {
    driver_id: DriverId;
    duration_ms: number;
    notes: string[];
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
