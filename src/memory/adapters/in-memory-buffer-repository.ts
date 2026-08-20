/**
 * InMemoryBufferRepository — BufferRepository 内存适配器
 *
 * 所有 Agent 共享一个实例，buffer 数据按 role_id 隔离存储于内存 Map。
 * 无物理文件路径；生产向持久化见 FileBufferRepository。
 */
import type { BufferMeta, BufferSnapshot, AgentContextSnapshot } from '../schemas';
import type { BufferRepository, SaveBufferResult } from '../ports/buffer-repository';

interface PendingEntry {
  snapshot: BufferSnapshot;
  agentContext?: AgentContextSnapshot;
}

interface BufferStore {
  bufferMeta: BufferMeta;
  pending: Map<number, PendingEntry>;
}

function createEmptyBufferMeta(role_id: string): BufferMeta {
  return {
    role_id,
    pending_count: 0,
    cursor: 0,
    total_processed: 0,
    total_dead_letters: 0,
  };
}

export class InMemoryBufferRepository implements BufferRepository {
  private readonly stores = new Map<string, BufferStore>();

  async ensureAgent(role_id: string): Promise<void> {
    this.getOrCreateStore(role_id);
  }

  async deleteAgent(role_id: string): Promise<void> {
    // 未初始化过 buffer 的 Agent 静默成功
    this.stores.delete(role_id);
  }

  async saveBufferSnapshot(
    role_id: string,
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<SaveBufferResult> {
    const store = this.getOrCreateStore(role_id);
    const seq = store.bufferMeta.cursor + 1;
    store.bufferMeta.cursor = seq;
    store.bufferMeta.pending_count += 1;

    const storedSnapshot: BufferSnapshot = agentContext
      ? { ...snapshot, context_snapshot_ref: String(seq) }
      : snapshot;

    const storedAgentContext = agentContext
      ? {
          ...agentContext,
          driver_calls: agentContext.driver_calls.map((call) => ({
            ...call,
            driver_return_ref: `report_${seq}.json`,
          })),
        }
      : undefined;

    store.pending.set(seq, {
      snapshot: storedSnapshot,
      ...(storedAgentContext ? { agentContext: storedAgentContext } : {}),
    });

    return {
      seq,
      snapshot: storedSnapshot,
      ...(storedAgentContext ? { agent_context_snapshot: storedAgentContext } : {}),
    };
  }

  async getBufferMeta(role_id: string): Promise<BufferMeta> {
    return { ...this.requireStore(role_id).bufferMeta };
  }

  async markBufferProcessed(role_id: string, seq: number): Promise<void> {
    const store = this.requireStore(role_id);
    const entry = store.pending.get(seq);
    if (!entry) {
      throw new Error(`Pending buffer not found: seq=${seq}`);
    }
    store.pending.delete(seq);
    store.bufferMeta.pending_count = Math.max(0, store.bufferMeta.pending_count - 1);
    store.bufferMeta.total_processed += 1;
    entry.snapshot.extraction_status = 'processed';
  }

  async markBufferDeadLetter(role_id: string, seq: number): Promise<void> {
    const store = this.requireStore(role_id);
    const entry = store.pending.get(seq);
    if (!entry) {
      throw new Error(`Pending buffer not found: seq=${seq}`);
    }
    store.pending.delete(seq);
    store.bufferMeta.pending_count = Math.max(0, store.bufferMeta.pending_count - 1);
    store.bufferMeta.total_dead_letters += 1;
    entry.snapshot.extraction_status = 'dead_letter';
  }

  async listPendingBufferSeqs(role_id: string): Promise<number[]> {
    return [...this.requireStore(role_id).pending.keys()].sort((a, b) => a - b);
  }

  async getPendingBuffer(
    role_id: string,
    seq: number,
  ): Promise<{ snapshot: BufferSnapshot; agentContext?: AgentContextSnapshot } | undefined> {
    const entry = this.requireStore(role_id).pending.get(seq);
    if (!entry) {
      return undefined;
    }
    return {
      snapshot: entry.snapshot,
      ...(entry.agentContext ? { agentContext: entry.agentContext } : {}),
    };
  }

  private getOrCreateStore(role_id: string): BufferStore {
    let store = this.stores.get(role_id);
    if (!store) {
      store = {
        bufferMeta: createEmptyBufferMeta(role_id),
        pending: new Map(),
      };
      this.stores.set(role_id, store);
    }
    return store;
  }

  private requireStore(role_id: string): BufferStore {
    const store = this.stores.get(role_id);
    if (!store) {
      throw new Error(`Buffer store not found for agent: ${role_id}`);
    }
    return store;
  }
}
