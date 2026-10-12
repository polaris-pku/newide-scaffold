/**
 * persona-evolution-decision — 判定契约、写回前置条件与失败分类（Phase 4-A）
 *
 * 三件事收在一个文件里，因为它们回答的是同一个问题：**一次演化判定从策略手里交回来之后，
 * 什么情况下可以被信任、什么情况下可以被写下去、什么情况下该按哪种失败处理。**
 * 判定规则本身在 services/persona-evolution-candidates.ts，执行内核在 Phase 4-C，
 * 这里只放那三道纯函数级的口径。
 *
 * 1. **判定契约**（`assertPersonaEvolutionDecisionConsistent`）。策略交回来的东西在运行时是
 *    未知的：绕过 TypeScript 的实现可以交回 `null`、标量，或一个 `verdict: 'typo'` 的对象。
 *    判定里有四个字段会被**原样写到别处**——`strategy_version` 进演化标记（版本变更是重评
 *    判据）、`role_id` 决定这次演化落到谁身上、`parent_version` 决定能不能写、以及
 *    `input_snapshot_hash` 决定幂等键。任何一处对不上，写下去的就是一条与 run 审计、与
 *    幂等判据互相矛盾的记录。因此这些检查全部排在**写任何东西之前**，与晋升同一条理由。
 *    最贵的一类仍是拼错的 `verdict`：它是个普通字符串，会一路滑过「非 eligible、非
 *    pending_review」的判断被写成一条正常的拒绝结论——实现错误伪装成判决结果，还进不了死信。
 *
 * 2. **写回前置条件**（`resolvePersonaEvolutionWrite`）。Persona 的更新是「基于某一版再
 *    产出一版」，因此写回必须带上前提「我读到的是第 v 版」。读到的版本与写回时的当前版本
 *    不一致，说明这份判定已经过期（别的进程刚演化过，或前端 PATCH 改过）——**不许覆盖**。
 *    这是纯函数形态的判据，原子的条件写在 Phase 4-B 落地，两者必须给出同一个结论。
 *
 * 3. **失败分类**（`PERSONA_EVOLUTION_FAILURE_TABLE`）。错误码与可重试性只在这里定一次：
 *    消费方（Phase 4-C 的执行内核）负责把异常映射到下面这六种情形之一，而不是各自拼
 *    `{ code, retryable }`——两条通道对同一种失败给出两种待遇，正是分类表存在的理由。
 *
 * 「判定不合格」（`rejected`）**不在这张表里**：那是一条结论，不是故障。它落在完成数里、
 * 进不了死信，与晋升把 `rejected` 计入 `completed_count` 同一个道理。
 */
import {
  knownDeliveryFailure,
  type DeliveryFailureClassification,
} from './delivery-error-classification';
import type { MaintenanceFailureCode, PersonaDef } from '../schemas';
import {
  PERSONA_EVOLUTION_APPROVAL_MODES,
  PERSONA_EVOLUTION_BLOCKER_RULES,
  PERSONA_EVOLUTION_VERDICTS,
  type PersonaEvolutionApprovalMode,
  type PersonaEvolutionBlockerRule,
  type PersonaEvolutionDecision,
  type PersonaEvolutionPersonaDraft,
  type PersonaEvolutionVerdict,
} from '../ports/persona-evolution-strategy';

// ═══════════════════════════════════════════
//  写回前置条件
// ═══════════════════════════════════════════

/** 一次写回该不该发生：`apply` 时连带给出新版本号（父版本 +1） */
export type PersonaEvolutionWriteResolution =
  | { kind: 'apply'; parent_version: number; next_version: number }
  | { kind: 'conflict'; parent_version: number; current_version: number };

/**
 * 判定「这份演化结果能不能写下去」。
 *
 * 唯一的判据是**父版本就是当前版本**：Persona 是单实体、单版本号的，一次演化只是「在第 v 版
 * 之上产出第 v+1 版」，因此版本号本身就是乐观锁。不一致的情形有两种，处理方式相同——不写、
 * 让上层重投（重投会重新读、重算快照、重判一次）：
 *
 * - 别的 worker 先写了一步（并发演化同一个角色）；
 * - 前端 PATCH / 旧的归纳入口改了 Persona（它们不经过这条通道，因此不会更新演化标记）。
 *
 * **冲突不是失败**：它是一次「这次没轮到我们」，因此分类为可重试的 `storage_conflict`
 * （见下面的失败表），而不是死信。反复冲突才说明有问题——那时次数会用满，照样进死信。
 */
export function resolvePersonaEvolutionWrite(input: {
  /** 判定所依据的父版本（策略原样带回的那一个） */
  parent_version: number;
  /** 写回那一刻读到的当前版本 */
  current_version: number;
}): PersonaEvolutionWriteResolution {
  if (input.current_version !== input.parent_version) {
    return {
      kind: 'conflict',
      parent_version: input.parent_version,
      current_version: input.current_version,
    };
  }
  return {
    kind: 'apply',
    parent_version: input.parent_version,
    next_version: input.parent_version + 1,
  };
}

/**
 * 由判定给出的正文构造新一版 Persona。
 *
 * `version` 只能由**父版本 +1**得出，`role_id` 与 `generated_at` 也只能由执行方填：让策略
 * 交出这些字段，就等于让它有机会写一个不属于它的版本号（例如自称 v99），而版本号是这条
 * 通道的条件写与「旧版本不被破坏」两件事的依据。
 */
export function buildEvolvedPersona(input: {
  role_id: string;
  draft: PersonaEvolutionPersonaDraft;
  parent_version: number;
  now: string;
}): PersonaDef {
  return {
    role_id: input.role_id,
    version: input.parent_version + 1,
    summary: input.draft.summary,
    skills_overview: input.draft.skills_overview,
    experience_coverage: input.draft.experience_coverage,
    recent_performance: input.draft.recent_performance,
    notes: input.draft.notes,
    generated_at: input.now,
  };
}

/** 变更摘要（人读）：这次演化把 Persona 从哪一版推到哪一版、依据什么规模 */
export function summarizePersonaEvolutionChange(input: {
  parent_version: number;
  persona_version: number;
  approved_skill_count: number;
  eligible_experience_count: number;
  input_snapshot_hash: string;
}): string {
  return (
    `Persona v${String(input.parent_version)} → v${String(input.persona_version)} from `
    + `${String(input.approved_skill_count)} approved skills and `
    + `${String(input.eligible_experience_count)} experiences `
    + `(snapshot ${input.input_snapshot_hash.slice(0, 12)}).`
  );
}

// ═══════════════════════════════════════════
//  失败分类
// ═══════════════════════════════════════════

/**
 * 演化失败的六种情形。
 *
 * 它是**诊断词汇**，与 `MaintenanceFailureCode`（状态机读的那个码）不是一一对应：其中
 * `storage_conflict` 与 `storage_failure` 落在同一个码上（都是可重试的 `storage_error`），
 * 却必须分开——「这个角色正被别的 worker 演化」与「磁盘抖了一下」对运维是两条完全不同的
 * 线索，合并成一句会让排查只能靠猜。反过来，判定不合格（`rejected`）根本不在这里：
 * 它是结论不是故障。
 */
export type PersonaEvolutionFailureKind =
  /** 模型/下游不可用（超时、限流、返回不可解析）：可重试 */
  | 'model_failure'
  /** 策略交回的判定违反契约（形状、结论、版本、角色、父版本、快照、数组、搭配）：**不可重试** */
  | 'malformed_decision'
  /** 写回时父版本已经不是当前版本（并发演化 / 前端 PATCH）：可重试——重投会重新读再判 */
  | 'storage_conflict'
  /** 输入不存在（Agent 或 Persona 被删掉）：**不可重试**，重投不会把它变回来 */
  | 'missing_input'
  /** 策略声明的不可重试拒绝（配置错、或明确拒绝判定的输入）：**不可重试** */
  | 'policy_failure'
  /** 存储读写失败：可重试 */
  | 'storage_failure';

interface PersonaEvolutionFailureShape {
  code: MaintenanceFailureCode;
  retryable: boolean;
}

/**
 * 六种情形 → （规范化失败码, 是否可重试）。
 *
 * 写成 `Record<PersonaEvolutionFailureKind, …>`：新增或改名一种情形时这里**先编译不过**，
 * 消费方不会拿着过期的表去分类一个它没见过的失败。
 */
const PERSONA_EVOLUTION_FAILURE_TABLE: Record<
  PersonaEvolutionFailureKind,
  PersonaEvolutionFailureShape
> = {
  model_failure: { code: 'model_error', retryable: true },
  malformed_decision: { code: 'payload_unreadable', retryable: false },
  storage_conflict: { code: 'storage_error', retryable: true },
  missing_input: { code: 'delivery_missing', retryable: false },
  policy_failure: { code: 'policy_rejected', retryable: false },
  storage_failure: { code: 'storage_error', retryable: true },
};

/** 六种情形的**运行时**清单（顺序与真值表声明顺序一致） */
export const PERSONA_EVOLUTION_FAILURE_KINDS: readonly PersonaEvolutionFailureKind[] =
  Object.keys(PERSONA_EVOLUTION_FAILURE_TABLE) as PersonaEvolutionFailureKind[];

/** 把一种失败情形规范化成可落盘的分类（`message` 带上原始原因） */
export function personaEvolutionFailure(
  kind: PersonaEvolutionFailureKind,
  message: string,
): DeliveryFailureClassification {
  const shape = PERSONA_EVOLUTION_FAILURE_TABLE[kind];
  return knownDeliveryFailure(shape.code, message, shape.retryable);
}

/** 这六种情形里哪些是可以重投的（run 收尾与人工复核时读它） */
export function isRetryablePersonaEvolutionFailure(kind: PersonaEvolutionFailureKind): boolean {
  return PERSONA_EVOLUTION_FAILURE_TABLE[kind].retryable;
}

// ═══════════════════════════════════════════
//  判定契约
// ═══════════════════════════════════════════

/**
 * 错误对象上的稳定标识：跨进程、跨实例比对时不必依赖 `instanceof`（错误可能穿过多层包装）。
 * 聚合「这一族失败」时读它，不要读 message。
 */
export const PERSONA_EVOLUTION_DECISION_CONTRACT_CODE = 'persona_evolution_decision_contract';

/**
 * 违反契约的形状（与检查顺序一致，见 `assertPersonaEvolutionDecisionConsistent`）。
 *
 * 前十项判的是判定**自己的形状**（其中 `role_id` / `strategy_version` / `approval` /
 * `parent_version` / `input_snapshot_hash` 五项顺带也判与本次执行是否一致），后两项判它
 * **内部搭不搭**：`verdict_approval` 判结论与审核模式的配对，`verdict_combination` 判结论与
 * 正文、挡板、理由的搭配。分成三个标识（外加正文自己的 `persona_draft`）是因为它们指向
 * 四种不同的修法，聚合时不该混成一句「组合不对」。
 */
export type PersonaEvolutionViolation =
  | 'decision_shape'
  | 'verdict'
  | 'role_id'
  | 'strategy_version'
  | 'approval'
  | 'parent_version'
  | 'input_snapshot_hash'
  | 'reasons'
  | 'blocking_rules'
  | 'verdict_approval'
  | 'verdict_combination'
  | 'persona_draft';

/**
 * 策略返回的判定违反契约。
 *
 * 与 `PromotionDecisionContractError` 同一种形状：错误对象上带着**稳定的机器可读标识**
 * （`contract_code`）与逐条的现状值，聚合「这一族失败」时读标识，排查时读字段，两者都不必
 * 依赖会变的消息文本。`expected` / `actual` 是排查这道题的唯一线索——“父版本对不上”与
 * “父版本对不上、该是 v2 实际是 v1”在事后是两条完全不同的线索。
 */
export class PersonaEvolutionDecisionContractError extends Error {
  readonly contract_code = PERSONA_EVOLUTION_DECISION_CONTRACT_CODE;
  /** 违反的是哪一条契约（按检查顺序，一次只报第一条） */
  readonly violation: PersonaEvolutionViolation;
  readonly expected: string;
  readonly actual: string;
  readonly role_id: string;
  /**
   * 违反的是**结论与审核模式的配对**（`verdict_approval`）时，判定自报的那两个值；其余
   * violation 上为 undefined。
   *
   * 单列出来是因为它们合成一句话就不好聚合了：「哪一对组合被策略交回来了」是个可以跨 run
   * 计数的量，而 `expected` / `actual` 里那两个是给人读的组合串。
   */
  readonly verdict: string | undefined;
  readonly approval: string | undefined;

  constructor(
    message: string,
    details: {
      violation: PersonaEvolutionViolation;
      expected: string;
      actual: string;
      role_id: string;
      verdict?: string;
      approval?: string;
    },
  ) {
    super(message);
    this.name = 'PersonaEvolutionDecisionContractError';
    this.violation = details.violation;
    this.expected = details.expected;
    this.actual = details.actual;
    this.role_id = details.role_id;
    this.verdict = details.verdict;
    this.approval = details.approval;
  }
}

/** 这条错误是不是「策略判定违反契约」（按类与稳定 code 双重判定） */
export function isPersonaEvolutionDecisionContractError(
  error: unknown,
): error is PersonaEvolutionDecisionContractError {
  if (error instanceof PersonaEvolutionDecisionContractError) return true;
  if (typeof error !== 'object' || error === null) return false;
  return (
    (error as { contract_code?: unknown }).contract_code
    === PERSONA_EVOLUTION_DECISION_CONTRACT_CODE
  );
}

/**
 * `verdict` 与 `approval` 的合法配对表。
 *
 * 三个 `verdict` 里有两个带着审核模式的语义：`eligible` 的定义就是「够格**且本次是自动
 * 批准**」，`pending_review` 的定义是「够格**且本次是人工审核**」，只有 `rejected`
 * 与审核模式无关。把这张表写成 `Record<PersonaEvolutionVerdict, …>` 而不是一串 if：
 * 契约新增一个结论时这里**先编译不过**，校验器不会因为漏了一格而放行一份它没见过的判定。
 *
 * 配对判定放在「与本次执行对账」之后：跑到这一步时 `decision.approval` 已经等于运行值，
 * 因此这条校验等价的读法是「结论必须是本次运行有权得到的那一个」——人工审核的运行只可能
 * 得到 `pending_review` / `rejected`，自动批准的运行只可能得到 `eligible` / `rejected`。
 */
const VERDICT_APPROVAL_PAIRING: Record<
  PersonaEvolutionVerdict,
  readonly PersonaEvolutionApprovalMode[]
> = {
  eligible: ['auto_approve'],
  pending_review: ['manual_review'],
  rejected: ['auto_approve', 'manual_review'],
};

/**
 * 校验一条判定与本次执行是否自洽，不自洽就抛 `PersonaEvolutionDecisionContractError`。
 *
 * 它收的是 `unknown` 而不是 `PersonaEvolutionDecision`：类型只对写得出类型的那一侧成立，
 * 而这份值来自**注入的策略**——绕过 TypeScript 的实现完全可以让 `evaluate` 交回 `null`、
 * 一个标量，或一个 `verdict: 'typo'` 的对象。这道校验是契约唯一的执行点，因此先按**运行时
 * 真值**判形状，再判这份判定与本次执行的关系，最后判它**内部搭不搭**。
 *
 * 检查顺序即「最先被写出去的那个字段」的顺序：
 *
 * 1. **形状** —— 非 null 对象才有字段可读（数组不算一份判定）。
 * 2. **结论** —— 三个值之外的一律拒掉（挡住「拼错的 verdict 被写成一条正常拒绝」）。
 * 3. **角色 / 策略版本 / 审核模式 / 父版本 / 输入快照** —— 五项先各判自身合法，再判与本次
 *    执行一致。五项都会被原样写到别处：角色决定演化落到谁身上、版本进标记且是重评判据、
 *    审核模式决定这次能不能写 Persona、父版本是写回的前置条件、快照是幂等键的一半。
 * 4. **两个数组的形状** —— `reasons` 必须是非空字符串数组，`blocking_rules` 必须是已知
 *    规则名的数组：它们是审计里人读与聚合的两半。
 * 5. **结论与审核模式的配对** —— 见 `VERDICT_APPROVAL_PAIRING`。两个字段各自合法也可能
 *    合起来在说一件不可能的事：`eligible + manual_review` 会在一次只被授权「记下来」的
 *    运行里写出 Persona，`pending_review + auto_approve` 会把本该自动演化的角色冻结成等人工。
 * 6. **结论与正文/挡板/理由的搭配** —— 合格的结论必须给出五段非空正文且不带挡板；不合格
 *    的结论必须给出至少一条挡板与理由，且**不得带正文**（判成不合格却递来一份「新 Persona」，
 *    只会在审计里留下一个永远不会被写下去、却长得像结果的东西）。
 *
 * 这是调用方与策略之间的契约，不是数据校验：一份不自洽的判定只可能来自配置错误或实现缺陷，
 * 重投多少次都是同一份，因此调用方一律判成不可重试（`malformed_decision` 的死信）。
 *
 * 断言签名让调用方在校验之后直接拿到收窄过的判定：**写路径必须从这里开始**。
 */
export function assertPersonaEvolutionDecisionConsistent(
  decision: unknown,
  expected: {
    /** 被判定的角色（候选自己带过来，权威） */
    role_id: string;
    /** 本次运行的审核模式（运行选项，权威） */
    approval: PersonaEvolutionApprovalMode;
    /** 注入策略的版本，也是 run 审计里记下的那一个 */
    strategy_version: string;
    /** 判定所依据的父 Persona 版本（执行方读到的那一个，权威） */
    parent_version: number;
    /** 判定所依据的输入快照（执行方算出来的那一个，权威） */
    input_snapshot_hash: string;
  },
): asserts decision is PersonaEvolutionDecision {
  const { role_id, approval, strategy_version, parent_version, input_snapshot_hash } = expected;

  if (!isDecisionObject(decision)) {
    throw contractError('decision_shape', {
      expected: 'a persona evolution decision object',
      actual: describeValue(decision),
      role_id,
      detail:
        'there is no verdict to act on and no field that can be read safely, so nothing about this '
        + 'candidate can be settled',
    });
  }

  if (!isOneOf(decision.verdict, PERSONA_EVOLUTION_VERDICTS)) {
    throw contractError('verdict', {
      expected: PERSONA_EVOLUTION_VERDICTS.join(' | '),
      actual: describeValue(decision.verdict),
      role_id,
      detail:
        'only those verdicts have a defined outcome, and anything else would be settled as an '
        + 'ordinary rejection, hiding the strategy defect behind a plausible conclusion',
    });
  }

  if (!isNonEmptyString(decision.role_id)) {
    throw contractError('role_id', {
      expected: `a non-empty role id (this execution was claimed for "${role_id}")`,
      actual: describeValue(decision.role_id),
      role_id,
      detail: 'the conclusion would be recorded against a role the strategy never evaluated',
    });
  }

  if (decision.role_id !== role_id) {
    throw contractError('role_id', {
      expected: role_id,
      actual: decision.role_id,
      role_id,
      detail:
        'a persona version would be written to a role this execution was not claimed for, so two '
        + 'roles could both be evolved from one claim',
    });
  }

  if (!isNonEmptyString(decision.strategy_version)) {
    throw contractError('strategy_version', {
      expected: `a non-empty version string (the injected strategy declares "${strategy_version}")`,
      actual: describeValue(decision.strategy_version),
      role_id,
      detail:
        'the version is recorded on the marker as the verdict of whether this candidate is '
        + 're-evaluated, and it is half of the idempotency key',
    });
  }

  if (decision.strategy_version !== strategy_version) {
    throw contractError('strategy_version', {
      expected: strategy_version,
      actual: decision.strategy_version,
      role_id,
      detail:
        'the version recorded on the marker and on the run would split, and a version change is '
        + 'what makes this candidate eligible for re-evaluation',
    });
  }

  if (!isOneOf(decision.approval, PERSONA_EVOLUTION_APPROVAL_MODES)) {
    throw contractError('approval', {
      expected: PERSONA_EVOLUTION_APPROVAL_MODES.join(' | '),
      actual: describeValue(decision.approval),
      role_id,
      detail:
        'the approval mode is what decides whether this execution may write a Persona version',
    });
  }

  if (decision.approval !== approval) {
    throw contractError('approval', {
      expected: approval,
      actual: decision.approval,
      role_id,
      detail:
        approval === 'manual_review'
          ? 'it claims a verdict the run did not authorise, so a role under human review would be '
            + 'evolved as if it had been approved'
          : 'it claims a verdict the run did not authorise, so a role allowed to be evolved would '
            + 'be frozen waiting for a human that this run was supposed to make unnecessary',
    });
  }

  if (!isPositiveInteger(decision.parent_version)) {
    throw contractError('parent_version', {
      expected: `a positive integer parent version (this execution read v${String(parent_version)})`,
      actual: describeValue(decision.parent_version),
      role_id,
      detail:
        'the parent version is the precondition of the conditional write; without it a decision '
        + 'could overwrite a version produced by someone else',
    });
  }

  if (decision.parent_version !== parent_version) {
    throw contractError('parent_version', {
      expected: String(parent_version),
      actual: String(decision.parent_version),
      role_id,
      detail:
        'the decision is based on a version that is not the one this execution read, so writing it '
        + 'would silently discard whatever produced the newer version',
    });
  }

  if (!isNonEmptyString(decision.input_snapshot_hash)) {
    throw contractError('input_snapshot_hash', {
      expected: `a non-empty snapshot hash (this execution computed "${input_snapshot_hash}")`,
      actual: describeValue(decision.input_snapshot_hash),
      role_id,
      detail: 'the snapshot hash is half of the idempotency key, so a candidate could be judged '
        + 'twice from two different inputs without either being recorded',
    });
  }

  if (decision.input_snapshot_hash !== input_snapshot_hash) {
    throw contractError('input_snapshot_hash', {
      expected: input_snapshot_hash,
      actual: decision.input_snapshot_hash,
      role_id,
      detail:
        'the decision claims to be based on an input this execution never built, so the idempotency '
        + 'record would describe a snapshot that was never judged',
    });
  }

  if (!isNonEmptyStringArray(decision.reasons)) {
    throw contractError('reasons', {
      expected: 'an array of non-empty strings',
      actual: describeValue(decision.reasons),
      role_id,
      detail: 'the reasons are the human-readable half of the record and are written verbatim',
    });
  }

  if (!isBlockerRuleArray(decision.blocking_rules)) {
    throw contractError('blocking_rules', {
      expected: `an array of known blocker rules (${PERSONA_EVOLUTION_BLOCKER_RULES.join(' | ')})`,
      actual: describeValue(decision.blocking_rules),
      role_id,
      detail:
        'the blocker rules are the machine-readable half of the record, so an unknown name would '
        + 'be aggregated as a rule that does not exist',
    });
  }

  // 结论与审核模式的配对：两个字段各自都是合法值，合起来却可能描述一件不可能的事。放在两个
  // 数组之后、正文与搭配之前——它比「不合格缺理由」更根本（前者会让执行方走错分支，后者只是
  // 审计少一句话），但同样属于「这份判定内部自洽吗」，因此与结论组合同一个 violation 家族，
  // 只是各占一个稳定标识（verdict_approval / verdict_combination），聚合时读得出来是哪一种。
  const allowedApprovals = VERDICT_APPROVAL_PAIRING[decision.verdict];
  if (!allowedApprovals.includes(decision.approval)) {
    throw contractError('verdict_approval', {
      expected: `${decision.verdict} + ${allowedApprovals.join(' | ')}`,
      actual: `${decision.verdict} + ${decision.approval}`,
      role_id,
      verdict: decision.verdict,
      approval: decision.approval,
      detail:
        decision.verdict === 'eligible'
          ? 'an eligible verdict is only meaningful under auto_approve, and this run is in '
            + 'manual_review mode; a Persona version would be written in a run that was authorised '
            + 'to do nothing but record the qualification'
          : decision.verdict === 'pending_review'
            ? 'a pending_review verdict is only meaningful under manual_review, and this run is in '
              + 'auto_approve mode; the role would be frozen as waiting for a human that this run '
              + 'was supposed to make unnecessary'
            : 'a rejected verdict cannot be paired with this approval mode',
    });
  }

  if (decision.verdict === 'rejected') {
    if (decision.blocking_rules.length === 0) {
      throw contractError('verdict_combination', {
        expected: 'a rejected verdict with at least one blocking rule',
        actual: 'a rejected verdict with no blocking rules',
        role_id,
        detail: 'nothing would record why the evolution was turned down',
      });
    }
    if (decision.reasons.length === 0) {
      throw contractError('verdict_combination', {
        expected: 'a rejected verdict with at least one reason',
        actual: 'a rejected verdict with no reasons',
        role_id,
        detail: 'the blocking rules would be recorded without an explanation',
      });
    }
    if (decision.persona !== undefined) {
      throw contractError('verdict_combination', {
        expected: 'blocking-free qualified verdicts to carry the new persona; a rejected one must not',
        actual: `a rejected verdict carrying a persona draft (${describeValue(decision.persona)})`,
        role_id,
        detail:
          'nothing writes that draft, so in the audit it would sit next to "rejected" looking like '
          + 'a result the strategy produced but the run discarded',
      });
    }
  } else {
    if (decision.blocking_rules.length > 0) {
      throw contractError('verdict_combination', {
        expected: `blocking_rules to be empty for a "${decision.verdict}" verdict`,
        actual: `blocking_rules ${JSON.stringify(decision.blocking_rules)}`,
        role_id,
        detail: 'a role that qualifies cannot also be blocked by a rule',
      });
    }
    if (!isPersonaDraft(decision.persona)) {
      throw contractError('persona_draft', {
        expected: 'an object with five non-empty strings '
          + '(summary / skills_overview / experience_coverage / recent_performance / notes)',
        actual: describeValue(decision.persona),
        role_id,
        detail:
          'the whole point of this channel is the persona it produces, and there is no other '
          + 'source for it: an empty or malformed draft would be written into the Persona verbatim',
      });
    }
  }
}

/**
 * 策略返回值里**可以进审计**的那一部分。
 *
 * 判定在结果与 run 记录里是一个结构化字段（`decision?: PersonaEvolutionDecision`），而策略
 * 交回来的东西在运行时可能根本不是对象（`null`、字符串、`undefined`）。原样塞进去会写出一条
 * 形状对不上任何读口的记录；这里只保留「非 null 且非数组的对象」——它至少还能回答「策略
 * 返回了什么」。标量与空值无处可挂，它们只出现在失败消息的 actual 里。
 */
export function auditPersonaEvolutionDecision(
  value: unknown,
): PersonaEvolutionDecision | undefined {
  // 双重断言是刻意的：一个「运行时是对象」的值与 PersonaEvolutionDecision 之间没有可用的
  // 类型关系，这里只把「非 null 对象」这一层留在审计里，它是不是一份**合法**判定由
  // assertPersonaEvolutionDecisionConsistent 回答
  return isDecisionObject(value) ? (value as unknown as PersonaEvolutionDecision) : undefined;
}

/**
 * 判定违反契约时，演练路径与执行内核共用的一句话。
 *
 * 抽出来是因为演练路径会**自己抛自己的**契约错误而不是走执行内核，两处的诊断文案若各写
 * 一遍，早晚会对同一种不一致给出两种说法；而这条错误恰恰是要拿去做跨 run 聚合的。
 */
export function describePersonaEvolutionContractFailure(
  error: PersonaEvolutionDecisionContractError,
): string {
  return (
    `The strategy returned a decision that violates the persona evolution contract `
    + `(${error.violation}): expected "${error.expected}", got "${error.actual}".`
  );
}

/** 运行时是不是一份「判定对象」：非 null 且不是数组的 object */
function isDecisionObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 非空（去掉首尾空白之后仍有内容）的字符串 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 每个元素都是非空字符串的数组 */
function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

/** 每个元素都是**已知**挡板规则名的数组 */
function isBlockerRuleArray(value: unknown): value is PersonaEvolutionBlockerRule[] {
  return Array.isArray(value) && value.every((item) => isOneOf(item, PERSONA_EVOLUTION_BLOCKER_RULES));
}

/** 正整数（版本号） */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

const DRAFT_FIELDS = [
  'summary',
  'skills_overview',
  'experience_coverage',
  'recent_performance',
  'notes',
] as const;

/** 五段正文都在、且都是非空字符串 */
function isPersonaDraft(value: unknown): value is PersonaEvolutionPersonaDraft {
  if (!isDecisionObject(value)) return false;
  return DRAFT_FIELDS.every((field) => isNonEmptyString(value[field]));
}

/** `list` 里有没有这个运行时值（把 `readonly T[]` 的成员判断收窄成一个普通字符串比对） */
function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

/** 报告里一条 expected / actual 的最大长度；超了截断，免得一份畸形判定把消息撑爆 */
const MAX_DESCRIBED_VALUE_LENGTH = 160;

/**
 * 把任意运行时值渲染成一段短文本，给失败消息的 expected / actual 用。
 *
 * 渲染本身**不许成为新的失败源**：循环引用、抛错的 `toString`、`BigInt` 都在这里收敛成一句
 * 说明。字符串原样返回（消息模板自己会加引号），其余按 JSON / `String` 渲染。
 */
function describeValue(value: unknown): string {
  let text: string;
  try {
    if (typeof value === 'string') {
      text = value;
    } else if (value === null) {
      text = 'null';
    } else if (typeof value === 'object') {
      text = JSON.stringify(value) ?? 'null';
    } else {
      text = String(value);
    }
  } catch {
    text = `[a ${typeof value} that could not be rendered]`;
  }
  return text.length > MAX_DESCRIBED_VALUE_LENGTH
    ? `${text.slice(0, MAX_DESCRIBED_VALUE_LENGTH)}…`
    : text;
}

function contractError(
  violation: PersonaEvolutionViolation,
  details: {
    expected: string;
    actual: string;
    role_id: string;
    detail: string;
    /** 只有 `verdict_approval` 会带上这两个：判定自报的结论与审核模式 */
    verdict?: string;
    approval?: string;
  },
): PersonaEvolutionDecisionContractError {
  return new PersonaEvolutionDecisionContractError(
    `Persona evolution strategy returned an invalid decision for role `
      + `${details.role_id} (${violation}): expected "${details.expected}", got `
      + `"${details.actual}"; ${details.detail}. The decision contract is a configuration error, `
      + 'not a transient failure, so this candidate is not retried.',
    { violation, ...details },
  );
}
