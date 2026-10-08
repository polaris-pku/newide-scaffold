import { describe, expect, it } from 'vitest';
import type { TaskDriverUsage } from '../../src/app/driver-usage-projector';
import { pendingBilledSources, projectRunUsage } from '../../src/app/run-usage-projection';
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

  it('reports by_source in one canonical key order, not in the order the source gave it', () => {
    // 同一个 run 的 `billed` 有两条取数路径：账本（SQL `GROUP BY`）与 run 目录自己的
    // `summary.json`（写入时的顺序）。实测同一个真实 run（662,716 token、两条腿）：回填前后
    // **数值逐字段相同、键序相反**（`proxy,claude_session_jsonl` ↔ `claude_session_jsonl,proxy`）。
    // JSON 的对象键序在语义上无关，但有两个后果：按键序渲染腿列表的前端会看到腿在回填
    // 前后换位；而「两条路径同值」只能靠 `toEqual` 断言、`JSON.stringify` 一比就假红。
    const usage = projectRunUsage({
      durable: {
        totals: tokens(350),
        // 刻意按**非字典序**摆：proxy 在前。规范化要能把它翻过来。
        by_source: {
          proxy: { ...tokens(100) },
          claude_session_jsonl: { ...tokens(250) },
        },
      },
    });

    expect(Object.keys(usage?.billed?.by_source ?? {})).toEqual([
      'claude_session_jsonl',
      'proxy',
    ]);
    // 数值一个不少——规范化只动键序，不动任何数字。
    expect(usage?.billed?.by_source.proxy?.total_tokens).toBe(100);
    expect(usage?.billed?.by_source.claude_session_jsonl?.total_tokens).toBe(250);
  });

  it('marks the driver leg as pending while the run is still running', () => {
    // 96% 的那条腿（实测一次真实 run：proxy 3,308 / driver 80,933）由**收尾**时的刮取写出来，
    // 所以运行中的 run 只可能有 proxy 腿。没有这一位，前端会把 `by_source.proxy` 读成
    // 「这个 run 花了这么多」——那是真相的 4%。
    const usage = projectRunUsage({
      timeline: [proxyUsage({ input_tokens: 100, output_tokens: 10 })],
      pendingSources: pendingBilledSources('running'),
    });

    expect(usage?.billed?.pending_sources).toEqual(['claude_session_jsonl']);
    expect(pendingBilledSources('running')).toEqual(['claude_session_jsonl']);
    // 已收尾的 run 不该说还有腿没到：那时候该到的都到了（没到的成因在 `driver_billed_merge`）。
    expect(pendingBilledSources('completed')).toEqual([]);
    expect(pendingBilledSources('failed')).toEqual([]);
  });

  it('waits on the source the configured driver actually declares', () => {
    // 换 driver 之后名字必须跟着变：否则面板会一直等一条永远不会来的腿，
    // 而真到的那条腿被当成「不在名单里」。
    expect(pendingBilledSources('running', 'codex_jsonl')).toEqual(['codex_jsonl']);
    expect(
      projectRunUsage({
        timeline: [proxyUsage({ input_tokens: 1, output_tokens: 1 })],
        pendingSources: pendingBilledSources('running', 'codex_jsonl'),
      })?.billed?.pending_sources,
    ).toEqual(['codex_jsonl']);
    // 缺省仍是历史名，零配置行为不变
    expect(pendingBilledSources('running')).toEqual(['claude_session_jsonl']);
  });

  it('never claims a leg is pending once it is actually there', () => {
    // 名单与账本各自由不同的事实算出来：账本两条腿齐了、名单还说缺 driver 腿时，
    // 报它 pending 就是撒谎。这条判据让「还没到」永远只在真的缺席时出现。
    const usage = projectRunUsage({
      durable: {
        totals: tokens(350),
        by_source: { proxy: tokens(100), claude_session_jsonl: tokens(250) },
      },
      pendingSources: ['claude_session_jsonl'],
    });

    expect(usage?.billed?.by_source.claude_session_jsonl?.total_tokens).toBe(250);
    expect(usage?.billed).not.toHaveProperty('pending_sources');

    // 而同一个 run 在「只有 proxy 腿」的时刻确实报得出来——否则上面那句可能是空转。
    const stillMissing = projectRunUsage({
      durable: { totals: tokens(100), by_source: { proxy: tokens(100) } },
      pendingSources: ['claude_session_jsonl'],
    });
    expect(stillMissing?.billed?.pending_sources).toEqual(['claude_session_jsonl']);
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
