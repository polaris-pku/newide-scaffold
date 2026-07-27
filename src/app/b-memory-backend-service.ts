import {
  type AgentBoardAgentView,
  type AgentBoardListItem,
  type ExperienceView,
  type SkillView,
} from '../memory';
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
  };
}

export class BMemoryBackendService {
  constructor(
    private readonly capabilities: Pick<BPublicCapabilities, 'boardQuery' | 'maintenance'>,
    private readonly embeddingInfo: BEmbeddingRuntimeInfo,
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
}
