import { describe, expect, it } from 'vitest';
import {
  InMemoryTelemetrySink,
  activeLedgerTokenCostTotal,
  bindActiveLlmUsageIdentity,
  mergeTokenUsageSummaries,
  recordProxyLlmUsage,
  releaseRunLlmUsageLedger,
  runWithLlmUsageLedger,
  snapshotActiveLedgerUsage,
  snapshotRunLedgerUsage,
  splitCachedPromptUsage,
  toRunTokenUsageSummary,
} from '../../src/telemetry';

describe('llm-usage-ledger', () => {
  it('records proxy usage onto the active sink and run ledger', async () => {
    const sink = new InMemoryTelemetrySink();
    await runWithLlmUsageLedger(
      {
        case_id: 'case_1',
        sink,
        scaffold_variant: 'full_system',
      },
      async () => {
        bindActiveLlmUsageIdentity({
          run_id: 'run_1',
          task_id: 'task_1',
          case_id: 'case_1',
        });
        await recordProxyLlmUsage({
          input_tokens: 100,
          output_tokens: 40,
          model: 'test-model',
          temperature: 0.2,
        });
        expect(activeLedgerTokenCostTotal()).toBe(140);
        expect(snapshotActiveLedgerUsage()).toMatchObject({
          source: 'proxy',
          total_tokens: 140,
          call_count: 1,
        });
      },
    );

    expect(snapshotRunLedgerUsage('run_1')).toMatchObject({
      total_tokens: 140,
      by_source: { proxy: { call_count: 1, total_tokens: 140 } },
    });
    expect(sink.list().map((record) => record.event_type)).toEqual(['proxy.llm_usage_recorded']);
    expect(sink.list()[0]?.payload).toMatchObject({
      case_id: 'case_1',
      input_tokens: 100,
      output_tokens: 40,
      model: 'test-model',
      scaffold_variant: 'full_system',
      temperature: 0.2,
    });
    releaseRunLlmUsageLedger('run_1');
  });

  it('merges proxy and claude summaries', () => {    const proxy = toRunTokenUsageSummary([
      {
        input_tokens: 10,
        output_tokens: 5,
        source: 'proxy',
        recorded_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const claude = toRunTokenUsageSummary(
      [
        {
          input_tokens: 20,
          output_tokens: 8,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 4,
          source: 'claude_session_jsonl',
          recorded_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      { session_id: 'sess_1' },
    );
    const merged = mergeTokenUsageSummaries([proxy, claude]);
    expect(merged.source).toBe('mixed');
    expect(merged.total_tokens).toBe(10 + 5 + 20 + 8 + 2 + 4);
    expect(merged.session_id).toBe('sess_1');
    expect(merged.by_source.proxy?.total_tokens).toBe(15);
    expect(merged.by_source.claude_session_jsonl?.total_tokens).toBe(34);
  });
});

describe('splitCachedPromptUsage', () => {
  it('把总 prompt 拆成不重不漏的三分量', () => {
    const split = splitCachedPromptUsage({
      prompt_tokens: 1000,
      cache_read_tokens: 700,
      cache_write_tokens: 100,
    });
    // 全价部分必须减去缓存读写：把 prompt_tokens 原样当全价，会和缓存读叠加成双计。
    expect(split.input_tokens).toBe(200);
    expect(split.cache_read_input_tokens).toBe(700);
    expect(split.cache_creation_input_tokens).toBe(100);
    expect(
      split.input_tokens + split.cache_read_input_tokens + split.cache_creation_input_tokens,
    ).toBe(1000);
  });

  it('未上报缓存时全价等于全部，且缓存量显式为 0', () => {
    expect(splitCachedPromptUsage({ prompt_tokens: 500 })).toEqual({
      input_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('上游缓存量超过 prompt 时钳到 0，不产出负数', () => {
    expect(
      splitCachedPromptUsage({ prompt_tokens: 100, cache_read_tokens: 300 }).input_tokens,
    ).toBe(0);
  });
});
