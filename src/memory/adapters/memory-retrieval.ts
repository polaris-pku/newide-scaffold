/**
 * 记忆检索适配器（memory 内部）
 *
 * ReMe 第一阶段：索引层 top-K 向量召回 → confidence 过滤 → 总量截断。
 * tag 命中作为向量召回之外的补充路径。
 * 不负责 DriverContext 组装 —— 组装见 services/driver-context.ts。
 *
 * ## 筛选规则（Spec §5.1 第一阶段，LLM 精筛留后续）
 *
 * 1. 向量 top-K 召回（默认 K=20）+ 最低余弦相似度门槛（默认 0.5）
 * 2. tag 补充：eligible 池中 tag 命中但未被向量召回的条目
 * 3. experience 过滤 confidence ≥ min_confidence（默认 0.2）
 * 4. 按相关度排序，skills + experiences 合计不超过 max_memory_items（默认 5）
 *
 * ## 调用链
 *
 * ```
 * repositoryRetrieveMemoryForTask → retrieveMemoriesForTask（本文件）
 * memory-cycle → buildDriverContext（services/driver-context.ts）
 * ```
 */
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { ExperienceRecord, SkillRecord } from '../schemas';
import type { MemoryRetrievalResult } from '../services/memory-query';
import { cosineSimilarity } from '../utils/vector';
import { defaultHashEmbeddingProvider } from './hash-embedding-provider';

/** ReMe 索引层默认 top-K（Spec §5.1） */
const DEFAULT_RECALL_TOP_K = 20;

/** 经验最低置信度（Spec §5.1） */
const DEFAULT_MIN_CONFIDENCE = 0.2;

/** 注入 Driver 的记忆条目总量上限（MemoryPolicy.max_memory_items） */
const DEFAULT_MAX_MEMORY_ITEMS = 5;

/** tag 补充路径：task_query token 与 tags 的最低重叠命中数 */
const DEFAULT_MIN_TAG_OVERLAP = 1;

/** 向量召回最低余弦相似度（低于此值视为不相关，不返回） */
const DEFAULT_MIN_EMBEDDING_SIMILARITY = 0.5;

/**
 * retrieveMemoriesForTask 的输入。
 * task_query 通常来自 task.spec，用于生成 task embedding 及 tag 匹配。
 */
export interface RetrieveMemoriesInput {
  task_query: string;
}

/**
 * 记忆检索策略（ReMe 第一阶段 + tag 补充）。
 */
export interface MemoryRelevancePolicy {
  include_skills: boolean;
  include_recent_experience: boolean;
  /** 索引层向量召回 top-K */
  recall_top_k: number;
  /** 向量召回最低余弦相似度 */
  min_embedding_similarity: number;
  /** 经验最低置信度 */
  min_confidence: number;
  /** skills + experiences 合计最大条目数 */
  max_memory_items: number;
  /** tag 补充路径的最低重叠命中数 */
  min_tag_overlap: number;
}

/**
 * 可选检索参数：策略覆盖与自定义 EmbeddingProvider。
 */
export interface MemoryRetrievalOptions {
  selection?: Partial<MemoryRelevancePolicy>;
  embedding?: EmbeddingProvider;
}

interface MemorySources {
  skills: SkillRecord[];
  experiences: ExperienceRecord[];
}

interface ScoredMemoryItem {
  kind: 'skill' | 'experience';
  skill?: SkillRecord;
  experience?: ExperienceRecord;
  embedding_similarity: number;
  tag_overlap: number;
}

/**
 * 为任务检索相关记忆的主入口。
 *
 * 流水线：向量 top-K → tag 补充 → confidence 过滤 → 相关度排序 → 总量截断。
 */
export async function retrieveMemoriesForTask(
  scope: AgentMemoryScope,
  input: RetrieveMemoriesInput,
  options?: MemoryRetrievalOptions,
): Promise<MemoryRetrievalResult> {
  const embedding = options?.embedding ?? defaultHashEmbeddingProvider;
  const policy = resolveRelevancePolicy(options);
  const taskEmbedding = await embedding.embed(input.task_query);

  const vectorSkills = policy.include_skills
    ? await scope.searchSkills({
        query_embedding: taskEmbedding,
        top_k: policy.recall_top_k,
        min_similarity: policy.min_embedding_similarity,
      })
    : [];
  const vectorExperiences = policy.include_recent_experience
    ? await scope.searchExperiences({
        query_embedding: taskEmbedding,
        top_k: policy.recall_top_k,
        min_similarity: policy.min_embedding_similarity,
        min_confidence: policy.min_confidence,
      })
    : [];

  const sources = await loadMemorySources(scope);
  const eligible = filterEligibleMemories(sources, policy);

  const candidates = await buildCandidateSet(
    input.task_query,
    taskEmbedding,
    policy,
    embedding,
    eligible,
    vectorSkills,
    vectorExperiences,
  );

  const selected = candidates.slice(0, policy.max_memory_items);
  return partitionSelectedMemories(selected);
}

async function loadMemorySources(scope: AgentMemoryScope): Promise<MemorySources> {
  const [skills, experiences] = await Promise.all([scope.listSkills(), scope.listExperiences()]);
  return { skills, experiences };
}

function resolveRelevancePolicy(options?: MemoryRetrievalOptions): MemoryRelevancePolicy {
  const overrides = options?.selection;
  return {
    include_skills: overrides?.include_skills ?? true,
    include_recent_experience: overrides?.include_recent_experience ?? true,
    recall_top_k: overrides?.recall_top_k ?? DEFAULT_RECALL_TOP_K,
    min_embedding_similarity:
      overrides?.min_embedding_similarity ?? DEFAULT_MIN_EMBEDDING_SIMILARITY,
    min_confidence: overrides?.min_confidence ?? DEFAULT_MIN_CONFIDENCE,
    max_memory_items: overrides?.max_memory_items ?? DEFAULT_MAX_MEMORY_ITEMS,
    min_tag_overlap: overrides?.min_tag_overlap ?? DEFAULT_MIN_TAG_OVERLAP,
  };
}

function filterEligibleMemories(
  sources: MemorySources,
  policy: MemoryRelevancePolicy,
): MemorySources {
  const skills = policy.include_skills
    ? sources.skills.filter(
        (skill) => skill.review_status === 'approved' && skill.market_status !== 'superseded',
      )
    : [];

  const experiences = policy.include_recent_experience
    ? sources.experiences.filter(
        (experience) =>
          experience.type === 'positive' &&
          !experience.promoted_to &&
          experience.confidence >= policy.min_confidence,
      )
    : [];

  return { skills, experiences };
}

async function buildCandidateSet(
  task_query: string,
  taskEmbedding: number[],
  policy: MemoryRelevancePolicy,
  embedding: EmbeddingProvider,
  eligible: MemorySources,
  vectorSkills: SkillRecord[],
  vectorExperiences: ExperienceRecord[],
): Promise<ScoredMemoryItem[]> {
  const seenSkillIds = new Set(vectorSkills.map((skill) => skill.id));
  const seenExperienceIds = new Set(vectorExperiences.map((experience) => experience.id));
  const scored: ScoredMemoryItem[] = [];

  for (const skill of vectorSkills) {
    scored.push(await scoreSkill(skill, task_query, taskEmbedding, embedding));
  }

  for (const experience of vectorExperiences) {
    scored.push(await scoreExperience(experience, task_query, taskEmbedding, embedding));
  }

  for (const skill of eligible.skills) {
    if (seenSkillIds.has(skill.id)) {
      continue;
    }
    const tag_overlap = scoreTagOverlap(skill.tags, task_query);
    if (tag_overlap >= policy.min_tag_overlap) {
      seenSkillIds.add(skill.id);
      scored.push(await scoreSkill(skill, task_query, taskEmbedding, embedding, tag_overlap));
    }
  }

  for (const experience of eligible.experiences) {
    if (seenExperienceIds.has(experience.id)) {
      continue;
    }
    const tag_overlap = scoreTagOverlap(experience.tags, task_query);
    if (tag_overlap >= policy.min_tag_overlap) {
      seenExperienceIds.add(experience.id);
      scored.push(
        await scoreExperience(experience, task_query, taskEmbedding, embedding, tag_overlap),
      );
    }
  }

  return scored.sort((left, right) => compareRelevance(left, right));
}

async function scoreSkill(
  skill: SkillRecord,
  task_query: string,
  taskEmbedding: number[],
  embedding: EmbeddingProvider,
  tag_overlap = scoreTagOverlap(skill.tags, task_query),
): Promise<ScoredMemoryItem> {
  const itemEmbedding = await resolveItemEmbedding(skill, embedding);
  return {
    kind: 'skill',
    skill,
    embedding_similarity: cosineSimilarity(taskEmbedding, itemEmbedding),
    tag_overlap,
  };
}

async function scoreExperience(
  experience: ExperienceRecord,
  task_query: string,
  taskEmbedding: number[],
  embedding: EmbeddingProvider,
  tag_overlap = scoreTagOverlap(experience.tags, task_query),
): Promise<ScoredMemoryItem> {
  const itemEmbedding = await resolveItemEmbedding(experience, embedding);
  return {
    kind: 'experience',
    experience,
    embedding_similarity: cosineSimilarity(taskEmbedding, itemEmbedding),
    tag_overlap,
  };
}

function partitionSelectedMemories(selected: ScoredMemoryItem[]): MemoryRetrievalResult {
  const skills: SkillRecord[] = [];
  const experiences: ExperienceRecord[] = [];

  for (const entry of selected) {
    if (entry.kind === 'skill' && entry.skill) {
      skills.push(entry.skill);
    } else if (entry.kind === 'experience' && entry.experience) {
      experiences.push(entry.experience);
    }
  }

  return { skills, experiences };
}

/** 优先使用已存储的 description_embedding；维度不匹配时回退 embed(description) */
async function resolveItemEmbedding(
  item: SkillRecord | ExperienceRecord,
  embedding: EmbeddingProvider,
): Promise<number[]> {
  if (item.description_embedding.length === embedding.dimensions) {
    return item.description_embedding;
  }
  return embedding.embed(item.description);
}

function compareRelevance(left: ScoredMemoryItem, right: ScoredMemoryItem): number {
  const leftScore = Math.max(left.embedding_similarity, normalizeTagScore(left.tag_overlap));
  const rightScore = Math.max(right.embedding_similarity, normalizeTagScore(right.tag_overlap));
  if (rightScore !== leftScore) {
    return rightScore - leftScore;
  }
  if (right.embedding_similarity !== left.embedding_similarity) {
    return right.embedding_similarity - left.embedding_similarity;
  }
  return right.tag_overlap - left.tag_overlap;
}

/** 将 tag 命中数映射到 0~1，便于与 embedding 分数联合排序 */
function normalizeTagScore(tag_overlap: number): number {
  return Math.min(1, tag_overlap / 3);
}

/**
 * 统计 task_query token 与 tags 的交集命中数。
 * token 与 tag 双向包含即算命中（忽略大小写）。
 */
function scoreTagOverlap(tags: string[], task_query: string): number {
  const queryTokens = tokenizeQuery(task_query);
  if (queryTokens.length === 0 || tags.length === 0) {
    return 0;
  }

  const normalizedTags = tags.map((tag) => tag.toLowerCase());
  let overlap = 0;

  for (const token of queryTokens) {
    const matched = normalizedTags.some((tag) => tag.includes(token) || token.includes(tag));
    if (matched) {
      overlap += 1;
    }
  }

  return overlap;
}

function tokenizeQuery(task_query: string): string[] {
  return task_query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}
