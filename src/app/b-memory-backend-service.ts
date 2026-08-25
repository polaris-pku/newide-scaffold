import {
  type AgentBoardAgentView,
  type AgentBoardListItem,
  type AgentHandle,
  applyUserRating,
  type CreateAgentSpec,
  createSkill,
  deleteExperience,
  deleteSkill,
  type EmbeddingProvider,
  type ExperienceListFilter,
  type ExperienceView,
  type ExperienceWritePatch,
  type LlmClient,
  LlmPersonaInduction,
  type MarketImportResult,
  marketImport,
  type MarketSearchQuery,
  marketSearch,
  type MemoryRepository,
  mergePersonaPatch,
  type PersonaPatch,
  publishSkillToMarket,
  regeneratePersona,
  type RetireOptions,
  type RetireResult,
  type RetirementScanResult,
  ruleBasedPersonaInduction,
  type SkillListFilter,
  type SkillView,
  type SkillWritePatch,
  toExperienceView,
  toSkillView,
  type CreateSkillInput,
  type UserRating,
  type UserRatingResult,
  updateExperience,
  updateSkill,
  type PersonaInducer,
  computeMemoryOverview,
  type MemoryOverview,
  cosineSimilarity,
  type DeadLetterEntry,
  promoteExperienceToSkill,
} from '../memory';
import type {
  AgentContextSnapshot,
  AgentStatus,
  BufferMeta,
  BufferSnapshot,
  ExperienceRecord,
  PersonaDef,
  SkillRecord,
} from '../memory/schemas';
import type { BMemoryMaintenanceEvidence } from './b-memory-maintenance-runner';
import type { BPublicCapabilities, ReviewedSkill } from './b-public-capabilities';
import { filterLegacyCouncilPseudoAgents } from './council-legacy-agent-filter';
import type { BEmbeddingRuntimeInfo } from './production-b-runtime';

export interface BMemoryOperationCapability {
  status: 'available' | 'unavailable';
  reason?: string;
}

export interface BMemoryCapabilities {
  schema_version: 'newide.b-memory-capabilities.v2';
  embedding: BEmbeddingRuntimeInfo;
  skill_review: {
    mode: 'manual' | 'auto_approve';
  };
  operations: {
    list_agents: BMemoryOperationCapability;
    get_agent_persona: BMemoryOperationCapability;
    list_experiences: BMemoryOperationCapability;
    list_skills: BMemoryOperationCapability;
    list_maintenance: BMemoryOperationCapability;
    promote_skills: BMemoryOperationCapability;
    promote_experience: BMemoryOperationCapability;
    approve_skill: BMemoryOperationCapability;
    reject_skill: BMemoryOperationCapability;
    update_persona: BMemoryOperationCapability;
    regenerate_persona: BMemoryOperationCapability;
    rate_task: BMemoryOperationCapability;
    get_buffer_state: BMemoryOperationCapability;
    get_pending_buffer: BMemoryOperationCapability;
    retry_extraction: BMemoryOperationCapability;
    search_memory: BMemoryOperationCapability;
    market_search: BMemoryOperationCapability;
    market_import: BMemoryOperationCapability;
    retire_agent: BMemoryOperationCapability;
    retirement_scan: BMemoryOperationCapability;
    create_agent: BMemoryOperationCapability;
    update_agent: BMemoryOperationCapability;
    delete_agent: BMemoryOperationCapability;
    create_skill: BMemoryOperationCapability;
    update_skill: BMemoryOperationCapability;
    delete_skill: BMemoryOperationCapability;
    publish_skill: BMemoryOperationCapability;
    update_experience: BMemoryOperationCapability;
    delete_experience: BMemoryOperationCapability;
    get_overview: BMemoryOperationCapability;
    list_pending_reviews: BMemoryOperationCapability;
    list_experiences_by_source_task: BMemoryOperationCapability;
  };
}

/** Agent 元数据更新补丁（与 MemoryRepository.updateAgentMeta 对齐） */
export interface AgentMetaPatch {
  name?: string;
  tags?: string[];
}

/**
 * Agent 生命周期端口。生产实现由 DriverRuntimeAgentExecutionFacade 提供
 * （→ AgentManager）；测试可注入真 AgentManager。
 */
export interface BMemoryLifecycle {
  retireAgent(roleId: string, options: RetireOptions): Promise<RetireResult>;
  /** 三重门控退休检测（week3 RFC §8.2）：只产出建议，不自动退休。 */
  runRetirementScan(roleId?: string): Promise<RetirementScanResult[]>;
  /** 显式创建 Agent（memory.createAgent）。 */
  createAgent(spec: CreateAgentSpec): Promise<AgentHandle>;
  /** 更新 Agent 元数据（名称 / 标签）。 */
  updateAgent(roleId: string, patch: AgentMetaPatch): Promise<AgentHandle>;
  /** 硬删除 Agent（安全前置：retired；未退休须 options.force 二次确认）。 */
  deleteAgent(roleId: string, options?: { force?: boolean }): Promise<void>;
}
export interface BMemoryBackendServiceOptions {
  autoApprovePromotedSkills?: boolean;
}

export class BMemoryBackendService {
  constructor(
    private readonly capabilities: Pick<
      BPublicCapabilities,
      'boardQuery' | 'maintenance' | 'reviewSkill' | 'bufferRepository'
    >,
    private readonly embeddingInfo: BEmbeddingRuntimeInfo,
    private readonly options: BMemoryBackendServiceOptions = {},
    // 以下为可选注入：不注入时对应能力在 getCapabilities() 里报告 unavailable，
    // 调用对应方法时抛出明确错误。保持与旧的两参构造签名向后兼容。
    private readonly repository?: MemoryRepository,
    private readonly lifecycle?: BMemoryLifecycle,
    private readonly embedding?: EmbeddingProvider,
    private readonly llm?: LlmClient,
  ) {}

  getCapabilities(): BMemoryCapabilities {
    return {
      schema_version: 'newide.b-memory-capabilities.v2',
      embedding: { ...this.embeddingInfo },
      skill_review: {
        mode: this.options.autoApprovePromotedSkills ? 'auto_approve' : 'manual',
      },
      operations: {
        list_agents: { status: 'available' },
        get_agent_persona: { status: 'available' },
        list_experiences: { status: 'available' },
        list_skills: { status: 'available' },
        list_maintenance: { status: 'available' },
        promote_skills: {
          status: 'available',
          reason: this.options.autoApprovePromotedSkills
            ? 'Promoted Skills are approved automatically.'
            : 'Promotion creates pending Skills for explicit review.',
        },
        promote_experience: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        approve_skill: { status: 'available' },
        reject_skill: { status: 'available' },
        market_search: {
          status: this.repository && this.embedding ? 'available' : 'unavailable',
          ...(this.repository && this.embedding
            ? {}
            : {
                reason:
                  'B runtime has no MemoryRepository or semantic embedding provider configured.',
              }),
        },
        market_import: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        retire_agent: {
          status: this.lifecycle ? 'available' : 'unavailable',
          ...(this.lifecycle ? {} : { reason: 'B runtime does not expose Agent retirement.' }),
        },
        retirement_scan: {
          status: this.lifecycle ? 'available' : 'unavailable',
          ...(this.lifecycle
            ? {}
            : { reason: 'B runtime does not expose retirement scanning.' }),
        },
        create_agent: {
          status: this.lifecycle ? 'available' : 'unavailable',
          ...(this.lifecycle ? {} : { reason: 'B runtime does not expose Agent creation.' }),
        },
        update_agent: {
          status: this.lifecycle ? 'available' : 'unavailable',
          ...(this.lifecycle
            ? {}
            : { reason: 'B runtime does not expose Agent metadata updates.' }),
        },
        delete_agent: {
          status: this.lifecycle ? 'available' : 'unavailable',
          ...(this.lifecycle ? {} : { reason: 'B runtime does not expose Agent deletion.' }),
        },
        create_skill: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        update_skill: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        delete_skill: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        publish_skill: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        update_experience: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        delete_experience: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        update_persona: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        regenerate_persona: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        rate_task: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        get_buffer_state: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        get_pending_buffer: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        retry_extraction: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        search_memory: {
          status: this.repository && this.embedding ? 'available' : 'unavailable',
          ...(this.repository && this.embedding
            ? {}
            : {
                reason:
                  'B runtime has no MemoryRepository or semantic embedding provider configured.',
              }),
        },
        get_overview: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        list_pending_reviews: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
        list_experiences_by_source_task: {
          status: this.repository ? 'available' : 'unavailable',
          ...(this.repository
            ? {}
            : { reason: 'B runtime has no MemoryRepository configured.' }),
        },
      },
    };
  }

  async listAgents(status?: string): Promise<AgentBoardListItem[]> {
    return filterLegacyCouncilPseudoAgents(
      await this.capabilities.boardQuery.listAgents(status as AgentStatus),
    );
  }

  getAgent(roleId: string): Promise<AgentBoardAgentView> {
    return this.capabilities.boardQuery.getAgent(roleId);
  }

  listSkills(roleId: string, filter?: SkillListFilter): Promise<SkillView[]> {
    return this.capabilities.boardQuery.listSkills(roleId, filter);
  }

  listExperiences(roleId: string, filter?: ExperienceListFilter): Promise<ExperienceView[]> {
    return this.capabilities.boardQuery.listExperiences(roleId, filter);
  }

  listMaintenance(roleId?: string): Promise<BMemoryMaintenanceEvidence[]> {
    return this.capabilities.maintenance.listEvidence(roleId);
  }

  async promoteSkills(roleId: string, requestedBy: string): Promise<BMemoryMaintenanceEvidence> {
    const promotion = await this.capabilities.maintenance.promoteSkills({
      role_id: roleId,
      requested_by: requestedBy,
    });
    if (!this.options.autoApprovePromotedSkills || promotion.status !== 'completed') {
      return promotion;
    }
    const skills = await Promise.all(
      promotion.skills.map(async (skill) => {
        if (!isPendingSkill(skill)) return skill;
        return this.approveSkill(roleId, skill.id, 'system:auto-approval');
      }),
    );
    return { ...promotion, skills };
  }

  /**
   * 手动晋升一条经验为 Skill（memory.promoteExperience）。
   * 显式指定经验晋升，产出 review_status='pending' 的技能进入待审核队列，
   * 审核走 approveSkill / rejectSkill。校验（仅正经验、未晋升过）在 memory 服务内完成。
   */
  async promoteExperience(roleId: string, experienceId: string): Promise<SkillView> {
    const repository = this.requireRepository('Experience promotion');
    return toSkillView(
      await promoteExperienceToSkill(repository, {
        role_id: roleId,
        experience_id: experienceId,
      }),
    );
  }

  /** 技能市场检索：query 文本 → embedding → 市场池（__market__）内 top-K 召回（Spec §6.2）。 */
  async marketSearch(query: MarketSearchQuery): Promise<SkillRecord[]> {
    if (!this.repository) {
      throw new Error('Market search requires a MemoryRepository');
    }
    if (!this.embedding) {
      throw new Error('Market search requires a semantic embedding provider');
    }
    return marketSearch(this.repository, this.embedding, query);
  }

  /** 技能市场引入：将一条市场技能克隆为引入方副本（Spec §6.2）。 */
  marketImport(roleId: string, sourceSkillId: string): Promise<MarketImportResult> {
    if (!this.repository) {
      throw new Error('Market import requires a MemoryRepository');
    }
    return marketImport(this.repository, roleId, sourceSkillId);
  }

  /** Agent 优雅退休（week3 RFC §12），委托给注入的 lifecycle。 */
  retireAgent(roleId: string, options: RetireOptions = {}): Promise<RetireResult> {
    if (!this.lifecycle) {
      throw new Error('Agent retirement is not available in this B runtime');
    }
    return this.lifecycle.retireAgent(roleId, options);
  }

  /** 三重门控退休检测（week3 RFC §8.2），委托给注入的 lifecycle，不自动退休。 */
  runRetirementScan(roleId?: string): Promise<RetirementScanResult[]> {
    if (!this.lifecycle) {
      throw new Error('Retirement scanning is not available in this B runtime');
    }
    return this.lifecycle.runRetirementScan(roleId);
  }

  /** 显式创建 Agent（memory.createAgent），委托给注入的 lifecycle。 */
  createAgent(spec: CreateAgentSpec): Promise<AgentHandle> {
    if (!this.lifecycle) {
      throw new Error('Agent creation is not available in this B runtime');
    }
    return this.lifecycle.createAgent(spec);
  }

  /** 更新 Agent 元数据（名称 / 标签），委托给注入的 lifecycle。 */
  updateAgent(roleId: string, patch: AgentMetaPatch): Promise<AgentHandle> {
    if (!this.lifecycle) {
      throw new Error('Agent metadata updates are not available in this B runtime');
    }
    return this.lifecycle.updateAgent(roleId, patch);
  }

  /**
   * 硬删除 Agent（memory.deleteAgent），委托给注入的 lifecycle。
   * 未退休 Agent 需要 `options.force`（级联丢弃名下全部资产）。
   */
  deleteAgent(roleId: string, options?: { force?: boolean }): Promise<void> {
    if (!this.lifecycle) {
      throw new Error('Agent deletion is not available in this B runtime');
    }
    return this.lifecycle.deleteAgent(roleId, options);
  }

  /** 手动创建 Skill（memory.createSkill），返回对外 SkillView。 */
  async createSkill(input: CreateSkillInput): Promise<SkillView> {
    const repository = this.requireRepository('Skill creation');
    const skill = await createSkill(repository, input, {
      autoApprove: this.options.autoApprovePromotedSkills === true,
    });
    return toSkillView(skill);
  }

  /** PATCH 更新 Skill（memory.updateSkill），返回对外 SkillView。 */
  async updateSkill(roleId: string, skillId: string, patch: SkillWritePatch): Promise<SkillView> {
    const repository = this.requireRepository('Skill updates');
    return toSkillView(await updateSkill(repository, roleId, skillId, patch));
  }

  /** 删除 Skill（memory.deleteSkill）。 */
  async deleteSkill(roleId: string, skillId: string): Promise<void> {
    const repository = this.requireRepository('Skill deletion');
    await deleteSkill(repository, roleId, skillId);
  }

  /** 技能上架市场（memory.publishSkillToMarket）：置 market_status='available'，保留归属。 */
  async publishSkillToMarket(roleId: string, skillId: string): Promise<SkillView> {
    const repository = this.requireRepository('Skill market publishing');
    return toSkillView(await publishSkillToMarket(repository, roleId, skillId));
  }

  /** PATCH 更新 Experience（memory.updateExperience），返回对外 ExperienceView。 */
  async updateExperience(
    roleId: string,
    experienceId: string,
    patch: ExperienceWritePatch,
  ): Promise<ExperienceView> {
    const repository = this.requireRepository('Experience updates');
    return toExperienceView(await updateExperience(repository, roleId, experienceId, patch));
  }

  /** 删除 Experience（memory.deleteExperience）。 */
  async deleteExperience(roleId: string, experienceId: string): Promise<void> {
    const repository = this.requireRepository('Experience deletion');
    await deleteExperience(repository, roleId, experienceId);
  }

  /** PATCH 更新 Persona（memory.updatePersona）：合并自由文本字段并 version+1。 */
  async updatePersona(roleId: string, patch: PersonaPatch): Promise<PersonaDef> {
    const repository = this.requireRepository('Persona updates');
    return mergePersonaPatch(repository, roleId, patch);
  }

  /**
   * 按需重新生成 Persona（memory.regeneratePersona）：基于当前 skills/experiences
   * 归纳；注入 LLM 时走 LlmPersonaInduction（失败降级规则版），否则直接规则版。
   */
  async regeneratePersona(roleId: string): Promise<PersonaDef> {
    const repository = this.requireRepository('Persona regeneration');
    return regeneratePersona(
      repository,
      this.capabilities.bufferRepository,
      roleId,
      this.personaInducer(),
    );
  }

  /** 用户评分（memory.rateTask）：调整派生经验置信度并写入 pending buffer。 */
  rateTask(roleId: string, taskId: string, rating: UserRating, note?: string): Promise<UserRatingResult> {
    const repository = this.requireRepository('Task rating');
    return applyUserRating(repository, this.capabilities.bufferRepository, {
      role_id: roleId,
      task_id: taskId,
      rating,
      ...(note !== undefined ? { note } : {}),
    });
  }

  /**
   * Buffer 状态总览（memory.getBufferState）：
   * meta + pending + dead-letter seq 列表 + 死信详情（含失败原因）。
   */
  async getBufferState(roleId: string): Promise<{
    meta: BufferMeta;
    pending_seqs: number[];
    dead_letter_seqs: number[];
    dead_letters: DeadLetterEntry[];
  }> {
    const repository = this.requireRepository('Buffer state');
    const [meta, pending_seqs, dead_letter_seqs, dead_letters] = await Promise.all([
      this.capabilities.bufferRepository.getBufferMeta(roleId),
      this.capabilities.bufferRepository.listPendingBufferSeqs(roleId),
      this.capabilities.bufferRepository.listDeadLetterSeqs(roleId),
      this.capabilities.bufferRepository.listDeadLetterEntries(roleId),
    ]);
    // roleId 必须存在（避免对不存在 Agent 的探针）
    await repository.getAgent(roleId);
    return { meta, pending_seqs, dead_letter_seqs, dead_letters };
  }

  /** 查看一条 pending 缓冲区快照（memory.getPendingBuffer）。 */
  async getPendingBuffer(roleId: string, seq: number): Promise<{
    snapshot: BufferSnapshot;
    agent_context?: AgentContextSnapshot;
  } | undefined> {
    this.requireRepository('Pending buffer');
    return this.capabilities.bufferRepository.getPendingBuffer(roleId, seq);
  }

  /**
   * 重试提取（memory.retryExtraction）：死信缓冲区恢复到 pending 后重新入队
   * 维护链路（BMemoryMaintenanceRunner.scheduleBuffer），返回调度证据。
   */
  async retryExtraction(roleId: string, seq: number): Promise<BMemoryMaintenanceEvidence> {
    const repository = this.requireRepository('Extraction retry');
    await repository.getAgent(roleId);
    await this.capabilities.bufferRepository.restoreDeadLetter(roleId, seq);
    const pending = await this.capabilities.bufferRepository.getPendingBuffer(roleId, seq);
    if (!pending) {
      throw new Error(`Pending buffer not found after restore: seq=${seq}`);
    }
    return this.capabilities.maintenance.scheduleBuffer({
      task_id: pending.snapshot.source_task_id,
      run_id: `retry:${roleId}:${String(seq)}`,
      role_id: roleId,
      buffer_seq: seq,
    });
  }

  /**
   * 单 Agent 内文本检索（memory.searchMemory）：query → embedding →
   * repo.searchSkills / searchExperiences（向量 top-K），返回对外视图，
   * 并附每条召回的相似度分数（供前端解释"为什么召回这条"）。
   */
  async searchMemory(
    roleId: string,
    query: string,
    options: {
      top_k?: number;
      min_similarity?: number;
      include_skills?: boolean;
      include_experiences?: boolean;
    } = {},
  ): Promise<{
    skills: Array<SkillView & { similarity: number }>;
    experiences: Array<ExperienceView & { similarity: number }>;
  }> {
    const repository = this.requireRepository('Memory search');
    if (!this.embedding) {
      throw new Error('Memory search requires a semantic embedding provider');
    }
    const query_embedding = await this.embedding.embed(query);
    const top_k = options.top_k ?? 5;
    const searchOptions = {
      query_embedding,
      top_k,
      ...(options.min_similarity !== undefined
        ? { min_similarity: options.min_similarity }
        : {}),
    };
    const [skills, experiences] = await Promise.all([
      options.include_skills === false ? [] : repository.searchSkills(roleId, searchOptions),
      options.include_experiences === false
        ? []
        : repository.searchExperiences(roleId, searchOptions),
    ]);
    const [scoredSkills, scoredExperiences] = await Promise.all([
      Promise.all(
        skills.map(async (skill) => ({
          ...toSkillView(skill),
          similarity: await this.computeSimilarity(query_embedding, skill),
        })),
      ),
      Promise.all(
        experiences.map(async (experience) => ({
          ...toExperienceView(experience),
          similarity: await this.computeSimilarity(query_embedding, experience),
        })),
      ),
    ]);
    return { skills: scoredSkills, experiences: scoredExperiences };
  }

  /** 计算召回记录与查询向量的余弦相似度（空 embedding 时按描述补算）。 */
  private async computeSimilarity(
    queryEmbedding: number[],
    record: SkillRecord | ExperienceRecord,
  ): Promise<number> {
    const embedding = this.embedding;
    if (!embedding) {
      throw new Error('Memory search requires a semantic embedding provider');
    }
    const recordEmbedding =
      record.description_embedding.length === embedding.dimensions
        ? record.description_embedding
        : await embedding.embed(record.description);
    return cosineSimilarity(queryEmbedding, recordEmbedding);
  }

  /** 全局记忆总览（memory.getOverview）：跨 Agent 聚合规模与健康信号。 */
  getOverview(): Promise<MemoryOverview> {
    const repository = this.requireRepository('Memory overview');
    return computeMemoryOverview(repository, this.capabilities.bufferRepository);
  }

  /**
   * 跨 Agent 待审核技能队列（memory.listPendingReviews）。
   * 汇总所有 Agent 名下 review_status='pending' 的技能，按提交时间升序。
   */
  async listPendingReviews(): Promise<SkillView[]> {
    this.requireRepository('Pending reviews');
    const agentIds = await this.capabilities.boardQuery.listAgents();
    const batches = await Promise.all(
      agentIds.map((agent) =>
        this.capabilities.boardQuery.listSkills(agent.role_id, { review_status: 'pending' }),
      ),
    );
    return batches.flat().sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /**
   * 按任务溯源经验（memory.listExperiencesBySourceTask）。
   * 跨所有 Agent 查找 source_task_id === taskId 的经验，返回对外视图。
   */
  async listExperiencesBySourceTask(taskId: string): Promise<ExperienceView[]> {
    const repository = this.requireRepository('Experience source lookup');
    const agentIds = await repository.listAgentIds();
    const batches = await Promise.all(
      agentIds.map(async (roleId) => {
        const experiences = await repository.listExperiences(roleId);
        return experiences.filter((item) => item.source_task_id === taskId);
      }),
    );
    return batches.flat().map(toExperienceView);
  }

  /** 构造 Persona 归纳器：有 LLM 注入则 LLM 归纳（自动降级规则版），否则纯规则版 */
  private personaInducer(): PersonaInducer {
    if (this.llm) {
      const induction = new LlmPersonaInduction(this.llm);
      return (memory, input) => induction.induce(memory, input);
    }
    return (memory, input) => ruleBasedPersonaInduction(memory, input);
  }

  approveSkill(roleId: string, skillId: string, reviewedBy: string): Promise<ReviewedSkill> {
    return this.capabilities.reviewSkill({
      role_id: roleId,
      skill_id: skillId,
      decision: 'approved',
      reviewer: reviewedBy,
    });
  }

  rejectSkill(roleId: string, skillId: string, reviewedBy: string): Promise<ReviewedSkill> {
    return this.capabilities.reviewSkill({
      role_id: roleId,
      skill_id: skillId,
      decision: 'rejected',
      reviewer: reviewedBy,
    });
  }

  /** 未注入 repository 时抛明确错误（与 capabilities 报告的 unavailable 对应） */
  private requireRepository(operation: string): MemoryRepository {
    if (!this.repository) {
      throw new Error(`${operation} requires a MemoryRepository`);
    }
    return this.repository;
  }
}

function isPendingSkill(value: unknown): value is { id: string; review_status: 'pending' } {
  if (!value || typeof value !== 'object') return false;
  const skill = value as Record<string, unknown>;
  return typeof skill.id === 'string' && skill.review_status === 'pending';
}
