/**
 * `token_usage_ledger` 的 SQLite 实现（与 `sqlite-protocol-delivery.ts` 同一套约定：
 * 自带迁移函数、共享宿主的 `DatabaseSync`、由 `SqliteCoordinationStore` 装配）。
 *
 * 建表有三处刻意选择，都是被具体的失效模式逼出来的：
 *
 * 1. **不建外键、没有级联删除**。`events` / `deliveries` 那些表都挂
 *    `REFERENCES tasks(task_id) ON DELETE CASCADE`，但用量账本**不能**这么做：任务是会被
 *    清理的，而累计用量的全部意义就是在清理之后仍然存在。挂上外键等于把「累计」交给
 *    会被删的那一行决定。
 * 2. **`role_id` 非空，无法归属时用空串**。SQLite 的唯一索引把 `NULL` 视为互不相同，
 *    可空列会让主键失去幂等性——同一个 run 重复收尾就变成重复计，而且不报错。
 * 3. **主键就是幂等键** `(run_id, role_id, source, metric)`，配合 `ON CONFLICT DO UPDATE`
 *    让重写是覆盖。这样重试、重启、回填都不需要先查后写。
 *
 * `runs_without_usage` 的判据是 `events` 里的 `handler.started`：它在 `startStage` 里写出
 * （`task-processor.ts:374`），早于任何 executor，所以「有它」等价于「确实开跑过」——
 * 与目录扫描时代用 `audit.jsonl` 判定的语义完全一致，只是判据换成了持久的表。
 * 用「有任意事件」是不行的：那样连从未推进的 run 也会被算成缺口，`complete` 会永远是 false。
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { RunUsageTokens } from '../protocol/run-snapshot';
import type {
  TokenUsageLedgerAggregate,
  TokenUsageLedgerEntry,
  TokenUsageLedgerQuery,
  TokenUsageLedgerStore,
} from './token-usage-ledger';

const LEDGER_TABLE = 'token_usage_ledger';
/** 重建迁移期间的临时表名。 */
const LEDGER_REBUILD_TABLE = 'token_usage_ledger_rebuilt';

const LEDGER_COLUMNS = [
  'run_id',
  'task_id',
  'role_id',
  'source',
  'metric',
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'total_input_tokens',
  'total_tokens',
  'call_count',
  'recorded_at',
  'schema_version',
] as const;

/**
 * 列定义。建表与重建迁移**共用同一份**，避免两处漂移出不同的表。
 *
 * `source` 只校验非空：它的取值域是开放的（driver 档案自己声明计费腿名字），
 * 写死 `IN (...)` 就等于「换 driver 必须改 schema」。
 */
const LEDGER_COLUMN_DDL = `
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (length(source) > 0),
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
`;

export function migrateTokenUsageLedger(database: DatabaseSync): void {
  relaxLegacySourceConstraint(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (${LEDGER_COLUMN_DDL});

    CREATE INDEX IF NOT EXISTS token_usage_ledger_by_task
      ON ${LEDGER_TABLE}(task_id);
    CREATE INDEX IF NOT EXISTS token_usage_ledger_by_role
      ON ${LEDGER_TABLE}(role_id);
  `);
}

/**
 * 把旧库上写死的 `source` 取值约束换成开放域。
 *
 * 老库建表时是 `CHECK (source IN ('proxy', 'claude_session_jsonl'))`。**`CREATE TABLE
 * IF NOT EXISTS` 永远不会改它**——所以老库一旦换 driver，第一次记账就撞约束失败，而且
 * 撞的是「累计用量」这条最不该丢的路径。SQLite 不能 ALTER 掉一个 CHECK，只能整表重建。
 *
 * 判据取自 `sqlite_master.sql` 而不是版本号：这个库没有为账本维护 user_version，
 * 而建表语句本身就带着「我是不是旧形状」的全部信息。
 *
 * **本函数刻意不开事务**：调用方 `SqliteCoordinationStore.migrate` 已经把整批迁移包在
 * 一个 `BEGIN IMMEDIATE` 里，嵌套 BEGIN 会直接抛 `cannot start a transaction within a
 * transaction`。原子性由调用方提供；下面的半成品兜底是给单独调用留的后路。
 */
function relaxLegacySourceConstraint(database: DatabaseSync): void {
  const legacySql = readTableSql(database, LEDGER_TABLE);
  const rebuiltSql = readTableSql(database, LEDGER_REBUILD_TABLE);

  if (legacySql === undefined && rebuiltSql !== undefined) {
    // 上一次重建死在 DROP 与 RENAME 之间。把半成品扶正——**不能丢**，那里面是全部历史用量。
    database.exec(`ALTER TABLE ${LEDGER_REBUILD_TABLE} RENAME TO ${LEDGER_TABLE}`);
    return;
  }
  if (rebuiltSql !== undefined) {
    database.exec(`DROP TABLE ${LEDGER_REBUILD_TABLE}`);
  }
  if (legacySql === undefined || !legacySql.includes('CHECK (source IN (')) return;

  const columns = LEDGER_COLUMNS.join(', ');
  database.exec(`
    CREATE TABLE ${LEDGER_REBUILD_TABLE} (${LEDGER_COLUMN_DDL});
    INSERT INTO ${LEDGER_REBUILD_TABLE} (${columns}) SELECT ${columns} FROM ${LEDGER_TABLE};
    DROP TABLE ${LEDGER_TABLE};
    ALTER TABLE ${LEDGER_REBUILD_TABLE} RENAME TO ${LEDGER_TABLE};
  `);
}

function readTableSql(database: DatabaseSync, table: string): string | undefined {
  const row = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  if (!row || typeof row !== 'object') return undefined;
  const sql = Reflect.get(row, 'sql');
  return typeof sql === 'string' ? sql : undefined;
}

export class SqliteTokenUsageLedger implements TokenUsageLedgerStore {
  constructor(private readonly database: DatabaseSync) {}

  appendTokenUsage(entries: readonly TokenUsageLedgerEntry[]): void {
    if (entries.length === 0) return;
    const statement = this.database.prepare(`
      INSERT INTO token_usage_ledger (
        run_id, task_id, role_id, source, metric,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        total_input_tokens, total_tokens, call_count, recorded_at, schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_id, role_id, source, metric) DO UPDATE SET
        task_id = excluded.task_id,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        total_input_tokens = excluded.total_input_tokens,
        total_tokens = excluded.total_tokens,
        call_count = excluded.call_count,
        recorded_at = excluded.recorded_at,
        schema_version = excluded.schema_version
    `);
    for (const entry of entries) {
      statement.run(
        entry.run_id,
        entry.task_id,
        entry.role_id,
        entry.source,
        entry.metric,
        entry.input_tokens,
        entry.output_tokens,
        entry.cache_creation_input_tokens,
        entry.cache_read_input_tokens,
        entry.total_input_tokens,
        entry.total_tokens,
        entry.call_count,
        entry.recorded_at,
        entry.schema_version,
      );
    }
  }

  aggregateTokenUsage(query: TokenUsageLedgerQuery, asOf: string): TokenUsageLedgerAggregate {
    const { where, params } = scopeFilter(query);
    // 缺口查询与作用域过滤共用同一个 scope_id：`task` 按 task_id，`run` 按 run_id。
    // 分开算会让「有行的 run」与「缺口的 run」落在两个不同的作用域上。
    const missingFilter =
      query.scope === 'task'
        ? 'AND task_id = ?'
        : query.scope === 'run'
          ? 'AND run_id = ?'
          : '';
    const missingParams: SQLInputValue[] =
      query.scope === 'task' || query.scope === 'run' ? [requireScopeId(query)] : [];
    const totals = emptyTokens();
    const bySource: Record<string, RunUsageTokens> = {};

    const grouped = this.database
      .prepare(
        `SELECT source,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
                SUM(cache_read_input_tokens) AS cache_read_input_tokens,
                SUM(total_input_tokens) AS total_input_tokens,
                SUM(total_tokens) AS total_tokens,
                SUM(call_count) AS call_count
         FROM token_usage_ledger
         ${where}
         GROUP BY source
         ORDER BY source`,
      )
      .all(...params) as SqlRow[];

    for (const row of grouped) {
      const source = readString(row, 'source');
      if (!source) continue;
      const tokens = readTokens(row);
      bySource[source] = tokens;
      addTokens(totals, tokens);
    }

    // 单独算 run 数：一个 run 两条腿都在时按来源求和会把它算两次。
    const counted = this.database
      .prepare(`SELECT COUNT(DISTINCT run_id) AS n FROM token_usage_ledger ${where}`)
      .get(...params) as SqlRow | undefined;
    const runsWithRows = readNumber(counted, 'n');

    const missing = this.database
      .prepare(
        `SELECT COUNT(DISTINCT run_id) AS n
         FROM events
         WHERE event_type = 'handler.started'
           AND run_id IS NOT NULL
           AND run_id NOT IN (SELECT run_id FROM token_usage_ledger)
           ${missingFilter}`,
      )
      .get(...missingParams) as SqlRow | undefined;
    const runsWithoutUsage = readNumber(missing, 'n');

    // `runs_counted` 按协议契约是「该作用域下找到的 run 数（**含**读不出用量的）」，
    // 所以它等于「有行的」+「执行过但没行的」。只数前者会让这个字段与文档不符，也会让
    // `complete` 的两个输入看起来自相矛盾。
    const runsCounted = runsWithRows + runsWithoutUsage;

    return {
      scope: query.scope,
      ...(query.scope !== 'system' && query.scope_id ? { scope_id: query.scope_id } : {}),
      as_of: asOf,
      runs_counted: runsCounted,
      runs_without_usage: runsWithoutUsage,
      complete: runsCounted > 0 && runsWithoutUsage === 0,
      totals,
      by_source: bySource,
    };
  }
}

/**
 * scope → WHERE 子句。`system` 无过滤；`task` / `role` / `run` 各自按列等值。
 *
 * `role` 的 `runs_without_usage` 在 `aggregateTokenUsage` 里刻意**不**加过滤：
 * `events` 表没有角色归属，无法判断缺席的 run 是否属于该角色，所以那个数只能是全局上界。
 * 它偏大不会偏小，于是 `complete` 只会偏保守。
 *
 * `run` 必须按 `run_id` 过滤（而不是像 `role` 那样放着不管），否则单 run 查询会把整个库里
 * 的缺席 run 全算进来，`complete` 永远 false——一个只对单个 run 提问的调用方会得到一个
 * 关于整个库的答案。
 */
function scopeFilter(query: TokenUsageLedgerQuery): { where: string; params: SQLInputValue[] } {
  if (query.scope === 'task') return { where: 'WHERE task_id = ?', params: [requireScopeId(query)] };
  if (query.scope === 'role') return { where: 'WHERE role_id = ?', params: [requireScopeId(query)] };
  if (query.scope === 'run') return { where: 'WHERE run_id = ?', params: [requireScopeId(query)] };
  return { where: '', params: [] };
}

/**
 * `task` / `role` / `run` 必须有 `scope_id`。缺了就抛错，而不是退化成 `task_id = ''` 静默查空
 * ——那会让调用方以为「这个 scope 没有用量」，而真相是它压根没指定 scope。
 */
function requireScopeId(query: TokenUsageLedgerQuery): string {
  if (query.scope_id === undefined) {
    throw new Error(`${query.scope} scope requires scope_id`);
  }
  return query.scope_id;
}

type SqlRow = Record<string, unknown>;

function readTokens(row: SqlRow): RunUsageTokens {
  return {
    input_tokens: readNumber(row, 'input_tokens'),
    output_tokens: readNumber(row, 'output_tokens'),
    cache_creation_input_tokens: readNumber(row, 'cache_creation_input_tokens'),
    cache_read_input_tokens: readNumber(row, 'cache_read_input_tokens'),
    total_input_tokens: readNumber(row, 'total_input_tokens'),
    total_tokens: readNumber(row, 'total_tokens'),
    call_count: readNumber(row, 'call_count'),
  };
}

function emptyTokens(): RunUsageTokens {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: 0,
    total_tokens: 0,
    call_count: 0,
  };
}

function addTokens(target: RunUsageTokens, add: RunUsageTokens): void {
  target.input_tokens += add.input_tokens;
  target.output_tokens += add.output_tokens;
  target.cache_creation_input_tokens += add.cache_creation_input_tokens;
  target.cache_read_input_tokens += add.cache_read_input_tokens;
  target.total_input_tokens += add.total_input_tokens;
  target.total_tokens += add.total_tokens;
  target.call_count += add.call_count;
}

function readNumber(row: SqlRow | undefined, key: string): number {
  const value = row?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
