/**
 * driver 侧 usage 观测的独立账本 sink：一次 run 一份 `driver-usage.jsonl`。
 *
 * 为什么要单开一个文件。`driver-stream.jsonl` 是事件流的**观测副本**，带 8 MiB 保留上限，
 * 写满就停并留下 `truncated: true`——按设计它就不是账本。实测一次 council：该文件只有
 * 11,943 行，覆盖前 75 秒，五个角色的终值一条都没进去，报表因此报出
 * `driver_sessions=1 / context=39568`，而真值是 5 段 / 三个数量级更高的成本。同一批观测
 * 在审计流里只有 163 行（单角色那次 47 行），犯不上跟十万条文本块抢一个容量预算，
 * 更不该被别人的预算连坐。
 *
 * 落点 `<runsRoot>/<run_id>/driver-usage.jsonl`，与 `telemetry.jsonl` /
 * `event-consumption.jsonl` / `latency.jsonl` 同一套约定：观测信号落 run 自己的文件，
 * **不进 run 的权威事件流**——那份流有「最后一条事件是终态」的消费方断言，汇总信号排在
 * `run.completed` 之后就会破坏它。
 *
 * 用 `appendFileSync` 而不是异步队列。异步写要靠 flush 收尾，而 council 恰恰死在 flush
 * 途中——`audit.jsonl` 的尾巴（第 5 个 session 的终值、gate 与 deliver 事件）就是这么丢的。
 * 同步落地没有可丢的队列：每个观测写下即完整，进程随后怎么被杀都不影响已经在盘上的数字。
 *
 * 写失败只丢那一条并记住这个 run，不再重试：观测埋点不该拖慢被测的 run，也不该把一次
 * 磁盘抖动升级成 run 失败。关掉开关时换成 `NoopDriverUsageSink`，生产行为与接线前逐位
 * 一致——不建文件、不写盘。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DriverUsageRecord } from './driver-usage-projector';

/**
 * driver usage 观测的落盘出口。同步语义是接口的一部分：实现不许把写盘推到调用方
 * 看不见的队列里去，否则「进程内正源 vs 盘上账本」又会分叉，正是这次要修的病。
 */
export interface DriverUsageSink {
  emit(record: DriverUsageRecord): void;
}

/** 未开启账本时的空转实现。 */
export class NoopDriverUsageSink implements DriverUsageSink {
  emit(_record: DriverUsageRecord): void {
    // 刻意什么都不做：观测写不写都不该影响 run。
  }
}

/**
 * 按 run 分目录落盘的账本 sink：写 `<root>/<run_id>/driver-usage.jsonl`。
 *
 * 与 `FileRunTelemetryJsonlSink` 同形，差别只在记录类型——那份是 scaffold 侧的 proxy
 * LLM 账（`newide.token_usage.v1`，能逐次累加），这份是 driver 侧的上下文占用与成本观测
 * （`used` 是 session 级累计值，只能折叠，绝不能逐行求和）。两套口径各自成文件、各自带
 * `metric` 标记，报表侧读出来才不会互加。
 */
export class FileRunDriverUsageJsonlSink implements DriverUsageSink {
  /** 每个 run 一个底层追加句柄，顺带把「目录建过没有」记在 initialized 里。 */
  private readonly filePaths = new Map<string, string>();
  private readonly failedRuns = new Set<string>();

  constructor(private readonly root: string) {}

  emit(record: DriverUsageRecord): void {
    const runId = record.run_id;
    if (!runId || this.failedRuns.has(runId)) return;
    try {
      let filePath = this.filePaths.get(runId);
      if (!filePath) {
        filePath = join(this.root, runId, 'driver-usage.jsonl');
        mkdirSync(dirname(filePath), { recursive: true });
        this.filePaths.set(runId, filePath);
      }
      appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch {
      this.failedRuns.add(runId);
    }
  }
}
