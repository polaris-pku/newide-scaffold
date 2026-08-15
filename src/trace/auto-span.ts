/**
 * AutoSpan: explicit span lifecycle helper for instrumentation points that are
 * not covered by the event-driven TraceProjector (e.g. a long-running driver
 * dispatch or a retry loop). Always closes the span — including on throw — so
 * the trajectory never leaks open spans.
 */
import { SCHEMA_VERSION, createId, nowTimestamp, type RunId, type TaskId } from '../core';
import type { TraceSink } from './trace-store';
import type {
  TrajectorySpanKind,
  TrajectorySpanRecord,
  TrajectorySpanStatus,
} from './types';

export interface AutoSpanOptions {
  kind: TrajectorySpanKind;
  run_id?: RunId;
  task_id?: TaskId;
  parent_span_id?: string;
  parallel_group_id?: string;
  agent_id?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  now?: () => number;
}

export class AutoSpan {
  readonly span_id: string;
  private readonly startedAt: number;
  private closed = false;

  constructor(
    private readonly sink: TraceSink,
    private readonly options: AutoSpanOptions,
  ) {
    this.span_id = createId('span');
    this.startedAt = (options.now ?? Date.now)();
    void sink.append(this.buildRecord('start', { started_at: nowTimestamp() }));
  }

  /** Close the span with an explicit status and optional summary. */
  close(status: TrajectorySpanStatus = 'ok', summary?: string): TrajectorySpanRecord {
    if (this.closed) {
      throw new Error(`AutoSpan ${this.span_id} was already closed`);
    }
    this.closed = true;
    const endedAt = (this.options.now ?? Date.now)();
    const record = this.buildRecord('end', {
      ended_at: nowTimestamp(),
      duration_ms: Math.max(0, endedAt - this.startedAt),
      status,
      ...(summary !== undefined ? { summary } : {}),
    });
    void this.sink.append(record);
    return record;
  }

  /** Close with `error` status; safe to call from a catch block. */
  fail(summary?: string): TrajectorySpanRecord {
    return this.close('error', summary);
  }

  private buildRecord(
    phase: TrajectorySpanRecord['phase'],
    extra: Partial<TrajectorySpanRecord>,
  ): TrajectorySpanRecord {
    return {
      span_id: this.span_id,
      kind: this.options.kind,
      phase,
      sequence: 0,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
      ...(this.options.run_id ? { run_id: this.options.run_id } : {}),
      ...(this.options.task_id ? { task_id: this.options.task_id } : {}),
      ...(this.options.parent_span_id ? { parent_span_id: this.options.parent_span_id } : {}),
      ...(this.options.parallel_group_id
        ? { parallel_group_id: this.options.parallel_group_id }
        : {}),
      ...(this.options.agent_id ? { agent_id: this.options.agent_id } : {}),
      ...(this.options.summary ? { summary: this.options.summary } : {}),
      ...(this.options.payload ? { payload: this.options.payload } : {}),
      ...extra,
    };
  }
}

/** Run an async operation inside an AutoSpan; closes ok/error via try/finally. */
export async function withSpan<T>(
  sink: TraceSink,
  options: AutoSpanOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const span = new AutoSpan(sink, options);
  try {
    const result = await operation();
    span.close('ok');
    return result;
  } catch (error) {
    span.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
