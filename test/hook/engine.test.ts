import { describe, it, expect, afterEach } from 'vitest';
import { HookEngine, createHookEvent } from '../../src/hook/hook';
import { SCHEMA_VERSION } from '../../src/core';
import { PriorityGateScheduler, DecisionAggregator, type GateScheduler, type GateDecision } from '../../src/gate';
import { parseHookConfigYaml } from '../../src/hook/loader';
import type { HookConfig, HookSettings } from '../../src/hook/config';

// ══════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════

const EMERGENCY_ENV = 'TEST_EMERGENCY_SKIP';
const SENTINEL = '1';

/** Default settings used by most tests. */
const defaultSettings: HookSettings = {
  fail_fast: false,
  default_timeout: 30,
  parallel: false,
  output_format: 'json',
  emergency_env_var: 'AGENT_EMERGENCY_SKIP',
};

/**
 * Build a minimal HookConfig, overriding any top-level key.
 * When settings are provided they are shallow-merged over defaultSettings.
 */
function makeConfig(overrides: {
  settings?: Partial<HookSettings>;
  gates?: HookConfig['gates'];
  hooks?: HookConfig['hooks'];
} = {}): HookConfig {
  return {
    version: 'hook-0.1',
    settings: { ...defaultSettings, ...overrides.settings },
    gates: overrides.gates ?? {
      'allow-gate': { type: 'command', command: 'true', retry_threshold: 1 },
    },
    hooks: overrides.hooks ?? {
      'task.completed': [{ gate: 'allow-gate', priority: 100 }],
    },
  };
}

/**
 * Create a HookEngine from config overrides.
 * Accepts an optional scheduler for injection.
 */
function makeEngine(
  overrides?: Parameters<typeof makeConfig>[0],
  scheduler?: GateScheduler,
): HookEngine {
  return new HookEngine({ config: makeConfig(overrides), scheduler });
}

/** Convenience: parse YAML and create engine in a single call. */
function engineFromYaml(yaml: string, scheduler?: GateScheduler): HookEngine {
  return new HookEngine({ config: parseHookConfigYaml(yaml), scheduler });
}

/** Create a minimal HookEvent for testing, overriding any field. */
function makeEvent(overrides: Partial<Parameters<typeof createHookEvent>[0]> = {}) {
  return createHookEvent({
    event_type: 'task.completed',
    subject_id: 'task-001',
    payload: {},
    ...overrides,
  });
}

/** Assert that a result represents an emergency skip. */
function expectSkipped(result: Awaited<ReturnType<HookEngine['handleEvent']>>) {
  expect(result.matched).toBe(false);
  expect(result.gate_requests).toHaveLength(0);
  expect(result.gate_results).toHaveLength(0);
  expect(result.final_decision).toBe('allow');
}

/** Assert that a result represents a normal (non-skipped) execution. */
function expectExecuted(
  result: Awaited<ReturnType<HookEngine['handleEvent']>>,
  opts: { gateCount?: number; decision?: GateDecision } = {},
) {
  const { gateCount = 1, decision = 'allow' } = opts;
  expect(result.matched).toBe(true);
  expect(result.gate_results).toHaveLength(gateCount);
  if (gateCount > 0) {
    expect(result.gate_results[0]!.decision).toBe(decision);
  }
  expect(result.final_decision).toBe(decision);
}

afterEach(() => {
  delete process.env[EMERGENCY_ENV];
});

// ══════════════════════════════════════════════
// Gate execution — sequential mode
// ══════════════════════════════════════════════

describe('gate execution', () => {
  it('runs matching gates and returns allow decision', async () => {
    const engine = makeEngine();
    const result = await engine.handleEvent(makeEvent());
    expectExecuted(result);
  });

  it('uses the provided scheduler instance', async () => {
    const scheduler = new PriorityGateScheduler();
    const engine = makeEngine({}, scheduler);
    const result = await engine.handleEvent(makeEvent());
    expectExecuted(result);
  });

  it('uses the provided aggregator instance', async () => {
    // Use a real aggregator but verify it was called through the result
    const aggregator = new DecisionAggregator();
    const engine = new HookEngine({
      config: makeConfig(),
      aggregator,
    });
    const result = await engine.handleEvent(makeEvent());
    expectExecuted(result);
  });

  it('returns matched=false when event type has no bindings', async () => {
    const engine = makeEngine({
      hooks: { 'task.created': [{ gate: 'allow-gate', priority: 100 }] },
    });
    const result = await engine.handleEvent(
      makeEvent({ event_type: 'task.completed' }),
    );
    expect(result.matched).toBe(false);
    expect(result.gate_requests).toHaveLength(0);
    expect(result.final_decision).toBe('allow');
  });

  it('returns matched=true but no gate results when all conditions filter out', async () => {
    const engine = makeEngine({
      hooks: {
        'task.completed': [
          { gate: 'allow-gate', priority: 100, if: "payload.level == 'critical'" },
        ],
      },
    });
    const result = await engine.handleEvent(
      makeEvent({ payload: { level: 'low' } }),
    );
    expect(result.matched).toBe(true);
    expect(result.gate_requests).toHaveLength(0);
    expect(result.gate_results).toHaveLength(0);
    expect(result.final_decision).toBe('allow');
  });
});

// ══════════════════════════════════════════════
// Emergency skip
// ══════════════════════════════════════════════

describe('emergency skip', () => {
  it('skips when env var is set to the sentinel enabling value', async () => {
    process.env[EMERGENCY_ENV] = SENTINEL;
    const engine = makeEngine({ settings: { emergency_env_var: EMERGENCY_ENV } });
    const result = await engine.handleEvent(makeEvent());
    expectSkipped(result);
  });

  it('skips when env var is set to an enabling value', async () => {
    process.env[EMERGENCY_ENV] = 'true';
    const engine = makeEngine({ settings: { emergency_env_var: EMERGENCY_ENV } });
    const result = await engine.handleEvent(makeEvent());
    expectSkipped(result);
  });

  it('does NOT skip when env var is a non-enabling truthy string', async () => {
    process.env[EMERGENCY_ENV] = 'some_other_value';
    const engine = makeEngine({ settings: { emergency_env_var: EMERGENCY_ENV } });
    const result = await engine.handleEvent(makeEvent());
    expectExecuted(result);
  });

  it('does NOT skip when env var is empty string', async () => {
    process.env[EMERGENCY_ENV] = '';
    const engine = makeEngine({ settings: { emergency_env_var: EMERGENCY_ENV } });
    const result = await engine.handleEvent(makeEvent());
    expectExecuted(result);
  });

  it('does NOT skip when env var is not set at all', async () => {
    const engine = makeEngine({ settings: { emergency_env_var: EMERGENCY_ENV } });
    const result = await engine.handleEvent(makeEvent());
    expectExecuted(result);
  });

  it('does NOT skip when emergency_env_var is empty string', async () => {
    process.env[EMERGENCY_ENV] = SENTINEL;
    const engine = makeEngine({ settings: { emergency_env_var: '' } });
    const result = await engine.handleEvent(makeEvent());
    expectExecuted(result);
  });

  it('does NOT skip when env var is set to a disabled value like "false"', async () => {
    process.env[EMERGENCY_ENV] = 'false';
    const engine = makeEngine({ settings: { emergency_env_var: EMERGENCY_ENV } });
    const result = await engine.handleEvent(makeEvent());
    expectExecuted(result);
  });
});

// ══════════════════════════════════════════════
// Priority ordering
// ══════════════════════════════════════════════

describe('priority ordering', () => {
  it('orders gate requests by priority descending', async () => {
    const yaml = `
version: "hook-0.1"
settings:
  fail_fast: false
  default_timeout: 30
gates:
  gate_low:
    type: command
    command: "true"
  gate_mid:
    type: command
    command: "true"
  gate_high:
    type: command
    command: "false"
hooks:
  task.completed:
    - gate: gate_low
      priority: 10
    - gate: gate_mid
      priority: 50
    - gate: gate_high
      priority: 100
`;
    const engine = engineFromYaml(yaml);
    const result = await engine.handleEvent(makeEvent());

    expect(result.gate_requests).toHaveLength(3);
    expect(result.gate_requests[0]!.priority).toBe(100);
    expect(result.gate_requests[1]!.priority).toBe(50);
    expect(result.gate_requests[2]!.priority).toBe(10);
  });

  it('uses DEFAULT_PRIORITY when entry has no explicit priority', async () => {
    const engine = makeEngine({
      hooks: {
        'task.completed': [
          { gate: 'allow-gate' }, // no priority field
        ],
      },
    });
    const result = await engine.handleEvent(makeEvent());
    expect(result.gate_requests[0]!.priority).toBe(50); // DEFAULT_PRIORITY
  });
});

// ══════════════════════════════════════════════
// If-condition filtering
// ══════════════════════════════════════════════

describe('if-condition filtering', () => {
  it('includes gates whose if condition evaluates true', async () => {
    const engine = makeEngine({
      hooks: {
        'task.completed': [
          { gate: 'allow-gate', priority: 100, if: "payload.urgent == true" },
        ],
      },
    });
    const result = await engine.handleEvent(
      makeEvent({ payload: { urgent: true } }),
    );
    expectExecuted(result);
  });

  it('excludes gates whose if condition evaluates false', async () => {
    const engine = makeEngine({
      gates: {
        'allow-gate': { type: 'command', command: 'true', retry_threshold: 1 },
        'deny-gate': { type: 'command', command: 'false', retry_threshold: 1 },
      },
      hooks: {
        'task.completed': [
          { gate: 'deny-gate', priority: 100, if: "payload.level == 'critical'" },
          { gate: 'allow-gate', priority: 50 },
        ],
      },
    });
    const result = await engine.handleEvent(
      makeEvent({ payload: { level: 'low' } }),
    );
    expect(result.gate_requests).toHaveLength(1);
    expect(result.gate_requests[0]!.gate_id).toBe('allow-gate');
  });

  it('includes gates that have no if condition', async () => {
    const engine = makeEngine({
      hooks: {
        'task.completed': [
          { gate: 'allow-gate', priority: 100 }, // no `if`
        ],
      },
    });
    const result = await engine.handleEvent(makeEvent());
    expectExecuted(result);
  });
});

// ══════════════════════════════════════════════
// Execution modes — parallel
// ══════════════════════════════════════════════

describe('parallel mode', () => {
  it('executes all gate requests concurrently', async () => {
    const engine = makeEngine({
      settings: { parallel: true },
      gates: {
        'gate-1': { type: 'command', command: 'true', retry_threshold: 1 },
        'gate-2': { type: 'command', command: 'true', retry_threshold: 1 },
        'gate-3': { type: 'command', command: 'true', retry_threshold: 1 },
      },
      hooks: {
        'task.completed': [
          { gate: 'gate-1', priority: 100 },
          { gate: 'gate-2', priority: 80 },
          { gate: 'gate-3', priority: 60 },
        ],
      },
    });
    const result = await engine.handleEvent(makeEvent());
    expect(result.gate_results).toHaveLength(3);
    expect(result.final_decision).toBe('allow');
  });

  it('does NOT stop early on deny in parallel mode (no fail_fast effect)', async () => {
    const engine = makeEngine({
      settings: { parallel: true, fail_fast: true },
      gates: {
        'gate-deny': { type: 'command', command: 'false', retry_threshold: 1 },
        'gate-allow': { type: 'command', command: 'true', retry_threshold: 1 },
      },
      hooks: {
        'task.completed': [
          { gate: 'gate-deny', priority: 100 },
          { gate: 'gate-allow', priority: 50 },
        ],
      },
    });
    const result = await engine.handleEvent(makeEvent());
    // In parallel mode, both gates execute even though the first denies
    expect(result.gate_results).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════
// Fail-fast — sequential mode
// ══════════════════════════════════════════════

describe('fail-fast', () => {
  it('stops executing after first deny when fail_fast is enabled', async () => {
    const engine = makeEngine({
      settings: { fail_fast: true },
      gates: {
        'gate-deny': { type: 'command', command: 'false', retry_threshold: 1 },
        'gate-allow': { type: 'command', command: 'true', retry_threshold: 1 },
      },
      hooks: {
        'task.completed': [
          { gate: 'gate-deny', priority: 100 },
          { gate: 'gate-allow', priority: 50 },
        ],
      },
    });
    const result = await engine.handleEvent(makeEvent());
    expect(result.gate_results).toHaveLength(1);
    expect(result.gate_results[0]!.decision).toBe('deny');
    expect(result.final_decision).toBe('deny');
  });

  it('executes all gates when fail_fast is disabled', async () => {
    const engine = makeEngine({
      settings: { fail_fast: false },
      gates: {
        'gate-deny': { type: 'command', command: 'false', retry_threshold: 1 },
        'gate-allow': { type: 'command', command: 'true', retry_threshold: 1 },
      },
      hooks: {
        'task.completed': [
          { gate: 'gate-deny', priority: 100 },
          { gate: 'gate-allow', priority: 50 },
        ],
      },
    });
    const result = await engine.handleEvent(makeEvent());
    expect(result.gate_results).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════
// Decision aggregation
// ══════════════════════════════════════════════

describe('decision aggregation', () => {
  it('aggregates multiple allow decisions to allow', async () => {
    const engine = makeEngine({
      gates: {
        'gate-a': { type: 'command', command: 'true', retry_threshold: 1 },
        'gate-b': { type: 'command', command: 'true', retry_threshold: 1 },
      },
      hooks: {
        'task.completed': [
          { gate: 'gate-a', priority: 100 },
          { gate: 'gate-b', priority: 90 },
        ],
      },
    });
    const result = await engine.handleEvent(makeEvent());
    expect(result.final_decision).toBe('allow');
  });

  it('aggregates to deny when any gate denies', async () => {
    const engine = makeEngine({
      gates: {
        'gate-allow': { type: 'command', command: 'true', retry_threshold: 1 },
        'gate-deny': { type: 'command', command: 'false', retry_threshold: 1 },
      },
      hooks: {
        'task.completed': [
          { gate: 'gate-allow', priority: 100 },
          { gate: 'gate-deny', priority: 90 },
        ],
      },
    });
    const result = await engine.handleEvent(makeEvent());
    expect(result.final_decision).toBe('deny');
  });

  it('returns allow when no gates fire for an event', async () => {
    const engine = makeEngine({
      hooks: { 'task.created': [{ gate: 'allow-gate', priority: 100 }] },
    });
    const result = await engine.handleEvent(
      makeEvent({ event_type: 'task.completed' }),
    );
    expect(result.final_decision).toBe('allow');
  });
});

// ═══════════════════════════════════════════════
// Gate execution failure & on_failure fallback
// ═══════════════════════════════════════════════

describe('gate execution failure', () => {
  it('uses on_failure decision when gate execution throws', async () => {
    const engine = new HookEngine({
      config: {
        version: 'hook-0.1',
        settings: defaultSettings,
        gates: {},
        hooks: {
          'task.completed': [
            { gate: 'unknown-gate', priority: 100, on_failure: 'deny' },
          ],
        },
      },
    });
    const result = await engine.handleEvent(makeEvent());
    expect(result.matched).toBe(true);
    expect(result.gate_requests).toHaveLength(1);
    expect(result.gate_results).toHaveLength(1);
    expect(result.gate_results[0]!.decision).toBe('deny');
    expect(result.gate_results[0]!.reason).toContain('Gate execution failed');
    expect(result.final_decision).toBe('deny');
  });

  it('defaults to allow when gate execution throws and on_failure is unset', async () => {
    const engine = new HookEngine({
      config: {
        version: 'hook-0.1',
        settings: defaultSettings,
        gates: {},
        hooks: {
          'task.completed': [{ gate: 'unknown-gate', priority: 100 }],
        },
      },
    });
    const result = await engine.handleEvent(makeEvent());
    expect(result.matched).toBe(true);
    expect(result.gate_results).toHaveLength(1);
    expect(result.gate_results[0]!.decision).toBe('allow');
    expect(result.final_decision).toBe('allow');
  });

  it('stops early on fail_fast when fallback decision is deny', async () => {
    const engine = new HookEngine({
      config: {
        version: 'hook-0.1',
        settings: { ...defaultSettings, fail_fast: true },
        gates: {
          'allow-gate': { type: 'command', command: 'true', retry_threshold: 1 },
        },
        hooks: {
          'task.completed': [
            { gate: 'unknown-gate', priority: 100, on_failure: 'deny' },
            { gate: 'allow-gate', priority: 50 },
          ],
        },
      },
    });
    const result = await engine.handleEvent(makeEvent());
    expect(result.gate_results).toHaveLength(1);
    expect(result.gate_results[0]!.decision).toBe('deny');
    expect(result.final_decision).toBe('deny');
  });
});

// ══════════════════════════════════════════════
// Gate request payload forwarding
// ══════════════════════════════════════════════

describe('gate request construction', () => {
  it('forwards event fields into the gate request payload', async () => {
    const engine = makeEngine();
    const event = makeEvent({
      subject_id: 'task-abc-123',
      payload: { key: 'value' },
    });
    const result = await engine.handleEvent(event);

    expect(result.gate_requests).toHaveLength(1);
    const req = result.gate_requests[0]!;
    expect(req.subject_id).toBe('task-abc-123');
    expect(req.gate_point).toBe('task.completed');
    expect(req.payload!.event_type).toBe('task.completed');
    expect(req.payload!.key).toBe('value');
  });

  it('sets correct gate_id and timeout from binding entry', async () => {
    const engine = makeEngine({
      hooks: {
        'task.completed': [
          { gate: 'allow-gate', priority: 100, timeout: 15 },
        ],
      },
    });
    const result = await engine.handleEvent(makeEvent());
    const req = result.gate_requests[0]!;
    expect(req.gate_id).toBe('allow-gate');
    expect(req.timeout_ms).toBe(15000); // 15 seconds * 1000
  });
});

// ══════════════════════════════════════════════
// Multiple event types
// ══════════════════════════════════════════════

describe('multiple event types', () => {
  it('matches gates against the correct event type bindings', async () => {
    const engine = makeEngine({
      gates: {
        'gate-a': { type: 'command', command: 'true', retry_threshold: 1 },
        'gate-b': { type: 'command', command: 'true', retry_threshold: 1 },
      },
      hooks: {
        'task.completed': [{ gate: 'gate-a', priority: 100 }],
        'task.created': [{ gate: 'gate-b', priority: 100 }],
      },
    });

    const resultCompleted = await engine.handleEvent(
      makeEvent({ event_type: 'task.completed' }),
    );
    expect(resultCompleted.gate_requests).toHaveLength(1);
    expect(resultCompleted.gate_requests[0]!.gate_id).toBe('gate-a');

    const resultCreated = await engine.handleEvent(
      makeEvent({ event_type: 'task.created' }),
    );
    expect(resultCreated.gate_requests).toHaveLength(1);
    expect(resultCreated.gate_requests[0]!.gate_id).toBe('gate-b');
  });
});

// ══════════════════════════════════════════════
// createHookEvent factory
// ══════════════════════════════════════════════

describe('createHookEvent', () => {
  it('auto-generates event_id, created_at, and schema_version', () => {
    const event = createHookEvent({
      event_type: 'task.completed',
      subject_id: 'task-1',
      payload: {},
    });
    expect(event.event_type).toBe('task.completed');
    expect(event.event_id).toMatch(/^event_/);
    expect(event.created_at).toBeTruthy();
    expect(event.schema_version).toBe(SCHEMA_VERSION);
  });

  it('preserves caller-provided fields', () => {
    const event = createHookEvent({
      event_type: 'task.failed',
      subject_id: 'subj-42',
      payload: { error: 'timeout' },
    });
    expect(event.subject_id).toBe('subj-42');
    expect(event.payload).toEqual({ error: 'timeout' });
  });
});
