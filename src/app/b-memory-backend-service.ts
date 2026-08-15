import {
  type AgentBoardAgentView,
  type AgentBoardListItem,
  type EmbeddingProvider,
  type ExperienceView,
  type MarketImportResult,
  marketImport,
  type MarketSearchQuery,
  marketSearch,
  type MemoryRepository,
  type RetireOptions,
  type RetireResult,
  type SkillView,
} from '../memory';
import type { SkillRecord } from '../memory/schemas';
import type { BMemoryMaintenanceEvidence } from './b-memory-maintenance-runner';
import type { BPublicCapabilities } from './b-public-capabilities';
import { filterLegacyCouncilPseudoAgents } from './council-legacy-agent-filter';
import type { BEmbeddingRuntimeInfo } from './production-b-runtime';

export interface BMemoryOperationCapability {
  status: 'available' | 'unavailable';
  reason?: string;
}

export interface BMemoryCapabilities {
  schema_version: 'newide.b-memory-capabilities.v1';
  embedding: BEmbeddingRuntimeInfo;
  operations: {
    list_agents: BMemoryOperationCapability;
    get_agent_persona: BMemoryOperationCapability;
    list_experiences: BMemoryOperationCapability;
    list_skills: BMemoryOperationCapability;
    list_maintenance: BMemoryOperationCapability;
    promote_skills: BMemoryOperationCapability;
    approve_skill: BMemoryOperationCapability;
    reject_skill: BMemoryOperationCapability;
    update_persona: BMemoryOperationCapability;
    market_search: BMemoryOperationCapability;
    market_import: BMemoryOperationCapability;
    retire_agent: BMemoryOperationCapability;
  };
}

/**
 * Agent 退休生命周期端口。生产实现由 DriverRuntimeAgentExecutionFacade
 * 提供（→ AgentManager.retireAgent）；测试可注入真 AgentManager。
 */
export interface BMemoryLifecycle {
  retireAgent(roleId: string, options: RetireOptions): Promise<RetireResult>;
}

export class BMemoryBackendService {
  constructor(
    private readonly capabilities: Pick<BPublicCapabilities, 'boardQuery' | 'maintenance'>,
    private readonly embeddingInfo: BEmbeddingRuntimeInfo,
    // 以下三个为可选注入：不注入时对应能力在 getCapabilities() 里报告 unavailable，
    // 调用对应方法时抛出明确错误。保持与旧的两参构造签名向后兼容。
    private readonly repository?: MemoryRepository,
    private readonly lifecycle?: BMemoryLifecycle,
    private readonly embedding?: EmbeddingProvider,
  ) {}

  getCapabilities(): BMemoryCapabilities {
    return {
      schema_version: 'newide.b-memory-capabilities.v1',
      embedding: { ...this.embeddingInfo },
      operations: {
        list_agents: { status: 'available' },
        get_agent_persona: { status: 'available' },
        list_experiences: { status: 'available' },
        list_skills: { status: 'available' },
        list_maintenance: { status: 'available' },
        promote_skills: {
          status: 'available',
          reason: 'Promotion creates pending Skills; it does not approve them.',
        },
        approve_skill: {
          status: 'unavailable',
          reason: 'B does not expose a public Skill approval transition.',
        },
        reject_skill: {
          status: 'unavailable',
          reason: 'B does not expose a public Skill rejection transition.',
        },
        update_persona: {
          status: 'unavailable',
          reason: 'B does not expose a public Persona update transition.',
        },
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
      },
    };
  }

  async listAgents(): Promise<AgentBoardListItem[]> {
    return filterLegacyCouncilPseudoAgents(
      await this.capabilities.boardQuery.listAgents(),
    );
  }

  getAgent(roleId: string): Promise<AgentBoardAgentView> {
    return this.capabilities.boardQuery.getAgent(roleId);
  }

  listSkills(roleId: string): Promise<SkillView[]> {
    return this.capabilities.boardQuery.listSkills(roleId);
  }

  listExperiences(roleId: string): Promise<ExperienceView[]> {
    return this.capabilities.boardQuery.listExperiences(roleId);
  }

  listMaintenance(roleId?: string): Promise<BMemoryMaintenanceEvidence[]> {
    return this.capabilities.maintenance.listEvidence(roleId);
  }

  promoteSkills(roleId: string, requestedBy: string): Promise<BMemoryMaintenanceEvidence> {
    return this.capabilities.maintenance.promoteSkills({
      role_id: roleId,
      requested_by: requestedBy,
    });
  }

  /** 技能市场检索：query 文本 → embedding → 全库 top-K 召回（Spec §6.2）。 */
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
}
