import { Parser, type Value as ExprEvalValue } from 'expr-eval';
import { SCHEMA_VERSION, createId, nowTimestamp, type Event } from '../core';
import {
  DecisionAggregator,
  PriorityGateScheduler,
  VALID_GATE_OUTPUT_FORMATS,
  type GateDecision,
  type GateDefinition,
  type GateOutputFormat,
  type GateRequest,
  type GateResult,
  type GateScheduler,
} from '../gate';
import {
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
} from './constants';
export { PHASE_1_HOOK_POINTS } from './constants';

// ──────────────────────────────────────────────
// Secure expression parser for `if` conditions
// ──────────────────────────────────────────────

const conditionParser = new Parser({
  allowMemberAccess: true,
  operators: {
    // Only enable safe, non-destructive operators
    comparison: true,
    logical: true,
    concatenate: true,
    in: true,
    // Disable all arithmetic, assignment, and function-definition operators
    add: false,
    subtract: false,
    multiply: false,
    divide: false,
    power: false,
    remainder: false,
    factorial: false,
    conditional: false,
    assignment: false,
    fndef: false,
    // Disable math/trig functions
    sin: false, cos: false, tan: false,
    asin: false, acos: false, atan: false,
    sinh: false, cosh: false, tanh: false,
    asinh: false, acosh: false, atanh: false,
    sqrt: false, log: false, ln: false, lg: false, log10: false,
    abs: false, ceil: false, floor: false, round: false, trunc: false,
    exp: false, length: false, random: false,
    min: false, max: false,
    cbrt: false, expm1: false, log1p: false, sign: false, log2: false,
  },
});

// Add custom `matches` function for glob pattern matching.
// Supports `|`-delimited alternatives: `'*.ts|*.tsx'` matches either glob.
// Expression `payload.file_path matches '*.ts'` is preprocessed to `matches(payload.file_path, '*.ts')`.
conditionParser.functions.matches = (a: unknown, b: unknown): boolean => {
  const str = String(a ?? '');
  const pattern = String(b ?? '');
  // Split on `|` for alternation — any match wins
  const alternatives = pattern.split('|');
  for (const alt of alternatives) {
    try {
      const regex = new RegExp(
        '^' +
          alt
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
          '$',
      );
      if (regex.test(str)) return true;
    } catch {
      // skip invalid patterns
    }
  }
  return false;
};

// Add custom `regex` function for raw regex matching.
// Expression `tool_input.command regex '^git\\s+push'` is preprocessed to `regex(tool_input.command, '^git\\s+push')`.
conditionParser.functions.regex = (a: unknown, b: unknown): boolean => {
  const str = String(a ?? '');
  const pattern = String(b ?? '');
  try {
    return new RegExp(pattern).test(str);
  } catch {
    return false;
  }
};

// Add custom `exists` unary operator for field existence checking.
// Usage: `exists context_pack_ref`, `not exists unresolved_risks`
(conditionParser as unknown as { unaryOps: Record<string, (a: unknown) => unknown> }).unaryOps['exists'] = (
  a: unknown,
): boolean => {
  return a !== undefined && a !== null;
};

/**
 * Preprocess an RFC expression string so it can be evaluated by expr-eval.
 *
 * Converts infix `matches` / `regex` operators into function calls:
 *   `X matches 'pattern'`      → `matches(X, 'pattern')`
 *   `X regex 'pattern'`        → `regex(X, 'pattern')`
 *
 * This is necessary because expr-eval only processes binary operators
 * listed in its hardcoded precedence tables, and custom operators cannot
 * be injected there without patching internal parser state.
 */
function preprocessExpression(expression: string): string {
  // Match: <ident(.ident)*> <matches|regex> <'string' or "string">
  return expression.replace(
    /([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\s+(matches|regex)\s+('[^']*'|"[^"]*")/g,
    (_full, left: string, op: string, right: string) => `${op}(${left}, ${right})`,
  );
}

/**
 * Property names that must never be accessible via member access, even on
 * nested objects.  These traverse the prototype chain and can expose
 * callable constructors (`Function`) when combined with `allowMemberAccess`.
 *
 * The list is defensive — `__proto__` grants direct prototype access,
 * `constructor` chains to `Function`, and `prototype` is the inverse
 * direction on the same chain.  None have a legitimate use in `if`
 * condition expressions.
 */
const BLOCKED_PROPERTIES = new Set<string>([
  'constructor',
  '__proto__',
  'prototype',
]);

/**
 * Create a recursively-safe proxy that:
 * 1. Resolves missing / `undefined` fields to `null` (for `exists` support).
 * 2. Blocks access to prototype-chain properties (`constructor`,
 *    `__proto__`, `prototype`).
 * 3. Blocks function-valued properties — callable objects must never leak
 *    into the expression scope.
 * 4. Recursively wraps nested objects so that member-access chains
 *    (`payload.x.y.z`) are also protected.
 */
function safeScope(event: HookEvent): Record<string, unknown> {
  // Cache weak-set of already-wrapped objects to avoid re-wrapping and
  // guard against circular references.
  const seen = new WeakSet<object>();

  function wrap(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'function') return null;
    if (typeof value !== 'object') return value; // primitive — safe

    if (seen.has(value as object)) return value;
    seen.add(value as object);

    // Arrays are commonly used as the RHS of the `in` operator (e.g.
    // `value in ['a', 'b']`). Wrapping them in a Proxy can interfere with
    // `in` checks, so we keep the array identity and only recursively wrap
    // its elements.
    if (Array.isArray(value)) {
      return value.map((item) => wrap(item));
    }

    return new Proxy(value as Record<string, unknown>, {
      get(_target, prop, receiver) {
        if (typeof prop === 'symbol') return undefined;
        if (BLOCKED_PROPERTIES.has(prop)) return null;

        const raw = Reflect.get(_target, prop, receiver);
        if (raw === undefined) return null;
        return wrap(raw);
      },
    });
  }

  return wrap(event) as Record<string, unknown>;
}

/**
 * Regular expression matching member-access to blocked prototype properties.
 *
 * Catches patterns like:
 *   - `payload.constructor`
 *   - `event_type . __proto__`
 *   - `x  .  prototype`
 *
 * This is a first-line parse-time defence; the {@link safeScope} proxy
 * provides the runtime backstop.
 */
const DANGEROUS_MEMBER_RE =
  /\.\s*(constructor|__proto__|prototype)\s*(?=[.[\s()+\-*/%^?:!=>|<&]|$)/;

/**
 * Remove string literals from an expression so that safety checks only look
 * at code tokens, not literal content.  Handles both single and double quoted
 * strings with escaped quotes.
 */
function stripStringLiterals(expression: string): string {
  return expression
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Throw if `expression` attempts member-access to a blocked prototype
 * property.  Called before the expression ever reaches the parser so that
 * even parser-level quirks cannot bypass the proxy defence.
 *
 * String literals are stripped first so that legitimate content like
 * `payload.path matches '.constructor'` is not rejected.
 */
function validateExpressionSafety(expression: string): void {
  const withoutStrings = stripStringLiterals(expression);
  if (DANGEROUS_MEMBER_RE.test(withoutStrings)) {
    const match = DANGEROUS_MEMBER_RE.exec(withoutStrings);
    throw new Error(
      `Forbidden property access ".${match![1]}" in condition expression`,
    );
  }
}

/**
 * Validate that an `if` condition expression is syntactically valid and
 * does not contain forbidden property accesses. Returns the normalized error
 * message on failure, or `undefined` on success.
 *
 * This is exported so the configuration loader can surface syntax errors at
 * load time rather than deferring them to runtime.
 */
export function validateConditionSyntax(expression: string): string | undefined {
  try {
    validateExpressionSafety(expression);
    const normalized = preprocessExpression(expression);
    conditionParser.parse(normalized);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

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
    // Emergency skip — if the configured env var is set to an enabling value, bypass all gates
    if (this.isEmergencySkipEnabled()) {
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
      // Send all gate requests concurrently via Promise.allSettled so that
      // per-binding on_failure can be applied without failing the whole batch.
      // Note: fail_fast has no early-termination effect in parallel mode
      // since all gates are already in-flight.
      const settled = await Promise.allSettled(
        gateRequests.map((request, index) =>
          this.executeGate(request, matchingEntries[index]!),
        ),
      );
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          gateResults.push(result.value);
        }
      }
    } else {
      // Execute gates sequentially, respecting priority order and fail_fast
      for (let i = 0; i < gateRequests.length; i++) {
        const result = await this.executeGate(gateRequests[i]!, matchingEntries[i]!);
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
      final_decision: gateResults.length > 0
        ? this.aggregator.aggregate(gateResults).decision
        : 'allow',
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  // ── Private helpers ──────────────────────────────

  /**
   * Execute a single gate request, falling back to the binding's `on_failure`
   * decision if the scheduler throws an execution error.
   */
  private executeGate(
    request: GateRequest,
    entry: HookBindingEntry,
  ): Promise<GateResult> {
    return this.scheduler.insert(request).catch((error: unknown) => {
      const fallbackDecision = entry.on_failure ?? 'allow';
      const reason = error instanceof Error ? error.message : String(error);
      const result: GateResult = {
        gate_result_id: createId('gate_result'),
        gate_id: request.gate_id,
        gate_point: request.gate_point,
        request_id: request.request_id,
        decision: fallbackDecision,
        reason: `Gate execution failed: ${reason}`,
        required_actions: [],
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      };
      if (request.subject_id !== undefined) {
        result.subject_id = request.subject_id;
      }
      return result;
    });
  }

  /**
   * Check whether the configured emergency bypass env var is set to an
   * explicitly enabling value (case-insensitive).
   */
  private isEmergencySkipEnabled(): boolean {
    const envVar = this.settings.emergency_env_var;
    if (!envVar) return false;
    const value = process.env[envVar];
    if (!value) return false;
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(value.toLowerCase());
  }

  /**
   * Convert a YAML GateConfig into a GateDefinition suitable for the scheduler.
   */
  private toGateDefinition(config: HookConfig['gates'][string]): GateDefinition {
    // Copy output config; format needs validation, other fields are pre-validated at parse time
    const outputConfig: GateDefinition['outputConfig'] = {};
    if (config.output) {
      const { format, ...fields } = config.output;
      if (format && isGateOutputFormat(format)) {
        outputConfig.format = format;
      }
      Object.assign(outputConfig, fields);
    }

    const def: GateDefinition = {
      type: config.type,
      outputConfig,
      retry_threshold: config.retry_threshold ?? 3,
    };

    if (config.timeout !== undefined) def.timeout = config.timeout;

    // Map typed fields directly (no more polymorphic `run`)
    switch (config.type) {
      case 'command':
        if (config.command !== undefined) def.command = config.command;
        break;
      case 'prompt':
        if (config.model !== undefined) def.model = config.model;
        if (config.prompt !== undefined) def.prompt = config.prompt;
        break;
      case 'http':
        if (config.http !== undefined) def.http = config.http;
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
   *
   * Uses `expr-eval` Parser for safe, sandboxed expression evaluation — no
   * arbitrary JavaScript code execution.  The event's top-level fields are
   * exposed as variables: `event_id`, `event_type`, `subject_id`, `run_id`,
   * `task_id`, `payload`, `created_at`, `schema_version`.
   *
   * Supported expression syntax (per Hooks RFC §5.3.4):
   * - Equality:       `==`, `!=`
   * - Comparison:     `>`, `<`, `>=`, `<=`
   * - Logical:        `and`, `or`, `not`
   * - Containment:    `value in ['a', 'b']`
   * - Glob matching:  `value matches '*.ts'`
   * - Regex matching: `value regex '^git\\s+push'`
   * - Existence:      `exists field_name`
   *
   * Returns true when the expression is undefined or evaluates to truthy.
   * Evaluation failures are fail-closed (return false).
   */
  private evaluateCondition(
    expression: string | undefined,
    event: HookEvent,
  ): boolean {
    if (!expression) return true;
    try {
      validateExpressionSafety(expression);
      const normalized = preprocessExpression(expression);
      const result = conditionParser.evaluate(
        normalized,
        safeScope(event) as unknown as ExprEvalValue,
      );
      return !!result;
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
          command: 'node -e "process.exit(0)"',
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

// ── Internal helpers ──────────────────────────────

function isGateOutputFormat(value: string): value is GateOutputFormat {
  return VALID_GATE_OUTPUT_FORMATS.has(value);
}
