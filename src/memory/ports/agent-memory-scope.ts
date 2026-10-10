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
import type { PendingBufferRead, SaveBufferResult } from './buffer-repository';
import type { MemoryVectorSearchOptions, SkillSaveResult, ExperienceSaveResult } from './memory-repository';

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
  getPendingBuffer(seq: number): Promise<PendingBufferRead | undefined>;
  markBufferProcessed(seq: number): Promise<void>;
  markBufferDeadLetter(seq: number): Promise<void>;

  saveExperience(experience: ExperienceRecord): Promise<void>;
  /**
   * 幂等保存一条由 Buffer 提取而来的经验（唯一键 `Experience.id`）。
   *
   * 两个独立 worker 可能同时处理同一个 `(role_id, buffer_seq)`，检查与写入必须原子、
   * 命中也只是返回已有那条而不是抛冲突。详见 MemoryRepository.saveExperienceIfAbsent。
   */
  saveExperienceIfAbsent(experience: ExperienceRecord): Promise<ExperienceSaveResult>;
  saveSkill(skill: SkillRecord): Promise<void>;
  /**
   * 幂等保存一条由经验晋升而来的技能（唯一键 `(role_id, promoted_from)`）。
   *
   * 晋升是「先存 Skill → 再回写 Experience.promoted_to」两步；第二步失败后重试会再次
   * 调用保存。没有幂等键就会攒出成对的重复技能。实现必须让检查与写入是原子的，并发
   * 调用也只产生一条技能。详见 MemoryRepository.saveSkillIfAbsent。
   */
  saveSkillIfAbsent(skill: SkillRecord): Promise<SkillSaveResult>;
  /** 覆盖写入当前 Persona 快照（如 Persona 演化后 version+1） */
  savePersona(persona: PersonaDef): Promise<void>;
  updateSkill(skill: SkillRecord): Promise<void>;
  updateExperience(experience: ExperienceRecord): Promise<void>;
}
