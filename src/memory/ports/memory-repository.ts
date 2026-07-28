/**
 * MemoryRepository 持久化端口
 *
 * 定义 Agent 结构化记忆数据的读写契约：Persona、Skills、Experiences、
 * 指标等。Buffer 队列见 BufferRepository。实现见 InMemoryRepository、PgMemoryRepository。
 */
import type {
  AgentHandle,
  AgentMetrics,
  CreateAgentSpec,
  ExperienceRecord,
  PersonaDef,
  SkillRecord,
} from '../schemas';

/** 向量检索参数（索引层 top-K 召回） */
export interface MemoryVectorSearchOptions {
  /** 任务 query 的 embedding 向量 */
  query_embedding: number[];
  /** 返回的最大条目数 */
  top_k: number;
  /** 最低余弦相似度（0~1），低于此值的条目不返回 */
  min_similarity?: number;
  /** 经验最低置信度（仅 searchExperiences 使用，默认 0.2） */
  min_confidence?: number;
}

export interface MemoryRepository {
  /** 确保 Agent 存在（不存在则用种子数据初始化） */
  ensureAgent(role_id: string): Promise<void>;

  /** 按 spec 注册新 Agent（已存在则抛错） */
  initializeAgent(spec: CreateAgentSpec): Promise<void>;

  /** 列出所有已注册的 Agent role_id */
  listAgentIds(): Promise<string[]>;

  /** 获取 Agent 聚合根 */
  getAgent(role_id: string): Promise<AgentHandle>;
  /** 获取当前 Persona 快照 */
  getPersona(role_id: string): Promise<PersonaDef>;
  /** 获取原始指标 */
  getMetrics(role_id: string): Promise<AgentMetrics>;
  /** 列出所有技能 */
  listSkills(role_id: string): Promise<SkillRecord[]>;
  /** 列出所有经验 */
  listExperiences(role_id: string): Promise<ExperienceRecord[]>;

  /** 按 query_embedding 余弦相似度检索技能（top-K，含资格过滤） */
  searchSkills(role_id: string, options: MemoryVectorSearchOptions): Promise<SkillRecord[]>;

  /** 按 query_embedding 余弦相似度检索经验（top-K，含资格过滤与 confidence 门槛） */
  searchExperiences(
    role_id: string,
    options: MemoryVectorSearchOptions,
  ): Promise<ExperienceRecord[]>;

  /** 持久化一条经验记录 */
  saveExperience(role_id: string, experience: ExperienceRecord): Promise<void>;
  /** 持久化一条技能记录 */
  saveSkill(role_id: string, skill: SkillRecord): Promise<void>;
  /** 更新已有技能（如消融实验 auto-approve） */
  updateSkill(role_id: string, skill: SkillRecord): Promise<void>;
  /** 更新已有经验（如晋升后写入 promoted_to） */
  updateExperience(role_id: string, experience: ExperienceRecord): Promise<void>;
}
