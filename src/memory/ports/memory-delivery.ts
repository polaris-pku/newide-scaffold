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
 * 也不重复累计。claim / lease / retry 的机制在后续工作包补，本端口先保证
 * 「交付项可查询、可重放、重复无害」。
 */
import type { ContextDeliveryItem, DeliveryStatus, DriverFeedbackRecord } from '../schemas';

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

export interface MemoryDeliveryRepository {
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
}
