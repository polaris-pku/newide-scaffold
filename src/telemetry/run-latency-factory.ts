/**
 * RunLatency 组合工厂。
 *
 * 职责：把 span 记录器与落盘位置绑在一起，让组合根只注入一个东西，而不必同时知道
 * recorder、sink 与聚合三者。这也是「一次 run 一份流水」的落点：span 追加到
 * `<root>/<run_id>/latency.jsonl`，同时在内存里留一份用于算 run 级聚合快照。
 *
 * 内存缓冲按 run 生命周期：`snapshot()` 之后就释放，避免长驻后端把每个 run 的
 * span 都永久留在堆上。
 */

import {
  FileRunLatencyTraceSink,
  RunLatencyRecorder,
  summarizeRunLatency,
  type RunLatencySpan,
  type RunLatencyTotals,
  type RunLatencyTraceSink,
} from './run-latency-trace';

/**
 * 组合根注入点。
 *
 * `createRecorder` 由执行循环在 run 开始时调用一次；`snapshot` 在 run 结束时调用，
 * 用于把聚合结果写进 run 的 summary。
 */
export interface RunLatency {
  createRecorder(input: { run_id: string; task_id: string }): RunLatencyRecorder;
  snapshot(runId: string): RunLatencyTotals;
}

export interface CreateRunLatencyOptions {
  /** 每 run 一个 JSONL 文件的根目录，通常是 `<state-root>/runs`。 */
  root: string;
  /** 叠加额外 sink（例如测试用的内存 sink）。 */
  extraSinks?: readonly RunLatencyTraceSink[];
  /** 设为 false 可整体关掉落盘，只保留内存聚合。 */
  persist?: boolean;
}

/** span 落在 `<root>/<run_id>/latency.jsonl`，并留一份内存缓冲供聚合。 */
export function createRunLatency(options: CreateRunLatencyOptions): RunLatency {
  const buffers = new Map<string, RunLatencySpan[]>();
  const persist = options.persist ?? true;

  const createRecorder: RunLatency['createRecorder'] = ({ run_id, task_id }) => {
    const buffer: RunLatencySpan[] = [];
    buffers.set(run_id, buffer);
    const sinks: RunLatencyTraceSink[] = [];
    if (persist) sinks.push(new FileRunLatencyTraceSink(options.root));
    sinks.push(...(options.extraSinks ?? []), {
      append: (span) => {
        buffer.push(span);
      },
    });
    return new RunLatencyRecorder({
      run_id,
      task_id,
      sink: {
        append: (span) => {
          for (const sink of sinks) {
            try {
              sink.append(span);
            } catch {
              // 一个 sink 失败不该影响其它 sink，更不该影响被测调用。
            }
          }
        },
      },
    });
  };

  return {
    createRecorder,
    snapshot: (runId) => {
      const spans = buffers.get(runId) ?? [];
      buffers.delete(runId);
      return summarizeRunLatency(runId, spans);
    },
  };
}
