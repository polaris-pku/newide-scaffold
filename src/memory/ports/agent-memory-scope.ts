/**
 * AgentMemoryScope 端口
 *
 * 单个 Agent 绑定 role_id 的记忆读写面；Agent 通过此接口访问自己的数据，
 * 无需每次传入 role_id。由 adapters/agent-memory-scope.ts 组合 MemoryRepository 与 BufferRepository。
 */
import type {
  AgentHandle,
  AgentMetrics,
  BufferMeta,
  BufferSnapshot,
  AgentContextSnapshot,
  ExperienceRecord,
  PersonaDef,
  SkillRecord,
} from '../schemas';
import type { SaveBufferResult } from './buffer-repository';
import type { MemoryVectorSearchOptions } from './memory-repository';

export interface AgentMemoryScope {
  readonly role_id: string;

  getAgent(): Promise<AgentHandle>;
  getPersona(): Promise<PersonaDef>;
  getMetrics(): Promise<AgentMetrics>;
  listSkills(): Promise<SkillRecord[]>;
  listExperiences(): Promise<ExperienceRecord[]>;
  searchSkills(options: MemoryVectorSearchOptions): Promise<SkillRecord[]>;
  searchExperiences(options: MemoryVectorSearchOptions): Promise<ExperienceRecord[]>;

  saveBufferSnapshot(
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<SaveBufferResult>;
  getBufferMeta(): Promise<BufferMeta>;
  listPendingBufferSeqs(): Promise<number[]>;
  getPendingBuffer(seq: number): Promise<
    | {
        snapshot: BufferSnapshot;
        agentContext?: AgentContextSnapshot;
      }
    | undefined
  >;
  markBufferProcessed(seq: number): Promise<void>;
  markBufferDeadLetter(seq: number): Promise<void>;

  saveExperience(experience: ExperienceRecord): Promise<void>;
  saveSkill(skill: SkillRecord): Promise<void>;
  updateSkill(skill: SkillRecord): Promise<void>;
  updateExperience(experience: ExperienceRecord): Promise<void>;
}
