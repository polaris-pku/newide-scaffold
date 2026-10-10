/**
 * InMemoryRepository — MemoryRepository 内存适配器
 *
 * 所有 Agent 共享一个实例，数据按 role_id 隔离存储于内存 Map。
 * 含 experiences、skills、persona 等；buffer 见 InMemoryBufferRepository。
 * 生产向持久化见 PgMemoryRepository。
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import {
  MARKET_POOL_ROLE_ID,
  type AgentArchiveRecord,
  type AgentHandle,
  type AgentMetrics,
  type AgentStatus,
  type CreateAgentSpec,
  type ExperienceRecord,
  type PersonaDef,
  type RetiredReason,
  type SkillRecord,
} from '../schemas';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type {
  ExperienceSaveResult,
  MarketImportResult,
  MarketSearchOptions,
  MemoryRepository,
  MemoryVectorSearchOptions,
  SkillSaveResult,
  TransferSkillToMarketOptions,
} from '../ports/memory-repository';
import { defaultHashEmbeddingProvider } from './hash-embedding-provider';
import { cosineSimilarity } from '../utils/vector';
import {
  createSeedHandle,
  createSeedMetrics,
  createSeedPersona,
  DEFAULT_MIN_EXPERIENCE_CONFIDENCE,
  DEFAULT_MIN_SIMILARITY,
  isEligibleExperience,
  isEligibleSkill,
  isMarketEligibleSkill,
} from './memory-repository-seeds';

interface AgentStore {
  handle: AgentHandle;
  persona: PersonaDef;
  metrics: AgentMetrics;
  skills: SkillRecord[];
  experiences: ExperienceRecord[];
}

interface ScoredRecord<T> {
  item: T;
  similarity: number;
}

export class InMemoryRepository implements MemoryRepository {
  private readonly agents = new Map<string, AgentStore>();
  /** 退休归档（实体删除后保留的最小字段） */
  private readonly archives = new Map<string, AgentArchiveRecord>();

  constructor(private readonly embedding: EmbeddingProvider = defaultHashEmbeddingProvider) {}

  async ensureAgent(role_id: string): Promise<void> {
    if (this.agents.has(role_id)) {
      return;
    }
    await this.initializeAgent({
      role_id,
      name: role_id,
    });
  }

  async initializeAgent(spec: CreateAgentSpec): Promise<void> {
    if (this.agents.has(spec.role_id)) {
      throw new Error(`Agent already exists: ${spec.role_id}`);
    }

    const persona = createSeedPersona(spec.role_id, spec.persona_seed);
    const metrics = createSeedMetrics(spec.role_id);
    const handle = createSeedHandle(spec, persona, metrics);

    this.agents.set(spec.role_id, {
      handle,
      persona,
      metrics,
      skills: [],
      experiences: [],
    });
  }

  async listAgentIds(): Promise<string[]> {
    // 隐藏市场池 Agent（方案 A）：它只作为技能的归属容器，不参与竞标/派发/展示
    return [...this.agents.keys()].filter((id) => id !== MARKET_POOL_ROLE_ID);
  }

  async updateAgentMeta(
    role_id: string,
    patch: { name?: string; tags?: string[] },
  ): Promise<void> {
    const store = this.requireStore(role_id);
    store.handle = {
      ...store.handle,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    };
  }

  async deleteAgent(role_id: string): Promise<void> {
    if (role_id === MARKET_POOL_ROLE_ID) {
      throw new Error(`Cannot delete market pool agent: ${role_id}`);
    }
    if (!this.agents.delete(role_id)) {
      throw new Error(`Agent not found: ${role_id}`);
    }
  }

  async archiveAgent(roleId: string, archive: AgentArchiveRecord): Promise<void> {
    this.archives.set(roleId, archive);
  }

  async getAgentArchive(roleId: string): Promise<AgentArchiveRecord | null> {
    return this.archives.get(roleId) ?? null;
  }

  async getAgent(role_id: string): Promise<AgentHandle> {
    return this.requireStore(role_id).handle;
  }

  async getPersona(role_id: string): Promise<PersonaDef> {
    return this.requireStore(role_id).persona;
  }

  async getMetrics(role_id: string): Promise<AgentMetrics> {
    return this.requireStore(role_id).metrics;
  }

  async listSkills(role_id: string): Promise<SkillRecord[]> {
    return [...this.requireStore(role_id).skills];
  }

  async listExperiences(role_id: string): Promise<ExperienceRecord[]> {
    return [...this.requireStore(role_id).experiences];
  }

  async searchSkills(role_id: string, options: MemoryVectorSearchOptions): Promise<SkillRecord[]> {
    const eligible = this.requireStore(role_id).skills.filter(isEligibleSkill);
    return rankByVectorSimilarity(eligible, options, this.embedding);
  }

  async searchExperiences(
    role_id: string,
    options: MemoryVectorSearchOptions,
  ): Promise<ExperienceRecord[]> {
    const min_confidence = options.min_confidence ?? DEFAULT_MIN_EXPERIENCE_CONFIDENCE;
    const eligible = this.requireStore(role_id).experiences.filter((experience) =>
      isEligibleExperience(experience, min_confidence),
    );
    return rankByVectorSimilarity(eligible, options, this.embedding);
  }

  async marketSearchSkills(options: MarketSearchOptions): Promise<SkillRecord[]> {
    // 技能市场仅检索市场池（__market__）内的技能：
    // 未退休/未迁入市场池的 Agent 技能（即使已 approved 或已 publish 标记）不可被检索到。
    if (options.exclude_agent_id === MARKET_POOL_ROLE_ID) {
      return [];
    }
    const market = this.agents.get(MARKET_POOL_ROLE_ID);
    if (!market) {
      return [];
    }
    const candidates = market.skills.filter(isMarketEligibleSkill);
    return rankByVectorSimilarity(candidates, options, this.embedding);
  }

  async marketImportSkill(role_id: string, source_skill_id: string): Promise<MarketImportResult> {
    // 1. 定位源技能（跨 Agent 全库查找）
    const sourceOwner = this.findSkillOwner(source_skill_id);
    if (!sourceOwner) {
      throw new Error(`Market skill not found: ${source_skill_id}`);
    }
    const source = sourceOwner.skill;
    if (!isMarketEligibleSkill(source)) {
      throw new Error(`Market skill not importable (review/status): ${source_skill_id}`);
    }

    const importer = this.requireStore(role_id);

    // 2. 幂等：引入方已存在该源技能的副本 → 直接返回已有副本
    const existing = importer.skills.find((skill) => skill.imported_from === source_skill_id);
    if (existing) {
      return { imported: existing, source, created: false };
    }

    // 3. 克隆副本
    const now = nowTimestamp();
    const copy: SkillRecord = {
      ...source,
      id: randomUUID(),
      agent_id: role_id,
      imported_from: source_skill_id,
      // 副本归引入方所有，provenance 记录在源技能的 imported_by 上
      imported_by: undefined,
      promoted_from: undefined,
      created_at: now,
      updated_at: now,
    };
    const stored = await this.withDescriptionEmbedding(copy);

    importer.skills.push(stored);
    importer.handle.skill_count = importer.skills.length;
    importer.handle.owned_skills.push(stored.id);
    importer.metrics.skill_count = importer.skills.length;
    importer.metrics.imported_skill_count += 1;
    importer.handle = { ...importer.handle, metric: importer.metrics };

    // 4. 更新源技能 imported_by（retirement 决策树依赖该字段）
    const updatedSource: SkillRecord = {
      ...source,
      imported_by: [...(source.imported_by ?? []), role_id],
      updated_at: now,
    };
    sourceOwner.store.skills[sourceOwner.index] = updatedSource;

    return { imported: stored, source: updatedSource, created: true };
  }

  async transferSkillToMarket(
    fromRoleId: string,
    skillId: string,
    options: TransferSkillToMarketOptions = {},
  ): Promise<SkillRecord> {
    const source = this.requireStore(fromRoleId);
    const index = source.skills.findIndex((skill) => skill.id === skillId);
    if (index === -1) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    // 首次迁移时自动初始化市场池 Agent
    await this.ensureAgent(MARKET_POOL_ROLE_ID);
    const market = this.requireStore(MARKET_POOL_ROLE_ID);

    const now = nowTimestamp();
    const original = source.skills[index]!;
    const moved: SkillRecord = {
      ...original,
      agent_id: MARKET_POOL_ROLE_ID,
      market_status: options.market_status ?? original.market_status,
      origin_agent_id: original.origin_agent_id ?? original.agent_id,
      updated_at: now,
    };

    // 从源 Agent 移除
    source.skills.splice(index, 1);
    source.handle = {
      ...source.handle,
      skill_count: source.skills.length,
      owned_skills: source.handle.owned_skills.filter((id) => id !== skillId),
    };
    source.metrics = { ...source.metrics, skill_count: source.skills.length };
    source.handle = { ...source.handle, metric: source.metrics };

    // 挂载到市场池
    market.skills.push(moved);
    market.handle = {
      ...market.handle,
      skill_count: market.skills.length,
      owned_skills: [...market.handle.owned_skills, moved.id],
    };
    market.metrics = { ...market.metrics, skill_count: market.skills.length };
    market.handle = { ...market.handle, metric: market.metrics };

    return moved;
  }

  async saveExperience(role_id: string, experience: ExperienceRecord): Promise<void> {
    const store = this.requireStore(role_id);
    const stored = await this.withDescriptionEmbedding(experience);
    store.experiences.push(stored);
    store.handle.experience_count = store.experiences.length;
    store.handle.owned_exps.push(stored.id);
    store.metrics.experience_count = store.experiences.length;
  }

  /**
   * 幂等保存经验：唯一键 `Experience.id`，与 PG 的 `ON CONFLICT (id) DO NOTHING` 语义一致。
   *
   * 并发来源是**两个独立 worker 同时处理同一个 (role_id, buffer_seq)**：稳定 id 只能让
   * 「顺序重试」认得出同一条，认不出并发重入。所以「检查 → 写入」之间不能有 await——先算
   * 好 embedding，再做一次**同步**的查-写：await 之后再查一次，命中的话认输、返回对手写进去
   * 的那条。JS 单线程下「最后一次同步检查 + push」不会被插队，并发调用因此只留一条经验，
   * 且两个调用方都拿到同一条已持久化的记录。
   */
  async saveExperienceIfAbsent(
    role_id: string,
    experience: ExperienceRecord,
  ): Promise<ExperienceSaveResult> {
    const store = this.requireStore(role_id);
    const existing = findExperienceById(store.experiences, experience.id);
    if (existing) {
      return { experience: existing, created: false };
    }

    const stored = await this.withDescriptionEmbedding(experience);

    // await 之后重查：并发的另一次调用可能已经写进去了
    const raced = findExperienceById(store.experiences, stored.id);
    if (raced) {
      return { experience: raced, created: false };
    }

    store.experiences.push(stored);
    store.handle.experience_count = store.experiences.length;
    store.handle.owned_exps.push(stored.id);
    store.metrics.experience_count = store.experiences.length;
    return { experience: stored, created: true };
  }

  async saveSkill(role_id: string, skill: SkillRecord): Promise<void> {
    const store = this.requireStore(role_id);
    const stored = await this.withDescriptionEmbedding(skill);
    store.skills.push(stored);
    store.handle.skill_count = store.skills.length;
    store.handle.owned_skills.push(stored.id);
    store.metrics.skill_count = store.skills.length;
    store.metrics.promoted_skill_count += 1;
  }

  /**
   * 幂等保存晋升技能：唯一键 `(role_id, promoted_from)`，与 PG 的 ON CONFLICT 语义一致。
   *
   * 「检查 → 写入」之间不能有 await，否则并发的两次晋升会各自查不到、各自写入，攒出成对的
   * 重复技能。这里因此先算好 embedding，再做一次**同步**的查-写：await 之后再查一次，
   * 命中的话认输、返回对手写进去的那条。JS 单线程下「最后一次同步检查 + push」不会被
   * 插队，所以并发调用只会产生一条技能。
   */
  async saveSkillIfAbsent(role_id: string, skill: SkillRecord): Promise<SkillSaveResult> {
    const store = this.requireStore(role_id);
    if (skill.promoted_from === undefined) {
      await this.saveSkill(role_id, skill);
      return { skill, created: true };
    }

    const existing = findSkillByPromotedFrom(store.skills, skill.promoted_from);
    if (existing) {
      return { skill: existing, created: false };
    }

    const stored = await this.withDescriptionEmbedding(skill);

    // await 之后重查：并发的另一次调用可能已经写进去了
    const raced = findSkillByPromotedFrom(store.skills, stored.promoted_from!);
    if (raced) {
      return { skill: raced, created: false };
    }

    store.skills.push(stored);
    store.handle.skill_count = store.skills.length;
    store.handle.owned_skills.push(stored.id);
    store.metrics.skill_count = store.skills.length;
    store.metrics.promoted_skill_count += 1;
    return { skill: stored, created: true };
  }

  async savePersona(role_id: string, persona: PersonaDef): Promise<void> {
    const store = this.requireStore(role_id);
    store.persona = persona;
    // AgentHandle 内嵌 persona 快照，AgentBoardQuery.getAgent 返回 handle.persona，需同步
    store.handle = { ...store.handle, persona };
  }

  async updateSkill(role_id: string, skill: SkillRecord): Promise<void> {
    const store = this.requireStore(role_id);
    const index = store.skills.findIndex((item) => item.id === skill.id);
    if (index === -1) {
      throw new Error(`Skill not found: ${skill.id}`);
    }
    store.skills[index] = await this.withDescriptionEmbedding(skill);
  }

  async updateExperience(role_id: string, experience: ExperienceRecord): Promise<void> {
    const store = this.requireStore(role_id);
    const index = store.experiences.findIndex((item) => item.id === experience.id);
    if (index === -1) {
      throw new Error(`Experience not found: ${experience.id}`);
    }
    store.experiences[index] = await this.withDescriptionEmbedding(experience);
  }

  async updateSkillEmbedding(role_id: string, skill_id: string, embedding: number[]): Promise<void> {
    const store = this.requireStore(role_id);
    const index = store.skills.findIndex((item) => item.id === skill_id);
    const existing = store.skills[index];
    if (!existing) {
      throw new Error(`Skill not found: ${skill_id}`);
    }
    store.skills[index] = { ...existing, description_embedding: embedding };
  }

  async updateExperienceEmbedding(
    role_id: string,
    experience_id: string,
    embedding: number[],
  ): Promise<void> {
    const store = this.requireStore(role_id);
    const index = store.experiences.findIndex((item) => item.id === experience_id);
    const existing = store.experiences[index];
    if (!existing) {
      throw new Error(`Experience not found: ${experience_id}`);
    }
    store.experiences[index] = {
      ...existing,
      description_embedding: embedding,
    };
  }

  async deleteSkill(role_id: string, skill_id: string): Promise<void> {
    const store = this.requireStore(role_id);
    const before = store.skills.length;
    store.skills = store.skills.filter((item) => item.id !== skill_id);
    if (store.skills.length === before) {
      throw new Error(`Skill not found: ${skill_id}`);
    }
    store.handle = {
      ...store.handle,
      skill_count: store.skills.length,
      owned_skills: store.handle.owned_skills.filter((id) => id !== skill_id),
    };
    store.metrics = { ...store.metrics, skill_count: store.skills.length };
    store.handle = { ...store.handle, metric: store.metrics };
  }

  async deleteExperience(role_id: string, experience_id: string): Promise<void> {
    const store = this.requireStore(role_id);
    const before = store.experiences.length;
    store.experiences = store.experiences.filter((item) => item.id !== experience_id);
    if (store.experiences.length === before) {
      throw new Error(`Experience not found: ${experience_id}`);
    }
    store.handle = {
      ...store.handle,
      experience_count: store.experiences.length,
      owned_exps: store.handle.owned_exps.filter((id) => id !== experience_id),
    };
    store.metrics = { ...store.metrics, experience_count: store.experiences.length };
    store.handle = { ...store.handle, metric: store.metrics };
  }

  async updateMetrics(
    role_id: string,
    update: (current: AgentMetrics) => AgentMetrics,
  ): Promise<void> {
    const store = this.requireStore(role_id);
    const next = update(store.metrics);
    store.metrics = next;
    // 同步聚合根内嵌指标快照
    store.handle = { ...store.handle, metric: next };
  }

  async updateAgentStatus(
    role_id: string,
    status: AgentStatus,
    options?: { retired_at?: string; retired_reason?: RetiredReason },
  ): Promise<void> {
    const store = this.requireStore(role_id);
    store.handle = {
      ...store.handle,
      status,
      ...(options?.retired_at !== undefined ? { retired_at: options.retired_at } : {}),
      ...(options?.retired_reason !== undefined
        ? { retired_reason: options.retired_reason }
        : {}),
    };
  }

  private async withDescriptionEmbedding<T extends SkillRecord | ExperienceRecord>(
    record: T,
  ): Promise<T> {
    if (record.description_embedding.length === this.embedding.dimensions) {
      return record;
    }
    return {
      ...record,
      description_embedding: await this.embedding.embed(record.description),
    };
  }

  private requireStore(role_id: string): AgentStore {
    const store = this.agents.get(role_id);
    if (!store) {
      throw new Error(`Agent not found: ${role_id}`);
    }
    return store;
  }

  /** 跨 Agent 查找一条技能所属的 store 与下标；未找到返回 undefined */
  private findSkillOwner(
    skill_id: string,
  ): { store: AgentStore; index: number; skill: SkillRecord } | undefined {
    for (const store of this.agents.values()) {
      const index = store.skills.findIndex((skill) => skill.id === skill_id);
      if (index !== -1) {
        return { store, index, skill: store.skills[index]! };
      }
    }
    return undefined;
  }
}

/**
 * 在同 role 的技能列表里找一条 `promoted_from` 指向给定经验的技能。
 *
 * 这是晋升幂等键的查询侧：`(role_id, promoted_from)` 唯一。列表本身已经按 role 隔离，
 * 所以只需要比 promoted_from。
 */
function findSkillByPromotedFrom(
  skills: readonly SkillRecord[],
  promoted_from: string,
): SkillRecord | undefined {
  return skills.find((skill) => skill.promoted_from === promoted_from);
}

/** 幂等保存经验的查询侧：唯一键是 Experience.id。 */
function findExperienceById(
  experiences: readonly ExperienceRecord[],
  id: string,
): ExperienceRecord | undefined {
  return experiences.find((experience) => experience.id === id);
}

async function rankByVectorSimilarity<T extends SkillRecord | ExperienceRecord>(
  items: T[],
  options: MemoryVectorSearchOptions,
  embedding: EmbeddingProvider,
): Promise<T[]> {
  const scored: ScoredRecord<T>[] = [];

  for (const item of items) {
    const itemEmbedding =
      item.description_embedding.length === embedding.dimensions
        ? item.description_embedding
        : await embedding.embed(item.description);
    scored.push({
      item,
      similarity: cosineSimilarity(options.query_embedding, itemEmbedding),
    });
  }

  return scored
    .filter((entry) => entry.similarity >= (options.min_similarity ?? DEFAULT_MIN_SIMILARITY))
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, options.top_k)
    .map((entry) => entry.item);
}
