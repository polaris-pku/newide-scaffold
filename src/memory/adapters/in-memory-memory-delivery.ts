/**
 * InMemoryMemoryDeliveryRepository — MemoryDeliveryRepository 内存适配器
 *
 * 所有 Agent 共享一个实例，交付项与反馈按 role_id 隔离存储于内存 Map。
 * 与 FileMemoryDeliveryRepository 保持同一套幂等语义（同键只留第一条），
 * 使测试替身不会掩盖生产行为差异。
 */
import type {
  ContextDeliveryItem,
  DriverFeedbackRecord,
} from '../schemas';
import type {
  ContextDeliveryFilter,
  DeliverySubmitResult,
  DriverFeedbackFilter,
  MemoryDeliveryRepository,
} from '../ports/memory-delivery';

interface DeliveryStore {
  contexts: Map<string, ContextDeliveryItem>;
  feedback: Map<string, DriverFeedbackRecord>;
}

export class InMemoryMemoryDeliveryRepository implements MemoryDeliveryRepository {
  private readonly stores = new Map<string, DeliveryStore>();

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
