/**
 * promotion-candidates — 谁算晋升候选、以及一条候选该怎么处理（Phase 3）
 *
 * 这是 Skill Promotion Job 的「选人」规则：从某个 Agent 的全部经验里挑出这次该动的那些，
 * 并说清每一条要做什么（直接 claim / 先重置再 claim / 先从过期租约里回收再 claim / 跳过）。
 * 纯函数、无 IO —— 规则写在这里一次，InMemory 与 Pg 两个适配器的 claimNext 都调它，
 * 因此「什么算候选」不可能在两个后端之间漂移。
 *
 * 为什么不能简单用「status === 'pending' 就算候选」：
 *
 * - **已晋升**（`promoted_to` 指向一条 Skill）永远不再进来，否则会攒出重复技能。
 * - **判过且结论已定**（rejected / pending_review）在**同一策略版本、同一份输入**下不重评 ——
 *   重评的判据是「策略变了」「输入变了」或「人工审核模式放宽成自动批准」，不是「又跑了一轮」。
 *   输入这一项是最容易漏掉的一半：晋升是个按周期扫的通道，少了它，一条刚提取出来（置信度还低）
 *   的经验会在**第一次被看到的那一轮**就判 `rejected` 并永久冻结——此后 Driver 反馈把它的置信度
 *   抬过门槛，也没有任何东西会再看它一眼。那正好把「反馈滚雪球、最终跨过阈值」这条故事反过来写。
 * - **人工审核模式下判出的 pending_review** 必须能被后续一次 auto_approve 的运行接起来，
 *   否则「先记下来等批准」就永远等不到批准（没有任何东西会再碰它）。这就是
 *   `reevaluate_then_claim` 存在的理由。
 * - **死信**只由人工重试（`retryDeadLetterPromotion`）放回，不自动重投。
 *
 * 排序取 `created_at` 升序（再按 id），即「先来的先处理」：与交付侧按到期时刻排序同一个
 * 意图 —— 顺序确定、可复现，且不会被「每次运行换一个顺序」搅乱观测。
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_PROMOTION_RETRY_POLICY,
  isDeliveryClaimExpired,
  isDeliveryDue,
  type DeliveryRetryPolicy,
} from './delivery-lifecycle';
import type { PromotionApprovalMode } from '../ports/promotion-strategy';
import type { ExperiencePromotion, ExperienceRecord } from '../schemas';

/** 判定「这次不动这条经验」的理由（机器可读，用于聚合「候选都卡在哪」） */
export type PromotionSkipReason =
  /** 已经晋升过：`promoted_to` 已指向一条 Skill */
  | 'already_promoted'
  /** 死信：只由人工重试放回 */
  | 'dead_letter'
  /** 正被别的 worker 持有（lease 未过期） */
  | 'in_flight'
  /** 还在退避窗口里 */
  | 'not_due'
  /** 投递次数已用满（正常路径下应已进死信，这里兜底） */
  | 'attempts_exhausted'
  /** 同一策略版本、同一份输入下已经判过，结论是不合格 */
  | 'evaluated_under_current_strategy'
  /** 同一策略版本下判为待审核，而本次运行还是人工审核模式 */
  | 'waiting_for_manual_review';

/**
 * 一条候选该做什么。
 *
 * 三种「要动它」的形状分开，是为了让适配器明确知道在 claim 之前还得先写什么：
 * 三者的写回内容不同，混成一个布尔会丢掉「为什么需要重置」这条信息。
 */
export type PromotionCandidatePlan =
  /** 现在就能 claim（含从未评估过、需要先落一个初始标记的情况） */
  | { kind: 'claim'; marker: ExperiencePromotion }
  /** 先按新策略把标记重置为待评估，再 claim（换策略版本 / 人工审核转自动批准） */
  | { kind: 'reevaluate_then_claim'; marker: ExperiencePromotion }
  /** 先按租约过期回收（`expireDeliveryClaimRecord`），再 claim */
  | { kind: 'expire_then_claim' }
  /** 本次不动它 */
  | { kind: 'skip'; reason: PromotionSkipReason };

/** 选候选与判「该不该动」需要的上下文 */
export interface PromotionCandidateInput {
  /** 参考时刻（注入时钟的结果） */
  now: string;
  /** 当前生效的策略版本：决定判过的候选要不要重评 */
  strategy_version: string;
  /** 本次运行的审核模式：决定 pending_review 要不要被自动批准接起来 */
  approval: PromotionApprovalMode;
  /** 重试预算；缺省用 DEFAULT_PROMOTION_RETRY_POLICY */
  policy?: DeliveryRetryPolicy;
}

/**
 * 产出一条候选的处理计划。
 *
 * 不抛错：任何读不懂的组合（例如 processed 却没有结论）都归到「重评一次」——
 * 搁着不动的代价是这条经验永远不再被考虑，而那比多评一次贵得多。
 */
export function planPromotionCandidate(
  experience: ExperienceRecord,
  input: PromotionCandidateInput,
): PromotionCandidatePlan {
  const policy = input.policy ?? DEFAULT_PROMOTION_RETRY_POLICY;
  const marker = experience.promotion;

  if (isPromotedExperience(experience)) {
    return { kind: 'skip', reason: 'already_promoted' };
  }

  // 从未评估：先在 claim 时落一个初始标记（status=pending、次数 0）
  if (!marker) {
    return { kind: 'claim', marker: initialPromotionMarker(input.now) };
  }

  switch (marker.status) {
    case 'dead_letter':
      return { kind: 'skip', reason: 'dead_letter' };

    case 'processing':
      // lease 未过期就是在别人手里；过期了先回收再 claim（回收本身可能用满次数进死信，
      // 那时随后的 claim 自然拿不到它）
      return isDeliveryClaimExpired(marker, input.now)
        ? { kind: 'expire_then_claim' }
        : { kind: 'skip', reason: 'in_flight' };

    case 'pending':
      if (marker.attempt_count >= policy.max_attempts) {
        return { kind: 'skip', reason: 'attempts_exhausted' };
      }
      return isDeliveryDue(marker, input.now)
        ? { kind: 'claim', marker }
        : { kind: 'skip', reason: 'not_due' };

    case 'processed': {
      // outcome === 'promoted' 已在上面被 isPromotedExperience 拦掉，这里只剩三种结论
      if (marker.strategy_version !== input.strategy_version) {
        return { kind: 'reevaluate_then_claim', marker: reevaluatePromotionMarker(marker, input.now) };
      }
      if (marker.outcome === 'pending_review') {
        return input.approval === 'auto_approve'
          ? {
              kind: 'reevaluate_then_claim',
              marker: reevaluatePromotionMarker(marker, input.now),
            }
          : { kind: 'skip', reason: 'waiting_for_manual_review' };
      }
      if (marker.outcome === 'rejected') {
        // 输入变了就重评：置信度被反馈抬上来、被手工改过、引用次数变了，都会让这条经验变成
        // 另一条候选。判据是**指纹**而不是「又跑了一轮」——同一份输入下重评只是把同一个结论
        // 再算一遍，而漏掉一次重评的代价是这条经验永远不再被考虑。
        return marker.input_snapshot_hash === promotionInputSnapshotHash(experience)
          ? { kind: 'skip', reason: 'evaluated_under_current_strategy' }
          : {
              kind: 'reevaluate_then_claim',
              marker: reevaluatePromotionMarker(marker, input.now),
            };
      }
      // 结论缺席：这条 processed 记录读不出判定（旧数据 / 被手工改过），重评一次
      return { kind: 'reevaluate_then_claim', marker: reevaluatePromotionMarker(marker, input.now) };
    }
  }
}

/**
 * 一条经验的**判定输入指纹**：策略判这条候选时读到的那些字段的规范摘要。
 *
 * 它回答的是「这条结论还是对同一个问题给出的吗」。喂进去的是参与判定的那几个字段：
 * `type` / `confidence` / `referenced_count` / `source_user_rating`，外加 `updated_at`
 * 作为兜底——任何一次写入（反馈回写、人工编辑）都会推动它，因此**改了内容就一定会重评**，
 * 不必在这里逐个列举「哪些写入算数」。
 *
 * 为什么是手工拼串而不是 `JSON.stringify(experience)`：后者的键顺序取决于对象是怎么被构造
 * 出来的（今天恰好稳定，那是实现的偶然），而这份串的每一段都由这里显式定序，于是「同内容必然
 * 同 hash」是被保证的。字段之间用不可打印分隔符隔开，避免拼接歧义（`["ab","c"]` 与
 * `["a","bc"]` 必须不同）。
 *
 * **已知不含的一项**：`min_age_ms` 这类由时间推动的门槛。它默认关闭；打开时，一条被判
 * `too_recent` 的经验要等到输入再次变化才会重评，而不是到点自动重评。把「当前时刻」也搅进
 * 指纹会让每一轮都判定为「输入变了」，那是拿周期性重评换收敛性，得不偿失。
 */
export function promotionInputSnapshotHash(experience: ExperienceRecord): string {
  const parts = [
    'promotion-input.v1',
    experience.id,
    experience.type,
    String(experience.confidence),
    String(experience.referenced_count),
    experience.source_user_rating ?? 'not_rated',
    experience.updated_at,
  ];
  return createHash('sha256').update(parts.join('\u001f'), 'utf8').digest('hex');
}

/** 本次该处理的经验（过滤掉 skip 的那些），按「先来的先处理」排序 */
export function selectPromotionCandidates(
  experiences: ExperienceRecord[],
  input: PromotionCandidateInput,
): ExperienceRecord[] {
  return experiences
    .filter((experience) => planPromotionCandidate(experience, input).kind !== 'skip')
    .sort(comparePromotionCandidates);
}

/** 候选排序：创建时间升序，同刻按 id —— 确定性来自这里，不来自存储返回顺序 */
export function comparePromotionCandidates(left: ExperienceRecord, right: ExperienceRecord): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1;
  return left.id.localeCompare(right.id);
}

/**
 * 这条经验是否已经晋升。
 *
 * `promoted_to` 是权威，晋升标记里的 `skill_id` 是同一件事的另一处落点（两者由同一次写入
 * 落定，见 MemoryRepository.completePromotion）；任一非空都算已晋升，宁可漏一次重评，
 * 也不要在两个字段短暂不一致时攒出第二条技能。
 */
export function isPromotedExperience(experience: ExperienceRecord): boolean {
  return experience.promoted_to !== undefined || experience.promotion?.outcome === 'promoted';
}

/** 从未评估过的经验在第一次 claim 时落下的初始标记 */
export function initialPromotionMarker(now: string): ExperiencePromotion {
  return { status: 'pending', attempt_count: 0, created_at: now, updated_at: now };
}

/**
 * 把一条已判过的标记重置为「待评估」，用于换策略版本重评、输入变化后重评、或人工审核转自动批准。
 *
 * 重置的是**判定**（结论、策略版本、输入指纹、理由、技能绑定）与**投递痕迹**（次数、持有的
 * token、退避、上次错误）：重评的那一次应当和从没评过一样，不该继承上一版策略的退避。
 * `created_at` 保留 —— 那是这条标记的来历，不是结论。
 */
export function reevaluatePromotionMarker(
  current: ExperiencePromotion,
  now: string,
): ExperiencePromotion {
  return {
    ...current,
    status: 'pending',
    attempt_count: 0,
    claimed_at: undefined,
    claim_owner: undefined,
    claim_token: undefined,
    lease_expires_at: undefined,
    next_retry_at: undefined,
    last_error: undefined,
    outcome: undefined,
    strategy_version: undefined,
    input_snapshot_hash: undefined,
    evaluated_at: undefined,
    skill_id: undefined,
    reasons: undefined,
    updated_at: now,
  };
}

/**
 * 计划 §10 要求表达的那组语义（未评估 / 处理中 / 待审核 / 已拒绝 / 已晋升 / 可重试 / 死信）
 * 在存储上的落点，收成一个词。
 *
 * 观测与测试用：状态是**派生**的（由生命周期 + 结论两列算出来），不是又一个要维护的字段——
 * 真存一份状态，就有两个真相来源可以对不上。
 */
export type PromotionStateLabel =
  | 'unevaluated'
  | 'processing'
  | 'retryable'
  | 'dead_letter'
  | 'promoted'
  | 'pending_review'
  | 'rejected';

export function promotionStateLabel(experience: ExperienceRecord): PromotionStateLabel {
  const marker = experience.promotion;
  if (!marker) return 'unevaluated';
  switch (marker.status) {
    case 'processing':
      return 'processing';
    case 'dead_letter':
      return 'dead_letter';
    case 'pending':
      // 投递过又回到队列 = 上一次失败了，等退避到期
      return marker.attempt_count > 0 ? 'retryable' : 'unevaluated';
    case 'processed':
      return marker.outcome ?? 'unevaluated';
  }
}
