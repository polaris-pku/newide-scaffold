/**
 * DefaultPersonaEvolutionStrategy — PersonaEvolutionStrategy 的阈值版实现（Phase 4-A）
 *
 * 逐条判定一个角色这次该不该演化出一版新 Persona，规则就是那些可配置的门槛：
 *
 *   输入非空？ → 输入规模达门槛？ → 反馈质量达标（若配置了）？
 *              → 输入快照与上次演化过的不一样？ → 算出来的正文与当前版本不同？
 *              → 全都通过才谈审核模式
 *
 * 全部通过才谈审核模式：`auto_approve` 给 `eligible`（调用方随即写出新版本），
 * `manual_review` 给 `pending_review`（只记录，**不写 Persona**）。缺省是人工审核——不得默认
 * 绕过人工审核。
 *
 * 纯判定、无 IO：策略不写存储、不调模型，因此可以脱离 job 单测。要接 LLM 的实现在自己内部
 * 调（并自己承担 `model_failure` 的重试语义），本文件只给一个确定性、可复现的默认实现。
 *
 * 三条判据值得单独解释，因为它们各自对应一条不能违反的约束：
 *
 * 1. **空输入一律拒绝**（`no_approved_input`）。产物完全由输入决定，没有输入就没有可演化的
 *    东西。这里必须是拒绝而不是「照常演化出一版什么都不含的 Persona」：后者会平白推进版本号，
 *    还会把一份空描述写进库里覆盖已有的内容——「缺失输入不得静默覆盖已有 Persona」说的就是它。
 * 2. **反馈聚合缺席也是拒绝**（`feedback_unavailable`），且只在策略**确实需要**它时才判
 *    （配置了 `min_average_confidence`）。把缺席当 0 分处理，等于用一个不存在的观测把角色
 *    判成不合格；把它当满分则更糟——那是在没有证据的情况下覆盖掉一份有依据的 Persona。
 * 3. **同一份输入已经演化过就不再产出新版本**（`no_new_input`）。这条挡的是「策略版本变了、
 *    输入没变」的情形：重评是被允许的（`planPersonaEvolutionCandidate` 会放行它），但
 *    **不得在没有新输入变化时重复创建版本**。因此策略照常被问一次，然后明确回一个拒绝，
 *    于是标记记录下来「这份输入在 v2 判据下也是这个结论」，后续运行按
 *    `evaluated_under_current_strategy` 跳过——判据换过一次就收敛，而不是每轮都重问一遍。
 */
import {
  buildExperienceCoverage,
  buildSkillsOverview,
} from '../services/rule-based-persona-induction';
import type {
  PersonaEvolutionApprovalMode,
  PersonaEvolutionBlockerRule,
  PersonaEvolutionDecision,
  PersonaEvolutionEvaluationInput,
  PersonaEvolutionPersonaDraft,
  PersonaEvolutionStrategy,
  PersonaEvolutionStrategyConfig,
} from '../ports/persona-evolution-strategy';
import type { PersonaDef } from '../schemas';

/** 默认策略版本；门槛或判定语义变化时递增（它是「要不要重评」的判据之一） */
export const DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION = 'persona-threshold.v1';

/** 策略在 `notes` 里自报的名字（人读的溯源信息） */
const STRATEGY_NAME = 'DefaultPersonaEvolutionStrategy';

/**
 * 默认配置。
 *
 * 三个门槛缺省都是「不设门槛」（0 / 0 / null）——它们是有代价的开关（会让演化更难发生），
 * 打开必须是显式的。`approval: 'manual_review'` 与晋升策略、与既有系统一致：自动批准必须
 * 是显式打开的开关。
 */
export const DEFAULT_PERSONA_EVOLUTION_STRATEGY_CONFIG: PersonaEvolutionStrategyConfig = {
  version: DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION,
  approval: 'manual_review',
  min_approved_skills: 0,
  min_experiences: 0,
  min_average_confidence: null,
};

export class DefaultPersonaEvolutionStrategy implements PersonaEvolutionStrategy {
  readonly config: PersonaEvolutionStrategyConfig;

  constructor(config: Partial<PersonaEvolutionStrategyConfig> = {}) {
    this.config = { ...DEFAULT_PERSONA_EVOLUTION_STRATEGY_CONFIG, ...config };
    assertValidConfig(this.config);
  }

  get version(): string {
    return this.config.version;
  }

  async evaluate(input: PersonaEvolutionEvaluationInput): Promise<PersonaEvolutionDecision> {
    const approval = input.approval;
    const { snapshot } = input;

    /** 一条拒绝结论：判定里的那五项「承诺」字段每次都一样，只有挡板与理由随情形变 */
    const reject = (
      blocking_rules: PersonaEvolutionBlockerRule[],
      reasons: string[],
    ): PersonaEvolutionDecision => ({
      verdict: 'rejected',
      role_id: input.role_id,
      strategy_version: this.config.version,
      approval,
      parent_version: input.parent_version,
      input_snapshot_hash: input.input_snapshot_hash,
      reasons,
      blocking_rules,
    });

    // ── 输入非空 ──────────────────────────────────────────────────
    if (snapshot.skills.length === 0 && snapshot.experiences.length === 0) {
      return reject(
        ['no_approved_input'],
        [
          `Role ${input.role_id} has no approved skills and no eligible experiences to evolve from.`,
        ],
      );
    }

    // ── 输入规模达门槛 ────────────────────────────────────────────
    const blocked: PersonaEvolutionBlockerRule[] = [];
    const reasons: string[] = [];
    if (snapshot.skills.length < this.config.min_approved_skills) {
      blocked.push('no_approved_input');
      reasons.push(
        `Only ${String(snapshot.skills.length)} approved skills; the strategy requires at least ${String(this.config.min_approved_skills)}.`,
      );
    }
    if (snapshot.experiences.length < this.config.min_experiences) {
      blocked.push('no_approved_input');
      reasons.push(
        `Only ${String(snapshot.experiences.length)} eligible experiences; the strategy requires at least ${String(this.config.min_experiences)}.`,
      );
    }
    if (blocked.length > 0) return reject(blocked, reasons);

    // ── 反馈质量（只在配置了门槛时才要求反馈聚合存在）────────────────
    if (this.config.min_average_confidence !== null) {
      const feedback = snapshot.feedback;
      if (feedback === undefined) {
        return reject(
          ['feedback_unavailable'],
          [
            `The strategy requires an average confidence of at least ${String(this.config.min_average_confidence)}, but no feedback aggregate is available for ${input.role_id}.`,
          ],
        );
      }
      if (feedback.average_confidence < this.config.min_average_confidence) {
        return reject(
          ['below_feedback_quality'],
          [
            `Average confidence ${String(feedback.average_confidence)} is below the required ${String(this.config.min_average_confidence)}.`,
          ],
        );
      }
    }

    // ── 同一份输入已经演化过：不许再产出一个版本 ────────────────────
    const last = input.last_evolution;
    if (last?.outcome === 'evolved' && last.input_snapshot_hash === input.input_snapshot_hash) {
      return reject(
        ['no_new_input'],
        [
          `Persona v${String(last.persona_version ?? input.parent_version)} was already evolved from this exact input snapshot; a strategy version change alone must not produce another version.`,
        ],
      );
    }

    // ── 正文：复用规则版归纳的那两段文案逻辑（同一批技能不该有第二种概述）──
    const draft: PersonaEvolutionPersonaDraft = {
      // 规则版归纳刻意不重写 summary（那是角色定位，由人给），默认策略照同一条规矩；
      // recent_performance 同理：规则版不编造，默认策略也不编造
      summary: input.current_persona.summary,
      skills_overview: buildSkillsOverview(snapshot.skills),
      experience_coverage: buildExperienceCoverage(snapshot.experiences),
      recent_performance: input.current_persona.recent_performance,
      notes:
        `Evolved by ${STRATEGY_NAME} from v${String(input.parent_version)} using `
        + `${String(snapshot.skills.length)} approved skills and `
        + `${String(snapshot.experiences.length)} experiences `
        + `(snapshot ${input.input_snapshot_hash.slice(0, 12)}).`,
    };

    if (personaContentMatches(draft, input.current_persona)) {
      return reject(
        ['persona_unchanged'],
        [
          `The evolved persona fields are identical to ${input.role_id} v${String(input.parent_version)}; there is nothing to write.`,
        ],
      );
    }

    const verdict = approval === 'manual_review' ? 'pending_review' : 'eligible';
    return {
      verdict,
      role_id: input.role_id,
      strategy_version: this.config.version,
      approval,
      parent_version: input.parent_version,
      input_snapshot_hash: input.input_snapshot_hash,
      reasons: [
        verdict === 'eligible'
          ? `Candidate qualifies and the run is in auto_approve mode.`
          : `Candidate qualifies but the run is in manual_review mode; it is recorded without writing a Persona version.`,
      ],
      blocking_rules: [],
      persona: draft,
    };
  }
}

/**
 * 演化结果与当前 Persona 的**内容**是否一致。
 *
 * 只比四段内容字段，**不比 `notes`**：`notes` 是溯源信息（父版本、输入规模、快照前缀），
 * 输入快照一变它就跟着变，把它算进「内容有没有变」会让这条判据永远不成立——于是每次输入
 * 抖动都会产出一个只改了溯源行、内容一模一样的新版本。内容是否真的变了，由这四段回答。
 */
function personaContentMatches(draft: PersonaEvolutionPersonaDraft, current: PersonaDef): boolean {
  return (
    draft.summary === current.summary
    && draft.skills_overview === current.skills_overview
    && draft.experience_coverage === current.experience_coverage
    && draft.recent_performance === current.recent_performance
  );
}

/**
 * 配置自检：门槛写错（负次数、越界的置信度、未知审核模式）必须在构造时就报错，
 * 而不是让每一次判定各自悄悄给出错的结论。
 */
function assertValidConfig(config: PersonaEvolutionStrategyConfig): void {
  if (!config.version) {
    throw new Error('Persona evolution strategy config requires a non-empty version.');
  }
  if (!Number.isInteger(config.min_approved_skills) || config.min_approved_skills < 0) {
    throw new Error(
      `Persona evolution min_approved_skills must be a non-negative integer: got ${String(config.min_approved_skills)}`,
    );
  }
  if (!Number.isInteger(config.min_experiences) || config.min_experiences < 0) {
    throw new Error(
      `Persona evolution min_experiences must be a non-negative integer: got ${String(config.min_experiences)}`,
    );
  }
  if (
    config.min_average_confidence !== null
    && (!Number.isFinite(config.min_average_confidence)
      || config.min_average_confidence < 0
      || config.min_average_confidence > 1)
  ) {
    throw new Error(
      `Persona evolution min_average_confidence must be null or in [0, 1]: got ${String(config.min_average_confidence)}`,
    );
  }
  const approval: PersonaEvolutionApprovalMode = config.approval;
  if (approval !== 'auto_approve' && approval !== 'manual_review') {
    throw new Error(`Unknown persona evolution approval mode: ${String(approval as string)}`);
  }
}
