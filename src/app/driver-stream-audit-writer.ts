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

export class FileDriverStreamAuditWriter implements DriverStreamAuditWriter {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly runsRoot = '.newide/runs') {}

  append(runId: string, taskId: string, event: DriverStreamEvent): Promise<void> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const runDir = path.join(this.runsRoot, runId);
      await fs.mkdir(runDir, { recursive: true });
      await fs.appendFile(
        path.join(runDir, 'driver-stream.jsonl'),
        `${JSON.stringify({
          schema_version: 'driver-stream-audit.v1',
          run_id: runId,
          task_id: taskId,
          recorded_at: new Date().toISOString(),
          event,
        })}\n`,
        'utf8',
      );
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
