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
 */
import { nowTimestamp } from '../../core';
import type { MemoryRepository } from '../ports/memory-repository';
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
  const delta = CONFIDENCE_DELTA[reference.effectiveness];
  const nextConfidence = round3(
    clamp(experience.confidence + delta, CONFIDENCE_FLOOR, CONFIDENCE_CAP),
  );
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
async function recomputeAvgConfidence(
  repository: MemoryRepository,
  role_id: string,
): Promise<void> {
  const experiences = await repository.listExperiences(role_id);
  const average =
    experiences.length > 0
      ? experiences.reduce((sum, experience) => sum + experience.confidence, 0) /
        experiences.length
      : 0;
  await repository.updateMetrics(role_id, (metrics) => ({
    ...metrics,
    avg_confidence: round3(average),
  }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
