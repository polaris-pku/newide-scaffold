/**
 * File-backed run trajectory writer (NDJSON).
 *
 * Mirrors FileRunAuditWriter: one `trajectory.jsonl` per run under
 * `<runsRoot>/<runId>/`, appended through a per-run promise queue so writes
 * stay ordered. Implements both the write side (TraceSink) and the read side
 * (TraceRepository) so replay can load a finished or crashed run.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RunId } from '../core';
import { TRAJECTORY_SCHEMA_VERSION, type TrajectorySpanRecord } from './types';

export const TRAJECTORY_FILE_NAME = 'trajectory.jsonl';

export class FileTrajectoryWriter {
  private readonly queues = new Map<RunId, Promise<void>>();

  constructor(private readonly runsRoot = '.newide/runs') {}

  private runDir(runId: RunId): string {
    return path.join(this.runsRoot, runId);
  }

  private filePath(runId: RunId): string {
    return path.join(this.runDir(runId), TRAJECTORY_FILE_NAME);
  }

  async initialize(runId: RunId): Promise<void> {
    await fs.mkdir(this.runDir(runId), { recursive: true });
    await fs.open(this.filePath(runId), 'a').then((handle) => handle.close());
  }

  append(record: TrajectorySpanRecord): Promise<void> {
    const runId = record.run_id ?? '__unscoped__';
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await this.initialize(runId);
      await fs.appendFile(this.filePath(runId), `${JSON.stringify(record)}\n`, 'utf-8');
    });
    this.queues.set(runId, next);
    return next.finally(() => {
      if (this.queues.get(runId) === next) this.queues.delete(runId);
    });
  }

  async flush(runId: RunId): Promise<void> {
    await (this.queues.get(runId) ?? Promise.resolve());
  }

  async load(runId: RunId): Promise<TrajectorySpanRecord[]> {
    const contents = await fs.readFile(this.filePath(runId), 'utf-8').catch(() => '');
    return contents
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => parseTrajectoryLine(line))
      .filter((record): record is TrajectorySpanRecord => record !== null);
  }
}

export function parseTrajectoryLine(line: string): TrajectorySpanRecord | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object') return null;
    const record = value as Partial<TrajectorySpanRecord>;
    const validPhase =
      record.phase === 'start' || record.phase === 'end' || record.phase === 'point';
    if (
      typeof record.span_id !== 'string' ||
      typeof record.kind !== 'string' ||
      !validPhase ||
      typeof record.sequence !== 'number' ||
      typeof record.created_at !== 'string'
    ) {
      return null;
    }
    return {
      ...(record as TrajectorySpanRecord),
      schema_version: TRAJECTORY_SCHEMA_VERSION,
    };
  } catch {
    return null;
  }
}
