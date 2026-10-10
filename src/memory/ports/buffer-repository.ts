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

/** 死信条目详情（memory.getBufferState 的 dead_letters 数组元素） */
export interface DeadLetterEntry {
  seq: number;
  /** 失败缓冲区的任务 ID */
  task_id: string;
  /** 提取失败原因（markBufferDeadLetter 时记录，可为空） */
  reason?: string;
  /** 进入死信的时间 */
  failed_at: string;
}

/** 缓冲区快照当前所在的分区 */
export type BufferLocation = 'pending' | 'processed' | 'dead_letter';

/**
 * 配对 AgentContextSnapshot 的读取结果。
 *
 * 「没有上下文」与「有上下文却读不出来」必须分开——两者在下游看都是
 * `agent_context` 缺席，但含义完全相反：
 *
 * - `present`：读到了。
 * - `absent`：快照没有声明 `context_snapshot_ref`。这是历史 Buffer 的正常形态（写入侧
 *   确实没做上下文清理），允许兼容性降级：下游只用 DriverReturn 继续干活。此时**不会**
 *   去读同 seq 上的 `context_N.json`——那份文件只可能是「context 落了、report 没落成」
 *   留下的孤儿，读它就是把一份不相干的上下文绑到一条从没声明过它的报告上。
 * - `unreadable`：快照声明了引用，但文件缺失 / JSON 损坏 / schema 校验失败 / 引用与所在
 *   seq 对不上 / 不可读。有一份**声明过**的上下文丢了，降级成「本次没有上下文」等于把
 *   丢失藏起来。
 */
export type AgentContextReadStatus = 'present' | 'absent' | 'unreadable';

/** 读一条 Buffer 的结果：快照 + 配对上下文的读取结果（含失败原因） */
export interface PendingBufferRead {
  snapshot: BufferSnapshot;
  agentContext?: AgentContextSnapshot;
  /** 见 AgentContextReadStatus；`unreadable` 才说明上下文真的出了问题 */
  agentContextStatus: AgentContextReadStatus;
  /** `unreadable` 时的原因（带路径，够定位到哪条 Buffer 坏了） */
  agentContextError?: string;
}

/** 按 seq 取回的缓冲区快照，附带它现在躺在哪个分区 */
export interface StoredBuffer extends PendingBufferRead {
  location: BufferLocation;
}

/**
 * 归档一条**已经交付完成**的 Buffer 的结果（pending → processed）。
 *
 * delivery 与 Buffer 在两个存储里，没有跨存储事务，所以归档只能是一个独立的后续
 * 动作：ack 说的是「下游处理完了」，这件事已经成真、不可回滚；把源 Buffer 移出
 * pending 只是清理待办队列。于是归档**要么成功、要么把结果讲清楚**。
 *
 * 关键是把「本来就没有可归档的东西」和「归档动作真的失败了」分开——前者无需修复，
 * 后者必须看得见，不能都当成无害情况吞掉（`failed` 意味着 Buffer 仍在 pending）。
 *
 * `failed` 还覆盖一种更细的半成品：**目标分区已写入、源分区那份没删掉**（删除失败），
 * 于是同一条 Buffer 同时存在于两个分区。文件实现为此给出带 `partial` 字样的消息——
 * 它既不能报 archived（还留在 pending），重试也是安全的（目标被同内容重写、源删掉之后
 * 才推进计数），但绝不能让调用方以为它已经搬完了。
 */
export type BufferArchiveOutcome =
  | { status: 'archived' }
  | { status: 'already_archived' }
  | { status: 'not_pending'; location: BufferLocation; message: string }
  | { status: 'missing'; message: string }
  | { status: 'failed'; message: string };

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

  /**
   * 保存缓冲区快照（配对可选 AgentContextSnapshot）。
   *
   * 实现须保证：同一 role 上并发调用拿到的 seq **互不相同且严格递增**，且从不是某个已经
   * 用过的 seq——复用会直接覆盖掉那条已有 Buffer。文件实现的做法是同一 role 串行化，并让
   * 序号从目录（所有分区里出现过的最大 report seq，**以及与 Buffer 配对的 context 文件
   * seq**）推导，而不是只信可能落后的 meta.cursor：配对写入是先落 context 再落 report，
   * 所以「context 落了、report 没落成」也会烧掉那个 seq，绝不再分配出去。
   *
   * 成对写入的提交点是 report 文件（见 FileBufferRepository 的写入顺序）；一旦返回成功，
   * 这条 Buffer 必须已经可被 getPendingBuffer 读回。
   */
  saveBufferSnapshot(
    role_id: string,
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<SaveBufferResult>;

  /**
   * 获取缓冲区元数据（pending 计数、游标、累计计数）。
   *
   * 这些数字是**文件分区的投影**，不是独立的事实来源：文件实现每次成功写入 / 归档 /
   * 恢复都按目录重算一遍，启动时（ensureAgent）也校正一次——所以计数器曾经因为写 meta
   * 失败而漏记，会在下一次成功操作或下次启动时自己回来。
   */
  getBufferMeta(role_id: string): Promise<BufferMeta>;

  /** 标记缓冲区为已处理（移动到 processed/） */
  markBufferProcessed(role_id: string, seq: number): Promise<void>;

  /**
   * 标记缓冲区为死信（提取失败）。
   *
   * `reason` 记录提取失败的原因（如错误消息），随死信条目持久化，
   * 经 listDeadLetterEntries / memory.getBufferState 对外可见。
   */
  markBufferDeadLetter(role_id: string, seq: number, reason?: string): Promise<void>;

  /**
   * 为仍处于 pending 的缓冲区快照写入用户评分（memory.rateTask）。
   *
   * 仅 pending 有效：seq 不在 pending 中（已处理/死信/不存在）时抛错，
   * 由调用方先经 listPendingBufferSeqs + getPendingBuffer 定位任务对应 seq。
   */
  updateBufferRating(role_id: string, seq: number, rating: UserRating): Promise<void>;

  /** 列出所有待处理缓冲区的 seq 列表 */
  listPendingBufferSeqs(role_id: string): Promise<number[]>;

  /** 列出所有死信缓冲区的 seq 列表（提取失败，可经 restoreDeadLetter 恢复） */
  listDeadLetterSeqs(role_id: string): Promise<number[]>;

  /** 列出死信详情（seq + task_id + 失败原因 + 进入死信时间） */
  listDeadLetterEntries(role_id: string): Promise<DeadLetterEntry[]>;

  /**
   * 将一条死信缓冲区恢复到 pending（memory.retryExtraction）。
   *
   * 副作用：文件移回 pending/ 目录并写回 extraction_status='pending'，
   * meta 的 pending_count +1、total_dead_letters −1。seq 不在死信时抛错。
   */
  restoreDeadLetter(role_id: string, seq: number): Promise<void>;

  /**
   * 获取指定 seq 的待处理缓冲区快照（含 agentContext 与其读取结果）。
   *
   * 快照本身读不出来（损坏）时抛错；快照在、配对的上下文读不出来时**不抛错**，
   * 而是把 `agentContextStatus='unreadable'` 连同原因交回调用方——报告那一半仍然
   * 可用，只是另一半不可用，调用方需要把这两件事分别处理（见 PendingBufferRead）。
   */
  getPendingBuffer(role_id: string, seq: number): Promise<PendingBufferRead | undefined>;

  /**
   * 获取指定 seq 的缓冲区快照，不管它现在在哪个分区：pending → processed → dead_letter。
   *
   * 上下文交付项只存**引用**不存 payload（见 ContextDeliveryItem），所以「Buffer 被
   * 归档走」不等于「交付不可读」：下游 ack 之后交付项仍要能按 delivery_id 取回完整的
   * DriverReturn 与 AgentContextSnapshot。getPendingBuffer 回答的是「还有什么等着处理」，
   * 这个回答的是「这条上下文还在不在、在哪」，两者用途不同，不能互相顶替。
   *
   * 缺席（三个分区都没有）返回 undefined；报告文件在但读不出来则抛错——损坏不是缺席，
   * 调用方需要能把这两种情况分开报告。上下文那一半同样不抛错，按 PendingBufferRead
   * 的 `agentContextStatus` 报告（`unreadable` 覆盖三个分区）。
   */
  getStoredBuffer(role_id: string, seq: number): Promise<StoredBuffer | undefined>;

  /**
   * 归档一条 Buffer（pending → processed），**不抛错**，把结果作为判别式返回。
   *
   * 与 markBufferProcessed 的分工：那个是「照做，做不到就抛」，适合调用方本来就要
   * 中断的场景；这个是「尽力做，并把做没做成、为什么没做成讲清楚」——已 ack 的交付
   * 路径需要后者，因为它已经不能回滚交付状态，只能如实报告（见 BufferArchiveOutcome）。
   * `failed` 表示 Buffer 仍在 pending，需要重试归档而不是当成已完成。
   */
  archiveBuffer(role_id: string, seq: number): Promise<BufferArchiveOutcome>;
}
