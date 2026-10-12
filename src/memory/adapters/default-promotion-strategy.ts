/**
 * DefaultPromotionStrategy — PromotionStrategy 的阈值版实现（Phase 3）
 *
 * 逐条判定一条经验够不够格晋升，规则就是那些可配置的阈值：
 *
 *   已晋升？ → 正经验？ → 置信度 > 门槛？ → 被引用次数 >= 门槛？
 *            → 够老（时间窗口）？ → 来源评分达标（反馈质量）？
 *
 * 全部通过才谈审核模式：`auto_approve` 给 `eligible`（调用方随即晋升），
 * `manual_review` 给 `pending_review`（只记录，不写 Skill）。**所有**被挡住的规则都会被
 * 收集，不是遇到第一条就返回——运维想知道的是「这批候选都栽在哪」，一次问清比反复试快。
 *
 * 纯判定、无 IO：策略不写存储、不调模型，因此可以脱离 job 单测（Phase 3-A 的策略测试
 * 只依赖本文件与 schemas）。判定理由是人读文本，`blocking_rules` 是机器读的稳定标识，
 * 两者一起进审计。
 */
import type {
  PromotionBlockerRule,
  PromotionDecision,
  PromotionEvaluationInput,
  PromotionStrategy,
  PromotionStrategyConfig,
} from '../ports/promotion-strategy';
import type { UserRating } from '../schemas';

/** 默认策略版本；阈值或判定语义变化时递增 */
export const DEFAULT_PROMOTION_STRATEGY_VERSION = 'promotion-threshold.v1';

/**
 * 默认配置。
 *
 * - `min_confidence: 0.95` 与 services/skill-promotion.ts 的 PROMOTION_CONFIDENCE_THRESHOLD
 *   同值，判据同样是「严格大于」——两条路径对同一条经验不该给出相反的结论。
 * - `min_referenced_count` / `min_age_ms` / `min_user_rating` 缺省不设门槛（0 / 0 / null）：
 *   它们是有代价的开关（会让晋升更晚发生），打开必须是显式的。
 * - `approval: 'manual_review'` 与既有系统一致（`NEWIDE_B_SKILL_AUTO_APPROVE` 缺省 0），
 *   自动批准必须是显式打开的开关。
 */
export const DEFAULT_PROMOTION_STRATEGY_CONFIG: PromotionStrategyConfig = {
  version: DEFAULT_PROMOTION_STRATEGY_VERSION,
  min_confidence: 0.95,
  min_referenced_count: 0,
  min_age_ms: 0,
  min_user_rating: null,
  approval: 'manual_review',
};

/** 用户评分的档次（越大越好）。`not_rated` 是 0：没被评过不等于评得好 */
const USER_RATING_RANK: Record<UserRating, number> = {
  resolved: 3,
  partially_resolved: 2,
  unresolved: 1,
  not_rated: 0,
};

export class DefaultPromotionStrategy implements PromotionStrategy {
  readonly config: PromotionStrategyConfig;

  constructor(config: Partial<PromotionStrategyConfig> = {}) {
    this.config = { ...DEFAULT_PROMOTION_STRATEGY_CONFIG, ...config };
    assertValidConfig(this.config);
  }

  get version(): string {
    return this.config.version;
  }

  async evaluate(input: PromotionEvaluationInput): Promise<PromotionDecision> {
    const { experience } = input;
    const approval = input.approval ?? this.config.approval;
    const blocking_rules: PromotionBlockerRule[] = [];
    const reasons: string[] = [];

    if (isAlreadyPromoted(experience)) {
      blocking_rules.push('already_promoted');
      reasons.push(
        `Experience ${experience.id} already points at Skill ${
          experience.promoted_to ?? experience.promotion?.skill_id ?? '<unknown>'
        }.`,
      );
    }

    if (experience.type !== 'positive') {
      blocking_rules.push('negative_experience');
      reasons.push('Negative experiences record failure lessons and are not promoted.');
    }

    if (!(experience.confidence > this.config.min_confidence)) {
      blocking_rules.push('below_confidence_threshold');
      reasons.push(
        `confidence ${experience.confidence} does not exceed the threshold ${this.config.min_confidence}.`,
      );
    }

    if (experience.referenced_count < this.config.min_referenced_count) {
      blocking_rules.push('insufficient_references');
      reasons.push(
        `referenced_count ${experience.referenced_count} is below the threshold ${this.config.min_referenced_count}.`,
      );
    }

    if (this.config.min_age_ms > 0) {
      const ageMs = Date.parse(input.now) - Date.parse(experience.created_at);
      if (!(ageMs >= this.config.min_age_ms)) {
        blocking_rules.push('too_recent');
        reasons.push(
          `Experience is ${ageMs}ms old; the window requires at least ${this.config.min_age_ms}ms.`,
        );
      }
    }

    if (this.config.min_user_rating !== null) {
      const actual = experience.source_user_rating ?? 'not_rated';
      if (USER_RATING_RANK[actual] < USER_RATING_RANK[this.config.min_user_rating]) {
        blocking_rules.push('insufficient_user_rating');
        reasons.push(
          `source_user_rating "${actual}" is below the required "${this.config.min_user_rating}".`,
        );
      }
    }

    if (blocking_rules.length > 0) {
      return {
        verdict: 'rejected',
        strategy_version: this.config.version,
        approval,
        reasons,
        blocking_rules,
        experience_id: experience.id,
      };
    }

    const verdict = approval === 'manual_review' ? 'pending_review' : 'eligible';
    reasons.push(
      verdict === 'eligible'
        ? 'Candidate qualifies and the run is in auto_approve mode.'
        : 'Candidate qualifies but the run is in manual_review mode; it is recorded without writing a Skill.',
    );

    return {
      verdict,
      strategy_version: this.config.version,
      approval,
      reasons,
      blocking_rules: [],
      experience_id: experience.id,
    };
  }
}

/** 已经绑定过技能的经验：`promoted_to` 是权威（与晋升标记里的 skill_id 同源） */
function isAlreadyPromoted(experience: PromotionEvaluationInput['experience']): boolean {
  return experience.promoted_to !== undefined || experience.promotion?.outcome === 'promoted';
}

/**
 * 配置自检：阈值写错（负次数、越界的置信度、未知审核模式）必须在构造时就报错，
 * 而不是让每一次判定各自悄悄给出错的结论。
 */
function assertValidConfig(config: PromotionStrategyConfig): void {
  if (!config.version) {
    throw new Error('Promotion strategy config requires a non-empty version.');
  }
  if (
    !Number.isFinite(config.min_confidence) ||
    config.min_confidence < 0 ||
    config.min_confidence >= 1
  ) {
    throw new Error(
      `Promotion strategy min_confidence must be in [0, 1): got ${String(config.min_confidence)}`,
    );
  }
  if (!Number.isInteger(config.min_referenced_count) || config.min_referenced_count < 0) {
    throw new Error(
      `Promotion strategy min_referenced_count must be a non-negative integer: got ${String(config.min_referenced_count)}`,
    );
  }
  if (!Number.isFinite(config.min_age_ms) || config.min_age_ms < 0) {
    throw new Error(
      `Promotion strategy min_age_ms must be a non-negative number: got ${String(config.min_age_ms)}`,
    );
  }
  if (config.min_user_rating !== null && !(config.min_user_rating in USER_RATING_RANK)) {
    throw new Error(`Unknown promotion strategy min_user_rating: ${String(config.min_user_rating)}`);
  }
  if (config.approval !== 'auto_approve' && config.approval !== 'manual_review') {
    throw new Error(`Unknown promotion approval mode: ${String(config.approval as string)}`);
  }
}
