import { SCHEMA_VERSION, createId, nowTimestamp, type Event } from '../core';
import {
  DecisionAggregator,
  PriorityGateScheduler,
  type GateDecision,
  type GateDefinition,
  type GateRequest,
  type GateResult,
  type GateScheduler,
} from '../gate';
import {
  type AgentHookPoint,
  type TaskHookPoint,
  type CouncilHookPoint,
  type LifecycleHookPoint,
  type SystemHookPoint,
  type HookPoint,
  PHASE_1_HOOK_POINTS,
  DEFAULT_HOOK_VERSION,
  DEFAULT_HOOK_SETTINGS,
  DEFAULT_PRIORITY,
  DEFAULT_TIMEOUT,
} from './constants';
import {
  type HookBindingEntry,
  type HookBinding,
  type HookConfig,
  type HookSettings,
} from './config';

// Re-export hook point definitions for backward compatibility
export type {
  AgentHookPoint,
  TaskHookPoint,
  CouncilHookPoint,
  LifecycleHookPoint,
  SystemHookPoint,
  HookPoint,
};
export { PHASE_1_HOOK_POINTS };

// ──────────────────────────────────────────────
// Runtime types
// ──────────────────────────────────────────────

export interface HookEvent extends Event {
  event_type: HookPoint;
}

export interface HookResult {
  hook_point: HookPoint | string;
  matched: boolean;
  gate_requests: GateRequest[];
  gate_results: GateResult[];
  final_decision: GateDecision;
  created_at: string;
  schema_version: typeof SCHEMA_VERSION;
}

export interface HookEngineOptions {
  /** Directly pass a parsed HookConfig object */
  config: HookConfig;
  /** Optional GateScheduler instance (created automatically if not provided) */
  scheduler?: GateScheduler;
  /** Optional DecisionAggregator instance (created automatically if not provided) */
  aggregator?: DecisionAggregator;
}

// ──────────────────────────────────────────────
// HookEngine
// ──────────────────────────────────────────────

export class HookEngine {
  private readonly version: string;
  private readonly settings: HookSettings;
  private readonly bindings: HookBinding;
  private readonly scheduler: GateScheduler;
  private readonly aggregator: DecisionAggregator;

  constructor(options: HookEngineOptions) {
    this.version = options.config.version;
    this.settings = options.config.settings;

    // Convert GateConfig entries to GateDefinition objects
    const definitions: Record<string, GateDefinition> = {};
    for (const [gateName, gateConfig] of Object.entries(options.config.gates)) {
      definitions[gateName] = this.toGateDefinition(gateConfig);
    }

    // Initialize scheduler with gate definitions
    this.scheduler =
      options.scheduler ?? new PriorityGateScheduler();
    this.scheduler.initialize({ definitions });

    // Build HookBinding map: event name → sorted binding entries
    this.bindings = new Map();
    for (const [eventName, entries] of Object.entries(options.config.hooks)) {
      this.bindings.set(eventName as HookPoint, entries);
    }

    this.aggregator = options.aggregator ?? new DecisionAggregator();
  }

  async handleEvent(event: HookEvent): Promise<HookResult> {
    // Emergency skip — if the configured env var is set, bypass all gates
    if (this.settings.emergency_env_var && process.env[this.settings.emergency_env_var]) {
      return {
        hook_point: event.event_type,
        matched: false,
        gate_requests: [],
        gate_results: [],
        final_decision: 'allow',
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      };
    }

    // Look up binding entries for this event type
    const entries = this.bindings.get(event.event_type);
    if (!entries || entries.length === 0) {
      return {
        hook_point: event.event_type,
        matched: false,
        gate_requests: [],
        gate_results: [],
        final_decision: 'allow',
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      };
    }

    // Sort by priority descending, evaluate if conditions
    const matchingEntries = entries
      .filter((entry) => this.evaluateCondition(entry.if, event))
      .sort((left, right) => (right.priority ?? DEFAULT_PRIORITY) - (left.priority ?? DEFAULT_PRIORITY));

    if (matchingEntries.length === 0) {
      return {
        hook_point: event.event_type,
        matched: true,
        gate_requests: [],
        gate_results: [],
        final_decision: 'allow',
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      };
    }

    // Build GateRequests for matching entries
    const gateRequests = matchingEntries.map((entry) =>
      this.toGateRequest(event, entry),
    );

    // Execute gates — parallel or sequential based on settings
    const gateResults: GateResult[] = [];
    if (this.settings.parallel) {
      // Send all gate requests concurrently via Promise.all.
      // Note: fail_fast has no early-termination effect in parallel mode
      // since all gates are already in-flight.
      const results = await Promise.all(
        gateRequests.map((request) => this.scheduler.insert(request)),
      );
      gateResults.push(...results);
    } else {
      // Execute gates sequentially, respecting priority order and fail_fast
      for (const request of gateRequests) {
        const result = await this.scheduler.insert(request);
        gateResults.push(result);
        // Stop early when fail_fast is enabled and a gate denies
        if (this.settings.fail_fast && result.decision === 'deny') {
          break;
        }
      }
    }

    return {
      hook_point: event.event_type,
      matched: true,
      gate_requests: gateRequests,
      gate_results: gateResults,
      final_decision: this.aggregator.aggregate(gateResults).decision,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  // ── Private helpers ──────────────────────────────

  /**
   * Convert a YAML GateConfig into a GateDefinition suitable for the scheduler.
   */
  private toGateDefinition(config: HookConfig['gates'][string]): GateDefinition {
    const outputConfig: GateDefinition['outputConfig'] = {};
    if (config.severity_map) {
      outputConfig.severity_map = config.severity_map;
    }

    const def: GateDefinition = {
      type: config.type,
      outputConfig,
      retry_threshold: config.retry_threshold ?? 3,
    };

    if (config.timeout !== undefined) def.timeout = config.timeout;

    switch (config.type) {
      case 'command':
        if (config.run !== undefined) def.command = config.run;
        break;
      case 'prompt':
        if (config.model !== undefined) def.model = config.model;
        if (config.run !== undefined) def.prompt = config.run;
        break;
      case 'http':
        if (config.run !== undefined) def.input = config.run;
        break;
      case 'composite':
        if (config.gates !== undefined) def.gates = config.gates;
        break;
    }

    return def;
  }

  /**
   * Build a GateRequest from a HookEvent and a HookBindingEntry.
   */
  private toGateRequest(
    event: HookEvent,
    entry: HookBindingEntry,
  ): GateRequest {
    return {
      gate_id: entry.gate,
      gate_point: event.event_type,
      request_id: createId('gate_req'),
      subject_id: event.subject_id,
      priority: entry.priority ?? DEFAULT_PRIORITY,
      timeout_ms: (entry.timeout ?? this.settings.default_timeout ?? DEFAULT_TIMEOUT) * 1000,
      created_at: nowTimestamp(),
      payload: {
        event_id: event.event_id,
        event_type: event.event_type,
        task_id: event.task_id,
        run_id: event.run_id,
        ...event.payload,
      },
      schema_version: SCHEMA_VERSION,
    };
  }

  /**
   * Evaluate an optional `if` condition expression against the event.
   * Returns true when the expression is undefined or evaluates to truthy.
   * Expression evaluation failures are fail-closed (return false).
   */
  private evaluateCondition(
    expression: string | undefined,
    event: HookEvent,
  ): boolean {
    if (!expression) return true;
    try {
      const fn = new Function('event', `return !!(${expression})`);
      return !!fn(event);
    } catch {
      return false;
    }
  }
}

// ──────────────────────────────────────────────
// Factory — Phase 1 default engine with mock allow gate
// ──────────────────────────────────────────────

export function createDefaultHookEngine(): HookEngine {
  const mockGateId = 'mock-allow-gate';

  const hooks: Record<string, HookBindingEntry[]> = {};
  for (const hookPoint of PHASE_1_HOOK_POINTS) {
    hooks[hookPoint] = [{ gate: mockGateId, priority: DEFAULT_PRIORITY }];
  }

  return new HookEngine({
    config: {
      version: DEFAULT_HOOK_VERSION,
      settings: { ...DEFAULT_HOOK_SETTINGS },
      gates: {
        [mockGateId]: {
          type: 'command',
          run: 'node -e "process.exit(0)"',
          retry_threshold: 1,
        },
      },
      hooks,
    },
  });
}

export function createHookEvent(
  input: Omit<HookEvent, 'event_id' | 'created_at' | 'schema_version'>,
): HookEvent {
  return {
    ...input,
    event_id: createId('event'),
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}
