import {
  type AgentBoardAgentView,
  type AgentBoardListItem,
  type AgentHandle,
  applyUserRating,
  type BufferArchiveOutcome,
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
  type PendingBufferRead,
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
  reindexMemory,
  type ReindexMemoryResult,
  type ContextDeliveryFilter,
  type DriverFeedbackFilter,
  type MemoryDeliveryRepository,
  type ClaimedDelivery,
  type DeliveryChannel,
  type DeliveryClaimRequest,
  type DeliveryRecordLocator,
  contextDeliveryId,
  contextDeliveryKey,
} from '../memory';
import type {
  AgentContextSnapshot,
  AgentStatus,
  BufferMeta,
  BufferSnapshot,
  ContextDeliveryItem,
  DeliveryStatus,
  DriverFeedbackRecord,
  ExperienceRecord,
  PersonaDef,
  SkillRecord,
} from '../memory/schemas';

import { SCHEMA_VERSION, createId, nowTimestamp } from '../core';
import type { BMemoryMaintenanceEvidence } from './b-memory-maintenance-runner';
import type { BPublicCapabilities, ReviewedSkill } from './b-public-capabilities';
import { filterLegacyCouncilPseudoAgents } from './council-legacy-agent-filter';
import type { BEmbeddingRuntimeInfo } from './production-b-runtime';

export interface BMemoryOperationCapability {
  status: 'available' | 'unavailable';
  reason?: string;
}

/**
 * 交付 claim 的能力声明。
 *
 * `isolation` 是这里最要紧的一格：只有文件实现用独占锁文件串行化 claim，
 * 多进程消费才成立；内存实现只在同进程内不重复投递，把它当生产部署用会
 * 出现两个消费者同时处理同一条交付。调用方据此决定能不能开多个消费者。
 */
export interface BMemoryDeliveryClaimCapability {
  status: 'available' | 'unavailable';
  reason?: string;
  isolation: 'process_mutex' | 'exclusive_lock_file' | 'unavailable';
  /** 未显式指定 lease_ms 时的租约时长 */
  lease_ms: number;
  /** 投递次数上限；达到后交付项进 dead_letter */
  max_attempts: number;
}

export interface BMemoryCapabilities {
  schema_version: 'newide.b-memory-capabilities.v4';
  embedding: BEmbeddingRuntimeInfo;
  skill_review: {
    mode: 'manual' | 'auto_approve';
  };
  /**
   * 记忆加工的归属声明。
   *
   * Experience 提取 / Skill 晋升 / Persona 演化由**外部** Memory Maintenance 系统
   * 负责；本仓只提供交付项、反馈 outbox 与只读查询。这里刻意不暴露本仓的加工
   * 状态——本仓没有那样的 Worker，暴露它只会让人以为任务流程会等下游。
   */
  memory_maintenance: {
    ownership: 'external';
    context_delivery: BMemoryOperationCapability;
    driver_feedback_outbox: BMemoryOperationCapability;
    /** claim/lease/重试的可用性与隔离级别（决定能不能多进程消费） */
    claim: BMemoryDeliveryClaimCapability;
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
    /** 下游交付：列出本仓已提交的上下文交付项 */
    list_context_deliveries: BMemoryOperationCapability;
    /** 下游交付：按 id 取一条交付项及其完整 DriverReturn + AgentContextSnapshot */
    get_context_delivery: BMemoryOperationCapability;
    /** 下游交付：列出 Driver 使用反馈（含经验尚不存在的那部分） */
    list_driver_feedback: BMemoryOperationCapability;
    /** 下游交付：claim 一条待投递的上下文或反馈（pending → processing） */
    claim_delivery: BMemoryOperationCapability;
    /** 下游交付：延长自己持有的 lease */
    renew_delivery_claim: BMemoryOperationCapability;
    /** 下游交付：ack 一次交付（processed / failed，失败走重试或 dead_letter） */
    ack_delivery: BMemoryOperationCapability;
    /** 下游交付：人工把 dead_letter 放回 pending */
    retry_delivery: BMemoryOperationCapability;
    /** 下游交付：把 lease 过期仍停在 processing 的记录放回队列 */
    restore_expired_deliveries: BMemoryOperationCapability;
    /** 下游交付：列出当前可投递的记录 */
    list_retryable_deliveries: BMemoryOperationCapability;
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
    reindex: BMemoryOperationCapability;
  };
}

/** getContextDelivery 的返回：交付项本身 + 从 Buffer 现取的完整输入 */
export interface ContextDeliveryPayload {
  delivery: ContextDeliveryItem;
  /** Buffer 快照是否取得到；false 表示 payload 现在拿不出来（不是空上下文） */
  payload_available: boolean;
  /**
   * payload_available=false 时的一句说明。两种情形都会带：
   * - 记录在但整份读不出来（报告损坏）；
   * - 报告读得出来，但配对 AgentContextSnapshot「声明过却读不出来」（见 payload 说明）。
   *   此时 `driver_return` 仍会给出——DriverReturn 单独可读，缺的是另一半。
   */
  payload_warning?: string;
  driver_return?: BufferSnapshot['driver_return'];
  agent_context?: AgentContextSnapshot;
}

/**
 * ack 的返回：交付项 + 源 Buffer 归档结果。
 *
 * 归档结果放进 ack 的返回值，是因为「交付已 processed、Buffer 还留在 pending」是需要被
 * 看见的一致性缺口：ack 不能回滚（下游确实处理完了），归档却可能没落地。调用方据此决定
 * 要不要重试归档（见 retryExtraction 与 getBufferState 的 archive_backlog），而不是拿到一个
 * 看起来完全成功的结果、却永远读不到那条本该被归档的 Buffer。
 *
 * `archive` 只在 `outcome: 'processed'` 且交付状态确实推进到 processed 时出现——那时
 * `delivery.status === 'processed'`。失败路径（退避重试或进 dead_letter）不碰 Buffer，
 * 没有归档这一步；feedback 通道不引用源 Buffer，同样没有。
 */
export type AckDeliveryPayload =
  | { channel: 'context'; delivery: ContextDeliveryItem; archive?: BufferArchiveOutcome }
  | { channel: 'feedback'; feedback: DriverFeedbackRecord };

/** 一条归档缺口：交付已 processed，但源 Buffer 还留在 pending */
export interface DeliveryArchiveBacklogEntry {
  delivery_id: string;
  task_id: string;
  buffer_seq: number;
  updated_at: string;
}

/** claim / ack 的返回：交付项本身，按通道放在各自的字段下 */
export type DeliveryRecordPayload =
  | { channel: 'context'; delivery: ContextDeliveryItem }
  | { channel: 'feedback'; feedback: DriverFeedbackRecord };

/** 交付状态计数 */
export interface DeliveryStatusCounts {
  pending: number;
  processing: number;
  processed: number;
  dead_letter: number;
}

/** 一条死信交付的摘要（不含 payload，只够解释「为什么卡住」） */
export interface DeliveryDeadLetterEntry {
  channel: DeliveryChannel;
  /** delivery_id / feedback_id */
  id: string;
  task_id: string;
  attempt_count: number;
  last_error?: string;
  updated_at: string;
}

/** memory.getBufferState 里的交付视图 */
export interface DeliveryStateSummary {
  /** 本运行时有没有交付存储；没有时下面各项恒为空 */
  available: boolean;
  context: DeliveryStatusCounts;
  feedback: DeliveryStatusCounts;
  dead_letters: DeliveryDeadLetterEntry[];
  /**
   * 归档缺口：交付已 processed、源 Buffer 却还留在 pending。
   *
   * 这一格存在是因为 delivery 与 Buffer 在两个存储里、没有跨存储事务：ack 成功只保证
   * 交付状态推进了，Buffer 归档是另一次写。缺口由**持久状态本身**推导出来（不是一份
   * 单独记的日志），所以重启后照样看得见；运维拿这里的 seq 调 retryExtraction 即可补做
   * 归档（见 BMemoryBackendService.retryExtraction）。
   */
  archive_backlog: DeliveryArchiveBacklogEntry[];
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
    > & { deliveryRepository?: MemoryDeliveryRepository },
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
    // 交付存储是可选的（测试缝/无下游部署）：缺席时明确报 unavailable，
    // 而不是让调用方在后面收到一个语焉不详的 undefined。
    const delivery = this.capabilities.deliveryRepository;
    const deliveryCapability = (what: string): BMemoryOperationCapability =>
      delivery
        ? { status: 'available' }
        : {
            status: 'unavailable',
            reason: `B runtime has no MemoryDeliveryRepository configured (${what}).`,
          };
    return {
      schema_version: 'newide.b-memory-capabilities.v4',
      embedding: { ...this.embeddingInfo },
      skill_review: {
        mode: this.options.autoApprovePromotedSkills ? 'auto_approve' : 'manual',
      },
      memory_maintenance: {
        ownership: 'external',
        context_delivery: deliveryCapability('context delivery'),
        driver_feedback_outbox: deliveryCapability('driver feedback outbox'),
        claim: delivery
          ? {
              status: 'available',
              isolation: delivery.policy.claim_isolation,
              lease_ms: delivery.policy.lease_ms,
              max_attempts: delivery.policy.max_attempts,
            }
          : {
              status: 'unavailable',
              reason: 'B runtime has no MemoryDeliveryRepository configured (delivery claim).',
              isolation: 'unavailable',
              lease_ms: 0,
              max_attempts: 0,
            },
      },
      operations: {
        list_context_deliveries: deliveryCapability('list context deliveries'),
        get_context_delivery: deliveryCapability('get context delivery'),
        list_driver_feedback: deliveryCapability('list driver feedback'),
        claim_delivery: deliveryCapability('delivery claim'),
        renew_delivery_claim: deliveryCapability('delivery claim renewal'),
        ack_delivery: deliveryCapability('delivery acknowledgement'),
        retry_delivery: deliveryCapability('delivery retry'),
        restore_expired_deliveries: deliveryCapability('expired claim recovery'),
        list_retryable_deliveries: deliveryCapability('retryable delivery listing'),
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
        reindex: {
          status: this.repository && this.embedding ? 'available' : 'unavailable',
          ...(this.repository && this.embedding
            ? {}
            : {
                reason:
                  'B runtime has no MemoryRepository or semantic embedding provider configured.',
              }),
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
   * meta + pending + dead-letter seq 列表 + 死信详情（含失败原因）
   * + 交付视图（两条通道的状态计数与死信摘要）。
   *
   * 交付视图放这里，是因为「失败 3 次之后卡住了」是运维必须能一眼看到的事实：
   * 交付项自己不会主动喊，得有一个总览入口。它的状态与 Buffer 状态互相独立——
   * 上下文交付了不等于 Buffer 被处理过，反之亦然。
   */
  async getBufferState(roleId: string): Promise<{
    meta: BufferMeta;
    pending_seqs: number[];
    dead_letter_seqs: number[];
    dead_letters: DeadLetterEntry[];
    delivery: DeliveryStateSummary;
  }> {
    const repository = this.requireRepository('Buffer state');
    const [meta, pending_seqs, dead_letter_seqs, dead_letters] = await Promise.all([
      this.capabilities.bufferRepository.getBufferMeta(roleId),
      this.capabilities.bufferRepository.listPendingBufferSeqs(roleId),
      this.capabilities.bufferRepository.listDeadLetterSeqs(roleId),
      this.capabilities.bufferRepository.listDeadLetterEntries(roleId),
    ]);
    // 归档缺口要拿 pending 列表来推：交付档案自己看不出源 Buffer 有没有搬走
    const delivery = await this.describeDeliveryState(roleId, pending_seqs);
    // roleId 必须存在（避免对不存在 Agent 的探针）
    await repository.getAgent(roleId);
    return { meta, pending_seqs, dead_letter_seqs, dead_letters, delivery };
  }

  /** 交付视图：两条通道各自的状态计数 + 死信摘要 + 归档缺口 */
  private async describeDeliveryState(
    roleId: string,
    pendingSeqs: readonly number[],
  ): Promise<DeliveryStateSummary> {
    const repository = this.capabilities.deliveryRepository;
    if (!repository) {
      return {
        available: false,
        context: emptyDeliveryStatusCounts(),
        feedback: emptyDeliveryStatusCounts(),
        dead_letters: [],
        archive_backlog: [],
      };
    }
    const [context, feedback] = await Promise.all([
      repository.listContextDeliveries({ role_id: roleId }),
      repository.listDriverFeedback({ role_id: roleId }),
    ]);
    const dead_letters: DeliveryDeadLetterEntry[] = [
      ...context
        .filter((item) => item.status === 'dead_letter')
        .map((item) => ({
          channel: 'context' as const,
          id: item.delivery_id,
          task_id: item.task_id,
          attempt_count: item.attempt_count,
          ...(item.last_error !== undefined ? { last_error: item.last_error } : {}),
          updated_at: item.updated_at,
        })),
      ...feedback
        .filter((record) => record.status === 'dead_letter')
        .map((record) => ({
          channel: 'feedback' as const,
          id: record.feedback_id,
          task_id: record.task_id,
          attempt_count: record.attempt_count,
          ...(record.last_error !== undefined ? { last_error: record.last_error } : {}),
          updated_at: record.updated_at,
        })),
    ];
    const stillPending = new Set(pendingSeqs);
    const archive_backlog: DeliveryArchiveBacklogEntry[] = context
      .filter((item) => item.status === 'processed' && stillPending.has(item.buffer_seq))
      .map((item) => ({
        delivery_id: item.delivery_id,
        task_id: item.task_id,
        buffer_seq: item.buffer_seq,
        updated_at: item.updated_at,
      }));
    return {
      available: true,
      context: countDeliveryStatus(context),
      feedback: countDeliveryStatus(feedback),
      dead_letters,
      archive_backlog,
    };
  }

  /** 查看一条 pending 缓冲区快照（memory.getPendingBuffer）。 */
  async getPendingBuffer(roleId: string, seq: number): Promise<PendingBufferRead | undefined> {
    this.requireRepository('Pending buffer');
    return this.capabilities.bufferRepository.getPendingBuffer(roleId, seq);
  }

  /**
   * 重试交付（memory.retryExtraction）：把这条 Buffer 名下**各自独立**的两处死信放回队列。
   *
   * 名字沿用历史接口，但语义是「恢复这条 Buffer 的下游交付」——本仓不执行
   * Experience 提取，下游系统怎么消费、什么时候消费都不由这里决定。
   *
   * 两处死信彼此独立，因此各自判断、各自恢复，谁都不阻塞谁：
   * - Buffer 在死信里 → 恢复回 pending；本来就在 pending → 不动它；
   * - 交付在死信里 → 放回 pending 并清零次数；已 pending / 已 processed → 不动它
   *   （processed 是终止态，重试不得把一条已经处理完的交付再投一次）；
   * - 「Buffer 进了死信而交付还 pending」与「交付进了死信而 Buffer 还 pending」
   *   都是正常形态，各自恢复那一条即可。
   *
   * Buffer 既不在 pending 也不在死信（已被归档或删除）时如实返回一条 skipped
   * 证据并写明原因，而不是抛错：运维需要看到的是「这条没什么可恢复的」，不是一句
   * 「找不到死信」把整次恢复操作打断。
   *
   * 此外还负责补做**归档缺口**：交付已 processed 而 Buffer 仍留在 pending 时，把 Buffer
   * 归档走（见 getBufferState 的 archive_backlog）。补做结果同样写进 warnings。
   */
  async retryExtraction(roleId: string, seq: number): Promise<BMemoryMaintenanceEvidence> {
    const repository = this.requireRepository('Extraction retry');
    await repository.getAgent(roleId);
    const bufferRepository = this.capabilities.bufferRepository;
    const warnings: string[] = [];
    const deliveryRepository = this.capabilities.deliveryRepository;
    const deliveryId = contextDeliveryId(contextDeliveryKey({ role_id: roleId, buffer_seq: seq }));

    // 归档缺口修复排在最前：交付已经 processed、Buffer 却仍留在 pending，说明上一次 ack
    // 之后的归档没落地（两个存储之间没有事务，ack 成功不代表 Buffer 搬走了）。这正是
    // getBufferState 里 archive_backlog 列出来的那批记录。放在死信恢复之前，是因为这一步
    // 只对「本来就留在 pending」的记录有意义——刚被恢复回来的 Buffer 该继续等下游。
    if (deliveryRepository) {
      const repair = await this.repairDeliveredBufferArchive(roleId, seq, deliveryId);
      if (repair) warnings.push(repair);
    }

    if ((await bufferRepository.listDeadLetterSeqs(roleId)).includes(seq)) {
      try {
        await bufferRepository.restoreDeadLetter(roleId, seq);
      } catch (error) {
        // 恢复失败（如死信记录损坏）不该拦下交付那一侧的恢复
        warnings.push(
          `Buffer ${roleId}:${String(seq)} could not be restored from dead letter ` +
            `(${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }

    if (deliveryRepository) {
      const retried = await deliveryRepository.retryDeadLetterDelivery({
        channel: 'context',
        role_id: roleId,
        id: deliveryId,
      });
      if (!retried) {
        const existing = await deliveryRepository.getContextDelivery(roleId, deliveryId);
        warnings.push(
          existing === undefined
            ? 'No context delivery has been submitted for this Buffer yet.'
            : `Context delivery is ${existing.status}; it was left untouched.`,
        );
      }
    }

    const pending = await bufferRepository.getPendingBuffer(roleId, seq);
    if (!pending) {
      const completedAt = nowTimestamp();
      warnings.push('Buffer is neither pending nor dead-lettered, so nothing was scheduled.');
      return {
        maintenance_ref: createId('b_maintenance'),
        kind: 'context_delivery',
        status: 'skipped',
        role_id: roleId,
        buffer_seq: seq,
        experiences: [],
        skills: [],
        warnings,
        created_at: completedAt,
        completed_at: completedAt,
        schema_version: SCHEMA_VERSION,
      };
    }

    const evidence = await this.capabilities.maintenance.scheduleBuffer({
      task_id: pending.snapshot.source_task_id,
      run_id: `retry:${roleId}:${String(seq)}`,
      role_id: roleId,
      buffer_seq: seq,
    });
    // 恢复明细只随返回值给调用方（持久化的那份是 runner 自己写的，两处不合并）
    return warnings.length > 0
      ? { ...evidence, warnings: [...warnings, ...evidence.warnings] }
      : evidence;
  }

  /**
   * 列出已提交的上下文交付项（memory.listContextDeliveries）。
   *
   * 这是下游系统「有哪些活要干」的只读入口：只返回交付项本身，payload 由
   * getContextDelivery 按需取回。
   */
  async listContextDeliveries(filter: ContextDeliveryFilter = {}): Promise<ContextDeliveryItem[]> {
    return this.requireDeliveryRepository('Context delivery').listContextDeliveries(filter);
  }

  /**
   * 按交付 id 取回完整输入（memory.getContextDelivery）。
   *
   * payload 从 Buffer 现取现读，不存第二份副本——DriverReturn 与
   * AgentContextSnapshot 的唯一事实来源始终是 `report_<seq>` / `context_<seq>`。
   * 读的是**任意分区**（pending / processed / dead_letter）：下游 ack 之后 Buffer
   * 会被归档离开 pending，而交付项本身仍然有效，交付的 payload 不能跟着消失。
   *
   * 三种「取不全」必须分开说，不能都塌成「本来就没有上下文」：
   * - 快照真的不在了（已被删除、或这个 seq 从未落过盘）→ `payload_available: false`，无 payload；
   * - 快照在、但它声明的 AgentContextSnapshot 读不出来（缺失 / 损坏 / schema 不匹配）
   *   → `payload_available: false` + `payload_warning`，DriverReturn 照给：报告那一半是好的，
   *   缺的是另一半；
   * - 历史 Buffer 本来就没有上下文（没有 context_snapshot_ref）→ `payload_available: true`，
   *   只是没有 `agent_context`，这是允许的兼容性降级。
   */
  async getContextDelivery(
    roleId: string,
    deliveryId: string,
  ): Promise<ContextDeliveryPayload | undefined> {
    const delivery = await this.requireDeliveryRepository('Context delivery').getContextDelivery(
      roleId,
      deliveryId,
    );
    if (!delivery) return undefined;
    try {
      const stored = await this.capabilities.bufferRepository.getStoredBuffer(
        roleId,
        delivery.buffer_seq,
      );
      if (!stored) {
        return { delivery, payload_available: false };
      }
      // 声明过引用却读不出来：DriverReturn 仍可单独读取，但「完整 payload 可用」是假的
      if (stored.agentContextStatus === 'unreadable') {
        return {
          delivery,
          payload_available: false,
          payload_warning:
            stored.agentContextError ??
            'The AgentContextSnapshot paired with this delivery could not be read.',
          driver_return: stored.snapshot.driver_return,
        };
      }
      return {
        delivery,
        payload_available: true,
        driver_return: stored.snapshot.driver_return,
        ...(stored.agentContext ? { agent_context: stored.agentContext } : {}),
      };
    } catch (error) {
      return {
        delivery,
        payload_available: false,
        payload_warning: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 列出 Driver 使用反馈（memory.listDriverFeedback）。
   *
   * 包含引用了尚不存在经验的那部分——它们就在 outbox 里等着下游归并，
   * 不是需要被过滤掉的异常数据。
   */
  async listDriverFeedback(filter: DriverFeedbackFilter = {}): Promise<DriverFeedbackRecord[]> {
    return this.requireDeliveryRepository('Driver feedback outbox').listDriverFeedback(filter);
  }

  // ── 下游交付的 claim / lease / 重试（工作包 C） ──────────────────
  //
  // 这几个方法是外部 Memory Maintenance 系统真正的「取活」入口：claim 拿到一条
  // 交付项，处理完 ack；中途崩了就让 lease 过期，由 restore 放回队列。本仓不参与
  // 处理过程，也不因为下游失败而改动 Task/Run 的终态。

  /**
   * claim 一条可投递的交付项（memory.claimDelivery）。
   *
   * 给 `id` 就只 claim 那一条，否则 claim 当前最该投递的一条。两条通道共用
   * 同一套状态机；拿不到（已被别人 claim、还没到退避时刻、次数用满）返回 undefined。
   */
  async claimDelivery(
    input: DeliveryClaimRequest & { id?: string | undefined },
  ): Promise<DeliveryRecordPayload | undefined> {
    const repository = this.requireDeliveryRepository('Delivery claim');
    const claimed =
      input.id !== undefined
        ? await repository.claimDelivery({ ...input, role_id: requireRoleId(input), id: input.id })
        : await repository.claimNextDelivery(input);
    return claimed ? toDeliveryPayload(claimed) : undefined;
  }

  /** 延长自己持有的 lease（memory.renewDeliveryClaim） */
  async renewDeliveryClaim(
    input: DeliveryRecordLocator & { owner: string; lease_ms?: number | undefined },
  ): Promise<DeliveryRecordPayload | undefined> {
    const claimed = await this.requireDeliveryRepository(
      'Delivery claim renewal',
    ).renewDeliveryClaim(input);
    return claimed ? toDeliveryPayload(claimed) : undefined;
  }

  /**
   * ack 一次交付（memory.ackDelivery）。
   *
   * `outcome: 'processed'` 表示下游处理完成；`'failed'` 需要给出 error 与
   * retryable —— 可重试的错误在退避后回到队列，不可重试或已用满次数的进 dead_letter。
   *
   * 上下文交付被确认完成时，源 Buffer 一并归档离开 pending：下游已经拿着这份上下文
   * 干活了，再让它无限期占着待办队列只会把「还有多少活没干」这个数字说错。这是下游
   * 动作的**结果**，不是任务流程在等下游——Task/Run 的终态早已写定，交付状态与 Buffer
   * 归档都不参与其中。失败路径**不动** Buffer：留着重试才有意义。
   *
   * 归档的一致性策略（两个存储，没有跨存储事务）：
   * ack 的成功语义**只覆盖交付状态**——`completeDelivery` 落了盘，下游处理完成就是既定
   * 事实，不会因为 Buffer 搬不动而回滚；因此归档结果不回滚 ack，而是作为判别式随返回值
   * 交给调用方（见 AckDeliveryPayload 与 BufferArchiveOutcome）。归档真的没落地时返回
   * `archive.status='failed'`，缺口同时出现在 getBufferState 的 `archive_backlog` 里，
   * 运维可用 retryExtraction 补做。重复 ack 是幂等的：completeDelivery 只对 processing
   * 生效，第二次直接返回 undefined，也就不会再归档一次。
   */
  async ackDelivery(
    input: DeliveryRecordLocator & {
      owner?: string | undefined;
      outcome: 'processed' | 'failed';
      error?: string | undefined;
      retryable?: boolean | undefined;
      processor_version?: string | undefined;
    },
  ): Promise<AckDeliveryPayload | undefined> {
    const repository = this.requireDeliveryRepository('Delivery acknowledgement');
    if (input.outcome === 'processed') {
      const completed = await repository.completeDelivery({
        channel: input.channel,
        role_id: input.role_id,
        id: input.id,
        owner: input.owner,
        processor_version: input.processor_version,
      });
      if (!completed) return undefined;
      // feedback 通道没有源 Buffer，没有归档这一步
      if (completed.channel === 'feedback') {
        return { channel: 'feedback', feedback: completed.item };
      }
      return {
        channel: 'context',
        delivery: completed.item,
        archive: await this.archiveDeliveredBuffer(completed.item.role_id, completed.item.buffer_seq),
      };
    }
    const failed = await repository.failDelivery({
      channel: input.channel,
      role_id: input.role_id,
      id: input.id,
      owner: input.owner,
      error: input.error ?? 'Delivery failed without a reason',
      retryable: input.retryable ?? false,
    });
    return failed ? toDeliveryPayload(failed) : undefined;
  }

  /**
   * 把已经交付完成的上下文对应的 Buffer 移出 pending，并把结果讲清楚（不再吞掉）。
   *
   * 归档只清理队列，不改变 ack 的成功语义：交付说的是「下游处理完了」，这件事已经成真。
   * 但「Buffer 早就不在 pending」（已被别的路径归档 / 进了死信 / 压根没落过盘）与
   * 「归档动作真的失败了」是两回事，前者无需修复、后者不能当成无事发生——所以这里交给
   * BufferRepository.archiveBuffer 判类，调用方从返回值就能看出是哪一种。
   */
  private archiveDeliveredBuffer(
    roleId: string,
    bufferSeq: number,
  ): Promise<BufferArchiveOutcome> {
    return this.capabilities.bufferRepository.archiveBuffer(roleId, bufferSeq);
  }

  /**
   * 补做一次「交付已 processed、Buffer 还留在 pending」的归档，把结果交给调用方写进 warnings。
   *
   * 只在交付确实处于 processed 时才动：交付还没被处理时，Buffer 留在 pending 是正常形态，
   * 把它归档走等于替下游做了决定。没有缺口（或 Buffer 已到终局）返回 undefined。
   */
  private async repairDeliveredBufferArchive(
    roleId: string,
    seq: number,
    deliveryId: string,
  ): Promise<string | undefined> {
    const deliveryRepository = this.capabilities.deliveryRepository;
    if (!deliveryRepository) return undefined;
    const delivery = await deliveryRepository.getContextDelivery(roleId, deliveryId);
    if (delivery?.status !== 'processed') return undefined;
    const outcome = await this.capabilities.bufferRepository.archiveBuffer(roleId, seq);
    switch (outcome.status) {
      case 'archived':
        return `Archived Buffer ${roleId}:${String(seq)}: its delivery had been acknowledged without the archive landing.`;
      case 'already_archived':
      case 'not_pending':
        // 已到终局（processed / dead_letter）：归档缺口本来就不存在
        return undefined;
      case 'missing':
        return `Delivery ${deliveryId} is processed but Buffer ${roleId}:${String(seq)} is in no partition; there is nothing left to archive.`;
      case 'failed':
        return `Buffer ${roleId}:${String(seq)} is still pending after a repair attempt: ${outcome.message}`;
    }
  }

  /** 人工重试：把 dead_letter 的交付项放回 pending（memory.retryDelivery） */
  async retryDelivery(input: DeliveryRecordLocator): Promise<DeliveryRecordPayload | undefined> {
    const retried = await this.requireDeliveryRepository('Delivery retry').retryDeadLetterDelivery(
      input,
    );
    return retried ? toDeliveryPayload(retried) : undefined;
  }

  /**
   * 启动/运维恢复：把 lease 过期仍停在 processing 的交付项放回队列
   * （memory.restoreExpiredDeliveries）。
   */
  async restoreExpiredDeliveries(options: {
    channel?: DeliveryChannel | undefined;
    role_id?: string | undefined;
  } = {}): Promise<DeliveryRecordPayload[]> {
    const restored = await this.requireDeliveryRepository(
      'Expired claim recovery',
    ).restoreExpiredDeliveryClaims(options);
    return restored.map(toDeliveryPayload);
  }

  /** 当前可投递的记录（memory.listRetryableDeliveries） */
  async listRetryableDeliveries(options: {
    channel?: DeliveryChannel | undefined;
    role_id?: string | undefined;
  } = {}): Promise<DeliveryRecordPayload[]> {
    const due = await this.requireDeliveryRepository(
      'Retryable delivery listing',
    ).listRetryableDeliveries(options);
    return due.map(toDeliveryPayload);
  }

  private requireDeliveryRepository(operation: string): MemoryDeliveryRepository {
    const repository = this.capabilities.deliveryRepository;
    if (!repository) {
      throw new Error(`${operation} requires a MemoryDeliveryRepository, which this runtime does not have.`);
    }
    return repository;
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

  /**
   * 重建向量索引（memory.reindex）：切换 embedding 模型后重算存量
   * Skills / Experiences 的 description_embedding（Spec §7.2）。
   * roleId 缺省全量；force=true 无条件重算（同维度换模型场景）。
   */
  async reindexMemory(
    roleId?: string,
    options: { force?: boolean } = {},
  ): Promise<ReindexMemoryResult> {
    const repository = this.requireRepository('Memory reindex');
    if (!this.embedding) {
      throw new Error('Memory reindex requires a semantic embedding provider');
    }
    return reindexMemory(repository, this.embedding, {
      ...(roleId !== undefined ? { role_id: roleId } : {}),
      ...(options.force !== undefined ? { force: options.force } : {}),
    });
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

/** 把 port 的判别式结果摊平成 JSON 友好的形状（前端不必再按 channel 取字段） */
function toDeliveryPayload(claimed: ClaimedDelivery): DeliveryRecordPayload {
  return claimed.channel === 'feedback'
    ? { channel: 'feedback', feedback: claimed.item }
    : { channel: 'context', delivery: claimed.item };
}

/** 按 id claim 时必须知道 role（id 只在 role 目录下唯一） */
function requireRoleId(input: { role_id?: string | undefined }): string {
  if (!input.role_id) {
    throw new Error('Claiming a specific delivery requires role_id.');
  }
  return input.role_id;
}

function emptyDeliveryStatusCounts(): DeliveryStatusCounts {
  return { pending: 0, processing: 0, processed: 0, dead_letter: 0 };
}

function countDeliveryStatus(
  records: ReadonlyArray<{ status: DeliveryStatus }>,
): DeliveryStatusCounts {
  const counts = emptyDeliveryStatusCounts();
  for (const record of records) {
    counts[record.status] += 1;
  }
  return counts;
}
