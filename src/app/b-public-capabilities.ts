import {
  RepositoryAgentBoardQuery,
  reviewSkill,
  type AgentBoardQuery,
  type BufferRepository,
  type MemoryRepository,
  type ReviewSkillInput,
} from '../memory';
import type {
  BMemoryMaintenanceEvidence,
  BMemoryMaintenancePort,
  BSkillPromotionRequest,
} from './b-memory-maintenance-runner';
import type { BackendBRuntime } from './production-b-runtime';

export type ReviewedSkill = Awaited<ReturnType<typeof reviewSkill>>;

export interface BMemoryMaintenanceCapabilities extends BMemoryMaintenancePort {
  listEvidence(roleId?: string): Promise<BMemoryMaintenanceEvidence[]>;
  promoteSkills(input: BSkillPromotionRequest): Promise<BMemoryMaintenanceEvidence>;
}

/**
 * 主线应用层消费 B 模块的唯一能力集合。
 *
 * B 的实现仍由 src/memory/index.ts 暴露；这里仅负责把生产 runtime、
 * Agent Board 查询和应用层维护操作组合为稳定依赖。
 */
export interface BPublicCapabilities {
  readonly repository: MemoryRepository;
  readonly bufferRepository: BufferRepository;
  readonly boardQuery: AgentBoardQuery;
  readonly maintenance: BMemoryMaintenanceCapabilities;
  reviewSkill(input: ReviewSkillInput): Promise<ReviewedSkill>;
}

export function createBPublicCapabilities(
  runtime: BackendBRuntime,
  maintenance: BMemoryMaintenanceCapabilities,
): BPublicCapabilities {
  return {
    repository: runtime.repository,
    bufferRepository: runtime.bufferRepository,
    boardQuery: new RepositoryAgentBoardQuery(runtime.repository),
    maintenance,
    reviewSkill: (input) => reviewSkill(runtime.repository, input),
  };
}
