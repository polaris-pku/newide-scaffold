/**
 * 退休资产处置与替代 Agent 创建
 *
 * 对应 week3 RFC 深度设计「第二部分 Retire」的 §12（执行路径）、§13（资产处置）、§14（替代 Agent）。
 * 由 AgentManager.retireAgent() 调用；本模块保持纯函数式（只依赖 MemoryRepository），便于单测。
 *
 * ## 资产处置规则（§13 简化版）
 *
 * Skills：
 * - review_status = 'rejected' → 丢弃（deleteSkill）
 * - 其他（approved / pending）→ 迁移到市场池（transferSkillToMarket，挂到
 *   __market__ 固定 Agent 名下），并按市场状态标记：
 *   - 已被其他 Agent 引入（imported_by 非空）→ market_status = 'available'（归市场所有）
 *   - 否则 → market_status = 'retired_unique'（视为稀缺遗产，保留在市场中）
 *
 * Experiences（§13.2）：
 * - confidence >= 0.7（Level A/B）→ 保留（留在原 Agent 名下作为归档）
 * - confidence < 0.7（Level C/D）→ 丢弃（deleteExperience）
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import type { MemoryRepository } from '../ports/memory-repository';
import type {
  AgentArchiveRecord,
  AgentHandle,
  ExperienceRecord,
  RetiredReason,
  SkillRecord,
} from '../schemas';

export interface RetireAssetDisposition {
  skills_retained: number;
  skills_discarded: number;
  experiences_retained: number;
  experiences_discarded: number;
}

export interface RetireOptions {
  /** 退休原因，默认 'manual' */
  reason?: RetiredReason;
  /** 是否创建替代 Agent：'clean_slate' | 'seeded_slate' | 'none'，默认 'none' */
  replacement?: 'clean_slate' | 'seeded_slate' | 'none';
}

export interface RetireResult {
  role_id: string;
  /**
   * - 'retired'：退休完成，实体已归档并删除
   * - 'pre_retired'：已标记预退休（不再接新任务），等待在跑任务完成后自动退休
   */
  status: 'retired' | 'pre_retired';
  retired_at?: string;
  retired_reason?: RetiredReason;
  asset_disposition?: RetireAssetDisposition;
  replacement_role_id?: string;
  /** status='pre_retired' 时为 true：仍有在跑任务，尚未真正退休 */
  pending?: boolean;
}

/** 资产处置入参（由 AgentManager 在 retireAgent 时从仓库读取） */
export interface RetireAssetInput {
  role_id: string;
  skills: SkillRecord[];
  experiences: ExperienceRecord[];
}

/** 保留经验的置信度下限（Level A/B 边界） */
export const RETAINED_EXPERIENCE_MIN_CONFIDENCE = 0.7;

/**
 * 执行退休资产处置。返回处置统计；不改变 Agent 状态。
 */
export async function disposeRetiredAssets(
  repository: MemoryRepository,
  input: RetireAssetInput,
): Promise<RetireAssetDisposition> {
  let skillsRetained = 0;
  let skillsDiscarded = 0;
  for (const skill of input.skills) {
    if (skill.review_status === 'rejected') {
      await repository.deleteSkill(input.role_id, skill.id);
      skillsDiscarded += 1;
      continue;
    }
    // 保留技能迁移到市场池（__market__ 名下），退休 Agent 之后可安全归档。
    // market_status 决定其在市场中的推荐身份（available / retired_unique）。
    const marketOwned = (skill.imported_by?.length ?? 0) > 0;
    await repository.transferSkillToMarket(input.role_id, skill.id, {
      market_status: marketOwned ? 'available' : 'retired_unique',
    });
    skillsRetained += 1;
  }

  let experiencesRetained = 0;
  let experiencesDiscarded = 0;
  for (const experience of input.experiences) {
    if (experience.confidence >= RETAINED_EXPERIENCE_MIN_CONFIDENCE) {
      experiencesRetained += 1;
    } else {
      await repository.deleteExperience(input.role_id, experience.id);
      experiencesDiscarded += 1;
    }
  }

  return {
    skills_retained: skillsRetained,
    skills_discarded: skillsDiscarded,
    experiences_retained: experiencesRetained,
    experiences_discarded: experiencesDiscarded,
  };
}

/** 可继承给替代 Agent 的经验条数上限 */
export const MAX_INHERITED_EXPERIENCES = 2;

/**
 * 创建替代 Agent（§14）。
 *
 * - 'clean_slate'：纯白板。继承来源 Agent 的前 2 个 tags，不继承经验。
 * - 'seeded_slate'：带种子。继承 tags + persona_seed，并继承至多 2 条
 *   Level A 经验（confidence >= 0.9 且 referenced_count >= 3）。
 *
 * 新 role_id = `${source.role_id}__replacement`。
 */
export async function createReplacementAgent(
  repository: MemoryRepository,
  source: AgentHandle,
  experiences: ExperienceRecord[],
  strategy: 'clean_slate' | 'seeded_slate',
): Promise<string> {
  const roleId = `${source.role_id}__replacement`;
  const baseTags = source.tags ?? [];
  const tags = strategy === 'clean_slate' ? baseTags.slice(0, 2) : [...baseTags];
  const personaSeed =
    strategy === 'seeded_slate' && tags.length > 0
      ? `You have the potential to grow into an expert in: ${tags.join(', ')}.`
      : undefined;

  await repository.initializeAgent({
    role_id: roleId,
    name: `${source.name} (replacement)`,
    tags,
    persona_seed: personaSeed,
  });

  if (strategy === 'seeded_slate') {
    const now = nowTimestamp();
    const levelA = experiences
      .filter((e) => e.confidence >= 0.9 && e.referenced_count >= 3)
      .slice(0, MAX_INHERITED_EXPERIENCES);
    for (const experience of levelA) {
      const inherited: ExperienceRecord = {
        ...experience,
        id: randomUUID(),
        agent_id: roleId,
        promoted_to: undefined,
        referenced_count: 0,
        last_referenced_at: undefined,
        created_at: now,
        updated_at: now,
        confidence_history: [...experience.confidence_history],
      };
      await repository.saveExperience(roleId, inherited);
    }
  }

  return roleId;
}

/**
 * 构建退休归档（最小字段）。
 *
 * 退休 finalize 时在删除 Agent 实体之前写入，保证删除后仍有 role_id /
 * 名称 / 时间 / 原因 / 资产处置计数等必要字段可追溯。
 */
export function buildAgentArchive(
  handle: AgentHandle,
  input: {
    retired_at: string;
    retired_reason: RetiredReason;
    asset_disposition: RetireAssetDisposition;
    replacement_role_id?: string;
  },
): AgentArchiveRecord {
  return {
    role_id: handle.role_id,
    name: handle.name,
    status: 'retired',
    retired_at: input.retired_at,
    retired_reason: input.retired_reason,
    ...(handle.tags !== undefined ? { tags: handle.tags } : {}),
    asset_disposition: input.asset_disposition,
    ...(input.replacement_role_id ? { replacement_role_id: input.replacement_role_id } : {}),
  };
}
