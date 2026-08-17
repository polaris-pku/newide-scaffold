/**
 * renderContextUsage 的 token-only 分支测试：LLM client 只报 tokens_in、
 * 未配置 contextWindow 时，曲线按 tokens_in 归一化画条形趋势而不是空置；
 * 配置了 pct 时仍走百分比曲线。
 */
import { describe, expect, it } from 'vitest';
import { renderContextUsage } from '../../src/trace/render';
import type { ContextUsagePoint } from '../../src/trace/analysis';

function point(round: number, tokensIn: number, pct = 0): ContextUsagePoint {
  return {
    round,
    tokens_in: tokensIn,
    context_pct: pct,
    created_at: '2026-08-16T10:00:00.000Z',
  };
}

describe('renderContextUsage', () => {
  it('renders a token-only bar trend when no context window is known', () => {
    const output = renderContextUsage([point(1, 2_000), point(2, 8_000), point(3, 4_000)]);
    expect(output).toContain('tokens_in:');
    expect(output).toContain('max 8000 tokens in at round 2');
    expect(output).toContain('(no context window configured)');
    expect(output).toContain('bars:');
    // 最大点（round 2，8000）填充格数应大于较小点（2000、4000）。
    // renderPercentBar 固定 8 字符宽，比较的是非 '▁' 的填充字符数。
    const bars = output.split('\n').find((line) => line.trim().startsWith('bars:'));
    const segments = bars?.split('bars:')[1]?.trim().split(' ') ?? [];
    const filledCount = (bar: string) => [...bar].filter((ch) => ch !== '▁').length;
    expect(filledCount(segments[1]!)).toBeGreaterThan(filledCount(segments[0]!));
    expect(filledCount(segments[1]!)).toBeGreaterThan(filledCount(segments[2]!));
  });

  it('keeps the pct-based view when context percentages exist', () => {
    const output = renderContextUsage([point(1, 2_000, 40), point(2, 8_000, 86)]);
    expect(output).toContain('usage:');
    expect(output).toContain('max 86% at round 2');
    expect(output).not.toContain('no context window configured');
  });
});
