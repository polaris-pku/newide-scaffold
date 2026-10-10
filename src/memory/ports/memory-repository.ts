/**
 * MemoryRepository 持久化端口
 *
 * 定义 Agent 结构化记忆数据的读写契约：Persona、Skills、Experiences、
 * 指标等。Buffer 队列见 BufferRepository。实现见 InMemoryRepository、PgMemoryRepository。
 */
import type {
  AgentArchiveRecord,
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
 * 技能市场检索参数（仅市场池召回）。
 *
 * 与 MemoryVectorSearchOptions 的区别：检索范围限定在市场池
 * （MARKET_POOL_ROLE_ID = __market__）内的技能——只有退休/迁入市场池的
 * 技能可被检索到，未退休 Agent 的技能不可被检索。
 * 资格过滤与 searchSkills 一致（review_status=approved 且 market_status≠superseded）。
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

/** saveSkillIfAbsent 的结果：实际存储的 Skill 与「本次是否新建」 */
export interface SkillSaveResult {
  /** 仓库里最终生效的那条 Skill（命中已有条目时是已有那条） */
  skill: SkillRecord;
  /** true = 本次新建；false = 幂等命中（同 (role_id, promoted_from) 已有条目） */
  created: boolean;
}

/** saveExperienceIfAbsent 的结果：实际存储的 Experience 与「本次是否新建」 */
export interface ExperienceSaveResult {
  /** 仓库里最终生效的那条 Experience（命中已有条目时是已有那条） */
  experience: ExperienceRecord;
  /** true = 本次新建（计数已加）；false = 幂等命中（同 id 已有条目，什么都没改） */
  created: boolean;
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

  /**
   * 写入退休归档（finalize 阶段调用）。在删除 Agent 实体前调用，保证删除后
   * 仍有最小字段可追溯。实现须幂等（同 role_id 重复写入覆盖）。
   */
  archiveAgent(roleId: string, archive: AgentArchiveRecord): Promise<void>;

  /**
   * 读取退休归档；不存在返回 null。供 retireAgent 幂等返回 / deleteAgent
   * 判定"已归档即已退休删除"使用。
   */
  getAgentArchive(roleId: string): Promise<AgentArchiveRecord | null>;

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
   * 技能市场检索：仅检索市场池（__market__）内的技能（Spec §6.2 skill.market_search）。
   *
   * 过滤规则与 searchSkills 一致（approved 且非 superseded），但检索范围仅限
   * 市场池——未退休/未迁入市场池的 Agent 技能不可被检索到。
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
  /**
   * 幂等保存一条**从 Buffer 提取而来**的经验：以 `Experience.id` 为唯一键。
   *
   * 提取落库的粒度是整条 Buffer（第 N 条保存失败就得整条重试），而**两个独立的 Memory
   * Maintenance worker 可以同时处理同一个 `(role_id, buffer_seq)`**——稳定 id 只解决了
   * 「顺序重试写重了」，解决不了「并发重入」：两个 worker 各自 list 一遍都看不到对方那条，
   * 于是各写一次，内存实现攒出重复 id，PG 实现撞主键把一个 worker 打成异常。
   *
   * 所以「查有没有 + 写进去」必须在存储层原子完成，调用方拿不到冲突异常：
   *
   * - 同 id 已存在：不新建、不计数（`experience_count` 与 `owned_exps` 都不动），
   *   返回仓库里已有的那一条（并发下返回的可能就是对手刚写进去的）；
   * - 同 id 不存在：按普通保存写入，计数加一。
   *
   * PG 用主键 + `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id`；内存实现让
   * 「最后一次同步检查 + push」之间没有 await。`agent_id` 的归属权威仍是调用方传入的
   * `role_id`（提取路径由 persistExtractedExperiences 定死），本方法不改写它。
   *
   * **聚合根一致**：经验落库与 Agent 聚合根（`experience_count` / `owned_exps` /
   * `metrics.experience_count`）的推进必须在同一事务内、且以数据库侧的原子增量为准，
   * 不能「先 getAgent/getMetrics 读出来、在内存副本上 +1、再整份 JSON 覆盖回去」。
   * 不同 id 的并发写入是这条约束的关键场景：逐条读改写会让后写的一方用旧快照覆盖先写的
   * 一方，留下「库里有 N 条、聚合根只记 1 条」的漂移。
   */
  saveExperienceIfAbsent(
    role_id: string,
    experience: ExperienceRecord,
  ): Promise<ExperienceSaveResult>;
  /** 持久化一条技能记录 */
  saveSkill(role_id: string, skill: SkillRecord): Promise<void>;
  /**
   * 幂等保存一条**由经验晋升而来**的技能：以 `(role_id, promoted_from)` 为唯一键。
   *
   * 晋升是两步写（先存 Skill、再把 Experience 的 promoted_to 指过去），第二步失败后重试
   * 会再次存 Skill。没有幂等键就会攒出成对的重复技能，且 Experience 的 promoted_to 只能
   * 指向其中一个，另一个变成没有任何来源的孤儿。实现必须让「查 + 写」是原子的（PG 用唯一
   * 约束 + ON CONFLICT，内存实现用无 await 间隔的同键检查），并发调用也只产生一条技能。
   *
   * `promoted_from` 为空（市场导入等）时退化为普通保存。
   *
   * **聚合根一致**：技能落库与 Agent 聚合根（`skill_count` / `owned_skills` /
   * `metrics.skill_count` / `metrics.promoted_skill_count`）的推进必须在同一事务内、且以
   * 数据库侧的原子增量为准。来源**不同**的并发晋升是这条约束的关键场景：逐条读改写会让
   * 后写的一方用旧快照覆盖先写的一方，留下「库里有 N 条技能、聚合根只记 1 条」的漂移。
   * 计数只在真正新建时递增，幂等命中不重复计数。
   */
  saveSkillIfAbsent(role_id: string, skill: SkillRecord): Promise<SkillSaveResult>;
  /** 覆盖写入当前 Persona 快照（如 Persona 演化后 version+1） */
  savePersona(role_id: string, persona: PersonaDef): Promise<void>;
  /** 更新已有技能（如消融实验 auto-approve） */
  updateSkill(role_id: string, skill: SkillRecord): Promise<void>;
  /** 更新已有经验（如晋升后写入 promoted_to） */
  updateExperience(role_id: string, experience: ExperienceRecord): Promise<void>;

  /**
   * 直写技能向量（memory.reindex 全量重建索引用）。
   *
   * 与 updateSkill 的区别：不做 withDescriptionEmbedding 守卫，按传入向量原样
   * 落库（含载荷 JSON 内的 description_embedding 字段同步），避免重建索引时被
   * 旧 provider 二次 embed。记录不存在时抛错。
   */
  updateSkillEmbedding(role_id: string, skill_id: string, embedding: number[]): Promise<void>;

  /** 直写经验向量（同 updateSkillEmbedding）。 */
  updateExperienceEmbedding(
    role_id: string,
    experience_id: string,
    embedding: number[],
  ): Promise<void>;

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
