/**
 * RunEventConsumption —— 单次 Task Run 的「事件消耗」埋点。
 *
 * 职责：回答「这一次 run 到底产生了多少事件、都是些什么、序列化后有多大」，并顺带
 * 记下协调层提交（commit）了多少个批次。与 `run-latency-trace` 是同一个套路：run 级
 * recorder 通过 AsyncLocalStorage 携带，深层调用零签名改动即可归属同一个 run。
 *
 * 核心设计：
 * - **只在两个真实出口计数**：阶段事件的唯一出口是生产 stage executor 的 `emit()`，
 *   落库提交的唯一出口是执行循环的 `on_committed_events`。在出口计数意味着不可能漏，
 *   也不需要每个调用点记得埋点。
 * - **观测绝不能反过来让生产 run 失败**：payload 序列化失败、sink 抛错都只吞掉这一条，
 *   计数本身永不抛出。
 * - **汇总只在 run 结束时发一次**，不逐事件发。逐事件发等于用事件流去测量事件流：
 *   被测对象会被观测者放大。
 * - **汇总信号落自己的文件，不进 run 的权威事件流**。`audit.jsonl` 与 `run.subscribe`
 *   里的事件是消费方会断言形状的契约；把观测信号混进去，既不属于任何 stage、也不属于
 *   run 生命周期，会直接破坏「最后一条事件是 run.completed」这类断言。生产用
 *   `FileRunEventConsumptionSink`，测试可注入内存 sink。
 * - **计数不含阶段语义之外的东西**：`handler.*`、`task.created`、`run.started` 等
 *   生命周期事件不过 `emit()`，因此不在计数内。与 audit.jsonl 对账时这部分是已知差集。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { emitTelemetry, type TelemetryRecord, type TelemetrySink } from './telemetry-sink';

/** 按 event_type 分组的计数与体积。 */
export interface RunEventConsumptionEntry {
  count: number;
  payload_bytes: number;
}

/**
 * 一次 run 的事件消耗汇总。
 *
 * `total_events` 是**经 `emit()` 出口的阶段事件**条数，不是 audit.jsonl 的行数：
 * 后者还含 RPC 处理器与 run 生命周期事件，多出来的部分是已知且可枚举的。
 */
export interface RunEventConsumptionTotals {
  run_id: string;
  task_id?: string;
  total_events: number;
  payload_bytes: number;
  by_type: Record<string, RunEventConsumptionEntry>;
  /** 协调层提交的批次数与条数，来自 `on_committed_events`。 */
  committed_batches: number;
  committed_events: number;
}

export interface RunEventConsumptionRecorderOptions {
  run_id: string;
  task_id?: string;
  /** 汇总信号的去处。不注入时只留内存计数，便于单测与 example 零改动。 */
  sink?: TelemetrySink;
}

/** run 级事件计数器。一个 run 一个实例，不跨 run 复用。 */
export class RunEventConsumptionRecorder {
  private readonly runId: string;
  private readonly taskId: string | undefined;
  private readonly sink: TelemetrySink | undefined;
  private readonly byType = new Map<string, RunEventConsumptionEntry>();
  private totalEvents = 0;
  private payloadBytes = 0;
  private committedBatches = 0;
  private committedEvents = 0;

  constructor(options: RunEventConsumptionRecorderOptions) {
    this.runId = options.run_id;
    this.taskId = options.task_id;
    this.sink = options.sink;
  }

  get run_id(): string {
    return this.runId;
  }

  /** 记一条经阶段出口产生的事件。当前没有 recorder 时调用方应走空转分支。 */
  consume(eventType: string, payload: unknown): void {
    const bytes = payloadByteLength(payload);
    const entry = this.byType.get(eventType) ?? { count: 0, payload_bytes: 0 };
    entry.count += 1;
    entry.payload_bytes += bytes;
    this.byType.set(eventType, entry);
    this.totalEvents += 1;
    this.payloadBytes += bytes;
  }

  /** 记一次协调层提交批次。条数由调用方给出，避免这里再去猜事件形状。 */
  commitBatch(eventCount: number): void {
    this.committedBatches += 1;
    this.committedEvents += eventCount;
  }

  /** 取汇总快照。可重复调用，不消耗内部状态。 */
  snapshot(): RunEventConsumptionTotals {
    return {
      run_id: this.runId,
      ...(this.taskId ? { task_id: this.taskId } : {}),
      total_events: this.totalEvents,
      payload_bytes: this.payloadBytes,
      by_type: Object.fromEntries(
        [...this.byType.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
      committed_batches: this.committedBatches,
      committed_events: this.committedEvents,
    };
  }

  /**
   * 收尾：把汇总作为两条 telemetry 信号发出。
   *
   * 刻意不抛错——它跑在 run 的收尾路径上，埋点失败绝不能让一个已经成功的 run 变成失败。
   */
  async finish(): Promise<RunEventConsumptionTotals> {
    const totals = this.snapshot();
    if (!this.sink) return totals;
    try {
      await emitTelemetry(this.sink, {
        event_type: 'run.event_consumed',
        subject_id: this.runId,
        ...(this.taskId ? { task_id: this.taskId } : {}),
        run_id: this.runId,
        payload: {
          total_events: totals.total_events,
          payload_bytes: totals.payload_bytes,
          by_type: totals.by_type,
        },
      });
      await emitTelemetry(this.sink, {
        event_type: 'run.event_committed_batch',
        subject_id: this.runId,
        ...(this.taskId ? { task_id: this.taskId } : {}),
        run_id: this.runId,
        payload: {
          committed_batches: totals.committed_batches,
          committed_events: totals.committed_events,
        },
      });
    } catch {
      // 埋点失败只丢信号，不影响已经跑完的 run。
    }
    return totals;
  }
}

/**
 * 追加写 `<root>/<run_id>/event-consumption.jsonl`。
 *
 * 与 `FileRunLatencyTraceSink` 同一个理由、同一套目录约定：观测信号落自己的文件，
 * **不进 run 的权威事件流**。走 registry 那条路（`appendTelemetry`）会让汇总信号出现在
 * `audit.jsonl` 与 `run.subscribe` 的流里，而它既不属于任何 stage、也不属于 run 生命
 * 周期——对「最后一条事件是 run.completed」这类消费方断言就是破坏。目录「已建过」按
 * run 记忆，避免每写一条都 mkdir。
 */
export class FileRunEventConsumptionSink implements TelemetrySink {
  private readonly readyRuns = new Set<string>();
  private readonly failedRuns = new Set<string>();

  constructor(private readonly root: string) {}

  emit(record: TelemetryRecord): void {
    const runId = record.run_id;
    if (!runId || this.failedRuns.has(runId)) return;
    try {
      const runDir = path.join(this.root, runId);
      if (!this.readyRuns.has(runId)) {
        mkdirSync(runDir, { recursive: true });
        this.readyRuns.add(runId);
      }
      appendFileSync(
        path.join(runDir, 'event-consumption.jsonl'),
        `${JSON.stringify(record)}\n`,
        'utf-8',
      );
    } catch {
      // 同一个 run 连续失败就不再重试：观测写不进去不该拖慢被测的 run。
      this.failedRuns.add(runId);
    }
  }
}

const recorderStorage = new AsyncLocalStorage<RunEventConsumptionRecorder>();
/** 在当前异步上下文内绑定计数器。 */
export function runWithRunEventConsumption<T>(
  recorder: RunEventConsumptionRecorder,
  run: () => Promise<T>,
): Promise<T> {
  return recorderStorage.run(recorder, run);
}

export function getRunEventConsumptionRecorder(): RunEventConsumptionRecorder | undefined {
  return recorderStorage.getStore();
}

/**
 * 记一条阶段事件。
 *
 * 没有 recorder 时（单测、example、非 RPC 路径）是空转：不产生任何副作用，也不改变
 * 异常语义。调用点是同步的（`emit()` 本身同步），所以这里也必须是同步的。
 */
export function recordRunEventConsumed(eventType: string, payload: unknown): void {
  recorderStorage.getStore()?.consume(eventType, payload);
}

/** 记一次提交批次。没有 recorder 时空转。 */
export function recordRunEventCommittedBatch(eventCount: number): void {
  recorderStorage.getStore()?.commitBatch(eventCount);
}

/**
 * payload 的序列化字节数。
 *
 * 序列化失败（循环引用、BigInt 等）只记 0 字节而不是抛出：体积是参考量，不值得为了
 * 它让生产 run 失败。用 `Buffer.byteLength` 而不是 `length`，因为 payload 里常有中文。
 */
function payloadByteLength(payload: unknown): number {
  try {
    const serialized = JSON.stringify(payload);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf-8');
  } catch {
    return 0;
  }
}
