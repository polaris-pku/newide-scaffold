/**
 * Telemetry 记录的 JSONL 落盘 sink。
 *
 * 两个粒度：`JsonlTelemetrySink` 收完整文件路径（调用方自己决定文件在哪，写失败直接
 * 抛出，eval 脚本据此失败）；`FileRunTelemetryJsonlSink` 只收根目录、按记录里的
 * `run_id` 分目录（生产侧一次 run 一个文件，写失败只丢信号——见其类注释）。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TelemetryRecord, TelemetrySink } from './telemetry-sink';

/**
 * Append-only JSONL sink for F-direction eval runs.
 * Each telemetry record is written as one JSON line.
 */
export class JsonlTelemetrySink implements TelemetrySink {
  private initialized = false;

  constructor(private readonly filePath: string) {}

  emit(record: TelemetryRecord): void {
    this.ensureReady();
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  private ensureReady(): void {
    if (this.initialized) {
      return;
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.initialized = true;
  }
}

/**
 * Fan-out sink that forwards each record to multiple sinks.
 */
export class CompositeTelemetrySink implements TelemetrySink {
  constructor(private readonly sinks: TelemetrySink[]) {}

  async emit(record: TelemetryRecord): Promise<void> {
    for (const sink of this.sinks) {
      await sink.emit(record);
    }
  }
}

/**
 * 按 run 分目录落盘的 telemetry sink：写 `<root>/<run_id>/telemetry.jsonl`。
 *
 * 与 `JsonlTelemetrySink` 的区别只在路径来源——那个由调用方拼好整条路径，这个把
 * run 目录交给记录里的 `run_id`。生产一次 run 一个文件，而写入点分散在多个 stage，
 * 各写各的路径迟早分叉。
 *
 * 与 `FileRunEventConsumptionSink` / `FileRunLatencyTraceSink` 同一套目录约定：观测
 * 信号落 run 自己的文件，**不进 run 的权威事件流**——那份流是消费方会断言形状的契约。
 * 写失败只丢这一条并记住这个 run，不再重试：观测写不进去不该拖慢被测的 run。
 */
export class FileRunTelemetryJsonlSink implements TelemetrySink {
  /** 每个 run 一个底层 sink，顺带把「目录建过没有」交给它的 initialized 记。 */
  private readonly sinks = new Map<string, JsonlTelemetrySink>();
  private readonly failedRuns = new Set<string>();

  constructor(private readonly root: string) {}

  emit(record: TelemetryRecord): void {
    const runId = record.run_id;
    if (!runId || this.failedRuns.has(runId)) return;
    try {
      let sink = this.sinks.get(runId);
      if (!sink) {
        sink = new JsonlTelemetrySink(join(this.root, runId, 'telemetry.jsonl'));
        this.sinks.set(runId, sink);
      }
      sink.emit(record);
    } catch {
      this.failedRuns.add(runId);
    }
  }
}
