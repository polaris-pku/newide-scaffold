/**
 * UsageFeedback — 用后验证回写服务（全自动测评的置信度增长通道）
 *
 * 每次任务完成后，Driver 会在 DriverReturn.referenced_experiences 中上报
 * 本次任务实际引用了哪些已存经验、以及每条经验的效果（fully_effective /
 * partially_effective / ineffective / not_applicable）。本服务把这份
 * "用后验证"信号回写给被引用的经验，使置信度不再只是提取时的静态自评：
 *
 *   - fully_effective     → referenced_count+1，confidence +0.1（封顶 0.98）
 *   - partially_effective → referenced_count+1，confidence +0.05（封顶 0.98）
 *   - ineffective         → referenced_count+1，confidence -0.1（下限 0.1）
 *   - not_applicable      → referenced_count+1，置信度不变
 *
 * 置信度增长追加 confidence_history（reason='usage_validation:<effectiveness>'），
 * 并同步 AgentMetrics.avg_confidence。这样在无人评分的测评中，真正被后续任务
 * 反复使用且有效的经验会滚雪球式积累置信度，最终达到晋升门槛（默认 0.95）；
 * 未被使用或无效的经验永远无法晋升——选择性晋升由真实使用效果决定，而不是
 * 靠调低阈值（调低阈值会让所有经验都晋升，失去筛选意义）。
 *
 * 与 feedback.ts（用户评分）同模式：纯函数式，repository 直接注入。
 * 引用了不存在/已删除的经验 id 时静默跳过（防御性：driver 可能引用跨 agent
 * 或已处置的记忆）。失败不抛错、不阻断任务主流程（由调用方决定是否降级）。
 *
 * 本文件另外承载**两条反馈通路共用的规则**：效果档位到置信度增量、上下限、以及
 * 「应用后的经验记录长什么样」（nextConfidenceAfterFeedback / applyFeedbackToExperience /
 * isFeedbackApplied）。异步的反馈消费者（runtime/driver-feedback-processor）与这里的
 * 进程内回写是两条不同的路径——前者按 feedback_id 幂等、原子写入，后者是实验入口的
 * 逐条回写——但它们对同一条反馈必须给出同一个业务结果，所以算的部分只写一次。
 */
import { nowTimestamp } from '../../core';
import type {
  ExperienceFeedbackApplication,
  MemoryRepository,
} from '../ports/memory-repository';
import type { Effectiveness, ExperienceRecord } from '../schemas';

/** 用后验证回写的单条引用（对齐 DriverReturn.referenced_experiences 条目） */
export interface UsageReference {
  /** 被引用经验的 id */
  experience_id: string;
  /** 是否实际应用了该经验 */
  applied: boolean;
  /** 该经验在本次任务中的效果 */
  effectiveness: Effectiveness;
  /** 备注 */
  note: string;
}

/** 单条经验回写的可观测明细（写入维护 evidence JSON，供中间产物核对置信度增长） */
export interface UsageFeedbackEntry {
  /** 被回写经验的 id */
  experience_id: string;
  /** 经验简述（便于人工核对） */
  description: string;
  /** driver 上报的效果档位 */
  effectiveness: Effectiveness;
  /** 回写前置信度 */
  from_confidence: number;
  /** 回写后置信度 */
  to_confidence: number;
  /** 回写后累计引用次数 */
  referenced_count: number;
}

/** 一次回写的结果统计 */
export interface UsageFeedbackResult {
  /** 被更新（置信度/引用计数）的经验条数 */
  updated_experiences: number;
  /** 引用但未找到的经验条数（静默跳过） */
  skipped_missing: number;
  /** 逐条回写明细（与 updated_experiences 一一对应） */
  details: UsageFeedbackEntry[];
}

/** 各效果档位的置信度增量 */
const CONFIDENCE_DELTA: Record<Effectiveness, number> = {
  fully_effective: 0.1,
  partially_effective: 0.05,
  ineffective: -0.1,
  not_applicable: 0,
};

/** 置信度上限：低于 1.0 保留区分度，同时保证 0.95 晋升门槛可达 */
const CONFIDENCE_CAP = 0.98;
/** 置信度下限：避免一次无效使用把经验清零 */
const CONFIDENCE_FLOOR = 0.1;

/**
 * 应用一次"用后验证"回写：按 references 更新被引用经验的置信度与引用计数。
 *
 * @param repository - MemoryRepository 端口
 * @param role_id    - 被引用经验所属的 Agent
 * @param references - 本次任务上报的引用列表（可能为空）
 * @returns 更新/跳过统计
 */
export async function applyUsageFeedback(
  repository: MemoryRepository,
  role_id: string,
  references: UsageReference[],
): Promise<UsageFeedbackResult> {
  if (references.length === 0) {
    return { updated_experiences: 0, skipped_missing: 0, details: [] };
  }

  const experiences = await repository.listExperiences(role_id);
  // 工作副本随回写推进更新，同一批内多次引用同一条经验可正确累计
  const byId = new Map(experiences.map((experience) => [experience.id, experience] as const));
  const now = nowTimestamp();

  let updatedExperiences = 0;
  let skippedMissing = 0;
  const details: UsageFeedbackEntry[] = [];
  for (const reference of references) {
    const experience = byId.get(reference.experience_id);
    if (!experience) {
      skippedMissing += 1;
      continue;
    }
    const updated = await writeBack(repository, role_id, experience, reference, now);
    byId.set(reference.experience_id, updated);
    details.push({
      experience_id: updated.id,
      description: updated.description,
      effectiveness: reference.effectiveness,
      from_confidence: experience.confidence,
      to_confidence: updated.confidence,
      referenced_count: updated.referenced_count,
    });
    updatedExperiences += 1;
  }

  if (updatedExperiences > 0) {
    await recomputeAvgConfidence(repository, role_id);
  }

  return { updated_experiences: updatedExperiences, skipped_missing: skippedMissing, details };
}

/** 单条经验回写：引用计数 +1，按效果调整置信度并追加溯源历史；返回更新后的记录 */
async function writeBack(
  repository: MemoryRepository,
  role_id: string,
  experience: ExperienceRecord,
  reference: UsageReference,
  now: string,
): Promise<ExperienceRecord> {
  const nextConfidence = nextConfidenceAfterFeedback(experience.confidence, reference.effectiveness);
  const updated: ExperienceRecord = {
    ...experience,
    referenced_count: experience.referenced_count + 1,
    confidence: nextConfidence,
    confidence_history: [
      ...experience.confidence_history,
      {
        value: nextConfidence,
        updated_at: now,
        reason: `usage_validation:${reference.effectiveness}`,
      },
    ],
    updated_at: now,
  };
  await repository.updateExperience(role_id, updated);
  return updated;
}

/** 重算 avg_confidence = 全部经验置信度均值（写入 updateMetrics，保持聚合根一致） */
export async function recomputeAvgConfidence(
  repository: MemoryRepository,
  role_id: string,
): Promise<void> {
  const experiences = await repository.listExperiences(role_id);
  await repository.updateMetrics(role_id, (metrics) => ({
    ...metrics,
    avg_confidence: averageConfidence(experiences),
  }));
}

/**
 * 一组经验的置信度均值（保留三位小数），空集为 0。
 *
 * 抽出来是因为「均值怎么算」正是并发回写最容易漂移的地方：进程内实现要在**同一段
 * 同步临界区**里算出它，数据库实现要在**同一个事务**里算出它——两边都得先拿到
 * 一份经验集合，再把这同一份算术用上。算法只写一处，两条腿就不会各算各的。
 *
 * 参数收成结构类型（只要有 `confidence`）：Phase 4 的输入快照里每一条经验也是这个形状，
 * 让它复用同一份算术，而不是在那边再写一遍 `sum / length`。多一处算术就多一个会漂的位数，
 * 而「均值保留几位」这种约定恰恰是最容易两边不一致的地方。
 */
export function averageConfidence(experiences: readonly { confidence: number }[]): number {
  if (experiences.length === 0) return 0;
  const sum = experiences.reduce((total, experience) => total + experience.confidence, 0);
  return round3(sum / experiences.length);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

// ═══════════════════════════════════════════
//  反馈写回的共享规则（反馈消费者与归并路径）
// ═══════════════════════════════════════════

/**
 * 回写后的置信度：按效果档位调整并夹在上下限之间。
 *
 * 单独抽出来，是因为**档位到增量、上下限**这三件事必须只有一处定义：遗留的进程内
 * 回写（applyUsageFeedback）与反馈消费者的原子应用（applyExperienceFeedback）算错了
 * 任何一处，同一条反馈在两条路径上就会给出两个置信度。记录怎么拼、写在哪，才是两边
 * 真正不同的部分。
 */
export function nextConfidenceAfterFeedback(
  current: number,
  effectiveness: Effectiveness,
): number {
  return round3(clamp(current + CONFIDENCE_DELTA[effectiveness], CONFIDENCE_FLOOR, CONFIDENCE_CAP));
}

/**
 * 反馈应用之后的经验记录（纯函数）：引用计数 +1、置信度按档位调整、追加一条带反馈
 * 溯源的置信度历史。
 *
 * `feedback_id` 写进历史条目，是**幂等判据的落点**（见 isFeedbackApplied）：它让
 * 「这条反馈已经作用过这条经验」成为一条可查的事实，而不是靠调用方记得自己做过什么。
 * 遗留的进程内回写（applyUsageFeedback）不走这里——它的条目没有 feedback_id，也就没有
 * 幂等可言（那条路径的重放由调用方自己保证不重复）；两条路径共用的是**算术**，不是记法。
 */
export function applyFeedbackToExperience(
  experience: ExperienceRecord,
  input: ExperienceFeedbackApplication,
  now: string,
): ExperienceRecord {
  const nextConfidence = nextConfidenceAfterFeedback(experience.confidence, input.effectiveness);
  return {
    ...experience,
    referenced_count: experience.referenced_count + 1,
    // 观察时刻可能早于上一次引用（反馈乱序到达），仍以「最近一次」为准
    last_referenced_at: latestTimestamp(experience.last_referenced_at, input.observed_at),
    confidence: nextConfidence,
    confidence_history: [
      ...experience.confidence_history,
      {
        value: nextConfidence,
        updated_at: now,
        reason:
          input.feedback_source === 'user_rating'
            ? `user_rating_validation:${input.effectiveness}`
            : `usage_validation:${input.effectiveness}`,
        feedback_id: input.feedback_id,
      },
    ],
    updated_at: now,
  };
}

/** 这条反馈是否已经作用过这条经验：置信度历史里有没有它 */
export function isFeedbackApplied(experience: ExperienceRecord, feedback_id: string): boolean {
  return experience.confidence_history.some((entry) => entry.feedback_id === feedback_id);
}

/** 两个可选时刻里较晚的那个（都没有则缺席） */
function latestTimestamp(
  current: string | undefined,
  candidate: string,
): string {
  if (current === undefined) return candidate;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}
