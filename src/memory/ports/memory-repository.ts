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
  DriverFeedbackSource,
  Effectiveness,
  ExperienceRecord,
  MarketStatus,
  PersonaDef,
  PersonaEvolutionMarker,
  PersonaEvolutionOutcome,
  PromotionOutcome,
  RetiredReason,
  SkillRecord,
} from '../schemas';
import type { DeliveryRetryPolicy } from '../services/delivery-lifecycle';
import type {
  PersonaEvolutionApprovalMode,
  PersonaEvolutionInputSnapshot,
} from './persona-evolution-strategy';
import type { PromotionApprovalMode } from './promotion-strategy';

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

/**
 * 一条 Driver 使用反馈对某条经验的应用请求。
 *
 * `feedback_id` 是幂等键：同一条反馈重复应用只生效一次。其余字段是回写所需的全部事实，
 * 由反馈记录原样带过来（不在这里重新解读效果档位）。
 */
export interface ExperienceFeedbackApplication {
  /** 幂等键：反馈的唯一标识（outbox 与待归并队列共用同一个 id） */
  feedback_id: string;
  /** 被引用的经验；不存在时什么也不写，由调用方决定是等待还是放弃 */
  experience_id: string;
  /** 本次任务是否实际应用了该经验 */
  applied: boolean;
  /** 该经验在本次任务中的效果 */
  effectiveness: Effectiveness;
  /** 备注原文 */
  note: string;
  /** 观察到该使用事实的时刻 */
  observed_at: string;
  /** 反馈来源（写进置信度历史的 reason，用于区分 Driver 自报与用户评分） */
  feedback_source: DriverFeedbackSource;
}

/** 一次反馈应用的去向：写了 / 早就写过 / 目标经验还不存在 */
export type ExperienceFeedbackOutcome = 'applied' | 'already_applied' | 'experience_missing';

export interface ExperienceFeedbackResult {
  outcome: ExperienceFeedbackOutcome;
  /** 应用之后仓库里的那条经验；`experience_missing` 时缺席 */
  experience?: ExperienceRecord;
}

// ── 技能晋升的状态面（Phase 3） ──────────────────────────────────────
//
// Skill Promotion Job 需要四种当前端口表达不了的**原子**操作：扫候选、claim 一条候选、
// 落一条结论、落一次失败/回收。它们全部作用在经验自己身上（晋升标记是 Experience 的
// 可选字段，见 schemas.ts 的 ExperiencePromotionSchema），因此**不需要**第二套存储或第二套
// 状态机：claim/lease/retry 的转移规则仍是 services/delivery-lifecycle.ts 里那一套，
// 「谁算候选」是 services/promotion-candidates.ts 里那一份纯规则。
//
// 为什么不能拿 listExperiences + updateExperience 自己拼：读—判断—写之间隔着 await，
// 两个 worker 会各自读到同一条未评估的经验、各自通过判断、各自写回——同一条经验被评估两次，
// 而且后写的一方会把先写的那份结论盖掉。判断与写入必须在存储层的同一个临界区里完成
// （与 saveExperienceIfAbsent / applyExperienceFeedback 同一条理由）。

/**
 * 扫候选的过滤条件。
 *
 * `strategy_version` 与 `approval` 是**语义**参数而不是优化参数：同一条判过的经验要不要
 * 重评，取决于「策略换版本了没有」与「人工审核是否已放宽为自动批准」。少了它们，扫出来的
 * 候选集合会与 promotion-candidates 的规则不一致。
 */
export interface PromotionCandidateQuery {
  /** 只扫该 role 的经验；缺省跨全部 Agent（市场池除外） */
  role_id?: string;
  /** 参考时刻（注入时钟） */
  now: string;
  /** 当前生效的策略版本 */
  strategy_version: string;
  /** 本次运行的审核模式 */
  approval: PromotionApprovalMode;
  /** 重试预算；缺省用 DEFAULT_PROMOTION_RETRY_POLICY */
  policy?: DeliveryRetryPolicy;
  /** 最多返回多少条（按「先来的先处理」取前 N 条） */
  limit?: number;
}

/** claim 一条候选：谁持有、持有多久、以什么时刻为准 */
export interface PromotionClaimRequest {
  /** 只在该 role 里找候选；缺省跨全部 Agent */
  role_id?: string;
  /** 消费者标识（下游自己给；本仓只做持有者比对，不解释它的含义） */
  owner: string;
  /** 参考时刻（注入时钟） */
  now: string;
  /** 租约时长（毫秒） */
  lease_ms: number;
  /** 当前生效的策略版本（决定判过的候选要不要先重置） */
  strategy_version: string;
  /** 本次运行的审核模式 */
  approval: PromotionApprovalMode;
  /** 重试预算；缺省用 DEFAULT_PROMOTION_RETRY_POLICY */
  policy?: DeliveryRetryPolicy;
}

/**
 * claim 到的一条候选。
 *
 * `claim_token` 必须原样带回 complete/fail —— 它是这次持有的凭据，租约过期后被别人拿走的
 * 候选，旧持有者拿着旧 token 再也写不进去（fencing 与交付通道同源，见 schemas.ts 的
 * lifecycleRecordFields）。
 */
export interface ClaimedPromotionCandidate {
  /** 这条经验属于哪个 Agent（写回时要按它定位） */
  role_id: string;
  /** claim 之后的经验（`promotion` 已是 processing，带 lease 与 token） */
  experience: ExperienceRecord;
  /** 本次 claim 的 fencing token */
  claim_token: string;
  /** claim 时的投递次数（已经 +1） */
  attempt_count: number;
}

/**
 * 落一条结论：processing → processed。
 *
 * `outcome === 'promoted'` 时必须给出 `skill_id`，且实现要**同一次原子写入**里把
 * `promoted_to` 也指过去——「Skill 已写入、经验还指向空」的中间态一旦能被读到，就会有人
 * 把它当成「这条没晋升过」再晋升一次（虽有唯一键兜底，但审计上多出一轮无谓的处理）。
 * 反过来 `outcome !== 'promoted'` 时不得写 `promoted_to`。
 *
 * token 不匹配、租约已过期、候选已被别人接手 → 返回 undefined（本次没写任何东西）。
 */
export interface PromotionCompletionRequest {
  role_id: string;
  experience_id: string;
  /** claim 时发下的 token；不匹配就什么都写不进去 */
  claim_token: string;
  /** 可选的交叉核对：传了就必须与记录上的 claim_owner 一致 */
  owner?: string;
  outcome: PromotionOutcome;
  /** 做出这个结论的策略版本 */
  strategy_version: string;
  /** 结论的人读理由 */
  reasons?: string[];
  /** 晋升出的 Skill id；`outcome === 'promoted'` 时必填，其余结论**不接受**（传了也不落） */
  skill_id?: string;
  /** 参考时刻（注入时钟） */
  now: string;
}

/**
 * 落一次失败：可重试则退避后回 pending，不可重试或已用满次数则进 dead_letter。
 *
 * `retryable` 由调用方判断（见 services/delivery-error-classification）：存储抖动可重试，
 * 坏数据与配置永久错不可重试。token 不匹配 → 返回 undefined。
 */
export interface PromotionFailureRequest {
  role_id: string;
  experience_id: string;
  claim_token: string;
  owner?: string;
  error: string;
  retryable: boolean;
  now: string;
  /** 重试预算；缺省用 DEFAULT_PROMOTION_RETRY_POLICY */
  policy?: DeliveryRetryPolicy;
}

/** 启动恢复：把租约过期仍停在 processing 的候选放回队列 */
export interface PromotionRestoreOptions {
  /** 只恢复该 role；缺省跨全部 Agent */
  role_id?: string;
  now: string;
  /** 重试预算；缺省用 DEFAULT_PROMOTION_RETRY_POLICY */
  policy?: DeliveryRetryPolicy;
}

// ── Persona 演化的状态面（Phase 4-B） ────────────────────────────────
//
// 与晋升（经验上的一个标记）同一套骨架，只有一处结构差异：**候选是「角色」而不是「行」**。
// 一个角色同时只有一条演化流，因此状态按 role 持有，claim/lease/fencing 也按 role 生效；
// 而「这条候选此刻该不该动」需要先看清这个角色的输入（已批准技能 + 已落定的经验）——
// 那份输入必须与标记在**同一个临界区**里读出来，否则「同一份输入」这句话就没有依据。
//
// 因此 claim 的入参刻意**不带**输入快照或 hash：适配器自己在临界区里读 Persona、技能、
// 经验，算出快照与 hash，再据此做计划。把 hash 交给调用方算，等于让「判据」与「被判的
// 那份输入」之间开出一个窗口——窗口里落进来的新经验会让人按旧快照判、按新快照记。

/**
 * 一条已 claim 的演化候选。
 *
 * 它同时是「这次判定的全部依据」：判定必须基于 `snapshot`，`parent_version` 取自
 * `persona.version`，写回时把 `claim_token` 与 `parent_version` 原样带回。
 */
export interface ClaimedPersonaEvolutionCandidate {
  role_id: string;
  /** claim 之后的标记（`processing`，带租约与 token） */
  marker: PersonaEvolutionMarker;
  /** 本次 claim 的 fencing token；落结论与落失败都要原样带回 */
  claim_token: string;
  /** claim 时的投递次数（已经 +1） */
  attempt_count: number;
  /** claim 那一刻读到的 Persona —— 父版本的权威读口，也是这次判定的 `parent_version` */
  persona: PersonaDef;
  /** claim 那一刻算出来的输入快照 —— 判定唯一能读到的输入 */
  snapshot: PersonaEvolutionInputSnapshot;
  /** 快照的 hash；幂等键的一半 */
  input_snapshot_hash: string;
}

/** 一次 claim 的入参（输入快照由适配器在临界区里自己算，见上面的说明） */
export interface PersonaEvolutionClaimRequest {
  owner: string;
  now: string;
  lease_ms: number;
  /** 当前生效的策略版本：决定判过的候选要不要重评 */
  strategy_version: string;
  /** 本次运行的审核模式：决定 `pending_review` 要不要被自动批准接起来 */
  approval: PersonaEvolutionApprovalMode;
  /** 只处理该 role；缺省按 `listAgentIds()` 的顺序逐条尝试 */
  role_id?: string;
  /** 重试预算；缺省用 DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY */
  policy?: DeliveryRetryPolicy;
}

/** 落一条结论的入参 */
export interface PersonaEvolutionCompletionRequest {
  role_id: string;
  claim_token: string;
  /** 交叉核对的持有者标识；真正的 fencing 是 claim_token */
  owner?: string;
  /** 判定所依据的父版本：**条件写的前置条件** */
  parent_version: number;
  /** 本次的结论 */
  outcome: PersonaEvolutionOutcome;
  /** 判定用的策略版本；写进标记，也是「要不要重评」的判据 */
  strategy_version: string;
  /** 判定所依据的输入快照；写进标记，也是幂等键的一半 */
  input_snapshot_hash: string;
  /** 产生这次结论的 maintenance run */
  source_run_id: string;
  /** 判定理由（人读） */
  reasons: string[];
  /** 变更摘要（人读）；`evolved` 时应当给 */
  change_summary?: string;
  /** 自动批准时的批准者标识 */
  reviewed_by?: string;
  /**
   * `outcome === 'evolved'` 时必填：这一版的**完整** Persona。
   *
   * 实现要校验 `persona.version === parent_version + 1` 且 `persona.role_id === role_id`：
   * 版本号只能由父版本推出，让调用方自报一个跳版本的值就等于允许它写出一个不属于它的版本。
   */
  persona?: PersonaDef;
  now: string;
}

/**
 * 落一条结论的结果。
 *
 * 三种终局必须分得开，因为它们的处置完全不同：`applied` 是落地了，`claim_lost` 是「这次没
 * 轮到我们」（落盘责任归当前持有者），而 `parent_conflict` 是**判据过期**——别的 worker 或
 * 前端 PATCH 在读到与写回之间改了 Persona，此时绝不能覆盖（那是「不得破坏旧版本」的落点），
 * 但也**不是**永久失败：重投会重新读、重算快照、重判一次。
 */
export type PersonaEvolutionCompletionResult =
  | { kind: 'applied'; marker: PersonaEvolutionMarker; persona?: PersonaDef | undefined }
  | { kind: 'claim_lost' }
  | { kind: 'parent_conflict'; expected_parent_version: number; current_version: number };

/** 落一次失败的入参（退避回队列或进死信） */
export interface PersonaEvolutionFailureRequest {
  role_id: string;
  claim_token: string;
  owner?: string;
  error: string;
  retryable: boolean;
  now: string;
  /** 重试预算；缺省用 DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY */
  policy?: DeliveryRetryPolicy;
}

/** 启动恢复的入参 */
export interface PersonaEvolutionRestoreOptions {
  /** 只恢复该 role；缺省跨全部 Agent */
  role_id?: string;
  now: string;
  /** 重试预算；缺省用 DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY */
  policy?: DeliveryRetryPolicy;
}

/** 恢复出来的一条候选：标记本身不带 role，因此成对返回 */
export interface RestoredPersonaEvolutionClaim {
  role_id: string;
  marker: PersonaEvolutionMarker;
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
  /**
   * 覆盖写入已有技能（如消融实验 auto-approve、人工审核裁决）。
   *
   * 覆盖的是**整条记录**：实现必须让 `promoted_from` 与载荷里的同名字段同步落地。它是晋升
   * 幂等键的一半，也是归属校验（`completePromotion` 的引用判据）读的那个字段——只写载荷会
   * 在库里留下「列说没有来源、载荷说是某条经验」的分裂状态，于是按列读的 PG 与按载荷读的
   * 内存实现对同一条引用给出两种结论。
   *
   * `promoted_from` 改出来若与同 role 的另一条技能撞车，写入必须**整体失败**：技能记录停在
   * 改之前，不得留下半截状态（PG 由 `(role_id, promoted_from)` 的部分唯一索引保证）。
   */
  updateSkill(role_id: string, skill: SkillRecord): Promise<void>;
  /** 更新已有经验（如晋升后写入 promoted_to） */
  updateExperience(role_id: string, experience: ExperienceRecord): Promise<void>;

  /**
   * 把一条 Driver 使用反馈**原子且幂等**地应用到一条经验上。
   *
   * 这是反馈消费与归并的唯一写入路径。它必须由存储层保证两件事，调用方无法用
   * `listExperiences` + `updateExperience` 自行拼出来：
   *
   * 1. **幂等**：同一 `feedback_id` 重复应用只生效一次。判据写在经验自己的置信度历史里
   *    （`ConfidenceHistoryEntry.feedback_id`），因此崩溃后重跑、lease 过期被别的 worker
   *    接手重跑，都只会得到 `already_applied`，不会第二次调整置信度、也不会第二次累加引用数。
   * 2. **原子**：判重与写入之间没有窗口。两个 worker 同时应用同一条反馈时，只有一个写进去；
   *    同时应用**两条不同**反馈到同一条经验时，也不该有一方用旧快照覆盖另一方（实现用
   *    CAS / 临界区，而不是「读出来、改一份内存副本、整份覆盖回去」）。
   *
   * 经验不存在时**不建经验、不报错**：反馈先到是正常情况，返回 `experience_missing` 由
   * 调用方决定是寄存待归并还是放弃。「不存在」包括一条形状上就不可能是经验 id 的引用
   * （`canNameExperience` 为假）——适配器必须对它给出同一个答案，而不是抛存储层自己的错。
   * 经验存在时按效果档位调整置信度、累加引用计数，并把
   * 本条反馈写进置信度历史（溯源）。`avg_confidence` 由实现顺带按当前经验集重算，
   * 与既有回写路径保持一致——这一步同样受原子性约束：重算出的均值必须与推进过的经验集合
   * 同源。逐条读改写会让并发回写**不同**经验的两次应用各自算出旧集合上的均值，后写的一方
   * 用过期聚合覆盖先写的，于是库里的 `avg_confidence` 与经验集合的真实均值对不上。
   * 实现要么把「推进经验 + 重算聚合」收进同一个事务与同一段临界区，要么让聚合写带条件
   * （聚合没被别人推进过才写），绝不能无条件整份覆盖。
   */
  applyExperienceFeedback(
    role_id: string,
    input: ExperienceFeedbackApplication,
  ): Promise<ExperienceFeedbackResult>;

  // ── 技能晋升的状态面（Phase 3） ──────────────────────────────────

  /**
   * 扫出本时刻该处理的候选（按「先来的先处理」排序）。
   *
   * 纯读：不 claim、不改状态。选候选的规则来自 services/promotion-candidates.ts 的
   * `planPromotionCandidate`（两个适配器共用同一份），因此 InMemory 与 Pg 对「谁算候选」
   * 不会有各自的解释。
   */
  listPromotionCandidates(query: PromotionCandidateQuery): Promise<ExperienceRecord[]>;

  /**
   * claim 下一条候选：未评估的一条落初始标记后进 processing，判过的一条按计划先
   * 重置（换策略版本 / 人工审核转自动批准）或先回收过期租约，再进 processing。
   *
   * 「筛 → 判 → 写」在同一个临界区里完成；拿不到（没有候选、别人抢先、抢不到锁）返回
   * undefined —— 与交付侧「返回 undefined 表示这次什么都没做」是同一种约定，不是错误。
   */
  claimNextPromotionCandidate(
    request: PromotionClaimRequest,
  ): Promise<ClaimedPromotionCandidate | undefined>;

  /**
   * 落一条结论（processing → processed）；token 不匹配或租约已过期返回 undefined。
   *
   * 凭据（claim_token / owner / lease）不成立时**什么都不写**：那是「这次没轮到我们」，
   * 结论归当前持有者。
   *
   * 凭据成立时，`outcome === 'promoted'` 还要过一次**引用校验**：`promoted_to` 指向的
   * 技能必须存在、属于本 role、且 `promoted_from` 就是这条经验（`outcome !== 'promoted'`
   * 时不需要 skill_id，也不会写 promoted_to）。校验不过时必须**整体失败**——不写结论、
   * 不写 promoted_to、不改动经验，并抛出一个明确、可诊断的完整性错误（见
   * services/promotion-integrity 的 `PromotionSkillIntegrityError`）。经验上的
   * `promoted_to` 是一条跨实体的指针，写歪了没有任何东西会来修它：它既不会因为重试而
   * 变正确，也不会被候选扫描重新捡起来（有 promoted_to 的经验不再入选）。
   *
   * 实现必须让这次校验落在**最终写入的一致性边界之内**：内存实现是同一段无 await 的临界区，
   * PG 是 role 临界区加「写入谓词里带同一条技能的存在性」的条件写。在边界之外「先查再写」
   * 留下的是「刚验过就被删掉/被转移」的窗口，那正是这条校验要挡的东西。
   */
  completePromotion(request: PromotionCompletionRequest): Promise<ExperienceRecord | undefined>;

  /** 落一次失败（退避回队列或进死信）；token 不匹配或租约已过期返回 undefined */
  failPromotion(request: PromotionFailureRequest): Promise<ExperienceRecord | undefined>;

  /**
   * 启动恢复：把租约过期仍停在 processing 的候选放回队列，返回回收到的那些经验。
   *
   * 每一条都在自己的临界区里重新判一次过期，因此不会把「列举之后已经被别人完成了」的候选
   * 重投一次。
   */
  restoreExpiredPromotionClaims(options: PromotionRestoreOptions): Promise<ExperienceRecord[]>;

  /**
   * 人工重试：dead_letter → pending，并清零投递次数（「再试一次」就是再给满额机会）。
   *
   * 只有死信可重试，其余状态返回 undefined。这是**运维入口**，自动路径不会调它。
   */
  retryDeadLetterPromotion(request: {
    role_id: string;
    experience_id: string;
    now: string;
  }): Promise<ExperienceRecord | undefined>;

  // ── Persona 演化的状态面（Phase 4-B） ────────────────────────────

  /**
   * 读一个角色的演化标记。
   *
   * 从未演化过返回 `undefined` —— 那不是错误，是「这条演化流还没被人碰过」（Phase 4 之前
   * 落库的 Agent、以及刚建的 Agent）。**必须是持久层的事实**，不能靠进程内缓存兜：它是
   * 「要不要 claim」的第一手判据。
   */
  getPersonaEvolutionMarker(role_id: string): Promise<PersonaEvolutionMarker | undefined>;

  /**
   * claim 下一个该演化的角色：读出它的输入、算出快照、按计划把标记推进到 `processing`。
   *
   * 「读输入 → 算快照 → 判计划 → 写标记」必须在**同一个临界区**里完成：计划的判据之一是
   * 「这份输入与上一次演化过的是不是同一份」，而输入是由同一个角色名下的技能与经验算出来的
   * ——中间插进来一条新经验，就会出现「按旧快照判、按新快照记」。因此入参不带快照，适配器
   * 自己在临界区里算（这也让两个适配器不可能对「输入是什么」有各自的解释）。
   *
   * 拿不到（没有候选、别人抢先、抢不到锁）返回 undefined —— 与交付侧「返回 undefined 表示
   * 这次什么都没做」是同一种约定，不是错误。
   */
  claimNextPersonaEvolutionCandidate(
    request: PersonaEvolutionClaimRequest,
  ): Promise<ClaimedPersonaEvolutionCandidate | undefined>;

  /**
   * 落一条结论（`processing` → `processed`），并在 `evolved` 时**条件写入**新 Persona 版本。
   *
   * 两道条件缺一不可，且必须在同一次原子写里成立：
   *
   * 1. **凭据**（`claim_token` / 可选 `owner` / 租约未过期、标记仍是 `processing`）：不成立
   *    返回 `{ kind: 'claim_lost' }` 且**什么都不写**——那是「这次没轮到我们」，结论归当前
   *    持有者，硬写只会把别人的结论盖掉。
   * 2. **父版本**（写回那一刻读到的 `persona.version` 必须等于 `request.parent_version`）：
   *    不成立返回 `{ kind: 'parent_conflict' }` 且**不覆盖**——Persona 是单实体单版本号的，
   *    版本号就是乐观锁。冲突说明这份判定已经过期（别的 worker 先写了一步，或前端 PATCH
   *    改过），重投会重新读、重算、重判。
   *
   * 落地的形态：Persona 行换成 `request.persona`（版本 = 父版本 + 1），标记写成
   * `processed` + 结论 + `parent_version` / `persona_version` / `strategy_version` /
   * `input_snapshot_hash` / `source_run_id` / `reasons` / `change_summary` / `reviewed_by`，
   * 并清掉凭据（token 与租约是**活着的**凭据，终态不再有人持有）。
   *
   * **重复执行不产生重复版本**靠的是「凭据 + 父版本」这两道条件：第二次调用时标记已经不是
   * `processing`（或 token 已换），因此 `claim_lost`，一个字节都不会写。
   */
  completePersonaEvolution(
    request: PersonaEvolutionCompletionRequest,
  ): Promise<PersonaEvolutionCompletionResult>;

  /** 落一次失败（退避回队列或进死信）；凭据不成立返回 undefined */
  failPersonaEvolution(
    request: PersonaEvolutionFailureRequest,
  ): Promise<PersonaEvolutionMarker | undefined>;

  /**
   * 启动恢复：把租约过期仍停在 `processing` 的演化标记放回队列。
   *
   * 每一条都在自己的临界区里重新判一次过期，因此不会把「列举之后已经被别人完成了」的候选
   * 重投一次。
   */
  restoreExpiredPersonaEvolutionClaims(
    options: PersonaEvolutionRestoreOptions,
  ): Promise<RestoredPersonaEvolutionClaim[]>;

  /**
   * 人工重试：`dead_letter` → `pending`，并清零投递次数（「再试一次」就是再给满额机会）。
   *
   * 只有死信可重试，其余状态返回 undefined。这是**运维入口**，自动路径不会调它。
   */
  retryDeadLetterPersonaEvolution(request: {
    role_id: string;
    now: string;
  }): Promise<PersonaEvolutionMarker | undefined>;

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
