/**
 * ContextDeliveryProcessor — 单条上下文交付项的消费（Phase 1 的处理内核）
 *
 * 把「一条已经被 claim 的 context delivery」变成「一次幂等的 Experience 落库 + 一次
 * Buffer 归档 + 一次交付 ack」，并且保证任何一步失败都有确定的、可重试的落点。批量、
 * run 记录、租约心跳的外壳在 context-delivery-worker.ts；这里只管一条。
 *
 * 处理顺序是刻意的，不是随便排的：
 *
 *   校验引用 → 取回 Buffer/Context → 提取 → 幂等落库 → 归档 Buffer → ack
 *                       ↑   可重试在这时退回 pending，不经过落库      ↑
 *                                                              归档失败就不 ack
 *
 * - **落库在归档之前**：Experience 没写进去就把它所在 Buffer 归档走，等于把这份输入
 *   从待办队列里抹掉而什么都没产出。反过来（先归档再落库）在归档成功、落库失败的窗口
 *   里会丢数据；先落库后归档的最坏情况是「经验写了两遍」——而落库是幂等的，重复一遍
 *   没有代价。可恢复的错误排序应当按「哪一边的重复更便宜」来定。
 * - **ack 在归档之后**：ack 是不可回滚的终态。归档失败（Buffer 还留在 pending）时抢先
 *   ack，会让「交付完成」与「输入还在待办队列」同时为真，而重试路径再也走不到——记录
 *   已经是 processed 了。所以归档没落地就不 ack，让交付按可重试失败退回队列：下次重跑
 *   时提取会命中稳定 id 跳过（不产生第二份经验），只是把归档补上。
 *
 * 崩溃点是同样的道理：无论进程死在「落库之后 / 归档之前」还是「归档之后 / ack 之前」，
 * 重启后记录都还会被重新投递；重跑的每一步都是幂等的（稳定 experience id、
 * archiveBuffer 的 already_archived、completeDelivery 的 token 匹配），因此不会产生
 * 第二份经验，也不会把别人的成果覆盖掉。
 *
 * **不做的事**：不晋升 Skill、不演化 Persona。那两件事由后续独立的 job 负责，这个进程
 * 只把上下文变成 Experience。
 */
import type { ContextDeliveryItem } from '../schemas';
import { CONTEXT_DELIVERY_SCHEMA_VERSION } from '../schemas';
import type {
  BufferArchiveOutcome,
  BufferRepository,
  StoredBuffer,
} from '../ports/buffer-repository';
import type { ClaimedDelivery, MemoryDeliveryRepository } from '../ports/memory-delivery';
import type { ExperienceExtractor } from '../ports/experience-extractor';
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
  persistExtractedExperiences,
  type MemoryScopeFactory,
  type PersistedExtraction,
} from '../services/memory-cycle';

/**
 * 一条交付项处理完之后落在哪里。
 *
 * 前四种各自对应 run 的一个计数（见 schemas 的 MaintenanceRunCounts）；`failed` 是
 * 「连失败都没能记下来」——本 worker 侧的失败，与交付自己的成败分开计。
 */
export type ContextDeliveryProcessStatus =
  /** Experience 已落库、Buffer 已归档、交付已 processed */
  | 'completed'
  /** 可重试失败：已按退避回到 pending，下次还会被投递 */
  | 'retried'
  /** 不可恢复或次数用满：已进 dead_letter */
  | 'dead_letter'
  /** 本次不归我（租约被抢走 / 记录已被别人处理），刻意没写任何终态 */
  | 'skipped'
  /** 终态没写进去（凭据失效、存储写失败），这一条的真实状态只能等租约恢复 */
  | 'failed';

/** 一条交付项的处理结果：既给 run 计数，也给事后排查 */
export interface ContextDeliveryProcessOutcome {
  status: ContextDeliveryProcessStatus;
  delivery_id: string;
  role_id: string;
  buffer_seq: number;
  /** 处理前这条记录的投递次数（claim 时已经 +1） */
  attempt_count: number;
  /** 处理它的那次 run（诊断用；同一批里的记录共享一个 run_id） */
  run_id?: string;
  /** 失败时的规范化分类；成功时为 undefined */
  failure?: DeliveryFailureClassification;
  /** 归档结果（走到那一步时才有），including 失败与「无事可归档」两类 */
  archive?: BufferArchiveOutcome;
  experiences_created: number;
  experiences_already_present: number;
  /** 不构成失败但需要人看见的事实（上下文缺席、归档落在别处分区、经验重复跳过…） */
  warnings: string[];
}

/** 处理一条交付项时随行的身份信息 */
export interface ContextDeliveryProcessContext {
  /** 本次消费的 worker 标识，同时用作 claim owner（与 run 记录里的 worker_id 同源） */
  worker_id: string;
  /** 承载这条记录的 maintenance run */
  run_id?: string;
}

/**
 * 单条上下文交付项的处理器。
 *
 * 形态是按计划 §6 定的：`process(delivery, context)`。worker 只依赖这个接口，因此批量、
 * 心跳、run 记录这些外壳可以单独测试，处理器也能被替身顶掉。
 */
export interface ContextDeliveryProcessor {
  process(
    delivery: ContextDeliveryItem,
    context: ContextDeliveryProcessContext,
  ): Promise<ContextDeliveryProcessOutcome>;
}

export interface ContextDeliveryProcessorOptions {
  deliveryRepository: MemoryDeliveryRepository;
  /**
   * Buffer 的读取面。
   *
   * 刻意不经 AgentMemoryScope：交付项只存引用不存 payload，而「这条上下文还在不在、
   * 在哪」要跨三个分区回答（交付被重投时 Buffer 可能已经被上一轮归档走了）。scope 的
   * getPendingBuffer 回答的是另一个问题（「还有什么等着处理」），拿它顶替会让重投在
   * 「归档成功、ack 失败」的窗口里读不到输入而误判成坏记录。
   */
  bufferRepository: BufferRepository;
  /** 构造 role 绑定作用域（落库时确定 Experience 归属），由组合根注入 */
  scopeFactory: MemoryScopeFactory;
  extractor: ExperienceExtractor;
  /** 下游 processor 的版本位，ack 时写进交付项（观测用） */
  processor_version?: string;
  /** 参考时刻（测试注入）；缺省取系统时间 */
  now?: () => string;
  /** claim/续租的租约时长；缺省用交付存储自己的 policy.lease_ms */
  lease_ms?: number;
  /** 心跳定时器（测试注入手动实现） */
  timers?: LeaseTimers;
}

/** 处理管线上的阶段，只用于「这次失败该按谁定性」 */
type ProcessStage = 'extract' | 'persist';

export class DefaultContextDeliveryProcessor implements ContextDeliveryProcessor {
  constructor(private readonly options: ContextDeliveryProcessorOptions) {}

  async process(
    delivery: ContextDeliveryItem,
    context: ContextDeliveryProcessContext,
  ): Promise<ContextDeliveryProcessOutcome> {
    const warnings: string[] = [];
    const base = {
      delivery_id: delivery.delivery_id,
      role_id: delivery.role_id,
      buffer_seq: delivery.buffer_seq,
      attempt_count: delivery.attempt_count,
      ...(context.run_id !== undefined ? { run_id: context.run_id } : {}),
      experiences_created: 0,
      experiences_already_present: 0,
    };

    const token = delivery.claim_token;
    if (!token) {
      // claim 一定会发一个凭据。没有它就写不了终态，也没有任何合法路径能推进这条记录——
      // 与其带着一个「看起来在处理、实际谁也 fence 不住」的状态往下走，不如当场报出来。
      return {
        ...base,
        status: 'failed',
        warnings,
        failure: knownDeliveryFailure(
          'unknown',
          'Claimed context delivery carries no claim_token; refusing to process it.',
          false,
        ),
      };
    }

    const inputFailure = this.validateInput(delivery);
    if (inputFailure) {
      // 坏输入不值得重投：直接按不可恢复失败落定。
      return this.settleFailure(delivery, context, token, inputFailure, warnings, base);
    }

    const loaded = await this.loadInput(delivery);
    if (!loaded.ok) {
      return this.settleFailure(delivery, context, token, loaded.failure, warnings, base);
    }
    const snapshot = loaded.stored;
    if (snapshot.agentContextStatus === 'unreadable') {
      // 声明过上下文却读不出来：半份输入不是「没有上下文」，拒绝提取（与 memory-cycle 的
      // assertContextUsable 同一判据），并按坏输入落定死信而不是徒劳重投。
      return this.settleFailure(
        delivery,
        context,
        token,
        knownDeliveryFailure(
          'payload_unreadable',
          snapshot.agentContextError ??
            `Agent context for Buffer ${bufferRef(delivery)} was declared but could not be read.`,
          false,
        ),
        warnings,
        base,
      );
    }
    if (snapshot.location === 'dead_letter') {
      // 这条 Buffer 早先被别的路径判过死信。交付是权威：输入本身读得出来就照常提取，
      // 只是归档时会落到 not_pending——把这件事留在 warnings 里，别让「它曾在死信区」无声消失。
      warnings.push(
        `Buffer ${bufferRef(delivery)} currently sits in the dead_letter partition; the delivery is processed from it regardless.`,
      );
    }

    const lease_ms = this.options.lease_ms ?? this.options.deliveryRepository.policy.lease_ms;
    const heartbeat = startLeaseHeartbeat({
      renew: () => this.renew(delivery, context, token, lease_ms),
      interval_ms: leaseRenewIntervalMs(lease_ms),
      ...(this.options.timers !== undefined ? { timers: this.options.timers } : {}),
      onError: (error) => {
        warnings.push(
          `Lease renewal for ${delivery.delivery_id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });

    let stage: ProcessStage = 'extract';
    let persisted: PersistedExtraction | undefined;
    let archive: BufferArchiveOutcome | undefined;
    try {
      const extraction = await this.options.extractor.extract(
        snapshot.snapshot,
        snapshot.agentContext,
      );
      warnings.push(...(extraction.warnings ?? []));
      if (heartbeat.lost) {
        // 提取期间租约就没了：**不再往下写**。落库与归档都是对一条（可能）已经属于别人的
        // 记录的动作——幂等能保证写不坏，但白干一遍仍然要去争同一把锁，没有任何理由。
        await heartbeat.stop();
        return this.skipAfterLostLease(delivery, context, warnings, base);
      }

      stage = 'persist';
      persisted = await persistExtractedExperiences(
        this.options.scopeFactory(delivery.role_id),
        delivery.buffer_seq,
        extraction.experiences,
      );
      if (persisted.already_present > 0) {
        warnings.push(
          `${String(persisted.already_present)} extracted experience(s) for Buffer ${bufferRef(delivery)} were already stored and were not written again.`,
        );
      }

      // 归档：把已经消费完的输入移出待办队列。它不改交付状态，所以放到落库之后、
      // ack 之前——失败时我们能选择不 ack（见文件头注释）。
      archive = await this.options.bufferRepository.archiveBuffer(
        delivery.role_id,
        delivery.buffer_seq,
      );
    } catch (error) {
      await heartbeat.stop();
      if (heartbeat.lost) return this.skipAfterLostLease(delivery, context, warnings, base);
      return this.settleFailure(
        delivery,
        context,
        token,
        failureForStage(stage, error),
        warnings,
        base,
      );
    }
    await heartbeat.stop();
    if (heartbeat.lost) {
      // 处理期间租约已经易主：这条记录现在（可能）归别人。什么都不写——尤其不能 ack，
      // 那会把新持有者正在做的工作说成「已完成」。
      return this.skipAfterLostLease(delivery, context, warnings, base, archive, persisted);
    }

    const counts = {
      experiences_created: persisted.created,
      experiences_already_present: persisted.already_present,
    };
    if (archive.status === 'failed') {
      // 输入还在 pending：不 ack，按可重试失败退回队列。重跑时提取会命中稳定 id 跳过，
      // 只补做归档，因此重复执行不会产生第二份经验。
      warnings.push(`Buffer ${bufferRef(delivery)} is still pending: ${archive.message}`);
      return this.settleFailure(
        delivery,
        context,
        token,
        knownDeliveryFailure('storage_error', archive.message, true),
        warnings,
        { ...base, ...counts },
        archive,
      );
    }
    if (archive.status === 'missing') {
      warnings.push(
        `Buffer ${bufferRef(delivery)} is in no partition; there was nothing left to archive.`,
      );
    }
    if (archive.status === 'not_pending') {
      warnings.push(
        `Buffer ${bufferRef(delivery)} was not in pending (${archive.location}); nothing to archive.`,
      );
    }

    const completed = await this.options.deliveryRepository.completeDelivery({
      channel: 'context',
      role_id: delivery.role_id,
      id: delivery.delivery_id,
      claim_token: token,
      owner: context.worker_id,
      ...(this.options.processor_version !== undefined
        ? { processor_version: this.options.processor_version }
        : {}),
      now: this.now(),
    });
    const item = contextItemOf(completed);
    if (!item) {
      // 凭着据写不进去：记录已经被别人接手，或者我们的租约在最后一步过期了。经验与归档
      // 都已经落地（那是幂等的，不算白干），但这条交付**不能**被报成完成。
      return {
        ...base,
        ...counts,
        status: 'failed',
        archive,
        warnings: [
          ...warnings,
          'Experience and archive landed, but the delivery could not be acknowledged: this worker no longer holds the claim.',
        ],
        failure: knownDeliveryFailure(
          'unknown',
          'Delivery acknowledgement was rejected: the claim token is no longer valid.',
          true,
        ),
      };
    }
    return { ...base, ...counts, status: 'completed', archive, warnings };
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private now(): string {
    return this.options.now ? this.options.now() : new Date().toISOString();
  }

  /** 续租一次；返回 false 即失去持有权（凭据失效 / 租约已过期） */
  private async renew(
    delivery: ContextDeliveryItem,
    context: ContextDeliveryProcessContext,
    token: string,
    lease_ms: number,
  ): Promise<boolean> {
    const renewed = await this.options.deliveryRepository.renewDeliveryClaim({
      channel: 'context',
      role_id: delivery.role_id,
      id: delivery.delivery_id,
      claim_token: token,
      owner: context.worker_id,
      lease_ms,
      now: this.now(),
    });
    return renewed !== undefined;
  }

  /**
   * 交付项自己声明的引用是否自洽。
   *
   * 这些字段全部由 buildContextDeliveryItem 从 (role_id, buffer_seq) 与 Buffer 快照派生，
   * 因此「声明的值」与「按声明的键重算的值」必须一致——不一致说明这条记录被手工改过，
   * 或者来自另一套构造规则。这时**不能**照它去读：读出来的可能根本不是它说的那份输入。
   */
  private validateInput(delivery: ContextDeliveryItem): DeliveryFailureClassification | undefined {
    if (delivery.schema_version !== CONTEXT_DELIVERY_SCHEMA_VERSION) {
      return knownDeliveryFailure(
        'payload_unreadable',
        `Context delivery ${delivery.delivery_id} declares schema_version=${delivery.schema_version}, which this consumer cannot read (expected ${CONTEXT_DELIVERY_SCHEMA_VERSION}).`,
        false,
      );
    }
    if (!Number.isInteger(delivery.buffer_seq) || delivery.buffer_seq <= 0) {
      return knownDeliveryFailure(
        'payload_unreadable',
        `Context delivery ${delivery.delivery_id} carries an invalid buffer_seq (${String(delivery.buffer_seq)}).`,
        false,
      );
    }
    if (delivery.memory_buffer_ref !== bufferRef(delivery)) {
      return knownDeliveryFailure(
        'payload_unreadable',
        `Context delivery ${delivery.delivery_id} points at ${delivery.memory_buffer_ref} but role/seq resolve to ${bufferRef(delivery)}.`,
        false,
      );
    }
    if (delivery.report_ref !== `report_${String(delivery.buffer_seq)}.json`) {
      return knownDeliveryFailure(
        'payload_unreadable',
        `Context delivery ${delivery.delivery_id} references report ${delivery.report_ref} but role/seq resolve to report_${String(delivery.buffer_seq)}.json.`,
        false,
      );
    }
    return undefined;
  }

  /**
   * 取回完整输入：DriverReturn + 配对的 AgentContextSnapshot。
   *
   * 用 getStoredBuffer 而不是 getPendingBuffer：交付项只存引用，而这条引用在「归档成功、
   * ack 失败」之后指向的是一份已经离开 pending 的 Buffer——重投时它仍然必须读得出来，
   * 否则幂等重跑会把自己的输入判成缺失。
   */
  private async loadInput(delivery: ContextDeliveryItem): Promise<LoadedInput> {
    let stored: StoredBuffer | undefined;
    try {
      stored = await this.options.bufferRepository.getStoredBuffer(
        delivery.role_id,
        delivery.buffer_seq,
      );
    } catch (error) {
      // 报告文件本身读不出来（缺文件 / JSON 坏 / schema 不匹配）：坏输入，重投不会变好。
      return {
        ok: false,
        failure: knownDeliveryFailure(
          'payload_unreadable',
          `Buffer ${bufferRef(delivery)} could not be read: ${error instanceof Error ? error.message : String(error)}`,
          false,
        ),
      };
    }
    if (!stored) {
      return {
        ok: false,
        failure: knownDeliveryFailure(
          'payload_unreadable',
          `Buffer ${bufferRef(delivery)} referenced by delivery ${delivery.delivery_id} is in no partition (pending / processed / dead_letter).`,
          false,
        ),
      };
    }
    if (delivery.context_snapshot_ref !== stored.snapshot.context_snapshot_ref) {
      return {
        ok: false,
        failure: knownDeliveryFailure(
          'payload_unreadable',
          `Context delivery ${delivery.delivery_id} declares context ref ${delivery.context_snapshot_ref ?? '(none)'} but Buffer ${bufferRef(delivery)} declares ${stored.snapshot.context_snapshot_ref ?? '(none)'}.`,
          false,
        ),
      };
    }
    return { ok: true, stored };
  }

  /** 租约丢失后的收敛：什么都不写，如实说明「这一条现在不归我」 */
  private skipAfterLostLease(
    delivery: ContextDeliveryItem,
    context: ContextDeliveryProcessContext,
    warnings: string[],
    base: OutcomeBase,
    archive?: BufferArchiveOutcome,
    persisted?: PersistedExtraction,
  ): ContextDeliveryProcessOutcome {
    return {
      ...base,
      ...(persisted
        ? {
            experiences_created: persisted.created,
            experiences_already_present: persisted.already_present,
          }
        : {}),
      status: 'skipped',
      ...(archive !== undefined ? { archive } : {}),
      warnings: [
        ...warnings,
        `The claim lease for ${delivery.delivery_id} was lost (or had expired) while worker ${context.worker_id} was processing it; nothing was written, so the current holder keeps its own claim.`,
      ],
    };
  }

  /**
   * 按分类把交付落定：可重试的退回 pending，不可恢复的进 dead_letter。
   *
   * 终态取的是**写回之后的记录状态**而不是这次的判定：`retryable` 为真但投递次数已经
   * 用满时，状态机会直接置死信。以判定为准会把一条已经死信的记录报成「还会再来」，
   * run 的计数与现场就对不上了。
   */
  private async settleFailure(
    delivery: ContextDeliveryItem,
    context: ContextDeliveryProcessContext,
    token: string,
    failure: DeliveryFailureClassification,
    warnings: string[],
    base: OutcomeBase,
    archive?: BufferArchiveOutcome,
  ): Promise<ContextDeliveryProcessOutcome> {
    const failed = await this.options.deliveryRepository.failDelivery({
      channel: 'context',
      role_id: delivery.role_id,
      id: delivery.delivery_id,
      claim_token: token,
      owner: context.worker_id,
      error: `${failure.code}: ${failure.message}`,
      retryable: failure.retryable,
      now: this.now(),
    });
    const item = contextItemOf(failed);
    if (!item) {
      return {
        ...base,
        status: 'failed',
        failure,
        ...(archive !== undefined ? { archive } : {}),
        warnings: [
          ...warnings,
          `Delivery ${delivery.delivery_id} could not be settled: this worker no longer holds the claim, so its real state has to be recovered from the lease.`,
        ],
      };
    }
    return {
      ...base,
      status: item.status === 'dead_letter' ? 'dead_letter' : 'retried',
      failure,
      ...(archive !== undefined ? { archive } : {}),
      warnings,
    };
  }
}

/** 结果里那部分与具体阶段无关的字段 */
type OutcomeBase = Pick<
  ContextDeliveryProcessOutcome,
  | 'delivery_id'
  | 'role_id'
  | 'buffer_seq'
  | 'attempt_count'
  | 'run_id'
  | 'experiences_created'
  | 'experiences_already_present'
>;

/** 输入装载结果：要么拿到完整输入，要么拿到一份「为什么读不出来」的定性 */
type LoadedInput =
  | { ok: true; stored: StoredBuffer }
  | { ok: false; failure: DeliveryFailureClassification };

/** `{role_id}:{buffer_seq}` —— 与 Buffer 分区上的引用同源 */
function bufferRef(delivery: ContextDeliveryItem): string {
  return `${delivery.role_id}:${String(delivery.buffer_seq)}`;
}

/**
 * 失败码按阶段定性：提取阶段的异常形状（工具类 errno / AbortError / ZodError）本身就是
 * 判据，交给 classifyDeliveryFailure；落库阶段的失败来源只有存储一个，码固定为
 * storage_error，可重试性仍沿用结构判定（ZodError 这种「记录形状不对」不该重投）。
 */
function failureForStage(stage: ProcessStage, error: unknown): DeliveryFailureClassification {
  const classified = classifyDeliveryFailure(error);
  if (stage === 'extract') return classified;
  return knownDeliveryFailure('storage_error', classified.message, classified.retryable);
}

/** 把 claim/ack 的联合返回值收窄成上下文交付项；通道不是 context 时返回 undefined */
function contextItemOf(claimed: ClaimedDelivery | undefined): ContextDeliveryItem | undefined {
  return claimed?.channel === 'context' ? claimed.item : undefined;
}
