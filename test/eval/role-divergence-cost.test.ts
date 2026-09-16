/**
 * driver-usage / cost-analysis — 计费台账的离线守卫
 *
 * 这两个模块回答的是「这次实验到底花了多少、缓存有没有在工作」，所以测试的重点不是
 * 覆盖率，而是**口径别错**：
 *   - 流式分片必须剔除，否则 call_count 虚高、命中率分母变小；
 *   - 三分量不许双计，否则花费虚高；
 *   - 缺台账必须显式可见，不能被当成零花费。
 * 这三条错了，实验结论就会朝「比实际便宜」的方向偏，且不会自己暴露。
 */
import { describe, expect, it } from 'vitest';
import { parseClaudeSessionUsageText } from '../../src/telemetry';
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  emptyDriverTokenEvidence,
  summarizeDriverTokenUsage,
} from '../../eval/role-divergence/driver-usage';
import {
  analyzeCosts,
  formatCostReport,
  type CellCostInput,
} from '../../eval/role-divergence/cost-analysis';

function row(overrides: Partial<Parameters<typeof summarizeDriverTokenUsage>[0]['rows'][number]>) {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    recorded_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const sessionLine = (overrides: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      model: 'test-model',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      ...(overrides.message as Record<string, unknown> | undefined),
    },
    ...overrides,
  });

describe('summarizeDriverTokenUsage', () => {
  it('按 Anthropic 口径加权：缓存读 0.1x、缓存写 1.25x', () => {
    const summary = summarizeDriverTokenUsage({
      rows: [
        row({ input_tokens: 1000, output_tokens: 10 }),
        row({ cache_creation_input_tokens: 2000, output_tokens: 10 }),
        row({ cache_read_input_tokens: 3000, output_tokens: 10 }),
      ],
    });

    expect(summary.call_count).toBe(3);
    expect(summary.billed_input_tokens).toBe(6000);
    expect(summary.effective_input_tokens).toBe(
      1000 * 1 + 2000 * CACHE_WRITE_MULTIPLIER + 3000 * CACHE_READ_MULTIPLIER,
    );
    expect(summary.cache_saved_input_tokens).toBe(6000 - summary.effective_input_tokens);
    expect(summary.ideal_cache_input_tokens).toBe(600);
    expect(summary.cache_read_ratio).toBeCloseTo(0.5, 4);
  });

  it('零命中时加权等于全价，节省必须为 0', () => {
    const summary = summarizeDriverTokenUsage({
      rows: [row({ input_tokens: 73_000, output_tokens: 99 }), row({ input_tokens: 73_119 })],
    });
    expect(summary.cache_read_ratio).toBe(0);
    expect(summary.effective_input_tokens).toBe(summary.billed_input_tokens);
    expect(summary.cache_saved_input_tokens).toBe(0);
  });

  it('剔除全零行作为兜底，并保留分片计数', () => {
    const summary = summarizeDriverTokenUsage({
      rows: [row({}), row({ input_tokens: 100, output_tokens: 1 }), row({})],
      skippedFragmentRows: 159,
    });
    expect(summary.call_count).toBe(1);
    expect(summary.skipped_fragment_rows).toBe(159);
  });

  it('空输入给出显式原因，而不是一个看起来正常的零', () => {
    const summary = summarizeDriverTokenUsage({ rows: [] });
    expect(summary.call_count).toBe(0);
    expect(summary.unavailable_reason).toBeTruthy();
    expect(emptyDriverTokenEvidence('boom').unavailable_reason).toBe('boom');
  });

  it('累计曲线单调，末项等于总计', () => {
    const summary = summarizeDriverTokenUsage({
      rows: [row({ input_tokens: 100 }), row({ input_tokens: 300 }), row({ input_tokens: 50 })],
    });
    expect(summary.calls.map((call) => call.cumulative_billed_input_tokens)).toEqual([
      100, 400, 450,
    ]);
    expect(summary.max_call_input_tokens).toBe(300);
  });
});

describe('parseClaudeSessionUsageText', () => {
  it('剔除 stop_reason 为 null 的流式分片，只留真正计费的行', () => {
    const text = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          stop_reason: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
      sessionLine({}),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          stop_reason: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
    ].join('\n');

    const parsed = parseClaudeSessionUsageText({ text, sessionId: 'sess-1' });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.skipped_fragment_rows).toBe(2);
    expect(parsed.entries[0]?.input_tokens).toBe(100);
    expect(parsed.entries[0]?.model).toBe('test-model');
  });

  it('按 sessionId 过滤，不带别的会话的开销进这一格', () => {
    const text = [sessionLine({}), sessionLine({ sessionId: 'other-session' })].join('\n');
    const parsed = parseClaudeSessionUsageText({ text, sessionId: 'sess-1' });
    expect(parsed.entries).toHaveLength(1);
  });

  it('按时间窗过滤，复用工作区时不会把上一轮算进来', () => {
    const text = [
      sessionLine({ timestamp: '2026-01-01T00:00:01.000Z' }),
      sessionLine({ timestamp: '2026-01-02T00:00:00.000Z' }),
    ].join('\n');
    const parsed = parseClaudeSessionUsageText({
      text,
      sessionId: 'sess-1',
      since: '2026-01-01T12:00:00.000Z',
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.recorded_at).toBe('2026-01-02T00:00:00.000Z');
  });

  it('畸形行被跳过而不是抛错', () => {
    const parsed = parseClaudeSessionUsageText({
      text: ['not json', '', sessionLine({})].join('\n'),
      sessionId: 'sess-1',
    });
    expect(parsed.entries).toHaveLength(1);
  });
});

describe('analyzeCosts', () => {
  const zeroHit = summarizeDriverTokenUsage({
    rows: [row({ input_tokens: 1000, output_tokens: 10 })],
    sessionIds: ['s1'],
  });
  const withCache = summarizeDriverTokenUsage({
    rows: [row({ input_tokens: 0, cache_read_input_tokens: 10_000, output_tokens: 5 })],
    sessionIds: ['s2'],
  });

  const cells: CellCostInput[] = [
    {
      cell_id: 'a',
      experiment: 'plan_role',
      role_key: 'correctness',
      status: 'completed',
      wall_ms: 100,
      driver_tokens: zeroHit,
    },
    {
      cell_id: 'b',
      experiment: 'plan_role',
      role_key: 'security',
      status: 'completed',
      wall_ms: 100,
      driver_tokens: withCache,
    },
    { cell_id: 'c', experiment: 'plan_neutral', role_key: 'neutral', status: 'completed', wall_ms: 1 },
    {
      cell_id: 'd',
      experiment: 'review_role',
      role_key: 'performance',
      status: 'failed',
      wall_ms: 1,
      driver_tokens_error: 'session missing',
    },
  ];

  it('缺台账的格单独计数，不被当成零花费', () => {
    const analysis = analyzeCosts(cells);
    expect(analysis.cells_total).toBe(4);
    expect(analysis.cells_with_driver_usage).toBe(2);
    expect(analysis.cells_without_driver_usage).toBe(2);
    expect(Object.keys(analysis.missing_reasons)).toHaveLength(2);
    // 缺省原因必须指向"未埋点"，而不是编造一个零
    expect(
      Object.keys(analysis.missing_reasons).some((reason) => reason.includes('no driver_tokens')),
    ).toBe(true);
  });

  it('合计把缓存读的折扣体现在加权花费里', () => {
    const analysis = analyzeCosts(cells);
    expect(analysis.totals.billed_input_tokens).toBe(11_000);
    expect(analysis.totals.effective_input_tokens).toBe(1000 + 10_000 * CACHE_READ_MULTIPLIER);
    expect(analysis.totals.cache_saved_input_tokens).toBe(
      11_000 - analysis.totals.effective_input_tokens,
    );
  });

  it('按实验与角色分组时把无台账的格排除在外', () => {
    const analysis = analyzeCosts(cells);
    expect(analysis.by_experiment.map((bucket) => bucket.key)).toEqual(['plan_role']);
    expect(analysis.by_role.map((bucket) => bucket.key).sort()).toEqual([
      'correctness',
      'security',
    ]);
  });

  it('最贵格按计费输入降序，且只列有台账的格', () => {
    const analysis = analyzeCosts(cells);
    expect(analysis.worst_cells.map((r) => r.cell_id)).toEqual(['b', 'a']);
  });

  it('报告文本把三个关键读数都写出来', () => {
    const report = formatCostReport(analyzeCosts(cells));
    expect(report).toContain('计费输入');
    expect(report).toContain('缓存命中率');
    expect(report).toContain('加权花费');
    expect(report).toContain('缺少 driver 台账的格');
    expect(report).toContain('session missing');
  });

  it('整体零命中时报告直说"一点没省"', () => {
    const report = formatCostReport(
      analyzeCosts([
        {
          cell_id: 'a',
          experiment: 'plan_role',
          role_key: 'correctness',
          status: 'completed',
          wall_ms: 1,
          driver_tokens: zeroHit,
        },
      ]),
    );
    expect(report).toContain('一点没省');
    expect(report).toContain('0.00%');
  });
});
