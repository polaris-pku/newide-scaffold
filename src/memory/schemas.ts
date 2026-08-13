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
  /** 当前写入游标（下一个 seq = cursor + 1） */
  cursor: z.number().int().min(0),
  /** 累计已处理的条目数 */
  total_processed: z.number().int().min(0),
  /** 累计死信条目数 */
  total_dead_letters: z.number().int().min(0),
  /** 累计已清理的上下文数 */
  total_cleaned: z.number().int().min(0).optional(),
});
export type BufferMeta = z.infer<typeof BufferMetaSchema>;

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
});

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
