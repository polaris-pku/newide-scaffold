import { describe, it, expect } from 'vitest';
import { HookEngine } from '../../src/hook/hook';
import { SCHEMA_VERSION, nowTimestamp } from '../../src/core';

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function makeEngine(ifExpression: string) {
  return new HookEngine({
    config: {
      version: 'hook-0.1',
      settings: {
        fail_fast: false,
        default_timeout: 30,
        parallel: false,
        output_format: 'json',
        emergency_env_var: 'AGENT_EMERGENCY_SKIP',
      },
      gates: {
        'allow-gate': {
          type: 'command',
          run: 'node -e "process.exit(0)"',
          retry_threshold: 1,
        },
      },
      hooks: {
        'task.completed': [
          { gate: 'allow-gate', priority: 100, if: ifExpression },
        ],
      },
    },
  });
}

function makeEvent(overrides?: Partial<ReturnType<typeof createEvent>>) {
  return {
    ...createEvent(),
    ...overrides,
  };
}

function createEvent() {
  return {
    event_id: 'evt-1',
    event_type: 'task.completed' as const,
    subject_id: 'task-001',
    task_id: 'task-001',
    run_id: 'run-001',
    payload: {} as Record<string, unknown>,
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

async function evaluateCondition(
  expression: string,
  eventOverrides?: Partial<ReturnType<typeof createEvent>>,
): Promise<boolean> {
  const engine = makeEngine(expression);
  const event = makeEvent(eventOverrides);
  const result = await engine.handleEvent(event);
  // matched=true + non-empty gate_requests means the condition passed
  return result.matched && result.gate_requests.length > 0;
}

// ──────────────────────────────────────────────
// Equality operators: ==, !=
// ──────────────────────────────────────────────

describe('equality operators', () => {
  it('== matches equal strings', async () => {
    const matched = await evaluateCondition("event_type == 'task.completed'");
    expect(matched).toBe(true);
  });

  it('== returns false for non-equal strings', async () => {
    const matched = await evaluateCondition("event_type == 'task.started'");
    expect(matched).toBe(false);
  });

  it('!= returns true for different strings', async () => {
    const matched = await evaluateCondition("event_type != 'task.started'");
    expect(matched).toBe(true);
  });

  it('!= returns false for equal strings', async () => {
    const matched = await evaluateCondition("event_type != 'task.completed'");
    expect(matched).toBe(false);
  });

  it('== compares payload field values', async () => {
    const matched = await evaluateCondition("payload.risk_level == 'critical'", {
      payload: { risk_level: 'critical' },
    });
    expect(matched).toBe(true);
  });

  it('== returns false when payload field does not match', async () => {
    const matched = await evaluateCondition("payload.risk_level == 'critical'", {
      payload: { risk_level: 'low' },
    });
    expect(matched).toBe(false);
  });
});

// ──────────────────────────────────────────────
// in operator
// ──────────────────────────────────────────────

describe('in operator', () => {
  it('in returns true when value is in the list', async () => {
    const matched = await evaluateCondition("event_type in ['task.completed', 'task.started']");
    expect(matched).toBe(true);
  });

  it('in returns false when value is not in the list', async () => {
    const matched = await evaluateCondition("event_type in ['task.created', 'task.started']");
    expect(matched).toBe(false);
  });

  it('in works with payload fields', async () => {
    const matched = await evaluateCondition("payload.risk_level in ['medium', 'high', 'critical']", {
      payload: { risk_level: 'high' },
    });
    expect(matched).toBe(true);
  });

  it('in returns false when payload value not in list', async () => {
    const matched = await evaluateCondition("payload.risk_level in ['medium', 'high']", {
      payload: { risk_level: 'low' },
    });
    expect(matched).toBe(false);
  });
});

// ──────────────────────────────────────────────
// matches operator (glob pattern matching)
// ──────────────────────────────────────────────

describe('matches operator (glob)', () => {
  it('matches a simple glob pattern', async () => {
    const matched = await evaluateCondition("payload.file_path matches '*.ts'", {
      payload: { file_path: 'src/main.ts' },
    });
    expect(matched).toBe(true);
  });

  it('returns false when glob does not match', async () => {
    const matched = await evaluateCondition("payload.file_path matches '*.ts'", {
      payload: { file_path: 'src/main.rs' },
    });
    expect(matched).toBe(false);
  });

  it('matches directory glob patterns', async () => {
    const matched = await evaluateCondition("payload.file_path matches 'services/*'", {
      payload: { file_path: 'services/auth/login.ts' },
    });
    expect(matched).toBe(true);
  });

  it('matches ? single-character wildcard', async () => {
    const matched = await evaluateCondition("payload.version matches 'v?.?'", {
      payload: { version: 'v1.0' },
    });
    expect(matched).toBe(true);
  });

  it('supports | alternation in patterns', async () => {
    const matched = await evaluateCondition(
      "payload.file_path matches '*.ts|*.tsx|*.js'",
      { payload: { file_path: 'src/component.tsx' } },
    );
    expect(matched).toBe(true);
  });

  it('| alternation — matches second alternative', async () => {
    const matched = await evaluateCondition(
      "payload.file_path matches '*.test.*|*_test.*'",
      { payload: { file_path: 'utils_test.py' } },
    );
    expect(matched).toBe(true);
  });

  it('| alternation returns false when none match', async () => {
    const matched = await evaluateCondition(
      "payload.file_path matches '*.ts|*.tsx'",
      { payload: { file_path: 'src/main.rs' } },
    );
    expect(matched).toBe(false);
  });

  it('matches literal text with | alternation (RFC example)', async () => {
    const matched = await evaluateCondition(
      "payload.tool_input.command matches 'rm -rf|git push --force'",
      { payload: { tool_input: { command: 'git push --force' } } },
    );
    expect(matched).toBe(true);
  });
});

// ──────────────────────────────────────────────
// regex operator
// ──────────────────────────────────────────────

describe('regex operator', () => {
  it('matches a regex pattern', async () => {
    const matched = await evaluateCondition(
      "payload.tool_input.command regex '^git\\\\s+push'",
      { payload: { tool_input: { command: 'git push --force' } } },
    );
    expect(matched).toBe(true);
  });

  it('returns false when regex does not match', async () => {
    const matched = await evaluateCondition(
      "payload.tool_input.command regex '^npm\\\\s+run'",
      { payload: { tool_input: { command: 'git push --force' } } },
    );
    expect(matched).toBe(false);
  });

  it('supports regex character classes', async () => {
    const matched = await evaluateCondition(
      "payload.version regex '^\\\\d+\\\\.\\\\d+\\\\.\\\\d+$'",
      { payload: { version: '2.14.0' } },
    );
    expect(matched).toBe(true);
  });

  it('returns false for invalid regex (fail-closed)', async () => {
    const matched = await evaluateCondition(
      "payload.value regex '[invalid'",
      { payload: { value: 'test' } },
    );
    expect(matched).toBe(false);
  });
});

// ──────────────────────────────────────────────
// Comparison operators: >, <, >=, <=
// ──────────────────────────────────────────────

describe('comparison operators', () => {
  it('>= returns true when greater or equal', async () => {
    const matched = await evaluateCondition('payload.ppc >= 0.85', {
      payload: { ppc: 0.95 },
    });
    expect(matched).toBe(true);
  });

  it('>= returns true when exactly equal', async () => {
    const matched = await evaluateCondition('payload.ppc >= 0.85', {
      payload: { ppc: 0.85 },
    });
    expect(matched).toBe(true);
  });

  it('>= returns false when less', async () => {
    const matched = await evaluateCondition('payload.ppc >= 0.85', {
      payload: { ppc: 0.5 },
    });
    expect(matched).toBe(false);
  });

  it('<= returns true when less or equal', async () => {
    const matched = await evaluateCondition('payload.ppc <= 1.0', {
      payload: { ppc: 0.95 },
    });
    expect(matched).toBe(true);
  });

  it('> returns true when strictly greater', async () => {
    const matched = await evaluateCondition('payload.count > 5', {
      payload: { count: 10 },
    });
    expect(matched).toBe(true);
  });

  it('> returns false when equal', async () => {
    const matched = await evaluateCondition('payload.count > 5', {
      payload: { count: 5 },
    });
    expect(matched).toBe(false);
  });

  it('< returns true when strictly less', async () => {
    const matched = await evaluateCondition('payload.count < 5', {
      payload: { count: 3 },
    });
    expect(matched).toBe(true);
  });

  it('< returns false when equal', async () => {
    const matched = await evaluateCondition('payload.count < 5', {
      payload: { count: 5 },
    });
    expect(matched).toBe(false);
  });
});

// ──────────────────────────────────────────────
// Logical operators: and, or, not
// ──────────────────────────────────────────────

describe('logical operators', () => {
  it('and returns true when both sides are true', async () => {
    const matched = await evaluateCondition(
      "payload.risk_level == 'high' and payload.file_path matches '*.ts'",
      { payload: { risk_level: 'high', file_path: 'src/main.ts' } },
    );
    expect(matched).toBe(true);
  });

  it('and returns false when left side is false', async () => {
    const matched = await evaluateCondition(
      "payload.risk_level == 'high' and payload.file_path matches '*.ts'",
      { payload: { risk_level: 'low', file_path: 'src/main.ts' } },
    );
    expect(matched).toBe(false);
  });

  it('and returns false when right side is false', async () => {
    const matched = await evaluateCondition(
      "payload.risk_level == 'high' and payload.file_path matches '*.ts'",
      { payload: { risk_level: 'high', file_path: 'src/main.rs' } },
    );
    expect(matched).toBe(false);
  });

  it('or returns true when either side is true', async () => {
    const matched = await evaluateCondition(
      "payload.risk_level == 'low' or payload.ppc >= 0.9",
      { payload: { risk_level: 'high', ppc: 0.95 } },
    );
    expect(matched).toBe(true);
  });

  it('or returns false when both sides are false', async () => {
    const matched = await evaluateCondition(
      "payload.risk_level == 'low' or payload.ppc < 0.5",
      { payload: { risk_level: 'high', ppc: 0.95 } },
    );
    expect(matched).toBe(false);
  });

  it('not negates a true condition', async () => {
    const matched = await evaluateCondition('not (payload.ppc < 0.8)', {
      payload: { ppc: 0.95 },
    });
    expect(matched).toBe(true);
  });

  it('not negates a false condition', async () => {
    const matched = await evaluateCondition('not (payload.ppc >= 0.8)', {
      payload: { ppc: 0.5 },
    });
    expect(matched).toBe(true);
  });

  it('supports precedence: and before or', async () => {
    // (true and false) or true = true
    const matched = await evaluateCondition(
      "payload.a == 'x' and payload.b == 'y' or payload.c == 'z'",
      { payload: { a: 'x', b: 'not-y', c: 'z' } },
    );
    expect(matched).toBe(true);
  });
});

// ──────────────────────────────────────────────
// exists operator
// ──────────────────────────────────────────────

describe('exists operator', () => {
  it('exists returns true when field has a value', async () => {
    const matched = await evaluateCondition('exists payload', {
      payload: { risk_level: 'high' },
    });
    expect(matched).toBe(true);
  });

  it('exists returns false when field is undefined', async () => {
    // task_id exists but context_pack_ref does not
    const event = createEvent();
    const engine = new HookEngine({
      config: {
        version: 'hook-0.1',
        settings: {
          fail_fast: false,
          default_timeout: 30,
          parallel: false,
          output_format: 'json',
          emergency_env_var: 'AGENT_EMERGENCY_SKIP',
        },
        gates: {
          'allow-gate': {
            type: 'command',
            run: 'node -e "process.exit(0)"',
            retry_threshold: 1,
          },
        },
        hooks: {
          'task.completed': [
            { gate: 'allow-gate', priority: 100, if: 'exists nonexistent_field' },
          ],
        },
      },
    });
    const result = await engine.handleEvent(event);
    // nonexistent_field is not on the event → exists → false → gate not triggered
    expect(result.matched).toBe(true);
    expect(result.gate_requests).toHaveLength(0);
  });

  it('not exists returns true when field is absent', async () => {
    const matched = await evaluateCondition('not exists nonexistent_field');
    expect(matched).toBe(true);
  });

  it('not exists returns false when field is present', async () => {
    const matched = await evaluateCondition('not exists payload', {
      payload: { risk_level: 'high' },
    });
    expect(matched).toBe(false);
  });

  it('exists works with nested payload fields', async () => {
    const matched = await evaluateCondition('exists payload.risk_level', {
      payload: { risk_level: 'high' },
    });
    expect(matched).toBe(true);
  });

  it('not exists works with nested payload fields', async () => {
    const matched = await evaluateCondition('not exists payload.nonexistent', {
      payload: { risk_level: 'high' },
    });
    expect(matched).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Complex / composed expressions (RFC examples)
// ──────────────────────────────────────────────

describe('complex composed expressions', () => {
  it('RFC Ex1: risk_level in list AND affected_paths matches glob', async () => {
    const matched = await evaluateCondition(
      "payload.risk_level in ['medium', 'high'] and payload.affected_paths matches 'services/*'",
      {
        payload: {
          risk_level: 'high',
          affected_paths: 'services/auth/login.ts',
        },
      },
    );
    expect(matched).toBe(true);
  });

  it('RFC Ex2: tool_name == value AND command matches alternation', async () => {
    const matched = await evaluateCondition(
      "payload.tool_name == 'Bash' and payload.tool_input.command matches 'rm -rf|git push --force'",
      {
        payload: {
          tool_name: 'Bash',
          tool_input: { command: 'git push --force' },
        },
      },
    );
    expect(matched).toBe(true);
  });

  it('RFC Ex3: ppc >= threshold AND not exists unresolved_risks', async () => {
    const matched = await evaluateCondition(
      'payload.ppc >= 0.85 and not exists payload.unresolved_risks',
      { payload: { ppc: 0.95 } },
    );
    expect(matched).toBe(true);
  });

  it('complex expression with and + or + not + matches', async () => {
    const matched = await evaluateCondition(
      "payload.danger_level == 'critical' and (" +
        "payload.file_path matches '*.env*' or " +
        "payload.file_path matches '*.key*'" +
        ')',
      {
        payload: {
          danger_level: 'critical',
          file_path: '.env.production',
        },
      },
    );
    expect(matched).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────

describe('edge cases', () => {
  it('undefined expression (no if field) is always true', async () => {
    const engine = new HookEngine({
      config: {
        version: 'hook-0.1',
        settings: {
          fail_fast: false,
          default_timeout: 30,
          parallel: false,
          output_format: 'json',
          emergency_env_var: 'AGENT_EMERGENCY_SKIP',
        },
        gates: {
          'allow-gate': {
            type: 'command',
            run: 'node -e "process.exit(0)"',
            retry_threshold: 1,
          },
        },
        hooks: {
          'task.completed': [
            { gate: 'allow-gate', priority: 100 },
          ],
        },
      },
    });
    const event = createEvent();
    const result = await engine.handleEvent(event);
    expect(result.matched).toBe(true);
    expect(result.gate_requests).toHaveLength(1);
  });

  it('invalid expression syntax returns false (fail-closed)', async () => {
    const matched = await evaluateCondition("this is ! not @ valid # syntax");
    expect(matched).toBe(false);
  });

  it('empty expression string is treated as true', async () => {
    const engine = new HookEngine({
      config: {
        version: 'hook-0.1',
        settings: {
          fail_fast: false,
          default_timeout: 30,
          parallel: false,
          output_format: 'json',
          emergency_env_var: 'AGENT_EMERGENCY_SKIP',
        },
        gates: {
          'allow-gate': {
            type: 'command',
            run: 'node -e "process.exit(0)"',
            retry_threshold: 1,
          },
        },
        hooks: {
          'task.completed': [
            { gate: 'allow-gate', priority: 100, if: '' },
          ],
        },
      },
    });
    const event = createEvent();
    const result = await engine.handleEvent(event);
    expect(result.matched).toBe(true);
    expect(result.gate_requests).toHaveLength(1);
  });

  it('matches with special regex characters in value does not error', async () => {
    const matched = await evaluateCondition(
      "payload.file_path matches '*.ts'",
      { payload: { file_path: 'computed[1].value + tax(annual)' } },
    );
    // Expect false — value contains special chars that don't match glob *.ts
    expect(matched).toBe(false);
  });

  it('regex with literal dot in pattern matches literally', async () => {
    const matched = await evaluateCondition(
      "payload.file_path regex '\\\\.env$'",
      { payload: { file_path: '.env' } },
    );
    expect(matched).toBe(true);
  });
});

// ──────────────────────────────────────────────
// Security: prototype-chain / sandbox protections
// ──────────────────────────────────────────────

describe('security — prototype-chain access blocked', () => {
  it('blocks payload.constructor (parse-time rejection)', async () => {
    const matched = await evaluateCondition(
      "payload.constructor == 'Object'",
      { payload: { risk_level: 'high' } },
    );
    expect(matched).toBe(false);
  });

  it('blocks payload.__proto__ (parse-time rejection)', async () => {
    const matched = await evaluateCondition(
      "payload.__proto__ == null",
      { payload: { risk_level: 'high' } },
    );
    expect(matched).toBe(false);
  });

  it('blocks payload.prototype (parse-time rejection)', async () => {
    const matched = await evaluateCondition(
      "payload.prototype == undefined",
      { payload: { risk_level: 'high' } },
    );
    expect(matched).toBe(false);
  });

  it('blocks event_type.constructor (primitive auto-box attack)', async () => {
    const matched = await evaluateCondition(
      "event_type.constructor == 'String'",
    );
    expect(matched).toBe(false);
  });

  it('blocks nested chain: payload.constructor.constructor', async () => {
    const matched = await evaluateCondition(
      "payload.constructor.constructor == 'Function'",
      { payload: {} },
    );
    expect(matched).toBe(false);
  });

  it('blocks .constructor with spaces around dot', async () => {
    const matched = await evaluateCondition(
      "payload . constructor == 'Object'",
      { payload: { risk_level: 'high' } },
    );
    expect(matched).toBe(false);
  });

  it('blocks .__proto__ with whitespace', async () => {
    const matched = await evaluateCondition(
      'payload  .  __proto__ == null',
      { payload: {} },
    );
    expect(matched).toBe(false);
  });

  it('legitimate member access still works after protections', async () => {
    const matched = await evaluateCondition(
      "payload.risk_level == 'high'",
      { payload: { risk_level: 'high' } },
    );
    expect(matched).toBe(true);
  });

  it('nested legitimate access still works', async () => {
    const matched = await evaluateCondition(
      "payload.tool_input.command matches 'git push*'",
      { payload: { tool_input: { command: 'git push --force' } } },
    );
    expect(matched).toBe(true);
  });

  it('exists operator still works on nested fields', async () => {
    const matched = await evaluateCondition('exists payload.risk_level', {
      payload: { risk_level: 'high' },
    });
    expect(matched).toBe(true);
  });

  it('proxy returns null for undefined nested field', async () => {
    // Basic proxy sanity check: undefined nested fields resolve to null
    const matched = await evaluateCondition(
      'payload.nonexistent_field == null',
      { payload: { risk_level: 'high' } },
    );
    expect(matched).toBe(true);
  });

  it('function values are blocked at runtime (explicit payload function)', async () => {
    // When payload contains a function-valued property, the safeScope proxy
    // should block it (typeof function → return null).
    // Using a custom-named function avoids the expr-eval tokenizer quirk
    // where Object.prototype properties (toString, valueOf, etc.) are
    // falsely classified as named operators via prototype-chain `in` checks.
    const matched = await evaluateCondition(
      'payload.myCallback == null',
      { payload: { myCallback: () => 'hello', risk_level: 'high' } },
    );
    // myCallback is a function, blocked by wrap() → null → == null is true
    expect(matched).toBe(true);
  });
});
