/**
 * MemoryWriter — 手动写入口服务（memory.createSkill / updateSkill / deleteSkill /
 * publishSkillToMarket / updateExperience / deleteExperience）
 *
 * 对应方案书 M2：为前端提供「从零写入」技能 / 经验通道，解决 curation 零写入口
 * 与「无法手动导入 Skill」两个局限。与 skill-review 同模式：纯函数式，只依赖
 * MemoryRepository 端口，不经过 Agent 实例（embedding / id / 时间戳由服务端补全，
 * description_embedding 传空数组由仓库 withDescriptionEmbedding 补向量）。
 *
 * 幂等约定：createSkill 以 (agent_id, description + content) 去重，重复创建返回
 * 已存在项；updateSkill / updateExperience 为 PATCH 语义，未提供的字段保持不变。
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import type { MemoryRepository } from '../ports/memory-repository';
import type { ExperienceRecord, MarketStatus, SkillRecord } from '../schemas';

/** 手动创建 Skill 的入参 */
export interface CreateSkillInput {
  /** 所属 Agent 的 role_id */
  role_id: string;
  /** 技能简短描述（用于列表展示与相似度检索） */
  description: string;
  /** 技能的完整内容（结构化指令或代码片段） */
  content: string;
  /** 分类标签 */
  tags?: string[];
  /** 技能版本号（默认 '1.0.0'） */
  version?: string;
}

/** 手动创建 Skill 的选项 */
export interface CreateSkillOptions {
  /** 创建后直接置 approved（NEWIDE_B_SKILL_AUTO_APPROVE=1 时由 B 服务透传） */
  autoApprove?: boolean;
}

/** Skill PATCH 补丁（未提供的字段保持不变） */
export interface SkillWritePatch {
  description?: string;
  content?: string;
  tags?: string[];
  /** 市场上架状态：available=可被市场检索 / superseded=已淘汰（retired_unique 仅退休流程使用） */
  market_status?: MarketStatus;
}

/** Experience PATCH 补丁（未提供的字段保持不变） */
export interface ExperienceWritePatch {
  description?: string;
  content?: string;
  tags?: string[];
  /** 人工调整置信度（0~1），写入 confidence_history（reason='manual_adjustment'）并同步 avg_confidence */
  confidence?: number;
}

/**
 * 手动创建一条 Skill。
 *
 * - 幂等：同 Agent 下 description + content 完全相同的已有技能直接返回（不重复写入）
 * - review_status 默认 pending；options.autoApprove 时直接 approved（进入检索资格）
 * - description_embedding 由仓库在写入时补全
 */
export async function createSkill(
  repository: MemoryRepository,
  input: CreateSkillInput,
  options: CreateSkillOptions = {},
): Promise<SkillRecord> {
  // 校验 Agent 存在（不存在时 getAgent 抛错）
  await repository.getAgent(input.role_id);

  const now = nowTimestamp();
  const existing = (await repository.listSkills(input.role_id)).find(
    (skill) => skill.description === input.description && skill.content === input.content,
  );
  if (existing) {
    return existing;
  }

  const skill: SkillRecord = {
    id: randomUUID(),
    description: input.description,
    description_embedding: [],
    content: input.content,
    version: input.version ?? '1.0.0',
    review_status: options.autoApprove ? 'approved' : 'pending',
    tags: input.tags ?? [],
    promoted_at: now,
    agent_id: input.role_id,
    created_at: now,
    updated_at: now,
  };
  await repository.saveSkill(input.role_id, skill);
  return (await requireStoredSkill(repository, input.role_id, skill.id)) ?? skill;
}

/**
 * PATCH 更新一条 Skill。
 *
 * - description 变更时强制重算 embedding（description_embedding 置空由仓库补全）
 * - market_status 仅允许 available / superseded（retired_unique 由退休流程独占）
 */
export async function updateSkill(
  repository: MemoryRepository,
  role_id: string,
  skill_id: string,
  patch: SkillWritePatch,
): Promise<SkillRecord> {
  const skills = await repository.listSkills(role_id);
  const skill = skills.find((item) => item.id === skill_id);
  if (!skill) {
    throw new Error(`Skill not found: ${skill_id}`);
  }
  const descriptionChanged =
    patch.description !== undefined && patch.description !== skill.description;
  const updated: SkillRecord = {
    ...skill,
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.market_status !== undefined ? { market_status: patch.market_status } : {}),
    ...(descriptionChanged ? { description_embedding: [] } : {}),
    updated_at: nowTimestamp(),
  };
  await repository.updateSkill(role_id, updated);
  return (await requireStoredSkill(repository, role_id, skill_id)) ?? updated;
}

/** 删除一条 Skill（repo 层 deleteSkill，删除不存在抛错） */
export async function deleteSkill(
  repository: MemoryRepository,
  role_id: string,
  skill_id: string,
): Promise<void> {
  await repository.deleteSkill(role_id, skill_id);
}

/**
 * 轻量上架技能到市场：置 market_status='available'（保留归属，不迁移到 __market__）。
 * 与退休流程的 transferSkillToMarket（归属转移）语义区分。
 */
export async function publishSkillToMarket(
  repository: MemoryRepository,
  role_id: string,
  skill_id: string,
): Promise<SkillRecord> {
  return updateSkill(repository, role_id, skill_id, { market_status: 'available' });
}

/**
 * PATCH 更新一条 Experience。
 *
 * - description 变更时强制重算 embedding
 * - confidence 变更时：校验 0~1、追加 confidence_history（reason='manual_adjustment'）、
 *   同步重算 AgentMetrics.avg_confidence
 */
export async function updateExperience(
  repository: MemoryRepository,
  role_id: string,
  experience_id: string,
  patch: ExperienceWritePatch,
): Promise<ExperienceRecord> {
  const experiences = await repository.listExperiences(role_id);
  const experience = experiences.find((item) => item.id === experience_id);
  if (!experience) {
    throw new Error(`Experience not found: ${experience_id}`);
  }
  if (patch.confidence !== undefined && (patch.confidence < 0 || patch.confidence > 1)) {
    throw new Error(`Confidence must be within [0, 1]: ${patch.confidence}`);
  }
  const now = nowTimestamp();
  const descriptionChanged =
    patch.description !== undefined && patch.description !== experience.description;
  const confidenceChanged =
    patch.confidence !== undefined && patch.confidence !== experience.confidence;

  const updated: ExperienceRecord = {
    ...experience,
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(descriptionChanged ? { description_embedding: [] } : {}),
    ...(confidenceChanged
      ? {
          confidence: patch.confidence as number,
          confidence_history: [
            ...experience.confidence_history,
            { value: patch.confidence as number, updated_at: now, reason: 'manual_adjustment' },
          ],
        }
      : {}),
    updated_at: now,
  };
  await repository.updateExperience(role_id, updated);

  if (confidenceChanged) {
    await recomputeAvgConfidence(repository, role_id);
  }
  return (await requireStoredExperience(repository, role_id, experience_id)) ?? updated;
}

/** 删除一条 Experience（若其晋升过 Skill，仅删经验、不影响已晋升的技能） */
export async function deleteExperience(
  repository: MemoryRepository,
  role_id: string,
  experience_id: string,
): Promise<void> {
  await repository.deleteExperience(role_id, experience_id);
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

/** 回读一条已存储的 Skill（仓库写入时补全了 embedding 等派生字段） */
async function requireStoredSkill(
  repository: MemoryRepository,
  role_id: string,
  skill_id: string,
): Promise<SkillRecord | undefined> {
  return (await repository.listSkills(role_id)).find((item) => item.id === skill_id);
}

/** 回读一条已存储的 Experience */
async function requireStoredExperience(
  repository: MemoryRepository,
  role_id: string,
  experience_id: string,
): Promise<ExperienceRecord | undefined> {
  return (await repository.listExperiences(role_id)).find((item) => item.id === experience_id);
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
