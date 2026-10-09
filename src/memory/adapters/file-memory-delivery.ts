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
 *
 * 并发隔离（工作包 C）：状态转移是「读—判断—写」，必须整体临界。同进程用按文件
 * 串行的 promise 链，跨进程用同名 `.lock` 独占文件（`open(..., 'wx')`）：
 * - 拿不到锁时短暂重试，超过预算就按「本次跳过」返回（不是错误，是并发下的正常结果）；
 * - 锁文件带 `acquired_at`，超过 TTL 视为持有者已崩溃并接管，避免一次崩溃永久锁死；
 * - 释放前核对 token，避免删掉别人重新建立的锁。
 * 单次写的原子性仍由临时文件 + rename 保证：任何时刻磁盘上要么是旧的完整记录，
 * 要么是新的完整记录，不存在半完成状态。
 */
import { mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  ContextDeliveryItemSchema,
  DriverFeedbackRecordSchema,
  type ContextDeliveryItem,
  type DriverFeedbackRecord,
} from '../schemas';
import { nowTimestamp } from '../../core';
import {
  DEFAULT_DELIVERY_LOCK_TTL_MS,
  DEFAULT_DELIVERY_LEASE_MS,
  DEFAULT_DELIVERY_RETRY_POLICY,
  type DeliveryRetryPolicy,
} from '../services/delivery-lifecycle';
import {
  claimNextRecord,
  claimRecord,
  completeRecord,
  failRecord,
  listRetryableRecords,
  renewRecordClaim,
  restoreExpiredRecords,
  retryDeadLetterRecord,
  type DeliveryRecordCandidate,
  type DeliveryRecordStore,
} from '../services/delivery-claim';
import type {
  ClaimedDelivery,
  ContextDeliveryFilter,
  DeliveryChannel,
  DeliveryClaimRequest,
  DeliveryRecordLocator,
  DeliveryRepositoryPolicy,
  DeliverySubmitResult,
  DriverFeedbackFilter,
  MemoryDeliveryRepository,
} from '../ports/memory-delivery';

export interface FileMemoryDeliveryRepositoryOptions {
  /** Agent 状态根目录，由 runtime 注入（非工作区路径） */
  agentStateRoot: string;
  retryPolicy?: Partial<DeliveryRetryPolicy>;
  lease_ms?: number;
  /** 锁文件存活上限：超过它可被另一进程判定为陈旧锁并接管 */
  lock_ttl_ms?: number;
}

const DELIVERY_DIR = 'delivery';
const CONTEXT_DIR = 'context';
const FEEDBACK_DIR = 'feedback';
const LOCK_SUFFIX = '.lock';
/** 抢锁重试预算与间隔：并发下的短暂争用不值得让调用方等太久 */
const LOCK_RETRY_BUDGET_MS = 100;
const LOCK_RETRY_INTERVAL_MS = 5;
/** 一次抢锁最多接管几把陈旧锁（防御性上限，正常路径不会用到第二把） */
const MAX_LOCK_TAKEOVERS = 5;

export class FileMemoryDeliveryRepository implements MemoryDeliveryRepository {
  private readonly agentStateRoot: string;
  private readonly lockTtlMs: number;
  /** 按文件串行的临界区链尾（同进程内先串行，再去争跨进程的锁文件） */
  private readonly locks = new Map<string, Promise<unknown>>();

  readonly policy: DeliveryRepositoryPolicy;

  constructor(options: FileMemoryDeliveryRepositoryOptions) {
    this.agentStateRoot = options.agentStateRoot;
    this.lockTtlMs = options.lock_ttl_ms ?? DEFAULT_DELIVERY_LOCK_TTL_MS;
    this.policy = {
      ...DEFAULT_DELIVERY_RETRY_POLICY,
      ...options.retryPolicy,
      lease_ms: options.lease_ms ?? DEFAULT_DELIVERY_LEASE_MS,
      claim_isolation: 'exclusive_lock_file',
    };
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
    const filePath = this.recordPath('context', item.role_id, item.delivery_id);
    // 提交只在文件**缺席**时写，因此不会覆盖下游已经推进过的状态——这正是
    // 「上游重放不把下游拽回去」的实现方式。两路并发创建同一个键时写入内容可能
    // 各自带一个 created_at，所以写完之后以磁盘上的那一份为准返回。
    const existing = await readJson(filePath, ContextDeliveryItemSchema);
    if (existing) {
      return { item: existing, created: false };
    }
    ContextDeliveryItemSchema.parse(item);
    await writeJsonAtomic(filePath, item);
    const stored = await readJson(filePath, ContextDeliveryItemSchema);
    return { item: stored ?? item, created: true };
  }

  async getContextDelivery(
    role_id: string,
    delivery_id: string,
  ): Promise<ContextDeliveryItem | undefined> {
    assertSafeRoleId(role_id);
    return readJson(this.recordPath('context', role_id, delivery_id), ContextDeliveryItemSchema);
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
    const filePath = this.recordPath('feedback', record.role_id, record.feedback_id);
    const existing = await readJson(filePath, DriverFeedbackRecordSchema);
    if (existing) {
      return { item: existing, created: false };
    }
    DriverFeedbackRecordSchema.parse(record);
    await writeJsonAtomic(filePath, record);
    const stored = await readJson(filePath, DriverFeedbackRecordSchema);
    return { item: stored ?? record, created: true };
  }

  async getDriverFeedback(
    role_id: string,
    feedback_id: string,
  ): Promise<DriverFeedbackRecord | undefined> {
    assertSafeRoleId(role_id);
    return readJson(this.recordPath('feedback', role_id, feedback_id), DriverFeedbackRecordSchema);
  }

  async listDriverFeedback(filter: DriverFeedbackFilter = {}): Promise<DriverFeedbackRecord[]> {
    return this.listRecords(filter.role_id, FEEDBACK_DIR, DriverFeedbackRecordSchema, (record) =>
      matchesFeedbackFilter(record, filter),
    );
  }

  // ── claim / lease / 重试 ─────────────────────────────────────────
  //
  // 与 InMemory 适配器逐条对应：转移规则来自同一个 services/delivery-lifecycle.ts，
  // 临界区由文件锁提供。两处唯一允许的差异是「锁怎么加」。

  async claimDelivery(
    input: DeliveryClaimRequest & { role_id: string; id: string },
  ): Promise<ClaimedDelivery | undefined> {
    const claim = this.claimInput(input);
    if (input.channel === 'feedback') {
      const item = await claimRecord(this.feedbackStore(), input.role_id, input.id, claim);
      return item ? { channel: 'feedback', item } : undefined;
    }
    const item = await claimRecord(this.contextStore(), input.role_id, input.id, claim);
    return item ? { channel: 'context', item } : undefined;
  }

  async claimNextDelivery(input: DeliveryClaimRequest): Promise<ClaimedDelivery | undefined> {
    const claim = this.claimInput(input);
    const scope = input.role_id !== undefined ? { role_id: input.role_id } : {};
    if (input.channel === 'feedback') {
      const item = await claimNextRecord(this.feedbackStore(), { ...claim, ...scope });
      return item ? { channel: 'feedback', item } : undefined;
    }
    const item = await claimNextRecord(this.contextStore(), { ...claim, ...scope });
    return item ? { channel: 'context', item } : undefined;
  }

  async renewDeliveryClaim(
    input: DeliveryRecordLocator & { owner: string; lease_ms?: number; now?: string },
  ): Promise<ClaimedDelivery | undefined> {
    const args = {
      owner: input.owner,
      lease_ms: input.lease_ms ?? this.policy.lease_ms,
      now: input.now ?? nowTimestamp(),
    };
    if (input.channel === 'feedback') {
      const item = await renewRecordClaim(this.feedbackStore(), input.role_id, input.id, args);
      return item ? { channel: 'feedback', item } : undefined;
    }
    const item = await renewRecordClaim(this.contextStore(), input.role_id, input.id, args);
    return item ? { channel: 'context', item } : undefined;
  }

  async completeDelivery(
    input: DeliveryRecordLocator & {
      owner?: string;
      processor_version?: string;
      now?: string;
    },
  ): Promise<ClaimedDelivery | undefined> {
    const args = {
      owner: input.owner,
      processor_version: input.processor_version,
      now: input.now ?? nowTimestamp(),
    };
    if (input.channel === 'feedback') {
      const item = await completeRecord(this.feedbackStore(), input.role_id, input.id, args);
      return item ? { channel: 'feedback', item } : undefined;
    }
    const item = await completeRecord(this.contextStore(), input.role_id, input.id, args);
    return item ? { channel: 'context', item } : undefined;
  }

  async failDelivery(
    input: DeliveryRecordLocator & {
      owner?: string;
      error: string;
      retryable: boolean;
      now?: string;
    },
  ): Promise<ClaimedDelivery | undefined> {
    const args = {
      owner: input.owner,
      error: input.error,
      retryable: input.retryable,
      now: input.now ?? nowTimestamp(),
      policy: this.policy,
    };
    if (input.channel === 'feedback') {
      const item = await failRecord(this.feedbackStore(), input.role_id, input.id, args);
      return item ? { channel: 'feedback', item } : undefined;
    }
    const item = await failRecord(this.contextStore(), input.role_id, input.id, args);
    return item ? { channel: 'context', item } : undefined;
  }

  async retryDeadLetterDelivery(
    input: DeliveryRecordLocator & { now?: string },
  ): Promise<ClaimedDelivery | undefined> {
    const args = { now: input.now ?? nowTimestamp() };
    if (input.channel === 'feedback') {
      const item = await retryDeadLetterRecord(this.feedbackStore(), input.role_id, input.id, args);
      return item ? { channel: 'feedback', item } : undefined;
    }
    const item = await retryDeadLetterRecord(this.contextStore(), input.role_id, input.id, args);
    return item ? { channel: 'context', item } : undefined;
  }

  async restoreExpiredDeliveryClaims(options: {
    channel?: DeliveryChannel;
    role_id?: string;
    now?: string;
  } = {}): Promise<ClaimedDelivery[]> {
    const now = options.now ?? nowTimestamp();
    const inputs = { role_id: options.role_id, now, policy: this.policy };
    const restored: ClaimedDelivery[] = [];
    if (options.channel !== 'feedback') {
      const candidates = await restoreExpiredRecords(this.contextStore(), inputs);
      restored.push(...candidates.map((c) => ({ channel: 'context' as const, item: c.record })));
    }
    if (options.channel !== 'context') {
      const candidates = await restoreExpiredRecords(this.feedbackStore(), inputs);
      restored.push(...candidates.map((c) => ({ channel: 'feedback' as const, item: c.record })));
    }
    return restored;
  }

  async listRetryableDeliveries(options: {
    channel?: DeliveryChannel;
    role_id?: string;
    now?: string;
  } = {}): Promise<ClaimedDelivery[]> {
    const now = options.now ?? nowTimestamp();
    const inputs = { role_id: options.role_id, now };
    const due: ClaimedDelivery[] = [];
    if (options.channel !== 'feedback') {
      const candidates = await listRetryableRecords(this.contextStore(), inputs);
      due.push(...candidates.map((c) => ({ channel: 'context' as const, item: c.record })));
    }
    if (options.channel !== 'context') {
      const candidates = await listRetryableRecords(this.feedbackStore(), inputs);
      due.push(...candidates.map((c) => ({ channel: 'feedback' as const, item: c.record })));
    }
    return due;
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private claimInput(input: DeliveryClaimRequest) {
    return {
      owner: input.owner,
      now: input.now ?? nowTimestamp(),
      lease_ms: input.lease_ms ?? this.policy.lease_ms,
      policy: this.policy,
    };
  }

  private contextStore(): DeliveryRecordStore<ContextDeliveryItem> {
    const schema = ContextDeliveryItemSchema;
    return {
      list: (role_id) =>
        this.listCandidates('context', role_id, schema, (item) => item.delivery_id),
      read: (role_id, id) => readJson(this.recordPath('context', role_id, id), schema),
      write: (role_id, record) =>
        writeJsonAtomic(this.recordPath('context', role_id, record.delivery_id), record),
      lock: (role_id, id, fn) =>
        this.withRecordLock(this.recordPath('context', role_id, id), fn),
    };
  }

  private feedbackStore(): DeliveryRecordStore<DriverFeedbackRecord> {
    const schema = DriverFeedbackRecordSchema;
    return {
      list: (role_id) =>
        this.listCandidates('feedback', role_id, schema, (record) => record.feedback_id),
      read: (role_id, id) => readJson(this.recordPath('feedback', role_id, id), schema),
      write: (role_id, record) =>
        writeJsonAtomic(this.recordPath('feedback', role_id, record.feedback_id), record),
      lock: (role_id, id, fn) =>
        this.withRecordLock(this.recordPath('feedback', role_id, id), fn),
    };
  }

  private recordPath(channel: DeliveryChannel, role_id: string, id: string): string {
    assertSafeRoleId(role_id);
    assertSafeRecordId(id);
    const dir = channel === 'feedback' ? this.feedbackDir(role_id) : this.contextDir(role_id);
    return join(dir, `${id}.json`);
  }

  /**
   * 同一进程内先按文件路径串行（链式等待），再进入跨进程的锁文件临界区。
   *
   * 返回 undefined 表示没抢到锁文件——调用方按「本次跳过」处理。
   */
  private withRecordLock<R>(filePath: string, fn: () => Promise<R>): Promise<R | undefined> {
    const previous = this.locks.get(filePath) ?? Promise.resolve();
    const run = previous.then(async () => {
      const token = `${process.pid}:${randomUUID()}`;
      const lockPath = `${filePath}${LOCK_SUFFIX}`;
      await mkdir(dirname(lockPath), { recursive: true });
      const acquired = await acquireLockFile(lockPath, this.lockTtlMs, token);
      if (!acquired) return undefined;
      try {
        return await fn();
      } finally {
        await releaseLockFile(lockPath, token);
      }
    });
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(filePath, settled);
    void settled.then(() => {
      if (this.locks.get(filePath) === settled) this.locks.delete(filePath);
    });
    return run;
  }

  /** 跨 role 列举候选（带 role_id 与 id，供 claimNext 逐条加锁后重读） */
  private async listCandidates<T extends { role_id: string }>(
    channel: DeliveryChannel,
    role_id: string | undefined,
    schema: { parse: (value: unknown) => T },
    idOf: (record: T) => string,
  ): Promise<Array<DeliveryRecordCandidate<T>>> {
    const roles = role_id !== undefined ? [role_id] : await this.listRoles();
    const candidates: Array<DeliveryRecordCandidate<T>> = [];
    for (const role of roles) {
      assertSafeRoleId(role);
      const dir = join(
        this.agentStateRoot,
        role,
        DELIVERY_DIR,
        channel === 'feedback' ? FEEDBACK_DIR : CONTEXT_DIR,
      );
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        // .lock / .tmp 不是记录；锁文件尤其不能被当成损坏记录反复重试
        if (!entry.endsWith('.json')) continue;
        const id = entry.slice(0, -'.json'.length);
        const record = await readJson(join(dir, entry), schema);
        if (!record) continue;
        candidates.push({ role_id: role, id: idOf(record) || id, record });
      }
    }
    return candidates;
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

/** id 由哈希派生，这里只做一次防线：带分隔符的 id 会写出 role 目录之外 */
function assertSafeRecordId(id: string): void {
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`Invalid delivery record id: ${id}`);
  }
}

/**
 * 争用一把独占锁文件。
 *
 * `open(lockPath, 'wx')` 是唯一的原子动作：创建成功即持有。已存在时先看它是不是
 * 陈旧锁（持有者崩了没删），陈旧就接管；否则短暂退避重试，超过预算放弃。
 *
 * 退避预算只管「等一个活着的持有者」，不管接管：一次磁盘操作在负载高时可能就要
 * 几十毫秒，如果把接管也算进预算，刚清掉陈旧锁就可能因为超时而空手而归——那正是
 * 崩溃恢复最需要成功的时候。接管次数另有很小的上限，免得有人不断重建陈旧锁把这里
 * 变成死循环。
 */
async function acquireLockFile(
  lockPath: string,
  ttlMs: number,
  token: string,
): Promise<boolean> {
  const deadline = Date.now() + LOCK_RETRY_BUDGET_MS;
  let takeovers = 0;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ token, acquired_at: nowTimestamp() }), 'utf8');
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (takeovers < MAX_LOCK_TAKEOVERS && (await isLockStale(lockPath, ttlMs))) {
      takeovers += 1;
      await rm(lockPath, { force: true }).catch(() => undefined);
      continue;
    }
    if (Date.now() >= deadline) return false;
    await delay(LOCK_RETRY_INTERVAL_MS);
  }
}

/** 锁文件不可解析时按陈旧处理：一把读不懂的锁只会永久挡住所有人 */
async function isLockStale(lockPath: string, ttlMs: number): Promise<boolean> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as { acquired_at?: unknown };
    if (typeof parsed.acquired_at !== 'string') return true;
    const acquiredAt = Date.parse(parsed.acquired_at);
    if (Number.isNaN(acquiredAt)) return true;
    return Date.now() - acquiredAt > ttlMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}

/** 只在锁文件仍是自己那把时删除；被别人接管过就让它去 */
async function releaseLockFile(lockPath: string, token: string): Promise<void> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as { token?: unknown };
    if (parsed.token !== token) return;
  } catch {
    return;
  }
  await rm(lockPath, { force: true }).catch(() => undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
