/**
 * 维护侧适配器的契约矩阵（测试脚手架）
 *
 * 两种后端（文件 / 内存）必须给出**同一套**语义——测试替身掩盖生产差异，是交付契约最贵
 * 的一类事故。因此矩阵只写一次，各测试文件按同一份适配器列表跑。
 *
 * 文件实现落状态目录；内存实现只在进程内，它不假装持久化，矩阵里如实体现。
 */
import { FileMemoryDeliveryRepository } from '../adapters/file-memory-delivery';
import { FileMaintenanceRunStore } from '../adapters/file-maintenance-run-store';
import { InMemoryMemoryDeliveryRepository } from '../adapters/in-memory-memory-delivery';
import { InMemoryMaintenanceRunStore } from '../adapters/in-memory-maintenance-run-store';
import type { MemoryDeliveryRepository } from '../ports/memory-delivery';
import type { MaintenanceRunStore } from '../ports/maintenance-run-store';

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
];
