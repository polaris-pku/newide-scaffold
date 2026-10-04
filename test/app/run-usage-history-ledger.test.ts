/**
 * 账本支撑的历史读路径 + 目录回填。
 *
 * 这一组里最要紧的一条是「run 目录被删掉之后累计还在」——那正是把历史从「扫目录重算」
 * 换成「读账本」的全部理由。其余守的是回填的边界：幂等、缺 `task_id` 跳过、不碰上下文
 * 占用、失败不缓存。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backfillTokenUsageLedger,
  LedgerRunUsageHistoryReader,
} from '../../src/app/run-usage-history';
import {
  SqliteCoordinationStore,
  TOKEN_USAGE_LEDGER_SCHEMA_VERSION,
  type CoordinationStateCommit,
  type TokenUsageLedgerEntry,
  type TokenUsageLedgerStore,
} from '../../src/persistence';
import type { RunUsageTokens } from '../../src/protocol/run-snapshot';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRunsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'usage-ledger-'));
  tempDirs.push(root);
  return root;
}

function tokens(total: number, callCount = 1): RunUsageTokens {
  return {
    input_tokens: total,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: total,
    total_tokens: total,
    call_count: callCount,
  };
}

/**
 * 播一个**确实开跑过**的 run：`handler.started` 由 `startStage` 写出、早于任何 executor，
 * 所以它是「执行过」的持久判据——账本的缺口统计正是靠它。
 */
function seedExecutedRun(store: SqliteCoordinationStore, run_id: string, task_id: string): void {
  const event = (suffix: string, event_type: string) => ({
    event_id: `${run_id}_${suffix}`,
    event_type,
    subject_id: task_id,
    run_id,
    task_id,
    payload: {},
    created_at: 'T',
    schema_version: 'v0',
  });
  store.commitState({
    task: {
      task_id,
      status: 'created',
      risk_level: 'medium',
      spec: 'usage reader test',
      completion_criteria: ['x'],
      affected_paths: ['src/**'],
      workspace_path: '/workspace',
      warnings: [],
      revision: 1,
      created_at: 'T',
      updated_at: 'T',
      schema_version: 'v0',
    },
    run: {
      run_id,
      task_id,
      status: 'created',
      mode: 'single_agent',
      workspace_path: '/workspace',
      revision: 1,
      created_at: 'T',
      updated_at: 'T',
      schema_version: 'v0',
    },
    runtime_state: {
      task_id,
      current_run_id: run_id,
      resume_cursor: 'select_agent',
      waiting_on: [],
      artifact_refs: [],
      diagnostics: {},
      updated_at: 'T',
      schema_version: 'v0',
    },
    events: [
      event('created', 'task.created'),
      event('started', 'handler.started'),
    ],
  } as CoordinationStateCommit);
}

function appendLedgerRow(
  store: SqliteCoordinationStore,
  spec: {
    run_id: string;
    task_id: string;
    total: number;
    source?: TokenUsageLedgerEntry['source'];
    role_id?: string;
  },
): void {
  store.appendTokenUsage([
    {
      run_id: spec.run_id,
      task_id: spec.task_id,
      role_id: spec.role_id ?? 'role_a',
      source: spec.source ?? 'proxy',
      metric: 'billed_tokens',
      recorded_at: 'T',
      schema_version: TOKEN_USAGE_LEDGER_SCHEMA_VERSION,
      ...tokens(spec.total),
    },
  ]);
}

interface SummarySpec {
  run_id: string;
  task_id?: string;
  proxy?: number;
  driverLeg?: number;
  /** 写一个**全是 0** 的 `token_usage`：它与「根本没有这个键」都必须算**缺席**。 */
  zeroUsage?: boolean;
  driverSessions?: Array<{ session_id: string; role_id?: string; total: number }>;
  contextOnlySessions?: Array<{ session_id: string; role_id: string; context_tokens_used: number }>;
}

async function writeRun(runsRoot: string, spec: SummarySpec): Promise<void> {
  const runDir = path.join(runsRoot, spec.run_id);
  await mkdir(runDir, { recursive: true });
  const bySource: Record<string, unknown> = {};
  if (spec.proxy) bySource.proxy = tokens(spec.proxy);
  if (spec.driverLeg) bySource.claude_session_jsonl = tokens(spec.driverLeg);
  await writeFile(
    path.join(runDir, 'summary.json'),
    JSON.stringify({
      run_id: spec.run_id,
      ...(spec.task_id === undefined ? {} : { task_id: spec.task_id }),
      ...(Object.keys(bySource).length > 0 || spec.zeroUsage
        ? {
            token_usage: {
              schema_version: 'newide.token_usage.v1',
              source: 'mixed',
              // 顶层合计 = 各 source 桶之和（实测 186 份真实 summary、7 个字段无一例外）。
              // 这条不变量正是「账本按行求和」与「summary 顶层」给出同一个数的前提；造一个
              // 违反它的替身会让兜底路径与回填路径**看起来**不同值——那是替身的缺陷，
              // 不是产品的。
              ...tokens(
                (spec.proxy ?? 0) + (spec.driverLeg ?? 0),
                (spec.proxy ? 1 : 0) + (spec.driverLeg ? 1 : 0),
              ),
              sources: Object.keys(bySource),
              by_source: bySource,
            },
          }
        : {}),
      ...(spec.driverSessions
        ? {
            driver_billed_usage: {
              source: 'claude_session_jsonl',
              metric: 'billed_tokens',
              sessions: spec.driverSessions.map((session) => ({
                session_id: session.session_id,
                ...(session.role_id ? { role_id: session.role_id } : {}),
                ...tokens(session.total),
              })),
            },
          }
        : {}),
      ...(spec.contextOnlySessions
        ? {
            driver_context_usage: {
              available: true,
              metric: 'context_tokens_used',
              sessions: spec.contextOnlySessions,
            },
          }
        : {}),
    }),
    'utf8',
  );
}

describe('backfillTokenUsageLedger', () => {
  it('is idempotent so a process restart cannot double count', async () => {
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, { run_id: 'run_1', task_id: 'task_1', proxy: 100, driverLeg: 250 });
    const ledger = new SqliteCoordinationStore(':memory:');

    const first = await backfillTokenUsageLedger(runsRoot, ledger, 'T');
    const afterFirst = ledger.aggregateTokenUsage({ scope: 'system' }, 'T').totals.total_tokens;
    const second = await backfillTokenUsageLedger(runsRoot, ledger, 'T');

    expect(first.rows_written).toBeGreaterThan(0);
    expect(ledger.aggregateTokenUsage({ scope: 'system' }, 'T').totals.total_tokens).toBe(
      afterFirst,
    );
    // 第二次**一行都不该写**。只断言「总量没变」是不够的：重复写一条主键相同但 role_id
    // 不同的行会同时改变总量，而这里正是要钉住那条路径没有发生。
    expect(second.rows_written).toBe(0);
    expect(second.runs_already_in_ledger).toBe(1);
    ledger.close();
  });

  it('does not double count a run the live path already wrote with role attribution', async () => {
    // 这条是上面的补集，也是实测抓到的那条：存活期写入的 proxy 行带真实 `role_id`，
    // 回填写的是未归属哨兵（`role_id = ''`），两者主键不同——于是「再回填一次」不是覆盖
    // 而是**新增一行**，同一个 run 的 proxy 腿被算成两倍（110 → 220）。触发条件正是最常见
    // 的那个：跑完一个 run 之后重启后端，第一次读历史就回填整棵目录树。
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, { run_id: 'run_1', task_id: 'task_1', proxy: 110 });
    const ledger = new SqliteCoordinationStore(':memory:');
    appendLedgerRow(ledger, { run_id: 'run_1', task_id: 'task_1', total: 110, role_id: 'role_a' });

    expect(
      ledger.aggregateTokenUsage({ scope: 'run', scope_id: 'run_1' }, 'T').totals.total_tokens,
    ).toBe(110);

    const result = await backfillTokenUsageLedger(runsRoot, ledger, 'T');

    const after = ledger.aggregateTokenUsage({ scope: 'run', scope_id: 'run_1' }, 'T');
    expect(after.totals.total_tokens).toBe(110);
    expect(after.by_source.proxy?.call_count).toBe(1);
    expect(result.rows_written).toBe(0);
    expect(result.runs_already_in_ledger).toBe(1);
    ledger.close();
  });

  it('fills only the leg the ledger is missing', async () => {
    // 判据是**腿**而不是 run：已经在账本里的那条腿不补，缺的那条补上。
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, { run_id: 'run_1', task_id: 'task_1', proxy: 100, driverLeg: 250 });
    const ledger = new SqliteCoordinationStore(':memory:');
    // 存活期只写下了 proxy 腿（driver 腿要等收尾后从 session JSONL 刮出来，可能缺席）。
    appendLedgerRow(ledger, { run_id: 'run_1', task_id: 'task_1', total: 100 });

    const result = await backfillTokenUsageLedger(runsRoot, ledger, 'T');

    const run = ledger.aggregateTokenUsage({ scope: 'run', scope_id: 'run_1' }, 'T');
    expect(run.by_source.proxy?.total_tokens).toBe(100);
    expect(run.by_source.claude_session_jsonl?.total_tokens).toBe(250);
    expect(result.rows_written).toBe(1);
    expect(result.runs_already_in_ledger).toBe(1);
    ledger.close();
  });

  it('skips a run whose summary has no task_id, because the ledger column is NOT NULL', async () => {
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, { run_id: 'run_ok', task_id: 'task_1', proxy: 100 });
    await writeRun(runsRoot, { run_id: 'run_orphan', proxy: 999 });

    const ledger = new SqliteCoordinationStore(':memory:');
    const result = await backfillTokenUsageLedger(runsRoot, ledger, 'T');

    expect(result.runs_scanned).toBe(2);
    expect(result.runs_skipped_without_task_id).toBe(1);
    // 被跳过的那个 run 的 999 不参与任何求和——不折算成 0，也不静默计入。
    expect(ledger.aggregateTokenUsage({ scope: 'system' }, 'T').totals.total_tokens).toBe(100);
    ledger.close();
  });

  it('never treats driver_context_usage occupancy as billed tokens', async () => {
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, {
      run_id: 'run_ctx',
      task_id: 'task_1',
      proxy: 50,
      contextOnlySessions: [
        { session_id: 'session_a', role_id: 'role_a', context_tokens_used: 123_456 },
      ],
    });

    const ledger = new SqliteCoordinationStore(':memory:');
    await backfillTokenUsageLedger(runsRoot, ledger, 'T');
    const aggregate = ledger.aggregateTokenUsage({ scope: 'system' }, 'T');

    expect(aggregate.totals.total_tokens).toBe(50);
    expect(aggregate.by_source.claude_session_jsonl).toBeUndefined();
    ledger.close();
  });

  it('attributes the driver leg by role but leaves the backfilled proxy leg unattributed', async () => {
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, {
      run_id: 'run_1',
      task_id: 'task_1',
      proxy: 100,
      driverLeg: 750,
      driverSessions: [
        { session_id: 'session_a', role_id: 'role_a', total: 450 },
        { session_id: 'session_b', role_id: 'role_b', total: 300 },
      ],
    });

    const ledger = new SqliteCoordinationStore(':memory:');
    await backfillTokenUsageLedger(runsRoot, ledger, 'T');

    expect(
      ledger.aggregateTokenUsage({ scope: 'role', scope_id: 'role_a' }, 'T').totals.total_tokens,
    ).toBe(450);
    expect(
      ledger.aggregateTokenUsage({ scope: 'role', scope_id: 'role_b' }, 'T').totals.total_tokens,
    ).toBe(300);
    // proxy 腿在 summary 里没有角色细分，回填只能落在未归属哨兵上——编造归属比留空更糟。
    const unattributed = ledger.aggregateTokenUsage({ scope: 'role', scope_id: '' }, 'T');
    expect(unattributed.totals.total_tokens).toBe(100);
    ledger.close();
  });
});

describe('LedgerRunUsageHistoryReader', () => {
  it('keeps the cumulative total after the run directory is deleted', async () => {
    // 这条就是这个读路径存在的理由：`.newide/runs` 没有任何保留策略，往期会被清掉。
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, { run_id: 'run_1', task_id: 'task_1', proxy: 100, driverLeg: 250 });
    const ledger = new SqliteCoordinationStore(':memory:');
    const reader = new LedgerRunUsageHistoryReader(ledger, runsRoot, () => 'T');

    const before = await reader.read({ scope: 'system' });
    expect(before.billed.totals.total_tokens).toBe(350);

    await rm(path.join(runsRoot, 'run_1'), { recursive: true, force: true });

    const after = await reader.read({ scope: 'system' });
    expect(after.billed.totals.total_tokens).toBe(350);
    expect(after.runs_counted).toBe(1);
    ledger.close();
  });

  it('exposes the ledger aggregate in the protocol shape', async () => {
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, { run_id: 'run_1', task_id: 'task_1', proxy: 100, driverLeg: 250 });
    const ledger = new SqliteCoordinationStore(':memory:');
    const reader = new LedgerRunUsageHistoryReader(ledger, runsRoot, () => '2026-10-03T00:00:00Z');

    const history = await reader.read({ scope: 'task', scope_id: 'task_1' });

    expect(history).toEqual({
      scope: 'task',
      scope_id: 'task_1',
      as_of: '2026-10-03T00:00:00Z',
      runs_counted: 1,
      runs_without_usage: 0,
      complete: true,
      billed: expect.objectContaining({ totals: expect.objectContaining({ total_tokens: 350 }) }),
    });
    ledger.close();
  });

  it('backfills once, not on every read', async () => {
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, { run_id: 'run_1', task_id: 'task_1', proxy: 100 });
    const appended: TokenUsageLedgerEntry[][] = [];
    const ledger = new SqliteCoordinationStore(':memory:');
    const counting: TokenUsageLedgerStore = {
      appendTokenUsage: (entries) => {
        appended.push([...entries]);
        ledger.appendTokenUsage(entries);
      },
      aggregateTokenUsage: (query, asOf) => ledger.aggregateTokenUsage(query, asOf),
    };
    const reader = new LedgerRunUsageHistoryReader(counting, runsRoot, () => 'T');

    await reader.read({ scope: 'system' });
    await reader.read({ scope: 'system' });
    await reader.read({ scope: 'system' });

    expect(appended).toHaveLength(1);
    ledger.close();
  });

  it('retries the backfill after a failure instead of caching the rejection', async () => {
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, { run_id: 'run_1', task_id: 'task_1', proxy: 100 });
    const ledger = new SqliteCoordinationStore(':memory:');
    let attempts = 0;
    const flaky: TokenUsageLedgerStore = {
      appendTokenUsage: (entries) => {
        attempts += 1;
        if (attempts === 1) throw new Error('ledger temporarily unavailable');
        ledger.appendTokenUsage(entries);
      },
      aggregateTokenUsage: (query, asOf) => ledger.aggregateTokenUsage(query, asOf),
    };
    const reader = new LedgerRunUsageHistoryReader(flaky, runsRoot, () => 'T');

    // 第一次回填失败：读不报错（账本里已有的部分仍可读），但不是永久放弃。
    const first = await reader.read({ scope: 'system' });
    expect(first.billed.totals.total_tokens).toBe(0);

    const second = await reader.read({ scope: 'system' });
    expect(attempts).toBe(2);
    expect(second.billed.totals.total_tokens).toBe(100);
    ledger.close();
  });

  it('canonicalises the key order of whatever aggregate the store hands back', async () => {
    // 账本 `GROUP BY` 出来的顺序实测恰好是字典序，但那是索引的巧合，不是契约。这条用例用
    // 一个**故意乱序**的存储替身把「这里显式规范化」钉住——否则它只是一句声明，而查询计划
    // 一变，同一个值的键序就会跟着变（同一个 run 的用量在回填前后换位）。
    const ordered: TokenUsageLedgerStore = {
      appendTokenUsage: () => undefined,
      aggregateTokenUsage: (query, asOf) => ({
        scope: query.scope,
        ...(query.scope_id === undefined ? {} : { scope_id: query.scope_id }),
        as_of: asOf,
        runs_counted: 1,
        runs_without_usage: 0,
        complete: true,
        totals: tokens(300),
        by_source: { proxy: tokens(100), claude_session_jsonl: tokens(200) },
      }),
    };
    const reader = new LedgerRunUsageHistoryReader(ordered, await makeRunsRoot(), () => 'T');

    const history = await reader.read({ scope: 'task', scope_id: 'task_1' });

    expect(Object.keys(history.billed.by_source)).toEqual(['claude_session_jsonl', 'proxy']);
    // 数值一个不少——规范化只动键序。
    expect(history.billed.by_source.proxy?.total_tokens).toBe(100);
    expect(history.billed.by_source.claude_session_jsonl?.total_tokens).toBe(200);
  });

  it('refuses a scope that has no subject', async () => {
    const ledger = new SqliteCoordinationStore(':memory:');
    const reader = new LedgerRunUsageHistoryReader(ledger, await makeRunsRoot(), () => 'T');

    await expect(reader.read({ scope: 'role' })).rejects.toThrow(/requires scope_id/);
    await expect(reader.read({ scope: 'task' })).rejects.toThrow(/requires scope_id/);
    await expect(reader.read({ scope: 'run' })).rejects.toThrow(/requires scope_id/);
    ledger.close();
  });

  it('reads one run back by id, and reports absence rather than zero', () => {
    // 这条守的是「进程重启后单个 run 的用量还在」：`readRun` 是同步的（挂在同步的快照投影
    // 上），所以它必须能在**不经过任何回填**的情况下直接答出一个已经落库的 run。
    const ledger = new SqliteCoordinationStore(':memory:');
    const reader = new LedgerRunUsageHistoryReader(ledger, '/nonexistent-runs-root', () => 'T');
    seedExecutedRun(ledger, 'run_1', 'task_1');
    appendLedgerRow(ledger, { run_id: 'run_1', task_id: 'task_1', total: 120 });
    appendLedgerRow(ledger, {
      run_id: 'run_1',
      task_id: 'task_1',
      total: 250,
      source: 'claude_session_jsonl',
      role_id: 'role_b',
    });

    const usage = reader.readRun('run_1');

    expect(usage?.by_source.proxy?.total_tokens).toBe(120);
    expect(usage?.by_source.claude_session_jsonl?.total_tokens).toBe(250);
    expect(usage?.totals.total_tokens).toBe(370);

    // 账本里没有这个 run → 缺席，不是一个全 0 的合计。**缺 ≠ 0**。
    expect(reader.readRun('run_never_seen')).toBeUndefined();
    ledger.close();
  });

  it('answers for a run whose usage only exists in its own summary, without a backfill', async () => {
    // 这条钉的是**读的顺序**。
    //
    // 快照投影是同步的，所以已收尾 run 的 `usage.billed` 只能走 `readRun`；而 `readRun` 曾经
    // 只看账本。于是对「用量还在 run 目录里、账本里还没有行」的 run，同一个 run 的用量会随
    // **有没有人先读过一次历史**而变：先读 `run.getUsage`（会回填）就有，直接读快照就没有。
    //
    // 这不是罕见状态，而是**升级后的全部历史**：实测本机 41 个状态库、292 个 run，`runs` 表
    // 里的 run 一个都没有账本行（`token_usage_ledger` 表在这些库里都还不存在），而其中 208 个
    // 有 `summary.json`。账本之前的历史全在目录里。
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, { run_id: 'run_1', task_id: 'task_1', proxy: 110, driverLeg: 40 });
    const ledger = new SqliteCoordinationStore(':memory:');
    const reader = new LedgerRunUsageHistoryReader(ledger, runsRoot, () => 'T');

    // 刻意**不调用** `reader.read`：答案是这一条读自己算出来的，不是别人回填剩下的。
    const before = reader.readRun('run_1');

    expect(before?.by_source.proxy?.total_tokens).toBe(110);
    expect(before?.by_source.claude_session_jsonl?.total_tokens).toBe(40);

    // 回填之后必须仍是同一个数——两条取数路径**同值**，顺序无关。
    await reader.read({ scope: 'task', scope_id: 'task_1' });
    expect(reader.readRun('run_1')).toEqual(before);

    // 账本在前：目录被清掉之后，答案必须还在账本里（`.newide/runs` 没有任何保留策略）。
    // 这条同时是**「账本优先」的对照**——把顺序倒过来，这里就只剩一个读不到的目录。
    await rm(path.join(runsRoot, 'run_1'), { recursive: true, force: true });
    expect(reader.readRun('run_1')).toEqual(before);
    ledger.close();
  });

  it('reports absence for a run that executed but has no usage anywhere', async () => {
    // 「有 handler.started、账本里没有行」是**已知缺口**。`readRun` 在这里必须返回
    // undefined——返回一个全 0 的合计会让调用方以为这个 run 花了 0 token。
    const ledger = new SqliteCoordinationStore(':memory:');
    seedExecutedRun(ledger, 'run_gap', 'task_gap');
    const reader = new LedgerRunUsageHistoryReader(ledger, '/nonexistent-runs-root', () => 'T');

    expect(reader.readRun('run_gap')).toBeUndefined();

    // 兜底路径不许**编**数字：目录在、summary 也在，只是没有可读的用量时，答案同样是缺席。
    // 这两格是上面那条回退的反向对照——没有它们，「兜底只在真读得到时才开口」只是一句声明。
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, { run_id: 'run_no_usage', task_id: 'task_gap' });
    await writeRun(runsRoot, { run_id: 'run_zero_usage', task_id: 'task_gap', zeroUsage: true });
    const withDirectory = new LedgerRunUsageHistoryReader(ledger, runsRoot, () => 'T');

    expect(withDirectory.readRun('run_no_usage')).toBeUndefined();
    // 全 0 的 `token_usage` 与「没有这个键」是同一件事：都读不出用量。**缺 ≠ 0**。
    expect(withDirectory.readRun('run_zero_usage')).toBeUndefined();

    // 而账本本身知道这是个缺口：`run` 作用域把「执行过」与「有行」分开报，不是都归成 0。
    const gap = await reader.read({ scope: 'run', scope_id: 'run_gap' });
    expect(gap.runs_counted).toBe(1);
    expect(gap.runs_without_usage).toBe(1);
    expect(gap.complete).toBe(false);
    expect(gap.billed.totals.total_tokens).toBe(0);
    ledger.close();
  });
});
