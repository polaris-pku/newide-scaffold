import {
  type AgentBoardAgentView,
  type AgentBoardListItem,
  type ExperienceView,
  type SkillView,
} from '../memory';
import type { BMemoryMaintenanceEvidence } from './b-memory-maintenance-runner';
import type { BPublicCapabilities } from './b-public-capabilities';
import { filterLegacyCouncilPseudoAgents } from './council-legacy-agent-filter';

export class BMemoryBackendService {
  constructor(
    private readonly capabilities: Pick<BPublicCapabilities, 'boardQuery' | 'maintenance'>,
  ) {}

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
