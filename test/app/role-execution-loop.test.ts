/**
 * role-execution-loop 行为测试：fake LLM + fake journal + fake dispatch port + fake 预算/finish 端口。
 *
 * 覆盖（阶段 2 矩阵 OWN-04/05、FIN-01/04/06、JRN-02、DIS-04、TRM 的 loop 侧）：
 * - 自主「调查→修改→验证失败→返工→验证→finish」、直接执行、先验证、无计划；
 * - driver 失败后继续、driver 成功后不自动结束、同回复双 dispatch 串行；
 * - finish 接受后剩余工具被拒绝（ROLE_ALREADY_FINISHED）、finish 被拒后继续；
 * - 纯文本（含完成词）不结束循环；零 dispatch 需显式 finish；
 * - 写屏障失败 / 预算触限 / 取消 / appendFinish 失败 → typed termination，不返回 outcome。
 *
 * 断言可观察事实：LLM 调用次数、dispatch 次数与顺序、sequence、journal finish/role_round 内容、
 * typed termination code，而不是固定步骤顺序。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionEvidence, ExecutionStatus } from '../../src/driver';

import type { ToolCall, ToolCallMessage, ToolDefinition } from '../../src/memory';
import type {
  RoleBudgetConsumption,
  RoleBudgetPort,
  RoleBudgetSnapshot,
  RoleDispatchObservation,
  RoleFinishDecision,
  RoleFrozenBudget,
  RoleFrozenPolicy,
  RoleLlmCompletion,
  RoleLlmPort,
  RoleLlmUsage,
  RoleLoopContextInput,
  RoleLoopOptions,
} from '../../src/app/role-autonomy-contract';
import {
  ROLE_BUDGET_DEFAULTS,
  ROLE_TOOL_NAMES,
  RoleTerminationError,
} from '../../src/app/role-autonomy-contract';
import { runRoleExecutionLoop } from '../../src/app/role-execution-loop';
import {
  FakeJournal,
  FakeMemory,
  FakeDispatchPort,
  FakeFinishValidator,
  type BarrierStage,
} from './role-autonomy-test-fixtures';

// ─────────────────────────────────────────────────────────────
// 夹具：冻结策略 / 上下文
// ─────────────────────────────────────────────────────────────

const FROZEN_BUDGET: RoleFrozenBudget = {
  limits: { ...ROLE_BUDGET_DEFAULTS },
  deadline_at: '2026-11-13T22:00:00.000Z',
};
const CLOCK = (): Date => new Date('2026-11-13T20:00:00.000Z');

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
    instruction: 'Fix the failing test in the workspace',
    response_only_allowed: true,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Fake LLM / Memory
// ─────────────────────────────────────────────────────────────

class FakeLlm implements RoleLlmPort {
  readonly calls: Array<{ messages: ToolCallMessage[]; tools: ToolDefinition[] }> = [];
  private readonly script: RoleLlmCompletion[];

  constructor(script: RoleLlmCompletion[]) {
    this.script = [...script];
  }

  async completeWithTools(input: {
    messages: ToolCallMessage[];
    tools: ToolDefinition[];
    signal?: AbortSignal;
  }): Promise<RoleLlmCompletion> {
    this.calls.push({
      messages: input.messages.map((message) => ({ ...message })),
      tools: input.tools,
    });
    const next = this.script.shift();
    if (next === undefined) throw new Error('FakeLlm: no scripted completion left');
    return next;
  }
}

// ─────────────────────────────────────────────────────────────
// Fake Journal / Dispatch
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Fake 预算 / finish 校验
// ─────────────────────────────────────────────────────────────

class FakeBudget implements RoleBudgetPort {
  readonly frozen: RoleFrozenBudget;
  readonly consumed: RoleBudgetConsumption;
  readonly rounds: Array<{ round: number; usage: RoleLlmUsage | undefined }> = [];
  roundChecks = 0;
  dispatchChecks = 0;
  maxRounds = Number.POSITIVE_INFINITY;
  maxDispatches = Number.POSITIVE_INFINITY;
  tokenExceeded = false;
  failRecordRound: Error | undefined;

  constructor(
    frozen: RoleFrozenBudget,
    private readonly journal: FakeJournal,
  ) {
    this.frozen = frozen;
    this.consumed = {
      dispatches: 0,
      role_rounds: 0,
      tokens: 0,
      tool_calls: 0,
      tokens_missing: false,
    };
  }

  snapshot(now?: Date): RoleBudgetSnapshot {
    return {
      frozen: this.frozen,
      consumed: { ...this.consumed },
      wall_clock_remaining_ms: Date.parse(this.frozen.deadline_at) - (now ?? CLOCK()).getTime(),
    };
  }

  assertRoundAllowed(): void {
    this.roundChecks += 1;
    if (this.roundChecks > this.maxRounds) {
      throw new RoleTerminationError({
        code: 'budget_rounds',
        actor: 'host',
        message: 'role round budget exhausted',
      });
    }
  }

  async recordRound(round: number, usage: RoleLlmUsage | undefined, at: string): Promise<void> {
    if (this.failRecordRound !== undefined) throw this.failRecordRound;
    this.rounds.push({ round, usage });
    this.consumed.role_rounds = round;
    if (usage === undefined) {
      this.consumed.tokens_missing = true;
      this.journal.roleRounds.push({ round, usage_missing: true, at });
      return;
    }
    this.consumed.tokens += usage.input_tokens + usage.output_tokens;
    this.journal.roleRounds.push({
      round,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      usage_missing: false,
      at,
    });
  }

  assertDispatchAllowed(): void {
    this.dispatchChecks += 1;
    if (this.consumed.dispatches >= this.maxDispatches) {
      throw new RoleTerminationError({
        code: 'budget_dispatches',
        actor: 'host',
        message: 'role dispatch budget exhausted',
      });
    }
  }

  recordDispatch(): void {
    this.consumed.dispatches += 1;
  }

  assertTokenBudget(): void {
    if (!this.tokenExceeded) return;
    throw new RoleTerminationError({
      code: 'budget_tokens',
      actor: 'host',
      message: 'role token budget exhausted',
    });
  }
}

// ─────────────────────────────────────────────────────────────
// 工具调用 / loop options 构造
// ─────────────────────────────────────────────────────────────

let callCounter = 0;

function toolCall(name: string, args: unknown): ToolCall {
  callCounter += 1;
  return {
    id: `call_${callCounter}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function completion(
  toolCalls: ToolCall[],
  content: string | null = null,
  usage?: RoleLlmUsage,
): RoleLlmCompletion {
  return {
    content,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    ...(usage !== undefined ? { usage } : {}),
  };
}

function dispatchCall(kind: 'investigate' | 'execute' | 'verify', instruction: string): ToolCall {
  return toolCall('dispatch_execution', { kind, instruction });
}

function finishCall(
  status: 'completed' | 'blocked' | 'failed',
  summary = 'task finished',
  extra: Record<string, unknown> = {},
): ToolCall {
  return toolCall('finish_task', { status, summary, ...extra });
}

interface Harness {
  options: RoleLoopOptions;
  llm: FakeLlm;
  journal: FakeJournal;
  dispatch: FakeDispatchPort;
  memory: FakeMemory;
  budget: FakeBudget;
  finish: FakeFinishValidator;
}

function makeHarness(input: {
  script: RoleLlmCompletion[];
  statuses?: ExecutionStatus[];
  barrierStages?: BarrierStage[];
  decisions?: RoleFinishDecision[];
  context?: Partial<RoleLoopContextInput>;
  policy?: Partial<RoleFrozenPolicy>;
  consumed?: Partial<RoleBudgetConsumption>;
  limits?: RoleLoopOptions['limits'];
  signal?: AbortSignal;
  clock?: () => Date;
}): Harness {
  const journal = new FakeJournal();
  const llm = new FakeLlm(input.script);
  const dispatch = new FakeDispatchPort(journal, input.statuses, input.barrierStages);
  const memory = new FakeMemory();
  const budget = new FakeBudget(FROZEN_BUDGET, journal);
  const finish = new FakeFinishValidator(input.decisions);
  const options: RoleLoopOptions = {
    llm,
    journal,
    dispatch,
    memory,
    policy: makePolicy(input.policy),
    context: makeContext(input.context),
    budget,
    finish,
    consumed: {
      dispatches: 0,
      role_rounds: 0,
      tokens: 0,
      tool_calls: 0,
      tokens_missing: false,
      ...input.consumed,
    },
    ...(input.limits !== undefined ? { limits: input.limits } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    clock: input.clock ?? CLOCK,
  };
  return { options, llm, journal, dispatch, memory, budget, finish };
}

function toolMessageContents(call: { messages: ToolCallMessage[] }): string[] {
  return call.messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.content ?? '');
}

function terminationOf(error: unknown): RoleTerminationError | undefined {
  return error instanceof RoleTerminationError ? error : undefined;
}

// ─────────────────────────────────────────────────────────────
// 主序列
// ─────────────────────────────────────────────────────────────

describe('runRoleExecutionLoop: 自主主序列', () => {
  it('调查→修改→验证失败→返工→验证→finish：5 次派工、6 回合、宿主不插入固定步骤', async () => {
    const harness = makeHarness({
      statuses: ['succeeded', 'succeeded', 'failed', 'succeeded', 'succeeded'],
      script: [
        completion([dispatchCall('investigate', 'locate the failing test')]),
        completion([dispatchCall('execute', 'fix the implementation')]),
        completion([dispatchCall('verify', 'run the test suite')]),
        completion([dispatchCall('execute', 'rework based on the failure')]),
        completion([dispatchCall('verify', 're-run the test suite')]),
        completion([finishCall('completed', 'fixed and verified')]),
      ],
    });

    const outcome = await runRoleExecutionLoop(harness.options);

    expect(outcome.status).toBe('completed');
    expect(outcome.zero_dispatch).toBe(false);
    expect(outcome.dispatches).toHaveLength(5);
    expect(outcome.dispatches.map((dispatch) => dispatch.status)).toEqual([
      'succeeded',
      'succeeded',
      'failed',
      'succeeded',
      'succeeded',
    ]);
    expect(outcome.usage.role_rounds).toBe(6);
    expect(outcome.plan).toBeUndefined();
    expect(harness.llm.calls).toHaveLength(6);
    // sequence 由宿主连续填写，不因失败/返工回退。
    expect(harness.dispatch.calls.map((call) => call.brief.sequence)).toEqual([1, 2, 3, 4, 5]);
    // 派工类型自由选择，宿主不强制顺序。
    expect(harness.dispatch.calls.map((call) => call.brief.kind)).toEqual([
      'investigate',
      'execute',
      'verify',
      'execute',
      'verify',
    ]);
    // finish 由 loop 写 journal（actor=role，含 summary/zero_dispatch）。
    expect(harness.journal.finishInputs).toHaveLength(1);
    expect(harness.journal.finishInputs[0]).toMatchObject({
      actor: 'role',
      status: 'completed',
      summary: 'fixed and verified',
      zero_dispatch: false,
    });
    // 每回合都 durable 写了 role_round（缺失 usage 标 missing，不填 0）。
    expect(harness.journal.roleRounds).toHaveLength(6);
    expect(harness.journal.roleRounds.every((round) => round.usage_missing)).toBe(true);
    expect(outcome.usage.usage_missing).toBe(true);
  });

  it('直接执行：一次 execute 派工后 finish；driver succeeded 不自动结束', async () => {
    const harness = makeHarness({
      statuses: ['succeeded'],
      script: [
        completion([dispatchCall('execute', 'apply the fix')]),
        completion([dispatchCall('execute', 'double-check the diff')]),
        completion([finishCall('completed')]),
      ],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.status).toBe('completed');
    expect(outcome.dispatches).toHaveLength(2);
    // 第一次派工成功之后 loop 仍继续（LLM 被调用了 3 次），没有自动结束。
    expect(harness.llm.calls).toHaveLength(3);
  });

  it('先验证：role 可以先派 verify 再 finish', async () => {
    const harness = makeHarness({
      statuses: ['succeeded'],
      script: [
        completion([dispatchCall('verify', 'run the tests before touching code')]),
        completion([finishCall('blocked', 'nothing to change')]),
      ],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.status).toBe('blocked');
    expect(harness.dispatch.calls[0]?.brief.kind).toBe('verify');
    expect(harness.journal.finishInputs[0]?.status).toBe('blocked');
  });

  it('driver 失败后 role 能继续决策', async () => {
    const harness = makeHarness({
      statuses: ['failed', 'succeeded'],
      script: [
        completion([dispatchCall('execute', 'first attempt')]),
        completion([dispatchCall('execute', 'second attempt after failure')]),
        completion([finishCall('completed')]),
      ],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.status).toBe('completed');
    expect(outcome.dispatches.map((dispatch) => dispatch.status)).toEqual(['failed', 'succeeded']);
    expect(harness.llm.calls).toHaveLength(3);
  });

  it('同一回复里的两个 dispatch 串行执行且 sequence 连续', async () => {
    const harness = makeHarness({
      statuses: ['succeeded', 'succeeded'],
      script: [
        completion([
          dispatchCall('execute', 'first dispatch in the same reply'),
          dispatchCall('verify', 'second dispatch in the same reply'),
        ]),
        completion([finishCall('completed')]),
      ],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.dispatches).toHaveLength(2);
    expect(harness.dispatch.maxActive).toBe(1);
    expect(harness.dispatch.calls.map((call) => call.brief.sequence)).toEqual([1, 2]);
    expect(harness.dispatch.calls[0]?.brief.kind).toBe('execute');
    expect(harness.dispatch.calls[1]?.brief.kind).toBe('verify');
  });

  it('update_plan 保存计划并回显，但不计为派工', async () => {
    const harness = makeHarness({
      script: [
        completion([toolCall('update_plan', { plan: '1) inspect 2) fix 3) verify' })]),
        completion([finishCall('completed')]),
      ],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.plan).toBe('1) inspect 2) fix 3) verify');
    expect(outcome.dispatches).toHaveLength(0);
    expect(harness.dispatch.calls).toHaveLength(0);
    expect(outcome.zero_dispatch).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// finish 语义
// ─────────────────────────────────────────────────────────────

describe('runRoleExecutionLoop: finish 语义', () => {
  it('finish 被拒后把 gaps 交还 role 继续，下一次 finish 接受', async () => {
    const harness = makeHarness({
      decisions: [
        {
          accepted: false,
          gaps: [{ code: 'evidence_source_insufficient', message: 'missing host-observed check' }],
        },
      ],
      script: [completion([finishCall('completed')]), completion([finishCall('completed')])],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.status).toBe('completed');
    expect(harness.llm.calls).toHaveLength(2);
    // 第二次 LLM 调用能看到第一次 finish 的拒绝结果。
    const secondCallToolContents = toolMessageContents(
      harness.llm.calls[1] as { messages: ToolCallMessage[] },
    );
    expect(secondCallToolContents).toHaveLength(1);
    expect(secondCallToolContents[0]).toContain('ROLE_FINISH_REJECTED');
    expect(secondCallToolContents[0]).toContain('evidence_source_insufficient');
    expect(harness.journal.finishInputs).toHaveLength(1);
  });

  it('finish 接受后同一回复的剩余 dispatch 不再执行', async () => {
    const harness = makeHarness({
      script: [
        completion([
          finishCall('completed', 'no execution needed'),
          dispatchCall('execute', 'must not run after finish'),
        ]),
      ],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.status).toBe('completed');
    expect(harness.dispatch.calls).toHaveLength(0);
    expect(harness.llm.calls).toHaveLength(1);
    expect(outcome.zero_dispatch).toBe(true);
  });

  it('纯文本（含完成词）不结束循环，零派工仍需 finish_task', async () => {
    const harness = makeHarness({
      script: [
        completion([], 'done! task complete.'),
        completion([], 'all finished, nothing else to do'),
        completion([finishCall('completed', 'answered')]),
      ],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.status).toBe('completed');
    expect(harness.llm.calls).toHaveLength(3);
    expect(harness.dispatch.calls).toHaveLength(0);
    expect(outcome.zero_dispatch).toBe(true);
    // 最终答复 = 已接受 finish 的 summary，而不是此前调查阶段的正文。
    expect(outcome.response).toBe('answered');
  });

  it('零 dispatch 的答复类任务可用 response_only 完成，且不伪造执行', async () => {
    const harness = makeHarness({
      script: [completion([finishCall('completed', 'answered directly', { response_only: true })])],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.zero_dispatch).toBe(true);
    expect(outcome.finish.response_only).toBe(true);
    expect(outcome.dispatches).toHaveLength(0);
    expect(harness.dispatch.calls).toHaveLength(0);
    expect(harness.journal.finishInputs[0]).toMatchObject({
      response_only: true,
      zero_dispatch: true,
      actor: 'role',
    });
    // finish 校验端口收到的 cancelled=false、dispatches 为空。
    expect(harness.finish.inputs[0]?.cancelled).toBe(false);
    expect(harness.finish.inputs[0]?.dispatches).toHaveLength(0);
  });

  it('finish 由唯一入口 persistRoleFinish 落盘：verification 原样写行、zero_dispatch 由 loop 显式给出', async () => {
    const harness = makeHarness({
      script: [
        completion([
          finishCall('completed', 'verified by role', {
            verification: [
              {
                requirement: 'the unit test passes',
                outcome: 'not_run',
                note: 'host did not run checks in this fake loop',
              },
              {
                requirement: 'the fix is applied',
                outcome: 'passed',
                dispatch_ids: ['dsp_self_reported'],
              },
            ],
          }),
        ]),
      ],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.status).toBe('completed');
    expect(outcome.finish.verification.map((claim) => claim.outcome)).toEqual([
      'not_run',
      'passed',
    ]);
    const finishRow = harness.journal.finishInputs[0];
    if (finishRow === undefined) throw new Error('expected a finish row');
    // 唯一生产入口写入的 finish 行：verification 是唯一完成陈述；zero_dispatch 由 loop 用
    // 「恢复前派工数 + 本次派工数」显式给出，persistRoleFinish 不再二次推断。
    expect(finishRow).toMatchObject({
      actor: 'role',
      status: 'completed',
      zero_dispatch: true,
      at: '2026-11-13T20:00:00.000Z',
      verification: [
        {
          requirement: 'the unit test passes',
          outcome: 'not_run',
          dispatch_ids: [],
          evidence_refs: [],
          note: 'host did not run checks in this fake loop',
        },
        {
          requirement: 'the fix is applied',
          outcome: 'passed',
          dispatch_ids: ['dsp_self_reported'],
          evidence_refs: [],
        },
      ],
    });
    // 精简后的完成语义：finish 行没有 checks/criterion/command/clause/target_paths 字段。
    for (const removed of ['checks', 'criterion', 'command', 'clause', 'target_paths']) {
      expect(finishRow).not.toHaveProperty(removed);
    }
    // entry_id 由内容派生（同一记录重复持久化是幂等写重试）。
    expect(finishRow.entry_id).toMatch(/^jrn_finish_[a-f0-9]{48}$/);
  });

  it('未收束的 unknown dispatch 进入 outcome.unresolved_dispatches（不伪造成功）', async () => {
    const harness = makeHarness({
      statuses: ['unknown'],
      script: [
        completion([dispatchCall('execute', 'might have side effects')]),
        completion([finishCall('blocked', 'side effect state unknown')]),
      ],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.status).toBe('blocked');
    expect(outcome.dispatches[0]?.status).toBe('unknown');
    expect(outcome.unresolved_dispatches).toHaveLength(1);
    expect(outcome.unresolved_dispatches[0]).toBe(outcome.dispatches[0]?.dispatch_id);
  });
});

// ─────────────────────────────────────────────────────────────
// typed termination：写屏障 / 预算 / 取消 / journal 写失败
// ─────────────────────────────────────────────────────────────

describe('runRoleExecutionLoop: typed termination', () => {
  it('evidence 写屏障失败 → evidence_write_failed，不返回 outcome', async () => {
    const harness = makeHarness({
      barrierStages: ['evidence'],
      script: [completion([dispatchCall('execute', 'apply change')])],
    });
    const error = await runRoleExecutionLoop(harness.options).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const termination = terminationOf(error);
    expect(termination?.termination).toMatchObject({
      code: 'evidence_write_failed',
      actor: 'host',
    });
    expect(termination?.termination.details).toMatchObject({ stage: 'evidence' });
    expect(harness.journal.finishInputs).toHaveLength(0);
  });

  it('accepted 写屏障失败 → journal_write_failed', async () => {
    const harness = makeHarness({
      barrierStages: ['accepted'],
      script: [completion([dispatchCall('execute', 'apply change')])],
    });
    const error = await runRoleExecutionLoop(harness.options).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(terminationOf(error)?.termination.code).toBe('journal_write_failed');
  });

  it('回合预算触限 → budget_rounds，且不再调用 LLM', async () => {
    const harness = makeHarness({
      script: [completion([], 'still thinking')],
    });
    // FakeBudget 以 assertRoundAllowed 的调用次数模拟回合上限；loop 还会在记忆召回前
    // 做一次「恢复后额度已耗尽」的预检查，所以这里允许一次真实 LLM 回合。
    harness.budget.maxRounds = 2;
    const error = await runRoleExecutionLoop(harness.options).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(terminationOf(error)?.termination.code).toBe('budget_rounds');
    expect(harness.llm.calls).toHaveLength(1);
  });

  it('派工预算触限 → budget_dispatches，不调用 dispatch', async () => {
    const harness = makeHarness({
      script: [completion([dispatchCall('execute', 'too many')])],
    });
    harness.budget.maxDispatches = 0;
    const error = await runRoleExecutionLoop(harness.options).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(terminationOf(error)?.termination.code).toBe('budget_dispatches');
    expect(harness.dispatch.calls).toHaveLength(0);
  });

  it('token 预算触限 → budget_tokens（由注入的预算端口判定）', async () => {
    const harness = makeHarness({
      script: [completion([], 'thinking')],
    });
    harness.budget.tokenExceeded = true;
    const error = await runRoleExecutionLoop(harness.options).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(terminationOf(error)?.termination.code).toBe('budget_tokens');
  });

  it('取消（AbortSignal）→ actor=user，不调用 LLM/driver', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = makeHarness({
      script: [],
      signal: controller.signal,
    });
    const error = await runRoleExecutionLoop(harness.options).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(terminationOf(error)?.termination).toMatchObject({ actor: 'user' });
    expect(harness.llm.calls).toHaveLength(0);
    expect(harness.dispatch.calls).toHaveLength(0);
  });

  it('appendFinish 失败 → journal_write_failed', async () => {
    const harness = makeHarness({
      script: [completion([finishCall('completed')])],
    });
    harness.journal.failAppendFinish = new Error('disk full');
    const error = await runRoleExecutionLoop(harness.options).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(terminationOf(error)?.termination).toMatchObject({
      code: 'journal_write_failed',
      actor: 'host',
    });
  });

  it('recordRound 的 journal 写失败由预算端口抛 journal_write_failed，loop 不吞', async () => {
    const harness = makeHarness({ script: [completion([], 'thinking')] });
    harness.budget.failRecordRound = new RoleTerminationError({
      code: 'journal_write_failed',
      actor: 'host',
      message: 'role_round write failed',
    });
    const error = await runRoleExecutionLoop(harness.options).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(terminationOf(error)?.termination.code).toBe('journal_write_failed');
  });

  it('冻结策略非法（引擎不是 role_autonomy）→ host_failed，不调用 LLM', async () => {
    const harness = makeHarness({
      policy: { engine: 'legacy' as unknown as 'role_autonomy' },
      script: [],
    });
    const error = await runRoleExecutionLoop(harness.options).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(terminationOf(error)?.termination).toMatchObject({
      code: 'host_failed',
      actor: 'host',
    });
    expect(harness.llm.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 首轮上下文 / usage / 限制
// ─────────────────────────────────────────────────────────────

describe('runRoleExecutionLoop: 首轮上下文与限制', () => {
  it('首轮上下文包含指令、自动召回与冻结预算；工具表只有 5 个允许工具', async () => {
    const harness = makeHarness({
      context: { frozen_driver_id: 'driver_alpha', confirmed_session_id: 'session_1' },
      script: [completion([finishCall('completed')])],
    });
    await runRoleExecutionLoop(harness.options);
    const firstCall = harness.llm.calls[0];
    expect(firstCall?.tools.map((tool) => tool.function.name)).toEqual([...ROLE_TOOL_NAMES]);
    const systemPrompt = firstCall?.messages[0]?.content ?? '';
    expect(systemPrompt).toContain('Fix the failing test in the workspace');
    expect(systemPrompt).toContain('RECALLED: use the existing helper');
    expect(systemPrompt).toContain('max_dispatches=12');
    expect(systemPrompt).toContain('driver_alpha');
    expect(systemPrompt).toContain('session_1');
    expect(firstCall?.messages[1]?.content).toBe('Fix the failing test in the workspace');
    // 自动召回只发生在首轮之前（不是每回合）。
    expect(harness.memory.recallCalls).toHaveLength(1);
    expect(harness.memory.recallCalls[0]).toMatchObject({
      task_id: 'task_1',
      run_id: 'run_1',
      role_id: 'role_1',
    });
  });

  it('NEWIDE_ROLE_TIME_BLIND=1 时系统提示不写 deadline，其他冻结预算照常', async () => {
    const previous = process.env.NEWIDE_ROLE_TIME_BLIND;
    process.env.NEWIDE_ROLE_TIME_BLIND = '1';
    try {
      const harness = makeHarness({ script: [completion([finishCall('completed')])] });
      await runRoleExecutionLoop(harness.options);
      const systemPrompt = harness.llm.calls[0]?.messages[0]?.content ?? '';
      expect(systemPrompt).toContain('max_dispatches=12');
      expect(systemPrompt).not.toContain('deadline_at=');
    } finally {
      if (previous === undefined) delete process.env.NEWIDE_ROLE_TIME_BLIND;
      else process.env.NEWIDE_ROLE_TIME_BLIND = previous;
    }
  });

  it('usage 缺失只标 missing，不填 0；有 usage 时累计 token', async () => {
    const harness = makeHarness({
      script: [
        completion([], 'first', { input_tokens: 10, output_tokens: 5 }),
        completion([finishCall('completed')]),
      ],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.usage.input_tokens).toBe(10);
    expect(outcome.usage.output_tokens).toBe(5);
    expect(outcome.usage.usage_missing).toBe(true);
    expect(harness.journal.roleRounds[0]).toMatchObject({
      round: 1,
      input_tokens: 10,
      output_tokens: 5,
      usage_missing: false,
    });
    expect(harness.journal.roleRounds[1]).toMatchObject({ round: 2, usage_missing: true });
    expect(harness.journal.roleRounds[1]?.input_tokens).toBeUndefined();
  });

  it('工具结果按 tool_result_chars 截断并打标记', async () => {
    const harness = makeHarness({
      limits: { tool_result_chars: 300, history_messages: 40 },
      script: [
        completion([toolCall('query_memory', { query: 'large result' })]),
        completion([], 'thinking'),
        completion([finishCall('completed')]),
      ],
    });
    harness.memory.query = async () => ({
      text: 'x'.repeat(5_000),
      count: 1,
    });
    await runRoleExecutionLoop(harness.options);
    const toolContents = toolMessageContents(
      harness.llm.calls[1] as { messages: ToolCallMessage[] },
    );
    expect(toolContents).toHaveLength(1);
    expect((toolContents[0] ?? '').length).toBeLessThanOrEqual(300);
    expect(toolContents[0]).toContain('truncated');
  });

  it('恢复时 consumed.role_rounds 作为回合起点，不清零', async () => {
    const harness = makeHarness({
      consumed: { dispatches: 2, role_rounds: 5, tokens: 100, tokens_missing: false },
      script: [completion([finishCall('completed')])],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.usage.role_rounds).toBe(6);
    expect(harness.journal.roleRounds[0]?.round).toBe(6);
    // 新回合的 token 只累计本次，不把恢复 token 冒充成输入/输出。
    expect(outcome.usage.input_tokens).toBe(0);
    expect(outcome.usage.output_tokens).toBe(0);
  });
});
function makeObservation(dispatchId: string, status: ExecutionStatus): RoleDispatchObservation {
  return {
    dispatch_id: dispatchId,
    status,
    evidence: {
      status,
      transport: { evidence: 'execution_unconfirmed', result_received: status !== 'unknown' },
    } as unknown as ExecutionEvidence,
    evidence_ref: { path: `journal/evidence/${dispatchId}.json`, sha256: 'a'.repeat(64) },
    evidence_sha256: 'a'.repeat(64),
    violations: [],
    attempts: 1,
  };
}

describe('复审修复：最终答复 / 在途取消与墙钟 / 恢复真实工作', () => {
  it('content=null + finish_task(summary)：最终 response 使用已接受 finish 的 summary', async () => {
    const harness = makeHarness({
      script: [
        { content: null, tool_calls: [finishCall('completed', 'final answer from summary')] },
      ],
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.response).toBe('final answer from summary');
    expect(outcome.finish.summary).toBe('final answer from summary');
    expect(harness.journal.finishInputs[0]).toMatchObject({
      status: 'completed',
      summary: 'final answer from summary',
    });
  });

  it('恢复前已有派工：zero_dispatch=false，finish 记录与派工列表包含恢复前真实工作', async () => {
    const recovered = makeObservation('dsp_recovered', 'succeeded');
    const harness = makeHarness({
      script: [completion([finishCall('completed')])],
      context: {
        recovered_dispatch_count: 1,
        recovered_dispatches: [recovered],
        recovered_unresolved_dispatches: [],
      },
    });
    const outcome = await runRoleExecutionLoop(harness.options);
    expect(outcome.zero_dispatch).toBe(false);
    expect(outcome.dispatches.map((dispatch) => dispatch.dispatch_id)).toContain('dsp_recovered');
    expect(harness.journal.finishInputs[0]?.zero_dispatch).toBe(false);
    // 未给 verification 时写空数组（不是 undefined，也不是旧 checks 形状）。
    expect(harness.journal.finishInputs[0]?.verification).toEqual([]);
  });

  it('LLM 挂起时总墙钟 deadline 仍停止等待：budget_wall_clock，且迟到 rejection 不泄漏', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness({ script: [] });
      const hanging = new Promise<never>(() => undefined);
      harness.options.llm = {
        completeWithTools: async () => hanging,
      };
      // 立即挂 rejection 处理器：定时器触发时 run 可能先 reject，不能留下未处理 rejection。
      const run = runRoleExecutionLoop(harness.options).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);
      const error = await run;
      expect(error).toBeInstanceOf(RoleTerminationError);
      expect((error as RoleTerminationError).termination.code).toBe('budget_wall_clock');
    } finally {
      vi.useRealTimers();
    }
  });

  it('记忆召回挂起时用户取消：host_cancelled，不启动 LLM，迟到 rejection 被消费', async () => {
    const controller = new AbortController();
    const harness = makeHarness({ script: [] });
    harness.options.signal = controller.signal;
    harness.memory.recall = async () =>
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error('late recall rejection after cancel'));
        });
      });
    const run = runRoleExecutionLoop(harness.options);
    await Promise.resolve();
    controller.abort();
    const error = await run.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RoleTerminationError);
    expect((error as RoleTerminationError).termination).toMatchObject({
      code: 'host_cancelled',
      actor: 'user',
    });
    expect(harness.llm.calls).toHaveLength(0);
  });
});
