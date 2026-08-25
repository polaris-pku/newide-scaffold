/**
 * MemoryReindex — 全量重建向量索引服务（memory.reindex）
 *
 * 切换 embedding 模型后，存量 description_embedding 与新 EmbeddingProvider 不再
 * 同语义（甚至维度不同），Spec §7.2 约定"模型切换时需要全量重建索引
 * （description_embedding 全部重算）"。本服务遍历全部（或指定）Agent 的
 * Skills / Experiences，用注入的 EmbeddingProvider 重算 description_embedding
 * 并直写回仓库（repository.updateSkillEmbedding / updateExperienceEmbedding，
 * 不经 withDescriptionEmbedding 守卫，避免被旧 provider 二次 embed）。
 *
 * 默认跳过维度已匹配的记录（幂等，重跑便宜）；force=true 时无条件重算——
 * 覆盖"同维度换模型"场景。全量重建时市场池（__market__）技能一并参与
 * （marketSearch 同样依赖 description_embedding）。单条失败不中断整体，
 * 收集进 failures。
 */
import { nowTimestamp } from '../../core';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { MemoryRepository } from '../ports/memory-repository';
import { MARKET_POOL_ROLE_ID } from '../schemas';

/** 重建索引的入参 */
export interface ReindexMemoryOptions {
  /** 只重建该 Agent 名下的 Skills/Experiences；缺省重建全部 Agent（含市场池） */
  role_id?: string;
  /**
   * true = 无条件重算（同维度换模型场景也必须重算）；
   * false（默认）= 仅重算为空或维度不匹配的记录，天然幂等
   */
  force?: boolean;
}

/** 单条记录重建失败信息（不中断整体） */
export interface ReindexFailure {
  agent_id: string;
  kind: 'skill' | 'experience';
  id: string;
  error: string;
}

/** 重建索引的结果证据 */
export interface ReindexMemoryResult {
  /** all = 全量（含市场池）；role = 单 Agent */
  scope: 'all' | 'role';
  /** scope='role' 时的目标 Agent */
  role_id?: string;
  agents_processed: number;
  skills_reindexed: number;
  skills_skipped: number;
  experiences_reindexed: number;
  experiences_skipped: number;
  failures: ReindexFailure[];
  /** 当前 EmbeddingProvider 的向量维度（重建后的目标维度） */
  dimensions: number;
  started_at: string;
  completed_at: string;
}

/**
 * 重建向量索引：重算存量 Skills / Experiences 的 description_embedding 并写回。
 *
 * - role_id 缺省时遍历 repository.listAgentIds() 全量重建（含市场池技能）
 * - 显式 role_id 会先 getAgent 校验存在（不存在抛错）
 * - 默认跳过维度已匹配的记录；force=true 无条件重算
 * - 单条失败收集进 failures，不中断整体
 */
export async function reindexMemory(
  repository: MemoryRepository,
  embedding: EmbeddingProvider,
  options: ReindexMemoryOptions = {},
): Promise<ReindexMemoryResult> {
  const startedAt = nowTimestamp();
  if (options.role_id !== undefined) {
    // 校验显式 role_id 存在（不存在时 getAgent 抛错）
    await repository.getAgent(options.role_id);
  }
  const agentIds = options.role_id !== undefined ? [options.role_id] : await repository.listAgentIds();
  if (options.role_id === undefined) {
    // 市场池技能也参与重建（marketSearch 依赖 description_embedding）；未初始化则跳过
    try {
      await repository.getAgent(MARKET_POOL_ROLE_ID);
      agentIds.push(MARKET_POOL_ROLE_ID);
    } catch {
      // 市场池尚未初始化，跳过
    }
  }

  const result: ReindexMemoryResult = {
    scope: options.role_id !== undefined ? 'role' : 'all',
    ...(options.role_id !== undefined ? { role_id: options.role_id } : {}),
    agents_processed: 0,
    skills_reindexed: 0,
    skills_skipped: 0,
    experiences_reindexed: 0,
    experiences_skipped: 0,
    failures: [],
    dimensions: embedding.dimensions,
    started_at: startedAt,
    completed_at: startedAt,
  };

  for (const agentId of agentIds) {
    result.agents_processed += 1;
    const skills = await repository.listSkills(agentId);
    for (const skill of skills) {
      if (!needsReembed(skill.description_embedding, embedding.dimensions, options.force)) {
        result.skills_skipped += 1;
        continue;
      }
      try {
        const description_embedding = await embedding.embed(skill.description);
        await repository.updateSkillEmbedding(agentId, skill.id, description_embedding);
        result.skills_reindexed += 1;
      } catch (error) {
        result.failures.push({
          agent_id: agentId,
          kind: 'skill',
          id: skill.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const experiences = await repository.listExperiences(agentId);
    for (const experience of experiences) {
      if (
        !needsReembed(experience.description_embedding, embedding.dimensions, options.force)
      ) {
        result.experiences_skipped += 1;
        continue;
      }
      try {
        const description_embedding = await embedding.embed(experience.description);
        await repository.updateExperienceEmbedding(agentId, experience.id, description_embedding);
        result.experiences_reindexed += 1;
      } catch (error) {
        result.failures.push({
          agent_id: agentId,
          kind: 'experience',
          id: experience.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  result.completed_at = nowTimestamp();
  return result;
}

/** 是否需要重算：force=true，或向量为空 / 维度与当前 provider 不匹配 */
function needsReembed(
  embedding: number[],
  dimensions: number,
  force: boolean | undefined,
): boolean {
  return force === true || embedding.length !== dimensions;
}
