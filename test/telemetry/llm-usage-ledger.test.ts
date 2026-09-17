import { describe, expect, it } from 'vitest';
import {
  InMemoryTelemetrySink,
  UNATTRIBUTED_LLM_USAGE_GROUP,
  activeLedgerTokenCostTotal,
  bindActiveLlmUsageIdentity,
  getRunLlmUsageLedger,
  groupLlmUsageEntriesBy,
  mergeTokenUsageSummaries,
  recordProxyLlmUsage,
  releaseRunLlmUsageLedger,
  runWithLlmUsageAttribution,
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

  it('attributes usage from the ambient scope and groups it by stage and role', async () => {
    const sink = new InMemoryTelemetrySink();
    await runWithLlmUsageLedger({ case_id: 'case_attr', run_id: 'run_attr', sink }, async () => {
      await runWithLlmUsageAttribution({ stage_cursor: 'execute_agent', role_id: 'impl' }, () =>
        recordProxyLlmUsage({ input_tokens: 10, output_tokens: 1 }),
      );
      // 内层只给 role_id：外层的 stage_cursor 必须留着，否则这批 token 会从
      // stage 汇总里整批漏掉（漏的时候不报错，只是数字变小）。
      await runWithLlmUsageAttribution({ stage_cursor: 'council' }, () =>
        runWithLlmUsageAttribution({ role_id: 'critic', round: 2 }, () =>
          recordProxyLlmUsage({ input_tokens: 20, output_tokens: 2 }),
        ),
      );
    });

    const entries = getRunLlmUsageLedger('run_attr')?.entries ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ stage_cursor: 'execute_agent', role_id: 'impl' });
    expect(entries[1]).toMatchObject({ stage_cursor: 'council', role_id: 'critic', round: 2 });

    const byStage = groupLlmUsageEntriesBy(entries, 'stage_cursor');
    expect(byStage.execute_agent).toMatchObject({ total_tokens: 11, call_count: 1 });
    expect(byStage.council).toMatchObject({ total_tokens: 22, call_count: 1 });

    const byRole = groupLlmUsageEntriesBy(entries, 'role_id');
    expect(byRole.impl?.total_tokens).toBe(11);
    expect(byRole.critic?.total_tokens).toBe(22);

    releaseRunLlmUsageLedger('run_attr');
  });

  it('keeps usage that lacks the grouping dimension in an unattributed bucket', () => {
    const grouped = groupLlmUsageEntriesBy(
      [
        {
          input_tokens: 1,
          output_tokens: 1,
          source: 'proxy',
          recorded_at: '2026-01-01T00:00:00.000Z',
          stage_cursor: 'execute_agent',
        },
        { input_tokens: 2, output_tokens: 2, source: 'proxy', recorded_at: '2026-01-01T00:00:00.000Z' },
      ],
      'stage_cursor',
    );

    // 漏标归属的量要被单独看见：否则「各环节加起来比总数少」看不出少在哪。
    expect(grouped.execute_agent?.call_count).toBe(1);
    expect(grouped[UNATTRIBUTED_LLM_USAGE_GROUP]?.total_tokens).toBe(4);
    expect(grouped[UNATTRIBUTED_LLM_USAGE_GROUP]?.call_count).toBe(1);
  });

  it('carries cache tokens and attribution into the emitted usage payload', async () => {
    const sink = new InMemoryTelemetrySink();
    await runWithLlmUsageLedger({ case_id: 'case_cache', sink }, () =>
      runWithLlmUsageAttribution({ stage_cursor: 'extract', role_id: 'promoter' }, () =>
        recordProxyLlmUsage({
          input_tokens: 100,
          output_tokens: 10,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 200,
          model: 'test-model',
        }),
      ),
    );

    expect(sink.list()).toHaveLength(1);
    expect(sink.list()[0]?.event_type).toBe('proxy.llm_usage_recorded');
    expect(sink.list()[0]?.payload).toMatchObject({
      case_id: 'case_cache',
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 200,
      stage_cursor: 'extract',
      role_id: 'promoter',
    });
  });

  it('detaches the run ledger on release so it does not outlive the run', async () => {
    const sink = new InMemoryTelemetrySink();
    await runWithLlmUsageLedger({ case_id: 'case_release', run_id: 'run_release', sink }, () =>
      recordProxyLlmUsage({ input_tokens: 1, output_tokens: 1 }),
    );
    expect(getRunLlmUsageLedger('run_release')?.entries).toHaveLength(1);

    releaseRunLlmUsageLedger('run_release');
    expect(getRunLlmUsageLedger('run_release')).toBeUndefined();
  });
});
