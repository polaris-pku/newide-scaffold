/**
 * TraceProjector: event-driven trajectory instrumentation.
 *
 * Maps the existing Event vocabulary into append-only TrajectorySpanRecords,
 * so the whole system gets a trajectory without touching flow code: lifecycle
 * events (task.created -> task.completed, driver.session_started ->
 * driver.run_result, ...) become paired start/end spans; everything else
 * becomes a point record. Parallelism is a render-time projection in replay
 * (overlapping siblings by sequence order), matching the DeepSeek Harness
 * model of storing a linear stream and reconstructing structure later.
 */
import { SCHEMA_VERSION, createId, nowTimestamp, type Event, type RunId } from '../core';
import type { TraceSink } from './trace-store';
import type {
  TrajectorySpanKind,
  TrajectorySpanPhase,
  TrajectorySpanRecord,
  TrajectorySpanStatus,
} from './types';

export interface TraceEventInput {
  event_type: string;
  subject_id: string;
  event_id?: string;
  run_id?: string;
  task_id?: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export function fromCoreEvent(event: Event): TraceEventInput {
  return {
    event_type: event.event_type,
    subject_id: event.subject_id,
    event_id: event.event_id,
    ...(event.run_id ? { run_id: event.run_id } : {}),
    ...(event.task_id ? { task_id: event.task_id } : {}),
    payload: event.payload,
    created_at: event.created_at,
  };
}

export interface SpanMapping {
  kind: TrajectorySpanKind;
  phase: TrajectorySpanPhase;
  status?: TrajectorySpanStatus;
  statusFromPayload?: (payload: Record<string, unknown>) => TrajectorySpanStatus | undefined;
  key?: (input: TraceEventInput) => string | undefined;
  summary?: (input: TraceEventInput) => string | undefined;
  agentId?: (input: TraceEventInput) => string | undefined;
}

function payloadValue(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function payloadString(input: TraceEventInput, ...keys: string[]): string | undefined {
  return payloadValue(input.payload, ...keys);
}

function driverRunStatus(payload: Record<string, unknown>): TrajectorySpanStatus | undefined {
  const status = payloadValue(payload, 'status');
  if (status === 'succeeded') return 'ok';
  if (status === 'failed' || status === 'interrupted') return 'error';
  if (status === 'cancelled') return 'cancelled';
  return undefined;
}

const MAPPING: Readonly<Record<string, SpanMapping>> = {
  'task.created': {
    kind: 'task.run',
    phase: 'start',
    key: (input) => input.task_id ?? input.subject_id,
    summary: (input) => payloadString(input, 'spec'),
    agentId: (input) => payloadString(input, 'role_id', 'owner_agent_id'),
  },
  'task.completed': {
    kind: 'task.run',
    phase: 'end',
    status: 'ok',
    key: (input) => input.task_id ?? input.subject_id,
    summary: (input) => payloadString(input, 'summary'),
  },
  'task.failed': {
    kind: 'task.run',
    phase: 'end',
    status: 'error',
    key: (input) => input.task_id ?? input.subject_id,
    summary: (input) => payloadString(input, 'message', 'code', 'reason'),
  },
  'run.created': {
    kind: 'run',
    phase: 'start',
    key: (input) => input.run_id ?? input.subject_id,
  },
  'run.started': { kind: 'run', phase: 'point' },
  'run.completed': {
    kind: 'run',
    phase: 'end',
    status: 'ok',
    key: (input) => input.run_id ?? input.subject_id,
  },
  'run.failed': {
    kind: 'run',
    phase: 'end',
    status: 'error',
    key: (input) => input.run_id ?? input.subject_id,
    summary: (input) => payloadString(input, 'message', 'code'),
  },
  'run.cancelled': {
    kind: 'run',
    phase: 'end',
    status: 'cancelled',
    key: (input) => input.run_id ?? input.subject_id,
    summary: (input) => payloadString(input, 'message', 'reason'),
  },
  'driver.session_started': {
    kind: 'driver.run',
    phase: 'start',
    key: (input) => payloadString(input, 'session_id') ?? input.subject_id,
    summary: (input) => payloadString(input, 'driver_id'),
    agentId: (input) => payloadString(input, 'role_id', 'agent_id'),
  },
  'driver.run_result': {
    kind: 'driver.run',
    phase: 'end',
    statusFromPayload: driverRunStatus,
    key: (input) => payloadString(input, 'session_id'),
    summary: (input) => payloadString(input, 'status'),
    agentId: (input) => payloadString(input, 'role_id', 'agent_id'),
  },
  'driver.turn_started': {
    kind: 'driver.turn',
    phase: 'point',
    agentId: (input) => payloadString(input, 'role_id', 'agent_id'),
  },
  'driver.turn_completed': {
    kind: 'driver.turn',
    phase: 'point',
    status: 'ok',
    summary: (input) => payloadString(input, 'stop_reason'),
    agentId: (input) => payloadString(input, 'role_id', 'agent_id'),
  },
  'driver.turn_failed': {
    kind: 'driver.turn',
    phase: 'point',
    status: 'error',
    summary: (input) => payloadString(input, 'reason', 'message'),
    agentId: (input) => payloadString(input, 'role_id', 'agent_id'),
  },
  'driver.tool_started': {
    kind: 'driver.tool',
    phase: 'point',
    summary: (input) => payloadString(input, 'title', 'tool_name'),
    agentId: (input) => payloadString(input, 'role_id', 'agent_id'),
  },
  'driver.tool_completed': {
    kind: 'driver.tool',
    phase: 'point',
    status: 'ok',
    summary: (input) => payloadString(input, 'title', 'tool_name'),
    agentId: (input) => payloadString(input, 'role_id', 'agent_id'),
  },
  'driver.tool_failed': {
    kind: 'driver.tool',
    phase: 'point',
    status: 'error',
    summary: (input) => payloadString(input, 'title', 'tool_name'),
    agentId: (input) => payloadString(input, 'role_id', 'agent_id'),
  },
  'driver.interrupt_requested': {
    kind: 'driver.run',
    phase: 'point',
    status: 'timeout',
    summary: (input) => payloadString(input, 'reason'),
  },
  'gate.requested': {
    kind: 'gate.eval',
    phase: 'start',
    key: (input) =>
      [payloadString(input, 'gate_point'), payloadString(input, 'subject_id')].join(':'),
  },
  'gate.result': {
    kind: 'gate.eval',
    phase: 'end',
    statusFromPayload: (payload) => (payload.decision === 'allow' ? 'ok' : 'error'),
    key: (input) =>
      [payloadString(input, 'gate_point'), payloadString(input, 'subject_id')].join(':'),
    summary: (input) => payloadString(input, 'decision', 'reason'),
  },
  'council.started': {
    kind: 'council.session',
    phase: 'start',
    key: (input) => input.subject_id,
    summary: (input) => payloadString(input, 'trigger'),
  },
  'council.decision': {
    kind: 'council.session',
    phase: 'end',
    status: 'ok',
    key: (input) => input.subject_id,
    summary: (input) => payloadString(input, 'verdict'),
  },
  'council.completed': {
    kind: 'council.session',
    phase: 'end',
    status: 'ok',
    key: (input) => input.subject_id,
    summary: () => 'completed',
  },
  'council.review_round_end': { kind: 'council.session', phase: 'point' },
  'memory.context_pack_built': {
    kind: 'memory.retrieve',
    phase: 'point',
    summary: (input) => payloadString(input, 'role_id'),
  },
  'memory.experience_referenced': { kind: 'memory.retrieve', phase: 'point' },
  'memory.extraction_completed': { kind: 'memory.extract', phase: 'point', status: 'ok' },
  'memory.skill_promoted': { kind: 'memory.extract', phase: 'point', status: 'ok' },
  'buffer.report_received': { kind: 'memory.extract', phase: 'point' },
  'memory.agent_lifecycle': { kind: 'memory.extract', phase: 'point' },
  'memory.persona_updated': { kind: 'memory.extract', phase: 'point' },
  'checkpoint.saved': {
    kind: 'checkpoint',
    phase: 'point',
    summary: (input) => payloadString(input, 'trigger'),
  },
  'artifact.registered': {
    kind: 'artifact',
    phase: 'point',
    summary: (input) => payloadString(input, 'type', 'uri'),
  },
  'artifact.selected': { kind: 'artifact', phase: 'point', status: 'ok' },
  'artifact.delivered': { kind: 'artifact', phase: 'point', status: 'ok' },
  'worktree.materialized': { kind: 'worktree', phase: 'point', status: 'ok' },
  'merge.authorization': {
    kind: 'merge',
    phase: 'point',
    summary: (input) => payloadString(input, 'status'),
  },
  'hook.matched': { kind: 'hook', phase: 'point' },
  'agent.message_send': { kind: 'agent.message', phase: 'point' },
  'agent.message_recv': { kind: 'agent.message', phase: 'point' },
  'agent.execution_requested': {
    kind: 'agent.execution',
    phase: 'point',
    agentId: (input) => payloadString(input, 'agent_id', 'role_id'),
  },
  'agent.execution_completed': {
    kind: 'agent.execution',
    phase: 'point',
    status: 'ok',
    agentId: (input) => payloadString(input, 'agent_id', 'role_id'),
  },
  'market.selected': {
    kind: 'market',
    phase: 'point',
    agentId: (input) => payloadString(input, 'winner_agent_id', 'agent_id'),
  },
  'system.timeout': { kind: 'system', phase: 'point', status: 'timeout' },
  'system.budget_exceeded': { kind: 'system', phase: 'point', status: 'error' },
  'lifecycle.human_gate': { kind: 'system', phase: 'point' },
};

interface OpenSpan {
  span_id: string;
  kind: TrajectorySpanKind;
  key?: string;
  run_id?: RunId;
  task_id?: string;
  agent_id?: string;
  summary?: string;
  started_at: string;
  source_event_id: string;
}

export class TraceProjector {
  private readonly open = new Map<string, OpenSpan[]>();
  private readonly sequences = new Map<string, number>();

  constructor(private readonly sink: TraceSink) {}

  /** Project one domain event into zero or more trajectory records. */
  projectEvent(input: TraceEventInput): TrajectorySpanRecord[] {
    const runKey = input.run_id ?? '__global__';
    const sequence = (this.sequences.get(runKey) ?? 0) + 1;
    this.sequences.set(runKey, sequence);

    const mapping = MAPPING[input.event_type];
    if (!mapping || mapping.phase === 'point') {
      const record = this.buildPointRecord(input, mapping?.kind ?? 'event', sequence, mapping);
      void this.sink.append(record);
      return [record];
    }
    if (mapping.phase === 'start') {
      const record = this.emitStart(input, mapping, sequence);
      void this.sink.append(record);
      return [record];
    }

    const records = this.emitEnd(input, mapping, sequence);
    for (const record of records) void this.sink.append(record);
    return records;
  }

  /** Close any leftover open spans for a run (crash / terminal without end event). */
  closeOpenSpans(runId: RunId): TrajectorySpanRecord[] {
    const stack = this.open.get(runId) ?? [];
    const records = stack.map((span) => this.buildEndRecord(span, 'open', nowTimestamp(), undefined));
    this.open.delete(runId);
    for (const record of records) void this.sink.append(record);
    return records;
  }

  private emitStart(
    input: TraceEventInput,
    mapping: SpanMapping,
    sequence: number,
  ): TrajectorySpanRecord {
    const runKey = input.run_id ?? '__global__';
    const stack = this.open.get(runKey) ?? [];
    const parent = mapping.kind === 'run' ? undefined : stack.at(-1);
    const key = mapping.key?.(input);
    const agentId = mapping.agentId?.(input);
    const summary = mapping.summary?.(input);
    const span: OpenSpan = {
      span_id: createId('span'),
      kind: mapping.kind,
      ...(key !== undefined ? { key } : {}),
      ...(input.run_id ? { run_id: input.run_id } : {}),
      ...(input.task_id ? { task_id: input.task_id } : {}),
      ...(agentId !== undefined ? { agent_id: agentId } : {}),
      ...(summary !== undefined ? { summary } : {}),
      started_at: input.created_at,
      source_event_id: input.event_id ?? input.subject_id,
    };
    stack.push(span);
    this.open.set(runKey, stack);
    return {
      span_id: span.span_id,
      kind: mapping.kind,
      phase: 'start',
      ...(input.run_id ? { run_id: input.run_id } : {}),
      ...(input.task_id ? { task_id: input.task_id } : {}),
      ...(parent ? { parent_span_id: parent.span_id } : {}),
      ...(agentId !== undefined ? { agent_id: agentId } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(span.started_at ? { started_at: span.started_at } : {}),
      source_event_id: span.source_event_id,
      sequence,
      created_at: input.created_at,
      schema_version: SCHEMA_VERSION,
    };
  }

  private emitEnd(
    input: TraceEventInput,
    mapping: SpanMapping,
    sequence: number,
  ): TrajectorySpanRecord[] {
    const runKey = input.run_id ?? '__global__';
    const stack = this.open.get(runKey) ?? [];
    const index = this.findOpenSpan(stack, mapping, input);
    if (index < 0) {
      // Unmatched end: keep it as a point so the event is not lost.
      return [this.buildPointRecord(input, mapping.kind, sequence, mapping)];
    }
    const removed = stack.splice(index, 1);
    const span = removed[0];
    if (!span) {
      return [this.buildPointRecord(input, mapping.kind, sequence, mapping)];
    }
    this.open.set(runKey, stack);
    const status = mapping.statusFromPayload?.(input.payload) ?? mapping.status ?? 'ok';
    const summary = mapping.summary?.(input) ?? span.summary;
    return [this.buildEndRecord(span, status, input.created_at, summary, sequence)];
  }

  private findOpenSpan(
    stack: OpenSpan[],
    mapping: SpanMapping,
    input: TraceEventInput,
  ): number {
    const key = mapping.key?.(input);
    if (key !== undefined) {
      const keyed = stack.findIndex((span) => span.kind === mapping.kind && span.key === key);
      if (keyed >= 0) return keyed;
    }
    // LIFO fallback for kinds whose start/end events do not share an identity.
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index]!.kind === mapping.kind) return index;
    }
    return -1;
  }

  private buildPointRecord(
    input: TraceEventInput,
    kind: TrajectorySpanKind,
    sequence: number,
    mapping?: SpanMapping,
  ): TrajectorySpanRecord {
    const agentId = mapping?.agentId?.(input);
    const summary = mapping?.summary?.(input);
    const status = mapping?.statusFromPayload?.(input.payload) ?? mapping?.status;
    return {
      span_id: createId('span'),
      kind,
      phase: 'point',
      ...(input.run_id ? { run_id: input.run_id } : {}),
      ...(input.task_id ? { task_id: input.task_id } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(agentId !== undefined ? { agent_id: agentId } : {}),
      ...(summary !== undefined ? { summary } : {}),
      source_event_id: input.event_id ?? input.subject_id,
      sequence,
      created_at: input.created_at,
      schema_version: SCHEMA_VERSION,
    };
  }

  private buildEndRecord(
    span: OpenSpan,
    status: TrajectorySpanStatus,
    endedAt: string,
    summary: string | undefined,
    sequence?: number,
  ): TrajectorySpanRecord {
    const durationMs = parseTimestampMs(endedAt) - parseTimestampMs(span.started_at);
    return {
      span_id: span.span_id,
      kind: span.kind,
      phase: 'end',
      ...(span.run_id ? { run_id: span.run_id } : {}),
      ...(span.task_id ? { task_id: span.task_id } : {}),
      ...(span.agent_id ? { agent_id: span.agent_id } : {}),
      ...(span.summary ? { summary: span.summary } : {}),
      ...(summary !== undefined && summary !== span.summary ? { summary } : {}),
      status,
      started_at: span.started_at,
      ended_at: endedAt,
      ...(Number.isFinite(durationMs) && durationMs >= 0 ? { duration_ms: durationMs } : {}),
      ...(span.source_event_id ? { source_event_id: span.source_event_id } : {}),
      sequence: sequence ?? 0,
      created_at: endedAt,
      schema_version: SCHEMA_VERSION,
    };
  }
}

function parseTimestampMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}
