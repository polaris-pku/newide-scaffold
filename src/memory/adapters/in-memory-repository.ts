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
  type PersonaEvolutionMarker,
  type RetiredReason,
  type SkillRecord,
} from '../schemas';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { PromotionApprovalMode } from '../ports/promotion-strategy';
import type {
  ClaimedPersonaEvolutionCandidate,
  ClaimedPromotionCandidate,
  ExperienceFeedbackApplication,
  ExperienceFeedbackResult,
  ExperienceSaveResult,
  MarketImportResult,
  MarketSearchOptions,
  MemoryRepository,
  MemoryVectorSearchOptions,
  PersonaEvolutionClaimRequest,
  PersonaEvolutionCompletionRequest,
  PersonaEvolutionCompletionResult,
  PersonaEvolutionFailureRequest,
  PersonaEvolutionRestoreOptions,
  PromotionCandidateQuery,
  PromotionClaimRequest,
  PromotionCompletionRequest,
  PromotionFailureRequest,
  PromotionRestoreOptions,
  RestoredPersonaEvolutionClaim,
  SkillSaveResult,
  TransferSkillToMarketOptions,
} from '../ports/memory-repository';
import {
  DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY,
  DEFAULT_PROMOTION_RETRY_POLICY,
  claimDeliveryRecord,
  completeDeliveryRecord,
  expireDeliveryClaimRecord,
  failDeliveryRecord,
  isDeliveryClaimExpired,
  newClaimToken,
  resetDeliveryForRetry,
  type DeliveryRetryPolicy,
} from '../services/delivery-lifecycle';
import {
  buildPersonaEvolutionSnapshot,
  personaEvolutionInputSnapshotHash,
  personaEvolutionLastRun,
  planPersonaEvolutionCandidate,
} from '../services/persona-evolution-candidates';
import {
  personaEvolutionSettlement,
  resolvePersonaEvolutionWrite,
} from '../services/persona-evolution-decision';
import {
  comparePromotionCandidates,
  planPromotionCandidate,
  type PromotionCandidateInput,
} from '../services/promotion-candidates';
import {
  assertPromotedSkillReference,
  type PromotedSkillFacts,
} from '../services/promotion-integrity';
import { applyFeedbackToExperience, averageConfidence, isFeedbackApplied } from '../services/usage-feedback';
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
  /**
   * Persona 演化的状态（Phase 4-B）。缺席 = 这条演化流还没被人碰过。
   *
   * 与 `promotion` 挂在经验上同一个理由：它是**维护状态**，不是对外视图。刻意不放进
   * `handle`（前端与 Coordinator 读的那份载荷不该多出 claim token 与失败原因），也不放进
   * `persona`（那是一次演化的产物，把「上一次怎么来的」记进产物会让两者互相耦合）。
   */
  personaEvolution?: PersonaEvolutionMarker;
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

  /**
   * 覆盖写入一条技能。
   *
   * `promoted_from` 是晋升幂等键的一半，所以这次写入也要过一遍唯一性检查：同一 role 下
   * 已有另一条技能指向同一来源时，写入被拒、**记录保持原状**。PG 侧靠部分唯一索引在同一条
   * UPDATE 里整句失败，两侧必须报同一件事——判据只写在一边，测试替身就会掩盖生产差异
   * （见 ports/memory-repository.ts 里 updateSkill 的说明）。
   *
   * 检查与赋值之间没有 await：并发的另一次写入不可能插进「刚查过」与「写回」之间。
   */
  async updateSkill(role_id: string, skill: SkillRecord): Promise<void> {
    const store = this.requireStore(role_id);
    const index = store.skills.findIndex((item) => item.id === skill.id);
    if (index === -1) {
      throw new Error(`Skill not found: ${skill.id}`);
    }
    const stored = await this.withDescriptionEmbedding(skill);
    if (stored.promoted_from !== undefined) {
      const clash = findSkillByPromotedFrom(store.skills, stored.promoted_from);
      if (clash && clash.id !== stored.id) {
        throw new Error(
          `Skill for promoted_from=${stored.promoted_from} already exists in ${role_id}; ` +
            `skill ${stored.id} was left unchanged.`,
        );
      }
    }
    store.skills[index] = stored;
  }

  async updateExperience(role_id: string, experience: ExperienceRecord): Promise<void> {
    const store = this.requireStore(role_id);
    const index = store.experiences.findIndex((item) => item.id === experience.id);
    if (index === -1) {
      throw new Error(`Experience not found: ${experience.id}`);
    }
    store.experiences[index] = await this.withDescriptionEmbedding(experience);
  }

  /**
   * 反馈的原子幂等应用（内存实现）。
   *
   * 「查有没有 / 判重 / 写回经验 / 重算聚合」四步之间**一个 await 都没有**，因此在 JS
   * 单线程下就是一段临界区：并发的两个应用不可能都基于同一份旧快照写回，同一条反馈也
   * 不可能应用两次（与 saveExperienceIfAbsent 用的是同一手法）。刻意不经过
   * withDescriptionEmbedding：描述没变、向量就不该重算，写回的是仓库里那条记录的副本。
   *
   * 聚合根的重算**必须**在这段临界区里：`recomputeAvgConfidence` 是「读全部经验 → 算均值
   * → 写 updateMetrics」，中间隔着 await。两条反馈并发时，后进入临界区的那条会在算出均值
   * 之后、写回之前被另一条插进来，于是它写回的是一个**已经过时**的均值——最终库里的
   * `avg_confidence` 落在旧快照上，与经验集合的真实均值对不上。这里改成同步算出均值并当场
   * 赋值：读到的集合与写回的均值必然来自同一刻，数据库实现把同样两件事收进同一个事务。
   *
   * 注：内存实现没有持久层，重启即清空——它是测试替身，不是生产存储（见 ports 里的说明）。
   */
  async applyExperienceFeedback(
    role_id: string,
    input: ExperienceFeedbackApplication,
  ): Promise<ExperienceFeedbackResult> {
    const store = this.requireStore(role_id);
    const index = store.experiences.findIndex((item) => item.id === input.experience_id);
    const current = store.experiences[index];
    if (!current) return { outcome: 'experience_missing' };
    if (isFeedbackApplied(current, input.feedback_id)) {
      return { outcome: 'already_applied', experience: { ...current } };
    }
    const next = applyFeedbackToExperience(current, input, nowTimestamp());
    store.experiences[index] = next;
    // 同步（不 await）：下面的重算与上面的写回属于同一个临界区，见方法注释
    const metrics = { ...store.metrics, avg_confidence: averageConfidence(store.experiences) };
    store.metrics = metrics;
    store.handle = { ...store.handle, metric: metrics };
    return { outcome: 'applied', experience: { ...next } };
  }

  // ── 技能晋升的状态面（Phase 3） ──────────────────────────────────
  //
  // 与 applyExperienceFeedback 用的是同一手法：整段「读—判断—写」**一个 await 都没有**，
  // 因此在 JS 单线程下就是一段临界区。晋升标记嵌在经验里，写回时不需要重算 embedding
  // （描述没变），所以同步写回是安全的。

  async listPromotionCandidates(query: PromotionCandidateQuery): Promise<ExperienceRecord[]> {
    const input = promotionCandidateInput(query);
    const candidates = this.scanPromotionCandidates(query.role_id, input);
    const limited =
      query.limit === undefined ? candidates : candidates.slice(0, Math.max(0, query.limit));
    return limited.map((candidate) => cloneExperience(candidate.experience));
  }

  async claimNextPromotionCandidate(
    request: PromotionClaimRequest,
  ): Promise<ClaimedPromotionCandidate | undefined> {
    const input = promotionCandidateInput(request);
    const candidates = this.scanPromotionCandidates(request.role_id, input);
    for (const candidate of candidates) {
      const claimed = this.claimPromotionSync(candidate.role_id, candidate.experience.id, input, request);
      if (claimed) return claimed;
    }
    return undefined;
  }

  /**
   * 落一条结论（processing → processed）。
   *
   * 凭据（claim_token / owner / lease）不成立时返回 undefined、什么都不写——那是「这次没
   * 轮到我们」，落盘的责任归当前持有者。凭据成立之后才轮到**引用校验**：`outcome='promoted'`
   * 时 `promoted_to` 指向的技能必须存在、属于本 role、且来源就是这条经验（判据见
   * services/promotion-integrity.ts）。不成立就抛，经验一个字节都不动——包括不写结论、
   * 不写 promoted_to：两种半截状态都比失败更糟。
   *
   * 校验与写入之间没有 await，因此「凭据判断 → 引用判据 → 最终赋值」在 JS 单线程下就是
   * 一段临界区：没有「刚验过就被删掉」的窗口，也不需要第二次确认。
   *
   * `promoted` 以外的结论不接受技能引用：调用方递来的 `skill_id` 既不进标记、也不进
   * `promoted_to`（rejected / pending_review 没有产出技能可言）。
   */
  async completePromotion(
    request: PromotionCompletionRequest,
  ): Promise<ExperienceRecord | undefined> {
    if (request.outcome === 'promoted' && request.skill_id === undefined) {
      throw new Error('completePromotion requires a skill_id when the outcome is "promoted".');
    }
    const located = this.locatePromotion(request.role_id, request.experience_id);
    if (!located) return undefined;
    const { store, index, experience } = located;
    const marker = experience.promotion;
    if (!marker) return undefined;

    const promotedTo = request.outcome === 'promoted' ? request.skill_id : undefined;
    const completed = completeDeliveryRecord(
      {
        ...marker,
        outcome: request.outcome,
        strategy_version: request.strategy_version,
        evaluated_at: request.now,
        skill_id: promotedTo,
        reasons: request.reasons,
      },
      {
        ...(request.owner !== undefined ? { owner: request.owner } : {}),
        claim_token: request.claim_token,
        now: request.now,
      },
    );
    if (!completed) return undefined;

    if (promotedTo !== undefined) {
      assertPromotedSkillReference(
        {
          role_id: request.role_id,
          experience_id: request.experience_id,
          skill_id: promotedTo,
        },
        this.findSkillFactsById(promotedTo),
      );
    }

    const next: ExperienceRecord = {
      ...experience,
      promotion: completed,
      // promoted_to 与结论在同一次写入里落定：读到「Skill 已存在、经验还没绑上」的中间态
      // 会让人把它当成没晋升过再晋升一次
      ...(promotedTo !== undefined ? { promoted_to: promotedTo } : {}),
    };
    store.experiences[index] = next;
    return cloneExperience(next);
  }

  async failPromotion(
    request: PromotionFailureRequest,
  ): Promise<ExperienceRecord | undefined> {
    const located = this.locatePromotion(request.role_id, request.experience_id);
    if (!located) return undefined;
    const { store, index, experience } = located;
    const marker = experience.promotion;
    if (!marker) return undefined;

    const failed = failDeliveryRecord(marker, {
      ...(request.owner !== undefined ? { owner: request.owner } : {}),
      claim_token: request.claim_token,
      now: request.now,
      error: request.error,
      retryable: request.retryable,
      policy: request.policy ?? DEFAULT_PROMOTION_RETRY_POLICY,
    });
    if (!failed) return undefined;

    const next: ExperienceRecord = { ...experience, promotion: failed };
    store.experiences[index] = next;
    return cloneExperience(next);
  }

  async restoreExpiredPromotionClaims(
    options: PromotionRestoreOptions,
  ): Promise<ExperienceRecord[]> {
    const policy = options.policy ?? DEFAULT_PROMOTION_RETRY_POLICY;
    const restored: ExperienceRecord[] = [];
    for (const role_id of this.promotionRoleIds(options.role_id)) {
      const store = this.agents.get(role_id);
      if (!store) continue;
      for (let index = 0; index < store.experiences.length; index += 1) {
        const experience = store.experiences[index];
        const marker = experience?.promotion;
        if (!experience || !marker || !isDeliveryClaimExpired(marker, options.now)) continue;
        const updated = expireDeliveryClaimRecord(marker, { now: options.now, policy });
        const next: ExperienceRecord = { ...experience, promotion: updated };
        store.experiences[index] = next;
        restored.push(cloneExperience(next));
      }
    }
    return restored;
  }

  async retryDeadLetterPromotion(request: {
    role_id: string;
    experience_id: string;
    now: string;
  }): Promise<ExperienceRecord | undefined> {
    const located = this.locatePromotion(request.role_id, request.experience_id);
    if (!located) return undefined;
    const { store, index, experience } = located;
    const marker = experience.promotion;
    if (!marker) return undefined;

    const reset = resetDeliveryForRetry(marker, { now: request.now });
    if (!reset) return undefined;

    const next: ExperienceRecord = { ...experience, promotion: reset };
    store.experiences[index] = next;
    return cloneExperience(next);
  }

  // ── Persona 演化的状态面（Phase 4-B） ──────────────────────────────
  //
  // 与晋升同一套手法：整段「读输入 → 算快照 → 判计划 → 写标记」**一个 await 都没有**，
  // 因此在 JS 单线程下就是一段临界区。差别只在候选的粒度——晋升是「一条经验一份状态」，
  // 演化是「一个角色一条演化流」，所以状态挂在 AgentStore 上、claim 按 role 生效。

  async getPersonaEvolutionMarker(
    role_id: string,
  ): Promise<PersonaEvolutionMarker | undefined> {
    const marker = this.agents.get(role_id)?.personaEvolution;
    return marker === undefined ? undefined : { ...marker };
  }

  async claimNextPersonaEvolutionCandidate(
    request: PersonaEvolutionClaimRequest,
  ): Promise<ClaimedPersonaEvolutionCandidate | undefined> {
    // 隐藏的市场池 Agent 已经被 listAgentIds 排除在外——它只是技能的归属容器，不演化
    const roles = request.role_id !== undefined ? [request.role_id] : await this.listAgentIds();
    for (const role_id of roles) {
      const claimed = this.claimPersonaEvolutionSync(role_id, request);
      if (claimed) return claimed;
    }
    return undefined;
  }

  async completePersonaEvolution(
    request: PersonaEvolutionCompletionRequest,
  ): Promise<PersonaEvolutionCompletionResult> {
    const store = this.agents.get(request.role_id);
    if (!store) return { kind: 'claim_lost' };
    const marker = store.personaEvolution;
    if (!marker) return { kind: 'claim_lost' };

    if (request.outcome === 'evolved') {
      const persona = request.persona;
      if (!persona) {
        throw new Error('completePersonaEvolution requires a persona when the outcome is "evolved".');
      }
      // 版本号只能由父版本推出：让调用方自报一个跳版本的值，等于允许它写出一个不属于它的版本
      if (persona.role_id !== request.role_id) {
        throw new Error(
          `completePersonaEvolution received a persona for ${persona.role_id}, not ${request.role_id}.`,
        );
      }
      if (persona.version !== request.parent_version + 1) {
        throw new Error(
          `completePersonaEvolution requires persona version ${String(request.parent_version + 1)} `
            + `(parent ${String(request.parent_version)} + 1); got ${String(persona.version)}.`,
        );
      }
    }

    // 凭据先判：不成立就什么都不写，落盘责任归当前持有者
    const settled = completeDeliveryRecord(
      personaEvolutionSettlement(marker, request),
      {
        ...(request.owner !== undefined ? { owner: request.owner } : {}),
        claim_token: request.claim_token,
        now: request.now,
      },
    );
    if (!settled) return { kind: 'claim_lost' };

    // 父版本条件：只有写 Persona 版本的那条路径需要它（其余结论不写 Persona，没有旧版本可破坏）。
    // 判据取自 4-A 的 `resolvePersonaEvolutionWrite`——与 Pg 那条腿、与 4-A 的单测共用同一份
    // 定义，因此「什么时候算冲突」不可能在两个后端之间漂移。
    if (request.outcome === 'evolved') {
      const persona = request.persona!;
      const resolution = resolvePersonaEvolutionWrite({
        parent_version: request.parent_version,
        current_version: store.persona.version,
      });
      if (resolution.kind === 'conflict') {
        return {
          kind: 'parent_conflict',
          expected_parent_version: resolution.parent_version,
          current_version: resolution.current_version,
        };
      }
      store.persona = persona;
      // AgentHandle 内嵌 persona 快照，AgentBoardQuery.getAgent 返回 handle.persona，需同步
      store.handle = { ...store.handle, persona };
    }

    store.personaEvolution = settled;
    return {
      kind: 'applied',
      marker: { ...settled },
      ...(request.outcome === 'evolved' ? { persona: { ...request.persona! } } : {}),
    };
  }

  async failPersonaEvolution(
    request: PersonaEvolutionFailureRequest,
  ): Promise<PersonaEvolutionMarker | undefined> {
    const store = this.agents.get(request.role_id);
    const marker = store?.personaEvolution;
    if (!store || !marker) return undefined;

    const failed = failDeliveryRecord(marker, {
      ...(request.owner !== undefined ? { owner: request.owner } : {}),
      claim_token: request.claim_token,
      error: request.error,
      retryable: request.retryable,
      now: request.now,
      policy: request.policy ?? DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY,
    });
    if (!failed) return undefined;

    store.personaEvolution = failed;
    return { ...failed };
  }

  async restoreExpiredPersonaEvolutionClaims(
    options: PersonaEvolutionRestoreOptions,
  ): Promise<RestoredPersonaEvolutionClaim[]> {
    const policy = options.policy ?? DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY;
    const restored: RestoredPersonaEvolutionClaim[] = [];
    for (const role_id of this.promotionRoleIds(options.role_id)) {
      const store = this.agents.get(role_id);
      const marker = store?.personaEvolution;
      if (!store || !marker || !isDeliveryClaimExpired(marker, options.now)) continue;
      const updated = expireDeliveryClaimRecord(marker, { now: options.now, policy });
      store.personaEvolution = updated;
      restored.push({ role_id, marker: { ...updated } });
    }
    return restored;
  }

  async retryDeadLetterPersonaEvolution(request: {
    role_id: string;
    now: string;
  }): Promise<PersonaEvolutionMarker | undefined> {
    const store = this.agents.get(request.role_id);
    const marker = store?.personaEvolution;
    if (!store || !marker) return undefined;

    const reset = resetDeliveryForRetry(marker, { now: request.now });
    if (!reset) return undefined;

    store.personaEvolution = reset;
    return { ...reset };
  }

  /**
   * 一个角色的一次 claim。**整段同步**：读 Persona、技能、经验，算快照与 hash，判计划，
   * 写标记——中间一个 await 都没有，因此「读到的输入」与「据此写下的租约」是同一份事实。
   */
  private claimPersonaEvolutionSync(
    role_id: string,
    request: PersonaEvolutionClaimRequest,
  ): ClaimedPersonaEvolutionCandidate | undefined {
    const store = this.agents.get(role_id);
    if (!store) return undefined;

    const snapshot = buildPersonaEvolutionSnapshot({
      role_id,
      skills: store.skills,
      experiences: store.experiences,
    });
    const input_snapshot_hash = personaEvolutionInputSnapshotHash(snapshot);
    // 上一次结论必须在**计划重置它之前**读出来：重评路径的第一步就是把结论字段清掉
    const last_evolution = personaEvolutionLastRun(store.personaEvolution);
    const policy = request.policy ?? DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY;
    const plan = planPersonaEvolutionCandidate(store.personaEvolution, {
      now: request.now,
      strategy_version: request.strategy_version,
      approval: request.approval,
      input_snapshot_hash,
      policy,
    });
    if (plan.kind === 'skip') return undefined;

    const marker =
      plan.kind === 'expire_then_claim'
        ? expireDeliveryClaimRecord(store.personaEvolution!, { now: request.now, policy })
        : plan.marker;

    const claimed = claimDeliveryRecord(marker, {
      owner: request.owner,
      now: request.now,
      lease_ms: request.lease_ms,
      claim_token: newClaimToken(),
      policy,
    });
    if (!claimed) {
      // 回收之后可能直接进了死信（次数用满），claim 自然拿不到它——把回收结果写回去，
      // 否则这条标记的租约永远停在过期状态，每次扫描都白跑一遍
      if (plan.kind === 'expire_then_claim') store.personaEvolution = marker;
      return undefined;
    }

    store.personaEvolution = claimed;
    return {
      role_id,
      marker: { ...claimed },
      claim_token: claimed.claim_token!,
      attempt_count: claimed.attempt_count,
      persona: { ...store.persona },
      snapshot,
      input_snapshot_hash,
      ...(last_evolution !== undefined ? { last_evolution } : {}),
    };
  }

  /**
   * 一条候选的一次 claim。**整段同步**：调用方已经同步扫过候选，这里从重读到写回一个
   * await 都没有，所以「扫描之后被别人改过」的唯一可能是同一轮里前一条候选的写回——
   * 因此必须按**重读后的当前版本**重算计划，不能沿用扫描时那份（那正是把别人刚写下的
   * 结论按旧计划盖掉的地方）。
   */
  private claimPromotionSync(
    role_id: string,
    experience_id: string,
    input: PromotionCandidateInput,
    request: PromotionClaimRequest,
  ): ClaimedPromotionCandidate | undefined {
    const located = this.locatePromotion(role_id, experience_id);
    if (!located) return undefined;
    const { store, index, experience } = located;

    const plan = planPromotionCandidate(experience, input);
    if (plan.kind === 'skip') return undefined;

    const policy = request.policy ?? DEFAULT_PROMOTION_RETRY_POLICY;
    const marker =
      plan.kind === 'expire_then_claim'
        ? expireDeliveryClaimRecord(experience.promotion!, { now: input.now, policy })
        : plan.marker;

    const claimed = claimDeliveryRecord(marker, {
      owner: request.owner,
      now: request.now,
      lease_ms: request.lease_ms,
      claim_token: newClaimToken(),
      policy,
    });

    if (!claimed) {
      // 回收之后可能直接进了死信（次数用满），claim 自然拿不到它——把回收结果写回去，
      // 否则这条记录的租约永远停在过期状态，每次扫描都白跑一遍
      if (plan.kind === 'expire_then_claim') {
        store.experiences[index] = { ...experience, promotion: marker };
      }
      return undefined;
    }

    const next: ExperienceRecord = { ...experience, promotion: claimed };
    store.experiences[index] = next;
    return {
      role_id,
      experience: cloneExperience(next),
      claim_token: claimed.claim_token!,
      attempt_count: claimed.attempt_count,
    };
  }

  /** 同步扫候选：按「先来的先处理」排序，规则见 services/promotion-candidates.ts */
  private scanPromotionCandidates(
    role_id: string | undefined,
    input: PromotionCandidateInput,
  ): Array<{ role_id: string; experience: ExperienceRecord }> {
    const candidates: Array<{ role_id: string; experience: ExperienceRecord }> = [];
    for (const currentRole of this.promotionRoleIds(role_id)) {
      const store = this.agents.get(currentRole);
      if (!store) continue;
      for (const experience of store.experiences) {
        if (planPromotionCandidate(experience, input).kind === 'skip') continue;
        candidates.push({ role_id: currentRole, experience });
      }
    }
    return candidates.sort((left, right) =>
      comparePromotionCandidates(left.experience, right.experience),
    );
  }

  /** 扫描范围：给了 role 就只扫它，否则扫全部（隐藏的市场池 Agent 不算） */
  private promotionRoleIds(role_id: string | undefined): string[] {
    if (role_id !== undefined) return [role_id];
    return [...this.agents.keys()].filter((id) => id !== MARKET_POOL_ROLE_ID);
  }

  private locatePromotion(
    role_id: string,
    experience_id: string,
  ): { store: AgentStore; index: number; experience: ExperienceRecord } | undefined {
    const store = this.agents.get(role_id);
    if (!store) return undefined;
    const index = store.experiences.findIndex((item) => item.id === experience_id);
    const experience = store.experiences[index];
    if (index === -1 || !experience) return undefined;
    return { store, index, experience };
  }

  /**
   * 按 id 在**全部** Agent 的存储里找一条技能的事实（不限当前 role 的那一份）。
   *
   * 「跨 role 引用」与「根本不存在」是两种不同的完整性错误，只有全局查才分得开；判据本身
   * 由 services/promotion-integrity.ts 给（与 PG 适配器同一份），这里只回答「查到了什么」。
   * 市场池 Agent 也在 this.agents 里，因此被转移过去的技能照样找得到，并会以「归属不符」
   * 而不是「不存在」被拒——那样排查时看得到它去了哪儿。
   */
  private findSkillFactsById(skill_id: string): PromotedSkillFacts | undefined {
    for (const [role_id, store] of this.agents) {
      const found = store.skills.find((skill) => skill.id === skill_id);
      if (found) return { role_id, promoted_from: found.promoted_from };
    }
    return undefined;
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

/** 把扫描/claim 需要的语义参数收敛成一份（端口上的 Query 与 Request 都带这几个字段） */
function promotionCandidateInput(source: {
  now: string;
  strategy_version: string;
  approval: PromotionApprovalMode;
  policy?: DeliveryRetryPolicy;
}): PromotionCandidateInput {
  return {
    now: source.now,
    strategy_version: source.strategy_version,
    approval: source.approval,
    ...(source.policy !== undefined ? { policy: source.policy } : {}),
  };
}

/** 返回给调用方的经验副本：晋升标记是嵌套对象，共享引用会让调用方改到仓库里的那份 */
function cloneExperience(experience: ExperienceRecord): ExperienceRecord {  return experience.promotion === undefined
    ? { ...experience }
    : { ...experience, promotion: { ...experience.promotion } };
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
