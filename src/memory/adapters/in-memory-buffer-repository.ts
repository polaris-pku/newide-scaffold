/**
 * InMemoryBufferRepository — BufferRepository 内存适配器
 *
 * 所有 Agent 共享一个实例，buffer 数据按 role_id 隔离存储于内存 Map。
 * 无物理文件路径；生产向持久化见 FileBufferRepository。
 */
import type {
  AgentContextSnapshot,
  BufferMeta,
  BufferSnapshot,
  UserRating,
} from '../schemas';
import type {
  AgentContextReadStatus,
  BufferArchiveOutcome,
  BufferLocation,
  BufferRepository,
  DeadLetterEntry,
  PendingBufferRead,
  SaveBufferResult,
  StoredBuffer,
} from '../ports/buffer-repository';
import { nowTimestamp } from '../../core';

interface PendingEntry {
  snapshot: BufferSnapshot;
  agentContext?: AgentContextSnapshot;
  /** 进入死信的原因（markBufferDeadLetter 时记录） */
  dead_letter_reason?: string;
  /** 进入死信的时间 */
  dead_letter_at?: string;
}

interface BufferStore {
  bufferMeta: BufferMeta;
  pending: Map<number, PendingEntry>;
  /** 已归档条目（markBufferProcessed 移入）——交付项只存引用，归档后仍要能按 seq 取回 */
  processed: Map<number, PendingEntry>;
  /** 死信条目（markBufferDeadLetter 移入，可被 restoreDeadLetter 恢复） */
  deadLetters: Map<number, PendingEntry>;
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
    // 与文件实现同一个不变量：分配的 seq 从没被用过。内存实现天然满足——从读 cursor 到
    // 写进 pending，中间没有任何 await，并发的两次调用不可能交错（JS 单线程）。文件实现
    // 没有这个便利，所以那里按 role 串行化并让序号从目录推导。
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
    entry.snapshot.extraction_status = 'processed';
    // 归档而不是丢弃：交付项的 payload 引用就落在这里，落地即删会让已交付的上下文取不回来
    store.processed.set(seq, entry);
    store.bufferMeta.pending_count = Math.max(0, store.bufferMeta.pending_count - 1);
    store.bufferMeta.total_processed += 1;
  }

  async markBufferDeadLetter(role_id: string, seq: number, reason?: string): Promise<void> {
    const store = this.requireStore(role_id);
    const entry = store.pending.get(seq);
    if (!entry) {
      throw new Error(`Pending buffer not found: seq=${seq}`);
    }
    store.pending.delete(seq);
    store.deadLetters.set(seq, entry);
    store.bufferMeta.pending_count = Math.max(0, store.bufferMeta.pending_count - 1);
    store.bufferMeta.total_dead_letters += 1;
    entry.snapshot.extraction_status = 'dead_letter';
    if (reason !== undefined) {
      entry.dead_letter_reason = reason;
      entry.dead_letter_at = nowTimestamp();
    }
  }

  async listDeadLetterSeqs(role_id: string): Promise<number[]> {
    return [...this.requireStore(role_id).deadLetters.keys()].sort((a, b) => a - b);
  }

  async listDeadLetterEntries(role_id: string): Promise<DeadLetterEntry[]> {
    const store = this.requireStore(role_id);
    return [...store.deadLetters.entries()]
      .sort(([left], [right]) => left - right)
      .map(([seq, entry]) => ({
        seq,
        task_id: entry.snapshot.task_id,
        ...(entry.dead_letter_reason !== undefined
          ? { reason: entry.dead_letter_reason }
          : {}),
        failed_at: entry.dead_letter_at ?? nowTimestamp(),
      }));
  }

  async restoreDeadLetter(role_id: string, seq: number): Promise<void> {
    const store = this.requireStore(role_id);
    const entry = store.deadLetters.get(seq);
    if (!entry) {
      throw new Error(`Dead-letter buffer not found: seq=${seq}`);
    }
    store.deadLetters.delete(seq);
    store.pending.set(seq, entry);
    store.bufferMeta.pending_count += 1;
    store.bufferMeta.total_dead_letters = Math.max(0, store.bufferMeta.total_dead_letters - 1);
    entry.snapshot.extraction_status = 'pending';
  }

  async updateBufferRating(role_id: string, seq: number, rating: UserRating): Promise<void> {
    const store = this.requireStore(role_id);
    const entry = store.pending.get(seq);
    if (!entry) {
      throw new Error(`Pending buffer not found: seq=${seq}`);
    }
    entry.snapshot = { ...entry.snapshot, user_rating: rating };
  }

  async listPendingBufferSeqs(role_id: string): Promise<number[]> {
    return [...this.requireStore(role_id).pending.keys()].sort((a, b) => a - b);
  }

  async getPendingBuffer(role_id: string, seq: number): Promise<PendingBufferRead | undefined> {
    const entry = this.requireStore(role_id).pending.get(seq);
    if (!entry) {
      return undefined;
    }
    return { snapshot: entry.snapshot, ...agentContextReadOf(entry) };
  }

  async getStoredBuffer(role_id: string, seq: number): Promise<StoredBuffer | undefined> {
    const store = this.requireStore(role_id);
    const partitions: ReadonlyArray<{ location: BufferLocation; entries: Map<number, PendingEntry> }> =
      [
        { location: 'pending', entries: store.pending },
        { location: 'processed', entries: store.processed },
        { location: 'dead_letter', entries: store.deadLetters },
      ];
    for (const { location, entries } of partitions) {
      const entry = entries.get(seq);
      if (!entry) continue;
      return { snapshot: entry.snapshot, ...agentContextReadOf(entry), location };
    }
    return undefined;
  }

  /**
   * 归档一条 Buffer，与文件实现给出同一套结果（见 BufferArchiveOutcome）。
   *
   * 内存实现没有磁盘，正常情况下不会失败；但仍按同一套判别式回答，测试替身才不会掩盖
   * 生产行为的差异——尤其是有意让 markBufferProcessed 失败时，这里必须报 `failed`
   * 而不是把异常抛给一个「不抛错」的调用方。
   */
  async archiveBuffer(role_id: string, seq: number): Promise<BufferArchiveOutcome> {
    try {
      await this.markBufferProcessed(role_id, seq);
      return { status: 'archived' };
    } catch (error) {
      return this.classifyArchiveFailure(role_id, seq, error);
    }
  }

  private classifyArchiveFailure(
    role_id: string,
    seq: number,
    error: unknown,
  ): BufferArchiveOutcome {
    const reason = error instanceof Error ? error.message : String(error);
    const store = this.stores.get(role_id);
    if (!store) {
      return {
        status: 'missing',
        message: `Buffer store not found for agent: ${role_id}`,
      };
    }
    if (store.processed.has(seq)) {
      // 配对 Buffer 的 parity 检查：内存实现搬运是原子的（report 与 context 一起进
      // processed），一般不会出现半成品；但手工构造的 processed 条目若声明了
      // context_snapshot_ref 却没带上上下文，那也是「归档不完整」，不能报 already_archived。
      const entry = store.processed.get(seq)!;
      if (entry.snapshot.context_snapshot_ref !== undefined && !entry.agentContext) {
        return {
          status: 'failed',
          message: `Buffer ${role_id}:${String(seq)} is archived without the AgentContextSnapshot declared by context_snapshot_ref=${entry.snapshot.context_snapshot_ref}.`,
        };
      }
      return { status: 'already_archived' };
    }
    if (store.deadLetters.has(seq)) {
      return {
        status: 'not_pending',
        location: 'dead_letter',
        message: `Buffer ${role_id}:${String(seq)} is dead-lettered, not pending, so archiving does not apply to it (${reason}).`,
      };
    }
    if (store.pending.has(seq)) {
      return {
        status: 'failed',
        message: `Buffer ${role_id}:${String(seq)} is still pending after the archive attempt: ${reason}`,
      };
    }
    return {
      status: 'missing',
      message: `Buffer ${role_id}:${String(seq)} is in no partition, so there was nothing to archive (${reason}).`,
    };
  }

  private getOrCreateStore(role_id: string): BufferStore {
    let store = this.stores.get(role_id);
    if (!store) {
      store = {
        bufferMeta: createEmptyBufferMeta(role_id),
        pending: new Map(),
        processed: new Map(),
        deadLetters: new Map(),
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

/**
 * 配对上下文的读取结果，与文件实现同一套判据（见 AgentContextReadStatus）。
 *
 * 内存里的快照不会被磁盘弄坏，所以这里只会出现 `present` / `absent` / 「声明了引用却
 * 没有上下文」这三种：手写的 BufferSnapshot 可以自带 `context_snapshot_ref` 而没配
 * 上下文，那在语义上就是「声明过却读不出来」，不能当成没有上下文放过。
 */
function agentContextReadOf(entry: PendingEntry): {
  agentContextStatus: AgentContextReadStatus;
  agentContext?: AgentContextSnapshot;
  agentContextError?: string;
} {
  if (entry.agentContext) {
    return { agentContextStatus: 'present', agentContext: entry.agentContext };
  }
  const declaredRef = entry.snapshot.context_snapshot_ref;
  if (declaredRef === undefined) {
    return { agentContextStatus: 'absent' };
  }
  return {
    agentContextStatus: 'unreadable',
    agentContextError:
      `Agent context declared by context_snapshot_ref=${declaredRef} has no stored snapshot ` +
      `for this Buffer.`,
  };
}
