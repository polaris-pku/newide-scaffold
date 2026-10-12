/**
 * DriverFeedbackWorker — Driver 反馈的批量消费与归并外壳（Phase 2）
 *
 * 处理内核在 driver-feedback-processor.ts（一条反馈怎么变成经验上的一次回写）。这里负责
 * 「一次运行」这件事本身：开一条 maintenance run、按上限批量 claim、逐条隔离、边跑边计数、
 * 收尾写结论。两者的分工与 Phase 1 一致——内核只管一条记录的状态与副作用，外壳管批量与观测。
 *
 * 两个入口，两条队列，两套 run：
 *
 * - `runOnce`：消费 Driver 反馈 outbox（job_type `driver_feedback`）。这是「新反馈进来了」。
 * - `reconcilePending`：归并待归并队列（job_type `feedback_reconcile`）。这是「当初等的那条
 *   经验出现了没有」。两者分开计数、分开 run，运维才分得清积压属于哪一边：一个是上游还在
 *   产出的输入，一个是自己在等的等待项。
 *
 * 两条队列各有自己的重试预算（见 delivery-lifecycle 的 resolveChannelRetryPolicy）：消费
 * 失败多是存储抖动，退避要短；等 Experience 出现的每一次尝试要拉开间隔，次数也多给，
 * 那一段累计等待就是待归并反馈的保留期限。
 *
 * 几条不能松的约束（与 Phase 1 的上下文 worker 相同，理由也相同）：
 *
 * - **只 claim 自己那条通道**，绝不顺带处理另一条——两条队列的失败上限与退避不同，
 *   一条的积压不该拖住另一条。
 * - **claim 数量与墙钟都有上限**，没有活就立刻返回，不轮询、不忙等；调度是外部的事。
 * - **单条失败不阻塞同批**：一条记录的异常只影响它自己的计数。
 * - **启动恢复先跑**：先把租约过期仍停在 processing 的本通道记录放回队列，再去消费。
 * - run 是观测与审计实体，不是事务边界：它失败不代表反馈失败，反之亦然。
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import type {
  DriverFeedbackRecord,
  MaintenanceFailure,
  MaintenanceJobType,
  MaintenanceRun,
  MaintenanceRunCounts,
  PendingFeedbackRecord,
} from '../schemas';
import type { ClaimedDelivery, MemoryDeliveryRepository } from '../ports/memory-delivery';
import type { MaintenanceRunStore } from '../ports/maintenance-run-store';
import { EMPTY_MAINTENANCE_RUN_COUNTS } from '../services/maintenance-run-lifecycle';
import { classifyDeliveryFailure } from '../services/delivery-error-classification';
import type {
  DriverFeedbackProcessContext,
  DriverFeedbackProcessOutcome,
  DriverFeedbackProcessor,
} from './driver-feedback-processor';

/** 一次运行缺省的 claim 上限；显式传 batchSize 可覆盖 */
export const DEFAULT_DRIVER_FEEDBACK_BATCH_SIZE = 20;
/** 一次运行缺省的墙钟上限（毫秒） */
export const DEFAULT_DRIVER_FEEDBACK_MAX_DURATION_MS = 60_000;

/** 本 worker 能跑的两种 run */
export type DriverFeedbackJob = Extract<
  MaintenanceJobType,
  'driver_feedback' | 'feedback_reconcile'
>;

/** 两条队列的记录：外壳只用它们共有的那几列（id / role / 关联经验 / 投递次数） */
type QueuedFeedback = DriverFeedbackRecord | PendingFeedbackRecord;

/** 每种的 job 对应哪条队列 */
const CHANNEL_OF_JOB = {
  driver_feedback: 'feedback',
  feedback_reconcile: 'pending_feedback',
} as const;

export interface DriverFeedbackWorkerOptions {
  deliveryRepository: MemoryDeliveryRepository;
  runStore: MaintenanceRunStore;
  processor: DriverFeedbackProcessor;
  /**
   * 消费者标识：既写进 run 记录，也作为 claim owner。
   *
   * 缺省按实例生成一个——同一个 worker 的多次运行共享它，重启后换一个新的。owner 只作
   * 交叉核对，真正的判据是每次 claim 发下的 token（见 delivery-lifecycle 的说明）。
   */
  worker_id?: string;
  /** claim / 续租的租约时长；缺省用交付存储自己的 policy.lease_ms */
  lease_ms?: number;
  /** 只消费该 role 的记录；缺省跨 role */
  role_id?: string;
  /** 参考时刻（测试注入）；缺省取系统时间 */
  now?: () => string;
  /** runOnce / reconcilePending 的缺省批量上限 */
  batch_size?: number;
  /** runOnce / reconcilePending 的缺省墙钟上限 */
  max_duration_ms?: number;
  /** 缺省是否先做启动恢复；缺省 true */
  restore_expired?: boolean;
}

export interface DriverFeedbackRunOptions {
  /** 本次最多 claim 多少条；缺省用 worker 配置，再缺省用 DEFAULT_DRIVER_FEEDBACK_BATCH_SIZE */
  batchSize?: number;
  /** 本次墙钟上限（毫秒） */
  maxDurationMs?: number;
  /** 优雅停止信号：置位后不再 claim 新记录，在途的那条照常跑完 */
  signal?: AbortSignal;
  /** 本次是否先做启动恢复；缺省用 worker 配置 */
  restoreExpired?: boolean;
  /** 只处理该 role 的记录；缺省用 worker 配置 */
  role_id?: string;
  /** 本次运行的参考时刻（同时作为 run 的 started_at）；缺省取当前时间 */
  now?: string;
}

/** 批次为什么停下来 */
export type DriverFeedbackStopReason =
  | 'no_work'
  | 'batch_size'
  | 'max_duration'
  | 'aborted'
  | 'worker_error';

export interface DriverFeedbackRunResult {
  /** 本次跑的是哪条队列的 run（消费新反馈 / 归并等待项） */
  job: DriverFeedbackJob;
  /** 本次运行的记录（已收尾） */
  run: MaintenanceRun;
  counts: MaintenanceRunCounts;
  stop_reason: DriverFeedbackStopReason;
  /** 启动恢复放回队列的条数（没做恢复时为 0） */
  restored_count: number;
  /** 逐条结果：run 计数之外的诊断面（失败码、应用去向、warnings） */
  outcomes: DriverFeedbackProcessOutcome[];
  /** 外壳自身失败（claim 读到存储故障等）时的规范化原因；成功运行时为 undefined */
  worker_failure?: MaintenanceFailure;
}

export interface DriverFeedbackRestoreResult {
  count: number;
}

export class DriverFeedbackWorker {
  readonly worker_id: string;
  private readonly now: () => string;

  constructor(private readonly options: DriverFeedbackWorkerOptions) {
    this.worker_id = options.worker_id ?? `driver-feedback-worker-${randomUUID()}`;
    this.now = options.now ?? nowTimestamp;
  }

  /** 消费一批 Driver 反馈 outbox 记录（memory 反馈通道的 `driver_feedback` run） */
  runOnce(options: DriverFeedbackRunOptions = {}): Promise<DriverFeedbackRunResult> {
    return this.runBatch('driver_feedback', options, {
      narrow: (claimed) => (claimed.channel === 'feedback' ? claimed.item : undefined),
      process: (item, context) => this.options.processor.process(item, context),
    });
  }

  /**
   * 归并一批待归并反馈（`feedback_reconcile` run）。
   *
   * 与 runOnce 用的是同一套批量外壳，只是换了一条队列与一个内核方法：归并任务**只**处理
   * 自己那条队列，不顺手去消费 outbox——两件事的触发周期与失败预算本来就不同。
   */
  reconcilePending(options: DriverFeedbackRunOptions = {}): Promise<DriverFeedbackRunResult> {
    return this.runBatch('feedback_reconcile', options, {
      narrow: (claimed) => (claimed.channel === 'pending_feedback' ? claimed.item : undefined),
      process: (item, context) => this.options.processor.reconcile(item, context),
    });
  }

  /**
   * 启动恢复：把租约过期仍停在 processing 的记录放回可投递队列。
   *
   * 直接复用交付存储自己的恢复能力——它逐条在临界区里重新判过期，因此不会把「列举之后
   * 已经被别人完成了」的记录重投一次。缺省恢复本 worker 管的两条通道（outbox 与待归并队列）；
   * 上下文交付通道归 Phase 1 的 worker，不在本进程的职责里。
   */
  async restoreExpired(
    options: {
      channel?: 'feedback' | 'pending_feedback';
      now?: string;
      role_id?: string;
    } = {},
  ): Promise<DriverFeedbackRestoreResult> {
    const channels = options.channel
      ? [options.channel]
      : (['feedback', 'pending_feedback'] as const);
    let count = 0;
    for (const channel of channels) {
      const restored = await this.options.deliveryRepository.restoreExpiredDeliveryClaims({
        channel,
        now: options.now ?? this.now(),
        ...(options.role_id !== undefined ? { role_id: options.role_id } : {}),
      });
      count += restored.length;
    }
    return { count };
  }

  // ── 内部 ────────────────────────────────────────────────────────

  /**
   * 批量外壳：开 run → （缺省先做启动恢复）→ 批量 claim 并逐条处理 → 收尾。
   *
   * 只有外壳自己的故障（claim 读不动存储）才会把 run 标成 failed；反馈项自己的成败只体现
   * 在计数里——一次「9 条归并、1 条进死信」的运行是正常的运行，不是失败的运行。
   */
  private async runBatch<TItem extends QueuedFeedback>(
    job: DriverFeedbackJob,
    options: DriverFeedbackRunOptions,
    pipeline: {
      /** 从 claim/ack 的联合返回值里取出本通道的记录（判据与 job 一致，只是让类型收窄） */
      narrow: (claimed: ClaimedDelivery) => TItem | undefined;
      process: (
        item: TItem,
        context: DriverFeedbackProcessContext,
      ) => Promise<DriverFeedbackProcessOutcome>;
    },
  ): Promise<DriverFeedbackRunResult> {
    const batchSize =
      options.batchSize ?? this.options.batch_size ?? DEFAULT_DRIVER_FEEDBACK_BATCH_SIZE;
    const maxDurationMs =
      options.maxDurationMs ??
      this.options.max_duration_ms ??
      DEFAULT_DRIVER_FEEDBACK_MAX_DURATION_MS;
    if (!Number.isInteger(batchSize) || batchSize < 0) {
      throw new Error('Driver feedback batchSize must be a non-negative integer.');
    }
    if (!Number.isFinite(maxDurationMs) || maxDurationMs < 0) {
      throw new Error('Driver feedback maxDurationMs must be a non-negative number.');
    }

    const channel = CHANNEL_OF_JOB[job];
    const startedAt = options.now ?? this.now();
    const startedMs = Date.parse(startedAt);
    const roleId = options.role_id ?? this.options.role_id;
    const run = await this.options.runStore.start({
      job_type: job,
      worker_id: this.worker_id,
      now: startedAt,
    });

    const counts: MaintenanceRunCounts = { ...EMPTY_MAINTENANCE_RUN_COUNTS };
    const outcomes: DriverFeedbackProcessOutcome[] = [];
    let stopReason: DriverFeedbackStopReason = 'no_work';
    let workerFailure: MaintenanceFailure | undefined;
    let restoredCount = 0;

    try {
      if (options.restoreExpired ?? this.options.restore_expired ?? true) {
        const restored = await this.restoreExpired({
          channel,
          now: startedAt,
          ...(roleId !== undefined ? { role_id: roleId } : {}),
        });
        restoredCount = restored.count;
      }

      while (true) {
        if (options.signal?.aborted) {
          stopReason = 'aborted';
          break;
        }
        if (outcomes.length >= batchSize) {
          stopReason = 'batch_size';
          break;
        }
        if (Date.parse(this.now()) - startedMs >= maxDurationMs) {
          stopReason = 'max_duration';
          break;
        }
        const claimed = await this.options.deliveryRepository.claimNextDelivery({
          channel,
          owner: this.worker_id,
          now: this.now(),
          // 与处理器续租时用的是同一个表达式：claim 多久就续多久，否则会出现「领了 5 秒
          // 租约、却按 60 秒去续」这种自我矛盾的组合（前者先过期，记录被别人捡走）。
          lease_ms: this.options.lease_ms ?? this.options.deliveryRepository.policy.lease_ms,
          ...(roleId !== undefined ? { role_id: roleId } : {}),
        });
        const item = claimed ? pipeline.narrow(claimed) : undefined;
        if (!item) {
          // 没有到期记录就是「这次没活」——退避窗口没到 / 队列空 / 已被别人领走，
          // 都是同一件事，不需要在这里等。
          stopReason = 'no_work';
          break;
        }
        counts.claimed_count += 1;
        outcomes.push(await this.processOne(item, run.run_id, pipeline.process));
        countOutcome(counts, outcomes[outcomes.length - 1]!);
      }
    } catch (error) {
      // 外壳自己出问题（claim 读不动存储等）：如实把 run 标成 failed，并保留已处理的计数。
      const classified = classifyDeliveryFailure(error);
      workerFailure = { code: classified.code, message: classified.message };
      counts.failure_count += 1;
      stopReason = 'worker_error';
    }

    const lastError = lastErrorOf(outcomes, workerFailure);
    const finished =
      workerFailure === undefined
        ? await this.options.runStore.finish(run.run_id, {
            ...counts,
            ...(lastError !== undefined ? { last_error: lastError } : {}),
            now: this.now(),
          })
        : await this.options.runStore.fail(run.run_id, workerFailure, {
            ...counts,
            now: this.now(),
          });
    if (!finished) {
      // 唯一可能是这条 run 已经是终态——run_id 是本进程刚开的，别人碰不到它。
      throw new Error(`Maintenance run ${run.run_id} could not be settled; it was already terminal.`);
    }

    return {
      job,
      run: finished,
      counts,
      stop_reason: stopReason,
      restored_count: restoredCount,
      outcomes,
      ...(workerFailure !== undefined ? { worker_failure: workerFailure } : {}),
    };
  }

  /**
   * 处理一条记录，并把处理器抛出的异常收进结果里。
   *
   * 处理器本该自己收敛所有失败（它拿得到 token，也只能由它写终态）；真抛出来说明有
   * 意料之外的缺陷。这时**不能**让异常掀掉整批：这一条记成 worker 侧失败，余下的照常处理。
   */
  private async processOne<TItem extends QueuedFeedback>(
    item: TItem,
    runId: string,
    process: (
      item: TItem,
      context: DriverFeedbackProcessContext,
    ) => Promise<DriverFeedbackProcessOutcome>,
  ): Promise<DriverFeedbackProcessOutcome> {
    try {
      return await process(item, { worker_id: this.worker_id, run_id: runId });
    } catch (error) {
      return {
        status: 'failed',
        feedback_id: item.feedback_id,
        role_id: item.role_id,
        experience_id: item.experience_id,
        attempt_count: item.attempt_count,
        run_id: runId,
        failure: classifyDeliveryFailure(error),
        warnings: ['The processor threw before it could settle this feedback.'],
      };
    }
  }
}

/** 一条结果落到哪个计数格；`skipped` 是「本次不归我」，`failed` 是「终态没写进去」 */
function countOutcome(counts: MaintenanceRunCounts, outcome: DriverFeedbackProcessOutcome): void {
  switch (outcome.status) {
    case 'completed':
      counts.completed_count += 1;
      return;
    case 'retried':
      counts.retried_count += 1;
      return;
    case 'dead_letter':
      counts.dead_letter_count += 1;
      return;
    case 'skipped':
      counts.skipped_count += 1;
      return;
    case 'failed':
      counts.failure_count += 1;
      return;
  }
}

/**
 * run 上那条 human-readable 的结论。
 *
 * 优先写记录侧的失败码（「这一批为什么没干净」），没有失败码时才写外壳自己的故障——
 * 两者同时出现时，记录失败更能解释现场；外壳故障本身已经在 worker_failure 里。
 */
function lastErrorOf(
  outcomes: DriverFeedbackProcessOutcome[],
  workerFailure: MaintenanceFailure | undefined,
): string | undefined {
  const failed = outcomes.filter((outcome) => outcome.failure !== undefined);
  const last = failed[failed.length - 1];
  if (last?.failure) return `${last.feedback_id}: ${last.failure.code}: ${last.failure.message}`;
  if (workerFailure) return `${workerFailure.code}: ${workerFailure.message}`;
  return undefined;
}
