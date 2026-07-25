import type { GateResultId, SchemaVersion, TaskStatus, Timestamp } from '../core';

export type GateDecision = 'allow' | 'deny' | 'ask' | 'defer';

export interface GateRequest {
  gate_id: string;
  gate_point: string;
  request_id: string;
  priority: number;
  denying?: boolean;
  timeout_ms: number;
  created_at: Timestamp;
  payload?: Record<string, unknown>;
  schema_version: SchemaVersion;
  subject_id?: string;
}

export interface GateResult {
  gate_result_id: GateResultId;
  gate_id: string;
  gate_point: string;
  request_id: string;
  subject_id?: string;
  subject_type?: 'task' | 'artifact' | 'proposal' | 'merge_attempt' | 'council' | string;
  causal_event_id?: string;
  attempt_id?: string;
  subject_version?: number;
  decision: GateDecision;
  reason: string;
  required_actions: string[];
  audit_ref?: string;
  target_state?: TaskStatus | string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface GateOutputConfig {
  severity_map?: Record<string, 'deny' | 'ask' | 'defer' | 'allow'>;
  threshold?: {
    line?: number;
    branch?: number;
  };
  on_fail?: 'deny' | 'ask' | 'defer' | 'allow';
  on_below_threshold?: 'deny' | 'ask' | 'defer' | 'allow';
}

export interface SubGateRef {
  gate_id: string;
  required?: boolean;
}

export interface GateDefinition {
  type: 'command' | 'prompt' | 'composite' | 'http';
  command?: string;
  model?: string;
  prompt?: string;
  http?: string;
  input?: string;
  gates?: SubGateRef[];
  outputConfig: GateOutputConfig;
  /** Per-gate timeout in seconds. Runners convert to ms internally. */
  timeout?: number;
  retry_threshold: number;
}

export interface GateRunner {
  readonly gate_id: string;
  run(request: GateRequest): Promise<GateResult>;
}

export interface GateSchedulerOptions {
  definitions?: Record<string, GateDefinition> | Map<string, GateDefinition>;
  customRunners?: Map<string, GateRunner>;
  concurrency?: number;
}

export interface GateScheduler {
  initialize(options: GateSchedulerOptions): void;
  insert(request: GateRequest): Promise<GateResult>;
}

export const VALID_DECISIONS = new Set<string>(['allow', 'deny', 'ask', 'defer']);
