/**
 * 阶段 2 四类预算控制器测试（RD-DIS-05 / RD-TRM-01；矩阵 DIS-05 / TRM-03 与 TRM-07 的预算部分）。
 *
 * 覆盖：
 * - dispatch / role 回合 / role token / 墙钟四类预算分别触限，抛带 code/actor 的
 *   `RoleTerminationError`（actor 恒为 host），并验证「恰好用完最后一次合法额度」不被拒绝；
 * - 墙钟用注入 clock 确定性跨过绝对 deadline（不 sleep）；
 * - `recordRound` durable 写 `role_round`：usage 缺失标 `tokens_missing` 且不带 token 数字，
 *   写失败转 `journal_write_failed` 且不把消费量记进内存；
 * - `foldRoleBudgetFacts` / `roleBudgetFactsFromLines`（生产/测试共用的唯一折叠算法）从真实
 *   Journal（关掉再开）的折叠记录与 `role_round` 行还原已消费量，restart 不清零、缺失 usage
 *   不补 0；
 * - 请求侧覆盖只能收紧（复用 `resolveRoleBudgetLimits`）；
 * - 取消/墙钟触限后 loop 不再启动后续 LLM/driver 调用（fake port 计数）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DispatchJournalEvidencePage,
  DispatchJournalFoldResult,
  DispatchJournalReadResult,
  JournalFinishAppendInput,
  JournalInitAppendInput,
  ReadDispatchEvidenceOptions,
  RoleRoundAppendInput,
} from '../../src/persistence';
import type { EvidenceRef } from '../../src/driver';
import { buildExecutionBrief, hashExecutionBrief } from '../../src/driver';
import { RunDispatchJournal } from '../../src/persistence';
import type {
  RoleBudgetConsumption,
  RoleBudgetLimits,
  RoleFrozenBudget,
  RoleJournalPort,
} from '../../src/app/role-autonomy-contract';
import {
  ROLE_BUDGET_DEFAULTS,
  RoleTerminationError,
  resolveRoleBudgetLimits,
} from '../../src/app/role-autonomy-contract';
import {
  emptyRoleBudgetConsumption,
  foldRoleBudgetFacts,
  roleBudgetFactsFromLines,
  RoleBudget,
  type RoleBudgetFacts,
} from '../../src/app/role-autonomy-budget';

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────

const IDENTITY = { run_id: 'run_budget', task_id: 'task_budget', role_id: 'role_budget' };
const START_MS = Date.parse('2026-11-13T12:00:00.000Z');
const ACCEPTED_AT = '2026-11-13T12:00:00.000Z';

const temporaryDirectories: string[] = [];
const openJournals: RunDispatchJournal[] = [];

afterEach(async () => {
  await Promise.all(
    openJournals.splice(0).map((journal) => journal.close().catch(() => undefined)),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function makeFrozen(overrides: Partial<RoleBudgetLimits> = {}): RoleFrozenBudget {
  const limits: RoleBudgetLimits = { ...ROLE_BUDGET_DEFAULTS, ...overrides };
  return {
    limits,
    deadline_at: new Date(START_MS + limits.wall_clock_seconds * 1_000).toISOString(),
  };
}

function legacyRead(): DispatchJournalReadResult {
  return {
    kind: 'legacy',
    status: 'absent',
    lines: [],
    entries: [],
    controls: [],
    repairs: [],
    problems: [],
    durability: { mode: 'fsync', directory_sync: true, notes: [] },
  };
}

function emptyFold(): DispatchJournalFoldResult {
  return {
    records: [],
    byDispatchId: new Map(),
    init: undefined,
    finish: undefined,
    repairs: [],
    entry_count: 0,
  };
}

interface FakeJournalOptions {
  appendRoleRound?: (input: RoleRoundAppendInput) => Promise<void>;
  read?: () => Promise<DispatchJournalReadResult>;
  fold?: () => Promise<DispatchJournalFoldResult>;
}

interface FakeJournal extends RoleJournalPort {
  roleRounds: RoleRoundAppendInput[];
}

function createFakeJournal(options: FakeJournalOptions = {}): FakeJournal {
  const roleRounds: RoleRoundAppendInput[] = [];
  return {
    roleRounds,
    read: options.read ?? (async () => legacyRead()),
    fold: options.fold ?? (async () => emptyFold()),
    appendInit: async (_input: JournalInitAppendInput) => undefined,
    appendFinish: async (_input: JournalFinishAppendInput) => undefined,
    appendRoleRound: async (input: RoleRoundAppendInput) => {
      roleRounds.push(input);
      await options.appendRoleRound?.(input);
    },
    registerEvidenceRef: async (_ref: EvidenceRef) => undefined,
    readEvidence: async (
      _ref: EvidenceRef,
      _options?: ReadDispatchEvidenceOptions,
    ): Promise<DispatchJournalEvidencePage> => {
      throw new Error('fake journal does not serve evidence');
    },
    getDispatchRecord: async (_dispatchId: string) => undefined,
  };
}

function makeBudget(
  overrides: Partial<RoleBudgetLimits> = {},
  options: FakeJournalOptions & { consumed?: RoleBudgetConsumption; clock?: () => Date } = {},
): { budget: RoleBudget; journal: FakeJournal } {
  const journal = createFakeJournal(options);
  // 所有未显式注入 clock 的用例都用固定 START_MS：预算测试不得依赖运行当天日期
  // （否则日期经过 deadline 后，所有断言会先触发 budget_wall_clock）。
  const clock = options.clock ?? (() => new Date(START_MS));
  const budget = new RoleBudget({
    frozen: makeFrozen(overrides),
    consumed: options.consumed ?? emptyRoleBudgetConsumption(),
    journal,
    clock,
  });
  return { budget, journal };
}

/** 断言是 typed termination 且 code/actor 精确匹配。 */
function expectTermination(error: unknown, code: string, actor: string): void {
  expect(error).toBeInstanceOf(RoleTerminationError);
  const termination = (error as RoleTerminationError).termination;
  expect(termination.code).toBe(code);
  expect(termination.actor).toBe(actor);
}

async function openJournal(): Promise<{ journal: RunDispatchJournal; runDir: string }> {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'newide-role-budget-'));
  temporaryDirectories.push(runDir);
  const journal = await RunDispatchJournal.open({ runDir, identity: IDENTITY });
  openJournals.push(journal);
  return { journal, runDir };
}

/**
 * 从真实 Journal 收集一个 Run 的预算事实：dispatches 取折叠记录数，role_round 行来自
 * `read().lines`（控制行筛选只在生产侧 `roleBudgetFactsFromLines` 维护一份）。
 */
async function readBudgetFacts(journal: RunDispatchJournal): Promise<RoleBudgetFacts> {
  const read = await journal.read();
  const fold = await journal.fold();
  return roleBudgetFactsFromLines(fold.records.length, read.lines);
}

async function appendInit(journal: RunDispatchJournal, frozen: RoleFrozenBudget): Promise<void> {
  await journal.appendInit({
    autonomy: true,
    evidence_only: false,
    buffer_v2: false,
    max_dispatches: frozen.limits.max_dispatches,
    max_role_rounds: frozen.limits.max_role_rounds,
    role_token_budget: frozen.limits.role_token_budget,
    deadline_at: frozen.deadline_at,
    engine: 'role_autonomy',
    engine_version: 'role-autonomy-v1',
    tool_allowlist: ['dispatch_execution', 'finish_task'],
    dispatch_timeout_ms: frozen.limits.dispatch_timeout_ms,
  });
}

async function appendAcceptedDispatch(journal: RunDispatchJournal): Promise<void> {
  const brief = buildExecutionBrief({
    identity: {
      dispatch_id: 'dispatch_1',
      run_id: IDENTITY.run_id,
      task_id: IDENTITY.task_id,
      role_id: IDENTITY.role_id,
      sequence: 1,
      accepted_at: ACCEPTED_AT,
    },
    request: { kind: 'execute', instruction: 'make the change' },
  }).brief;
  await journal.appendAccepted({
    brief,
    brief_sha256: hashExecutionBrief(brief),
    budget_before: {
      dispatches_left: 11,
      role_tokens_left: 100_000,
      deadline_at: '2026-11-13T12:45:00.000Z',
    },
  });
}

// ─────────────────────────────────────────────────────────────
// 四类预算触限
// ─────────────────────────────────────────────────────────────

describe('四类预算', () => {
  it('dispatch：12 次允许，第 13 次抛 budget_dispatches（host）', () => {
    const { budget } = makeBudget();
    for (let index = 0; index < ROLE_BUDGET_DEFAULTS.max_dispatches; index += 1) {
      budget.assertDispatchAllowed();
      budget.recordDispatch();
    }
    expect(budget.snapshot().consumed.dispatches).toBe(12);

    try {
      budget.assertDispatchAllowed();
      expect.unreachable('dispatch budget must throw at the 13th dispatch');
    } catch (error) {
      expectTermination(error, 'budget_dispatches', 'host');
    }
  });

  it('role 回合：40 回合允许，第 41 次抛 budget_rounds（host），role_round 逐回合 durable 落盘', async () => {
    const { budget, journal } = makeBudget();
    for (let round = 1; round <= ROLE_BUDGET_DEFAULTS.max_role_rounds; round += 1) {
      budget.assertRoundAllowed();
      await budget.recordRound(round, { input_tokens: 10, output_tokens: 5 }, ACCEPTED_AT);
    }
    expect(budget.snapshot().consumed.role_rounds).toBe(40);
    expect(journal.roleRounds).toHaveLength(40);
    expect(journal.roleRounds.at(-1)).toMatchObject({ round: 40, usage_missing: false });

    try {
      budget.assertRoundAllowed();
      expect.unreachable('round budget must throw at the 41st round');
    } catch (error) {
      expectTermination(error, 'budget_rounds', 'host');
    }
  });

  it('role token：已知 token 超限抛 budget_tokens；usage 缺失只标 missing，不做物理硬断言', async () => {
    const { budget, journal } = makeBudget({ role_token_budget: 100 });
    await budget.recordRound(1, { input_tokens: 80, output_tokens: 40 }, ACCEPTED_AT);
    expect(budget.snapshot().consumed.tokens).toBe(120);

    try {
      budget.assertTokenBudget();
      expect.unreachable('known token overflow must throw budget_tokens');
    } catch (error) {
      expectTermination(error, 'budget_tokens', 'host');
    }

    // usage 缺失：tokens_missing=true，token 不累加（不填 0），journal 行不带 token 数字。
    const missing = makeBudget({ role_token_budget: 100 });
    await missing.budget.recordRound(1, undefined, ACCEPTED_AT);
    const snapshot = missing.budget.snapshot();
    expect(snapshot.consumed).toMatchObject({ tokens: 0, tokens_missing: true });
    expect(() => missing.budget.assertTokenBudget()).not.toThrow();
    const recorded = missing.journal.roleRounds[0];
    expect(recorded).toMatchObject({ round: 1, usage_missing: true });
    expect(recorded).not.toHaveProperty('input_tokens');
    expect(recorded).not.toHaveProperty('output_tokens');

    // 恢复出来的缺失用量同样不补 0 参与求和。
    expect(journal.roleRounds[0]?.usage_missing).toBe(false);
  });

  it('墙钟：注入 clock 跨过绝对 deadline 后 assertRoundAllowed/assertDispatchAllowed 抛 budget_wall_clock', () => {
    let nowMs = START_MS;
    const { budget } = makeBudget({}, { clock: () => new Date(nowMs) });
    budget.assertRoundAllowed();
    expect(budget.snapshot().wall_clock_remaining_ms).toBe(
      ROLE_BUDGET_DEFAULTS.wall_clock_seconds * 1_000,
    );

    nowMs = START_MS + ROLE_BUDGET_DEFAULTS.wall_clock_seconds * 1_000;
    expect(budget.snapshot().wall_clock_remaining_ms).toBe(0);
    try {
      budget.assertRoundAllowed();
      expect.unreachable('wall clock must throw at the deadline');
    } catch (error) {
      expectTermination(error, 'budget_wall_clock', 'host');
    }
    try {
      budget.assertDispatchAllowed();
      expect.unreachable('wall clock must throw at the deadline for dispatches too');
    } catch (error) {
      expectTermination(error, 'budget_wall_clock', 'host');
    }
  });

  it('恰好用完上限后仍可收束：快照不因预算达到上限而拒绝', async () => {
    const { budget } = makeBudget({ max_role_rounds: 1, max_dispatches: 1 });
    budget.assertRoundAllowed();
    await budget.recordRound(1, undefined, ACCEPTED_AT);
    budget.assertDispatchAllowed();
    budget.recordDispatch();
    // 上限恰好用完：不得把「已用完」当成「越界」。
    expect(budget.snapshot().consumed).toMatchObject({ role_rounds: 1, dispatches: 1 });
  });
});

// ─────────────────────────────────────────────────────────────
// durable 写入与失败传播
// ─────────────────────────────────────────────────────────────

describe('任务级 tool-call 上限（TaskBudget.max_tool_calls）', () => {
  it('先 durable 记账、再在执行工具前抛 budget_tool_calls；恢复累加，不重新获得额度', async () => {
    const journal = createFakeJournal();
    const budget = new RoleBudget({
      frozen: { ...makeFrozen(), max_tool_calls: 1 },
      consumed: emptyRoleBudgetConsumption(),
      journal,
      clock: () => new Date(START_MS),
    });
    const error = await budget
      .recordRound(1, { input_tokens: 1, output_tokens: 1 }, ACCEPTED_AT, 2)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expectTermination(error, 'budget_tool_calls', 'host');
    expect(journal.roleRounds[0]).toMatchObject({ round: 1, tool_calls: 2 });

    // 恢复：role_round 行的 tool_calls 计入已消费，冻结上限不因 restart 放宽。
    const first = await openJournal();
    await appendInit(first.journal, makeFrozen());
    await first.journal.appendRoleRound({
      round: 1,
      usage_missing: true,
      tool_calls: 3,
      at: ACCEPTED_AT,
    });
    await first.journal.close();
    const second = await openJournalIn(first.runDir);
    const consumed = foldRoleBudgetFacts([await readBudgetFacts(second.journal)]);
    expect(consumed).toMatchObject({ dispatches: 0, role_rounds: 1, tool_calls: 3 });
    expect(consumed.tokens_missing).toBe(true);
    const restored = new RoleBudget({
      frozen: { ...makeFrozen(), max_tool_calls: 1 },
      consumed,
      journal: second.journal,
      clock: () => new Date(START_MS),
    });
    expect(restored.snapshot().consumed.tool_calls).toBe(3);
    const restoreError = await restored
      .recordRound(2, undefined, ACCEPTED_AT, 0)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expectTermination(restoreError, 'budget_tool_calls', 'host');
  });
});

describe('recordRound durable 写', () => {
  it('appendRoleRound 失败 → journal_write_failed（host），且消费量不前进', async () => {
    const { budget } = makeBudget(
      {},
      {
        appendRoleRound: async () => {
          throw new Error('disk full');
        },
      },
    );
    try {
      await budget.recordRound(1, { input_tokens: 3, output_tokens: 4 }, ACCEPTED_AT);
      expect.unreachable('journal write failure must terminate the loop');
    } catch (error) {
      expectTermination(error, 'journal_write_failed', 'host');
    }
    expect(budget.snapshot().consumed).toMatchObject({ role_rounds: 0, tokens: 0 });
  });

  it('非法回合号是宿主错误（host_failed），不写 journal', async () => {
    const { budget, journal } = makeBudget();
    await expect(
      budget.recordRound(0, { input_tokens: 1, output_tokens: 1 }, ACCEPTED_AT),
    ).rejects.toBeInstanceOf(RoleTerminationError);
    expect(journal.roleRounds).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 恢复不清零（真实 Journal，关掉再开）
// ─────────────────────────────────────────────────────────────

describe('foldRoleBudgetFacts / roleBudgetFactsFromLines（恢复不清零）', () => {
  it('从真实 Journal（关掉再开）的折叠记录与 role_round 行还原已消费量，restart 不清零', async () => {
    const frozen = makeFrozen();
    const first = await openJournal();
    await appendInit(first.journal, frozen);
    await appendAcceptedDispatch(first.journal);
    await first.journal.appendRoleRound({
      round: 1,
      input_tokens: 100,
      output_tokens: 50,
      usage_missing: false,
      at: ACCEPTED_AT,
    });
    await first.journal.appendRoleRound({ round: 2, usage_missing: true, at: ACCEPTED_AT });
    await first.journal.close();

    const second = await openJournalIn(first.runDir);
    const consumed = foldRoleBudgetFacts([await readBudgetFacts(second.journal)]);
    // 缺失 usage 的回合不被当成 0 计入 token，只标 tokens_missing。
    expect(consumed).toEqual({
      dispatches: 1,
      role_rounds: 2,
      tokens: 150,
      tool_calls: 0,
      tokens_missing: true,
    });

    // 恢复后上限检查必须基于还原值：max_role_rounds=2 时下一回合触限。
    const capped = new RoleBudget({
      frozen: makeFrozen({ max_role_rounds: 2 }),
      consumed,
      journal: second.journal,
      clock: () => new Date(START_MS),
    });
    try {
      capped.assertRoundAllowed();
      expect.unreachable('restored role rounds must not be reset to zero');
    } catch (error) {
      expectTermination(error, 'budget_rounds', 'host');
    }
  });

  it('祖先事实与当前 Run 事实按同一算法累加：dispatch/回合/token/tool_calls 都不清零', async () => {
    const parent = await openJournal();
    await appendInit(parent.journal, makeFrozen());
    await appendAcceptedDispatch(parent.journal);
    await parent.journal.appendRoleRound({
      round: 1,
      input_tokens: 10,
      output_tokens: 5,
      tool_calls: 2,
      usage_missing: false,
      at: ACCEPTED_AT,
    });
    await parent.journal.close();
    const parentReopened = await openJournalIn(parent.runDir);

    const child = await openJournal();
    await appendInit(child.journal, makeFrozen());
    await appendAcceptedDispatch(child.journal);
    await child.journal.appendRoleRound({
      round: 1,
      input_tokens: 100,
      output_tokens: 50,
      tool_calls: 1,
      usage_missing: false,
      at: ACCEPTED_AT,
    });
    await child.journal.appendRoleRound({ round: 2, usage_missing: true, at: ACCEPTED_AT });
    await child.journal.close();
    const childReopened = await openJournalIn(child.runDir);

    const consumed = foldRoleBudgetFacts([
      await readBudgetFacts(childReopened.journal),
      await readBudgetFacts(parentReopened.journal),
    ]);
    expect(consumed).toEqual({
      dispatches: 2,
      role_rounds: 2,
      tokens: 165,
      tool_calls: 3,
      tokens_missing: true,
    });
  });

  it('无 role_round 行时折叠为 0，而不是伪造消费', async () => {
    const frozen = makeFrozen();
    const { journal } = await openJournal();
    await appendInit(journal, frozen);
    const consumed = foldRoleBudgetFacts([await readBudgetFacts(journal)]);
    expect(consumed).toEqual(emptyRoleBudgetConsumption());
    // 全新 Journal 没有控制行 = 0 消费；不是「缺失 usage」。
    expect(consumed.tokens_missing).toBe(false);
  });
});

async function openJournalIn(runDir: string): Promise<{ journal: RunDispatchJournal }> {
  const journal = await RunDispatchJournal.open({ runDir, identity: IDENTITY });
  openJournals.push(journal);
  return { journal };
}

// ─────────────────────────────────────────────────────────────
// 请求侧只能收紧
// ─────────────────────────────────────────────────────────────

describe('resolveRoleBudgetLimits', () => {
  it('放大请求被忽略（取宿主上限），收紧请求生效，非法值返回 undefined', () => {
    expect(resolveRoleBudgetLimits({ max_dispatches: 100 })).toMatchObject({ max_dispatches: 12 });
    expect(resolveRoleBudgetLimits({ max_dispatches: 3 })).toMatchObject({ max_dispatches: 3 });
    expect(resolveRoleBudgetLimits({ wall_clock_seconds: 60 })).toMatchObject({
      wall_clock_seconds: 60,
    });
    expect(resolveRoleBudgetLimits({ max_dispatches: 0 })).toBeUndefined();
    expect(resolveRoleBudgetLimits({ max_dispatches: 1.5 })).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// loop 边界：取消/触限后不再启动后续调用
// ─────────────────────────────────────────────────────────────

describe('取消与触限后的调用边界', () => {
  it('取消后 loop 不再调用预算/LLM/dispatch（预算不吞 AbortSignal，由 loop 检查）', async () => {
    let nowMs = START_MS;
    const { budget } = makeBudget({}, { clock: () => new Date(nowMs) });
    const controller = new AbortController();
    const counts = { llm: 0, dispatch: 0 };

    // 最小 loop 形状：取消检查 → 回合/墙钟/token 检查 → LLM → recordRound → 派工检查。
    const runOneRound = async (signal: AbortSignal): Promise<void> => {
      if (signal.aborted) return;
      budget.assertRoundAllowed();
      budget.assertTokenBudget();
      counts.llm += 1;
      await budget.recordRound(counts.llm, { input_tokens: 1, output_tokens: 1 }, ACCEPTED_AT);
      budget.assertDispatchAllowed();
      counts.dispatch += 1;
      budget.recordDispatch();
    };

    await runOneRound(controller.signal);
    controller.abort();
    await runOneRound(controller.signal);
    expect(counts).toEqual({ llm: 1, dispatch: 1 });

    // 墙钟触限：下一次回合检查抛 typed termination，且不再有新的 LLM 调用。
    nowMs = START_MS + ROLE_BUDGET_DEFAULTS.wall_clock_seconds * 1_000;
    await expect(runOneRound(new AbortController().signal)).rejects.toBeInstanceOf(
      RoleTerminationError,
    );
    expect(counts).toEqual({ llm: 1, dispatch: 1 });
  });
});
