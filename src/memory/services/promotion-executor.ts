/**
 * promotion-executor — 把一条已 claim 的候选执行到底（Phase 3-B）
 *
 * 这是 Skill Promotion 的**执行内核**：输入一条 claim 到的候选，输出它的终局。批量外壳
 * （claim 循环、run 审计、批大小与墙钟上限）在 Phase 3-C 的 job 里，本文件只回答「这一条
 * 该怎么办」。拆开是因为「一条候选的幂等语义」与「一批候选怎么调度」是两件可以分别审的
 * 事，前者错了会攒出重复技能，后者错了只是慢。
 *
 * 一次执行的三条出口，对应计划 §10 的三条处理规则：
 *
 *   判定不合格        → complete(outcome='rejected')        —— 只记结论，不写 Skill
 *   判定合格·人工审核 → complete(outcome='pending_review')  —— 只记结论，不写 Skill
 *   判定合格·自动批准 → saveSkillIfAbsent() → complete(outcome='promoted', skill_id)
 *
 * 第三条的两段写是这条通道的幂等要害：**先写 Skill、再回写经验**，第二步失败时整条重试。
 * 只要 Skill 的写入是 `saveSkillIfAbsent`（唯一键 `(role_id, promoted_from)`），重试就必然
 * 命中同一条技能——「同一 Experience 不产生第二条 Skill」的全部依据在这里，而不是靠调用方
 * 记住上一轮写过什么。经验侧的 `promoted_to` 与晋升结论由 `completePromotion` 在**一次**
 * 条件写里落定，因此不存在「Skill 已存在、经验还没绑上」这个可被读到的中间态。
 *
 * 第二步要写进去的是一条**跨实体的引用**，所以它还会被存储侧再验一次：那条技能必须存在、
 * 属于本 Agent、且来源就是这条经验（判据见 ./promotion-integrity）。本执行器给的 id 来自
 * 刚刚那次 `saveSkillIfAbsent`，正常情况下必然成立；不成立意味着存储里发生了别的事（技能
 * 被删/被转移，或调用方塞了一条不属于这里的 id），此时 `completePromotion` 抛完整性错误，
 * 下面那张分类表把它判为不可重试——**不会**把 `promoted_to` 写成指向别人的指针，也不会
 * 拿这条永远不会成立的引用去占满重试名额。
 *
 * **策略返回值是一道契约**（`assertPromotionDecisionConsistent`）：判定合格与否不只是策略
 * 自己的事，因为判定里有三个字段会被**原样写到别处**——`strategy_version` 进 Experience 的
 * 晋升标记、`experience_id` 决定这条结论挂给谁、`approval` 决定这次是否允许写 Skill。一个
 * 声明自己是 v1 却返回 v2 的策略会让经验记着 v2 而 run 记着 v1（同一条经验被两个版本各评
 * 一次，审计分裂且反复重评），一条返回别人 id 的判定会把结论写到另一条经验上。这些都不是
 * 「重投能修好」的抖动，而是配置/实现的错，因此在**写任何东西之前**就拒掉，按不可重试落盘
 * 进死信，并在消息里带上期望值与实际值。校验刻意放在执行内核而不是 job 的入口：内核也可以
 * 被别的调用方（脚本、后续的调度器）直接使用，契约不该由某一个外壳代为执行。
 *
 * 这道契约在**运行时不靠类型**（`assertPromotionDecisionConsistent` 收的是 `unknown`）：注入
 * 的策略可以绕过 TypeScript 交回 `null`、标量，或一个 `verdict: 'typo'` 的对象。最贵的一种
 * 是这个拼错的 verdict——它是个普通字符串，会一路滑过「非 eligible、非 pending_review」的
 * 判断被写成一条正常的 `rejected` 结论，实现错误就此伪装成判决结果，也不会进死信。因此校验
 * 先按真值表判形状（对象 / 三个结论 / 两个审核模式 / 非空版本与非空经验 id / 两个数组的元素
 * 逐个判），再判结论组合，**最后**才与本次执行对账。`reasons` 与 `blocking_rules` 的元素级
 * 检查同理：它们是审计里人读与聚合的两半，一个空串或一个不存在的规则名写进去就再也分辨不出
 * 「策略拒了它」和「策略写错了」。
 *
 * 失败一律走 `failPromotion`（带 claim token 的 fencing 写），由共享状态机决定是退避重投
 * 还是死信。分类表（`classifyPromotionFailure`）：
 *
 * | 情形 | 分类 | 去向 |
 * | --- | --- | --- |
 * | Agent 不在了 | delivery_missing | 死信——重投不会让 Agent 回来 |
 * | 载荷解析不了（ZodError） | payload_unreadable | 死信——重投读到的是同一份坏数据 |
 * | 技能引用不成立（不存在 / 跨 Agent / 来源不符） | storage_error | 死信——重投不会让这条引用成立 |
 * | 策略返回的判定违反契约（形状 / 结论 / 版本 / 经验 id / 审核模式 / 数组元素 / 结论组合对不上） | payload_unreadable | 死信——同一次判定重投多少次都是同一份错结论 |
 * | 连接/超时类 errno | downstream_unavailable | 退避重投 |
 * | 权限/路径类 errno | storage_error | 死信 |
 * | Skill 写了、经验没回写 | storage_error（显式可重试）| 退避重投，重试复用同一条 Skill |
 * | 其余 | unknown | 退避重投（有上限，用满进死信）|
 *
 * 「Experience 不在了」不走分类：它是**结构性**的，由条件写自己回答——经验被删掉时
 * `completePromotion` / `failPromotion` 读不到那一行，返回 undefined，执行结果就是 `failed`。
 * 没有异常可分类，也就没有需要猜的东西。
 *
 * claim 已经不在我们手里时（token 失效 / 租约过期 / 经验被删）**什么都不写**，返回 `failed`：
 * 那不是「处理失败」，是「这次没轮到我们」——落盘的责任归当前持有者，硬写只会把别人的
 * 结论盖掉。同理，失败本身也写不下去时（载荷损坏），返回值里仍然带着规范化分类，交给
 * 上层 run 记录，审计信息不会因为写不进存储而消失。
 *
 * 已知的、刻意留下的一个窗口：判定用的是 claim 那一刻读到的经验快照。若在 claim 与判定之间
 * 恰好有一条反馈落库，被判定的置信度就是旧值。窗口是一次纯函数求值的长度（无 IO），而经验
 * 的回写不会因此丢东西——`completePromotion` 保留读到的其余字段；但「按旧置信度晋升」这件事
 * 本身仍可能发生。要收紧它得让判定与 claim 同处一个临界区（或让回写带上「置信度未变」的
 * 前提），那是接口层的改动，不在本阶段范围内。
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import {
  classifyDeliveryFailure,
  knownDeliveryFailure,
  type DeliveryFailureClassification,
} from './delivery-error-classification';
import type { DeliveryRetryPolicy } from './delivery-lifecycle';
import { isPromotionSkillIntegrityError } from './promotion-integrity';
import type {
  ClaimedPromotionCandidate,
  MemoryRepository,
  SkillSaveResult,
} from '../ports/memory-repository';
import {
  PROMOTION_APPROVAL_MODES,
  PROMOTION_BLOCKER_RULES,
  PROMOTION_VERDICTS,
  type PromotionApprovalMode,
  type PromotionBlockerRule,
  type PromotionDecision,
  type PromotionStrategy,
} from '../ports/promotion-strategy';
import type { ExperienceRecord, PromotionOutcome, SkillRecord } from '../schemas';

/** 一条候选执行完之后落在哪里（复用 job 契约里的那组词，去掉「没轮到我们」以外的分支） */
export type PromotionExecutionStatus =
  | 'promoted'
  | 'pending_review'
  | 'rejected'
  | 'retried'
  | 'dead_letter'
  | 'failed';

/** 执行内核的构造依赖：只接端口，不接具体后端 */
export interface PromotionExecutorDeps {
  /** 经验与技能的读写面（Skill 幂等写入、经验回写、失败落盘都在这里） */
  repository: MemoryRepository;
  /** 逐条判定的策略（版本与阈值都带着它） */
  strategy: PromotionStrategy;
  /** 重试预算；缺省用 DEFAULT_PROMOTION_RETRY_POLICY */
  policy?: DeliveryRetryPolicy;
  /** 参考时刻（测试注入）；缺省取系统时间 */
  now?: () => string;
  /** 交叉核对的持有者标识；缺省不做 owner 核对（真正的 fencing 是 claim token） */
  owner?: string;
}

/** 单条执行的可变参数 */
export interface PromotionExecutionOptions {
  /** 本次运行的审核模式：合格之后是晋升还是只记 pending_review */
  approval: PromotionApprovalMode;
  /** 本次的参考时刻；缺省取 deps.now()，再缺省取系统时间 */
  now?: string;
}

/** 一条候选的执行结果：既给 run 计数，也给事后排查 */
export interface PromotionExecutionResult {
  status: PromotionExecutionStatus;
  role_id: string;
  experience_id: string;
  /** 执行前这条候选的投递次数（claim 时已经 +1） */
  attempt_count: number;
  /** 策略判定；判定本身抛错时缺席 */
  decision?: PromotionDecision;
  /** 晋升产出的 Skill id；`promoted` 时才有 */
  skill_id?: string;
  /** 复用了一条已存在的同源 Skill（上一次尝试写成功、经验没回写，或并发的一方先写进去了） */
  skill_reused?: boolean;
  /** 失败时的规范化分类；成功与跳过时为缺席 */
  failure?: DeliveryFailureClassification;
  /** 不构成失败但需要人看见的事实 */
  warnings: string[];
}

/**
 * 执行一条已 claim 的候选。
 *
 * 调用方必须传**刚刚 claim 到**的候选（带 claim_token）：函数内的每一次写回都拿它当凭据，
 * 凭据失效就什么都写不进去。不抛错——所有失败都变成带 `failure` 的结果，让批量外壳得以
 * 单条隔离、批次部分成功。
 */
export async function executePromotionCandidate(
  deps: PromotionExecutorDeps,
  candidate: ClaimedPromotionCandidate,
  options: PromotionExecutionOptions,
): Promise<PromotionExecutionResult> {
  const now = options.now ?? deps.now?.() ?? nowTimestamp();
  const { role_id, experience, claim_token, attempt_count } = candidate;

  // 策略交回来的东西在运行时是**未知的**：自定义策略可以绕过类型层，交回 null、标量，或一个
  // 字段自相矛盾的对象。因此它先落在 `unknown` 上，由契约校验决定它能不能往下走。
  let returned: unknown;
  try {
    returned = await deps.strategy.evaluate({
      role_id,
      experience,
      now,
      approval: options.approval,
    });
  } catch (error) {
    // 策略自己抛错（配置非法、注入的实现有 bug）：按通用分类落盘，不让它掀掉整批
    return recordFailure(deps, candidate, classifyPromotionFailure(error), now, {});
  }

  try {
    // 契约校验必须在写任何东西之前：判定里的版本、经验 id 与审核模式都会被原样落到别处，
    // 对不上就意味着这次执行会写出一条与 run 审计对不上的记录；形状不合法的判定（拼错的
    // verdict、缺席的字段、不是数组的理由）也在这里被挡住，不会退化成一条 rejected 结论
    assertPromotionDecisionConsistent(returned, {
      experience_id: experience.id,
      approval: options.approval,
      strategy_version: deps.strategy.version,
    });
  } catch (error) {
    // 校验要拒的正是这份判定，audit 里必须留着它到底返回了什么——只留一句「对不上」而不留
    // 对不上的那个值，排查时还得去复现一次才看得到。只有形状上确实是一份判定的返回值进得了
    // 审计（标量与空值无处可挂），它同样只出现在失败消息的 actual 里。
    const audited = auditPromotionDecision(returned);
    return recordFailure(deps, candidate, classifyPromotionFailure(error), now, {
      ...(audited !== undefined ? { decision: audited } : {}),
    });
  }

  // 走到这里返回值已经过契约校验（断言签名把它收窄成一份合法判定），写路径才开始
  const decision: PromotionDecision = returned;

  if (decision.verdict !== 'eligible') {
    const outcome: PromotionOutcome =
      decision.verdict === 'pending_review' ? 'pending_review' : 'rejected';
    return settleDecision(deps, candidate, decision, outcome, now);
  }

  // ── 自动批准：先原子写 Skill，再回写经验 ────────────────────────────
  let saved: SkillSaveResult;
  try {
    saved = await deps.repository.saveSkillIfAbsent(
      role_id,
      buildPromotedSkill(role_id, experience, now, options.approval),
    );
  } catch (error) {
    return recordFailure(deps, candidate, classifyPromotionFailure(error), now, { decision });
  }

  const warnings = saved.created
    ? []
    : [
        `Skill ${saved.skill.id} already existed for experience ${experience.id}; reused it instead of writing a duplicate.`,
      ];

  let completed: ExperienceRecord | undefined;
  try {
    completed = await deps.repository.completePromotion({
      role_id,
      experience_id: experience.id,
      claim_token,
      ...(deps.owner !== undefined ? { owner: deps.owner } : {}),
      outcome: 'promoted',
      // 版本取注入策略的那一个：上面已经校验过判定自带的是同一个，这里用哪一个都不改变
      // 结果，但取这一个让「run 记的版本 = 经验记的版本 = 真正判定用的版本」在写入口就是
      // 同一个来源，而不是靠三处各自传递得恰好一致
      strategy_version: deps.strategy.version,
      reasons: decision.reasons,
      skill_id: saved.skill.id,
      now,
    });
  } catch (error) {
    return recordFailure(deps, candidate, classifyPromotionFailure(error), now, {
      decision,
      warnings,
      skill_reused: !saved.created,
    });
  }

  if (completed) {
    return {
      status: 'promoted',
      role_id,
      experience_id: experience.id,
      attempt_count,
      decision,
      skill_id: saved.skill.id,
      skill_reused: !saved.created,
      warnings,
    };
  }

  // Skill 已经进了库、经验却没回写——这正是「重试复用原 Skill」要覆盖的形状。走同一条失败
  // 记录路径（显式可重试）：下一轮 claim 时 saveSkillIfAbsent 会命中同一条，经验最终指向唯一
  // 的那个 skill id。失败原因里带上 skill id，排查时不必去库里反查。
  return recordFailure(
    deps,
    candidate,
    knownDeliveryFailure(
      'storage_error',
      `Skill ${saved.skill.id} was stored but the experience write-back did not apply (claim lost, lease expired, or a concurrent write won); the next attempt reuses the same Skill.`,
      true,
    ),
    now,
    { decision, warnings, skill_reused: !saved.created },
  );
}

/**
 * 错误对象上的稳定标识：跨进程、跨实例比对时不必依赖 `instanceof`（错误可能穿过多层包装）。
 * 聚合「这一族失败」时读它，不要读 message。
 */
export const PROMOTION_DECISION_CONTRACT_CODE = 'promotion_decision_contract';

/**
 * 策略返回的判定违反契约。
 *
 * 与 `PromotionSkillIntegrityError` 同一种形状：错误对象上带着**稳定的机器可读标识**
 * （`contract_code`）与逐条的现状值，聚合「这一族失败」时读标识，排查时读字段，两者都不必
 * 依赖会变的消息文本。`expected` / `actual` 是排查这道题的唯一线索——「版本对不上」与
 * 「版本对不上、该是 v1 实际是 v2」在事后是两条完全不同的线索。
 */
export class PromotionDecisionContractError extends Error {
  readonly contract_code = PROMOTION_DECISION_CONTRACT_CODE;
  /** 违反的是哪一条契约（按检查顺序，一次只报第一条） */
  readonly violation: PromotionDecisionViolation;
  readonly expected: string;
  readonly actual: string;
  readonly experience_id: string;

  constructor(
    message: string,
    details: {
      violation: PromotionDecisionViolation;
      expected: string;
      actual: string;
      experience_id: string;
    },
  ) {
    super(message);
    this.name = 'PromotionDecisionContractError';
    this.violation = details.violation;
    this.expected = details.expected;
    this.actual = details.actual;
    this.experience_id = details.experience_id;
  }
}

/** 这条错误是不是「策略判定违反契约」（按类与稳定 code 双重判定） */
export function isPromotionDecisionContractError(
  error: unknown,
): error is PromotionDecisionContractError {
  if (error instanceof PromotionDecisionContractError) return true;
  if (typeof error !== 'object' || error === null) return false;
  return (error as { contract_code?: unknown }).contract_code === PROMOTION_DECISION_CONTRACT_CODE;
}

/**
 * 校验一条判定与本次执行是否自洽，不自洽就抛 `PromotionDecisionContractError`。
 *
 * 它收的是 `unknown` 而不是 `PromotionDecision`：类型只对写得出类型的那一侧成立，而这份值
 * 来自**注入的策略**——绕过 TypeScript 的实现（脚本、编译过来的别的语言、测试替身）完全
 * 可以让 `evaluate` 交回 `null`、一个标量，或一个 `verdict: 'typo'` 的对象。这道校验是契约
 * 唯一的执行点，因此先按**运行时真值**判形状，再判这份判定与本次执行的关系。
 *
 * 检查顺序即「最先被写出去的那个字段」的顺序，每一层各自挡一类具体的事故：
 *
 * 1. **形状** —— 非 null 对象才有字段可读（数组不算一份判定）。形状不对时没有 `verdict`
 *    可言，也没有任何字段可以安全地读出来。
 * 2. **结论** —— 三个值之外的一律拒掉。这一条挡的是最贵的一类策略缺陷：拼错的 `verdict`
 *    是个普通字符串，执行内核只能按「eligible / pending_review / 其余」三分支走，于是它会
 *    被写成一条正常的 `rejected` 结论——实现错误伪装成判决结果，还进不了死信。
 * 3. **版本 / 经验 id / 审核模式** —— 先各判「是不是非空字符串（或合法枚举）」，再判与本次
 *    执行是否一致。三个字段都会被原样写到别处：版本进经验的晋升标记（版本变更是重评判据，
 *    分裂会让同一条经验被两个版本各判一次）、经验 id 决定结论挂给谁、审核模式决定这次能不能
 *    写 Skill。
 * 4. **两个数组的形状** —— `reasons` 必须是非空字符串数组，`blocking_rules` 必须是已知规则
 *    名的数组。它们是审计里人读与聚合的两半，一个空串或一个不存在的规则名写进去，事后就
 *    分辨不出「策略拒了它」和「策略写错了」。
 * 5. **结论组合** —— `rejected` 必须给出挡住的规则与理由（否则「为什么被拒」不可审计），
 *    `eligible` / `pending_review` 不得带挡住的规则（合格就不该有规则挡着）。
 *
 * 这是调用方与策略之间的契约，不是数据校验：一份不自洽的判定只可能来自配置错误或实现缺陷，
 * 重投多少次都是同一份，因此调用方一律判成不可重试（`classifyPromotionFailure` 把它落成
 * `payload_unreadable` 的死信）。
 *
 * 断言签名让调用方在校验之后直接拿到收窄过的判定：**写路径必须从这里开始**。
 */
export function assertPromotionDecisionConsistent(
  decision: unknown,
  expected: {
    /** 被判定的那条经验（候选自己带过来，权威） */
    experience_id: string;
    /** 本次运行的审核模式（运行选项，权威） */
    approval: PromotionApprovalMode;
    /** 注入策略的版本，也是 run 审计里记下的那一个 */
    strategy_version: string;
  },
): asserts decision is PromotionDecision {
  const { experience_id, approval, strategy_version } = expected;

  if (!isDecisionObject(decision)) {
    throw contractError('decision_shape', {
      expected: 'a promotion decision object',
      actual: describeValue(decision),
      experience_id,
      detail:
        'there is no verdict to act on and no field that can be read safely, so nothing about this '
        + 'candidate can be settled',
    });
  }

  if (!isOneOf(decision.verdict, PROMOTION_VERDICTS)) {
    throw contractError('verdict', {
      expected: PROMOTION_VERDICTS.join(' | '),
      actual: describeValue(decision.verdict),
      experience_id,
      detail:
        'only those verdicts have a defined outcome, and anything else would be settled as an '
        + 'ordinary rejection, hiding the strategy defect behind a plausible conclusion',
    });
  }

  if (!isNonEmptyString(decision.strategy_version)) {
    throw contractError('strategy_version', {
      expected: `a non-empty version string (the injected strategy declares "${strategy_version}")`,
      actual: describeValue(decision.strategy_version),
      experience_id,
      detail:
        'the version is recorded on the experience as the marker that decides whether the '
        + 'candidate is re-evaluated',
    });
  }

  if (decision.strategy_version !== strategy_version) {
    throw contractError('strategy_version', {
      expected: strategy_version,
      actual: decision.strategy_version,
      experience_id,
      detail:
        'the version recorded on the experience and on the run would split, and a version change '
        + 'is what makes this candidate eligible for re-evaluation',
    });
  }

  if (!isNonEmptyString(decision.experience_id)) {
    throw contractError('experience_id', {
      expected: `a non-empty experience id (this execution was claimed for "${experience_id}")`,
      actual: describeValue(decision.experience_id),
      experience_id,
      detail:
        'the conclusion would be recorded against nothing that can be reconciled with the claim',
    });
  }

  if (decision.experience_id !== experience_id) {
    throw contractError('experience_id', {
      expected: experience_id,
      actual: decision.experience_id,
      experience_id,
      detail: 'the conclusion would be written to an experience the strategy never evaluated',
    });
  }

  if (!isOneOf(decision.approval, PROMOTION_APPROVAL_MODES)) {
    throw contractError('approval', {
      expected: PROMOTION_APPROVAL_MODES.join(' | '),
      actual: describeValue(decision.approval),
      experience_id,
      detail:
        'the approval mode is what decides whether this execution may write a Skill, and it is '
        + 'written to the experience verbatim',
    });
  }

  if (decision.approval !== approval) {
    throw contractError('approval', {
      expected: approval,
      actual: decision.approval,
      experience_id,
      detail:
        approval === 'manual_review'
          ? 'it claims a verdict the run did not authorise, so a candidate under human review '
            + 'would be settled as if it had been approved'
          : 'it claims a verdict the run did not authorise, so a candidate allowed to be promoted '
            + 'would be settled as if a human still had to look at it',
    });
  }

  if (!isNonEmptyStringArray(decision.reasons)) {
    throw contractError('reasons', {
      expected: 'an array of non-empty strings',
      actual: describeValue(decision.reasons),
      experience_id,
      detail: 'the reasons are the human-readable half of the record and are written verbatim',
    });
  }

  if (!isBlockerRuleArray(decision.blocking_rules)) {
    throw contractError('blocking_rules', {
      expected: `an array of known blocker rules (${PROMOTION_BLOCKER_RULES.join(' | ')})`,
      actual: describeValue(decision.blocking_rules),
      experience_id,
      detail:
        'the blocker rules are the machine-readable half of the record, so an unknown name would '
        + 'be aggregated as a rule that does not exist',
    });
  }

  if (decision.verdict === 'rejected') {
    if (decision.blocking_rules.length === 0) {
      throw contractError('verdict_combination', {
        expected: 'a rejected verdict with at least one blocking rule',
        actual: 'a rejected verdict with no blocking rules',
        experience_id,
        detail: 'nothing would record why the candidate was turned down',
      });
    }
    if (decision.reasons.length === 0) {
      throw contractError('verdict_combination', {
        expected: 'a rejected verdict with at least one reason',
        actual: 'a rejected verdict with no reasons',
        experience_id,
        detail: 'the blocking rules would be recorded without an explanation',
      });
    }
  } else if (decision.blocking_rules.length > 0) {
    throw contractError('verdict_combination', {
      expected: `blocking_rules to be empty for a "${decision.verdict}" verdict`,
      actual: `blocking_rules ${JSON.stringify(decision.blocking_rules)}`,
      experience_id,
      detail: 'a candidate that qualifies cannot also be blocked by a rule',
    });
  }
}

/**
 * 违反契约的形状（与检查顺序一致，见 `assertPromotionDecisionConsistent`）。
 *
 * 前七项判的是判定**自己的形状**（其中 `strategy_version` / `experience_id` / `approval`
 * 三项顺带也判与本次执行是否一致），最后一项判结论组合。
 */
export type PromotionDecisionViolation =
  | 'decision_shape'
  | 'verdict'
  | 'strategy_version'
  | 'experience_id'
  | 'approval'
  | 'reasons'
  | 'blocking_rules'
  | 'verdict_combination';

/**
 * 策略返回值里**可以进审计**的那一部分。
 *
 * 判定在结果与 run 记录里是一个结构化字段（`decision?: PromotionDecision`），而策略交回来的
 * 东西在运行时可能根本不是对象（`null`、字符串、`undefined`）。原样塞进去会写出一条形状对不上
 * 任何读口的记录；这里只保留「非 null 且非数组的对象」——它至少还能回答「策略返回了什么」。
 * 标量与空值无处可挂，它们只出现在失败消息的 actual 里（`describeValue` 负责渲染）。
 */
export function auditPromotionDecision(value: unknown): PromotionDecision | undefined {
  // 双重断言是刻意的：一个「运行时是对象」的值与 PromotionDecision 之间没有可用的类型关系，
  // 这里只把「非 null 对象」这一层留在审计里，它是不是一份**合法**判定由
  // assertPromotionDecisionConsistent 回答，读这个字段的人也应当先过那道校验
  return isDecisionObject(value) ? (value as unknown as PromotionDecision) : undefined;
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
function isBlockerRuleArray(value: unknown): value is PromotionBlockerRule[] {
  return Array.isArray(value) && value.every((item) => isOneOf(item, PROMOTION_BLOCKER_RULES));
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
  violation: PromotionDecisionViolation,
  details: { expected: string; actual: string; experience_id: string; detail: string },
): PromotionDecisionContractError {
  return new PromotionDecisionContractError(
    `Promotion strategy returned an invalid decision for experience `
      + `${details.experience_id} (${violation}): expected "${details.expected}", got `
      + `"${details.actual}"; ${details.detail}. The decision contract is a configuration error, `
      + 'not a transient failure, so this candidate is not retried.',
    { violation, ...details },
  );
}

/**
 * 判定违反契约时，演练路径与执行内核共用的一句话。
 *
 * 抽出来是因为演练路径（job 的 previewOne）会**自己抛自己的**契约错误而不是走执行内核，
 * 两处的诊断文案若各写一遍，早晚会对同一种不一致给出两种说法；而这条错误恰恰是要拿去做
 * 跨 run 聚合的。期望值与实际值都在里面——那正是排查这道题需要的两个数。
 */
export function describeContractFailure(error: PromotionDecisionContractError): string {
  return `The strategy returned a decision that violates the promotion contract (${error.violation}): expected "${error.expected}", got "${error.actual}".`;
}

/**
 * 判定合格但不需要写 Skill 的两条出口（pending_review / rejected）。
 *
 * 落结论用的是同一条带 token 的条件写：凭据失效就什么都不写，返回 `failed`。
 */
async function settleDecision(
  deps: PromotionExecutorDeps,
  candidate: ClaimedPromotionCandidate,
  decision: PromotionDecision,
  outcome: PromotionOutcome,
  now: string,
): Promise<PromotionExecutionResult> {
  const { role_id, experience, claim_token, attempt_count } = candidate;
  let completed: ExperienceRecord | undefined;
  try {
    completed = await deps.repository.completePromotion({
      role_id,
      experience_id: experience.id,
      claim_token,
      ...(deps.owner !== undefined ? { owner: deps.owner } : {}),
      outcome,
      strategy_version: decision.strategy_version,
      reasons: decision.reasons,
      now,
    });
  } catch (error) {
    return recordFailure(deps, candidate, classifyPromotionFailure(error), now, { decision });
  }

  if (completed) {
    return {
      status: outcome,
      role_id,
      experience_id: experience.id,
      attempt_count,
      decision,
      warnings: [],
    };
  }

  // 凭据失效：结论没写进去，持有者已经换人（或经验已被删）。落盘的责任归当前持有者。
  return {
    status: 'failed',
    role_id,
    experience_id: experience.id,
    attempt_count,
    decision,
    failure: knownDeliveryFailure(
      'delivery_missing',
      `Promotion claim for experience ${experience.id} was lost before the "${outcome}" conclusion could be written.`,
      false,
    ),
    warnings: [],
  };
}

/**
 * 记一次失败：交给共享状态机决定退避重投还是死信。
 *
 * 返回值里始终带着传进来的 `failure`——即使失败本身也没能写进存储（载荷损坏、存储不可用），
 * 上层 run 仍能记下规范化分类与原因，审计信息不会因为写不下去而消失。
 */
async function recordFailure(
  deps: PromotionExecutorDeps,
  candidate: ClaimedPromotionCandidate,
  failure: DeliveryFailureClassification,
  now: string,
  extra: { decision?: PromotionDecision; warnings?: string[]; skill_reused?: boolean },
): Promise<PromotionExecutionResult> {
  const base: PromotionExecutionResult = {
    status: 'failed',
    role_id: candidate.role_id,
    experience_id: candidate.experience.id,
    attempt_count: candidate.attempt_count,
    ...(extra.decision !== undefined ? { decision: extra.decision } : {}),
    ...(extra.skill_reused !== undefined ? { skill_reused: extra.skill_reused } : {}),
    failure,
    warnings: extra.warnings ?? [],
  };

  let failed: ExperienceRecord | undefined;
  try {
    failed = await deps.repository.failPromotion({
      role_id: candidate.role_id,
      experience_id: candidate.experience.id,
      claim_token: candidate.claim_token,
      ...(deps.owner !== undefined ? { owner: deps.owner } : {}),
      error: failure.message,
      retryable: failure.retryable,
      now,
      ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
    });
  } catch {
    // 连失败都写不下去（同一份坏载荷挡住了读写两侧）：审计留在返回值里
    return base;
  }

  // failPromotion 返回 undefined = 凭据已失效，我们什么都没写
  if (!failed) return base;
  return {
    ...base,
    status: failed.promotion?.status === 'dead_letter' ? 'dead_letter' : 'retried',
  };
}

/**
 * 由经验构造晋升技能。
 *
 * 自动批准时直接写成 `approved`（与既有系统 `NEWIDE_B_SKILL_AUTO_APPROVE=1` 的终态一致，
 * `reviewed_by` 沿用同一个值），而不是先写 `pending` 再补一次 `updateSkill`：那第二笔写
 * 一旦失败，经验已被标成已晋升、技能却永远停在待审核，没有任何东西会再去批准它。多写一步
 * 换来的不是一个状态，是一条永不收敛的分支。
 */
export function buildPromotedSkill(
  role_id: string,
  experience: ExperienceRecord,
  now: string,
  approval: PromotionApprovalMode,
): SkillRecord {
  const autoApproved = approval === 'auto_approve';
  return {
    id: randomUUID(),
    description: experience.description,
    description_embedding: experience.description_embedding,
    content: experience.content,
    version: '1.0.0',
    review_status: autoApproved ? 'approved' : 'pending',
    tags: [...experience.tags],
    promoted_from: experience.id,
    promoted_at: now,
    agent_id: role_id,
    market_status: 'available',
    ...(autoApproved
      ? { reviewed_by: 'system:auto-approval', reviewed_at: now }
      : {}),
    created_at: now,
    updated_at: now,
  };
}

/**
 * 把执行期的异常映射成「可重试吗」与规范化失败码。
 *
 * 在通用分类之上加三类判断，都是「异常的形状回答不了、只有本通道知道」的：
 *
 * 1. **归属的 Agent 不在了**。两个后端抛的都是普通 Error，判据取它们各自的固定信号：
 *
 *    - InMemory 的 `requireStore` 抛 `Agent not found: <id>`（`AGENT_MISSING_PREFIX`）；
 *    - PG/PGlite 上这条状态其实不可达（`memory_experiences` 对 `memory_agents` 是
 *      `ON DELETE CASCADE`，Agent 没了经验也没了，根本扫不出候选），但若 INSERT 恰好撞上
 *      归属行消失，Postgres 报的是外键冲突 `23503`——一并按同一结论处理，免得它落进
 *      `unknown`（可重试）白重投五次。
 *
 * 2. **技能引用不成立**（`PromotionSkillIntegrityError`）：同一条不成立的引用，重投多少次
 *    都不成立。
 * 3. **策略判定违反契约**（`PromotionDecisionContractError`：形状不合法，或与本次执行对不上）：
 *    同一次判定重投多少次都还是那一份，修它的是改配置或改实现。这一类按 `payload_unreadable`
 *    落死信——它是「这条投递的内容我读不懂」的另一种形状，与坏数据同一条理由，而不是
 *    `unknown` 白占重试名额。
 *
 * 这些信号由 promotion-executor 的契约测试钉住：适配器改了措辞或换了 SQLSTATE，那条
 * 测试先红，而不是让分类悄悄退化。
 */
export function classifyPromotionFailure(error: unknown): DeliveryFailureClassification {
  const message = error instanceof Error ? error.message : String(error);
  // 引用不成立（技能不存在 / 属于别的 Agent / 来源是另一条经验）：递来的是一条永远不会
  // 成立的引用，重投多少次都是同一句拒绝。按存储侧的完整性错误落死信，而不是掉进
  // `unknown`（可重试）白占五次名额。
  if (isPromotionSkillIntegrityError(error)) {
    return knownDeliveryFailure(
      'storage_error',
      `${message} (the reference itself is invalid, so retrying cannot fix it; this candidate needs human review)`,
      false,
    );
  }
  // 策略判定违反契约（形状 / 结论 / 版本 / 经验 id / 审核模式 / 数组元素 / 结论组合）：同一次
  // 判定重投多少次都还是那一份，修它的是改配置或改策略实现，不是再跑一遍。按
  // `payload_unreadable`（坏输入，重试无意义）落死信，而不是掉进 `unknown`（可重试）白占名额。
  if (isPromotionDecisionContractError(error)) {
    return knownDeliveryFailure(
      'payload_unreadable',
      `${message} (the strategy decision itself is invalid, so retrying cannot fix it; this is a configuration error or a strategy defect that needs a human)`,
      false,
    );
  }
  if (message.startsWith(AGENT_MISSING_PREFIX) || isForeignKeyViolation(error)) {
    return knownDeliveryFailure(
      'delivery_missing',
      `${message} (the owning Agent was removed while this experience was being promoted; re-running will not bring it back)`,
      false,
    );
  }
  return classifyDeliveryFailure(error);
}

/** 适配器表示「这个 Agent 不在了」的消息前缀（InMemory 的 requireStore 与 Pg 的 requireAgentRow 都用它） */
export const AGENT_MISSING_PREFIX = 'Agent not found:';

/** Postgres 外键冲突的 SQLSTATE：技能要被挂到一个不存在的 Agent 行上 */
const PG_FOREIGN_KEY_VIOLATION = '23503';

function isForeignKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === PG_FOREIGN_KEY_VIOLATION;
}
