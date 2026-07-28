import { type GateDecision, type SubGateRef } from '../gate';
import type { HookPoint } from './constants';

// ──────────────────────────────────────────────
// HookConfig — YAML-driven hook configuration (Hooks RFC §5)
// ──────────────────────────────────────────────

/** Global settings inherited by all hook bindings */
export interface HookSettings {
  /** Stop processing remaining gates immediately when any gate returns deny */
  fail_fast: boolean;
  /** Default gate timeout in seconds */
  default_timeout: number;
  /** When true, gate requests are sent in parallel via Promise.all; when false, executed sequentially in priority order */
  parallel: boolean;
  /** Default output format for gate results */
  output_format: string;
  /** Environment variable name used for emergency skip */
  emergency_env_var: string;
}

/** Per-gate configuration in the YAML gates section */
export interface GateConfig {
  /** Gate runner type */
  type: 'command' | 'prompt' | 'composite' | 'http';
  /** Command string (command type), prompt text (prompt type), or URL (http type) */
  run?: string;
  /** Model identifier for prompt-type gates */
  model?: string;
  /** Sub-gate references for composite-type gates */
  gates?: SubGateRef[];
  /** Output format configuration */
  output?: {
    format?: string;
  };
  /** Severity-to-decision mapping */
  severity_map?: Record<string, GateDecision>;
  /** Gate timeout override in seconds */
  timeout?: number;
  /** Maximum retry attempts (default 3) */
  retry_threshold?: number;
}

/** A single entry in a hook event's binding list */
export interface HookBindingEntry {
  /** Human-readable binding name for log tracing */
  name?: string;
  /** References a gate defined in the gates section */
  gate: string;
  /** Execution priority — higher runs first (default {@link DEFAULT_PRIORITY}) */
  priority?: number;
  /** Condition expression evaluated against the event; gate fires only when truthy */
  if?: string;
  /** Timeout override for this binding in seconds (default {@link DEFAULT_TIMEOUT}) */
  timeout?: number;
  /** Fallback decision when gate execution itself fails */
  on_failure?: GateDecision;
}

/** Top-level hook configuration matching the Hooks RFC YAML schema */
export interface HookConfig {
  /** Hook protocol version (e.g. "hook-0.1") */
  version: string;
  /** Global settings */
  settings: HookSettings;
  /** Gate definitions keyed by gate name */
  gates: Record<string, GateConfig>;
  /** Hook event bindings keyed by event type name (only specify events you want to hook into) */
  hooks: Partial<Record<HookPoint, HookBindingEntry[]>>;
}

// ──────────────────────────────────────────────
// HookBinding — event name → binding entries mapping
// ──────────────────────────────────────────────

/** Maps event type names to their ordered list of binding entries */
export type HookBinding = Map<HookPoint, HookBindingEntry[]>;

