/**
 * MemoryRepository 持久化端口
 *
 * 定义 Agent 结构化记忆数据的读写契约：Persona、Skills、Experiences、
 * 指标等。Buffer 队列见 BufferRepository。实现见 InMemoryRepository、PgMemoryRepository。
 */
import type {
  AgentHandle,
  AgentMetrics,
  AgentStatus,
  CreateAgentSpec,
  ExperienceRecord,
  MarketStatus,
  PersonaDef,
  RetiredReason,
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

/**
 * 技能市场检索参数（跨 Agent 全库召回）。
 *
 * 与 MemoryVectorSearchOptions 的区别：不限定 role_id，检索范围是全部
 * Agent 的「可市场技能」（review_status=approved 且 market_status≠superseded）。
 */
export interface MarketSearchOptions {
  /** 检索 query 的 embedding 向量 */
  query_embedding: number[];
  /** 返回的最大条目数 */
  top_k: number;
  /** 最低余弦相似度（0~1），低于此值的条目不返回 */
  min_similarity?: number;
  /** 排除的 Agent role_id（通常传入调用方自身，避免推荐自己的技能） */
  exclude_agent_id?: string;
}

/** 技能市场引入结果 */
export interface MarketImportResult {
  /** 引入后的副本 SkillRecord（agent_id = 引入方，id 为新 UUID，imported_from 指向源技能） */
  imported: SkillRecord;
  /** 更新后的源 SkillRecord（imported_by 已追加引入方） */
  source: SkillRecord;
  /** 是否本次新建副本；false 表示幂等命中（该 Agent 已引入过此技能） */
  created: boolean;
}

/** 技能迁移到市场池的选项 */
export interface TransferSkillToMarketOptions {
  /** 迁移后写入的 market_status（不传则沿用原值） */
  market_status?: MarketStatus;
}

export interface MemoryRepository {
  /** 确保 Agent 存在（不存在则用种子数据初始化） */
  ensureAgent(role_id: string): Promise<void>;

  /** 按 spec 注册新 Agent（已存在则抛错） */
  initializeAgent(spec: CreateAgentSpec): Promise<void>;

  /**
   * 更新 Agent 元数据（显示名称 / 标签）。
   *
   * 仅允许更新非生命周期字段；Agent 状态变更走 updateAgentStatus。
   * 实现须同步 AgentHandle 内嵌快照与聚合根一致性。
   */
  updateAgentMeta(
    role_id: string,
    patch: { name?: string; tags?: string[] },
  ): Promise<void>;

  /**
   * 删除 Agent 及其全部持久化记忆（级联）。
   *
   * 调用方负责前置条件（通常仅允许 retired 状态，且 skills 已迁移市场）；
   * 实现须级联删除名下 experiences / skills（Pg 由 ON DELETE CASCADE 保证）
   * 与 Agent 行本身。删除不存在的 Agent 抛错。
   */
  deleteAgent(role_id: string): Promise<void>;

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

  /**
   * 技能市场检索：跨 Agent 全库范围检索「可市场技能」（Spec §6.2 skill.market_search）。
   *
   * 过滤规则与 searchSkills 一致（approved 且非 superseded），但不受单个
   * Agent 作用域限制；支持排除调用方自身。
   */
  marketSearchSkills(options: MarketSearchOptions): Promise<SkillRecord[]>;

  /**
   * 技能市场引入：将一条市场技能克隆为引入方副本（Spec §6.2 skill.market_import）。
   *
   * 副作用（实现须保证原子性）：
   *   1. 副本存入引入方（新 UUID，agent_id=引入方，imported_from=源技能 id）
   *   2. 源技能 imported_by 追加引入方 role_id（retirement 决策树依赖该字段）
   *   3. 引入方 AgentMetrics.imported_skill_count++（且 skill_count++）
   */
  marketImportSkill(role_id: string, source_skill_id: string): Promise<MarketImportResult>;

  /**
   * 将一条技能迁移到市场池（固定 MARKET_POOL_ROLE_ID 名下）。
   *
   * 退休资产处置时调用：把保留技能从退休 Agent 名下迁移到市场池，使技能
   * 始终有归属（满足 Pg FK），退休 Agent 之后可安全归档。
   *
   * 副作用（实现须保证原子性）：
   *   1. 技能 agent_id / role_id 改为 MARKET_POOL_ROLE_ID，id 不变
   *      （imported_from 等溯源链接不失效）
   *   2. 首次调用自动初始化市场池 Agent
   *   3. 源 Agent 与市场池的 handle/metrics 计数同步增减
   *   4. origin_agent_id 记录原创建者（若尚未记录）
   */
  transferSkillToMarket(
    fromRoleId: string,
    skillId: string,
    options?: TransferSkillToMarketOptions,
  ): Promise<SkillRecord>;

  /** 持久化一条经验记录 */
  saveExperience(role_id: string, experience: ExperienceRecord): Promise<void>;
  /** 持久化一条技能记录 */
  saveSkill(role_id: string, skill: SkillRecord): Promise<void>;
  /** 覆盖写入当前 Persona 快照（如 Persona 演化后 version+1） */
  savePersona(role_id: string, persona: PersonaDef): Promise<void>;
  /** 更新已有技能（如消融实验 auto-approve） */
  updateSkill(role_id: string, skill: SkillRecord): Promise<void>;
  /** 更新已有经验（如晋升后写入 promoted_to） */
  updateExperience(role_id: string, experience: ExperienceRecord): Promise<void>;
  /** 删除一条技能（如退休时资产处置丢弃 rejected Skill） */
  deleteSkill(role_id: string, skill_id: string): Promise<void>;
  /** 删除一条经验（如退休时资产处置丢弃低置信度 Experience） */
  deleteExperience(role_id: string, experience_id: string): Promise<void>;

  /**
   * 原子更新 AgentMetrics。
   *
   * 采用函数式 updater：read-modify-write 由存储层保证，调用方只需描述增量。
   * 实现必须同步 AgentHandle.metric 内嵌快照，保持聚合根一致。
   */
  updateMetrics(
    role_id: string,
    update: (current: AgentMetrics) => AgentMetrics,
  ): Promise<void>;

  /**
   * 迁移 Agent 生命周期状态（created → active/idle → draining → retired）。
   *
   * @param options.retired_at    置 retired 时写入退休时间
   * @param options.retired_reason 置 retired 时写入退休原因
   */
  updateAgentStatus(
    role_id: string,
    status: AgentStatus,
    options?: { retired_at?: string; retired_reason?: RetiredReason },
  ): Promise<void>;
}
