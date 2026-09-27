import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DriverStreamEvent } from '../driver/contract';

export interface DriverStreamAuditWriter {
  append(runId: string, taskId: string, event: DriverStreamEvent): Promise<void>;
  flush(runId: string): Promise<void>;
}

export class NoopDriverStreamAuditWriter implements DriverStreamAuditWriter {
  append(): Promise<void> {
    return Promise.resolve();
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * 单个 run 的 driver-stream.jsonl 默认保留上限（字节）。
 *
 * 这份文件是观测副本不是账本：事件流会随会话长度线性堆积，没有上限就会让
 * state root 无界增长。超限后停止追加并留下一行截断标记（`truncated: true`），
 * 读取方（如 driver-usage-projector）按没有 `event` 的行跳过即可。
 */
export const DEFAULT_DRIVER_STREAM_MAX_BYTES = 8 * 1024 * 1024;

export class FileDriverStreamAuditWriter implements DriverStreamAuditWriter {
  private readonly queues = new Map<string, Promise<void>>();
  /** 已写过截断标记的 run。只防同一进程内重复标记，跨进程允许多标一行。 */
  private readonly truncatedRuns = new Set<string>();

  constructor(
    private readonly runsRoot = '.newide/runs',
    /**
     * 单 run 文件的保留上限。判定用文件当前大小（进程重启后依然生效），写入
     * 整行后才可能越线，所以实际保留量是「上限附近最后一条完整记录」。传
     * `Infinity` 关闭截断。
     */
    private readonly maxBytesPerRun: number = DEFAULT_DRIVER_STREAM_MAX_BYTES,
  ) {}

  append(runId: string, taskId: string, event: DriverStreamEvent): Promise<void> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.truncatedRuns.has(runId)) return;
      const runDir = path.join(this.runsRoot, runId);
      const filePath = path.join(runDir, 'driver-stream.jsonl');
      await fs.mkdir(runDir, { recursive: true });
      const envelope = {
        schema_version: 'driver-stream-audit.v1',
        run_id: runId,
        task_id: taskId,
        recorded_at: new Date().toISOString(),
      };
      const size = await fs
        .stat(filePath)
        .then((stat) => stat.size)
        .catch(() => 0);
      if (size >= this.maxBytesPerRun) {
        this.truncatedRuns.add(runId);
        await fs.appendFile(filePath, `${JSON.stringify({ ...envelope, truncated: true })}\n`, 'utf8');
        return;
      }
      await fs.appendFile(filePath, `${JSON.stringify({ ...envelope, event })}\n`, 'utf8');
    });
    this.queues.set(runId, next);
    return next.finally(() => {
      if (this.queues.get(runId) === next) this.queues.delete(runId);
    });
  }

  async flush(runId: string): Promise<void> {
    await (this.queues.get(runId) ?? Promise.resolve());
  }
}
