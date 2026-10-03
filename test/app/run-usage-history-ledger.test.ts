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

interface SummarySpec {
  run_id: string;
  task_id?: string;
  proxy?: number;
  driverLeg?: number;
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
      ...(Object.keys(bySource).length > 0
        ? {
            token_usage: {
              schema_version: 'newide.token_usage.v1',
              source: 'mixed',
              ...tokens((spec.proxy ?? 0) + (spec.driverLeg ?? 0)),
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
    expect(second.rows_written).toBe(first.rows_written);
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

  it('refuses a scope that has no subject', async () => {
    const ledger = new SqliteCoordinationStore(':memory:');
    const reader = new LedgerRunUsageHistoryReader(ledger, await makeRunsRoot(), () => 'T');

    await expect(reader.read({ scope: 'role' })).rejects.toThrow(/requires scope_id/);
    await expect(reader.read({ scope: 'task' })).rejects.toThrow(/requires scope_id/);
    ledger.close();
  });
});
