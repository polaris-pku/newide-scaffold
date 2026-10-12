/**
 * DriverFeedbackProcessor — Driver 反馈的消费与归并内核（Phase 2）
 *
 * 两种输入，同一套「应用」动作：
 *
 *   1. `process`：消费 outbox 里的一条反馈交付项。经验已经存在就当场写进去；还不存在就
 *      把反馈**寄存**进待归并队列，然后 ack 这条交付——寄存落盘之前绝不 ack。
 *   2. `reconcile`：归并任务的单条内核。拿一条寄存记录去重查经验：出现了就写进去并结案；
 *      还是没出现就按可重试失败退回队列（退避到点再来），用满次数自然进死信。
 *
 * 三条不能松的约束，都是边界而不是实现细节：
 *
 * - **不碰在线流程**：不调 scheduleBuffer、不造 Buffer。反馈的价值在于「某条经验被用得怎么样」，
 *   造一条上下文把它塞回提取流程，等于用另一个更大的问题盖住归并问题。
 * - **不晋升、不演化**：写进经验的只有置信度与使用计数，Skill 与 Persona 由各自独立的 job
 *   决定（见计划 §3）。这条边界由组合方式保证——本文件连那两个端口都不持有。
 * - **幂等靠 feedback_id，不靠调用方记得**：应用的幂等判据写在经验自己的置信度历史里
 *   （repository.applyExperienceFeedback），交付的幂等判据写在 claim 凭据与状态机上。
 *   两层合起来，重复投递、崩溃重跑、lease 过期被接手重跑，都只会得到同一条业务结果。
 *
 * 失败处理与 Phase 1 的上下文消费者同形：坏输入（契约版本不认识、feedback_id 与派生值
 * 不符、关联键为空）当场进死信，不值得重投；存储/连接类错误按可重试回退，次数用满由
 * 状态机置死信。租约丢失（心跳被拒）时不写任何终态——那条记录已经不是自己的了。
 */
import {
  DRIVER_FEEDBACK_EVENT_VERSION,
  type DeliveryStatus,
  type DriverFeedbackContent,
  type DriverFeedbackRecord,
  type PendingFeedbackRecord,
} from '../schemas';
import type { ClaimedDelivery, MemoryDeliveryRepository } from '../ports/memory-delivery';
import type { ExperienceFeedbackResult, MemoryRepository } from '../ports/memory-repository';
import { driverFeedbackId, driverFeedbackKey } from '../services/context-delivery';
import {
  classifyDeliveryFailure,
  knownDeliveryFailure,
  type DeliveryFailureClassification,
} from '../services/delivery-error-classification';
import {
  leaseRenewIntervalMs,
  startLeaseHeartbeat,
  type LeaseTimers,
} from '../services/lease-heartbeat';
import {
  buildPendingFeedbackRecord,
  feedbackApplicationOf,
  isSupportedFeedbackVersion,
} from '../services/pending-feedback';

/** 反馈消费者管的两条通道：输入 outbox 与自己的待归并队列 */
type FeedbackChannel = 'feedback' | 'pending_feedback';

/**
 * 一条反馈处理完之后落在哪里。
 *
 * 前四种各自对应 run 的一个计数（见 schemas 的 MaintenanceRunCounts）；`failed` 是
 * 「连失败都没能记下来」——本 worker 侧的失败，与交付自己的成败分开计。
 */
export type DriverFeedbackProcessStatus =
  /** 交付已 ack：反馈要么已经写进经验，要么已寄存在待归并队列里 */
  | 'completed'
  /** 可重试失败：已按退避回到 pending，下次还会被投递 */
  | 'retried'
  /** 不可恢复或次数用满：已进 dead_letter */
  | 'dead_letter'
  /** 本次不归我（租约被抢走 / 记录已被别人处理），刻意没写任何终态 */
  | 'skipped'
  /** 终态没写进去（凭据失效、存储写失败），这一条的真实状态只能等租约恢复 */
  | 'failed';

/** 反馈最终去了哪里（`completed` 的三种形态） */
export type DriverFeedbackApplicationOutcome =
  /** 这次把它写进了经验 */
  | 'applied'
  /** 同一条反馈早已写进这条经验（重复投递 / 崩溃重跑），本次什么都没改 */
  | 'already_applied'
  /** 经验还没出现：原始反馈已寄存进待归并队列，等它出现再归并 */
  | 'parked';

/** 一条反馈的处理结果：既给 run 计数，也给事后排查 */
export interface DriverFeedbackProcessOutcome {
  status: DriverFeedbackProcessStatus;
  feedback_id: string;
  role_id: string;
  /** 被引用的经验（可能尚不存在） */
  experience_id: string;
  /** 处理前这条记录的投递次数（claim 时已经 +1） */
  attempt_count: number;
  /** 处理它的那次 run（诊断用；同一批里的记录共享一个 run_id） */
  run_id?: string;
  /** 走到终局时反馈去了哪里；失败时为 undefined */
  application?: DriverFeedbackApplicationOutcome;
  /** 应用后经验的置信度（本次真正写入时才有，供核对回写生效） */
  confidence?: number;
  /** 失败时的规范化分类；成功时为 undefined */
  failure?: DeliveryFailureClassification;
  /** 不构成失败但需要人看见的事实 */
  warnings: string[];
}

/** 处理一条记录时随行的身份信息 */
export interface DriverFeedbackProcessContext {
  /** 本次消费的 worker 标识，同时用作 claim owner（与 run 记录里的 worker_id 同源） */
  worker_id: string;
  /** 承载这条记录的 maintenance run */
  run_id?: string;
}

/**
 * 单条反馈的处理器。
 *
 * `process` 与 `reconcile` 的差别只在「输入是从哪条队列 claim 来的」以及「经验缺席时怎么办」，
 * 应用动作本身共用同一段代码（applyOrPark / applyFeedback）——两条路径各写一遍应用逻辑，
 * 正是它们迟早给出两个业务结果的开始。
 */
export interface DriverFeedbackProcessor {
  /** 消费一条 Driver 反馈交付项（outbox 通道） */
  process(
    delivery: DriverFeedbackRecord,
    context: DriverFeedbackProcessContext,
  ): Promise<DriverFeedbackProcessOutcome>;
  /** 归并一条寄存着的待归并反馈（pending_feedback 通道） */
  reconcile(
    pending: PendingFeedbackRecord,
    context: DriverFeedbackProcessContext,
  ): Promise<DriverFeedbackProcessOutcome>;
}

export interface DriverFeedbackProcessorOptions {
  deliveryRepository: MemoryDeliveryRepository;
  /** 经验的写入面：应用反馈要原子且幂等，因此走 repository 而不是 scope */
  repository: MemoryRepository;
  /** 下游 processor 的版本位，ack 时写进交付项（观测用） */
  processor_version?: string;
  /** 参考时刻（测试注入）；缺省取系统时间 */
  now?: () => string;
  /** claim/续租的租约时长；缺省用交付存储自己的 policy.lease_ms */
  lease_ms?: number;
  /** 心跳定时器（测试注入手动实现） */
  timers?: LeaseTimers;
}

/** 应用一次反馈的结果：要么拿到仓库的裁决，要么带着一份分类去落定 */
type ApplyAttempt =
  | { ok: true; result: ExperienceFeedbackResult }
  | { ok: false; failure: DeliveryFailureClassification };

/** 结果里那部分与具体输入无关的字段 */
type OutcomeBase = Pick<
  DriverFeedbackProcessOutcome,
  'feedback_id' | 'role_id' | 'experience_id' | 'attempt_count' | 'run_id'
>;

export class DefaultDriverFeedbackProcessor implements DriverFeedbackProcessor {
  constructor(private readonly options: DriverFeedbackProcessorOptions) {}

  async process(
    delivery: DriverFeedbackRecord,
    context: DriverFeedbackProcessContext,
  ): Promise<DriverFeedbackProcessOutcome> {
    const warnings: string[] = [];
    const base = outcomeBase(delivery, context);
    const token = delivery.claim_token;
    if (!token) return this.missingClaimToken(base, warnings, delivery.feedback_id);
    const invalid = validateFeedback(delivery);
    if (invalid) {
      return this.settleFailure('feedback', delivery, context, token, invalid, warnings, base);
    }

    const applied = await this.applyUnderLease('feedback', delivery, context, token, () =>
      this.applyOrPark(delivery, context, warnings),
    );
    if (applied.lost) {
      return this.skipAfterLostLease(delivery, context, warnings, base);
    }
    if (!applied.value.ok) {
      return this.settleFailure(
        'feedback',
        delivery,
        context,
        token,
        applied.value.failure,
        warnings,
        base,
      );
    }
    return this.complete('feedback', delivery, context, token, applied.value.result, warnings, base);
  }

  async reconcile(
    pending: PendingFeedbackRecord,
    context: DriverFeedbackProcessContext,
  ): Promise<DriverFeedbackProcessOutcome> {
    const warnings: string[] = [];
    const base = outcomeBase(pending, context);
    const token = pending.claim_token;
    if (!token) return this.missingClaimToken(base, warnings, pending.feedback_id);
    // 契约校验对寄存记录同样适用：它可能来自更早的版本（当时能被寄存，不代表现在读得懂）
    const invalid = validateFeedback(pending.feedback);
    if (invalid) {
      return this.settleFailure(
        'pending_feedback',
        pending,
        context,
        token,
        invalid,
        warnings,
        base,
      );
    }

    const applied = await this.applyUnderLease('pending_feedback', pending, context, token, () =>
      this.applyFeedback(pending.feedback),
    );
    if (applied.lost) {
      return this.skipAfterLostLease(pending, context, warnings, base);
    }
    if (!applied.value.ok) {
      return this.settleFailure(
        'pending_feedback',
        pending,
        context,
        token,
        applied.value.failure,
        warnings,
        base,
      );
    }
    if (applied.value.result.outcome === 'experience_missing') {
      // 还在等：按可重试失败退回队列，退避到点再来。这里**不**置死信、也不重复寄存——
      // 用满次数（pending 通道的重试预算）自然进死信，那一段等待时间就是保留期限。
      warnings.push(
        `Experience ${pending.experience_id} still does not exist; the feedback stays parked.`,
      );
      return this.settleFailure(
        'pending_feedback',
        pending,
        context,
        token,
        knownDeliveryFailure(
          'unknown',
          `experience_missing: Experience ${pending.experience_id} has not appeared yet.`,
          true,
        ),
        warnings,
        base,
      );
    }
    return this.complete(
      'pending_feedback',
      pending,
      context,
      token,
      applied.value.result,
      warnings,
      base,
    );
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private now(): string {
    return this.options.now ? this.options.now() : new Date().toISOString();
  }

  /**
   * 应用或寄存：经验在就写进去，不在就把反馈存进待归并队列。
   *
   * 顺序是刻意的：**先寄存，再由调用方 ack**。反过来（先 ack 再寄存）在两步之间崩溃时，
   * 交付已经是 processed，这条反馈却哪儿都没落下——它既不在 outbox 的待办里，也不在归并
   * 队列里，只能靠人去发现。先寄存后 ack 的最坏情况是「寄存成功、ack 失败」，重跑时会
   * 再走一遍：寄存按 feedback_id 幂等，应用按 feedback_id 幂等，都不会多出第二条。
   */
  private async applyOrPark(
    feedback: DriverFeedbackRecord,
    context: DriverFeedbackProcessContext,
    warnings: string[],
  ): Promise<ApplyAttempt> {
    const applied = await this.applyFeedback(feedback);
    if (!applied.ok) return applied;
    if (applied.result.outcome !== 'experience_missing') return applied;

    try {
      const parked = await this.options.deliveryRepository.submitPendingFeedback(
        buildPendingFeedbackRecord(feedback, this.now()),
      );
      if (!parked.created) {
        warnings.push(
          `Feedback ${feedback.feedback_id} was already parked under the same id; the existing record was kept (it may already be merged).`,
        );
      }
    } catch (error) {
      // 寄存没落地就绝不能 ack：这条反馈还没被任何地方接住。
      const classified = classifyDeliveryFailure(error);
      return {
        ok: false,
        failure: knownDeliveryFailure(
          'storage_error',
          `Failed to park feedback ${feedback.feedback_id} for later reconciliation: ${classified.message}`,
          classified.retryable,
        ),
      };
    }
    warnings.push(
      `Experience ${feedback.experience_id} does not exist yet; the feedback was parked for reconciliation.`,
    );
    return applied;
  }

  /** 应用一次反馈：仓库怎么裁决（写了 / 早就写过 / 经验不存在）由它给，这里只负责搬运 */
  private async applyFeedback(feedback: DriverFeedbackContent): Promise<ApplyAttempt> {
    try {
      return {
        ok: true,
        result: await this.options.repository.applyExperienceFeedback(
          feedback.role_id,
          feedbackApplicationOf(feedback),
        ),
      };
    } catch (error) {
      // 应用阶段的失败来源只有存储一个（没有模型调用、没有 Buffer），码固定 storage_error；
      // 可重试性仍沿用结构判定：ZodError 这种「记录形状不对」不该重投。
      const classified = classifyDeliveryFailure(error);
      return {
        ok: false,
        failure: knownDeliveryFailure('storage_error', classified.message, classified.retryable),
      };
    }
  }

  /**
   * 在租约心跳下做一次应用。
   *
   * 应用本身是一次存储往返（毫秒级），远短于租约，但心跳仍要挂上：租约的**判定**在下游
   * 一侧（回收只看 `lease_expires_at`），这里不续租，一次卡住的存储调用就足以让记录在别人
   * 眼里过期。心跳被拒的含义只有一个——这条记录已经不归我了，因此不写任何终态。
   */
  private async applyUnderLease<T>(
    channel: FeedbackChannel,
    record: DriverFeedbackRecord | PendingFeedbackRecord,
    context: DriverFeedbackProcessContext,
    token: string,
    work: () => Promise<T>,
  ): Promise<{ lost: false; value: T } | { lost: true }> {
    const lease_ms = this.options.lease_ms ?? this.options.deliveryRepository.policy.lease_ms;
    const heartbeat = startLeaseHeartbeat({
      renew: async () => {
        const renewed = await this.options.deliveryRepository.renewDeliveryClaim({
          channel,
          role_id: record.role_id,
          id: record.feedback_id,
          claim_token: token,
          owner: context.worker_id,
          lease_ms,
          now: this.now(),
        });
        return renewed !== undefined;
      },
      interval_ms: leaseRenewIntervalMs(lease_ms),
      ...(this.options.timers !== undefined ? { timers: this.options.timers } : {}),
    });
    let value: T;
    try {
      value = await work();
    } finally {
      await heartbeat.stop();
    }
    return heartbeat.lost ? { lost: true } : { lost: false, value };
  }

  /** ack：交付完成。写不进去说明凭据已经失效（租约过期被接手），这一条不归本次报完成 */
  private async complete(
    channel: FeedbackChannel,
    record: DriverFeedbackRecord | PendingFeedbackRecord,
    context: DriverFeedbackProcessContext,
    token: string,
    result: ExperienceFeedbackResult,
    warnings: string[],
    base: OutcomeBase,
  ): Promise<DriverFeedbackProcessOutcome> {
    const completed = await this.options.deliveryRepository.completeDelivery({
      channel,
      role_id: record.role_id,
      id: record.feedback_id,
      claim_token: token,
      owner: context.worker_id,
      ...(this.options.processor_version !== undefined
        ? { processor_version: this.options.processor_version }
        : {}),
      now: this.now(),
    });
    if (settledStatus(completed, channel) === undefined) {
      return {
        ...base,
        status: 'failed',
        warnings: [
          ...warnings,
          'The feedback was processed, but the delivery could not be acknowledged: this worker no longer holds the claim.',
        ],
        failure: knownDeliveryFailure(
          'unknown',
          'Delivery acknowledgement was rejected: the claim token is no longer valid.',
          true,
        ),
      };
    }
    const application: DriverFeedbackApplicationOutcome =
      result.outcome === 'experience_missing' ? 'parked' : result.outcome;
    return {
      ...base,
      status: 'completed',
      application,
      ...(result.outcome === 'applied' && result.experience
        ? { confidence: result.experience.confidence }
        : {}),
      warnings,
    };
  }

  /**
   * 按分类把记录落定：可重试的退回 pending，不可恢复的进 dead_letter。
   *
   * 终态取的是**写回之后的记录状态**而不是这次的判定：`retryable` 为真但投递次数已经
   * 用满时，状态机会直接置死信。以判定为准会把一条已经死信的记录报成「还会再来」，
   * run 的计数与现场就对不上了。
   */
  private async settleFailure(
    channel: FeedbackChannel,
    record: DriverFeedbackRecord | PendingFeedbackRecord,
    context: DriverFeedbackProcessContext,
    token: string,
    failure: DeliveryFailureClassification,
    warnings: string[],
    base: OutcomeBase,
  ): Promise<DriverFeedbackProcessOutcome> {
    const failed = await this.options.deliveryRepository.failDelivery({
      channel,
      role_id: record.role_id,
      id: record.feedback_id,
      claim_token: token,
      owner: context.worker_id,
      error: `${failure.code}: ${failure.message}`,
      retryable: failure.retryable,
      now: this.now(),
    });
    const settled = settledStatus(failed, channel);
    if (settled === undefined) {
      return {
        ...base,
        status: 'failed',
        failure,
        warnings: [
          ...warnings,
          `Feedback ${record.feedback_id} could not be settled: this worker no longer holds the claim, so its real state has to be recovered from the lease.`,
        ],
      };
    }
    return {
      ...base,
      status: settled === 'dead_letter' ? 'dead_letter' : 'retried',
      failure,
      warnings,
    };
  }

  /** 租约丢失后的收敛：什么都不写，如实说明「这一条现在不归我」 */
  private skipAfterLostLease(
    record: DriverFeedbackRecord | PendingFeedbackRecord,
    context: DriverFeedbackProcessContext,
    warnings: string[],
    base: OutcomeBase,
  ): DriverFeedbackProcessOutcome {
    return {
      ...base,
      status: 'skipped',
      warnings: [
        ...warnings,
        `The claim lease for ${record.feedback_id} was lost (or had expired) while worker ${context.worker_id} was processing it; nothing was written, so the current holder keeps its own claim.`,
      ],
    };
  }

  /** claim 记录必须带凭据，否则谁也写不了终态——当场报出来，而不是带着它往下走 */
  private missingClaimToken(
    base: OutcomeBase,
    warnings: string[],
    feedback_id: string,
  ): DriverFeedbackProcessOutcome {
    return {
      ...base,
      status: 'failed',
      warnings,
      failure: knownDeliveryFailure(
        'unknown',
        `Claimed feedback ${feedback_id} carries no claim_token; refusing to process it (the claim lease is the only thing fencing this write).`,
        false,
      ),
    };
  }
}

/**
 * 反馈记录自己声明的身份是否自洽。
 *
 * `feedback_id` / `feedback_key` 都是由 (role_id, task_id, experience_id, source, event_version)
 * 派生出来的，因此「声明的值」与「按声明的因子重算的值」必须一致——不一致说明这条记录被
 * 手工改过，或者来自另一套构造规则。这时**不能**照它去写：写出来的置信度历史会把一条来源
 * 不明的反馈记在某条经验名下，而那条经验不知道它是谁。
 *
 * 契约版本不认识同样属于坏输入：重投多少次都是同一个结论，直接死信。
 */
function validateFeedback(
  feedback: DriverFeedbackContent,
): DeliveryFailureClassification | undefined {
  if (!isSupportedFeedbackVersion(feedback.event_version)) {
    return knownDeliveryFailure(
      'payload_unreadable',
      `Feedback ${feedback.feedback_id} declares event_version=${feedback.event_version}, which this consumer cannot read (expected ${DRIVER_FEEDBACK_EVENT_VERSION}).`,
      false,
    );
  }
  if (!feedback.experience_id) {
    return knownDeliveryFailure(
      'payload_unreadable',
      `Feedback ${feedback.feedback_id} carries no experience_id to merge into.`,
      false,
    );
  }
  const expectedKey = driverFeedbackKey({
    role_id: feedback.role_id,
    task_id: feedback.task_id,
    experience_id: feedback.experience_id,
    feedback_source: feedback.feedback_source,
    event_version: feedback.event_version,
  });
  if (feedback.feedback_key !== expectedKey) {
    return knownDeliveryFailure(
      'payload_unreadable',
      `Feedback ${feedback.feedback_id} declares key ${feedback.feedback_key} but its own fields derive ${expectedKey}.`,
      false,
    );
  }
  const expectedId = driverFeedbackId(expectedKey);
  if (feedback.feedback_id !== expectedId) {
    return knownDeliveryFailure(
      'payload_unreadable',
      `Feedback ${feedback.feedback_id} does not match the id derived from its own fields (${expectedId}).`,
      false,
    );
  }
  return undefined;
}

/** 结果里那部分与具体输入无关的字段（两类记录都有 feedback_id / role_id / experience_id） */
function outcomeBase(
  record: DriverFeedbackRecord | PendingFeedbackRecord,
  context: DriverFeedbackProcessContext,
): OutcomeBase {
  return {
    feedback_id: record.feedback_id,
    role_id: record.role_id,
    experience_id: record.experience_id,
    attempt_count: record.attempt_count,
    ...(context.run_id !== undefined ? { run_id: context.run_id } : {}),
  };
}

/** 把 claim/ack 的联合返回值收窄成「落定在了什么状态」；通道不符（或什么都没写）时 undefined */
function settledStatus(
  claimed: ClaimedDelivery | undefined,
  channel: FeedbackChannel,
): DeliveryStatus | undefined {
  return claimed?.channel === channel ? claimed.item.status : undefined;
}
