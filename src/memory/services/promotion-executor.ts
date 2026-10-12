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
 * 失败一律走 `failPromotion`（带 claim token 的 fencing 写），由共享状态机决定是退避重投
 * 还是死信。分类表（`classifyPromotionFailure`）：
 *
 * | 情形 | 分类 | 去向 |
 * | --- | --- | --- |
 * | Agent 不在了 | delivery_missing | 死信——重投不会让 Agent 回来 |
 * | 载荷解析不了（ZodError） | payload_unreadable | 死信——重投读到的是同一份坏数据 |
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
import type {
  ClaimedPromotionCandidate,
  MemoryRepository,
  SkillSaveResult,
} from '../ports/memory-repository';
import type {
  PromotionApprovalMode,
  PromotionDecision,
  PromotionStrategy,
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

  let decision: PromotionDecision;
  try {
    decision = await deps.strategy.evaluate({ role_id, experience, now, approval: options.approval });
  } catch (error) {
    // 策略自己抛错（配置非法、注入的实现有 bug）：按通用分类落盘，不让它掀掉整批
    return recordFailure(deps, candidate, classifyPromotionFailure(error), now, {});
  }

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
      strategy_version: decision.strategy_version,
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
 * 在通用分类之上只加一类判断：**归属的 Agent 不在了**。这不是「异常的形状」能回答的问题
 * （两个后端抛的都是普通 Error），所以判据取两个后端各自的固定信号：
 *
 * - InMemory 的 `requireStore` 抛 `Agent not found: <id>`（`AGENT_MISSING_PREFIX`）；
 * - PG/PGlite 上这条状态其实不可达（`memory_experiences` 对 `memory_agents` 是
 *   `ON DELETE CASCADE`，Agent 没了经验也没了，根本扫不出候选），但若 INSERT 恰好撞上
 *   归属行消失，Postgres 报的是外键冲突 `23503`——一并按同一结论处理，免得它落进
 *   `unknown`（可重试）白重投五次。
 *
 * 这两个信号由 promotion-executor 的契约测试钉住：适配器改了措辞或换了 SQLSTATE，那条
 * 测试先红，而不是让分类悄悄退化。
 */
export function classifyPromotionFailure(error: unknown): DeliveryFailureClassification {
  const message = error instanceof Error ? error.message : String(error);
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

