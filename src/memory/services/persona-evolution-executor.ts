/**
 * persona-evolution-executor — 把一条已 claim 的角色执行到底（Phase 4-C）
 *
 * 这是 Persona 演化的**执行内核**：输入一条 claim 到的候选（角色 + 当前 Persona + 输入快照 +
 * 凭据），输出它的终局。批量外壳（claim 循环、run 审计、批大小与墙钟上限）在
 * runtime/persona-evolution-job.ts，本文件只回答「这一条该怎么办」——与晋升同一种拆分理由：
 * 「一条候选的判据与写回前提」错了会写坏 Persona 版本，而「一批候选怎么调度」错了只是慢。
 *
 * 一次执行的三条出口，对应计划 §11 的处理规则：
 *
 *   判定不合格        → complete(outcome='rejected')        —— 只记结论，不写 Persona
 *   判定合格·人工审核 → complete(outcome='pending_review')  —— 只记结论，不写 Persona
 *   判定合格·自动批准 → 构造 v(parent+1) → complete(outcome='evolved', persona)
 *
 * 第三条是这条通道的幂等要害，靠的是**两道条件在同一次原子写里同时成立**（Phase 4-B 的
 * `completePersonaEvolution`）：凭据（claim token / 租约 / 仍在 processing）与父版本
 * （写回那一刻的 `persona.version` 必须等于这次判定所依据的那一版）。本文件不自己实现
 * 那两道条件，只把判定给出的父版本与快照 hash 原样递过去，并把三种终局分开处置：
 *
 *   applied         → 落地（新版本 + 标记）
 *   parent_conflict → **不覆盖**，按可重试的 `storage_conflict` 退回队列。重投会重新读、
 *                     重算快照、重判一次，因此这不是失败而是「这次的判据过期了」
 *   claim_lost      → 什么都不写，这条结果记 `failed`。「这次没轮到我们」不是处理失败，
 *                     落盘责任归当前持有者，硬写只会把别人的结论盖掉
 *
 * **策略返回值是一道契约**（`assertPersonaEvolutionDecisionConsistent`）。判定里有四个字段
 * 会被原样写到别处——`strategy_version` 进标记（版本变更是重评判据）、`role_id` 决定这次
 * 演化落到谁身上、`parent_version` 决定能不能写、`input_snapshot_hash` 决定幂等键。任何一处
 * 对不上，写下去的就是一条与 run 审计、与幂等判据互相矛盾的记录。最贵的一类仍是拼错的
 * `verdict`：它是个普通字符串，会一路滑过「非 eligible、非 pending_review」的判断被写成一条
 * 正常的拒绝结论——实现错误伪装成判决结果，还进不了死信。因此这些检查全部排在**写任何东西
 * 之前**，按不可重试落进死信。校验放在内核而不是外壳：内核也可以被别的调用方（脚本、后续
 * 调度器）直接用，契约不该由某一个外壳代为执行。
 *
 * 失败一律走 `failPersonaEvolution`（带 claim token 的 fencing 写），由共享状态机决定退避
 * 重投还是死信。分类表（`classifyPersonaEvolutionFailure`）比晋升多一维：**是判定那一层
 * 抛的，还是存储那一层抛的**。这一维不能从异常形状看出来——两边都可能是普通 Error——所以由
 * 调用点显式传进来，而不是靠猜。据此把六种情形都用满：
 *
 * | 情形 | 来源 | 分类（码 / 可重试） | 去向 |
 * | --- | --- | --- | --- |
 * | 判定违反契约（形状 / 结论 / 角色 / 版本 / 父版本 / 快照 / 数组 / 搭配） | 判定 | malformed_decision（payload_unreadable / 否） | 死信——同一次判定重投多少次都是同一份 |
 * | 判定抛出且通用分类说可重试 | 判定 | model_failure（model_error / 是） | 退避重投——这条通道里会抛的判定基本都是调模型的那一类 |
 * | 判定抛出且通用分类说不可重试 | 判定 | policy_failure（policy_rejected / 否） | 死信——策略在声明「这份输入我不判」 |
 * | 父版本已经不是当前版本 | 存储（返回值） | storage_conflict（storage_error / 是） | 退避重投——重投会重新读再判 |
 * | 归属 Agent 不在了（前缀 / 23503） | 存储 | missing_input（delivery_missing / 否） | 死信——重投不会把 Agent 变回来 |
 * | 其余存储异常 | 存储 | storage_failure（storage_error / 是） | 退避重投（有上限，用满进死信） |
 *
 * 「判定不合格」（`rejected`）**不在这张表里**：那是一条结论，不是故障。它落在完成数里、
 * 进不了死信，与晋升把 `rejected` 计入 `completed_count` 同一个道理。
 *
 * 刻意**没有**做的一件事：不在写回之前自己调 `resolvePersonaEvolutionWrite` 预判冲突。那道
 * 判据的权威副本是存储的条件写（重复判一遍只会让人以为内核也是权威），而契约校验已经保证
 * 判定自报的父版本就是这次 claim 读到的那一版——「读到之后被谁改过」只有写的那一刻才知道。
 */
import { nowTimestamp } from '../../core';
import { classifyDeliveryFailure } from './delivery-error-classification';
import type { DeliveryRetryPolicy } from './delivery-lifecycle';
import {
  isPersonaEvolutionDecisionContractError,
  auditPersonaEvolutionDecision,
  buildEvolvedPersona,
  personaEvolutionFailure,
  summarizePersonaEvolutionChange,
  assertPersonaEvolutionDecisionConsistent,
  type PersonaEvolutionFailureClassification,
} from './persona-evolution-decision';
import type { ClaimedPersonaEvolutionCandidate, MemoryRepository } from '../ports/memory-repository';
import type {
  PersonaEvolutionApprovalMode,
  PersonaEvolutionDecision,
  PersonaEvolutionStrategy,
} from '../ports/persona-evolution-strategy';
import type { PersonaEvolutionMarker, PersonaEvolutionOutcome } from '../schemas';

/** 一条候选执行完之后落在哪里（复用 job 契约里的那组词，去掉本外壳不产生的 `skipped`） */
export type PersonaEvolutionExecutionStatus =
  | 'evolved'
  | 'pending_review'
  | 'rejected'
  | 'retried'
  | 'dead_letter'
  | 'failed';

/**
 * 自动批准时写进标记的批准者标识。
 *
 * 与技能自动晋升用同一个值（`schemas.ts` 的 `reviewed_by` 注释已经这么写了）：读审计的人不该
 * 为了「这是谁批的」再去分辨两条通道各用了哪个字符串，而它们的含义本来就是同一件事——
 * 系统按配置自动放行，人没有参与。
 */
export const AUTO_APPROVAL_REVIEWER = 'system:auto-approval';

/** 执行内核的构造依赖：只接端口，不接具体后端 */
export interface PersonaEvolutionExecutorDeps {
  /** Agent 聚合、Persona 与演化状态的读写面（结论落地、失败落盘都在这里） */
  repository: MemoryRepository;
  /** 逐条判定的策略（版本与阈值都带着它） */
  strategy: PersonaEvolutionStrategy;
  /** 重试预算；缺省用 DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY */
  policy?: DeliveryRetryPolicy;
  /** 参考时刻（测试注入）；缺省取系统时间 */
  now?: () => string;
  /** 交叉核对的持有者标识；缺省不做 owner 核对（真正的 fencing 是 claim token） */
  owner?: string;
}

/** 单条执行的可变参数 */
export interface PersonaEvolutionExecutionOptions {
  /** 本次运行的审核模式：合格之后是写出新版本还是只记 pending_review */
  approval: PersonaEvolutionApprovalMode;
  /** 产生这条结论的 maintenance run；写进标记，是「这一版是哪次运行跑出来的」 */
  source_run_id: string;
  /** 自动批准时的批准者标识；缺省 AUTO_APPROVAL_REVIEWER */
  reviewed_by?: string;
  /** 本次的参考时刻；缺省取 deps.now()，再缺省取系统时间 */
  now?: string;
}

/** 一条候选的执行结果：既给 run 计数，也给事后排查 */
export interface PersonaEvolutionExecutionResult {
  status: PersonaEvolutionExecutionStatus;
  role_id: string;
  /** 执行前这条候选的投递次数（claim 时已经 +1） */
  attempt_count: number;
  /** 这次判定依据的输入快照 hash；claim 拿到的那个，失败时也带着（幂等键的一半） */
  input_snapshot_hash: string;
  /** 这次判定依据的父 Persona 版本；claim 读到的那一版 */
  parent_version: number;
  /** 策略判定；判定本身抛错时缺席 */
  decision?: PersonaEvolutionDecision;
  /** 演化写下的 Persona 版本；`evolved` 时才有 */
  persona_version?: number;
  /**
   * 失败时的规范化分类；成功与跳过时为缺席。
   *
   * 除了给状态机读的 `code` 与 `retryable`，它还带着**落在六种情形里的哪一种**（`kind`）——
   * run 的审计要按情形计数（「这一批里有几次是父版本冲突」），而从 `code` 上分不出来：
   * 父版本冲突与存储抖动共享同一个 `storage_error`。
   */
  failure?: PersonaEvolutionFailureClassification;
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
export async function executePersonaEvolutionCandidate(
  deps: PersonaEvolutionExecutorDeps,
  candidate: ClaimedPersonaEvolutionCandidate,
  options: PersonaEvolutionExecutionOptions,
): Promise<PersonaEvolutionExecutionResult> {
  const now = options.now ?? deps.now?.() ?? nowTimestamp();
  const { role_id, claim_token, persona, snapshot, input_snapshot_hash } = candidate;
  // 父版本的权威读口是 claim 读到的那一版 Persona；契约校验会保证判定自报的是同一个
  const parent_version = persona.version;

  // 策略交回来的东西在运行时是**未知的**：自定义策略可以绕过类型层，交回 null、标量，或一个
  // 字段自相矛盾的对象。因此它先落在 `unknown` 上，由契约校验决定它能不能往下走。
  let returned: unknown;
  try {
    returned = await deps.strategy.evaluate({
      role_id,
      now,
      approval: options.approval,
      current_persona: persona,
      parent_version,
      snapshot,
      input_snapshot_hash,
      ...(candidate.last_evolution !== undefined
        ? { last_evolution: candidate.last_evolution }
        : {}),
    });
  } catch (error) {
    // 判定自己抛错（模型不可用、注入的实现有 bug）：按判定层的分类落盘，不让它掀掉整批
    return recordFailure(deps, candidate, options, classifyPersonaEvolutionFailure(error, 'judgement'), now, {});
  }

  try {
    // 契约校验必须在写任何东西之前：判定里的版本、角色、父版本与快照 hash 都会被原样落到
    // 别处，对不上就意味着这次执行会写出一条与 run 审计对不上的记录；形状不合法的判定
    // （拼错的 verdict、缺席的字段、不是数组的理由、合格却不给正文）也在这里被挡住
    assertPersonaEvolutionDecisionConsistent(returned, {
      role_id,
      approval: options.approval,
      strategy_version: deps.strategy.version,
      parent_version,
      input_snapshot_hash,
    });
  } catch (error) {
    // 校验要拒的正是这份判定，审计里必须留着它到底返回了什么——只留一句「对不上」而不留
    // 对不上的那个值，排查时还得去复现一次才看得到
    const audited = auditPersonaEvolutionDecision(returned);
    return recordFailure(deps, candidate, options, classifyPersonaEvolutionFailure(error, 'judgement'), now, {
      ...(audited !== undefined ? { decision: audited } : {}),
    });
  }

  // 走到这里返回值已经过契约校验（断言签名把它收窄成一份合法判定），写路径才开始
  const decision: PersonaEvolutionDecision = returned;

  if (decision.verdict !== 'eligible') {
    const outcome: PersonaEvolutionOutcome =
      decision.verdict === 'pending_review' ? 'pending_review' : 'rejected';
    return settleConclusion(deps, candidate, options, decision, outcome, now);
  }

  // ── 自动批准：构造新版本，交给条件写去落定 ──────────────────────────
  // 版本号只能由父版本 +1 得出（`buildEvolvedPersona`），角色与生成时刻也只能由执行方填：
  // 让判定交出这些字段就等于让它有机会写一个不属于它的版本号
  const next_persona = buildEvolvedPersona({
    role_id,
    draft: decision.persona!,
    parent_version,
    now,
  });
  const change_summary = summarizePersonaEvolutionChange({
    parent_version,
    persona_version: next_persona.version,
    approved_skill_count: snapshot.skills.length,
    eligible_experience_count: snapshot.experiences.length,
    input_snapshot_hash,
  });

  let completed;
  try {
    completed = await deps.repository.completePersonaEvolution({
      role_id,
      claim_token,
      ...(deps.owner !== undefined ? { owner: deps.owner } : {}),
      parent_version,
      outcome: 'evolved',
      // 版本与快照 hash 取**执行侧**的这两个：契约校验已经保证判定自带的是同一个，这里用
      // 哪一个都不改变结果，但取这一个让「run 记的 = 标记记的 = 判定依据的」在写入口就是
      // 同一个来源，而不是靠三处各自传递得恰好一致
      strategy_version: deps.strategy.version,
      input_snapshot_hash,
      source_run_id: options.source_run_id,
      reasons: decision.reasons,
      change_summary,
      reviewed_by: options.reviewed_by ?? AUTO_APPROVAL_REVIEWER,
      persona: next_persona,
      now,
    });
  } catch (error) {
    // 存储侧的异常（连接断了、权限、载荷写不进去）：按存储层的分类落盘
    return recordFailure(deps, candidate, options, classifyPersonaEvolutionFailure(error, 'storage'), now, {
      decision,
    });
  }

  return settleCompletion(deps, candidate, options, completed, 'evolved', now, {
    decision,
    ...(completed.kind === 'applied' ? { persona_version: next_persona.version } : {}),
  });
}

/**
 * 判定合格但不需要写 Persona 的两条出口（rejected / pending_review）。
 *
 * 落结论用的是同一条带 token 的条件写：凭据失效就什么都不写，返回 `failed`。两条出口都
 * **不写 Persona**，因此存储侧也没有父版本条件可判——`pending_review` 是「够格但本次没人
 * 放行」，`rejected` 是「不够格」，两者都没有旧版本可破坏。
 */
async function settleConclusion(
  deps: PersonaEvolutionExecutorDeps,
  candidate: ClaimedPersonaEvolutionCandidate,
  options: PersonaEvolutionExecutionOptions,
  decision: PersonaEvolutionDecision,
  outcome: PersonaEvolutionOutcome,
  now: string,
): Promise<PersonaEvolutionExecutionResult> {
  const { role_id, claim_token } = candidate;

  let completed;
  try {
    completed = await deps.repository.completePersonaEvolution({
      role_id,
      claim_token,
      ...(deps.owner !== undefined ? { owner: deps.owner } : {}),
      parent_version: candidate.persona.version,
      outcome,
      strategy_version: deps.strategy.version,
      input_snapshot_hash: candidate.input_snapshot_hash,
      source_run_id: options.source_run_id,
      reasons: decision.reasons,
      now,
    });
  } catch (error) {
    return recordFailure(deps, candidate, options, classifyPersonaEvolutionFailure(error, 'storage'), now, {
      decision,
    });
  }

  return settleCompletion(deps, candidate, options, completed, outcome, now, { decision });
}

/**
 * 三种终局的共同处置。
 *
 * 分开写是因为它们的处置完全不同，而**只有一种会丢结论**：落定与父版本冲突都是可解释的
 * 结果，凭据失效则意味着这次执行什么都没留下——那不是「处理失败」，是「这次没轮到我们」。
 *
 * 落地时的 status 直接取**这次要求落下的那个结论**（`evolved` / `pending_review` /
 * `rejected` 与执行状态是同一组词）。没有从标记上读回来的必要：标记就是由这次调用按这个
 * 请求写下去的，回读只会在「适配器写了别的」这种不可能的情形上变出一个抛错分支——而适配器
 * 真的写了别的，该红的是存储契约测试，不是让一条候选的执行结果去猜。
 */
function settleCompletion(
  deps: PersonaEvolutionExecutorDeps,
  candidate: ClaimedPersonaEvolutionCandidate,
  options: PersonaEvolutionExecutionOptions,
  completed: Awaited<ReturnType<MemoryRepository['completePersonaEvolution']>>,
  outcome: PersonaEvolutionOutcome,
  now: string,
  extra: { decision: PersonaEvolutionDecision; persona_version?: number },
): Promise<PersonaEvolutionExecutionResult> {
  const { role_id, attempt_count, input_snapshot_hash, persona } = candidate;
  const base = {
    role_id,
    attempt_count,
    input_snapshot_hash,
    parent_version: persona.version,
    decision: extra.decision,
  };

  switch (completed.kind) {
    case 'applied':
      return Promise.resolve({
        ...base,
        status: outcome,
        ...(extra.persona_version !== undefined ? { persona_version: extra.persona_version } : {}),
        warnings: [],
      });
    case 'parent_conflict':
      // 别的 worker 先写了一步，或前端 PATCH 改过：**不覆盖**，把这条判定作废退回队列。
      // 重投会重新读、重算快照、重判一次——因此这是「判据过期」而不是「处理失败」。
      return recordFailure(
        deps,
        candidate,
        options,
        personaEvolutionFailure(
          'storage_conflict',
          `Persona for ${role_id} is now v${String(completed.current_version)} while this decision `
            + `was produced from v${String(completed.expected_parent_version)}; nothing was written `
            + 'and the candidate is re-queued to be read, snapshotted and judged again.',
        ),
        now,
        { decision: extra.decision },
      );
    case 'claim_lost':
      return Promise.resolve({
        ...base,
        status: 'failed',
        failure: personaEvolutionFailure(
          'missing_input',
          `Persona evolution claim for role ${role_id} was lost before the conclusion could be `
            + 'written (the lease expired and another worker took over, or the role is gone); '
            + 'nothing was written and the current holder owns the outcome.',
        ),
        warnings: [],
      });
  }
}

/**
 * 记一次失败：交给共享状态机决定退避重投还是死信。
 *
 * 返回值里始终带着传进来的 `failure`——即使失败本身也没能写进存储（存储不可用、凭据已失效），
 * 上层 run 仍能记下规范化分类与原因，审计信息不会因为写不下去而消失。
 */
async function recordFailure(
  deps: PersonaEvolutionExecutorDeps,
  candidate: ClaimedPersonaEvolutionCandidate,
  options: PersonaEvolutionExecutionOptions,
  failure: PersonaEvolutionFailureClassification,
  now: string,
  extra: { decision?: PersonaEvolutionDecision },
): Promise<PersonaEvolutionExecutionResult> {
  const base: PersonaEvolutionExecutionResult = {
    status: 'failed',
    role_id: candidate.role_id,
    attempt_count: candidate.attempt_count,
    input_snapshot_hash: candidate.input_snapshot_hash,
    parent_version: candidate.persona.version,
    ...(extra.decision !== undefined ? { decision: extra.decision } : {}),
    failure,
    warnings: [],
  };

  let failed: PersonaEvolutionMarker | undefined;
  try {
    failed = await deps.repository.failPersonaEvolution({
      role_id: candidate.role_id,
      claim_token: candidate.claim_token,
      ...(deps.owner !== undefined ? { owner: deps.owner } : {}),
      error: failure.message,
      retryable: failure.retryable,
      now,
      ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
    });
  } catch {
    // 连失败都写不下去：审计留在返回值里
    return base;
  }

  // failPersonaEvolution 返回 undefined = 凭据已失效，我们什么都没写
  if (!failed) return base;
  return {
    ...base,
    status: failed.status === 'dead_letter' ? 'dead_letter' : 'retried',
  };
}

/** 异常是判定那一层抛的，还是存储那一层抛的 */
export type PersonaEvolutionFailureLayer = 'judgement' | 'storage';

/** 适配器表示「这个 Agent 不在了」的消息前缀（InMemory 的 requireStore 与 Pg 的 requireAgentRow 都用它） */
const AGENT_MISSING_PREFIX = 'Agent not found:';

/** Postgres 外键冲突的 SQLSTATE */
const PG_FOREIGN_KEY_VIOLATION = '23503';

/**
 * 把执行期的异常映射成「可重试吗」与规范化失败码。
 *
 * 与晋升的分类器同形，多一个 `layer` 参数：这条通道的判定**允许调模型**（见
 * ports/persona-evolution-strategy.ts 的说明），因此「判定抛错」与「存储抛错」必须分开——
 * 前者多半是下游/模型那一侧（重投有意义），后者才该读成存储故障。两者在异常形状上没有区
 * 别（都可能是普通 Error），所以由调用点显式传进来，而不是猜。
 *
 * 六种情形各自的触发条件与去向见文件头的分类表。三条判据是"形状回答不了、只有本通道知道"的：
 *
 * 1. **策略判定违反契约**（`PersonaEvolutionDecisionContractError`）：同一次判定重投多少次
 *    都还是那一份，修它的是改配置或改策略实现，因此按不可重试落死信。
 * 2. **归属 Agent 不在了**：预置判据是适配器固定的消息前缀与 `23503`。两个适配器目前对
 *    「Agent 被删」回答的是 `claim_lost`（结构性的，不走异常），这条规则是给「异常形状的
 *    同一种事实」留的出口——一个会抛的实现不该因为抛了就白重投五次。
 * 3. **判定层抛出的不可重试错误**：那是策略在声明「这份输入我不判」（配置错、或它自己的
 *    校验拒绝了输入），重投无用。
 */
export function classifyPersonaEvolutionFailure(
  error: unknown,
  layer: PersonaEvolutionFailureLayer,
): PersonaEvolutionFailureClassification {
  const message = error instanceof Error ? error.message : String(error);

  if (isPersonaEvolutionDecisionContractError(error)) {
    return personaEvolutionFailure(
      'malformed_decision',
      `${message} (the strategy decision itself is invalid, so retrying cannot fix it; this is a `
        + 'configuration error or a strategy defect that needs a human)',
    );
  }
  if (message.startsWith(AGENT_MISSING_PREFIX) || isForeignKeyViolation(error)) {
    return personaEvolutionFailure(
      'missing_input',
      `${message} (the role this evolution belongs to was removed while it was being evolved; `
        + 're-running will not bring it back)',
    );
  }

  const generic = classifyDeliveryFailure(error);
  if (layer === 'judgement') {
    // 这条通道里会抛的判定基本都是调模型的那一类；把「不知道是什么」也归到模型层，比留一个
    // `unknown` 更有用——审计读得出是哪一层出的问题，重投语义不变（同样有上限、同样进死信）
    return generic.retryable
      ? personaEvolutionFailure('model_failure', message)
      : personaEvolutionFailure('policy_failure', message);
  }
  // 存储层：可重试的一律读成存储故障（连接断了、锁等不到），不可重试的沿用通用分类——
  // 权限/路径类是确定的配置错，把它说成「存储抖了一下」会让运维白重试五次
  return generic.retryable ? personaEvolutionFailure('storage_failure', message) : generic;
}

function isForeignKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === PG_FOREIGN_KEY_VIOLATION;
}
