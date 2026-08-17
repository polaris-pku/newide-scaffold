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

  it('merges proxy and claude summaries', () => {
    const proxy = toRunTokenUsageSummary([
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
