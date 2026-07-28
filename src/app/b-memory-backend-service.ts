import {
  RepositoryAgentBoardQuery,
  type AgentBoardAgentView,
  type AgentBoardListItem,
  type ExperienceView,
  type MemoryRepository,
  type SkillView,
} from '../memory';
import type {
  BMemoryMaintenanceEvidence,
  BMemoryMaintenanceRunner,
} from './b-memory-maintenance-runner';

export class BMemoryBackendService {
  private readonly board: RepositoryAgentBoardQuery;

  constructor(
    repository: MemoryRepository,
    private readonly maintenance: BMemoryMaintenanceRunner,
  ) {
    this.board = new RepositoryAgentBoardQuery(repository);
  }

  listAgents(): Promise<AgentBoardListItem[]> {
    return this.board.listAgents();
  }

  getAgent(roleId: string): Promise<AgentBoardAgentView> {
    return this.board.getAgent(roleId);
  }

  listSkills(roleId: string): Promise<SkillView[]> {
    return this.board.listSkills(roleId);
  }

  listExperiences(roleId: string): Promise<ExperienceView[]> {
    return this.board.listExperiences(roleId);
  }

  listMaintenance(roleId?: string): Promise<BMemoryMaintenanceEvidence[]> {
    return this.maintenance.listEvidence(roleId);
  }

  promoteSkills(roleId: string, requestedBy: string): Promise<BMemoryMaintenanceEvidence> {
    return this.maintenance.promoteSkills({ role_id: roleId, requested_by: requestedBy });
  }
}
