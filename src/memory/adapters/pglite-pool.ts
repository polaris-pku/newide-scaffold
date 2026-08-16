/**
 * PGlitePool — SqlPool 的 PGlite 嵌入式适配器
 *
 * 使用 @electric-sql/pglite（WASM PostgreSQL）在进程内运行真实 Postgres，
 * 加载 pgvector 扩展，因此 PgMemoryRepository 的 SQL 与 pgvector 语义完全一致，
 * 且不需要安装/启动外部数据库或 Docker。数据可持久化到本地目录（dataDir），
 * 省略 dataDir 时使用内存数据库。
 */
import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import type { SqlClient, SqlPool, SqlQueryResult } from '../ports/sql-pool';

/** PGlitePool 构造选项 */
export interface PGlitePoolOptions {
  /** 数据库文件目录；省略则使用内存数据库（进程退出后数据丢失） */
  dataDir?: string;
}

/** PGlitePool 工厂：创建并等待数据库就绪，返回 SqlPool 结构接口 */
export async function createPGlitePool(
  options: PGlitePoolOptions = {},
): Promise<SqlPool> {
  if (options.dataDir) {
    await mkdir(options.dataDir, { recursive: true });
  }
  const db = new PGlite({
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    extensions: { vector },
  });
  await db.waitReady;
  return new PGlitePool(db);
}

/**
 * PGlitePool — 将 PGlite 的 query API 归一化为 SqlPool。
 * PGlite 是单连接数据库，connect() 返回共享同一实例的客户端，
 * release() 为空操作；BEGIN/COMMIT/ROLLBACK 通过普通 query 执行。
 */
export class PGlitePool implements SqlPool {
  constructor(private readonly db: PGlite) {}

  async query<T>(text: string, params?: unknown[]): Promise<SqlQueryResult<T>> {
    const result = await this.db.query<T>(text, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.affectedRows ?? null,
    };
  }

  async connect(): Promise<SqlClient> {
    const query = async <T>(text: string, params?: unknown[]): Promise<SqlQueryResult<T>> =>
      this.query<T>(text, params);
    return {
      query,
      release: () => undefined,
    };
  }

  async end(): Promise<void> {
    await this.db.close();
  }
}
