/**
 * 技能市场自学习 — 存活 Agent 定期扫描市场、按 tag + persona 相似度引入技能。
 *
 * 纯函数与编排分离：
 * - buildLearningQuery / computeTagSimilarity / evaluateSkillLearning：纯函数，可单测
 * - learnSkillsForAgent：编排（读 Agent → 检索市场池 → 评分 → 幂等引入）
 *
 * 检索范围仅限市场池（__market__）；已拥有 / 已引入过的技能跳过（幂等）。
 * 决策 = tagWeight * tag 相似度 + personaWeight * persona 相似度，且 persona
 * 相似度必须 >= minPersonaSimilarity（保底）。
 */
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { MemoryRepository } from '../ports/memory-repository';
import type { AgentHandle } from '../schemas';
import { cosineSimilarity } from '../utils/vector';

export interface SkillLearningOptions {
  /** 每次检索的市场候选上限（默认 10） */
  marketTopK?: number;
  /** persona 相似度保底（0~1），低于则不学习（默认 0.3） */
  minPersonaSimilarity?: number;
  /** tag 相似度权重（默认 0.4） */
  tagWeight?: number;
  /** persona 相似度权重（默认 0.6） */
  personaWeight?: number;
  /** combined 分阈值（默认 0.45） */
  learnThreshold?: number;
  /** 每轮每个 Agent 最多引入技能数（默认 3） */
  maxSkillsPerAgentPerCycle?: number;
}

export interface SkillLearningDecision {
  skill_id: string;
  tag_similarity: number;
  persona_similarity: number;
  combined: number;
  learn: boolean;
  reason: 'learned' | 'persona_below_floor' | 'below_threshold';
}

export interface SkillLearningOutcome {
  role_id: string;
  imported_skill_ids: string[];
  skipped_skill_ids: string[];
  decisions: SkillLearningDecision[];
}

export const DEFAULT_SKILL_LEARNING_OPTIONS: Required<SkillLearningOptions> = {
  marketTopK: 10,
  minPersonaSimilarity: 0.3,
  tagWeight: 0.4,
  personaWeight: 0.6,
  learnThreshold: 0.45,
  maxSkillsPerAgentPerCycle: 3,
};

/** 从 Agent 的 Persona + tags 构建市场检索文本。 */
export function buildLearningQuery(handle: AgentHandle): string {
  return [
    handle.persona.summary,
    handle.persona.skills_overview,
    handle.persona.experience_coverage,
    ...(handle.tags ?? []),
  ]
    .filter((part) => typeof part === 'string' && part.trim().length > 0)
    .join('\n');
}

/** tag 相似度（Jaccard：交集 / 并集）。 */
export function computeTagSimilarity(
  agentTags: string[] | undefined,
  skillTags: string[],
): number {
  const agent = new Set(agentTags ?? []);
  const skill = new Set(skillTags);
  const union = new Set([...agent, ...skill]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const tag of agent) {
    if (skill.has(tag)) intersection += 1;
  }
  return intersection / union.size;
}

/**
 * 学习决策：combined = tagWeight*tag + personaWeight*persona。
 * persona 相似度低于保底 → 直接不学（reason='persona_below_floor'）。
 */
export function evaluateSkillLearning(input: {
  skill_id: string;
  tag_similarity: number;
  persona_similarity: number;
  options?: SkillLearningOptions;
}): SkillLearningDecision {
  const options = { ...DEFAULT_SKILL_LEARNING_OPTIONS, ...input.options };
  const tag = clamp01(input.tag_similarity);
  const persona = clamp01(input.persona_similarity);
  const combined = options.tagWeight * tag + options.personaWeight * persona;

  if (persona < options.minPersonaSimilarity) {
    return {
      skill_id: input.skill_id,
      tag_similarity: tag,
      persona_similarity: persona,
      combined,
      learn: false,
      reason: 'persona_below_floor',
    };
  }
  const learn = combined >= options.learnThreshold;
  return {
    skill_id: input.skill_id,
    tag_similarity: tag,
    persona_similarity: persona,
    combined,
    learn,
    reason: learn ? 'learned' : 'below_threshold',
  };
}

/**
 * 让单个 Agent 扫描市场池并学习技能（幂等）。
 *
 * @param repository - MemoryRepository 端口
 * @param embedding  - EmbeddingProvider（构建检索 query 向量）
 * @param roleId     - 学习者 Agent
 * @param options    - 学习策略
 * @returns 引入 / 跳过清单与逐条决策
 */
export async function learnSkillsForAgent(
  repository: MemoryRepository,
  embedding: EmbeddingProvider,
  roleId: string,
  options: SkillLearningOptions = {},
): Promise<SkillLearningOutcome> {
  const opts = { ...DEFAULT_SKILL_LEARNING_OPTIONS, ...options };
  const handle = await repository.getAgent(roleId);
  const queryText = buildLearningQuery(handle);
  const queryEmbedding = await embedding.embed(queryText);

  // 仅检索市场池（__market__），排除自身
  const candidates = await repository.marketSearchSkills({
    query_embedding: queryEmbedding,
    top_k: opts.marketTopK,
    min_similarity: opts.minPersonaSimilarity,
    exclude_agent_id: roleId,
  });

  // 去重：已拥有 / 已引入过副本
  const owned = new Set<string>();
  const importedFrom = new Set<string>();
  for (const skill of await repository.listSkills(roleId)) {
    owned.add(skill.id);
    if (skill.imported_from) importedFrom.add(skill.imported_from);
  }

  const decisions: SkillLearningDecision[] = [];
  const importedSkillIds: string[] = [];
  const skippedSkillIds: string[] = [];

  for (const skill of candidates) {
    if (owned.has(skill.id) || importedFrom.has(skill.id)) {
      skippedSkillIds.push(skill.id);
      continue;
    }
    const personaSimilarity = cosineSimilarity(queryEmbedding, skill.description_embedding);
    const decision = evaluateSkillLearning({
      skill_id: skill.id,
      tag_similarity: computeTagSimilarity(handle.tags, skill.tags),
      persona_similarity: personaSimilarity,
      options: opts,
    });
    decisions.push(decision);
    if (decision.learn) {
      await repository.marketImportSkill(roleId, skill.id);
      importedSkillIds.push(skill.id);
      if (importedSkillIds.length >= opts.maxSkillsPerAgentPerCycle) break;
    } else {
      skippedSkillIds.push(skill.id);
    }
  }

  return {
    role_id: roleId,
    imported_skill_ids: importedSkillIds,
    skipped_skill_ids: skippedSkillIds,
    decisions,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
