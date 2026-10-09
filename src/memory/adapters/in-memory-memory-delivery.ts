/**
 * InMemoryMemoryDeliveryRepository — MemoryDeliveryRepository 内存适配器
 *
 * 所有 Agent 共享一个实例，交付项与反馈按 role_id 隔离存储于内存 Map。
 * 与 FileMemoryDeliveryRepository 保持同一套幂等语义与同一套 claim/lease/重试
 * 语义（转移规则来自 services/delivery-lifecycle.ts），使测试替身不会掩盖
 * 生产行为差异。
 *
 * 并发隔离：单进程内用「按 key 串行的 promise 链」保证读—判断—写的临界区，
 * 因此不需要文件锁；capabilities 会如实报告 `claim_isolation: 'process_mutex'`。
 */
import {
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
import { nowTimestamp } from '../../core';
import type { ContextDeliveryItem, DriverFeedbackRecord } from '../schemas';
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

interface DeliveryStore {
  contexts: Map<string, ContextDeliveryItem>;
  feedback: Map<string, DriverFeedbackRecord>;
}

export interface InMemoryMemoryDeliveryRepositoryOptions {
  retryPolicy?: Partial<DeliveryRetryPolicy>;
  lease_ms?: number;
}

export class InMemoryMemoryDeliveryRepository implements MemoryDeliveryRepository {
  private readonly stores = new Map<string, DeliveryStore>();
  /** 按 key 串行的临界区链尾；用于把读—判断—写变成原子操作 */
  private readonly locks = new Map<string, Promise<unknown>>();

  readonly policy: DeliveryRepositoryPolicy;

  constructor(options: InMemoryMemoryDeliveryRepositoryOptions = {}) {
    this.policy = {
      ...DEFAULT_DELIVERY_RETRY_POLICY,
      ...options.retryPolicy,
      lease_ms: options.lease_ms ?? DEFAULT_DELIVERY_LEASE_MS,
      claim_isolation: 'process_mutex',
    };
  }

  async ensureAgent(role_id: string): Promise<void> {
    this.getOrCreateStore(role_id);
  }

  async deleteAgent(role_id: string): Promise<void> {
    // 未初始化过交付存储的 Agent 静默成功（与 BufferRepository 对齐）
    this.stores.delete(role_id);
  }

  async submitContextDelivery(
    item: ContextDeliveryItem,
  ): Promise<DeliverySubmitResult<ContextDeliveryItem>> {
    const store = this.getOrCreateStore(item.role_id);
    const existing = store.contexts.get(item.delivery_id);
    if (existing) {
      return { item: existing, created: false };
    }
    store.contexts.set(item.delivery_id, { ...item });
    return { item: { ...item }, created: true };
  }

  async getContextDelivery(
    role_id: string,
    delivery_id: string,
  ): Promise<ContextDeliveryItem | undefined> {
    const item = this.stores.get(role_id)?.contexts.get(delivery_id);
    return item ? { ...item } : undefined;
  }

  async listContextDeliveries(
    filter: ContextDeliveryFilter = {},
  ): Promise<ContextDeliveryItem[]> {
    const items: ContextDeliveryItem[] = [];
    for (const store of this.stores.values()) {
      for (const item of store.contexts.values()) {
        if (matchesContextFilter(item, filter)) items.push({ ...item });
      }
    }
    return items.sort((left, right) => left.delivery_key.localeCompare(right.delivery_key));
  }

  async submitDriverFeedback(
    record: DriverFeedbackRecord,
  ): Promise<DeliverySubmitResult<DriverFeedbackRecord>> {
    const store = this.getOrCreateStore(record.role_id);
    const existing = store.feedback.get(record.feedback_id);
    if (existing) {
      return { item: { ...existing }, created: false };
    }
    store.feedback.set(record.feedback_id, { ...record });
    return { item: { ...record }, created: true };
  }

  async getDriverFeedback(
    role_id: string,
    feedback_id: string,
  ): Promise<DriverFeedbackRecord | undefined> {
    const record = this.stores.get(role_id)?.feedback.get(feedback_id);
    return record ? { ...record } : undefined;
  }

  async listDriverFeedback(filter: DriverFeedbackFilter = {}): Promise<DriverFeedbackRecord[]> {
    const records: DriverFeedbackRecord[] = [];
    for (const store of this.stores.values()) {
      for (const record of store.feedback.values()) {
        if (matchesFeedbackFilter(record, filter)) records.push({ ...record });
      }
    }
    return records.sort((left, right) => left.feedback_key.localeCompare(right.feedback_key));
  }

  // ── claim / lease / 重试 ─────────────────────────────────────────
  //
  // 每个方法都显式写两条通道的分支，而不是用泛型分派：分派需要断言返回值类型，
  // 而断言正是「两条通道其实已经被当成一回事」的伪装。分支写开之后，类型检查
  // 仍然能挡住把 feedback 记录当成 context 记录返回。

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
    return {
      list: async (role_id) =>
        this.entries<ContextDeliveryItem>(
          role_id,
          (store) => store.contexts.values(),
          (item) => item.delivery_id,
        ),
      read: async (role_id, id) => {
        const item = this.stores.get(role_id)?.contexts.get(id);
        return item ? { ...item } : undefined;
      },
      write: async (role_id, record) => {
        this.getOrCreateStore(role_id).contexts.set(record.delivery_id, { ...record });
      },
      lock: (role_id, id, fn) => this.withKeyLock(`context:${role_id}:${id}`, fn),
    };
  }

  private feedbackStore(): DeliveryRecordStore<DriverFeedbackRecord> {
    return {
      list: async (role_id) =>
        this.entries<DriverFeedbackRecord>(
          role_id,
          (store) => store.feedback.values(),
          (record) => record.feedback_id,
        ),
      read: async (role_id, id) => {
        const record = this.stores.get(role_id)?.feedback.get(id);
        return record ? { ...record } : undefined;
      },
      write: async (role_id, record) => {
        this.getOrCreateStore(role_id).feedback.set(record.feedback_id, { ...record });
      },
      lock: (role_id, id, fn) => this.withKeyLock(`feedback:${role_id}:${id}`, fn),
    };
  }

  private entries<T>(
    role_id: string | undefined,
    select: (store: DeliveryStore) => Iterable<T>,
    idOf: (record: T) => string,
  ): Promise<Array<DeliveryRecordCandidate<T>>> {
    const candidates: DeliveryRecordCandidate<T>[] = [];
    const roleIds = role_id !== undefined ? [role_id] : [...this.stores.keys()];
    for (const role of roleIds) {
      const store = this.stores.get(role);
      if (!store) continue;
      for (const record of select(store)) {
        candidates.push({ role_id: role, id: idOf(record), record: { ...record } });
      }
    }
    return Promise.resolve(candidates);
  }

  /**
   * 按 key 串行的临界区：把 fn 接到该 key 的链尾，保证同一记录上的
   * 读—判断—写不会交错。链尾完成后清理，避免长跑进程里 Map 无界增长。
   */
  private withKeyLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }

  private getOrCreateStore(role_id: string): DeliveryStore {
    let store = this.stores.get(role_id);
    if (!store) {
      store = { contexts: new Map(), feedback: new Map() };
      this.stores.set(role_id, store);
    }
    return store;
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
