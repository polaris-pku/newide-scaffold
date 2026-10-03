/**
 * 账本行构造的纯函数测试。
 *
 * 重点在两处**保守规则**上，它们是「账本能与 `summary.token_usage` 对上」的唯一保证：
 * 归集必须发生在写入前（主键决定的），以及 driver 腿逐会话求和与权威总量不等时**不许**
 * 按角色写。另有一条守的是口径：`driver_context_usage` 的 `context_tokens_used` 是占用，
 * 不是计费，绝不能混进来。
 */
import { describe, expect, it } from 'vitest';
import {
  buildTokenUsageLedgerEntries,
  readClaudeSessionLeg,
} from '../../src/app/run-usage-ledger-entries';
import { UNATTRIBUTED_ROLE_ID } from '../../src/persistence';
import type { RunUsageTokens } from '../../src/protocol/run-snapshot';

function tokens(total: number, callCount = 1): RunUsageTokens {
  return {
    input_tokens: total,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: total,
    total_tokens: total,
    call_count: callCount,
  };
}

function baseInput() {
  return { run_id: 'run_1', task_id: 'task_1', timeline: [], recorded_at: 'T' };
}

describe('readClaudeSessionLeg', () => {
  it('returns undefined rather than zero when the leg is absent or empty', () => {
    expect(readClaudeSessionLeg(undefined)).toBeUndefined();
    expect(readClaudeSessionLeg({})).toBeUndefined();
    expect(readClaudeSessionLeg({ by_source: {} })).toBeUndefined();
    // 腿在但总量为 0：同样是「没有」，返回 undefined 让调用方少写一行而不是写一行 0。
    expect(readClaudeSessionLeg({ by_source: { claude_session_jsonl: tokens(0) } })).toBeUndefined();
  });

  it('reads the claude_session_jsonl leg when present', () => {
    const leg = readClaudeSessionLeg({ by_source: { claude_session_jsonl: tokens(7500, 2) } });
    expect(leg?.total_tokens).toBe(7500);
    expect(leg?.call_count).toBe(2);
  });
});

describe('buildTokenUsageLedgerEntries driver leg', () => {
  it('attributes by role when the sessions reconcile with the authoritative leg', () => {
    const entries = buildTokenUsageLedgerEntries({
      ...baseInput(),
      driverBilledLeg: tokens(7500, 2),
      driverBilledUsage: {
        sessions: [
          { role_id: 'role_a', ...tokens(4500) },
          { role_id: 'role_b', ...tokens(3000) },
        ],
      },
    });

    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.role_id === 'role_a')?.total_tokens).toBe(4500);
    expect(entries.find((e) => e.role_id === 'role_b')?.total_tokens).toBe(3000);
    expect(entries.every((e) => e.source === 'claude_session_jsonl')).toBe(true);
  });

  it('falls back to one unattributed row when the sessions do not reconcile', () => {
    // 逐会话求和 500 ≠ 权威腿 7500。按角色写会让账本总数与 summary 对不上，
    // 所以宁可丢掉角色分解，也要保住「账本总数 == summary 的那条腿」。
    const entries = buildTokenUsageLedgerEntries({
      ...baseInput(),
      driverBilledLeg: tokens(7500, 2),
      driverBilledUsage: { sessions: [{ role_id: 'role_a', ...tokens(500) }] },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role_id: UNATTRIBUTED_ROLE_ID,
      total_tokens: 7500,
      call_count: 2,
    });
  });

  it('falls back when no sessions carry billed amounts', () => {
    // driver_context_usage 的 sessions 只有 context_tokens_used（占用），没有计费细分。
    // 它们一个数字都不该进计费行。
    const entries = buildTokenUsageLedgerEntries({
      ...baseInput(),
      driverBilledLeg: tokens(7500, 2),
      driverBilledUsage: {
        metric: 'context_tokens_used',
        sessions: [
          { session_id: 'session_a', role_id: 'role_a', context_tokens_used: 999 },
          { session_id: 'session_b', role_id: 'role_b', context_tokens_used: 111 },
        ],
      },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ role_id: UNATTRIBUTED_ROLE_ID, total_tokens: 7500 });
  });

  it('writes no driver rows when there is no driver leg', () => {
    const entries = buildTokenUsageLedgerEntries({
      ...baseInput(),
      driverBilledUsage: { sessions: [{ role_id: 'role_a', ...tokens(4500) }] },
    });
    expect(entries).toEqual([]);
  });
});

describe('buildTokenUsageLedgerEntries proxy leg', () => {
  it('rolls multiple events of the same role into a single row', () => {
    // 主键是 (run_id, role_id, source, metric)：逐事件写会互相覆盖、静默丢用量。
    const entries = buildTokenUsageLedgerEntries({
      ...baseInput(),
      timeline: [
        { type: 'proxy.llm_usage_recorded', payload: { input_tokens: 100, role_id: 'role_a' } },
        { type: 'proxy.llm_usage_recorded', payload: { input_tokens: 5, role_id: 'role_a' } },
        { type: 'handler.started', payload: { cursor: 'execute_agent' } },
      ],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'proxy',
      role_id: 'role_a',
      total_tokens: 105,
      call_count: 2,
    });
  });

  it('counts cache toward the total, matching summarizeRunConsumption', () => {
    const entries = buildTokenUsageLedgerEntries({
      ...baseInput(),
      timeline: [
        {
          type: 'proxy.llm_usage_recorded',
          payload: {
            input_tokens: 10,
            output_tokens: 3,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            role_id: 'role_a',
          },
        },
      ],
    });

    // total = input + cache_creation + cache_read + output
    expect(entries[0]?.total_tokens).toBe(63);
    expect(entries[0]?.total_input_tokens).toBe(60);
  });

  it('sends events without an attributable role to the sentinel instead of dropping them', () => {
    const entries = buildTokenUsageLedgerEntries({
      ...baseInput(),
      timeline: [
        { type: 'proxy.llm_usage_recorded', payload: { input_tokens: 7 } },
        { type: 'proxy.llm_usage_recorded', payload: { input_tokens: 1, role_id: '   ' } },
      ],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ role_id: UNATTRIBUTED_ROLE_ID, total_tokens: 8 });
  });
});
