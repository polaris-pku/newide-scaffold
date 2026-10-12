/**
 * pending-feedback — 待归并反馈的构造与映射（纯函数）
 *
 * 反馈消费者有两个时刻需要「把一份 Driver 反馈变成别的东西」，都不该各写一遍：
 *
 * - **寄存**：Experience 还没出现时，把反馈副本包成一条待归并记录（buildPendingFeedbackRecord）。
 * - **应用**：无论走直连还是归并路径，真正要写进经验的是同一组事实，由反馈记录原样映射而来
 *   （feedbackApplicationOf）。两条路径共用它，就不会出现「直连按 note 写、归并漏了 note」
 *   这种两边各解释一遍的漂移。
 *
 * 这里只做形状转换与幂等键的搬运，不查询、不落盘：谁在什么时候寄存、谁在什么时候归并，
 * 由运行时（runtime/driver-feedback-processor）决定。
 */
import { nowTimestamp } from '../../core';
import {
  DRIVER_FEEDBACK_EVENT_VERSION,
  DriverFeedbackContentSchema,
  type DriverFeedbackContent,
  type DriverFeedbackRecord,
  type PendingFeedbackRecord,
} from '../schemas';
import type { ExperienceFeedbackApplication } from '../ports/memory-repository';

/**
 * 一条反馈的待归并身份。
 *
 * 就是反馈自己的 `feedback_id`：同一条反馈在 outbox 与待归并队列里用同一个 id，于是
 * 「这条反馈消费到哪一步了」可以跨两张表直接对起来（也正因如此，寄存是幂等的——
 * 重复寄存撞在同一个主键上）。
 */
export function pendingFeedbackId(feedbackId: string): string {
  return feedbackId;
}

/**
 * 把一条「Experience 还不存在」的反馈包成待归并记录。
 *
 * `feedback` 是反馈**内容**的副本（`DriverFeedbackContent`，不含交付状态机字段）而不是引用：
 * 归并发生在 Experience 出现之后的某个时刻，那一刻不该再回头读 outbox（它可能被清库、
 * 被人工重置、或换了后端）。副本让这条待归并记录自足。
 *
 * 只取内容、不连交付进度一起抄，是刻意的：outbox 那条记录此刻可能正被 claim（带着凭据与
 * 租约），照抄会把一份活凭据与一个冻结的状态塞进另一个 payload，还会让「这条反馈处理到哪
 * 一步了」在同一个文件里有两个互相矛盾的答案。进度只属于它自己那条交付记录。
 *
 * 反馈的契约版本不是这版消费者认识的，仍然照存——**判据不由本函数承担**：寄存前消费者
 * 已经校验过契约（不认识就直接进死信），归并时还会再校验一次（记录可能来自更早的版本）。
 */
export function buildPendingFeedbackRecord(
  feedback: DriverFeedbackRecord,
  now: string = nowTimestamp(),
): PendingFeedbackRecord {
  return {
    feedback_id: pendingFeedbackId(feedback.feedback_id),
    role_id: feedback.role_id,
    experience_id: feedback.experience_id,
    feedback: driverFeedbackContentOf(feedback),
    status: 'pending',
    // 还没归并过：attempt_count 在每次 claim 时递增（见 services/delivery-lifecycle）
    attempt_count: 0,
    created_at: now,
    updated_at: now,
  };
}

/** 取一条反馈记录的内容部分（丢掉交付状态机字段）；zod 对象默认丢弃未知键 */
export function driverFeedbackContentOf(feedback: DriverFeedbackRecord): DriverFeedbackContent {
  return DriverFeedbackContentSchema.parse(feedback);
}

/**
 * 反馈内容 → 要写进经验的那组事实。
 *
 * 字段一一对应，不做解读：效果档位怎么变置信度是 usage-feedback 的事，这里只负责搬运，
 * 免得「谁改了什么」在两条路径上各有各的说法。
 */
export function feedbackApplicationOf(
  feedback: DriverFeedbackContent,
): ExperienceFeedbackApplication {
  return {
    feedback_id: feedback.feedback_id,
    experience_id: feedback.experience_id,
    applied: feedback.applied,
    effectiveness: feedback.effectiveness,
    note: feedback.note,
    observed_at: feedback.observed_at,
    feedback_source: feedback.feedback_source,
  };
}

/** 这版消费者能读的反馈契约版本；不认识的版本属于坏输入，重投多少次都一样 */
export function isSupportedFeedbackVersion(event_version: string): boolean {
  return event_version === DRIVER_FEEDBACK_EVENT_VERSION;
}

/**
 * 待归并记录**自己声明的关联键**是否与它携带的反馈内容一致。
 *
 * 一条待归并记录回答两个问题：它挂在哪条交付队列上（顶层 `feedback_id` / `role_id` /
 * `experience_id`），以及它携带的反馈说了什么（嵌套 `feedback` 里的同名字段）。两者是同一
 * 事实的两处抄写，必须逐字一致——不一致就意味着这份记录被手工改过，或者来自另一套构造规则。
 *
 * 为什么必须在**归并之前**挡住：应用的定位与写入用的是嵌套那一份（`feedback.role_id` /
 * `feedback.experience_id`），而 claim/lease/ack/fail、也就是死信落点，用的是顶层那一份
 * （`{channel, role_id: record.role_id, id: record.feedback_id}`）。两者不一致时会出现两种
 * 都不可接受的写入——**跨 Agent 写**（顶层指向 A、内容说 B，于是 B 的经验被 A 队列里的反馈
 * 改写，而那条经验的置信度历史里记着一条它不知道来源的 id）、以及**fence 键错位**（死信落在
 * 一条与内容无关的记录上，真正出问题的那条永远留在队列里空转）。
 *
 * 三者都判，缺一不可：
 * - `role_id` 不一致 → 上面那条跨 Agent 写
 * - `experience_id` 不一致 → 同 role 内也会写错经验（"the" experience 由内容说了算）
 * - `feedback_id` 不一致 → 幂等键与溯源落点对不上（内容里那个才是要记进置信度历史的 id）
 *
 * 返回不一致的字段名（空数组表示自洽）；调用方据此落一条规范化的 `payload_unreadable`
 * 错误并直接进死信——这是不可恢复的损坏数据，重投多少次都是同一个结论。
 */
export function pendingFeedbackBindingMismatches(
  record: PendingFeedbackRecord,
): PendingFeedbackIdentityField[] {
  const mismatches: PendingFeedbackIdentityField[] = [];
  if (record.feedback_id !== record.feedback.feedback_id) mismatches.push('feedback_id');
  if (record.role_id !== record.feedback.role_id) mismatches.push('role_id');
  if (record.experience_id !== record.feedback.experience_id) mismatches.push('experience_id');
  return mismatches;
}

/**
 * 把上一条的不一致渲染成一句可落盘的诊断。
 *
 * 逐个字段列出「顶层说什么、内容说什么」：只报字段名的话，人工恢复时还得自己去把两侧读出来
 * 对比一遍，而这条记录从此只会出现在死信里。
 */
export function describePendingFeedbackBindingMismatch(
  record: PendingFeedbackRecord,
  mismatches: readonly PendingFeedbackIdentityField[],
): string {
  const fields = mismatches
    .map(
      (field) =>
        `${field}=${record[field]} (top-level) vs ${record.feedback[field]} (feedback payload)`,
    )
    .join('; ');
  return `Pending feedback ${record.feedback_id} contradicts its own payload on ${mismatches.join(
    ', ',
  )}: ${fields}.`;
}

/** 待归并记录里既是顶层关联键、又在反馈内容里各有一份的字段 */
type PendingFeedbackIdentityField = 'feedback_id' | 'role_id' | 'experience_id';
