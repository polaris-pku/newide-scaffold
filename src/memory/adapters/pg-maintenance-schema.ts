/**
 * 维护侧数据库 Schema（交付项 / 反馈 outbox / 维护 run）
 *
 * 与 PgMemoryRepository 的 schema 分开一个入口：交付与 run 存储必须能**独立**使用
 * ——下游消费者只读交付存储时不该被迫先建起记忆实体那几张表。DDL 全部是
 * `CREATE ... IF NOT EXISTS`，可重复执行，因此没有单独的版本号：重复跑就是幂等
 * 迁移，失败也是普通的 SQL 错误（带表名），足以诊断。
 *
 * 时间列一律存 TEXT（ISO 字符串），不存 timestamptz：载荷里的时刻是
 * `z.iso.datetime()` 的严格 ISO 形态，而 timestamptz 往返会把
 * `2026-01-01T00:00:00.000Z` 变成 `2026-01-01 00:00:00+00`，解析直接失败。
 * 列只用于比较与排序，ISO 字符串按字典序比较与时序一致。
 *
 * 载荷（payload）是解析的唯一来源：列只服务 WHERE / ORDER BY，读回记录永远走
 * payload，因此列与载荷不可能各自漂移出一套语义。
 */
import type { SqlPool } from '../ports/sql-pool';

/** 上下文交付项表名 */
export const CONTEXT_DELIVERY_TABLE = 'memory_context_deliveries';
/** Driver 反馈 outbox 表名 */
export const DRIVER_FEEDBACK_TABLE = 'memory_driver_feedback';
/** 维护 run 表名 */
export const MAINTENANCE_RUN_TABLE = 'memory_maintenance_runs';

export async function ensurePgMaintenanceSchema(pool: SqlPool): Promise<void> {
  // 交付项与反馈 outbox 共用同一组状态列，索引也按同一套查询姿势建：
  // 「到期可投递」（status + next_retry_at）与「按 role 收窄」（role_id + status）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CONTEXT_DELIVERY_TABLE} (
      delivery_id TEXT PRIMARY KEY,
      delivery_key TEXT NOT NULL UNIQUE,
      role_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      claim_owner TEXT,
      claim_token TEXT,
      lease_expires_at TEXT,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload JSONB NOT NULL
    );
  `);

  // 上一版建过的表没有 claim_token：CAST 与 fencing 都需要它是一等列，对已存在的库补上。
  // 旧行的该列为 NULL，语义是「这条 processing 记录没有凭据」——照 delivery-lifecycle
  // 的恢复策略，它只能等租约过期被回收后重新 claim，任何人都不可能凭它写终态。
  await pool.query(
    `ALTER TABLE ${CONTEXT_DELIVERY_TABLE} ADD COLUMN IF NOT EXISTS claim_token TEXT;`,
  );

  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_context_deliveries_due_idx
      ON ${CONTEXT_DELIVERY_TABLE} (status, next_retry_at);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_context_deliveries_lease_idx
      ON ${CONTEXT_DELIVERY_TABLE} (status, lease_expires_at);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_context_deliveries_role_idx
      ON ${CONTEXT_DELIVERY_TABLE} (role_id, status, next_retry_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${DRIVER_FEEDBACK_TABLE} (
      feedback_id TEXT PRIMARY KEY,
      feedback_key TEXT NOT NULL UNIQUE,
      role_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      experience_id TEXT NOT NULL,
      feedback_source TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      claim_owner TEXT,
      claim_token TEXT,
      lease_expires_at TEXT,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload JSONB NOT NULL
    );
  `);

  await pool.query(
    `ALTER TABLE ${DRIVER_FEEDBACK_TABLE} ADD COLUMN IF NOT EXISTS claim_token TEXT;`,
  );

  // 归并查询的落点：按关联键找「这条经验的反馈有没有先到」（role_id + experience_id），
  // 以及按状态找还没归并的积压（status + next_retry_at）。
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_driver_feedback_experience_idx
      ON ${DRIVER_FEEDBACK_TABLE} (role_id, experience_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_driver_feedback_due_idx
      ON ${DRIVER_FEEDBACK_TABLE} (status, next_retry_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MAINTENANCE_RUN_TABLE} (
      run_id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      payload JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_maintenance_runs_job_idx
      ON ${MAINTENANCE_RUN_TABLE} (job_type, started_at);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_maintenance_runs_status_idx
      ON ${MAINTENANCE_RUN_TABLE} (status, started_at);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_maintenance_runs_worker_idx
      ON ${MAINTENANCE_RUN_TABLE} (worker_id, started_at);
  `);
}
