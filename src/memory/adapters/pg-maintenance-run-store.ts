/**
 * PgMaintenanceRunStore — MaintenanceRunStore 数据库适配器
 *
 * 与 File / InMemory 适配器共用 services/maintenance-run-lifecycle.ts 的转移规则。
 * 收尾的「终态只写一次」由**条件更新**保证：`UPDATE ... WHERE status = 'running'`
 * 匹配不到行就说明这条 run 已经被收尾过，返回 undefined 而不是覆盖先到的结论。
 *
 * 时间列存 TEXT（ISO 字符串），理由见 pg-maintenance-schema.ts：timestamptz 的往返
 * 会把 ISO 形态改掉，而载荷要求严格的 `z.iso.datetime()`。
 */
import { nowTimestamp } from '../../core';
import { MAINTENANCE_RUN_TABLE, ensurePgMaintenanceSchema } from './pg-maintenance-schema';
import { MaintenanceRunSchema, type MaintenanceFailure, type MaintenanceRun } from '../schemas';
import {
  applyMaintenanceRunLimit,
  completeMaintenanceRun,
  createMaintenanceRun,
  failMaintenanceRun,
} from '../services/maintenance-run-lifecycle';
import type { SqlPool } from '../ports/sql-pool';
import type {
  FinishMaintenanceRunInput,
  MaintenanceRunQuery,
  MaintenanceRunStore,
  StartMaintenanceRunInput,
} from '../ports/maintenance-run-store';

export interface PgMaintenanceRunStoreOptions {
  pool: SqlPool;
  /** 关闭懒建表（由调用方自行 ensurePgMaintenanceSchema）；缺省 true */
  autoMigrate?: boolean;
}

export class PgMaintenanceRunStore implements MaintenanceRunStore {
  private readonly pool: SqlPool;
  private readonly autoMigrate: boolean;
  private schemaReady: Promise<void> | undefined;

  constructor(options: PgMaintenanceRunStoreOptions) {
    this.pool = options.pool;
    this.autoMigrate = options.autoMigrate ?? true;
  }

  async start(input: StartMaintenanceRunInput): Promise<MaintenanceRun> {
    await this.ensureSchema();
    const run = createMaintenanceRun(input, input.now ?? nowTimestamp());
    try {
      await this.pool.query(
        `INSERT INTO ${MAINTENANCE_RUN_TABLE}
           (run_id, job_type, status, worker_id, started_at, finished_at, payload)
         VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb)`,
        [run.run_id, run.job_type, run.status, run.worker_id, run.started_at, JSON.stringify(run)],
      );
    } catch (error) {
      // 主键撞上就是「同一次运行被开了两遍」，如实报错而不是接着写第二份
      throw new Error(
        `Maintenance run already exists: ${run.run_id} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return run;
  }

  finish(
    run_id: string,
    result: FinishMaintenanceRunInput,
  ): Promise<MaintenanceRun | undefined> {
    return this.settle(run_id, (run, now) => completeMaintenanceRun(run, result, now), result.now);
  }

  fail(
    run_id: string,
    error: MaintenanceFailure,
    result: FinishMaintenanceRunInput = {},
  ): Promise<MaintenanceRun | undefined> {
    return this.settle(
      run_id,
      (run, now) => failMaintenanceRun(run, error, result, now),
      result.now,
    );
  }

  async get(run_id: string): Promise<MaintenanceRun | undefined> {
    await this.ensureSchema();
    const result = await this.pool.query<{ payload: unknown }>(
      `SELECT payload FROM ${MAINTENANCE_RUN_TABLE} WHERE run_id = $1`,
      [run_id],
    );
    return result.rows[0] ? parseRun(result.rows[0].payload) : undefined;
  }

  async list(query: MaintenanceRunQuery = {}): Promise<MaintenanceRun[]> {
    await this.ensureSchema();
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [
      ['job_type', query.job_type],
      ['status', query.status],
      ['worker_id', query.worker_id],
    ] as const) {
      if (value === undefined) continue;
      params.push(value);
      clauses.push(`${column} = $${String(params.length)}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query<{ payload: unknown }>(
      `SELECT payload FROM ${MAINTENANCE_RUN_TABLE}${where} ORDER BY started_at, run_id`,
      params,
    );
    const runs = result.rows.flatMap((row) => {
      const run = parseRun(row.payload);
      return run ? [run] : [];
    });
    // 过滤与排序已经在 SQL 里做完（那是索引的用武之地），limit 的「最近 N 条」
    // 语义拿共享实现来定，免得两处对 limit 有各自的解释
    return applyMaintenanceRunLimit(runs, query.limit);
  }

  /**
   * 收尾：只从 `running` 出发的条件更新。
   *
   * 计数与终态一起落在 payload 里，`status` 列同步更新——列是查询用的，payload 是
   * 解析用的，两者由同一次写落定，不可能只更新一半。
   */
  private async settle(
    run_id: string,
    apply: (run: MaintenanceRun, now: string) => MaintenanceRun | undefined,
    now: string | undefined,
  ): Promise<MaintenanceRun | undefined> {
    const current = await this.get(run_id);
    if (!current) return undefined;
    const next = apply(current, now ?? nowTimestamp());
    if (!next) return undefined;
    const result = await this.pool.query(
      `UPDATE ${MAINTENANCE_RUN_TABLE}
         SET status = $1, finished_at = $2, payload = $3::jsonb
       WHERE run_id = $4 AND status = 'running'`,
      [next.status, next.finished_at ?? null, JSON.stringify(next), run_id],
    );
    return result.rowCount === 1 ? next : undefined;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.autoMigrate) return;
    this.schemaReady ??= ensurePgMaintenanceSchema(this.pool);
    await this.schemaReady;
  }
}

function parseRun(payload: unknown): MaintenanceRun | undefined {
  try {
    return MaintenanceRunSchema.parse(typeof payload === 'string' ? JSON.parse(payload) : payload);
  } catch {
    return undefined;
  }
}
