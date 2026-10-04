import { describe, expect, it } from 'vitest';
import type { TaskDriverUsage } from '../../src/app/driver-usage-projector';
import { projectRunUsage } from '../../src/app/run-usage-projection';
import type { RunUsageTokens } from '../../src/protocol/run-snapshot';

type TimelineItem = { type: string; payload: Record<string, unknown> };

/** 一个只有 input 的合计；投影不做算术，所以用例里只关心搬对没搬对。 */
function tokens(total: number): RunUsageTokens {
  return {
    input_tokens: total,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: total,
    total_tokens: total,
    call_count: 1,
  };
}

function proxyUsage(input: {
  input_tokens: number;
  output_tokens: number;
  stage_cursor?: string;
}): TimelineItem {
  return {
    type: 'proxy.llm_usage_recorded',
    payload: {
      input_tokens: input.input_tokens,
      output_tokens: input.output_tokens,
      ...(input.stage_cursor ? { stage_cursor: input.stage_cursor } : {}),
    },
  };
}

const driverUsage: TaskDriverUsage = {
  available: true,
  source: 'driver_stream_usage_update',
  metric: 'context_tokens_used',
  context_tokens_used: 4200,
  reported_costs: [{ amount: 0.12, currency: 'USD' }],
  complete: true,
  sessions: [
    {
      session_id: 'session_a',
      role_id: 'role_impl',
      context_tokens_used: 4200,
      context_window_size: 200000,
      reported_cost: { amount: 0.12, currency: 'USD' },
      complete: true,
    },
  ],
};

describe('projectRunUsage', () => {
  it('stays absent when neither leg has anything to report', () => {
    // 没有任何用量事实时整个 usage 缺席——不编一个 0 出来。
    expect(projectRunUsage({ timeline: [] })).toBeUndefined();
    expect(
      projectRunUsage({ timeline: [{ type: 'run.started', payload: {} }] }),
    ).toBeUndefined();
  });

  it('never exposes a single top-level total across the scope-separated metrics', () => {
    // 三条口径互不相加，所以顶层绝不能出现任何像「总数」的字段：
    // 前端一定会拿它当结论，而那个数必然是错的。
    const usage = projectRunUsage({
      timeline: [proxyUsage({ input_tokens: 100, output_tokens: 20, stage_cursor: 'execute_agent' })],
      driverUsage,
    });

    expect(usage).toBeDefined();
    expect(Object.keys(usage!).sort()).toEqual(['billed', 'by_stage', 'context']);
    expect(usage).not.toHaveProperty('total_tokens');
    expect(usage).not.toHaveProperty('totals');
  });

  it('sums the proxy leg into billed.by_source and buckets it by stage', () => {
    const usage = projectRunUsage({
      timeline: [
        proxyUsage({ input_tokens: 100, output_tokens: 20, stage_cursor: 'execute_agent' }),
        proxyUsage({ input_tokens: 50, output_tokens: 5, stage_cursor: 'execute_agent' }),
        proxyUsage({ input_tokens: 7, output_tokens: 3, stage_cursor: 'gate' }),
      ],
    });

    expect(usage?.billed).toEqual({
      metric: 'billed_tokens',
      by_source: {
        proxy: {
          input_tokens: 157,
          output_tokens: 28,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          total_input_tokens: 157,
          total_tokens: 185,
          call_count: 3,
        },
      },
    });

    // stage 桶名与 summary.consumption 一致；metric 名自带 proxy 范围，
    // 防止被当成「这个 stage 的总消耗」。
    expect(usage?.by_stage?.execute_agent).toMatchObject({
      metric: 'proxy_billed_tokens',
      llm_calls: 2,
      total_tokens: 175,
    });
    expect(usage?.by_stage?.gate).toMatchObject({ metric: 'proxy_billed_tokens', total_tokens: 10 });
  });

  it('projects the driver context occupancy as a separately namespaced metric', () => {
    const usage = projectRunUsage({ timeline: [], driverUsage });

    expect(usage?.context).toEqual({
      metric: 'context_tokens_used',
      context_tokens_used: 4200,
      complete: true,
      sessions: [
        {
          session_id: 'session_a',
          role_id: 'role_impl',
          context_tokens_used: 4200,
          context_window_size: 200000,
          reported_cost: { amount: 0.12, currency: 'USD' },
        },
      ],
    });
    // 上下文占用与计费流量不是同一个量，两者必须各自成块。
    expect(usage?.billed).toBeUndefined();
  });

  it('propagates an incomplete driver observation instead of claiming completeness', () => {
    // 被截断文件喂出的观测 complete=false：如实标注，不冒充完整数据。
    const usage = projectRunUsage({
      timeline: [],
      driverUsage: { ...driverUsage, complete: false },
    });

    expect(usage?.context?.complete).toBe(false);
  });

  it('ignores an unavailable driver accumulator', () => {
    const usage = projectRunUsage({
      timeline: [],
      driverUsage: { ...driverUsage, available: false },
    });

    expect(usage).toBeUndefined();
  });

  it('lets the durable ledger leg win over the live timeline', () => {
    // 已收尾的 run 用账本那一份：它是收尾时写死的权威件，**两条腿都在**；而存活期时间线
    // 永远只有 proxy 腿（driver 计费从不进事件流）。同一个 run 在「进程还持有」与
    // 「进程重启后读」两种情况下必须报同一个 `billed`，所以这里必须是账本压过时间线，
    // 而不是「两个都报」或「时间线优先」。
    const usage = projectRunUsage({
      timeline: [proxyUsage({ input_tokens: 100, output_tokens: 10, stage_cursor: 'execute_agent' })],
      durable: {
        totals: { ...tokens(370), call_count: 2 },
        by_source: {
          proxy: { ...tokens(110), output_tokens: 10, total_tokens: 120 },
          claude_session_jsonl: { ...tokens(250) },
        },
      },
    });

    expect(Object.keys(usage?.billed?.by_source ?? {}).sort()).toEqual([
      'claude_session_jsonl',
      'proxy',
    ]);
    // 账本的 proxy 腿（120）而不是时间线那条（110）——两者不同正是这条用例的意义。
    expect(usage?.billed?.by_source.proxy?.total_tokens).toBe(120);
    expect(usage?.billed?.by_source.claude_session_jsonl?.total_tokens).toBe(250);
    // 按 stage 分桶只有存活期时间线有，账本不提供它——两条腿各来自各自的来源。
    expect(usage?.by_stage?.execute_agent?.total_tokens).toBe(110);
  });

  it('falls back to the timeline when the ledger has no legs', () => {
    // 账本为空（写入失败被吞掉、或这个 run 还没进账本）：不能因此把数字变成缺席，
    // 存活期时间线仍然能给出 proxy 腿。
    const usage = projectRunUsage({
      timeline: [proxyUsage({ input_tokens: 100, output_tokens: 10 })],
      durable: { totals: { ...tokens(0), call_count: 0 }, by_source: {} },
    });

    expect(usage?.billed?.by_source.proxy?.total_tokens).toBe(110);
  });

  it('treats a missing timeline as absent rather than as an empty one', () => {
    // 本进程不持有该 run 时 `timeline` 是**缺席**的。此时只有账本能说话；两样都没有就整个缺席。
    expect(projectRunUsage({})).toBeUndefined();
    expect(
      projectRunUsage({ durable: { totals: { ...tokens(0) }, by_source: {} } }),
    ).toBeUndefined();

    const durableOnly = projectRunUsage({
      durable: { totals: { ...tokens(250) }, by_source: { claude_session_jsonl: { ...tokens(250) } } },
    });
    expect(durableOnly?.billed?.by_source.claude_session_jsonl?.total_tokens).toBe(250);
    // 没有存活期时间线就没有按 stage 分桶——不编一个空对象出来。
    expect(durableOnly?.by_stage).toBeUndefined();
  });
});
