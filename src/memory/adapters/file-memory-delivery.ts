/**
 * FileMemoryDeliveryRepository — MemoryDeliveryRepository 文件持久化适配器
 *
 * 交付项与反馈落盘在应用状态目录（非用户工作区）：
 * `{agentStateRoot}/{role_id}/delivery/{context,feedback}/<id>.json`。
 * 与 BufferRepository 同处一个 role 目录树，因此 deleteAgent 能一次清干净。
 *
 * 幂等靠文件名：id 由稳定键哈希而来，同键的第二次提交在磁盘上看见同名文件，
 * 读回已有内容并原样返回——不覆盖、不改状态，上游重放不会把下游已推进的
 * 交付项拽回去。
 */
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ContextDeliveryItemSchema,
  DriverFeedbackRecordSchema,
  type ContextDeliveryItem,
  type DriverFeedbackRecord,
} from '../schemas';
import type {
  ContextDeliveryFilter,
  DeliverySubmitResult,
  DriverFeedbackFilter,
  MemoryDeliveryRepository,
} from '../ports/memory-delivery';

export interface FileMemoryDeliveryRepositoryOptions {
  /** Agent 状态根目录，由 runtime 注入（非工作区路径） */
  agentStateRoot: string;
}

const DELIVERY_DIR = 'delivery';
const CONTEXT_DIR = 'context';
const FEEDBACK_DIR = 'feedback';

export class FileMemoryDeliveryRepository implements MemoryDeliveryRepository {
  private readonly agentStateRoot: string;

  constructor(options: FileMemoryDeliveryRepositoryOptions) {
    this.agentStateRoot = options.agentStateRoot;
  }

  async ensureAgent(role_id: string): Promise<void> {
    assertSafeRoleId(role_id);
    await mkdir(this.contextDir(role_id), { recursive: true });
    await mkdir(this.feedbackDir(role_id), { recursive: true });
  }

  async deleteAgent(role_id: string): Promise<void> {
    assertSafeRoleId(role_id);
    // 整个 Agent 状态目录（含 buffer 与 delivery）一并移除；不存在时静默成功
    await rm(join(this.agentStateRoot, role_id), { recursive: true, force: true });
  }

  async submitContextDelivery(
    item: ContextDeliveryItem,
  ): Promise<DeliverySubmitResult<ContextDeliveryItem>> {
    assertSafeRoleId(item.role_id);
    const dir = this.contextDir(item.role_id);
    const filePath = join(dir, `${item.delivery_id}.json`);
    const existing = await readJson(filePath, ContextDeliveryItemSchema);
    if (existing) {
      return { item: existing, created: false };
    }
    ContextDeliveryItemSchema.parse(item);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(filePath, item);
    return { item, created: true };
  }

  async getContextDelivery(
    role_id: string,
    delivery_id: string,
  ): Promise<ContextDeliveryItem | undefined> {
    assertSafeRoleId(role_id);
    return readJson(join(this.contextDir(role_id), `${delivery_id}.json`), ContextDeliveryItemSchema);
  }

  async listContextDeliveries(
    filter: ContextDeliveryFilter = {},
  ): Promise<ContextDeliveryItem[]> {
    return this.listRecords(filter.role_id, CONTEXT_DIR, ContextDeliveryItemSchema, (item) =>
      matchesContextFilter(item, filter),
    );
  }

  async submitDriverFeedback(
    record: DriverFeedbackRecord,
  ): Promise<DeliverySubmitResult<DriverFeedbackRecord>> {
    assertSafeRoleId(record.role_id);
    const dir = this.feedbackDir(record.role_id);
    const filePath = join(dir, `${record.feedback_id}.json`);
    const existing = await readJson(filePath, DriverFeedbackRecordSchema);
    if (existing) {
      return { item: existing, created: false };
    }
    DriverFeedbackRecordSchema.parse(record);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(filePath, record);
    return { item: record, created: true };
  }

  async getDriverFeedback(
    role_id: string,
    feedback_id: string,
  ): Promise<DriverFeedbackRecord | undefined> {
    assertSafeRoleId(role_id);
    return readJson(
      join(this.feedbackDir(role_id), `${feedback_id}.json`),
      DriverFeedbackRecordSchema,
    );
  }

  async listDriverFeedback(filter: DriverFeedbackFilter = {}): Promise<DriverFeedbackRecord[]> {
    return this.listRecords(filter.role_id, FEEDBACK_DIR, DriverFeedbackRecordSchema, (record) =>
      matchesFeedbackFilter(record, filter),
    );
  }

  /**
   * 跨 role 列举：给出 role_id 就只读那一个目录，否则遍历状态根下的每个 role。
   *
   * 逐目录读失败（目录不存在）按「没有记录」处理：交付存储是懒初始化的，
   * 未产出过交付的 Agent 不该让整次列举报错。
   */
  private async listRecords<T>(
    role_id: string | undefined,
    kind: typeof CONTEXT_DIR | typeof FEEDBACK_DIR,
    schema: { parse: (value: unknown) => T },
    accept: (record: T) => boolean,
  ): Promise<T[]> {
    const roles = role_id !== undefined ? [role_id] : await this.listRoles();
    const records: T[] = [];
    for (const role of roles) {
      assertSafeRoleId(role);
      const dir = join(this.agentStateRoot, role, DELIVERY_DIR, kind);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        if (!entry.endsWith('.json')) continue;
        const record = await readJson(join(dir, entry), schema);
        if (record && accept(record)) records.push(record);
      }
    }
    return records;
  }

  private async listRoles(): Promise<string[]> {
    try {
      const entries = await readdir(this.agentStateRoot, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private contextDir(role_id: string): string {
    return join(this.agentStateRoot, role_id, DELIVERY_DIR, CONTEXT_DIR);
  }

  private feedbackDir(role_id: string): string {
    return join(this.agentStateRoot, role_id, DELIVERY_DIR, FEEDBACK_DIR);
  }
}

function assertSafeRoleId(role_id: string): void {
  if (!role_id || role_id.includes('/') || role_id.includes('\\') || role_id.includes('..')) {
    throw new Error(`Invalid role_id for delivery storage: ${role_id}`);
  }
}

/** 读一条记录；文件不存在或内容不可解析时返回 undefined（损坏记录不该拦住列举） */
async function readJson<T>(
  filePath: string,
  schema: { parse: (value: unknown) => T },
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    await rename(tmpPath, filePath);
  } catch {
    await unlink(filePath).catch(() => undefined);
    await rename(tmpPath, filePath);
  }
}

function matchesContextFilter(
  item: ContextDeliveryItem,
  filter: ContextDeliveryFilter,
): boolean {
  if (filter.role_id !== undefined && item.role_id !== filter.role_id) return false;
  if (filter.task_id !== undefined && item.task_id !== filter.task_id) return false;
  if (filter.status !== undefined && item.status !== filter.status) return false;
  return true;
}

function matchesFeedbackFilter(
  record: DriverFeedbackRecord,
  filter: DriverFeedbackFilter,
): boolean {
  if (filter.role_id !== undefined && record.role_id !== filter.role_id) return false;
  if (filter.task_id !== undefined && record.task_id !== filter.task_id) return false;
  if (filter.experience_id !== undefined && record.experience_id !== filter.experience_id) {
    return false;
  }
  if (filter.status !== undefined && record.status !== filter.status) return false;
  return true;
}
