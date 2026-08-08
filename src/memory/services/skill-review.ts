/**
 * SkillReview — pending Skill 的审批状态迁移服务
 *
 * 为晋升后处于 pending 状态的 Skill 提供人工审批入口：reviewSkill 接收
 * role_id、skill_id、审批结果（approved/rejected）与审批人，将 Skill 迁移到
 * 对应终态并写回 MemoryRepository。
 *
 * 存储与 Agent 分离：本服务直接操作 MemoryRepository 端口（listSkills +
 * updateSkill / updateExperience），不依赖任何 Agent 实例或 AgentMemoryScope。
 *
 * 核心逻辑：
 *   1. 严格状态机：仅 pending → approved / rejected 是合法迁移，非 pending 或
 *      不存在的 Skill 一律抛错
 *   2. 批准：写入 review_status / reviewed_by / reviewed_at，approved 后即满足
 *      检索资格（isEligibleSkill 与检索流水线均按 review_status='approved' 过滤），
 *      从下一次 Agent 任务开始自动进入 B 的检索与 Context 构建
 *   3. 拒绝：同样写入审核字段，并清除来源 Experience 的 promoted_to，解除晋升
 *      绑定，允许该经验未来被重新晋升
 */
import { nowTimestamp } from '../../core';
import type { MemoryRepository } from '../ports/memory-repository';
import type { ExperienceRecord, SkillRecord } from '../schemas';

/** 审批结果：与 SkillRecord.review_status 的合法终态一一对应 */
export type SkillReviewDecision = 'approved' | 'rejected';

/** reviewSkill 的入参 */
export interface ReviewSkillInput {
  /** 所属 Agent 的 role_id */
  role_id: string;
  /** 待审批 Skill 的 id */
  skill_id: string;
  /** 审批结果（approved=批准，rejected=拒绝） */
  decision: SkillReviewDecision;
  /** 审批人标识（人工或系统审核方） */
  reviewer: string;
}

/**
 * 审批一条 pending Skill 并返回更新后的 SkillRecord。
 *
 * @param repository - MemoryRepository 端口（直接操作存储，不经过 Agent 实例）
 * @param input      - role_id / skill_id / decision / reviewer
 * @returns 更新后的 SkillRecord（review_status 已迁移，approved 后自动进入检索资格）
 * @throws 当 Skill 不存在或当前状态非 pending 时抛错
 */
export async function reviewSkill(
  repository: MemoryRepository,
  input: ReviewSkillInput,
): Promise<SkillRecord> {
  const skill = await requirePendingSkill(repository, input.role_id, input.skill_id);

  const now = nowTimestamp();
  const reviewed: SkillRecord = {
    ...skill,
    review_status: input.decision,
    reviewed_by: input.reviewer,
    reviewed_at: now,
    updated_at: now,
  };

  await repository.updateSkill(input.role_id, reviewed);

  if (input.decision === 'rejected' && skill.promoted_from) {
    await clearPromotionBinding(repository, input.role_id, skill.promoted_from);
  }

  return reviewed;
}

/** 查找 Skill 并校验其处于 pending 状态（严格状态机，仅 pending 可审批） */
async function requirePendingSkill(
  repository: MemoryRepository,
  role_id: string,
  skill_id: string,
): Promise<SkillRecord> {
  const skills = await repository.listSkills(role_id);
  const skill = skills.find((item) => item.id === skill_id);
  if (!skill) {
    throw new Error(`Skill not found: ${skill_id}`);
  }
  if (skill.review_status !== 'pending') {
    throw new Error(`Skill is not pending: ${skill_id} (current: ${skill.review_status})`);
  }
  return skill;
}

/**
 * 拒绝 Skill 后清除来源 Experience 的 promoted_to，解除晋升绑定。
 * 来源经验不存在时跳过（防御性处理，不阻断审批）。
 */
async function clearPromotionBinding(
  repository: MemoryRepository,
  role_id: string,
  experience_id: string,
): Promise<void> {
  const experiences = await repository.listExperiences(role_id);
  const source = experiences.find((item) => item.id === experience_id);
  if (!source) {
    return;
  }
  const unbound: ExperienceRecord = { ...source, promoted_to: undefined };
  await repository.updateExperience(role_id, unbound);
}
