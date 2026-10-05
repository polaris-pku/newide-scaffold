/**
 * 「这一轮 proxy 花了多少 token」在系统里有**三份拷贝**，本文件钉住它们永远相等。
 *
 * | 拷贝 | 生产者 | 去处 |
 * |---|---|---|
 * | `resolveTokenUsageFromTimeline` | `run-terminal-output-writer` | summary 的 `token_usage`、快照的 `usage.billed` |
 * | `summarizeRunConsumption` | 同上 | summary 的 `consumption`（按 stage 分桶） |
 * | `buildTokenUsageLedgerEntries` | `run-usage-ledger-entries` | 用量账本的行（累计口径的正源） |
 *
 * 它们**不是三种口径**，是同一个量的三份拷贝，所以算术只有一套：
 * `total_input_tokens = input + cache_creation + cache_read`，
 * `total_tokens = total_input_tokens + output`。
 *
 * 这正是曾经出过问题的地方：第一份把 cache 写死 0、只数 input+output，靠「没有调用点传
 * cache」与另外两份相等。**靠巧合相等不是口径一致**——一旦有生产者开始传 cache，面板上
 * 「这一轮花了多少」会按你看哪块而给出两个数，而账本还会照旧累计。本文件让那个巧合
 * 变成断言。
 */
import { describe, expect, it } from 'vitest';
import { buildTokenUsageLedgerEntries } from '../../src/app/run-usage-ledger-entries';
import {
  resolveTokenUsageFromTimeline,
  summarizeRunConsumption,
} from '../../src/app/run-terminal-output-writer';

type TimelineEvent = { type: string; payload: Record<string, unknown> };

function proxyEvent(payload: Record<string, unknown>): TimelineEvent {
  return { type: 'proxy.llm_usage_recorded', payload };
}

function ledgerTotal(events: TimelineEvent[]): number {
  return buildTokenUsageLedgerEntries({
    run_id: 'run_1',
    task_id: 'task_1',
    timeline: events,
    recorded_at: 'T',
  }).reduce((sum, entry) => sum + entry.total_tokens, 0);
}

describe('proxy 计费用量的三份拷贝', () => {
  it('agrees with cache present (the case that used to diverge silently)', () => {
    const events = [
      proxyEvent({
        input_tokens: 10,
        output_tokens: 3,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
      }),
    ];

    // total = input + cache_creation + cache_read + output = 63
    expect(resolveTokenUsageFromTimeline(events)?.total_tokens).toBe(63);
    expect(summarizeRunConsumption(events).totals.total_tokens).toBe(63);
    expect(ledgerTotal(events)).toBe(63);
    // cache 也要能读出来，而不是被归零——否则「含 cache」只是碰巧对上了总数。
    expect(resolveTokenUsageFromTimeline(events)?.by_source.proxy).toMatchObject({
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      total_input_tokens: 60,
    });
  });

  it('agrees with cache absent (today’s producers)', () => {
    const events = [proxyEvent({ input_tokens: 100, output_tokens: 10 })];

    expect(resolveTokenUsageFromTimeline(events)?.total_tokens).toBe(110);
    expect(summarizeRunConsumption(events).totals.total_tokens).toBe(110);
    expect(ledgerTotal(events)).toBe(110);
  });

  it('sums cache across several calls instead of reading only the last one', () => {
    const events = [
      proxyEvent({ input_tokens: 1, cache_creation_input_tokens: 2, role_id: 'role_a' }),
      proxyEvent({ input_tokens: 4, cache_read_input_tokens: 8, role_id: 'role_a' }),
      proxyEvent({ output_tokens: 16, cache_creation_input_tokens: 32, role_id: 'role_a' }),
    ];

    const expected = 1 + 2 + 4 + 8 + 16 + 32;
    expect(resolveTokenUsageFromTimeline(events)?.total_tokens).toBe(expected);
    expect(summarizeRunConsumption(events).totals.total_tokens).toBe(expected);
    expect(ledgerTotal(events)).toBe(expected);
  });

  it('keeps the three copies apart on the driver leg (context occupancy is not billed)', () => {
    // `driver_context_usage`（占用）绝不能混进任何一份计费拷贝。这里的 timeline 只有
    // proxy 事件，所以三份都只该数 proxy；driver 腿由 summary 合并阶段另行并入。
    const events = [
      { type: 'driver.usage_updated', payload: { used: 9999, size: 200000, role_id: 'role_a' } },
      proxyEvent({ input_tokens: 5, output_tokens: 5 }),
    ];

    expect(resolveTokenUsageFromTimeline(events)?.total_tokens).toBe(10);
    expect(summarizeRunConsumption(events).totals.total_tokens).toBe(10);
    expect(ledgerTotal(events)).toBe(10);
  });
});
