/**
 * SqlPool — 最小 SQL 执行端口
 *
 * 只暴露 PgMemoryRepository 需要的三个能力（query / connect / end），
 * 使 pg.Pool 与 PGlite 适配器都能满足该结构接口。
 * 返回结果只保留 rows 与 rowCount，抹平 pg 与 PGlite 的结果差异。
 */
export interface SqlQueryResult<T = unknown> {
  rows: T[];
  rowCount: number | null;
}

/** 从池中借出的单连接客户端（事务用） */
export interface SqlClient {
  query<T>(text: string, params?: unknown[]): Promise<SqlQueryResult<T>>;
  release(): void;
}

/** 最小 SQL 连接池接口 */
export interface SqlPool {
  query<T>(text: string, params?: unknown[]): Promise<SqlQueryResult<T>>;
  connect(): Promise<SqlClient>;
  end(): Promise<void>;
}
