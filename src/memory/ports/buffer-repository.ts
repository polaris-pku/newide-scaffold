/**
 * BufferRepository 持久化端口
 *
 * 定义 Agent 任务后 buffer 队列的读写契约：pending 写入、游标、
 * processed / dead_letter 迁移等。生产实现为文件存储（pending/ 等目录）。
 */
import type { BufferMeta, BufferSnapshot, AgentContextSnapshot, UserRating } from '../schemas';

/** saveBufferSnapshot 的返回值 */
export interface SaveBufferResult {
  /** 分配的缓冲区序号（单调递增） */
  seq: number;
  /** 写入的缓冲区快照副本 */
  snapshot: BufferSnapshot;
  /** 若同时写入了 AgentContextSnapshot，则附带 */
  agent_context_snapshot?: AgentContextSnapshot;
}

export interface BufferRepository {
  /** 确保 Agent 的 buffer 存储已初始化（不存在则创建空状态） */
  ensureAgent(role_id: string): Promise<void>;

  /**
   * 删除 Agent 的 buffer 存储（pending / processed / dead_letter 与 meta）。
   *
   * 与 MemoryRepository.deleteAgent 配对使用；Agent 不存在时静默成功
   * （未初始化过 buffer 的 Agent 删除不报错）。
   */
  deleteAgent(role_id: string): Promise<void>;

  /** 保存缓冲区快照（配对可选 AgentContextSnapshot） */
  saveBufferSnapshot(
    role_id: string,
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<SaveBufferResult>;

  /** 获取缓冲区元数据（pending 计数、游标等） */
  getBufferMeta(role_id: string): Promise<BufferMeta>;

  /** 标记缓冲区为已处理（移动到 processed/） */
  markBufferProcessed(role_id: string, seq: number): Promise<void>;

  /** 标记缓冲区为死信（提取失败） */
  markBufferDeadLetter(role_id: string, seq: number): Promise<void>;

  /**
   * 为仍处于 pending 的缓冲区快照写入用户评分（memory.rateTask）。
   *
   * 仅 pending 有效：seq 不在 pending 中（已处理/死信/不存在）时抛错，
   * 由调用方先经 listPendingBufferSeqs + getPendingBuffer 定位任务对应 seq。
   */
  updateBufferRating(role_id: string, seq: number, rating: UserRating): Promise<void>;

  /** 列出所有待处理缓冲区的 seq 列表 */
  listPendingBufferSeqs(role_id: string): Promise<number[]>;

  /** 获取指定 seq 的待处理缓冲区快照（含 agentContext） */
  getPendingBuffer(
    role_id: string,
    seq: number,
  ): Promise<
    | {
        snapshot: BufferSnapshot;
        agentContext?: AgentContextSnapshot;
      }
    | undefined
  >;
}
