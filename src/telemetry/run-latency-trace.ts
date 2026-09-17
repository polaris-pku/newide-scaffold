/**
 * RunLatencyTrace —— 单次 Task Run 的墙钟归因埋点。
 *
 * 职责：把「这一次 run 的时间到底花在哪个调用上」记录成可离线分析的 span 流水；
 * 落到哪里由注入的 `RunLatencyTraceSink` 决定（生产用按 run 分文件的 JSONL sink，
 * 测试用内存 sink）。
 *
 * 核心设计：
 * - 用 AsyncLocalStorage 携带 run 级 recorder。这样 facade、stage executor、
 *   council 席位、driver 重试都能零签名改动地记 span，且自动归属同一个 run，
 *   不必逐层传参。
 * - 每条 span 同时记墙钟 `started_at` / `completed_at` 与单调钟差值 `duration_ms`。
 *   墙钟用于跨进程、跨文件对齐时间轴，单调钟用于抗系统时间调整；两者不可互替。
 *   单调钟倒退时如实退回墙钟口径，而不是把负数压成 0 谎报「瞬间完成」。
 * - 异常路径同样落 span：失败往往正是耗时异常的原因，只记成功路径会让「为什么
 *   这次特别慢」变成盲区。
 * - 观测绝不能反过来让生产 run 失败：写 sink 统一走 `appendRunLatencySpan`，
 *   任何 sink 实现抛错都只丢这一条 span；文件 sink 自己也不再重试失败的 run。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { nowTimestamp } from '../core';
import {
  resolveRunLatencySpan,
  type RunLatencyLayer,
  type RunLatencySpanName,
  type RunLatencySpanRef,
} from './run-latency-spans';

// span 词汇表（登记名、layer、动态族工厂）从本模块转发，调用点继续用同一个
// import 路径，不必知道登记处被拆成了单独的文件。
export {
  DRIVER_TIMING_MILESTONES,
  RUN_LATENCY_SPANS,
  agentToolSpan,
  driverMilestoneSpan,
  latencySpan,
  resolveRunLatencySpan,
  stageSpan,
} from './run-latency-spans';
export type {
  DriverTimingMilestoneName,
  RunLatencyLayer,
  RunLatencySpanName,
  RunLatencySpanRef,
} from './run-latency-spans';

/** 时长的取值口径。`wall_clock` 只在单调钟不可用或倒退时出现。 */
export type RunLatencyDurationSource = 'monotonic' | 'wall_clock';

export interface RunLatencySpan {
  run_id: string;
  task_id?: string;
  /** 稳定 span 标识，如 `facade.retrieve_memory`；同一个 run 内可重复出现。 */
  name: string;
  layer: RunLatencyLayer;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  duration_source: RunLatencyDurationSource;
  ok: boolean;
  role_id?: string;
  /** 第几次尝试（driver 重试、council 续跑等重试语义）。 */
  attempt?: number;
  /** LLM 轮次序号 / council synthesis 轮次。 */
  round?: number;
  error?: string;
  meta?: Record<string, unknown>;
}

/**
 * 调用方提供的一条外部测得的 span 描述。
 *
 * 不含 name / layer：它们由第一个参数（登记名或 ref）给出，run_id / task_id 由
 * recorder 补齐。这样一条 span 的归属只有一个来源。
 */
export interface RunLatencySpanRecordInput {
  started_at: string;
  completed_at: string;
  duration_ms: number;
  duration_source?: RunLatencyDurationSource;
  ok?: boolean;
  role_id?: string;
  attempt?: number;
  round?: number;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface RunLatencySpanOptions<T = unknown> {
  role_id?: string;
  attempt?: number;
  round?: number;
  meta?: Record<string, unknown>;
  /**
   * 用被测函数的返回值补充 meta。
   *
   * 耗时和「这次调用的输入/输出有多大」必须记在同一条 span 上才能一起分析，
   * 否则分开记录会对不上时间点。
   *
   * 这个回调是观测代码：它抛错绝不能影响被测调用。
   */
  metaFrom?: (value: T) => Record<string, unknown> | undefined;
}

export interface RunLatencyTraceSink {
  append(span: RunLatencySpan): void;
}

/**
 * 调 sink 写一条 span，吞掉 sink 自己的异常。
 *
 * recorder 统一走这里，于是「观测不能反过来让生产 run 失败」这条纪律对任何 sink
 * 实现都成立，不需要每个 sink 各自记得 try/catch。
 */
export function appendRunLatencySpan(sink: RunLatencyTraceSink, span: RunLatencySpan): void {
  try {
    sink.append(span);
  } catch {
    // 丢这一条 span，保住被测调用。
  }
}

export class NoopRunLatencyTraceSink implements RunLatencyTraceSink {
  append(_span: RunLatencySpan): void {
    return undefined;
  }
}

/**
 * 追加写 `<root>/<run_id>/latency.jsonl`。
 *
 * 与 FileRunAuditWriter 保持同样的目录约定，便于把 audit.jsonl /
 * driver-stream.jsonl / latency.jsonl / telemetry.jsonl 放在同一层对时间轴。
 * 目录「已建过」按 run 记忆，避免每写一条都 mkdir。
 */
export class FileRunLatencyTraceSink implements RunLatencyTraceSink {
  private readonly readyRuns = new Set<string>();
  private readonly failedRuns = new Set<string>();

  constructor(private readonly root: string) {}

  append(span: RunLatencySpan): void {
    if (this.failedRuns.has(span.run_id)) return;
    try {
      const runDir = path.join(this.root, span.run_id);
      if (!this.readyRuns.has(span.run_id)) {
        mkdirSync(runDir, { recursive: true });
        this.readyRuns.add(span.run_id);
      }
      appendFileSync(path.join(runDir, 'latency.jsonl'), `${JSON.stringify(span)}\n`, 'utf-8');
    } catch {
      // 同一个 run 连续失败就不再重试，否则每条 span 都再吃一次失败路径的开销。
      this.failedRuns.add(span.run_id);
    }
  }
}

export type MonotonicNow = () => number;

/**
 * span 流水的一份聚合快照。
 *
 * 逐条 span 适合离线做瀑布图，但「这次 run 每层各花了多少」是更常被问的问题。
 * 快照按 span 名与 layer 分组合计，让调用点不必自己去解析 JSONL。
 */
export interface RunLatencyTotals {
  run_id: string;
  task_id?: string;
  span_count: number;
  /** 按 span 名分组的合计（含次数），用于回答「每层各花了多少」。 */
  by_name: Record<string, { count: number; total_duration_ms: number; max_duration_ms: number }>;
  /** 按 layer 分组的合计，用于粗粒度归因。 */
  by_layer: Record<string, { count: number; total_duration_ms: number }>;
}

/** 从 span 序列算聚合快照；不排序、不改写输入。 */
export function summarizeRunLatency(
  runId: string,
  spans: readonly RunLatencySpan[],
  taskId?: string,
): RunLatencyTotals {
  const byName: RunLatencyTotals['by_name'] = {};
  const byLayer: RunLatencyTotals['by_layer'] = {};
  for (const span of spans) {
    const nameBucket = byName[span.name] ?? { count: 0, total_duration_ms: 0, max_duration_ms: 0 };
    nameBucket.count += 1;
    nameBucket.total_duration_ms += span.duration_ms;
    nameBucket.max_duration_ms = Math.max(nameBucket.max_duration_ms, span.duration_ms);
    byName[span.name] = nameBucket;

    const layerBucket = byLayer[span.layer] ?? { count: 0, total_duration_ms: 0 };
    layerBucket.count += 1;
    layerBucket.total_duration_ms += span.duration_ms;
    byLayer[span.layer] = layerBucket;
  }
  return {
    run_id: runId,
    ...(taskId ? { task_id: taskId } : {}),
    span_count: spans.length,
    by_name: byName,
    by_layer: byLayer,
  };
}

function defaultMonotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export interface RunLatencyRecorderOptions {
  run_id: string;
  task_id?: string;
  sink: RunLatencyTraceSink;
  /** 单调钟，便于测试注入。 */
  monotonicNow?: MonotonicNow;
  /** 墙钟取值，便于测试注入。 */
  now?: () => string;
}

/** run 级 span 记录器。一个 run 一个实例，不跨 run 复用。 */
export class RunLatencyRecorder {
  private readonly runId: string;
  private readonly taskId: string | undefined;
  private readonly sink: RunLatencyTraceSink;
  private readonly monotonicNow: MonotonicNow;
  private readonly now: () => string;
  private spans = 0;

  constructor(options: RunLatencyRecorderOptions) {
    this.runId = options.run_id;
    this.taskId = options.task_id;
    this.sink = options.sink;
    this.monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
    this.now = options.now ?? nowTimestamp;
  }

  get run_id(): string {
    return this.runId;
  }

  get spanCount(): number {
    return this.spans;
  }

  /** 计时包裹一个异步调用，返回值与异常原样透传。 */
  async span<T>(
    nameOrRef: RunLatencySpanName | RunLatencySpanRef,
    options: RunLatencySpanOptions<T>,
    run: () => Promise<T>,
  ): Promise<T> {
    const ref = resolveRunLatencySpan(nameOrRef);
    const startedMonotonic = this.monotonicNow();
    const startedAt = this.now();
    try {
      const value = await run();
      this.emit(ref, options, startedAt, startedMonotonic, undefined, value);
      return value;
    } catch (error) {
      this.emit(ref, options, startedAt, startedMonotonic, error, undefined);
      throw error;
    }
  }

  /** 记录一条由外部测得的 span（如 driver transport 的里程碑）。 */
  record(nameOrRef: RunLatencySpanName | RunLatencySpanRef, input: RunLatencySpanRecordInput): void {
    const ref = resolveRunLatencySpan(nameOrRef);
    this.spans += 1;
    appendRunLatencySpan(this.sink, {
      run_id: this.runId,
      ...(this.taskId ? { task_id: this.taskId } : {}),
      name: ref.name,
      layer: ref.layer,
      started_at: input.started_at,
      completed_at: input.completed_at,
      duration_ms: input.duration_ms,
      duration_source: input.duration_source ?? 'monotonic',
      ok: input.ok ?? true,
      ...(input.role_id ? { role_id: input.role_id } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.round !== undefined ? { round: input.round } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    });
  }

  private emit<T>(
    ref: RunLatencySpanRef,
    options: RunLatencySpanOptions<T>,
    startedAt: string,
    startedMonotonic: number,
    error: unknown,
    value: T | undefined,
  ): void {
    const endedMonotonic = this.monotonicNow();
    const completedAt = this.now();
    const elapsed = endedMonotonic - startedMonotonic;
    // 单调钟在同一进程内理论上不会倒退；真倒退了说明这个基准不可信，
    // 退回墙钟并如实标注口径，而不是把负数压成 0 谎报「瞬间完成」。
    const useMonotonic = Number.isFinite(elapsed) && elapsed >= 0;
    const derived = error === undefined ? safeMetaFrom(options.metaFrom, value) : undefined;
    this.spans += 1;
    appendRunLatencySpan(this.sink, {
      run_id: this.runId,
      ...(this.taskId ? { task_id: this.taskId } : {}),
      name: ref.name,
      layer: ref.layer,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: useMonotonic ? elapsed : wallClockElapsedMs(startedAt, completedAt),
      duration_source: useMonotonic ? 'monotonic' : 'wall_clock',
      ok: error === undefined,
      ...(options.role_id ? { role_id: options.role_id } : {}),
      ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
      ...(options.round !== undefined ? { round: options.round } : {}),
      ...(error !== undefined ? { error: errorMessage(error) } : {}),
      ...metaFields(options.meta, derived),
    });
  }
}

const recorderStorage = new AsyncLocalStorage<RunLatencyRecorder>();

/**
 * 在当前异步上下文内绑定 recorder。
 *
 * 这是埋点能「零签名改动」覆盖深层调用的关键：facade、stage executor、council
 * 席位、driver 重试都跑在这个上下文里，于是自动归属同一个 run，不必逐层传参。
 */
export function runWithRunLatencyRecorder<T>(
  recorder: RunLatencyRecorder,
  run: () => Promise<T>,
): Promise<T> {
  return recorderStorage.run(recorder, run);
}

export function getRunLatencyRecorder(): RunLatencyRecorder | undefined {
  return recorderStorage.getStore();
}

/**
 * 计时包裹一个调用，span 归属当前 run。
 *
 * 没有 recorder 时（单测、example、非 RPC 路径）直接执行 `run`：不产生任何副作用，
 * 也不改变异常语义。第一个参数接受登记名（拼错即编译错误）或动态族 ref。
 */
export function withRunLatencySpan<T>(
  nameOrRef: RunLatencySpanName | RunLatencySpanRef,
  options: RunLatencySpanOptions<T>,
  run: () => Promise<T>,
): Promise<T> {
  const recorder = recorderStorage.getStore();
  if (!recorder) return run();
  return recorder.span(nameOrRef, options, run);
}

/**
 * 记录一条外部测得的 span。
 *
 * 供不便接收 recorder 实例的边界使用（例如 driver transport 的里程碑回调）：
 * 它只需要一个普通函数引用，就能把数据写进当前 run 的流水。
 */
export function recordRunLatencySpan(
  nameOrRef: RunLatencySpanName | RunLatencySpanRef,
  input: RunLatencySpanRecordInput,
): void {
  recorderStorage.getStore()?.record(nameOrRef, input);
}

function wallClockElapsedMs(startedAt: string, completedAt: string): number {
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

/** metaFrom 是观测代码，抛错不能影响被测调用。 */
function safeMetaFrom<T>(
  metaFrom: ((value: T) => Record<string, unknown> | undefined) | undefined,
  value: T | undefined,
): Record<string, unknown> | undefined {
  if (!metaFrom) return undefined;
  try {
    return metaFrom(value as T);
  } catch {
    return undefined;
  }
}

function metaFields(
  meta: Record<string, unknown> | undefined,
  derived: Record<string, unknown> | undefined,
): { meta?: Record<string, unknown> } {
  if (!meta && !derived) return {};
  return { meta: { ...(meta ?? {}), ...(derived ?? {}) } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
