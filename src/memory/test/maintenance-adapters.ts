/**
 * 维护侧适配器的契约矩阵（测试脚手架）
 *
 * 三种后端（内存 / 文件 / PGlite+PostgreSQL）必须给出**同一套**语义——测试替身掩盖
 * 生产差异，是交付契约最贵的一类事故。因此矩阵只写一次，各测试文件按同一份
 * 适配器列表跑；新增一种后端只要往这里加一条。
 *
 * PGlite 是嵌入式 WASM PostgreSQL（无需 Docker / 外部服务），因此这条腿在 CI 里
 * 始终真的跑，而不是被环境跳过。一份进程内数据库按测试文件共享，用例之间用
 * TRUNCATE 隔离——每例新建一个 PGlite 实例要多花一秒钟起步的启动成本，没必要。
 */
import { FileMemoryDeliveryRepository } from '../adapters/file-memory-delivery';
import { FileMaintenanceRunStore } from '../adapters/file-maintenance-run-store';
import { InMemoryMemoryDeliveryRepository } from '../adapters/in-memory-memory-delivery';
import { InMemoryMaintenanceRunStore } from '../adapters/in-memory-maintenance-run-store';
import { PgMemoryDeliveryRepository } from '../adapters/pg-memory-delivery';
import { PgMaintenanceRunStore } from '../adapters/pg-maintenance-run-store';
import {
  CONTEXT_DELIVERY_TABLE,
  DRIVER_FEEDBACK_TABLE,
  MAINTENANCE_RUN_TABLE,
  ensurePgMaintenanceSchema,
} from '../adapters/pg-maintenance-schema';
import { createPGlitePool } from '../adapters/pglite-pool';
import type { SqlPool } from '../ports/sql-pool';
import type { ContextDeliveryItem } from '../schemas';
import type { MemoryDeliveryRepository } from '../ports/memory-delivery';
import type { MaintenanceRunStore } from '../ports/maintenance-run-store';

let pgPool: SqlPool | undefined;

/** 一份进程内 PGlite 数据库，所有数据库适配器用例共享 */
export async function pgMaintenancePool(): Promise<SqlPool> {
  pgPool ??= await createPGlitePool();
  await ensurePgMaintenanceSchema(pgPool);
  return pgPool;
}

/**
 * 清空数据库腿的三张表。
 *
 * 用例之间必须隔离：交付项、反馈与 run 在库里是全局可查的，上一例留下的 pending
 * 会让下一例的 `claimNextDelivery` 拿到不该属于它的记录。
 */
export async function resetPgMaintenanceTables(): Promise<void> {
  const pool = pgPool;
  if (!pool) return;
  await pool.query(`TRUNCATE ${CONTEXT_DELIVERY_TABLE}`);
  await pool.query(`TRUNCATE ${DRIVER_FEEDBACK_TABLE}`);
  await pool.query(`TRUNCATE ${MAINTENANCE_RUN_TABLE}`);
}

/** 关掉进程内数据库（测试文件收尾用） */
export async function closePgMaintenancePool(): Promise<void> {
  const pool = pgPool;
  pgPool = undefined;
  await pool?.end();
}

/**
 * 直接往库里塞一条**历史形状**的上下文交付项（工作包 B 落盘的字段集）。
 *
 * 刻意绕过适配器与 zod 的默认值：要验的是「旧数据落到新表后还能不能被读进来」，
 * 经由适配器写就等于已经套上了今天的字段集，那测的是自己。
 */
export async function insertLegacyContextDeliveryRow(item: ContextDeliveryItem): Promise<void> {
  const pool = await pgMaintenancePool();
  // 状态机字段一个都不给：库里靠默认值与可空列兜住，读回时由 schema 的默认值补齐
  await pool.query(
    `INSERT INTO ${CONTEXT_DELIVERY_TABLE}
       (delivery_id, delivery_key, role_id, task_id, status, created_at, updated_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      item.delivery_id,
      item.delivery_key,
      item.role_id,
      item.task_id,
      item.status,
      item.created_at,
      item.updated_at,
      JSON.stringify(item),
    ],
  );
}

export interface DeliveryAdapterCase {
  name: string;
  /** 开一个指向该存储的适配器实例；root 是文件实现的状态目录 */
  create: (root: string) => Promise<MemoryDeliveryRepository>;
  /**
   * 重启：新实例指向**同一份存储**。内存实现没有持久层，只能原样返回上一个实例
   * ——这正是它不该被当成生产存储的原因，矩阵里如实体现而不是假装重启过。
   */
  reopen: (root: string, previous: MemoryDeliveryRepository) => Promise<MemoryDeliveryRepository>;
}

export const DELIVERY_ADAPTERS: DeliveryAdapterCase[] = [
  {
    name: 'FileMemoryDeliveryRepository',
    create: (root) => Promise.resolve(new FileMemoryDeliveryRepository({ agentStateRoot: root })),
    reopen: (root) => Promise.resolve(new FileMemoryDeliveryRepository({ agentStateRoot: root })),
  },
  {
    name: 'InMemoryMemoryDeliveryRepository',
    create: () => Promise.resolve(new InMemoryMemoryDeliveryRepository()),
    reopen: (_root, previous) => Promise.resolve(previous),
  },
  {
    name: 'PgMemoryDeliveryRepository（PGlite）',
    create: () => pgMaintenancePool().then((pool) => new PgMemoryDeliveryRepository({ pool })),
    reopen: () => pgMaintenancePool().then((pool) => new PgMemoryDeliveryRepository({ pool })),
  },
];

export interface RunStoreAdapterCase {
  name: string;
  /** 开一个指向该存储的 run store；root 是文件实现的目录 */
  create: (root: string) => Promise<MaintenanceRunStore>;
  /**
   * 重启：新实例指向同一份存储。内存实现只能原样返回上一个实例——它不假装持久化，
   * 契约测试里也因此不把「重启后还在」当它的义务。
   */
  reopen: (root: string, previous: MaintenanceRunStore) => Promise<MaintenanceRunStore>;
  /** 该后端是否真的持久化（内存实现为 false） */
  durable: boolean;
}

export const RUN_STORE_ADAPTERS: RunStoreAdapterCase[] = [
  {
    name: 'FileMaintenanceRunStore',
    create: (root) => Promise.resolve(new FileMaintenanceRunStore({ root })),
    reopen: (root) => Promise.resolve(new FileMaintenanceRunStore({ root })),
    durable: true,
  },
  {
    name: 'InMemoryMaintenanceRunStore',
    create: () => Promise.resolve(new InMemoryMaintenanceRunStore()),
    reopen: (_root, previous) => Promise.resolve(previous),
    durable: false,
  },
  {
    name: 'PgMaintenanceRunStore（PGlite）',
    create: () => pgMaintenancePool().then((pool) => new PgMaintenanceRunStore({ pool })),
    reopen: () => pgMaintenancePool().then((pool) => new PgMaintenanceRunStore({ pool })),
    durable: true,
  },
];
