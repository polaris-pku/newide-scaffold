/**
 * context-delivery — 下游交付项的构造服务（纯函数）
 *
 * 把一次任务的 Buffer 事实（role_id / buffer_seq / DriverReturn 引用）与
 * Driver 自报的经验使用事实，翻译成外部 Memory Maintenance 系统可消费的两类记录，
 * 并给出它们的稳定幂等键。
 *
 * 这里只做「构造」：算键、算时间戳、拼引用，不落盘、不查询。落盘由
 * MemoryDeliveryRepository 的适配器负责，调用方（维护 runner / 执行 facade）
 * 决定何时提交。
 */
import { createHash } from 'node:crypto';
import { nowTimestamp } from '../../core';
import {
  CONTEXT_DELIVERY_SCHEMA_VERSION,
  DRIVER_FEEDBACK_EVENT_VERSION,
  type ContextDeliveryItem,
  type DriverFeedbackRecord,
  type DriverFeedbackSource,
  type Effectiveness,
} from '../schemas';

/** 幂等键 → 文件名安全 id：键本身含 ':'（Windows 文件名非法），哈希后使用 */
function hashedId(prefix: string, key: string): string {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

/**
 * 上下文交付的稳定幂等键。
 *
 * 形状即计划里写死的 `role_id:buffer_seq:context_schema_version`：同一份 Buffer
 * 上下文无论被提交多少次，键都一样，于是只会留下一条交付记录。
 */
export function contextDeliveryKey(input: {
  role_id: string;
  buffer_seq: number;
  schema_version?: string;
}): string {
  return [
    input.role_id,
    String(input.buffer_seq),
    input.schema_version ?? CONTEXT_DELIVERY_SCHEMA_VERSION,
  ].join(':');
}

/** 由幂等键派生交付 id（文件名安全） */
export function contextDeliveryId(key: string): string {
  return hashedId('ctxdel', key);
}

/** 构造上下文交付项的输入：只取 Buffer 侧已有的稳定事实 */
export interface ContextDeliveryInput {
  role_id: string;
  task_id: string;
  buffer_seq: number;
  source_driver: string;
  /** Buffer 快照里的 context_snapshot_ref（有上下文快照时才有） */
  context_snapshot_ref?: string | undefined;
  schema_version?: string;
}

/**
 * 构造一条上下文交付项。
 *
 * `context_snapshot_ref` 直接沿用 Buffer 快照自己的字段：有就是有，没有就是
 * 没有——交付项不负责猜测上下文是否该存在。
 */
export function buildContextDeliveryItem(input: ContextDeliveryInput): ContextDeliveryItem {
  const schema_version = input.schema_version ?? CONTEXT_DELIVERY_SCHEMA_VERSION;
  const delivery_key = contextDeliveryKey({
    role_id: input.role_id,
    buffer_seq: input.buffer_seq,
    schema_version,
  });
  const at = nowTimestamp();
  return {
    delivery_id: contextDeliveryId(delivery_key),
    delivery_key,
    role_id: input.role_id,
    task_id: input.task_id,
    buffer_seq: input.buffer_seq,
    memory_buffer_ref: `${input.role_id}:${String(input.buffer_seq)}`,
    report_ref: `report_${String(input.buffer_seq)}.json`,
    ...(input.context_snapshot_ref !== undefined
      ? { context_snapshot_ref: input.context_snapshot_ref }
      : {}),
    source_driver: input.source_driver,
    status: 'pending',
    schema_version,
    created_at: at,
    updated_at: at,
  };
}

/** Driver 反馈的稳定幂等键（计划指定的五个因子） */
export function driverFeedbackKey(input: {
  role_id: string;
  task_id: string;
  experience_id: string;
  feedback_source: DriverFeedbackSource;
  event_version?: string;
}): string {
  return [
    input.role_id,
    input.task_id,
    input.experience_id,
    input.feedback_source,
    input.event_version ?? DRIVER_FEEDBACK_EVENT_VERSION,
  ].join(':');
}

/** 由幂等键派生反馈 id（文件名安全） */
export function driverFeedbackId(key: string): string {
  return hashedId('drvfb', key);
}

/** DriverReturn.referenced_experiences 的一条引用（对齐该字段形状） */
export interface DriverReferencedExperience {
  experience_id: string;
  applied: boolean;
  effectiveness: Effectiveness;
  note: string;
}

/** 构造反馈记录的输入 */
export interface DriverFeedbackInput {
  role_id: string;
  task_id: string;
  /** 产生该引用的 Buffer 序号（用户评分路径可能没有） */
  buffer_seq?: number | undefined;
  /** 引用列表，来自 DriverReturn.referenced_experiences */
  references: readonly DriverReferencedExperience[];
  observed_at?: string;
  event_version?: string;
}

/**
 * 把 DriverReturn 的引用列表翻译成反馈记录。
 *
 * 不查 Experience 是否存在：引用不存在的经验是正常情况（跨 agent / 已处置 /
 * 下游还没提取出来），反馈照记，由下游按 experience_id 归并。
 *
 * 同一条经验在本次任务里被引用多次时键相同，只保留**第一次**——driver 对同一条
 * 经验给出两个互相矛盾的效果档位时，先到的那条为准；这与「重放不覆盖已有反馈」
 * 是同一条规则，免得同一件事在两处得到两种答案。
 */
export function buildDriverUsageFeedbackRecords(
  input: DriverFeedbackInput,
): DriverFeedbackRecord[] {
  const observed_at = input.observed_at ?? nowTimestamp();
  const event_version = input.event_version ?? DRIVER_FEEDBACK_EVENT_VERSION;
  const byKey = new Map<string, DriverFeedbackRecord>();
  for (const reference of input.references) {
    const feedback_key = driverFeedbackKey({
      role_id: input.role_id,
      task_id: input.task_id,
      experience_id: reference.experience_id,
      feedback_source: 'driver_usage',
      event_version,
    });
    if (byKey.has(feedback_key)) continue;
    byKey.set(feedback_key, {
      feedback_id: driverFeedbackId(feedback_key),
      feedback_key,
      role_id: input.role_id,
      task_id: input.task_id,
      ...(input.buffer_seq !== undefined ? { buffer_seq: input.buffer_seq } : {}),
      experience_id: reference.experience_id,
      applied: reference.applied,
      effectiveness: reference.effectiveness,
      note: reference.note,
      observed_at,
      feedback_source: 'driver_usage' as const,
      event_version,
      status: 'pending' as const,
      created_at: observed_at,
      updated_at: observed_at,
    });
  }
  return [...byKey.values()];
}
