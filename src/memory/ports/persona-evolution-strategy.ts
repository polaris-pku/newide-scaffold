/**
 * PersonaEvolutionStrategy 契约 — Persona 演化的判定端口（Phase 4-A）
 *
 * 本文件只定义**契约**：一次演化判定收什么、吐什么、可以怎么配。实现（阈值版策略在
 * adapters/default-persona-evolution-strategy.ts）、持久化状态与 claim（Phase 4-B）、
 * 执行内核与批量外壳（Phase 4-C）都在别处，因为判定规则要能脱离它们单独被审阅。
 *
 * 与 Phase 3 的 `PromotionStrategy` 刻意同构（同样的 verdict / approval / blocker 三个词表、
 * 同样的「判定里带版本与输入 id」的写法），所以读过晋升的人不必再学一套词汇。差别是这条
 * 通道**自带产物**：晋升的产物（Skill）由执行内核从经验构造，而 Persona 的产物（那几段
 * 文本）只可能由判定方给出——判定说合格的同时就得交出「新 Persona 长什么样」。
 *
 * 三处不能松的边界，都写进类型里而不是靠调用方自觉：
 *
 * 1. **判定只能读快照**。`PersonaEvolutionDecision` 必须原样带回 `input_snapshot_hash`，
 *    而执行内核会把注入策略能读到的输入**限定为快照**（见 services/persona-evolution-candidates.ts）。
 *    于是「同一个 hash ⇒ 同一份输入 ⇒ 同一个判定」按构造成立，幂等键才站得住：一个能读到
 *    快照之外数据的策略，会让「输入没变」这句话变得无法验证。
 * 2. **判定自带父版本**。`parent_version` 是写回的前置条件（Phase 4-B 的条件写据它比对），
 *    因此它必须与 `role_id`、`input_snapshot_hash` 一起在**写任何东西之前**与本次执行对账。
 * 3. **缺失反馈是一个显式结论，不是一个默认值**。反馈聚合只能作为只读输入（`feedback`
 *    缺席即「没有可用聚合」），策略必须据此给出 `rejected` + `feedback_unavailable`，
 *    而不是把缺席当 0 分静默覆盖掉已有的 Persona。
 */
import type {
  ExperienceType,
  MarketStatus,
  PersonaDef,
  PersonaEvolutionOutcome,
  ReviewStatus,
} from '../schemas';

// ═══════════════════════════════════════════
//  词表：审核模式 / 结论 / 挡板规则
// ═══════════════════════════════════════════

/**
 * 审核模式。
 *
 * - `auto_approve`：判定合格就直接写出新 Persona 版本。
 * - `manual_review`：判定合格也只留下 `pending_review`，**不写 Persona**，等人工放行或
 *   后续一次 `auto_approve` 的运行。缺省取它——不得默认绕过人工审核（计划 §11 与
 *   Phase 4 的硬约束）。
 */
export type PersonaEvolutionApprovalMode = 'auto_approve' | 'manual_review';

/**
 * 两种审核模式的**运行时**清单。
 *
 * 类型在运行时不存在，而「策略返回的 `approval` 是不是这两种之一」必须由值来回答：绕过
 * TypeScript 的自定义策略可以给出 `'yolo'`，而这个字段决定本次执行能不能写 Persona。
 * 真值表写成 `Record<…, true>`，契约新增或改名成员时这里**先编译不过**。
 */
const APPROVAL_MODE_TABLE: Record<PersonaEvolutionApprovalMode, true> = {
  auto_approve: true,
  manual_review: true,
};

/** `PersonaEvolutionApprovalMode` 的取值清单（顺序与真值表声明顺序一致） */
export const PERSONA_EVOLUTION_APPROVAL_MODES: readonly PersonaEvolutionApprovalMode[] =
  Object.keys(APPROVAL_MODE_TABLE) as PersonaEvolutionApprovalMode[];

/**
 * 演化判定的结论。
 *
 * 与晋升同一组词，因为它们描述的是同一件事：够不够格、要不要人看、还是被挡下了。
 * 落库的形态叫 `PersonaEvolutionOutcome`（schemas.ts：`evolved` / `pending_review` /
 * `rejected`）——**两者刻意不同名**：`eligible` 是「够格」这个判断，`evolved` 是「版本
 * 真的写下去了」这个事实，自动批准时前者导致后者，人工审核时前者导致 `pending_review`。
 * 把两者合成一个名字，就再也分不出「够格但没人放行」和「已经写进库」。
 */
export type PersonaEvolutionVerdict = 'eligible' | 'pending_review' | 'rejected';

const VERDICT_TABLE: Record<PersonaEvolutionVerdict, true> = {
  eligible: true,
  pending_review: true,
  rejected: true,
};

/**
 * `PersonaEvolutionVerdict` 的取值清单。
 *
 * 校验器拿它挡下最贵的一类策略缺陷：一个拼错的 `verdict`（`'typo'`）是**字符串**，会一路
 * 通过「非 eligible、非 pending_review」的判断被写成一个正常的拒绝结论——实现错误伪装成
 * 判决结果，还进不了死信。见 services/persona-evolution-decision.ts。
 */
export const PERSONA_EVOLUTION_VERDICTS: readonly PersonaEvolutionVerdict[] = Object.keys(
  VERDICT_TABLE,
) as PersonaEvolutionVerdict[];

/**
 * 挡住演化的规则名（稳定的机器可读标识）。理由文本会变，这些名字不变，
 * 因此聚合「这条通道都栽在哪条规则上」时用的是它们。
 */
export type PersonaEvolutionBlockerRule =
  /** 没有已批准 / 已生效的技能，或没有可参与演化的经验：输入是空的 */
  | 'no_approved_input'
  /** 输入快照与上一次演化完全相同：没有新输入，不该再产出一个版本 */
  | 'no_new_input'
  /** 算出来的 Persona 文本与当前版本无差别 */
  | 'persona_unchanged'
  /** 读到的父版本已经不是当前版本：这条判定基于一份过期快照 */
  | 'parent_version_changed'
  /** 反馈聚合缺失（策略需要它才能判）——**不得**把缺席当 0 分静默覆盖 */
  | 'feedback_unavailable'
  /** 反馈质量未达门槛（平均置信度低于配置值） */
  | 'below_feedback_quality';

/** 六个合法挡板规则的**运行时**清单（同上：契约变了这里先编译不过） */
const BLOCKER_RULE_TABLE: Record<PersonaEvolutionBlockerRule, true> = {
  no_approved_input: true,
  no_new_input: true,
  persona_unchanged: true,
  parent_version_changed: true,
  feedback_unavailable: true,
  below_feedback_quality: true,
};

/** `PersonaEvolutionBlockerRule` 的取值清单 */
export const PERSONA_EVOLUTION_BLOCKER_RULES: readonly PersonaEvolutionBlockerRule[] =
  Object.keys(BLOCKER_RULE_TABLE) as PersonaEvolutionBlockerRule[];

// ═══════════════════════════════════════════
//  输入：快照与它的 hash
// ═══════════════════════════════════════════

/**
 * 输入快照里的一条技能 —— **只保留判定可能依赖的字段**。
 *
 * 字段集合刻意收窄到这条通道真正会读的那些（描述、正文、标签、审核与市场状态、时刻），
 * 因为 hash 覆盖的正是「策略能读到的全部」：多留一个不会被读的字段，只会让「内容没变」
 * 被误判成「输入变了」而白白多产出一个版本。
 */
export interface PersonaEvolutionSkillSnapshot {
  id: string;
  description: string;
  content: string;
  tags: string[];
  review_status: ReviewStatus;
  market_status?: MarketStatus | undefined;
  updated_at: string;
}

/** 输入快照里的一条经验 —— 同上，只留判定会读的字段 */
export interface PersonaEvolutionExperienceSnapshot {
  id: string;
  description: string;
  content: string;
  tags: string[];
  type: ExperienceType;
  confidence: number;
  updated_at: string;
}

/** 反馈的只读聚合。它是**输入**不是数据源：缺的那几条不会在这里被补成默认值 */
export interface PersonaEvolutionFeedbackSummary {
  /** 已归并到经验上的反馈条数 */
  applied_feedback_count: number;
  /** 角色当前的平均置信度（由反馈归并维护） */
  average_confidence: number;
  /** 最近一次反馈归并的时刻；从未有过反馈时缺席 */
  last_feedback_at?: string | undefined;
}

/**
 * 一次演化判定的输入快照。
 *
 * 数组按 `id` 升序 —— **排序是快照的一部分**，不是装饰：存储返回顺序在三个后端之间本来
 * 就不保证一致，而 hash 必须只由内容决定。排序规则写在
 * services/persona-evolution-candidates.ts 里，那里也是唯一构造快照的地方。
 *
 * **当前 Persona 不在快照里**，这是幂等的要害而不是遗漏：Persona 是这条通道的产物，把
 * 它算进 hash 会让「演化出一版新 Persona」本身改变输入，于是下一次运行必然算出新 hash、
 * 必然再演化一版，永远收敛不了。产物与输入的分界在这里，父版本另在 `parent_version`
 * 上作为写回的前置条件。
 */
export interface PersonaEvolutionInputSnapshot {
  role_id: string;
  skills: PersonaEvolutionSkillSnapshot[];
  experiences: PersonaEvolutionExperienceSnapshot[];
  /** 反馈聚合；缺席表示**没有可用聚合**，策略必须显式拒绝而不是当 0 处理 */
  feedback?: PersonaEvolutionFeedbackSummary | undefined;
}

/**
 * 判定给出的 Persona 正文 —— 恰好是 `PersonaDef` 去掉系统字段之后的那些。
 *
 * `role_id` / `version` / `generated_at` 由执行内核填（版本号只能由「当前父版本 +1」得出，
 * 不能由策略自报）：让策略交出这些字段就等于让它有机会写一个不属于它的版本号。
 */
export interface PersonaEvolutionPersonaDraft {
  summary: string;
  skills_overview: string;
  experience_coverage: string;
  recent_performance: string;
  notes: string;
}

// ═══════════════════════════════════════════
//  判定
// ═══════════════════════════════════════════

/** 上一次演化留下的痕迹（只读；从未演化过时缺席） */
export interface PersonaEvolutionLastRun {
  /** 上一次判定依据的输入快照 */
  input_snapshot_hash?: string | undefined;
  /** 上一次判定用的策略版本 */
  strategy_version?: string | undefined;
  /** 上一次的结论 */
  outcome?: PersonaEvolutionOutcome | undefined;
  /** 上一次写下的 Persona 版本（`evolved` 时才有） */
  persona_version?: number | undefined;
  /** 上一次结论的时刻 */
  evaluated_at?: string | undefined;
}

/** 一次判定的输入 */
export interface PersonaEvolutionEvaluationInput {
  /** 被演化的 Agent */
  role_id: string;
  /** 参考时刻（注入时钟的结果；判定里不要自己取当前时间） */
  now: string;
  /** 本次运行的审核模式 */
  approval: PersonaEvolutionApprovalMode;
  /** 当前生效的 Persona —— **执行上下文，不属于输入快照**（见快照注释） */
  current_persona: PersonaDef;
  /** 当前 Persona 的版本，也是这次写回的前置条件 */
  parent_version: number;
  /** 只读的输入快照：判定**只能**依据它 */
  snapshot: PersonaEvolutionInputSnapshot;
  /** 快照的 hash；判定必须原样带回 */
  input_snapshot_hash: string;
  /** 上一次演化留下的痕迹；从未演化过时缺席 */
  last_evolution?: PersonaEvolutionLastRun | undefined;
}

/**
 * 一份演化判定。
 *
 * `verdict` 与 `approval` 是**两个维度**：前者是策略对输入的评价，后者是这次运行的授权，
 * 两者必须配对（见 services/persona-evolution-decision.ts 的 `VERDICT_APPROVAL_PAIRING`）。
 * `role_id` / `parent_version` / `input_snapshot_hash` / `strategy_version` 四个字段都会被
 * 原样写到别处（写回条件、幂等键、审计），因此它们既是内容也是**承诺**，校验器逐个对账。
 */
export interface PersonaEvolutionDecision {
  verdict: PersonaEvolutionVerdict;
  /** 被演化的 Agent；与被判定的那条候选必须一致 */
  role_id: string;
  /** 做出该判定的策略版本；变了就可以重新评估 */
  strategy_version: string;
  /** 做出该判定时的审核模式；与本次运行必须一致 */
  approval: PersonaEvolutionApprovalMode;
  /** 判定所依据的父 Persona 版本；写回时据此做条件更新 */
  parent_version: number;
  /** 判定所依据的输入快照；幂等键的一半 */
  input_snapshot_hash: string;
  /** 人读的判定理由（与 `blocking_rules` 一起进审计） */
  reasons: string[];
  /** 机器读的挡板规则；合格时必须为空 */
  blocking_rules: PersonaEvolutionBlockerRule[];
  /** 合格时给出的新 Persona 正文；`rejected` 时不要求（此时它无处可去） */
  persona?: PersonaEvolutionPersonaDraft | undefined;
}

// ═══════════════════════════════════════════
//  策略
// ═══════════════════════════════════════════

/**
 * 策略配置。阈值全部可注入，不散落 magic number；`version` 是它的身份。
 *
 * 三个门槛缺省都是「不设门槛」（0 / 0 / null）——它们是有代价的开关（会让演化更难发生），
 * 打开必须是显式的。这与晋升策略同一条理由：`min_confidence` 之外的开关默认关着。
 */
export interface PersonaEvolutionStrategyConfig {
  /**
   * 策略版本。**语义或阈值变化时必须递增**——它是「同一份输入要不要重评」的判据
   * （见 planPersonaEvolutionCandidate）：版本没变、输入快照也没变就跳过；任一变了就重评。
   */
  version: string;
  /** 缺省审核模式；运行选项可以覆盖到更严或更宽的那一侧 */
  approval: PersonaEvolutionApprovalMode;
  /** 至少要有几条已批准技能；0 表示不设门槛 */
  min_approved_skills: number;
  /** 至少要有几条可参与演化的经验；0 表示不设门槛 */
  min_experiences: number;
  /** 平均置信度门槛（反馈质量）；null 表示不设门槛，且不要求反馈聚合存在 */
  min_average_confidence: number | null;
}

/**
 * Persona 演化策略。
 *
 * 纯判定、无 IO：策略不写存储、不调模型（要调模型的实现在自己内部做，但那时它必须自带
 * 重试语义，见 Phase 4-C 的错误分类）。这样它既能脱离 job 单测，也能被三个后端共用。
 */
export interface PersonaEvolutionStrategy {
  /** 策略版本；run 审计与每条判定的 `strategy_version` 都取它 */
  readonly version: string;
  readonly config: PersonaEvolutionStrategyConfig;
  evaluate(input: PersonaEvolutionEvaluationInput): Promise<PersonaEvolutionDecision>;
}
