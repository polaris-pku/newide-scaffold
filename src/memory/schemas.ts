/**
 * Spec §3 持久化数据结构（Zod Schema）
 *
 * 定义 Buffer、AgentContextSnapshot、Experience、Skill、Persona、AgentHandle、
 * Metrics、DriverReturn 等可校验、可落库的领域实体。不含运行时编排类。
 */

import { z } from 'zod';

// ═══════════════════════════════════════════
//  Enums
// ═══════════════════════════════════════════

/** 用户对任务完成情况的评分 */
export const UserRatingSchema = z.enum([
  'resolved',
  'partially_resolved',
  'unresolved',
  'not_rated',
]);
export type UserRating = z.infer<typeof UserRatingSchema>;

/** Agent 生命周期状态 */
export const AgentStatusSchema = z.enum(['created', 'active', 'idle', 'draining', 'retired']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** Agent 退休原因枚举 */
export const RetiredReasonSchema = z.enum([
  'performance_degradation',
  'inactivity',
  'persona_drift',
  'manual',
  'split',
]);
export type RetiredReason = z.infer<typeof RetiredReasonSchema>;

/** 缓冲区报告提取状态机 */
export const ExtractionStatusSchema = z.enum(['pending', 'processing', 'processed', 'dead_letter']);
export type ExtractionStatus = z.infer<typeof ExtractionStatusSchema>;

/**
 * 交付状态机（定义在此处而非交付小节，是因为经验上的晋升标记也复用它，见
 * ExperiencePromotionSchema——枚举必须先于使用它的 schema 求值）。
 *
 * 取值与 Buffer 的 ExtractionStatus 一致——上下文交付项与反馈 outbox 共用同一套状态
 * 语义（见 工作包 C），但这里讲的是「交付给了下游」，所以不复用抽取那边的名字。
 */
export const DeliveryStatusSchema = z.enum([
  'pending',
  'processing',
  'processed',
  'dead_letter',
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

/** 技能审核状态 */
export const ReviewStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

/** 技能在市场中的状态 */
export const MarketStatusSchema = z.enum(['available', 'superseded', 'retired_unique']);
export type MarketStatus = z.infer<typeof MarketStatusSchema>;

/**
 * 技能市场池 Agent 的固定 role_id（方案 A）。
 *
 * 退休时保留的技能会被迁移到这个固定 Agent 名下，使技能始终「属于某个
 * Agent」（满足 Pg FK），同时退休 Agent 可安全归档。该 Agent 是隐藏的
 * 系统角色：listAgentIds() 会过滤掉它，因此不会出现在 Agent Board、
 * loadAllAgents 实例化、竞标或派发中。
 *
 * 技能市场检索（marketSearchSkills）**仅在该池内进行**：未退休/未迁入
 * 市场池的 Agent 技能不可被检索到。
 */
export const MARKET_POOL_ROLE_ID = '__market__';

/** 经验类型：正经验记录成功方案，负经验记录失败教训 */
export const ExperienceTypeSchema = z.enum(['positive', 'negative']);
export type ExperienceType = z.infer<typeof ExperienceTypeSchema>;

/** 引用的经验在本次任务中的效果 */
export const EffectivenessSchema = z.enum([
  'fully_effective',
  'partially_effective',
  'ineffective',
  'not_applicable',
]);
export type Effectiveness = z.infer<typeof EffectivenessSchema>;

// ═══════════════════════════════════════════
//  Driver Return
// ═══════════════════════════════════════════

/**
 * Driver 6 字段报告 — 每次任务完成后 Driver 返回的结构化输出。
 * 与 AgentContextSnapshot 配对，作为经验提取的双源原材料之一。
 *
 * 六字段说明：
 * - artifacts: 产出的文件/制品列表
 * - summary: 任务执行的自然语言总结
 * - decisions: 决策路径记录（决策点 → 选项 → 选择 + 理由）
 * - blockers: 遇到的阻塞项及解决方案
 * - referenced_experiences: 引用的经验及其在本次任务中的效果
 * - assumptions: 做出的假设及其风险
 */
export const DriverReturnSchema = z.object({
  /** 产出制品列表（代码补丁、文档等） */
  artifacts: z.array(
    z.object({
      type: z.string(),
      path: z.string(),
      summary: z.string(),
    }),
  ),
  /** 任务执行的全局自然语言总结 */
  summary: z.string(),
  /** 本次任务执行的整体效果评估 */
  effectiveness: EffectivenessSchema.optional(),
  /** 关键决策记录：决策点 → 可选方案 → 最终选择 + 理由 */
  decisions: z.array(
    z.object({
      point: z.string(),
      options: z.array(z.string()),
      chosen: z.string(),
      reason: z.string(),
    }),
  ),
  /** 阻塞项列表（含解决尝试和最终状态） */
  blockers: z.array(
    z.object({
      blocker: z.string(),
      attempts: z.array(z.string()),
      resolution: z.string(),
      resolved: z.boolean(),
    }),
  ),
  /** 本次任务引用的经验及其实际效果评估 */
  referenced_experiences: z.array(
    z.object({
      experience_id: z.string(),
      applied: z.boolean(),
      effectiveness: EffectivenessSchema,
      note: z.string(),
    }),
  ),
  /** 任务执行中的潜在假设及错误后果分析 */
  assumptions: z.array(
    z.object({
      assumption: z.string(),
      risk_if_wrong: z.string(),
    }),
  ),
});
export type DriverReturn = z.infer<typeof DriverReturnSchema>;

// ═══════════════════════════════════════════
//  Buffer
// ═══════════════════════════════════════════

/** 清理后保留的 Driver 调用记录（AgentContextSnapshot 内嵌） */
export const AgentContextDriverCallSchema = z.object({
  /** Driver 调用的唯一标识 */
  call_id: z.string(),
  /** 被调用的 Driver 标识 */
  driver_id: z.string(),
  /** 对应 DriverReturn 的引用（如 report_{seq}.json） */
  driver_return_ref: z.string(),
});
export type AgentContextDriverCall = z.infer<typeof AgentContextDriverCallSchema>;

/**
 * Agent 顶层上下文快照 — 任务完成后对顶层 Agent 上下文清理（Context Cleaning）的结构化产出。
 * 与 BufferSnapshot 成对写入 pending/（context_{seq}.json ↔ report_{seq}.json）。
 */
export const AgentContextSnapshotSchema = z.object({
  /** 快照唯一标识 */
  snapshot_id: z.uuid(),
  /** 来源任务 ID */
  source_task_id: z.string(),
  /** 拥有者 Agent ID */
  agent_id: z.string(),
  /** 清理后保留的思考/推理过程（reasoning chains） */
  thinking_trace: z.string(),
  /** 清理后保留的计划/任务分解过程 */
  planning_trace: z.string(),
  /** 本次任务中的 Driver 调用记录列表 */
  driver_calls: z.array(AgentContextDriverCallSchema),
  /** 清理操作执行时间 */
  cleaned_at: z.iso.datetime(),
  /** 清理前的原始 token 估算 */
  original_token_count: z.number().int().min(0),
  /** 清理后保留的 token 估算 */
  cleaned_token_count: z.number().int().min(0),
  /** 压缩比 = cleaned_token_count / original_token_count */
  compression_ratio: z.number().min(0),
});
export type AgentContextSnapshot = z.infer<typeof AgentContextSnapshotSchema>;

/**
 * 缓冲区快照 — Driver 报告进入缓冲区时的完整记录
 */
export const BufferSnapshotSchema = z.object({
  /** 任务唯一标识 */
  task_id: z.string(),
  /** 任务的人类可读描述 */
  task_description: z.string(),
  /** 用户评分（可选，初次写入时可能未评） */
  user_rating: UserRatingSchema.optional(),
  /** Driver 返回的 6 字段结构化报告 */
  driver_return: DriverReturnSchema,
  /** 来源任务 ID */
  source_task_id: z.string(),
  /** 执行该任务的 Driver 标识 */
  source_driver: z.string(),
  /**
   * 配对 AgentContextSnapshot 的序列号（context_{seq}.json）。
   * 缺失时表明上下文清理失败，提取时降级为仅使用 DriverReturn。
   */
  context_snapshot_ref: z.string().optional(),
  /** 缓冲区接收时间 */
  received_at: z.iso.datetime(),
  /** 提取重试次数（初始为 0） */
  retry_count: z.number().int().min(0),
  /** 提取状态机 */
  extraction_status: ExtractionStatusSchema,
});
export type BufferSnapshot = z.infer<typeof BufferSnapshotSchema>;

/** 缓冲区元数据 */
export const BufferMetaSchema = z.object({
  /** 关联的 Agent role_id */
  role_id: z.string(),
  /** 当前 pending 条目总数 */
  pending_count: z.number().int().min(0),
  /** 最近一次提取操作时间 */
  last_extraction_at: z.iso.datetime().optional(),
  /** 最近一次提取处理的报告数 */
  last_extraction_report_count: z.number().int().min(0).optional(),
  /** 最近一次提取生成的经验数 */
  last_extraction_experiences_created: z.number().int().min(0).optional(),
  /** 当前写入游标（下一个 seq = cursor + 1；记的是分配过的 seq 上界，只前进） */
  cursor: z.number().int().min(0),
  /** 累计已处理的条目数（文件实现里 = processed/ 分区里的报告条数，按目录重算） */
  total_processed: z.number().int().min(0),
  /** 累计死信条目数（文件实现里 = dead_letter/ 分区里的报告条数，按目录重算） */
  total_dead_letters: z.number().int().min(0),
  /** 累计已清理的上下文数 */
  total_cleaned: z.number().int().min(0).optional(),
});
export type BufferMeta = z.infer<typeof BufferMetaSchema>;

// ═══════════════════════════════════════════
//  共享状态机字段（交付通道 + 经验晋升标记）
// ═══════════════════════════════════════════

/**
 * 上下文交付项、反馈 outbox、待归并反馈与经验上的晋升标记共用的**状态机字段**。
 *
 * 这四条记录走的是同一套 claim / lease / retry / dead-letter / fencing 语义，所以字段
 * 只在这里定义一次，再由各 schema 各自展开——字段集合不可能漂移，
 * `services/delivery-lifecycle.ts` 里那组纯规则函数也才能对它们一视同仁（它的
 * `DeliveryLifecycleRecord` 要的正是这几个名字，晋升标记因此不必另写一套状态机）。
 *
 * `attempt_count` 给 `.default(0)`：工作包 B 落盘的历史记录没有这个字段，
 * 默认值是它们的真实语义（还没投递过），不必写迁移脚本。
 */
const lifecycleRecordFields = {
  /** 生命周期状态；推进规则见 services/delivery-lifecycle.ts */
  status: DeliveryStatusSchema,
  /** 已发起的投递次数（claim 一次算一次），达到重试上限后进 dead_letter */
  attempt_count: z.number().int().min(0).default(0),
  /** 当前持有者最后一次 claim 的时刻 */
  claimed_at: z.iso.datetime().optional(),
  /** 当前持有者标识（下游消费者自己给；本仓不解释它的含义） */
  claim_owner: z.string().optional(),
  /**
   * 本次 claim 的 fencing token —— **每次 claim 唯一**，renew / complete / fail 必须原样带回。
   *
   * 与 `claim_owner` 的分工是刻意的：owner 是稳定 worker 标识（同一个人重启后还是它），
   * 因此无法区分「上一个进程的持有」与「这个进程的持有」。token 每次 claim 都新生成，
   * 于是租约过期后被别人抢走的记录，旧持有者拿着旧 token 再也写不进去——这就是
   * 「过期 worker 不能覆盖新 worker 的成果」在数据上的落点。
   *
   * 可选是为了读得进工作包 B/C 之前的旧记录；**缺 token 不是绕过 fencing 的口子**，
   * 而是明确的恢复路径：旧记录只能等租约过期（或本就无租约）被判为过期后回到队列，
   * 由下一次 claim 重新发一个 token，任何持有者都无法凭旧记录写终态。
   */
  claim_token: z.string().optional(),
  /** 本次 lease 的到期时刻；过期即可被 restoreExpired* 放回队列 */
  lease_expires_at: z.iso.datetime().optional(),
  /** 退避后的最早可再投递时刻；缺席表示立即可投递 */
  next_retry_at: z.iso.datetime().optional(),
  /** 最近一次失败原因（dead_letter 时保留最后一次） */
  last_error: z.string().optional(),
  /** 下游 processor 的版本位（由外部系统在 ack 时填充） */
  processor_version: z.string().optional(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
};

// ═══════════════════════════════════════════
//  Experience
// ═══════════════════════════════════════════

/** 置信度变更历史条目 */
export const ConfidenceHistoryEntrySchema = z.object({
  /** 变更后的置信度值（0~1） */
  value: z.number().min(0).max(1),
  /** 变更时间 */
  updated_at: z.iso.datetime(),
  /** 变更原因说明 */
  reason: z.string(),
  /**
   * 造成这次变更的 Driver 反馈 id（反馈回写路径才有）。
   *
   * 它同时是**反馈应用的幂等键落点**：条目一旦写下，就说明这条反馈已经作用过这条经验，
   * 重复投递（崩溃后重跑、lease 过期被接手）再来一次时据此跳过。可选是刻意的——历史
   * 记录与 `applyUsageFeedback` 写的旧条目都没有这个字段，它们按「无从判断」读入即可，
   * 不需要迁移。
   */
  feedback_id: z.string().optional(),
});

/**
 * 一次晋升评估的结论 —— 策略判定这条经验该去哪。
 *
 * 与生命周期状态是两个维度：结论是**判定结果**（够不够格、要不要人看），`status` 是
 * **处理进度**（谁在处理、处理完没有）。两者都记在 ExperiencePromotion 上，因此
 * 「判定为 rejected」与「这条已经处理完」不会互相顶替。
 */
export const PromotionOutcomeSchema = z.enum([
  /** 判定合格且当前是自动批准模式：调用方随即写入 Skill 并把 promoted_to 指过去 */
  'promoted',
  /** 判定合格但当前是人工审核模式：只留下这里，**不写 Skill**，等人工或后续自动批准的运行 */
  'pending_review',
  /** 判定不合格：留下理由，同一策略版本下不再重复评估 */
  'rejected',
]);
export type PromotionOutcome = z.infer<typeof PromotionOutcomeSchema>;

/**
 * 经验上的晋升标记 —— Skill Promotion Job 处理这条经验时留下的一切。
 *
 * **可缺席即「从未评估」**：工作包 B 之前落盘的经验、以及新提取出来的经验都没有这个
 * 字段，读作「还没被人评估过」，不需要迁移脚本（Pg 的载荷是 JSONB，老行只是少一个键）。
 *
 * 计划 §10 要求表达的那些语义落在这里：
 *
 * | 计划里的说法 | 本 schema 的落点 |
 * | --- | --- |
 * | 未评估       | `promotion === undefined` |
 * | 处理中       | `status === 'processing'`（lease 未过期） |
 * | 已晋升       | `status === 'processed'` 且 `outcome === 'promoted'` |
 * | 待审核       | `status === 'processed'` 且 `outcome === 'pending_review'` |
 * | 已拒绝       | `status === 'processed'` 且 `outcome === 'rejected'` |
 * | 失败 / 可重试 | `status === 'pending'`、`attempt_count > 0`、`next_retry_at` 是退避后的时刻 |
 * | 死信         | `status === 'dead_letter'`（用满次数或明确不可恢复） |
 *
 * 生命周期字段与交付项共用（见 lifecycleRecordFields），转移规则也共用
 * services/delivery-lifecycle.ts：晋升没有第二套状态机，只有同一套骨架加上面那几列
 * 结论字段。**候选的 claim 也不需要另一套** —— `claim_owner` / `claim_token` /
 * `lease_expires_at` 就是这条候选的 claim，持久化在经验自己身上，进程内 Map 不参与防重。
 *
 * 审计（计划 §10 的「记录结果及策略版本」）：`strategy_version` 是判定它的策略版本，
 * `evaluated_at` 是判定时刻，`reasons` 是判定理由，`attempt_count` / `last_error` 是
 * 失败与重试的痕迹。`skill_id` 只在 `outcome === 'promoted'` 时有值，与经验上的
 * `promoted_to` 同源。
 *
 * 刻意不加「outcome=promoted ⇒ skill_id 必填」的跨字段 refine：那是写入路径的
 * 不变量（见 MemoryRepository.completePromotion 的说明），写在这里会让 schema 变成
 * ZodEffects，失去后续复用 `.extend()` / `.shape` 的能力。
 */
export const ExperiencePromotionSchema = z.object({
  ...lifecycleRecordFields,
  /** 评估结论；缺席 = 还没得出结论（正在处理、或被判失败退回了队列） */
  outcome: PromotionOutcomeSchema.optional(),
  /** 做出该结论的策略版本；版本变了，同一条经验可以被重新评估 */
  strategy_version: z.string().optional(),
  /** 结论产生的时刻 */
  evaluated_at: z.iso.datetime().optional(),
  /** 晋升出的 Skill id；只在 `outcome === 'promoted'` 时有值，且与 Experience.promoted_to 一致 */
  skill_id: z.uuid().optional(),
  /** 结论的人读理由（策略给了什么、被哪条规则挡住） */
  reasons: z.array(z.string()).optional(),
});
export type ExperiencePromotion = z.infer<typeof ExperiencePromotionSchema>;

/**
 * 经验记录 — Agent 每次任务后反思提取的结构化知识
 */
export const ExperienceRecordSchema = z.object({
  /** 经验唯一标识 */
  id: z.uuid(),
  /** 经验简短描述（用于列表展示和相似度检索） */
  description: z.string(),
  /** 描述文本的向量嵌入 */
  description_embedding: z.array(z.number()),
  /** 经验的完整内容（结构化或自然语言） */
  content: z.string(),
  /** 当前置信度（0~1），随使用反馈动态更新 */
  confidence: z.number().min(0).max(1),
  /** 分类标签列表 */
  tags: z.array(z.string()),
  /** 拥有者 Agent ID */
  agent_id: z.string(),
  /** 关联的负经验 ID 列表（记录了失败教训的经验） */
  linked_negative_exp: z.array(z.string()).optional(),
  /** 若被晋升为技能，记录晋升后的技能 ID */
  promoted_to: z.uuid().optional(),
  /**
   * 晋升标记：Skill Promotion Job 处理这条经验时留下的 claim / 结论 / 审计信息。
   * 缺席 = 从未被评估过（工作包 B 之前的旧经验，以及刚提取出来的经验）。
   */
  promotion: ExperiencePromotionSchema.optional(),
  /** 该经验成立所依赖的假设列表 */
  assumptions: z.array(z.string()).optional(),
  /** 置信度变更历史（用于追踪经验的可信度变化） */
  confidence_history: z.array(ConfidenceHistoryEntrySchema),
  /** 被其他任务引用的次数 */
  referenced_count: z.number().int().min(0),
  /** 最近一次被引用的时间 */
  last_referenced_at: z.iso.datetime().optional(),
  /** 来源任务 ID */
  source_task_id: z.string(),
  /** 来源 Driver 标识 */
  source_driver: z.string(),
  /** 来源任务的用户评分 */
  source_user_rating: UserRatingSchema.optional(),
  /** 经验类型：positive=成功方案，negative=失败教训 */
  type: ExperienceTypeSchema,
  /** 创建时间 */
  created_at: z.iso.datetime(),
  /** 最后更新时间 */
  updated_at: z.iso.datetime(),
});
export type ExperienceRecord = z.infer<typeof ExperienceRecordSchema>;

/**
 * 这个字符串有没有可能命名一条已落库的经验。
 *
 * 判据直接取自上面的 schema（`id` 是 uuid），不另立一套：经验 id 一律由 randomUUID() 生成，
 * 库里那一列也是 uuid 类型。因此满足不了它的引用**不可能**对应到任何一条经验——它只可能是
 * 把别的东西当成了经验 id（典型：driver 把上下文占位条目的编号报回来）。这类引用不该进
 * 反馈表，也不该被当成「还没出现的经验」去等待：等多久都不会出现。
 */
export function canNameExperience(experienceId: string): boolean {
  return ExperienceRecordSchema.shape.id.safeParse(experienceId).success;
}

/** 经验溯源信息 */
export const ExperienceSourceSchema = z.object({
  /** 经验 ID */
  experience_id: z.string(),
  /** 来源任务 ID */
  source_task_id: z.string(),
  /** 来源 Driver 标识 */
  source_driver: z.string(),
  /** 来源制品列表 */
  source_artifacts: z.array(
    z.object({
      type: z.string(),
      path: z.string(),
      summary: z.string(),
    }),
  ),
  /** 来源任务的用户评分 */
  source_user_rating: UserRatingSchema,
  /** 经验成立时依赖的假设列表 */
  source_assumptions: z.array(z.string()),
  /** 置信度变更完整历史 */
  confidence_history: z.array(ConfidenceHistoryEntrySchema),
});
export type ExperienceSource = z.infer<typeof ExperienceSourceSchema>;

// ═══════════════════════════════════════════
//  Skill
// ═══════════════════════════════════════════

/**
 * 技能记录 — 经充分验证的可复用能力单元
 *
 * 由经验晋升而成（promoted_from 非空）或从外部市场导入（imported_by 非空）。
 */
export const SkillRecordSchema = z.object({
  /** 技能唯一标识 */
  id: z.uuid(),
  /** 技能简短描述（用于列表展示和相似度检索） */
  description: z.string(),
  /** 描述文本的向量嵌入 */
  description_embedding: z.array(z.number()),
  /** 技能的完整内容（结构化指令或代码片段） */
  content: z.string(),
  /** 技能版本号 */
  version: z.string(),
  /** 审核状态 */
  review_status: ReviewStatusSchema,
  /** 子技能 ID 列表 */
  sub_skills: z.array(z.string()).optional(),
  /** 分类标签列表 */
  tags: z.array(z.string()),
  /** 若由经验晋升而来，记录来源经验 ID */
  promoted_from: z.uuid().optional(),
  /** 若从技能市场引入而来，记录来源市场 Skill 的 ID（用于溯源与幂等） */
  imported_from: z.uuid().optional(),
  /** 晋升时间 */
  promoted_at: z.iso.datetime(),
  /** 创造者 Agent ID */
  agent_id: z.string(),
  /**
   * 技能的最初创建者 Agent ID。
   *
   * 技能归入市场池（__market__）时记录原创建者；通过市场引入的副本沿袭
   * 源技能的原创建者，从而溯源到技能谱系的根创建者。
   */
  origin_agent_id: z.string().optional(),
  /** 导入该技能的其他 Agent ID 列表 */
  imported_by: z.array(z.string()).optional(),
  /** 关联的负经验 ID 列表（记录了该技能不适用的情况） */
  linked_negative_exp: z.array(z.string()).optional(),
  /** 在市场中的状态 */
  market_status: MarketStatusSchema.optional(),
  /** 审核人 ID */
  reviewed_by: z.string().optional(),
  /** 审核时间 */
  reviewed_at: z.iso.datetime().optional(),
  /** 创建时间 */
  created_at: z.iso.datetime(),
  /** 最后更新时间 */
  updated_at: z.iso.datetime(),
});
export type SkillRecord = z.infer<typeof SkillRecordSchema>;

// ═══════════════════════════════════════════
//  Persona
// ═══════════════════════════════════════════

/**
 * Persona 定义 — Agent 的当前能力快照
 *
 * 由 Memory 模块定期根据最新的经验和技能重新生成，
 * 作为 Coordinator 分配任务时匹配 Agent 能力的依据。
 */
export const PersonaDefSchema = z.object({
  /** 关联的 Agent role_id */
  role_id: z.string(),
  /** Persona 版本号（每次重新生成时递增） */
  version: z.number().int().positive(),
  /** Persona 摘要说明 */
  summary: z.string(),
  /** 技能覆盖范围概述 */
  skills_overview: z.string(),
  /** 经验覆盖范围概述 */
  experience_coverage: z.string(),
  /** 近期表现总结 */
  recent_performance: z.string(),
  /** 补充说明 */
  notes: z.string(),
  /** Persona 生成时间 */
  generated_at: z.iso.datetime(),
});
export type PersonaDef = z.infer<typeof PersonaDefSchema>;

/**
 * 一次演化的结论 —— 这条角色的演化流走到了哪一格（Phase 4）。
 *
 * 与晋升的 `PromotionOutcome` 是同一族语义，只换了落脚点：晋升的产物是「多了一条技能」，
 * 演化的产物是「Persona 版本 +1」，所以第一格叫 `evolved` 而不是 `promoted`。
 *
 * `eligible`（策略说够格）**不在**这里——那是判定，`evolved` 是事实：自动批准时前者导致
 * 后者，人工审核时前者导致 `pending_review`。把「够格」写进这个枚举，就再也分不出
 * 「够格但没人放行」和「已经写进库」。
 */
export const PersonaEvolutionOutcomeSchema = z.enum([
  /** 判定合格且当前是自动批准模式：新 Persona 版本已经写在库里 */
  'evolved',
  /** 判定合格但当前是人工审核模式：只留下这里，**不写 Persona**，等人工或后续自动批准的运行 */
  'pending_review',
  /** 判定不合格：留下理由与挡板规则，同一输入快照与策略版本下不再重复评估 */
  'rejected',
]);
export type PersonaEvolutionOutcome = z.infer<typeof PersonaEvolutionOutcomeSchema>;

/**
 * 演化标记 —— Persona Evolution Job 处理**一个角色**时留下的一切（Phase 4）。
 *
 * **可缺席即「从未演化过」**：Phase 4 之前落库的 Agent、以及新建的 Agent 都没有这个字段，
 * 读作「这条演化流还没被人碰过」，不需要迁移脚本（Pg 侧是一个可空的 JSONB 列，老行是 NULL）。
 *
 * 与晋升标记（`ExperiencePromotionSchema`）是**同一套骨架 + 不同的结论字段**：生命周期字段
 * 共用 `lifecycleRecordFields`，转移规则共用 `services/delivery-lifecycle.ts`，因此这条通道
 * 没有第二套状态机。三处刻意的差异，都是「候选是角色而不是行」的直接后果：
 *
 * 1. **候选的粒度是 role**：claim/lease 按角色持有（一个角色同时只有一条演化流），因此
 *    逐条结果与幂等键都以 `role_id` 为主，而不像晋升那样每条经验各自持有。
 * 2. **多了一组版本字段**：`parent_version`（判定与写回的前置条件）、`persona_version`
 *    （这次写下的版本）、`input_snapshot_hash`（幂等键的一半）、`strategy_version`、
 *    `source_run_id`、`change_summary`。计划 §11 要求 Persona 更新「记录 source run、
 *    strategy version、input snapshot 与变更摘要」，落点就是这里。
 * 3. **没有 `skill_id` 这种「产物指针」**：产物是 Persona 本身（同一行、版本号 +1），
 *    不需要跨实体引用，因而也没有晋升那条「引用成立性」校验。
 *
 * 版本模型读法（计划 §11 的「Persona 版本」一节）：
 *
 * | 问题 | 读法 |
 * | --- | --- |
 * | 当前 Persona 是第几版 | `PersonaDef.version` |
 * | 它是由哪一版演化来的 | 本标记的 `parent_version` → `persona_version` |
 * | 它依据什么输入 | `input_snapshot_hash` |
 * | 按哪一版判据 | `strategy_version` |
 * | 是谁、哪一次运行产生的 | `source_run_id` + `reviewed_by` |
 * | 变了什么 | `change_summary`（人读） |
 * | 审核状态 | `outcome`（`pending_review` = 等人工；`evolved` + `reviewed_by` = 自动批准） |
 *
 * **落点**：标记挂在 **Agent 记录**上（InMemory 是 `AgentStore` 的一个字段，Pg 是
 * `memory_agents` 的一个可空 JSONB 列，见 Phase 4-B），**不放进 `AgentHandle`、也不放进
 * `PersonaDef`**。理由是它属于维护状态而不是对外视图：`AgentHandle` 是前端与 Coordinator
 * 读的那份载荷，把 claim token、重试次数、失败原因塞进去等于给在线读口加了一组它不该看见
 * 的字段；而 `PersonaDef` 是一次演化的**产物**，把「上一次演化是怎么来的」记在产物里会让
 * 产物与状态互相耦合（前端 PATCH Persona 时还得决定这一组字段怎么办）。
 */
export const PersonaEvolutionMarkerSchema = z.object({
  ...lifecycleRecordFields,
  /** 最近一次演化的结论；缺席 = 还没得出结论（正在处理、或被判失败退回了队列） */
  outcome: PersonaEvolutionOutcomeSchema.optional(),
  /** 这次判定与写回所基于的父 Persona 版本：条件写的前置条件 */
  parent_version: z.number().int().positive().optional(),
  /** 这次演化写下的 Persona 版本；只在 `outcome === 'evolved'` 时有值，且等于它 +1 */
  persona_version: z.number().int().positive().optional(),
  /** 做出该结论的策略版本；版本变了，同一份输入可以被重新评估 */
  strategy_version: z.string().optional(),
  /** 判定所依据的输入快照 hash —— 与 `strategy_version` 一起构成「要不要重评」的判据 */
  input_snapshot_hash: z.string().optional(),
  /** 产生这次结论的 maintenance run */
  source_run_id: z.string().optional(),
  /** 结论产生的时刻 */
  evaluated_at: z.iso.datetime().optional(),
  /** 结论的人读理由（策略给了什么、被哪条规则挡住） */
  reasons: z.array(z.string()).optional(),
  /** 变更摘要（人读）：这次演化把 Persona 从哪一版推到哪一版、依据什么规模 */
  change_summary: z.string().optional(),
  /** 自动批准时的批准者标识；与技能晋升同一个值（`system:auto-approval`） */
  reviewed_by: z.string().optional(),
});
export type PersonaEvolutionMarker = z.infer<typeof PersonaEvolutionMarkerSchema>;

// ═══════════════════════════════════════════
//  Metrics
// ═══════════════════════════════════════════

/** Agent Metrics 原始指标（持久化） */
export const AgentMetricsSchema = z.object({
  /** 关联的 Agent role_id */
  role_id: z.string(),
  /** 累计接收的任务总数 */
  total_tasks: z.number().int().min(0),
  /** 累计参与投标的任务数 */
  tasks_bid: z.number().int().min(0),
  /** 累计中标的任务数 */
  tasks_won: z.number().int().min(0),
  /** 累计完成的任务数 */
  tasks_completed: z.number().int().min(0),
  /** 累计成功完成的任务数 */
  tasks_succeeded: z.number().int().min(0),
  /** 累计部分完成的任务数 */
  tasks_partial: z.number().int().min(0),
  /** 累计失败的任务数 */
  tasks_failed: z.number().int().min(0),
  /** 当前掌握的技能总数 */
  skill_count: z.number().int().min(0),
  /** 当前积累的经验总数 */
  experience_count: z.number().int().min(0),
  /** 从外部导入的技能总数 */
  imported_skill_count: z.number().int().min(0),
  /** 自主晋升的技能总数 */
  promoted_skill_count: z.number().int().min(0),
  /** 所有经验的加权平均置信度（0~1） */
  avg_confidence: z.number().min(0).max(1),
  /** 累计 token 消耗总成本 */
  token_cost_total: z.number().min(0),
  /** 首次参与任务时间 */
  first_task_at: z.iso.datetime().optional(),
  /** 最近一次参与任务时间 */
  last_task_at: z.iso.datetime().optional(),
  /** 最近一次中标时间 */
  last_won_at: z.iso.datetime().optional(),
  /** 指标产生时的 Persona 版本号 */
  persona_version: z.number().int().positive(),
  /** Persona 漂移度（0~1，越高表示当前表现与 Persona 描述差异越大） */
  persona_drift: z.number().min(0).max(1).optional(),
  /** Persona 最近一次保持稳定的时间点 */
  persona_stable_since: z.iso.datetime().optional(),
  /** 最近一次退休扫描时间（三重门控触发机制的状态持久化） */
  last_retirement_scan_at: z.iso.datetime().optional(),
  /** 最近一次 Persona 漂移层评估时间（第二层门控冷却起点） */
  last_persona_drift_eval_at: z.iso.datetime().optional(),
  /** 最近一次 LLM 全面评估时间（第三层门控冷却起点） */
  last_llm_eval_at: z.iso.datetime().optional(),
});
export type AgentMetrics = z.infer<typeof AgentMetricsSchema>;

/**
 * 派生指标（实时计算，不持久化）
 *
 * 基于 AgentMetrics 原始数据通过 calculateDerivedMetrics() 实时计算，
 * 用于 Agent 排名、任务分配决策等场景。
 */
export interface DerivedMetrics {
  /** 任务成功率 = tasks_succeeded / tasks_completed */
  success_rate: number;
  /** 投标胜率 = tasks_won / tasks_bid */
  bid_win_rate: number;
  /** 经验密度 = experience_count / total_tasks */
  experience_density: number;
  /** 技能密度 = skill_count / experience_count */
  skill_density: number;
  /** 活跃度评分（基于最近任务距今的天数，14 天半衰期） */
  activity_score: number;
}

/**
 * 从原始指标实时计算派生指标
 *
 * 纯函数，不依赖外部状态。
 * 活跃度评分使用公式：1 / (1 + daysSinceLastTask / 14)
 */
export function calculateDerivedMetrics(m: AgentMetrics): DerivedMetrics {
  const daysSinceLastTask = m.last_task_at
    ? (Date.now() - new Date(m.last_task_at).getTime()) / (1000 * 60 * 60 * 24)
    : 30;

  return {
    success_rate: m.tasks_completed > 0 ? m.tasks_succeeded / m.tasks_completed : 0,
    bid_win_rate: m.tasks_bid > 0 ? m.tasks_won / m.tasks_bid : 0,
    experience_density: m.total_tasks > 0 ? m.experience_count / m.total_tasks : 0,
    skill_density: m.experience_count > 0 ? m.skill_count / m.experience_count : 0,
    activity_score: 1.0 / (1.0 + daysSinceLastTask / 14),
  };
}

// ═══════════════════════════════════════════
//  Agent
// ═══════════════════════════════════════════

/** 创建 Agent 的输入参数 */
export const CreateAgentSpecSchema = z.object({
  /** Agent 的角色 ID（全局唯一） */
  role_id: z.string(),
  /** Agent 的显示名称 */
  name: z.string(),
  /** 初始标签列表（用于分类和匹配） */
  tags: z.array(z.string()).optional(),
  /** Persona 种子文本（用于生成初始画像摘要） */
  persona_seed: z.string().optional(),
  /** 约束条件列表（限制 Agent 的行为范围） */
  constraints: z.array(z.string()).optional(),
});
export type CreateAgentSpec = z.infer<typeof CreateAgentSpecSchema>;

/**
 * Agent 聚合根 — Agent 的完整对外视图
 *
 * 组合了 persona、metrics、skill/experience 计数和生命周期状态。
 * 由 MemoryRepository.getAgent() 返回，供 Coordinator 做任务分配决策。
 */
export const AgentHandleSchema = z.object({
  /** 角色 ID */
  role_id: z.string(),
  /** 显示名称 */
  name: z.string(),
  /** 当前 Persona 快照 */
  persona: PersonaDefSchema,
  /** 当前技能总数 */
  skill_count: z.number().int().min(0),
  /** 当前经验总数 */
  experience_count: z.number().int().min(0),
  /** 生命周期状态 */
  status: AgentStatusSchema,
  /** 创建时间 */
  created_at: z.iso.datetime(),
  /** 标签列表 */
  tags: z.array(z.string()).optional(),
  /** 父 Agent ID（若由分裂产生） */
  parent_agent_id: z.string().optional(),
  /** 退休时间 */
  retired_at: z.iso.datetime().optional(),
  /** 退休原因 */
  retired_reason: RetiredReasonSchema.optional(),
  /** 拥有的技能 ID 列表 */
  owned_skills: z.array(z.string()),
  /** 拥有的经验 ID 列表 */
  owned_exps: z.array(z.string()),
  /** 性能指标快照 */
  metric: AgentMetricsSchema,
});
export type AgentHandle = z.infer<typeof AgentHandleSchema>;

// ═══════════════════════════════════════════
//  Agent Archive（退休归档）
// ═══════════════════════════════════════════

/**
 * 退休归档（最小字段）。
 *
 * 退休 finalize 后，Agent 实体从数据库中删除，仅保留此归档记录用于追溯。
 * 详细的经验/技能数据随实体删除（技能在资产处置时已迁入市场池；保留经验
 * 不再单独留存，仅保留计数摘要）。
 */
export const AgentArchiveRecordSchema = z.object({
  /** 退休 Agent 的 role_id */
  role_id: z.string(),
  /** 显示名称 */
  name: z.string(),
  /** 归档状态（固定 retired） */
  status: z.literal('retired'),
  /** 退休时间 */
  retired_at: z.iso.datetime(),
  /** 退休原因 */
  retired_reason: RetiredReasonSchema,
  /** 标签（用于追溯） */
  tags: z.array(z.string()).optional(),
  /** 资产处置摘要（计数） */
  asset_disposition: z.object({
    skills_retained: z.number().int().min(0),
    skills_discarded: z.number().int().min(0),
    experiences_retained: z.number().int().min(0),
    experiences_discarded: z.number().int().min(0),
  }),
  /** 替代 Agent role_id（若创建） */
  replacement_role_id: z.string().optional(),
});
export type AgentArchiveRecord = z.infer<typeof AgentArchiveRecordSchema>;

// ═══════════════════════════════════════════
//  Extract Result
// ═══════════════════════════════════════════

/** 经验提取操作的结果摘要 */
export const ExtractResultSchema = z.object({
  /** 本次新创建的经验数量 */
  experiences_created: z.number().int().min(0),
  /** 本次更新的已有经验数量 */
  experiences_updated: z.number().int().min(0),
  /** 本次生成的负经验数量 */
  negative_experiences: z.number().int().min(0),
  /** 本次晋升为技能的经验数量 */
  skills_promoted: z.number().int().min(0),
});
export type ExtractResult = z.infer<typeof ExtractResultSchema>;

// ═══════════════════════════════════════════
//  Memory Delivery（上游交付契约）
// ═══════════════════════════════════════════

// DeliveryStatusSchema 定义在文件开头的 Enums 一节：经验上的晋升标记（见
// ExperiencePromotionSchema）也复用它，两边必须是同一个枚举。

/** 上下文交付契约的版本；引用语义变化时递增，交付键随之改变 */
export const CONTEXT_DELIVERY_SCHEMA_VERSION = 'context-delivery.v1';
/** Driver 使用反馈契约的版本；反馈键与 event_version 都取自它 */
export const DRIVER_FEEDBACK_EVENT_VERSION = 'driver-usage.v1';

// lifecycleRecordFields（交付项 / 反馈 outbox / 待归并反馈 / 经验晋升标记共用的状态机
// 字段）定义在 Experience 一节之前——经验上的晋升标记也用它，必须先生效。

/**
 * 上下文交付项 — 一次 Agent 任务完成后交付给外部 Memory Maintenance 系统的输入。
 *
 * 只存**稳定引用**，不复制 payload：DriverReturn 与 AgentContextSnapshot 各只有
 * 一份，仍在 Buffer 的 `report_<seq>.json` / `context_<seq>.json` 里。下游读到这条
 * 记录就知道该去取哪一份，而不会拿到与 Buffer 漂移的第二份副本。
 *
 * `delivery_key = role_id:buffer_seq:context_schema_version` 是幂等键：同一份
 * 上下文重复提交只会留下一条交付记录。
 */
export const ContextDeliveryItemSchema = z.object({
  /** 文件名安全 id（由 delivery_key 哈希而来） */
  delivery_id: z.string(),
  /** 稳定幂等键：`{role_id}:{buffer_seq}:{context_schema_version}` */
  delivery_key: z.string(),
  /** 产出该上下文的 Agent */
  role_id: z.string(),
  /** 来源任务 */
  task_id: z.string(),
  /** 该任务在 Buffer 中的序号 */
  buffer_seq: z.number().int().positive(),
  /** Buffer 引用：`{role_id}:{buffer_seq}`（与 memory_buffer_ref 同源） */
  memory_buffer_ref: z.string(),
  /** DriverReturn 在 Buffer 中的文件名（report_<seq>.json） */
  report_ref: z.string(),
  /** AgentContextSnapshot 在 Buffer 中的文件名；缺失表示本次没有上下文快照 */
  context_snapshot_ref: z.string().optional(),
  /** 执行该任务的 Driver 标识 */
  source_driver: z.string(),
  /** 契约版本；下游据此判断自己能不能消费这条 */
  schema_version: z.string(),
  ...lifecycleRecordFields,
});
export type ContextDeliveryItem = z.infer<typeof ContextDeliveryItemSchema>;

/** Driver 使用反馈的来源；用户评分与 Driver 自报是两条独立来源，各有幂等键 */
export const DriverFeedbackSourceSchema = z.enum(['driver_usage', 'user_rating']);
export type DriverFeedbackSource = z.infer<typeof DriverFeedbackSourceSchema>;

/**
 * 一条 Driver 反馈的**内容**字段（交付状态机之外的那部分）。
 *
 * 单独抽出来是给待归并副本用的：那份副本要回答的是「这条反馈说了什么」，不该带上任何
 * 一条交付记录的进度。照抄整条 outbox 记录会把 status/attempt_count/claim_token/租约
 * 一起带进去——同一个 payload 里于是有两个互相矛盾的状态，而副本里那个还是**冻结**的
 * （写完就不动了），最容易被误读成实时进度。按这份 schema 取内容，副本从构造上就不带
 * 这些字段（zod 对象默认丢弃未知键）。
 */
const driverFeedbackContentFields = {
  /** 文件名安全 id（由 feedback_key 哈希而来） */
  feedback_id: z.string(),
  /** 稳定幂等键：`{role_id}:{task_id}:{experience_id}:{source}:{event_version}` */
  feedback_key: z.string(),
  /** 上报该反馈的 Agent */
  role_id: z.string(),
  /** 产生该使用记录的任务 */
  task_id: z.string(),
  /** 该任务在 Buffer 中的序号（用户评分路径可能没有） */
  buffer_seq: z.number().int().min(0).optional(),
  /** 被引用的经验 id（可以指向尚不存在的经验） */
  experience_id: z.string(),
  /** 本次任务是否实际应用了该经验 */
  applied: z.boolean(),
  /** 该经验在本次任务中的效果 */
  effectiveness: EffectivenessSchema,
  /** 备注原文 */
  note: z.string(),
  /** 观察到该使用事实的时刻 */
  observed_at: z.iso.datetime(),
  /** 反馈来源 */
  feedback_source: DriverFeedbackSourceSchema,
  /** 契约事件版本（见 DRIVER_FEEDBACK_EVENT_VERSION） */
  event_version: z.string(),
};

/** 反馈的内容（不含交付状态机字段）；待归并副本、应用与校验都只依赖这一份 */
export const DriverFeedbackContentSchema = z.object(driverFeedbackContentFields);
export type DriverFeedbackContent = z.infer<typeof DriverFeedbackContentSchema>;

/**
 * Driver 使用反馈记录 — Agent 对某条既有经验的使用事实。
 *
 * 刻意独立于 Experience 是否存在：Driver 可能引用跨 agent 或已被处置的经验，
 * 反馈先落到 outbox，等下游系统上线/补全后再按 `feedback_id` 归并。
 *
 * `feedback_id` 由 `role_id + task_id + experience_id + feedback_source +
 * event_version` 派生：同一份 DriverReturn 重复提交只会得到同一条反馈，
 * 既不会重复累计使用效果，也不会覆盖已知的更高质量反馈。
 *
 * 内容是内容、进度是进度：上面那份内容字段 + 交付状态机字段。前者可被单独复制
 * （见 PendingFeedbackRecord.feedback），后者只属于这一条交付记录。
 */
export const DriverFeedbackRecordSchema = z.object({
  ...driverFeedbackContentFields,
  ...lifecycleRecordFields,
});
export type DriverFeedbackRecord = z.infer<typeof DriverFeedbackRecordSchema>;

/**
 * 待归并反馈 — 反馈先到、Experience 还没出现时，反馈消费者把它寄存在这里。
 *
 * 为什么要有这一条记录，而不是把 outbox 那条反馈留在 pending 上反复重投：outbox 记录的是
 * 「上游交付了什么」，它的投递次数与退避预算属于**消费这条反馈**；而归并要等的是另一件事
 * ——某条 Experience 什么时候出现，等待窗口长得多（小时计），失败上限与保留期限另算。
 * 两者共用一个计数器，任何一次存储抖动都会吃掉归并的预算，观测上也分不清积压是谁的。
 * 因此归并队列单列：幂等键仍是 `feedback_id`（同一条反馈只寄存一份），状态机与 claim/lease
 * 语义则复用交付那套（见 services/delivery-lifecycle.ts），不另造一套。
 *
 * `feedback` 里存**原始反馈的内容副本**（`DriverFeedbackContent`，不含交付状态机字段），
 * 不存引用：归并发生在 Experience 出现之后的某个时刻，那一刻不该再去翻 outbox——它可能已经
 * 被人工重试清零、被清库、或者干脆换了后端。「保留原始 payload 和关联键」在这里是自足的意思。
 *
 * `created_at` 即入队时刻，也就是 pending age 的起点（保留期限从它算起）。
 */
export const PendingFeedbackRecordSchema = z.object({
  /** 幂等键 = 原反馈的 `feedback_id`：同一条反馈只寄存一条 */
  feedback_id: z.string(),
  /** 上报该反馈的 Agent；归并时按它定位 Experience 的归属 */
  role_id: z.string(),
  /** 关联键：等它出现的那条经验（与 feedback.experience_id 同源） */
  experience_id: z.string(),
  /** 原始反馈的内容（效果档位、备注、观察时刻、来源与契约版本都在里面，归并时自足） */
  feedback: DriverFeedbackContentSchema,
  ...lifecycleRecordFields,
});
export type PendingFeedbackRecord = z.infer<typeof PendingFeedbackRecordSchema>;

// ═══════════════════════════════════════════
//  Maintenance Run（维护任务运行记录）
// ═══════════════════════════════════════════

/**
 * 维护 job 的种类。取值就是「谁在跑」：四条消费者通道（上下文交付、反馈消费、
 * 反馈归并）与两个演化 job（技能晋升、Persona 演化）各有自己的 run。
 *
 * 反馈归并（`feedback_reconcile`）单列，而不是并进 `driver_feedback`：它由独立的
 * 周期任务驱动、失败上限与保留期限另算，观测上要能和「消费新反馈」分开看积压。
 */
export const MaintenanceJobTypeSchema = z.enum([
  'context_delivery',
  'driver_feedback',
  'feedback_reconcile',
  'skill_promotion',
  'persona_evolution',
]);
export type MaintenanceJobType = z.infer<typeof MaintenanceJobTypeSchema>;

/**
 * 维护 run 的生命周期。`running` 是唯一的非终止态：一个 run 要么正常收尾
 * （`completed`），要么带着失败原因收尾（`failed`）。run 只描述「这一次运行」，
 * 不承载业务事务语义——它失败不代表交付项失败，反之亦然。
 */
export const MaintenanceRunStatusSchema = z.enum(['running', 'completed', 'failed']);
export type MaintenanceRunStatus = z.infer<typeof MaintenanceRunStatusSchema>;

/**
 * 规范化失败码。日志与指标只带 message 而不带关联 id/code 时，同一种故障在
 * 不同 run 里长得不一样，积压与复发就无从聚合。枚举刻意小：新增码意味着
 * 「这一族失败值得单独观测」，不该随手加。
 */
export const MaintenanceFailureCodeSchema = z.enum([
  /** 交付记录在存储里找不到（被并发删掉，或引用了不存在的 id） */
  'delivery_missing',
  /** 交付项引用的 payload 读不出来：坏输入，重试无意义 */
  'payload_unreadable',
  /** 下游系统/连接不可用：可重试 */
  'downstream_unavailable',
  /** 模型调用失败（超时、限流、返回不可解析）：可重试 */
  'model_error',
  /** 存储读写失败：可重试 */
  'storage_error',
  /** 策略判定为不可晋升/不可演化：不是故障，是结论 */
  'policy_rejected',
  /** 没能归入以上任何一类的失败 */
  'unknown',
]);
export type MaintenanceFailureCode = z.infer<typeof MaintenanceFailureCodeSchema>;

/** 规范化失败描述：code 用于聚合，message 用于人读 */
export const MaintenanceFailureSchema = z.object({
  code: MaintenanceFailureCodeSchema,
  message: z.string(),
});
export type MaintenanceFailure = z.infer<typeof MaintenanceFailureSchema>;

/**
 * 一次维护 run 的计数。六个计数各自对应一种终局，`claimed_count` 是入口口径、
 * 其余五个是出口口径——同一次 run 里，出口只可能落在其中一个上。
 */
export const MaintenanceRunCountsSchema = z.object({
  /** 本次 claim 到的交付项/候选数 */
  claimed_count: z.number().int().min(0).default(0),
  /** 处理成功并已推进到终态的数量 */
  completed_count: z.number().int().min(0).default(0),
  /** 失败但退避后会再来的数量 */
  retried_count: z.number().int().min(0).default(0),
  /** 用尽次数或明确不可重试、进了死信的数量 */
  dead_letter_count: z.number().int().min(0).default(0),
  /** 本次无事可做而跳过的数量（记录不在预期状态、已被别人处理走等） */
  skipped_count: z.number().int().min(0).default(0),
  /** 本 run 自身的失败条数（异常而非交付失败） */
  failure_count: z.number().int().min(0).default(0),
});
export type MaintenanceRunCounts = z.infer<typeof MaintenanceRunCountsSchema>;

/**
 * 维护 run — 观测与审计实体，**不是业务事务边界**。
 *
 * 它回答的是「这一次调度发生了什么、多久、带走了什么失败码」，不参与
 * 交付状态机：run 结束不改变任何交付项的状态，交付项的状态也不回写 run。
 * 因此两个 store 上的并发（同一交付项被两个 run 各处理一次）不构成冲突——
 * 收敛交付项靠的是交付存储自己的原子 claim。
 */
export const MaintenanceRunSchema = z.object({
  run_id: z.string(),
  job_type: MaintenanceJobTypeSchema,
  status: MaintenanceRunStatusSchema,
  /** 执行这次的 worker / 消费者标识（与交付项 claim_owner 同源） */
  worker_id: z.string(),
  started_at: z.iso.datetime(),
  /** 终止态才有；`running` 时缺席 */
  finished_at: z.iso.datetime().optional(),
  ...MaintenanceRunCountsSchema.shape,
  /** 终局失败原因（`failed` 时保留；`completed` 也可带，表示部分失败） */
  last_error: z.string().optional(),
});
export type MaintenanceRun = z.infer<typeof MaintenanceRunSchema>;
