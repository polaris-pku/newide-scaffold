/**
 * PromotionStrategy 端口 — Skill Promotion Job 的候选资格策略（Phase 3）
 *
 * 与 ports/promotion-trigger-policy.ts 的分工，别混：
 *
 * - `PromotionTriggerPolicy`（已有）回答的是「**现在要不要**为这个 Agent 跑一次晋升」，
 *   是容量/高信/时间三层的**触发**门控，服务于 Agent 任务内的 `SkillPromotionProcessor`。
 * - `PromotionStrategy`（本文件）回答的是「**这一条**经验够不够格晋升、要不要人先看」，
 *   是逐条的**资格**判定，服务于独立的 Skill Promotion Job。
 *
 * 策略必须可配置、可版本化：`version` 是配置的一部分，写进每一条判定与每一次 run 的
 * 审计，用来回答「这条结论是哪一版策略给的」。换版本后同一条经验可以被重新评估
 * （见 services/promotion-candidates.ts 的选候选规则）。
 *
 * 判定与动作分离：策略只产出 `PromotionDecision`（结论 + 理由 + 版本），不写任何东西。
 * 「判定为 promoted 时去写 Skill」是 job 那一侧的事（Phase 3-B/3-C），因此策略是纯函数、
 * 可以脱离存储单测。
 */
import type { ExperienceRecord, UserRating } from '../schemas';

/**
 * 审核模式。
 *
 * - `auto_approve`：判定合格就直接晋升（写 Skill 并回写 promoted_to）。
 * - `manual_review`：判定合格也只留下 `pending_review`，**不写 Skill**，等人工放行或
 *   后续一次 auto_approve 的运行。缺省取它——与既有系统一致（`NEWIDE_B_SKILL_AUTO_APPROVE`
 *   缺省为 0、晋升出的 Skill `review_status` 是 pending），自动批准必须是显式打开的开关。
 */
export type PromotionApprovalMode = 'auto_approve' | 'manual_review';

/**
 * 两种审核模式的**运行时**清单。
 *
 * 类型在运行时不存在，而「策略返回的 `approval` 是不是这两种之一」必须由值来回答：一个
 * 绕过 TypeScript 的自定义策略可以给出 `'yolo'`，而这个字段决定本次执行能不能写 Skill，
 * 也原样进经验与 run 的审计。真值表写成 `Record<PromotionApprovalMode, true>` 而不是裸数组，
 * 是为了让契约新增或改名成员时**先编译不过**，校验器不会拿着过期的清单去拒掉一条合法判定。
 */
const APPROVAL_MODE_TABLE: Record<PromotionApprovalMode, true> = {
  auto_approve: true,
  manual_review: true,
};

/** `PromotionApprovalMode` 的取值清单（顺序与真值表的声明顺序一致） */
export const PROMOTION_APPROVAL_MODES: readonly PromotionApprovalMode[] = Object.keys(
  APPROVAL_MODE_TABLE,
) as PromotionApprovalMode[];

/**
 * 策略配置。阈值全部可注入，不散落 magic number；`version` 是它的身份。
 *
 * 默认值见 adapters/default-promotion-strategy.ts 的 DEFAULT_PROMOTION_STRATEGY_CONFIG。
 */
export interface PromotionStrategyConfig {
  /**
   * 策略版本。**语义或阈值变化时必须递增**——它是「同一条经验要不要重评」的判据
   * （见 promotion-candidates）：版本没变而结论已定（rejected）就跳过，版本变了就重评。
   */
  version: string;
  /** 最低置信度；判据是**严格大于**（与 services/skill-promotion.ts 的既有语义一致） */
  min_confidence: number;
  /** 最低被引用次数（`>=`）；0 表示不设门槛 */
  min_referenced_count: number;
  /**
   * 时间窗口：经验必须已经存在至少这么久（毫秒），太新的不晋升。
   *
   * 方向是「够不够老」而不是「够不够新」：晋升是延迟的离线动作，刚提取出来的经验还没有
   * 任何使用反馈作证，立刻晋升等于把一次孤立的成功当规律。0 表示不设门槛。
   */
  min_age_ms: number;
  /**
   * 反馈质量条件：来源任务的用户评分至少要达到这一档；`null` 表示不看评分。
   *
   * 档次由高到低为 resolved > partially_resolved > unresolved。来源评分缺席或为
   * `not_rated` 时，任何非 null 的门槛都不满足——「没被评过」不等于「评得好」。
   */
  min_user_rating: UserRating | null;
  /** 判定合格之后怎么走（见 PromotionApprovalMode） */
  approval: PromotionApprovalMode;
}

/** 候选的判定结论 */
export type PromotionVerdict =
  /** 够格，且当前是自动批准模式 —— 调用方可以晋升它 */
  | 'eligible'
  /** 够格，但当前是人工审核模式 —— 只记录，不写 Skill */
  | 'pending_review'
  /** 不够格 —— 记录理由，同一策略版本下不再重评 */
  | 'rejected';

/** 三个合法结论的**运行时**清单（同上：契约变了这里先编译不过） */
const VERDICT_TABLE: Record<PromotionVerdict, true> = {
  eligible: true,
  pending_review: true,
  rejected: true,
};

/**
 * `PromotionVerdict` 的取值清单。
 *
 * 校验器拿它挡下最贵的一类策略缺陷：一个拼错的 `verdict`（`'typo'`）是**字符串**，会一路
 * 通过「非 eligible、非 pending_review」的判断被写成一个正常的拒绝结论，于是实现错误伪装成
 * 判决结果（见 services/promotion-executor.ts 的 `assertPromotionDecisionConsistent`）。
 */
export const PROMOTION_VERDICTS: readonly PromotionVerdict[] = Object.keys(
  VERDICT_TABLE,
) as PromotionVerdict[];

/**
 * 挡住晋升的规则名（稳定的机器可读标识）。理由文本会变，这些名字不变，
 * 因此聚合「这批候选都栽在哪条规则上」时用的是它们。
 */
export type PromotionBlockerRule =
  /** 已经晋升过（`promoted_to` 已指向一条 Skill） */
  | 'already_promoted'
  /** 负经验：失败教训不晋升为可复用技能 */
  | 'negative_experience'
  /** 置信度未超过门槛 */
  | 'below_confidence_threshold'
  /** 被引用次数不足 */
  | 'insufficient_references'
  /** 经验太新，还没满时间窗口 */
  | 'too_recent'
  /** 来源评分未达到反馈质量门槛 */
  | 'insufficient_user_rating';

/** 六个合法挡板规则的**运行时**清单（同上：契约变了这里先编译不过） */
const BLOCKER_RULE_TABLE: Record<PromotionBlockerRule, true> = {
  already_promoted: true,
  negative_experience: true,
  below_confidence_threshold: true,
  insufficient_references: true,
  too_recent: true,
  insufficient_user_rating: true,
};

/**
 * `PromotionBlockerRule` 的取值清单。
 *
 * 挡板规则是审计里**做聚合用的那一半**（理由文本会变，规则名不变），因此一个不在这张表里的
 * 名字会被聚合成一条并不存在的规则——校验器据此拒掉它，而不是把它写进经验。
 */
export const PROMOTION_BLOCKER_RULES: readonly PromotionBlockerRule[] = Object.keys(
  BLOCKER_RULE_TABLE,
) as PromotionBlockerRule[];

/** 一次判定的输入 */
export interface PromotionEvaluationInput {
  /** 经验所属 Agent */
  role_id: string;
  /** 被评估的经验（`promotion` 字段可能已经带着上一次的 claim/结论） */
  experience: ExperienceRecord;
  /** 评估时刻（注入时钟的结果，与 run 的 started_at 同源） */
  now: string;
  /** 本次运行的审核模式；缺省用策略配置里的那一个 */
  approval?: PromotionApprovalMode;
}

/** 一次判定的结果 —— 结论、理由、以及做出它的策略版本 */
export interface PromotionDecision {
  verdict: PromotionVerdict;
  /** 做出这个判定的策略版本；原样写进 Experience 的晋升标记与 run 审计 */
  strategy_version: string;
  /** 本次判定实际使用的审核模式（运行选项覆盖之后的值） */
  approval: PromotionApprovalMode;
  /** 判定的完整理由（人读），未合格时含被挡住的规则 */
  reasons: string[];
  /** 挡住晋升的规则名；`verdict !== 'rejected'` 时为空数组 */
  blocking_rules: PromotionBlockerRule[];
  /** 参与判定的经验 id，便于逐条对账 */
  experience_id: string;
}

/**
 * 候选资格策略。
 *
 * `evaluate` 是异步的：默认实现只读这一条经验（纯判定），但策略端口不排除需要外部信息的
 * 实现（例如拉取该经验的反馈聚合、或调模型做语义判定）——把签名定成同步会把那些实现挡在
 * 门外，而定成异步对纯函数实现没有代价。
 */
export interface PromotionStrategy {
  /** 本策略的版本（与 config.version 同源，单独暴露给只关心版本位的调用方） */
  readonly version: string;
  /** 本策略的完整配置（记录进 run 审计，回答「这次是按什么判的」） */
  readonly config: PromotionStrategyConfig;
  /** 判定一条候选 */
  evaluate(input: PromotionEvaluationInput): Promise<PromotionDecision>;
}
