/**
 * 用量账本 —— 「某个 run / task / role 到底花了多少 token」的**持久**真相。
 *
 * 为什么必须落库而不是继续重算：账本之前的唯一取数是每条 run 目录里的 `summary.json`，
 * 于是历史 = 扫目录重算。但 `.newide/runs` 是一棵**没有任何保留策略**的无界目录树
 * （`src/`、`scripts/`、`.env.example` 都搜不到清理逻辑），往期一旦被清掉，重算出来的
 * 「累计」会**变小**——一个会随清理缩水的数不是累计。本仓库已经做过同样的判断：
 * `driver-stream.jsonl` 带 8 MiB 保留上限会静默丢尾，所以才有
 * `driver-usage.jsonl` 这条「没有保留上限」的追加账本
 * （`driver-usage-projector.ts:222`）。这里把同一判断用在用量上。
 *
 * 形状是**只追加**，而不是一个可变总数，原因是三条具体的失效模式：
 *
 * - **并发丢更新**：可变总数要么读-改-写，要么住在整块覆盖的 JSONB 里。后者正是
 *   `memory_agents.metrics` 的写法（`pg-memory-repository.ts:502-520`：`getMetrics()`
 *   → 内存里改 → `SET metrics = $2::jsonb`），两个 role 并发就会丢一次自增，而丢的时候
 *   不报错、事后也发现不了。只追加是 INSERT，不读-改-写。
 * - **重复计入**：重试 / 重启 / 补写都会再写一次。唯一键
 *   `(run_id, role_id, source, metric)` 让重复写是**覆盖**而不是累加。
 * - **口径被写坏**：每行自带 `source` 与 `metric`，写入时**不做任何跨口径合并**——
 *   proxy 腿与 driver 计费腿永远是两行。聚合是读取时的一层视图，不是一个早就被加错的数。
 *
 * 与 `runs` / `tasks` 之间**刻意不建外键、也没有级联删除**：任务是会被清理的，
 * 而累计用量恰恰必须在清理之后仍然存在。见 `sqlite-token-usage-ledger.ts` 的建表注释。
 */
import type { RunUsageTokens } from '../protocol/run-snapshot';

/** 用量来自哪条腿。两条腿互不相加：`claude_session_jsonl` 只记 driver 自己的计费。 */
export type TokenUsageSource = 'proxy' | 'claude_session_jsonl';

/** 计费口径。名字自带范围，避免出现「总数」这种没有范围的字段。 */
export type TokenUsageMetric = 'billed_tokens';

/** 账本行的 schema 版本。放在端口层，让写入方（`src/app`）不必为了一个常量去依赖 SQLite 实现。 */
export const TOKEN_USAGE_LEDGER_SCHEMA_VERSION = 'newide.token_usage_ledger.v1';

/**
 * 无法归属角色时的 `role_id` 取值。
 *
 * 用空串而**不是** `null`：SQLite 的唯一索引把 `NULL` 视为互不相同，`role_id` 可空会让
 * `(run_id, role_id, source, metric)` 失去幂等性——重复收尾就变成重复计，而且是静默的。
 */
export const UNATTRIBUTED_ROLE_ID = '';

/** 一条账本行：一个 run 在一个角色上、一条口径腿的实测用量。 */
export interface TokenUsageLedgerEntry extends RunUsageTokens {
  run_id: string;
  task_id: string;
  /** 归属角色；取不到时用 `UNATTRIBUTED_ROLE_ID`。 */
  role_id: string;
  source: TokenUsageSource;
  metric: TokenUsageMetric;
  recorded_at: string;
  schema_version: string;
}

/**
 * 可聚合的作用域。
 *
 * `run` 是后来补上的，补它的理由与 P5 立账本的理由是同一个：**单个 run 的用量此前只存在于
 * 进程内存里**。`proxy.llm_usage_recorded` 不落 `coordination.sqlite`（它走 telemetry 通道），
 * 所以进程重启后 `run.getSnapshot` 的 `usage` 整个消失——哪怕账本里这个 run 的行一直在。
 * 一条按 `run_id` 的等值查询就能把那块补回来，主键前缀就是 `run_id`，是索引命中。
 */
export type TokenUsageLedgerScope = 'task' | 'system' | 'role' | 'run';

export interface TokenUsageLedgerQuery {
  scope: TokenUsageLedgerScope;
  /** `task` / `role` / `run` 必填；`system` 忽略。 */
  scope_id?: string;
}

export interface TokenUsageLedgerAggregate {
  scope: TokenUsageLedgerScope;
  scope_id?: string;
  as_of: string;
  /**
   * 本 scope 下找到的 run 数，**含读不出用量的**——与协议契约同义。
   *
   * 等于「账本里有行的 run」+「执行过但账本里没有行的 run」。只数前者会让这个字段与
   * `runs_without_usage` 的语义对不上（一个是子集、一个是全体）。
   */
  runs_counted: number;
  /**
   * 本 scope 内**执行过但账本里没有用量**的 run 数——统计口径是「`events` 表里有
   * `handler.started` 的 run 却不在账本里」，与目录扫描时代用 `audit.jsonl` 判「确实开跑过」
   * 是同一个语义，只是判据换成了持久的表。
   *
   * `role` scope 下这是**全局上界**：`events` 没有角色归属，无法判断某个缺席的 run 是否
   * 属于该角色，所以报的是「整个库里有多少执行过的 run 缺席」。它只会偏大不会偏小，
   * 于是 `runs_counted` 与 `complete` 在 role 下都偏保守。
   *
   * `run` scope 下它是**精确**的 0 或 1：有没有那个 run 的 `handler.started` 是能直接查的。
   * 于是 `complete` 在这里的含义是「这个 run 的用量确实进账了」——调用方必须据此决定是报
   * 数字还是报缺席，而不是把 `totals` 里那堆 0 当成「这个 run 没花钱」。
   */
  runs_without_usage: number;
  /**
   * `runs_counted > 0 && runs_without_usage === 0`。
   *
   * 缺一个 run 就 false，绝不把缺席折算成 0。对 `role` scope 而言，它成立的充要条件正是
   * 「每个执行过的 run 都在账本里」——也只有这时角色求和才是精确的。
   */
  complete: boolean;
  totals: RunUsageTokens;
  /** 按腿分开，永不合并；缺腿就是缺键，不是 0。 */
  by_source: Record<string, RunUsageTokens>;
}

export interface TokenUsageLedgerStore {
  /**
   * 幂等追加。同一 `(run_id, role_id, source, metric)` 重复写入是**覆盖**，不是累加，
   * 因此重复收尾 / 重试 / 回填都不会重复计。
   */
  appendTokenUsage(entries: readonly TokenUsageLedgerEntry[]): void;
  aggregateTokenUsage(query: TokenUsageLedgerQuery, asOf: string): TokenUsageLedgerAggregate;
}
