/**
 * RunLatencyTrace —— 单次 Task Run 的墙钟归因埋点。
 *
 * 职责：把「这一次 run 的时间到底花在哪个调用上」记录成可离线分析的 span 流水；
 * 落到哪里由注入的 `RunLatencyTraceSink` 决定（生产用按 run 分文件的 JSONL sink，
 * 测试用内存 sink）。
 *
 * 核心设计：
 * - 每条 span 同时记墙钟 `started_at` / `completed_at` 与单调钟差值 `duration_ms`。
 *   墙钟用于跨进程、跨文件对齐时间轴，单调钟用于抗系统时间调整；两者不可互替。
 *   单调钟倒退时如实退回墙钟口径，而不是把负数压成 0 谎报「瞬间完成」。
 * - 异常路径同样落 span：失败往往正是耗时异常的原因，只记成功路径会让「为什么
 *   这次特别慢」变成盲区。
 * - 观测绝不能反过来让生产 run 失败：写 sink 统一走 `appendRunLatencySpan`，
 *   任何 sink 实现抛错都只丢这一条 span。
 */

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

export type MonotonicNow = () => number;

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
