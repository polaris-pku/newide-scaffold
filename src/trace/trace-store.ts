/**
 * Trace sink and repository contracts plus in-memory implementation.
 *
 * TraceSink is the write side (append-only, like the telemetry sink);
 * TraceRepository is the read side used by replay and the run.trajectory RPC.
 */
import type { RunId } from '../core';
import type { TrajectorySpanRecord } from './types';

export interface TraceSink {
  append(record: TrajectorySpanRecord): void | Promise<void>;
  flush(runId: RunId): void | Promise<void>;
}

export interface TraceRepository {
  load(runId: RunId): Promise<TrajectorySpanRecord[]>;
}

export type RunTraceStore = TraceSink & TraceRepository;

export class NoopTraceStore implements RunTraceStore {
  append(_record: TrajectorySpanRecord): void {
    return undefined;
  }

  flush(_runId: RunId): void {
    return undefined;
  }

  async load(_runId: RunId): Promise<TrajectorySpanRecord[]> {
    return [];
  }
}

/** In-memory run trace store; useful for tests and the demo path. */
export class InMemoryTraceStore implements RunTraceStore {
  private readonly records = new Map<RunId, TrajectorySpanRecord[]>();

  append(record: TrajectorySpanRecord): void {
    const records = this.records.get(record.run_id ?? '') ?? [];
    records.push(record);
    this.records.set(record.run_id ?? '', records);
  }

  flush(_runId: RunId): void {
    return undefined;
  }

  async load(runId: RunId): Promise<TrajectorySpanRecord[]> {
    return [...(this.records.get(runId) ?? [])];
  }

  list(): TrajectorySpanRecord[] {
    return [...this.records.values()].flat();
  }
}
