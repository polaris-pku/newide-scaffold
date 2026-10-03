import { describe, expect, it } from 'vitest';
import type { TaskDriverUsage } from '../../src/app/driver-usage-projector';
import { projectRunUsage } from '../../src/app/run-usage-projection';

type TimelineItem = { type: string; payload: Record<string, unknown> };

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
});
