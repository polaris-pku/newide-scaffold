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

/**
 * 旧库升级演练。
 *
 * 这一组用**真实文件库**而不是内存库来跑，因为要验的正是「已经存在的库能不能被就地改好」：
 * 旧 schema 的 `source` 列写死了 `CHECK (source IN ('proxy', 'claude_session_jsonl'))`，
 * 而 `CREATE TABLE IF NOT EXISTS` 永远不会改它。不重建表，换 driver 后第一次记账就撞约束，
 * 丢的是「累计用量」这条最不该丢的路径。
 */
describe('legacy source constraint migration', () => {
  const LEGACY_DDL = `
    CREATE TABLE token_usage_ledger (
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('proxy', 'claude_session_jsonl')),
      metric TEXT NOT NULL CHECK (metric IN ('billed_tokens')),
      input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      cache_creation_input_tokens INTEGER NOT NULL CHECK (cache_creation_input_tokens >= 0),
      cache_read_input_tokens INTEGER NOT NULL CHECK (cache_read_input_tokens >= 0),
      total_input_tokens INTEGER NOT NULL CHECK (total_input_tokens >= 0),
      total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
      call_count INTEGER NOT NULL CHECK (call_count >= 0),
      recorded_at TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      PRIMARY KEY (run_id, role_id, source, metric)
    );
    CREATE INDEX token_usage_ledger_by_task ON token_usage_ledger(task_id);
    CREATE INDEX token_usage_ledger_by_role ON token_usage_ledger(role_id);
  `;

  /** 建一个「老库」：旧 CHECK + 一行历史用量。 */
  function seedLegacyLedger(databasePath: string): void {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(LEGACY_DDL);
    legacy
      .prepare(
        `INSERT INTO token_usage_ledger (
           run_id, task_id, role_id, source, metric,
           input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
           total_input_tokens, total_tokens, call_count, recorded_at, schema_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'run_old',
        'task_old',
        'role_old',
        'claude_session_jsonl',
        'billed_tokens',
        10,
        20,
        0,
        0,
        10,
        30,
        1,
        'T',
        TOKEN_USAGE_LEDGER_SCHEMA_VERSION,
      );
    legacy.close();
  }

  function insertWithSource(databasePath: string, source: string): void {
    const database = new DatabaseSync(databasePath);
    try {
      database
        .prepare(
          `INSERT INTO token_usage_ledger (
             run_id, task_id, role_id, source, metric,
             input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
             total_input_tokens, total_tokens, call_count, recorded_at, schema_version
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('run_new', 'task_new', 'role_new', source, 'billed_tokens', 1, 1, 0, 0, 1, 2, 1, 'T', TOKEN_USAGE_LEDGER_SCHEMA_VERSION);
    } finally {
      // 抛错路径也必须关库：Windows 上留着句柄会让 afterEach 的目录清理 EPERM。
      database.close();
    }
  }

  function tableSql(databasePath: string): string {
    const database = new DatabaseSync(databasePath);
    try {
      const row = database
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'token_usage_ledger'`,
        )
        .get() as { sql: string } | undefined;
      return row?.sql ?? '';
    } finally {
      database.close();
    }
  }

  it('refuses a driver-declared source on a legacy ledger, which is why the rebuild exists', () => {
    const databasePath = tempDatabasePath();
    seedLegacyLedger(databasePath);

    // 先确认这个失败模式是真的：不重建的话，换 driver 的名字直接撞 CHECK
    expect(() => insertWithSource(databasePath, 'codex_jsonl')).toThrow(/CHECK constraint/i);
  });

  it('rebuilds the table, keeps history, and accepts a newly declared source', () => {
    const databasePath = tempDatabasePath();
    seedLegacyLedger(databasePath);

    // 打开生产库 → 迁移就地跑起来
    const store = new SqliteCoordinationStore(databasePath);
    store.close();

    // 历史行必须原样保留
    const database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare('SELECT source, total_tokens FROM token_usage_ledger WHERE run_id = ?')
        .get('run_old'),
    ).toEqual({ source: 'claude_session_jsonl', total_tokens: 30 });
    database.close();

    // 约束已放开，且索引被重建
    expect(tableSql(databasePath)).not.toContain('CHECK (source IN (');
    expect(() => insertWithSource(databasePath, 'codex_jsonl')).not.toThrow();

    const indexes = new DatabaseSync(databasePath);
    const indexNames = indexes
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'token_usage_ledger'`)
      .all() as Array<{ name: string }>;
    indexes.close();
    // 只看两条显式索引；主键还会自带一个 sqlite_autoindex。
    expect(indexNames.map((row) => row.name)).toEqual(
      expect.arrayContaining(['token_usage_ledger_by_task', 'token_usage_ledger_by_role']),
    );
  });

  it('is idempotent across repeated opens', () => {
    const databasePath = tempDatabasePath();
    seedLegacyLedger(databasePath);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const store = new SqliteCoordinationStore(databasePath);
      store.close();
    }

    const database = new DatabaseSync(databasePath);
    expect(
      database.prepare('SELECT COUNT(*) AS n FROM token_usage_ledger').get(),
    ).toEqual({ n: 1 });
    database.close();
    expect(() => insertWithSource(databasePath, 'gemini_jsonl')).not.toThrow();
  });

  it('leaves a freshly created ledger on the open source domain', () => {
    const databasePath = tempDatabasePath();
    const store = new SqliteCoordinationStore(databasePath);
    store.close();

    expect(tableSql(databasePath)).not.toContain('CHECK (source IN (');
    expect(() => insertWithSource(databasePath, 'anything_declared_by_a_profile')).not.toThrow();
  });
});
