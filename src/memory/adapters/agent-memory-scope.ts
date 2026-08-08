/**
 * AgentMemoryScope 适配器
 *
 * 将 MemoryRepository 与 BufferRepository 组合为绑定 role_id 的作用域对象；
 * 由 AgentManager.createAgent 为每个 Agent 创建独立实例。
 */
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { BufferRepository } from '../ports/buffer-repository';
import type { MemoryRepository, MemoryVectorSearchOptions } from '../ports/memory-repository';
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
import type { SaveBufferResult } from '../ports/buffer-repository';

class ScopedAgentMemory implements AgentMemoryScope {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly buffer: BufferRepository,
    readonly role_id: string,
  ) {}

  getAgent(): Promise<AgentHandle> {
    return this.repository.getAgent(this.role_id);
  }

  getPersona(): Promise<PersonaDef> {
    return this.repository.getPersona(this.role_id);
  }

  getMetrics(): Promise<AgentMetrics> {
    return this.repository.getMetrics(this.role_id);
  }

  listSkills(): Promise<SkillRecord[]> {
    return this.repository.listSkills(this.role_id);
  }

  listExperiences(): Promise<ExperienceRecord[]> {
    return this.repository.listExperiences(this.role_id);
  }

  searchSkills(options: MemoryVectorSearchOptions): Promise<SkillRecord[]> {
    return this.repository.searchSkills(this.role_id, options);
  }

  searchExperiences(options: MemoryVectorSearchOptions): Promise<ExperienceRecord[]> {
    return this.repository.searchExperiences(this.role_id, options);
  }

  saveBufferSnapshot(
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<SaveBufferResult> {
    return this.buffer.saveBufferSnapshot(this.role_id, snapshot, agentContext);
  }

  getBufferMeta(): Promise<BufferMeta> {
    return this.buffer.getBufferMeta(this.role_id);
  }

  listPendingBufferSeqs(): Promise<number[]> {
    return this.buffer.listPendingBufferSeqs(this.role_id);
  }

  getPendingBuffer(seq: number): Promise<
    | {
        snapshot: BufferSnapshot;
        agentContext?: AgentContextSnapshot;
      }
    | undefined
  > {
    return this.buffer.getPendingBuffer(this.role_id, seq);
  }

  markBufferProcessed(seq: number): Promise<void> {
    return this.buffer.markBufferProcessed(this.role_id, seq);
  }

  markBufferDeadLetter(seq: number): Promise<void> {
    return this.buffer.markBufferDeadLetter(this.role_id, seq);
  }

  saveExperience(experience: ExperienceRecord): Promise<void> {
    return this.repository.saveExperience(this.role_id, experience);
  }

  saveSkill(skill: SkillRecord): Promise<void> {
    return this.repository.saveSkill(this.role_id, skill);
  }

  savePersona(persona: PersonaDef): Promise<void> {
    return this.repository.savePersona(this.role_id, persona);
  }

  updateSkill(skill: SkillRecord): Promise<void> {
    return this.repository.updateSkill(this.role_id, skill);
  }

  updateExperience(experience: ExperienceRecord): Promise<void> {
    return this.repository.updateExperience(this.role_id, experience);
  }
}

export function createAgentMemoryScope(
  repository: MemoryRepository,
  buffer: BufferRepository,
  role_id: string,
): AgentMemoryScope {
  return new ScopedAgentMemory(repository, buffer, role_id);
}
