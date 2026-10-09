/**
 * MemoryDeliveryRepository 端口
 *
 * 任务流程向下游 Memory Maintenance 系统交付输入的两条通道：
 *
 *   1. 上下文交付项（context delivery）—— DriverReturn + AgentContextSnapshot 的稳定引用，
 *      供下游做 Experience 提取。
 *   2. Driver 使用反馈 outbox —— Agent 对既有经验的使用事实，供下游判断 Skill 晋升。
 *
 * 两条通道共用一套状态语义（DeliveryStatus）与同样的提交幂等规则：同一个
 * 稳定键重复提交只保留第一条记录，返回 `created: false`，不覆盖已有内容、
 * 也不重复累计。
 *
 * claim / lease / retry 的转移规则定义在 services/delivery-lifecycle.ts，本端口
 * 只声明「有这些动作」，两个适配器必须给出同一套行为。两类记录的形状差异只体现在
 * id 字段名（delivery_id / feedback_id）上，因此状态机部分是**泛化的**：
 * `channel` 是唯一的判别式，返回值按它收窄。端口刻意不写 14 个近乎相同的方法——
 * 两条通道各写一套转移才是它们漂移的原因。
 */
import type {
  ContextDeliveryItem,
  DeliveryStatus,
  DriverFeedbackRecord,
} from '../schemas';
import type { DeliveryRetryPolicy } from '../services/delivery-lifecycle';

/** 提交结果：`created` 为 false 表示命中了幂等键，返回的是已存在的那条 */
export interface DeliverySubmitResult<T> {
  item: T;
  created: boolean;
}

/** 上下文交付项的查询过滤（全部可选，缺省即全量） */
export interface ContextDeliveryFilter {
  role_id?: string | undefined;
  task_id?: string | undefined;
  status?: DeliveryStatus | undefined;
}

/** Driver 反馈 outbox 的查询过滤（全部可选，缺省即全量） */
export interface DriverFeedbackFilter {
  role_id?: string | undefined;
  task_id?: string | undefined;
  experience_id?: string | undefined;
  status?: DeliveryStatus | undefined;
}

/** 两条交付通道的判别式 */
export type DeliveryChannel = 'context' | 'feedback';

/** claim 请求：谁持有、持有多久、以什么时刻为准 */
export interface DeliveryClaimRequest {
  channel: DeliveryChannel;
  /** 消费者标识（下游自己给；本仓只做持有者比对，不解释它的含义） */
  owner: string;
  /** lease 时长（毫秒）；缺省用实现自己的 `policy.lease_ms` */
  lease_ms?: number | undefined;
  /** 参考时刻（测试注入，避免依赖真实时钟）；缺省取当前时间 */
  now?: string | undefined;
  /** 只取该 role 的交付项；缺省跨 role */
  role_id?: string | undefined;
}

/** 定位一条已有交付记录 */
export interface DeliveryRecordLocator {
  channel: DeliveryChannel;
  role_id: string;
  /** `channel='context'` 时为 delivery_id，`channel='feedback'` 时为 feedback_id */
  id: string;
}

export interface ClaimedContextDelivery {
  channel: 'context';
  item: ContextDeliveryItem;
}
export interface ClaimedDriverFeedback {
  channel: 'feedback';
  item: DriverFeedbackRecord;
}
/**
 * 一次 claim/ack 的结果。
 *
 * 判别式 `channel` 让调用方在收窄之后直接拿到具体类型，不必在 port 层做断言；
 * 这也是两条通道能共用一套方法而不牺牲类型安全的原因。
 */
export type ClaimedDelivery = ClaimedContextDelivery | ClaimedDriverFeedback;

/** 该实现的 claim/重试参数；capabilities 如实转述它，而不是报一份默认值 */
export interface DeliveryRepositoryPolicy extends DeliveryRetryPolicy {
  /** 未显式传 lease_ms 时使用的租约时长 */
  lease_ms: number;
  /**
   * claim 的并发隔离级别：
   * - `process_mutex`：只在同进程内保证不重复投递（内存实现）
   * - `exclusive_lock_file`：跨进程用独占锁文件串行化同一记录的 claim
   */
  claim_isolation: 'process_mutex' | 'exclusive_lock_file';
}

export interface MemoryDeliveryRepository {
  /** 该实现的 lease / 重试 / 隔离级别 */
  readonly policy: DeliveryRepositoryPolicy;

  /** 确保该 Agent 的交付存储已初始化（不存在则创建空状态） */
  ensureAgent(role_id: string): Promise<void>;

  /** 删除该 Agent 的交付存储（与 BufferRepository.deleteAgent 配对使用） */
  deleteAgent(role_id: string): Promise<void>;

  /**
   * 提交一条上下文交付项（幂等）。
   *
   * 幂等键是 `item.delivery_key`；命中时原样返回已存在的记录，不更新其
   * status/updated_at —— 下游可能已经把那条推进到 processing/processed，
   * 上游重放不得把它拽回 pending。
   *
   * 实现上只需保证「只在记录缺席时写」：提交从不 UPDATE 已有记录，因此与
   * claim/ack 之间不存在覆盖竞争，也不需要为提交再引入一次锁。
   */
  submitContextDelivery(
    item: ContextDeliveryItem,
  ): Promise<DeliverySubmitResult<ContextDeliveryItem>>;

  /** 读取一条上下文交付项（按 role + delivery_id） */
  getContextDelivery(
    role_id: string,
    delivery_id: string,
  ): Promise<ContextDeliveryItem | undefined>;

  /** 列出上下文交付项（跨 role 缺省全量，按 role_id/task_id/status 过滤） */
  listContextDeliveries(filter?: ContextDeliveryFilter): Promise<ContextDeliveryItem[]>;

  /**
   * 提交一条 Driver 使用反馈（幂等）。
   *
   * 幂等键是 `record.feedback_key`；命中时返回已有记录，不覆盖、不累计 ——
   * 同一份 DriverReturn 重放不得让使用效果被记两次。
   */
  submitDriverFeedback(
    record: DriverFeedbackRecord,
  ): Promise<DeliverySubmitResult<DriverFeedbackRecord>>;

  /** 读取一条 Driver 反馈（按 role + feedback_id） */
  getDriverFeedback(
    role_id: string,
    feedback_id: string,
  ): Promise<DriverFeedbackRecord | undefined>;

  /** 列出 Driver 反馈（跨 role 缺省全量，按 role_id/task_id/experience_id/status 过滤） */
  listDriverFeedback(filter?: DriverFeedbackFilter): Promise<DriverFeedbackRecord[]>;

  // ── claim / lease / 重试（工作包 C） ──────────────────────────────
  //
  // 下面这组方法对两条通道给出**同一套**转移语义。返回 undefined 统一表示
  // 「这次什么都没做」：记录不存在、状态不允许（已被别人 claim、已 processed、
  // 还没到退避时刻）、持有者不匹配、或没抢到锁。调用方不需要区分这些——它们
  // 对调用方的下一步动作是同一种：稍后再试或放弃。

  /**
   * claim 一条指定的交付记录（pending → processing）。
   *
   * 「检查 pending + 写 processing」必须在同一个临界区里完成，否则两个消费者
   * 会同时看到 pending。隔离方式见 `policy.claim_isolation`。
   */
  claimDelivery(
    input: DeliveryClaimRequest & { id: string },
  ): Promise<ClaimedDelivery | undefined>;

  /** claim 下一条可以投递的记录（按到期时刻先后；跨 role 缺省全局扫描） */
  claimNextDelivery(input: DeliveryClaimRequest): Promise<ClaimedDelivery | undefined>;

  /** 延长自己持有的 lease（持有者必须匹配，且 lease 尚未过期） */
  renewDeliveryClaim(
    input: DeliveryRecordLocator & {
      owner: string;
      lease_ms?: number | undefined;
      now?: string | undefined;
    },
  ): Promise<ClaimedDelivery | undefined>;

  /** 交付完成：processing → processed（终止态） */
  completeDelivery(
    input: DeliveryRecordLocator & {
      owner?: string | undefined;
      processor_version?: string | undefined;
      now?: string | undefined;
    },
  ): Promise<ClaimedDelivery | undefined>;

  /**
   * 交付失败：可重试则退避后回到 pending，不可重试或已用满次数则进 dead_letter。
   *
   * `retryable` 由下游判断：连接失败/RPC 超时/临时存储错误是可重试的；
   * schema 解析不了、role/seq 非法、配置永久错不是。
   */
  failDelivery(
    input: DeliveryRecordLocator & {
      owner?: string | undefined;
      error: string;
      retryable: boolean;
      now?: string | undefined;
    },
  ): Promise<ClaimedDelivery | undefined>;

  /** 人工重试：dead_letter → pending，并清零投递次数 */
  retryDeadLetterDelivery(
    input: DeliveryRecordLocator & { now?: string | undefined },
  ): Promise<ClaimedDelivery | undefined>;

  /** 启动恢复：把 lease 过期仍停在 processing 的记录放回可投递队列 */
  restoreExpiredDeliveryClaims(options?: {
    channel?: DeliveryChannel | undefined;
    role_id?: string | undefined;
    now?: string | undefined;
  }): Promise<ClaimedDelivery[]>;

  /** 当前可投递（pending 且已过退避窗口）的记录，按到期时刻排序 */
  listRetryableDeliveries(options?: {
    channel?: DeliveryChannel | undefined;
    role_id?: string | undefined;
    now?: string | undefined;
  }): Promise<ClaimedDelivery[]>;
}
