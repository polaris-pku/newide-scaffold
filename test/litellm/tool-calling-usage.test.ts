/**
 * buildToolCallUsage 单元测试：AI SDK generateText 的 usage → 轨迹 LlmUsage
 * 的提取与 context_pct 推算。该函数是 LiteLLMToolCallingClient 的纯函数，
 * 不需要真实 LLM API；覆盖 v5+（inputTokens/outputTokens）与 v4
 * （promptTokens/completionTokens）两种字段名，以及未配置 contextWindow
 * 时只报 tokens 不推算 pct 的行为。
 */
import { describe, expect, it } from 'vitest';
import { buildToolCallUsage } from '../../src/memory/adapters/litellm-tool-calling-client';

describe('buildToolCallUsage', () => {
  it('extracts v5+ usage field names', () => {
    const usage = buildToolCallUsage({
      usage: { inputTokens: 12_000, outputTokens: 400, totalTokens: 12_400 },
    });
    expect(usage).toEqual({ tokens_in: 12_000, tokens_out: 400 });
  });

  it('falls back to v4 usage field names', () => {
    const usage = buildToolCallUsage({
      usage: { promptTokens: 8_000, completionTokens: 300 },
    });
    expect(usage).toEqual({ tokens_in: 8_000, tokens_out: 300 });
  });

  it('derives context_pct from tokens_in when contextWindow is configured', () => {
    const usage = buildToolCallUsage(
      { usage: { inputTokens: 64_000, outputTokens: 1_000 } },
      128_000,
    );
    expect(usage).toMatchObject({
      tokens_in: 64_000,
      tokens_out: 1_000,
      context_limit: 128_000,
    });
    expect(usage?.context_pct).toBeCloseTo(50);
  });

  it('does not derive context_pct without a contextWindow', () => {
    const usage = buildToolCallUsage({ usage: { inputTokens: 64_000 } });
    expect(usage).toEqual({ tokens_in: 64_000 });
    expect(usage?.context_pct).toBeUndefined();
  });

  it('returns undefined when the result carries no usage', () => {
    expect(buildToolCallUsage({ usage: undefined })).toBeUndefined();
    expect(buildToolCallUsage({})).toBeUndefined();
  });
});
