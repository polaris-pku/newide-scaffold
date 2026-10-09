/**
 * 账本 → `RoleTokenUsageReader` 的适配（Agent Board 角色累计用量的装配点）。
 *
 * 守三件事：
 * - 按 `role_id` 求和，**各腿相加**（`proxy` + driver 计费腿），与 run 的
 *   `token_usage.total_tokens` 同口径；
 * - 只算被问的那个角色，别的角色的行不加进来；
 * - 账本里没有这个角色的行时返回 `undefined` 而**不是 0**——判据是「到底有没有腿」，
 *   不是 `runs_counted`（后者把「执行过但没进账本」的 run 也算进来，那时 totals 全是 0）。
 */
import { describe, expect, it } from 'vitest';
import { createLedgerRoleTokenUsage } from '../../src/app/b-public-capabilities';
import {
  SqliteCoordinationStore,
  TOKEN_USAGE_LEDGER_SCHEMA_VERSION,
  type TokenUsageLedgerEntry,
  type TokenUsageSource,
} from '../../src/persistence';
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

function appendLedgerRow(
  store: SqliteCoordinationStore,
  spec: {
    run_id: string;
    task_id?: string;
    total: number;
    source?: TokenUsageSource;
    role_id?: string;
  },
): void {
  store.appendTokenUsage([
    {
      run_id: spec.run_id,
      task_id: spec.task_id ?? 'task_1',
      role_id: spec.role_id ?? 'role_a',
      source: spec.source ?? 'proxy',
      metric: 'billed_tokens',
      recorded_at: 'T',
      schema_version: TOKEN_USAGE_LEDGER_SCHEMA_VERSION,
      ...tokens(spec.total),
    } satisfies TokenUsageLedgerEntry,
  ]);
}

describe('createLedgerRoleTokenUsage', () => {
  it('按 role_id 求和，两条腿相加', () => {
    const ledger = new SqliteCoordinationStore(':memory:');
    appendLedgerRow(ledger, { run_id: 'run_1', role_id: 'role_a', source: 'proxy', total: 41_626 });
    appendLedgerRow(ledger, {
      run_id: 'run_1',
      role_id: 'role_a',
      source: 'claude_session_jsonl',
      total: 121_794,
    });

    expect(createLedgerRoleTokenUsage(ledger).totalBilledTokens('role_a')).toBe(163_420);
  });

  it('跨多个 run 累加，且只算被问的那个角色', () => {
    const ledger = new SqliteCoordinationStore(':memory:');
    appendLedgerRow(ledger, { run_id: 'run_1', role_id: 'role_a', total: 100 });
    appendLedgerRow(ledger, { run_id: 'run_2', role_id: 'role_a', total: 250 });
    appendLedgerRow(ledger, { run_id: 'run_1', role_id: 'role_b', total: 9_999 });

    expect(createLedgerRoleTokenUsage(ledger).totalBilledTokens('role_a')).toBe(350);
    expect(createLedgerRoleTokenUsage(ledger).totalBilledTokens('role_b')).toBe(9_999);
  });

  it('账本里没有这个角色的行时返回 undefined，不是 0', () => {
    const ledger = new SqliteCoordinationStore(':memory:');
    appendLedgerRow(ledger, { run_id: 'run_1', role_id: 'role_a', total: 100 });

    expect(createLedgerRoleTokenUsage(ledger).totalBilledTokens('role_missing')).toBeUndefined();
  });

  it('未归属（role_id 为空）的行不属于任何角色', () => {
    const ledger = new SqliteCoordinationStore(':memory:');
    appendLedgerRow(ledger, { run_id: 'run_1', role_id: '', total: 132_184 });

    expect(createLedgerRoleTokenUsage(ledger).totalBilledTokens('role_a')).toBeUndefined();
  });

  it('同一 (run, role_id, source) 重复写入是覆盖，不重复计', () => {
    const ledger = new SqliteCoordinationStore(':memory:');
    appendLedgerRow(ledger, { run_id: 'run_1', role_id: 'role_a', total: 100 });
    appendLedgerRow(ledger, { run_id: 'run_1', role_id: 'role_a', total: 100 });

    expect(createLedgerRoleTokenUsage(ledger).totalBilledTokens('role_a')).toBe(100);
  });
});
