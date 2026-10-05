/**
 * 用量账本（`token_usage_ledger`）的持久语义测试。
 *
 * 这一组用例守的是三条**具体的失效模式**，而不是「能存能取」：
 * 1. 并发/重写导致重复计入 —— 幂等键必须让重写是覆盖；
 * 2. 无法归属角色时用 NULL 让唯一键失效 —— SQLite 把 NULL 视为互不相同；
 * 3. 把「从未推进的 run」也算成缺口 —— 那样 `complete` 会永远是 false，信号被淹掉。
 * 另有一条守的是本轮的目的本身：**任务被清理后累计用量仍然存在**。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteCoordinationStore,
  TOKEN_USAGE_LEDGER_SCHEMA_VERSION,
  UNATTRIBUTED_ROLE_ID,
  type CoordinationStateCommit,
  type TokenUsageLedgerEntry,
} from '../../src/persistence';
import type { RunUsageTokens } from '../../src/protocol/run-snapshot';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDatabasePath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-token-ledger-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'coordination.sqlite');
}

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

function entry(overrides: Partial<TokenUsageLedgerEntry> & { run_id: string }): TokenUsageLedgerEntry {
  return {
    task_id: 'task_1',
    role_id: 'role_a',
    source: 'proxy',
    metric: 'billed_tokens',
    recorded_at: 'T',
    schema_version: TOKEN_USAGE_LEDGER_SCHEMA_VERSION,
    ...tokens(100),
    ...overrides,
  };
}

/**
 * 播一个 task + run，附带 `task.created`，并按需附一条 `handler.started`。
 *
 * 后者是关键：它由 `startStage` 写出、早于任何 executor，所以是「确实开跑过」的持久判据。
 */
function seedRun(
  store: SqliteCoordinationStore,
  run_id: string,
  task_id: string,
  withHandlerStarted: boolean,
): void {
  const event = (suffix: string, event_type: string) => ({
    event_id: `${run_id}_${suffix}`,
    event_type,
    subject_id: task_id,
    run_id,
    task_id,
    payload: {},
    created_at: 'T',
    schema_version: 'v0',
  });
  store.commitState({
    task: {
      task_id,
      status: 'created',
      risk_level: 'medium',
      spec: 'usage ledger test',
      completion_criteria: ['x'],
      affected_paths: ['src/**'],
      workspace_path: '/workspace',
      warnings: [],
      revision: 1,
      created_at: 'T',
      updated_at: 'T',
      schema_version: 'v0',
    },
    run: {
      run_id,
      task_id,
      status: 'created',
      mode: 'single_agent',
      workspace_path: '/workspace',
      revision: 1,
      created_at: 'T',
      updated_at: 'T',
      schema_version: 'v0',
    },
    runtime_state: {
      task_id,
      current_run_id: run_id,
      resume_cursor: 'select_agent',
      waiting_on: [],
      artifact_refs: [],
      diagnostics: {},
      updated_at: 'T',
      schema_version: 'v0',
    },
    events: [
      event('created', 'task.created'),
      ...(withHandlerStarted ? [event('started', 'handler.started')] : []),
    ],
  } as CoordinationStateCommit);
}

describe('SqliteTokenUsageLedger', () => {
  it('keeps the two legs separate and never merges them into one number', () => {
    const store = new SqliteCoordinationStore(':memory:');
    seedRun(store, 'run_1', 'task_1', true);
    store.appendTokenUsage([
      entry({ run_id: 'run_1', source: 'proxy', ...tokens(100) }),
      entry({ run_id: 'run_1', source: 'claude_session_jsonl', ...tokens(250) }),
    ]);

    const aggregate = store.aggregateTokenUsage({ scope: 'system' }, 'T');

    expect(aggregate.by_source.proxy?.total_tokens).toBe(100);
    expect(aggregate.by_source.claude_session_jsonl?.total_tokens).toBe(250);
    // 两条腿相加得 350，但那是消费方的事，账本自己不合并成一个数。
    expect(aggregate.totals.total_tokens).toBe(350);
    expect(aggregate.runs_counted).toBe(1);
    store.close();
  });

  it('overwrites on rewrite instead of double counting', () => {
    const store = new SqliteCoordinationStore(':memory:');
    seedRun(store, 'run_1', 'task_1', true);
    store.appendTokenUsage([entry({ run_id: 'run_1', ...tokens(100) })]);
    // 重复收尾 / 重试 / 回填：同一个幂等键再写一次，必须是覆盖。
    store.appendTokenUsage([entry({ run_id: 'run_1', ...tokens(100) })]);

    expect(store.aggregateTokenUsage({ scope: 'system' }, 'T').totals.total_tokens).toBe(100);
    store.close();
  });

  it('keeps unattributed rows idempotent because the sentinel is not NULL', () => {
    // SQLite 的唯一索引把 NULL 视为互不相同：role_id 若可空，下面第二次写入会新增一行。
    const databasePath = tempDatabasePath();
    const store = new SqliteCoordinationStore(databasePath);
    seedRun(store, 'run_1', 'task_1', true);
    const unattributed = entry({
      run_id: 'run_1',
      role_id: UNATTRIBUTED_ROLE_ID,
      ...tokens(70),
    });
    store.appendTokenUsage([unattributed]);
    store.appendTokenUsage([unattributed]);
    expect(store.aggregateTokenUsage({ scope: 'system' }, 'T').totals.total_tokens).toBe(70);
    store.close();

    const database = new DatabaseSync(databasePath);
    const rows = database
      .prepare('SELECT role_id, COUNT(*) AS n FROM token_usage_ledger GROUP BY role_id')
      .all();
    expect(rows).toEqual([{ role_id: '', n: 1 }]);
    database.close();
  });

  it('counts an executed run with no ledger rows as a known gap, but not a run that never advanced', () => {
    const store = new SqliteCoordinationStore(':memory:');
    // 开跑过、也有账本 —— 唯一一个贡献数字的 run。
    seedRun(store, 'run_ok', 'task_ok', true);
    store.appendTokenUsage([entry({ run_id: 'run_ok', task_id: 'task_ok', ...tokens(100) })]);
    // 开跑过、没有账本 —— 已知缺口，必须让 complete 掉下来。
    seedRun(store, 'run_gap', 'task_gap', true);
    // 从未推进（只有 task.created，没有 handler.started）—— 不是 run，不该进分母。
    seedRun(store, 'run_idle', 'task_idle', false);

    const aggregate = store.aggregateTokenUsage({ scope: 'system' }, 'T');

    expect(aggregate.runs_counted).toBe(2);
    expect(aggregate.runs_without_usage).toBe(1);
    expect(aggregate.complete).toBe(false);
    // 缺口不折算成 0：总量仍只有能读到的那一份。
    expect(aggregate.totals.total_tokens).toBe(100);
    store.close();
  });

  it('is complete when every executed run is in the ledger', () => {
    const store = new SqliteCoordinationStore(':memory:');
    seedRun(store, 'run_ok', 'task_ok', true);
    seedRun(store, 'run_idle', 'task_idle', false);
    store.appendTokenUsage([entry({ run_id: 'run_ok', task_id: 'task_ok', ...tokens(100) })]);

    const aggregate = store.aggregateTokenUsage({ scope: 'system' }, 'T');

    expect(aggregate.runs_counted).toBe(1);
    expect(aggregate.runs_without_usage).toBe(0);
    expect(aggregate.complete).toBe(true);
    store.close();
  });

  it('is never complete when nothing is in the ledger at all', () => {
    const store = new SqliteCoordinationStore(':memory:');
    const aggregate = store.aggregateTokenUsage({ scope: 'task', scope_id: 'task_missing' }, 'T');

    expect(aggregate.runs_counted).toBe(0);
    expect(aggregate.complete).toBe(false);
    expect(aggregate.by_source).toEqual({});
    store.close();
  });

  it('filters the task scope and sums the role scope across runs', () => {
    const store = new SqliteCoordinationStore(':memory:');
    seedRun(store, 'run_1', 'task_1', true);
    seedRun(store, 'run_2', 'task_2', true);
    store.appendTokenUsage([
      entry({ run_id: 'run_1', task_id: 'task_1', role_id: 'role_a', ...tokens(100) }),
      entry({ run_id: 'run_2', task_id: 'task_2', role_id: 'role_a', ...tokens(40) }),
      entry({ run_id: 'run_2', task_id: 'task_2', role_id: 'role_b', ...tokens(7) }),
    ]);

    expect(store.aggregateTokenUsage({ scope: 'task', scope_id: 'task_1' }, 'T').totals.total_tokens).toBe(100);
    const role = store.aggregateTokenUsage({ scope: 'role', scope_id: 'role_a' }, 'T');
    expect(role.totals.total_tokens).toBe(140);
    expect(role.runs_counted).toBe(2);
    expect(role.scope_id).toBe('role_a');
    store.close();
  });

  it('reports the global upper bound for role scope because roles are not attributable in events', () => {
    const store = new SqliteCoordinationStore(':memory:');
    seedRun(store, 'run_1', 'task_1', true);
    // 另一个 task 的 run 开跑过但没账本；它是否属于 role_a 无法判断，所以按全局上界报。
    seedRun(store, 'run_other', 'task_other', true);
    store.appendTokenUsage([entry({ run_id: 'run_1', task_id: 'task_1', role_id: 'role_a', ...tokens(100) })]);

    const role = store.aggregateTokenUsage({ scope: 'role', scope_id: 'role_a' }, 'T');

    // runs_counted 含读不出用量的 run，所以 role 下它是「有行的 1 + 全局缺席上界 1」。
    expect(role.runs_counted).toBe(2);
    expect(role.runs_without_usage).toBe(1);
    expect(role.complete).toBe(false);
    // task scope 能精确过滤，所以它只看见自己那个 run。
    expect(store.aggregateTokenUsage({ scope: 'task', scope_id: 'task_1' }, 'T').runs_without_usage).toBe(0);
    store.close();
  });

  it('answers about one run for the run scope, including its own gap', () => {
    // 单 run 查询必须只谈那个 run：如果把整个库的缺口都算进来，`complete` 永远 false，
    // 一个只问单个 run 的调用方会得到一个关于整个库的答案。
    const store = new SqliteCoordinationStore(':memory:');
    seedRun(store, 'run_1', 'task_1', true);
    seedRun(store, 'run_2', 'task_2', true);
    seedRun(store, 'run_other', 'task_other', true);
    store.appendTokenUsage([
      entry({ run_id: 'run_1', task_id: 'task_1', source: 'proxy', role_id: 'role_a', ...tokens(100) }),
      entry({
        run_id: 'run_1',
        task_id: 'task_1',
        source: 'claude_session_jsonl',
        role_id: 'role_b',
        ...tokens(250),
      }),
      entry({ run_id: 'run_2', task_id: 'task_2', role_id: 'role_a', ...tokens(40) }),
    ]);

    const run = store.aggregateTokenUsage({ scope: 'run', scope_id: 'run_1' }, 'T');

    // 两条腿都按角色求和，且**不相加成一个数**——合并是消费方的事。
    expect(run.by_source.proxy?.total_tokens).toBe(100);
    expect(run.by_source.claude_session_jsonl?.total_tokens).toBe(250);
    expect(run.totals.total_tokens).toBe(350);
    expect(run.scope_id).toBe('run_1');
    // 另外两个 run 的缺口不许泄漏进来。
    expect(run.runs_counted).toBe(1);
    expect(run.runs_without_usage).toBe(0);
    expect(run.complete).toBe(true);
    store.close();
  });

  it('reports a run that executed without ledger rows as its own gap', () => {
    const store = new SqliteCoordinationStore(':memory:');
    seedRun(store, 'run_1', 'task_1', true);
    seedRun(store, 'run_2', 'task_2', true);
    store.appendTokenUsage([entry({ run_id: 'run_2', task_id: 'task_2', ...tokens(40) })]);

    const run = store.aggregateTokenUsage({ scope: 'run', scope_id: 'run_1' }, 'T');

    expect(run.runs_counted).toBe(1);
    expect(run.runs_without_usage).toBe(1);
    expect(run.complete).toBe(false);
    // 缺口**不折算成 0**：一条腿都没有，而不是「两条腿都是 0」。
    expect(run.by_source).toEqual({});
    expect(run.totals.total_tokens).toBe(0);
    store.close();
  });

  it('counts nothing for a run that never advanced past creation', () => {
    const store = new SqliteCoordinationStore(':memory:');
    // 只有 task.created、没有 handler.started：从未开跑过，不是缺口也不是用量。
    seedRun(store, 'run_idle', 'task_idle', false);

    const run = store.aggregateTokenUsage({ scope: 'run', scope_id: 'run_idle' }, 'T');

    expect(run.runs_counted).toBe(0);
    expect(run.runs_without_usage).toBe(0);
    expect(run.complete).toBe(false);
    store.close();
  });

  it('refuses the run scope without a scope_id instead of silently querying everything', () => {
    const store = new SqliteCoordinationStore(':memory:');
    expect(() => store.aggregateTokenUsage({ scope: 'run' }, 'T')).toThrow(
      /run scope requires scope_id/,
    );
    store.close();
  });

  it('survives task deletion because it has no cascade', () => {
    // 这一条守的就是本轮的目的：任务是会被清理的，累计用量必须活过清理。
    const databasePath = tempDatabasePath();
    const store = new SqliteCoordinationStore(databasePath);
    seedRun(store, 'run_1', 'task_1', true);
    store.appendTokenUsage([entry({ run_id: 'run_1', task_id: 'task_1', ...tokens(100) })]);
    store.close();

    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    database.prepare('DELETE FROM tasks WHERE task_id = ?').run('task_1');
    // events / runs 随外键级联消失，账本必须留下。
    expect(database.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
    expect(database.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    expect(database.prepare('SELECT COUNT(*) AS n FROM token_usage_ledger').get()).toEqual({ n: 1 });
    database.close();

    const reopened = new SqliteCoordinationStore(databasePath);
    expect(reopened.aggregateTokenUsage({ scope: 'system' }, 'T').totals.total_tokens).toBe(100);
    reopened.close();
  });
});
