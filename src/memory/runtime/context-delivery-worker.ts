/**
 * ContextDeliveryWorker — 上下文交付的批量消费外壳（Phase 1）
 *
 * 处理内核在 context-delivery-processor.ts（一条交付怎么变成 Experience）。这里负责
 * 「一次运行」这件事本身：开一条 maintenance run、按上限批量 claim、逐条隔离、边跑边
 * 计数、收尾写结论。两者的分工是刻意的——内核只管一条记录的状态与副作用，外壳管
 * 批量与观测，测试也就能分别落在自己那一层。
 *
 * 几条不能松的约束：
 *
 * - **只 claim context 通道**。反馈 outbox 由 Phase 2 的独立消费者负责；一个通道的
 *   失败上限与退避不该被另一个通道的积压拖住。
 * - **claim 数量有上限**（`batchSize`）且有墙钟上限（`maxDurationMs`）。无上限的全量
 *   claim 会把一次调度变成一次不设终点的批处理，运维既排不掉也估不出它的时长。
 * - **没有活就立刻返回**，不轮询、不 sleep。调度是外部的事（scheduler / cron /
 *   readiness 钩子），worker 不在里面忙等——退避窗口没到的记录 claim 不到，那就是
 *   「这次没活」，不是「再等一会儿」。
 * - **单条失败不阻塞同批**：一条记录的异常只影响它自己的计数，余下的照常处理。
 * - **优雅停止不再 claim 新的**，但在途的那一条会跑完（不让它半途而废，交给 lease
 *   恢复反而更慢）。`abort` 只在两次 claim 之间生效。
 * - **启动恢复先跑**：先调 restoreExpired 把租约过期仍停在 processing 的记录放回队列，
 *   再去消费。否则那些「上一个进程崩溃时留下的」记录要等下一次调度才有人管。
 *
 * run 是观测与审计实体，不是事务边界：它记录这次跑了什么、带走了多少种结果，但它的
 * 成败不改变任何交付项的状态（见 schemas 的 MaintenanceRun 注释）。
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import type {
  ContextDeliveryItem,
  MaintenanceFailure,
  MaintenanceRunCounts,
  MaintenanceRun,
} from '../schemas';
import type { MemoryDeliveryRepository } from '../ports/memory-delivery';
import type { MaintenanceRunStore } from '../ports/maintenance-run-store';
import { EMPTY_MAINTENANCE_RUN_COUNTS } from '../services/maintenance-run-lifecycle';
import { classifyDeliveryFailure } from '../services/delivery-error-classification';
import type {
  ContextDeliveryProcessOutcome,
  ContextDeliveryProcessor,
} from './context-delivery-processor';

/** 一次运行缺省的 claim 上限；显式传 batchSize 可覆盖 */
export const DEFAULT_CONTEXT_DELIVERY_BATCH_SIZE = 20;
/** 一次运行缺省的墙钟上限（毫秒） */
export const DEFAULT_CONTEXT_DELIVERY_MAX_DURATION_MS = 60_000;

export interface ContextDeliveryWorkerOptions {
  deliveryRepository: MemoryDeliveryRepository;
  runStore: MaintenanceRunStore;
  processor: ContextDeliveryProcessor;
  /**
   * 消费者标识：既写进 run 记录，也作为 claim owner。
   *
   * 缺省按实例生成一个——同一个 worker 的多次运行共享它，重启后换一个新的。owner 只作
   * 交叉核对，真正的判据是每次 claim 发下的 token（见 delivery-lifecycle 的说明），
   * 所以换不换 id 都不影响正确性。
   */
  worker_id?: string;
  /** claim / 续租的租约时长；缺省用交付存储自己的 policy.lease_ms */
  lease_ms?: number;
  /** 只消费该 role 的交付项；缺省跨 role */
  role_id?: string;
  /** 参考时刻（测试注入）；缺省取系统时间 */
  now?: () => string;
  /** runOnce 的缺省批量上限 */
  batch_size?: number;
  /** runOnce 的缺省墙钟上限 */
  max_duration_ms?: number;
  /** runOnce 缺省是否先做启动恢复；缺省 true */
  restore_expired?: boolean;
}

export interface ContextDeliveryRunOptions {
  /** 本次最多 claim 多少条；缺省用 worker 配置，再缺省用 DEFAULT_CONTEXT_DELIVERY_BATCH_SIZE */
  batchSize?: number;
  /** 本次墙钟上限（毫秒） */
  maxDurationMs?: number;
  /** 优雅停止信号：置位后不再 claim 新记录，在途的那条照常跑完 */
  signal?: AbortSignal;
  /** 本次是否先做启动恢复；缺省用 worker 配置 */
  restoreExpired?: boolean;
  /** 只消费该 role 的交付项；缺省用 worker 配置 */
  role_id?: string;
  /** 本次运行的参考时刻（同时作为 run 的 started_at）；缺省取当前时间 */
  now?: string;
}

/** 批次为什么停下来 */
export type ContextDeliveryStopReason =
  | 'no_work'
  | 'batch_size'
  | 'max_duration'
  | 'aborted'
  | 'worker_error';

export interface ContextDeliveryRunResult {
  /** 本次运行的记录（已收尾） */
  run: MaintenanceRun;
  counts: MaintenanceRunCounts;
  stop_reason: ContextDeliveryStopReason;
  /** 启动恢复放回队列的条数（没做恢复时为 0） */
  restored_count: number;
  /** 逐条结果：run 计数之外的诊断面（失败码、归档结果、warnings） */
  outcomes: ContextDeliveryProcessOutcome[];
  /** 外壳自身失败（claim 读到存储故障等）时的规范化原因；成功运行时为 undefined */
  worker_failure?: MaintenanceFailure;
}

export interface ContextDeliveryRestoreResult {
  restored: ContextDeliveryItem[];
  count: number;
}

export class ContextDeliveryWorker {
  readonly worker_id: string;
  private readonly now: () => string;

  constructor(private readonly options: ContextDeliveryWorkerOptions) {
    this.worker_id = options.worker_id ?? `context-delivery-worker-${randomUUID()}`;
    this.now = options.now ?? nowTimestamp;
  }

  /**
   * 跑一次：开 run → （缺省先做启动恢复）→ 批量 claim 并逐条处理 → 收尾。
   *
   * 只有外壳自己的故障（claim 读不动存储）才会把 run 标成 failed；交付项自己的成败
   * 只体现在计数里——一次「9 条成功、1 条进死信」的运行是正常的运行，不是失败的运行。
   */
  async runOnce(options: ContextDeliveryRunOptions = {}): Promise<ContextDeliveryRunResult> {
    const batchSize = options.batchSize ?? this.options.batch_size ?? DEFAULT_CONTEXT_DELIVERY_BATCH_SIZE;
    const maxDurationMs =
      options.maxDurationMs ?? this.options.max_duration_ms ?? DEFAULT_CONTEXT_DELIVERY_MAX_DURATION_MS;
    const roleId = options.role_id ?? this.options.role_id;
    if (!Number.isInteger(batchSize) || batchSize < 0) {
      throw new Error('Context delivery batchSize must be a non-negative integer.');
    }
    if (!Number.isFinite(maxDurationMs) || maxDurationMs < 0) {
      throw new Error('Context delivery maxDurationMs must be a non-negative number.');
    }

    const startedAt = options.now ?? this.now();
    const startedMs = Date.parse(startedAt);
    const run = await this.options.runStore.start({
      job_type: 'context_delivery',
      worker_id: this.worker_id,
      now: startedAt,
    });

    const counts: MaintenanceRunCounts = { ...EMPTY_MAINTENANCE_RUN_COUNTS };
    const outcomes: ContextDeliveryProcessOutcome[] = [];
    let stopReason: ContextDeliveryStopReason = 'no_work';
    let workerFailure: MaintenanceFailure | undefined;
    let restoredCount = 0;

    try {
      const restore = options.restoreExpired ?? this.options.restore_expired ?? true;
      if (restore) {
        const restored = await this.restoreExpired({ now: startedAt, ...(roleId ? { role_id: roleId } : {}) });
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
          channel: 'context',
          owner: this.worker_id,
          now: this.now(),
          // 与处理器续租时用的是同一个表达式：claim 多久就续多久，否则会出现「领了 5 秒
          // 租约、却按 60 秒去续」这种自我矛盾的组合（前者先过期，记录被别人捡走）。
          lease_ms: this.options.lease_ms ?? this.options.deliveryRepository.policy.lease_ms,
          ...(roleId !== undefined ? { role_id: roleId } : {}),
        });
        const item = claimed?.channel === 'context' ? claimed.item : undefined;
        if (!item) {
          // 没有到期记录就是「这次没活」——退避窗口没到 / 队列空 / 已被别人领走，
          // 都是同一件事，不需要在这里等。
          stopReason = 'no_work';
          break;
        }
        counts.claimed_count += 1;
        const outcome = await this.processOne(item, run.run_id);
        outcomes.push(outcome);
        countOutcome(counts, outcome);
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
      run: finished,
      counts,
      stop_reason: stopReason,
      restored_count: restoredCount,
      outcomes,
      ...(workerFailure !== undefined ? { worker_failure: workerFailure } : {}),
    };
  }

  /**
   * 启动恢复：把租约过期仍停在 processing 的上下文交付放回可投递队列。
   *
   * 直接复用交付存储自己的恢复能力——它逐条在临界区里重新判过期，因此不会把「列举之后
   * 已经被别人完成了」的记录重投一次。只恢复 context 通道。
   */
  async restoreExpired(
    options: { now?: string; role_id?: string } = {},
  ): Promise<ContextDeliveryRestoreResult> {
    const restored = await this.options.deliveryRepository.restoreExpiredDeliveryClaims({
      channel: 'context',
      now: options.now ?? this.now(),
      ...(options.role_id !== undefined ? { role_id: options.role_id } : {}),
    });
    const items = restored
      .map((claimed) => (claimed.channel === 'context' ? claimed.item : undefined))
      .filter((item): item is ContextDeliveryItem => item !== undefined);
    return { restored: items, count: items.length };
  }

  /**
   * 处理一条记录，并把处理器抛出的异常收进结果里。
   *
   * 处理器本该自己收敛所有失败（它拿得到 token，也只能由它写终态）；真抛出来说明有
   * 意料之外的缺陷。这时**不能**让异常掀掉整批：这一条记成 worker 侧失败，余下的照常处理。
   */
  private async processOne(
    item: ContextDeliveryItem,
    runId: string,
  ): Promise<ContextDeliveryProcessOutcome> {
    try {
      return await this.options.processor.process(item, {
        worker_id: this.worker_id,
        run_id: runId,
      });
    } catch (error) {
      return {
        status: 'failed',
        delivery_id: item.delivery_id,
        role_id: item.role_id,
        buffer_seq: item.buffer_seq,
        attempt_count: item.attempt_count,
        run_id: runId,
        failure: classifyDeliveryFailure(error),
        experiences_created: 0,
        experiences_already_present: 0,
        warnings: ['The processor threw before it could settle this delivery.'],
      };
    }
  }
}

/** 一条结果落到哪个计数格；`skipped` 是「本次不归我」，`failed` 是「终态没写进去」 */
function countOutcome(counts: MaintenanceRunCounts, outcome: ContextDeliveryProcessOutcome): void {
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
 * 优先写交付侧的失败码（「这一批为什么没干净」），没有失败码时才写外壳自己的故障——
 * 两者同时出现时，交付失败更能解释现场；外壳故障本身已经在 worker_failure 里。
 */
function lastErrorOf(
  outcomes: ContextDeliveryProcessOutcome[],
  workerFailure: MaintenanceFailure | undefined,
): string | undefined {
  const failed = outcomes.filter((outcome) => outcome.failure !== undefined);
  const last = failed[failed.length - 1];
  if (last?.failure) return `${last.delivery_id}: ${last.failure.code}: ${last.failure.message}`;
  if (workerFailure) return `${workerFailure.code}: ${workerFailure.message}`;
  return undefined;
}
