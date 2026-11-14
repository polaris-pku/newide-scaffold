/**
 * role-autonomy-tools 测试：隔离工具表（5 个工具）与参数/执行语义。
 *
 * 覆盖（阶段 2 矩阵 OWN-01/02/03、FIN-04、EVD-05、DIS-02/03）：
 * - 工具表只含 dispatch_execution / query_memory / read_evidence / update_plan / finish_task；
 *   没有 invoke_driver / invoke_council / mailbox_send / fs/shell/git/network；
 * - 模型伪造宿主身份字段（dispatch_id/task_id/run_id/role_id/sequence/accepted_at/预算）被 strict
 *   schema 拒绝，宿主自己填身份、sequence、accepted_at、budget_before；
 * - 实际 Brief instruction 原样传给 dispatch port；retry_of/reconciliation_ref 透传；
 *   reuse Session 必须等于 context.confirmed_session_id，否则不派工；
 * - read_evidence 只经 RoleJournalPort：未登记 → ROLE_EVIDENCE_UNAVAILABLE，
 *   路径穿越/绝对路径/file:// → ROLE_INVALID_ARGUMENTS；
 * - finish 拒绝把 gaps 交还 role；接受后剩余工具一律 ROLE_ALREADY_FINISHED；
 * - 同一回复多个 dispatch 串行（maxActive=1）；纯文本不被强制包装成 driver 调用。
 */
import { describe, expect, it } from 'vitest';
import type { BudgetSnapshot, EvidenceRef } from '../../src/driver';
import { hashExecutionBrief } from '../../src/driver';

import type { ToolCall } from '../../src/memory';
import type {
  RoleBudgetConsumption,
  RoleBudgetPort,
  RoleBudgetSnapshot,
  RoleFinishDecision,
  RoleFrozenBudget,
  RoleFrozenPolicy,
  RoleLlmCompletion,
  RoleLlmPort,
  RoleLoopContextInput,
  RoleLoopOptions,
  RoleToolName,
} from '../../src/app/role-autonomy-contract';
import {
  ROLE_BUDGET_DEFAULTS,
  ROLE_TOOL_NAMES,
  ROLE_VERIFICATION_OUTCOMES,
  RoleDispatchExecutionArgsSchema,
  RoleFinishArgsSchema,
  RoleQueryMemoryArgsSchema,
  RoleReadEvidenceArgsSchema,
  RoleTerminationError,
  RoleUpdatePlanArgsSchema,
} from '../../src/app/role-autonomy-contract';
import { createRoleToolExecutor } from '../../src/app/role-autonomy-tools';
import { runRoleExecutionLoop } from '../../src/app/role-execution-loop';
import {
  FakeJournal,
  FakeMemory,
  FakeDispatchPort,
  FakeFinishValidator,
} from './role-autonomy-test-fixtures';

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────

const FROZEN_BUDGET: RoleFrozenBudget = {
  limits: { ...ROLE_BUDGET_DEFAULTS },
  deadline_at: '2026-11-13T22:00:00.000Z',
};
const NOW = (): Date => new Date('2026-11-13T20:00:00.000Z');
const FORBIDDEN_TOOL_NAMES = [
  'invoke_driver',
  'invoke_council',
  'mailbox_send',
  'read_file',
  'write_file',
  'shell',
  'bash',
  'git',
  'http',
  'fetch',
] as const;

function makePolicy(overrides: Partial<RoleFrozenPolicy> = {}): RoleFrozenPolicy {
  return {
    engine: 'role_autonomy',
    engine_version: 'role-autonomy-v1',
    tool_allowlist: [...ROLE_TOOL_NAMES],
    evidence_only: false,
    buffer_v2: false,
    budget: FROZEN_BUDGET,
    routing: {},
    ...overrides,
  };
}

function makeContext(overrides: Partial<RoleLoopContextInput> = {}): RoleLoopContextInput {
  return {
    task_id: 'task_1',
    run_id: 'run_1',
    role_id: 'role_1',
    instruction: 'Fix the failing test',
    response_only_allowed: true,
    ...overrides,
  };
}

let callCounter = 0;
function toolCall(name: string, args: unknown): ToolCall {
  callCounter += 1;
  return {
    id: `call_${callCounter}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

// ─────────────────────────────────────────────────────────────
// Fake 端口
// ─────────────────────────────────────────────────────────────

class FakeBudget implements RoleBudgetPort {
  readonly frozen = FROZEN_BUDGET;
  readonly consumed: RoleBudgetConsumption = {
    dispatches: 0,
    role_rounds: 0,
    tokens: 0,
    tool_calls: 0,
    tokens_missing: false,
  };

  snapshot(now?: Date): RoleBudgetSnapshot {
    return {
      frozen: this.frozen,
      consumed: { ...this.consumed },
      wall_clock_remaining_ms: Date.parse(this.frozen.deadline_at) - (now ?? NOW()).getTime(),
    };
  }

  assertRoundAllowed(): void {}
  async recordRound(_round: number, _usage: unknown, _at: string): Promise<void> {}
  assertDispatchAllowed(): void {}
  recordDispatch(): void {
    this.consumed.dispatches += 1;
  }
  assertTokenBudget(): void {}
}

interface ToolsHarness {
  journal: FakeJournal;
  dispatch: FakeDispatchPort;
  memory: FakeMemory;
  budget: FakeBudget;
  finish: FakeFinishValidator;
  context: RoleLoopContextInput;
  policy: RoleFrozenPolicy;
  executor: ReturnType<typeof createRoleToolExecutor>;
}

function makeToolsHarness(
  input: {
    context?: Partial<RoleLoopContextInput>;
    policy?: Partial<RoleFrozenPolicy>;
    decisions?: RoleFinishDecision[];
  } = {},
): ToolsHarness {
  const journal = new FakeJournal();
  const dispatch = new FakeDispatchPort(journal);
  const memory = new FakeMemory();
  const budget = new FakeBudget();
  const finish = new FakeFinishValidator(input.decisions);
  const context = makeContext(input.context);
  const policy = makePolicy(input.policy);
  const executor = createRoleToolExecutor({
    journal,
    dispatch,
    memory,
    budget,
    finish,
    policy,
    context,
    now: NOW,
  });
  return { journal, dispatch, memory, budget, finish, context, policy, executor };
}

function errorCodeOf(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

// ─────────────────────────────────────────────────────────────
// 生成 JSON Schema 的遍历工具（表驱动断言用）
// ─────────────────────────────────────────────────────────────

type SchemaNode = Record<string, unknown>;

function collectSchemaNodes(
  node: unknown,
  path = 'root',
): Array<{ node: SchemaNode; path: string }> {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => collectSchemaNodes(item, `${path}[${index}]`));
  }
  const record = node as SchemaNode;
  return [
    { node: record, path },
    ...Object.entries(record).flatMap(([key, child]) =>
      collectSchemaNodes(child, `${path}.${key}`),
    ),
  ];
}

function schemaAt(root: unknown, keys: readonly string[]): SchemaNode | undefined {
  let current: unknown = root;
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as SchemaNode)[key];
  }
  return current === null || typeof current !== 'object' ? undefined : (current as SchemaNode);
}

function toolParameters(name: RoleToolName): SchemaNode {
  const definition = makeToolsHarness().executor.definitions.find(
    (candidate) => candidate.function.name === name,
  );
  if (definition === undefined) throw new Error(`missing tool definition: ${name}`);
  return definition.function.parameters as SchemaNode;
}

/** 工具名 → 同源 Zod schema + 模型侧 required（宿主身份/预算字段不得出现）。 */
const TOOL_SCHEMA_CASES: ReadonlyArray<{
  name: RoleToolName;
  schema: { shape: Record<string, unknown> };
  required: readonly string[];
}> = [
  {
    name: 'dispatch_execution',
    schema: RoleDispatchExecutionArgsSchema,
    required: ['instruction', 'kind'],
  },
  { name: 'query_memory', schema: RoleQueryMemoryArgsSchema, required: ['query'] },
  { name: 'read_evidence', schema: RoleReadEvidenceArgsSchema, required: ['ref'] },
  { name: 'update_plan', schema: RoleUpdatePlanArgsSchema, required: ['plan'] },
  { name: 'finish_task', schema: RoleFinishArgsSchema, required: ['status', 'summary'] },
];

/** 整数边界：`exclusiveMinimum: n` 已收敛为 `minimum: n + 1`（声明的下界）。 */
const INTEGER_BOUNDARY_CASES: ReadonlyArray<{
  tool: RoleToolName;
  path: readonly string[];
  minimum: number;
  maximum?: number;
}> = [
  {
    tool: 'dispatch_execution',
    path: ['properties', 'timeout_ms'],
    minimum: 1,
    maximum: ROLE_BUDGET_DEFAULTS.dispatch_timeout_ms,
  },
  { tool: 'query_memory', path: ['properties', 'limit'], minimum: 1, maximum: 20 },
  { tool: 'read_evidence', path: ['properties', 'offset'], minimum: 0 },
  { tool: 'read_evidence', path: ['properties', 'limit'], minimum: 1 },
];

// ─────────────────────────────────────────────────────────────
// 隔离工具表
// ─────────────────────────────────────────────────────────────

describe('复审修复：模型 timeout 只能收紧', () => {
  it('timeout_ms 大于冻结上限 → Brief 使用冻结上限；更小的值生效', async () => {
    const frozenPolicy = {
      budget: {
        ...FROZEN_BUDGET,
        limits: { ...FROZEN_BUDGET.limits, dispatch_timeout_ms: 2_000 },
      },
    };
    const harness = makeToolsHarness({ policy: frozenPolicy });
    await harness.executor.execute(
      toolCall('dispatch_execution', {
        instruction: 'run the long job',
        kind: 'execute',
        timeout_ms: 500_000,
      }),
    );
    expect(harness.dispatch.calls[0]?.brief.timeout_ms).toBe(2_000);

    const second = makeToolsHarness({ policy: frozenPolicy });
    await second.executor.execute(
      toolCall('dispatch_execution', {
        instruction: 'run a short job',
        kind: 'execute',
        timeout_ms: 1_000,
      }),
    );
    expect(second.dispatch.calls[0]?.brief.timeout_ms).toBe(1_000);
  });

  it('timeout_ms 超过 schema 硬上限 → ROLE_INVALID_ARGUMENTS，不派工', async () => {
    const harness = makeToolsHarness();
    const result = await harness.executor.execute(
      toolCall('dispatch_execution', {
        instruction: 'run',
        kind: 'execute',
        timeout_ms: 999_999,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ROLE_INVALID_ARGUMENTS');
    expect(harness.dispatch.calls).toHaveLength(0);
  });
});

describe('role-autonomy-tools: 隔离工具表', () => {
  it('只含 5 个允许工具，没有 invoke_driver/invoke_council/mailbox_send/fs/shell/git/network', () => {
    const harness = makeToolsHarness();
    const names = harness.executor.definitions.map((definition) => definition.function.name);
    expect(names).toEqual([...ROLE_TOOL_NAMES]);
    for (const forbidden of FORBIDDEN_TOOL_NAMES) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('工具授权按冻结 allowlist 过滤；未授权工具 → ROLE_UNKNOWN_TOOL', async () => {
    const harness = makeToolsHarness({ policy: { tool_allowlist: ['finish_task'] } });
    expect(harness.executor.definitions.map((definition) => definition.function.name)).toEqual([
      'finish_task',
    ]);
    const result = await harness.executor.execute(
      toolCall('dispatch_execution', { kind: 'execute', instruction: 'not allowed' }),
    );
    expect(errorCodeOf(result)).toBe('ROLE_UNKNOWN_TOOL');
    expect(harness.dispatch.calls).toHaveLength(0);
  });

  it('未知工具与非法 JSON 参数被稳定拒绝', async () => {
    const harness = makeToolsHarness();
    expect(errorCodeOf(await harness.executor.execute(toolCall('invoke_driver', {})))).toBe(
      'ROLE_UNKNOWN_TOOL',
    );
    expect(
      errorCodeOf(
        await harness.executor.execute({
          id: 'bad_json',
          type: 'function',
          function: { name: 'dispatch_execution', arguments: '{not-json' },
        }),
      ),
    ).toBe('ROLE_INVALID_ARGUMENTS');
  });

  it('模型伪造宿主身份字段（dispatch_id/task_id/run_id/role_id/sequence/accepted_at/budget）被拒绝', async () => {
    const harness = makeToolsHarness();
    const forgedFields: Record<string, unknown>[] = [
      { dispatch_id: 'dsp_forged' },
      { task_id: 'task_forged' },
      { run_id: 'run_forged' },
      { role_id: 'role_forged' },
      { sequence: 99 },
      { accepted_at: '2026-01-01T00:00:00.000Z' },
      { budget_before: { dispatches_left: 1 } },
      { brief_sha256: 'a'.repeat(64) },
    ];
    for (const forged of forgedFields) {
      const result = await harness.executor.execute(
        toolCall('dispatch_execution', {
          kind: 'execute',
          instruction: 'forged identity',
          ...forged,
        }),
      );
      expect(errorCodeOf(result)).toBe('ROLE_INVALID_ARGUMENTS');
    }
    expect(harness.dispatch.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 生成 JSON Schema：与 Zod 同源 + 保守收敛（RD-IMP-14）
// ─────────────────────────────────────────────────────────────

describe('role-autonomy-tools: 生成 JSON Schema 同源与收敛', () => {
  it.each(TOOL_SCHEMA_CASES)(
    '$name：参数与 Zod schema 同源（字段集合一致，required/additionalProperties 正确）',
    ({ name, schema, required }) => {
      const parameters = toolParameters(name);
      expect(parameters.type).toBe('object');
      // strict：模型伪造的宿主身份/预算字段没有声明位置。
      expect(parameters.additionalProperties).toBe(false);
      expect([...((parameters.required as string[] | undefined) ?? [])].sort()).toEqual(
        [...required].sort(),
      );
      // 同源生成：模型看到的字段集合 = 运行时 Zod 接受的字段集合，不维护第二份手写表。
      expect(Object.keys(parameters.properties as SchemaNode).sort()).toEqual(
        Object.keys(schema.shape).sort(),
      );
    },
  );

  it.each(TOOL_SCHEMA_CASES)(
    '$name：已删除 $schema/default，const→enum、oneOf→anyOf，整数 exclusiveMinimum 已收敛',
    ({ name }) => {
      const parameters = toolParameters(name);
      const nodes = collectSchemaNodes(parameters);
      for (const { node, path } of nodes) {
        expect(node, path).not.toHaveProperty('$schema');
        expect(node, path).not.toHaveProperty('default');
        expect(node, path).not.toHaveProperty('const');
        expect(node, path).not.toHaveProperty('oneOf');
        if (node.type === 'integer') {
          // `exclusiveMinimum: n` 被收敛成等价的 `minimum: n + 1`（更广的 provider 子集）。
          expect(node, path).not.toHaveProperty('exclusiveMinimum');
          expect(typeof node.minimum, path).toBe('number');
        }
      }
      // 额外显式断言根节点：$schema 只是 meta，provider 不需要。
      expect(parameters).not.toHaveProperty('$schema');
    },
  );

  it.each(INTEGER_BOUNDARY_CASES)(
    '$tool 的 $path：整数边界为 minimum（不是 exclusiveMinimum）',
    ({ tool, path, minimum, maximum }) => {
      const node = schemaAt(toolParameters(tool), path);
      expect(node).toBeDefined();
      expect(node).toMatchObject({ type: 'integer', minimum });
      expect(node).not.toHaveProperty('exclusiveMinimum');
      if (maximum !== undefined) expect(node?.maximum).toBe(maximum);
    },
  );

  it('dispatch_execution.session：oneOf 已转 anyOf、const 已转 enum，每个分支 required 含 mode', () => {
    const parameters = toolParameters('dispatch_execution');
    const session = schemaAt(parameters, ['properties', 'session']);
    expect(session).toBeDefined();
    expect(session).not.toHaveProperty('oneOf');
    expect(session).not.toHaveProperty('default');
    const branches = session?.anyOf as SchemaNode[];
    expect(Array.isArray(branches)).toBe(true);
    expect(branches).toHaveLength(2);
    // 每个分支都必须显式声明 mode（不允许 provider 省略模式后猜默认值）。
    for (const branch of branches) {
      expect(Array.isArray(branch.required)).toBe(true);
      expect(branch.required as string[]).toContain('mode');
      expect(branch.additionalProperties).toBe(false);
    }
    const modes = branches.map((branch) =>
      schemaAt(branch, ['properties', 'mode']),
    ) as SchemaNode[];
    expect(modes.map((mode) => mode.enum)).toEqual([['fresh'], ['reuse']]);
  });

  it('finish_task：参数含 verification、无 checks/criterion/command/clause/target_paths', () => {
    const parameters = toolParameters('finish_task');
    const properties = parameters.properties as SchemaNode;
    expect(properties).toHaveProperty('verification');
    for (const removed of ['checks', 'criterion', 'command', 'clause', 'target_paths']) {
      expect(properties).not.toHaveProperty(removed);
      expect(parameters).not.toHaveProperty(removed);
    }

    const verification = schemaAt(parameters, ['properties', 'verification']);
    expect(verification).toMatchObject({ type: 'array', maxItems: 32 });
    expect(verification).not.toHaveProperty('default');

    const claim = schemaAt(parameters, ['properties', 'verification', 'items']);
    expect(claim).toMatchObject({ type: 'object', additionalProperties: false });
    expect(claim?.required).toEqual(['requirement', 'outcome']);
    expect(Object.keys(claim?.properties as SchemaNode).sort()).toEqual([
      'dispatch_ids',
      'evidence_refs',
      'note',
      'outcome',
      'requirement',
    ]);
    const outcome = schemaAt(parameters, [
      'properties',
      'verification',
      'items',
      'properties',
      'outcome',
    ]);
    expect(outcome?.enum).toEqual([...ROLE_VERIFICATION_OUTCOMES]);
  });
});

// ─────────────────────────────────────────────────────────────
// dispatch_execution
// ─────────────────────────────────────────────────────────────

describe('role-autonomy-tools: dispatch_execution', () => {
  it('宿主填身份/sequence/accepted_at/budget_before，实际 Brief instruction 传给 dispatch port', async () => {
    const harness = makeToolsHarness({ context: { frozen_driver_id: 'driver_alpha' } });
    const result = await harness.executor.execute(
      toolCall('dispatch_execution', {
        kind: 'execute',
        instruction: 'apply the minimal fix in src/foo.ts',
        acceptance: ['unit tests pass'],
        constraints: ['do not touch unrelated files'],
        expected_artifacts: ['src/foo.ts'],
      }),
    );
    expect(result.ok).toBe(true);
    expect(harness.dispatch.calls).toHaveLength(1);
    const call = harness.dispatch.calls[0];
    if (call === undefined) throw new Error('expected a dispatch call');
    expect(call.brief.instruction).toBe('apply the minimal fix in src/foo.ts');
    expect(call.brief.kind).toBe('execute');
    expect(call.brief.read_only).toBe(false);
    expect(call.brief.run_id).toBe('run_1');
    expect(call.brief.task_id).toBe('task_1');
    expect(call.brief.role_id).toBe('role_1');
    expect(call.brief.sequence).toBe(1);
    expect(call.brief.accepted_at).toBe('2026-11-13T20:00:00.000Z');
    expect(call.brief.session).toEqual({ mode: 'fresh' });
    expect(call.brief_sha256).toBe(hashExecutionBrief(call.brief));
    expect(call.budget_before).toEqual({
      dispatches_left: 12,
      role_tokens_left: 120_000,
      deadline_at: FROZEN_BUDGET.deadline_at,
    } satisfies BudgetSnapshot);
    // frozen_driver_id 只作诊断/回显。
    expect(result.data).toMatchObject({ status: 'succeeded', frozen_driver_id: 'driver_alpha' });
  });

  it('retry_of / reconciliation_ref 透传到宿主构造的 Brief', async () => {
    const harness = makeToolsHarness();
    const reconciliationRef: EvidenceRef = {
      path: 'journal/evidence/dsp_old.json',
      sha256: 'a'.repeat(64),
    };
    const result = await harness.executor.execute(
      toolCall('dispatch_execution', {
        kind: 'execute',
        instruction: 'retry with evidence',
        retry_of: 'dsp_old',
        reconciliation_ref: reconciliationRef,
      }),
    );
    expect(result.ok).toBe(true);
    const call = harness.dispatch.calls[0];
    expect(call?.brief.retry_of).toBe('dsp_old');
    expect(call?.brief.reconciliation_ref).toEqual(reconciliationRef);
  });

  it('investigate 强制只读；execute 声明只读被契约拒绝且不派工', async () => {
    const harness = makeToolsHarness();
    const investigate = await harness.executor.execute(
      toolCall('dispatch_execution', { kind: 'investigate', instruction: 'read only' }),
    );
    expect(investigate.ok).toBe(true);
    expect(harness.dispatch.calls[0]?.brief.read_only).toBe(true);

    const invalid = await harness.executor.execute(
      toolCall('dispatch_execution', {
        kind: 'execute',
        instruction: 'execute but read only',
        read_only: true,
      }),
    );
    expect(errorCodeOf(invalid)).toBe('ROLE_INVALID_ARGUMENTS');
    expect(harness.dispatch.calls).toHaveLength(1);
  });

  it('reuse Session 只能复用 context.confirmed_session_id，否则不派工', async () => {
    // 没有确认 Session：reuse 直接拒绝。
    const noSession = makeToolsHarness();
    const rejected = await noSession.executor.execute(
      toolCall('dispatch_execution', {
        kind: 'execute',
        instruction: 'reuse session',
        session: { mode: 'reuse', session_id: 'session_1' },
      }),
    );
    expect(errorCodeOf(rejected)).toBe('ROLE_INVALID_ARGUMENTS');
    expect(noSession.dispatch.calls).toHaveLength(0);

    // 有确认 Session 但 reuse 另一个 Session：拒绝，且不悄悄改成 fresh。
    const confirmed = makeToolsHarness({ context: { confirmed_session_id: 'session_1' } });
    const mismatch = await confirmed.executor.execute(
      toolCall('dispatch_execution', {
        kind: 'execute',
        instruction: 'reuse other session',
        session: { mode: 'reuse', session_id: 'session_other' },
      }),
    );
    expect(errorCodeOf(mismatch)).toBe('ROLE_INVALID_ARGUMENTS');
    expect(confirmed.dispatch.calls).toHaveLength(0);

    // 与确认 Session 一致：允许，且 Brief 保留 reuse。
    const allowed = await confirmed.executor.execute(
      toolCall('dispatch_execution', {
        kind: 'execute',
        instruction: 'reuse confirmed session',
        session: { mode: 'reuse', session_id: 'session_1' },
      }),
    );
    expect(allowed.ok).toBe(true);
    expect(confirmed.dispatch.calls[0]?.brief.session).toEqual({
      mode: 'reuse',
      session_id: 'session_1',
    });
  });

  it('写屏障失败映射成 typed termination（accepted/settled→journal，evidence→evidence）', async () => {
    const journalBarrier = makeToolsHarness();
    journalBarrier.dispatch.barrierStages.push('accepted');
    const journalError = await journalBarrier.executor
      .execute(toolCall('dispatch_execution', { kind: 'execute', instruction: 'x' }))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(journalError).toBeInstanceOf(RoleTerminationError);
    expect((journalError as RoleTerminationError).termination).toMatchObject({
      code: 'journal_write_failed',
      actor: 'host',
    });

    const evidenceBarrier = makeToolsHarness();
    evidenceBarrier.dispatch.barrierStages.push('evidence');
    const evidenceError = await evidenceBarrier.executor
      .execute(toolCall('dispatch_execution', { kind: 'execute', instruction: 'x' }))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect((evidenceError as RoleTerminationError).termination).toMatchObject({
      code: 'evidence_write_failed',
      actor: 'host',
    });

    // settled 写的是 Journal 终态行（evidence 已 durable）：与 engine 派工路径同一结论。
    const settledBarrier = makeToolsHarness();
    settledBarrier.dispatch.barrierStages.push('settled');
    const settledError = await settledBarrier.executor
      .execute(toolCall('dispatch_execution', { kind: 'execute', instruction: 'x' }))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect((settledError as RoleTerminationError).termination).toMatchObject({
      code: 'journal_write_failed',
      actor: 'host',
      details: {
        stage: 'settled',
        driver_invoked: true,
        side_effect_state: 'unknown',
        barrier_code: 'settled_write_failed',
      },
    });
  });

  it('同一回复的两个 dispatch 在工具层按顺序执行，sequence 连续', async () => {
    const harness = makeToolsHarness();
    const first = await harness.executor.execute(
      toolCall('dispatch_execution', { kind: 'execute', instruction: 'first' }),
    );
    const second = await harness.executor.execute(
      toolCall('dispatch_execution', { kind: 'verify', instruction: 'second' }),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(harness.dispatch.calls.map((call) => call.brief.sequence)).toEqual([1, 2]);
    expect(harness.dispatch.maxActive).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// query_memory / read_evidence / update_plan
// ─────────────────────────────────────────────────────────────

describe('role-autonomy-tools: query_memory / read_evidence / update_plan', () => {
  it('query_memory 失败返回 ROLE_MEMORY_UNAVAILABLE；成功返回文本与计数', async () => {
    const harness = makeToolsHarness();
    const ok = await harness.executor.execute(
      toolCall('query_memory', { query: 'how to fix', limit: 3 }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.data).toMatchObject({ text: 'memory:how to fix', count: 1 });
    expect(harness.memory.queryCalls[0]).toEqual({ query: 'how to fix', limit: 3 });

    harness.memory.failQuery = true;
    const failed = await harness.executor.execute(toolCall('query_memory', { query: 'x' }));
    expect(errorCodeOf(failed)).toBe('ROLE_MEMORY_UNAVAILABLE');
  });

  it('read_evidence 只经 RoleJournalPort：未登记拒绝，路径穿越/file:///绝对路径由 schema 拒绝', async () => {
    const harness = makeToolsHarness();
    const unregistered: EvidenceRef = {
      path: 'journal/evidence/nope.json',
      sha256: 'a'.repeat(64),
    };
    expect(
      errorCodeOf(await harness.executor.execute(toolCall('read_evidence', { ref: unregistered }))),
    ).toBe('ROLE_EVIDENCE_UNAVAILABLE');

    const unsafeRefs: Array<Record<string, unknown>> = [
      { path: '../outside.json', sha256: 'a'.repeat(64) },
      { path: '/etc/passwd', sha256: 'a'.repeat(64) },
      { path: 'file:///etc/passwd', sha256: 'a'.repeat(64) },
      { path: 'journal\\evidence\\x.json', sha256: 'a'.repeat(64) },
    ];
    for (const ref of unsafeRefs) {
      expect(errorCodeOf(await harness.executor.execute(toolCall('read_evidence', { ref })))).toBe(
        'ROLE_INVALID_ARGUMENTS',
      );
    }
  });

  it('read_evidence 读取已登记 ref 并支持分页参数', async () => {
    const harness = makeToolsHarness();
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const sha256 = 'b'.repeat(64);
    harness.journal.evidenceFiles.set('journal/evidence/dsp_1.json', { text, sha256 });
    const result = await harness.executor.execute(
      toolCall('read_evidence', {
        ref: { path: 'journal/evidence/dsp_1.json', sha256 },
        offset: 5,
        limit: 5,
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      text: 'fghij',
      offset: 5,
      limit: 5,
      total_bytes: text.length,
      truncated: true,
    });
  });

  it('update_plan 保存并回显计划，不计为派工', async () => {
    const harness = makeToolsHarness();
    const result = await harness.executor.execute(
      toolCall('update_plan', { plan: '1) inspect 2) fix 3) verify' }),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ plan: '1) inspect 2) fix 3) verify', updated: true });
    expect(harness.executor.plan).toBe('1) inspect 2) fix 3) verify');
    expect(harness.dispatch.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// finish_task
// ─────────────────────────────────────────────────────────────

describe('role-autonomy-tools: finish_task', () => {
  it('finish 拒绝把具体 gaps 作为工具结果交还 role，且不标记 finished', async () => {
    const harness = makeToolsHarness({
      decisions: [
        {
          accepted: false,
          gaps: [
            { code: 'unresolved_dispatch', message: 'dispatch dsp_1 is still unknown' },
            { code: 'evidence_source_insufficient', message: 'missing host-observed check' },
          ],
        },
      ],
    });
    const result = await harness.executor.execute(
      toolCall('finish_task', { status: 'completed', summary: 'done' }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ROLE_FINISH_REJECTED');
    const detail = result.error?.detail as { gaps?: Array<{ code: string }> } | undefined;
    expect(detail?.gaps?.map((gap) => gap.code)).toEqual([
      'unresolved_dispatch',
      'evidence_source_insufficient',
    ]);
    expect(harness.executor.finished).toBe(false);
    expect(harness.executor.finishRecord).toBeUndefined();
    expect(harness.journal.finishInputs).toHaveLength(0);
  });

  it('finish 接受后所有剩余工具（含再次 finish）都返回 ROLE_ALREADY_FINISHED', async () => {
    const harness = makeToolsHarness();
    const accepted = await harness.executor.execute(
      toolCall('finish_task', { status: 'completed', summary: 'all done' }),
    );
    expect(accepted.ok).toBe(true);
    expect(harness.executor.finished).toBe(true);
    expect(harness.executor.finishRecord?.status).toBe('completed');

    const remaining: ToolCall[] = [
      toolCall('dispatch_execution', { kind: 'execute', instruction: 'must not run' }),
      toolCall('query_memory', { query: 'must not run' }),
      toolCall('read_evidence', {
        ref: { path: 'journal/evidence/x.json', sha256: 'a'.repeat(64) },
      }),
      toolCall('update_plan', { plan: 'must not run' }),
      toolCall('finish_task', { status: 'completed', summary: 'again' }),
    ];
    for (const call of remaining) {
      const result = await harness.executor.execute(call);
      expect(errorCodeOf(result)).toBe('ROLE_ALREADY_FINISHED');
    }
    expect(harness.dispatch.calls).toHaveLength(0);
    expect(harness.memory.queryCalls).toHaveLength(0);
  });

  it('finish 记录规范化 response_only，并携带 zero_dispatch 事实', async () => {
    const harness = makeToolsHarness();
    const result = await harness.executor.execute(
      toolCall('finish_task', {
        status: 'completed',
        summary: 'answered without code changes',
        response_only: true,
      }),
    );
    expect(result.data).toMatchObject({
      accepted: true,
      status: 'completed',
      response_only: true,
      zero_dispatch: true,
    });
    expect(harness.executor.finishRecord?.response_only).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// OWN-02：纯文本不被强制包装成 driver 调用
// ─────────────────────────────────────────────────────────────

describe('role-autonomy-tools: 纯文本不被强制包装', () => {
  it('loop 收到纯文本时不会调用 dispatch port，必须显式 finish_task', async () => {
    const journal = new FakeJournal();
    const dispatch = new FakeDispatchPort(journal);
    const memory = new FakeMemory();
    const budget = new FakeBudget();
    const finish = new FakeFinishValidator();
    const completions: RoleLlmCompletion[] = [
      { content: 'done! all tests pass', tool_calls: undefined },
      {
        content: null,
        tool_calls: [toolCall('finish_task', { status: 'completed', summary: 'answered' })],
      },
    ];
    const llm: RoleLlmPort = {
      async completeWithTools(): Promise<RoleLlmCompletion> {
        const next = completions.shift();
        if (next === undefined) throw new Error('no scripted completion');
        return next;
      },
    };
    const options: RoleLoopOptions = {
      llm,
      journal,
      dispatch,
      memory,
      policy: makePolicy(),
      context: makeContext(),
      budget,
      finish,
      consumed: { dispatches: 0, role_rounds: 0, tokens: 0, tokens_missing: false },
      clock: NOW,
    };
    const outcome = await runRoleExecutionLoop(options);
    expect(outcome.status).toBe('completed');
    expect(outcome.zero_dispatch).toBe(true);
    expect(dispatch.calls).toHaveLength(0);
    expect(journal.finishInputs).toHaveLength(1);
  });
});
