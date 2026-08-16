import { describe, expect, it } from 'vitest';
import { TraceProjector, type TraceEventInput } from '../../src/trace/trace-projector';
import type { TrajectorySpanRecord } from '../../src/trace/types';

const T0 = '2026-07-11T08:00:00.000Z';
const T1 = '2026-07-11T08:00:01.000Z';

function event(
  event_type: string,
  subject_id: string,
  payload: Record<string, unknown> = {},
  at: string = T0,
): TraceEventInput {
  return {
    event_type,
    subject_id,
    run_id: 'run_1',
    task_id: 'task_1',
    payload,
    created_at: at,
  };
}

describe('TraceProjector', () => {
  it('pairs lifecycle events into start/end spans and keeps points as-is', () => {
    const projector = new TraceProjector({ append: () => undefined, flush: () => undefined });
    const records: TrajectorySpanRecord[] = [
      projector.projectEvent(event('task.created', 'task_1', { spec: 'Do the thing' }))[0]!,
      projector.projectEvent(event('run.created', 'run_1'))[0]!,
      projector.projectEvent(event('driver.session_started', 'session_1', { driver_id: 'drv' }))[0]!,
      projector.projectEvent(
        event('driver.run_result', 'result_1', { status: 'succeeded' }, T1),
      )[0]!,
      projector.projectEvent(event('gate.requested', 'gate_1', { gate_point: 'task.completed' }))[0]!,
      projector.projectEvent(event('gate.result', 'gate_result_1', { decision: 'allow' }, T1))[0]!,
      projector.projectEvent(event('task.completed', 'task_1', { summary: 'done' }, T1))[0]!,
      projector.projectEvent(event('run.completed', 'run_1', {}, T1))[0]!,
    ];

    expect(records).toHaveLength(8);
    expect(records.map((record) => record.phase)).toEqual([
      'start',
      'start',
      'start',
      'end',
      'start',
      'end',
      'end',
      'end',
    ]);

    const taskStart = records[0]!;
    const taskEnd = records[6]!;
    expect(taskStart.kind).toBe('task.run');
    expect(taskEnd.span_id).toBe(taskStart.span_id);
    expect(taskEnd.status).toBe('ok');

    const runStart = records[1]!;
    const runEnd = records[7]!;
    expect(runStart.parent_span_id).toBeUndefined();
    expect(runEnd.span_id).toBe(runStart.span_id);
    expect(runEnd.status).toBe('ok');

    const driverStart = records[2]!;
    const driverEnd = records[3]!;
    expect(driverStart.parent_span_id).toBe(runStart.span_id);
    expect(driverEnd.span_id).toBe(driverStart.span_id);
    expect(driverEnd.status).toBe('ok');
    expect(driverEnd.duration_ms).toBe(1000);
    expect(driverEnd.ended_at).toBe(T1);

    const gateStart = records[4]!;
    const gateEnd = records[5]!;
    expect(gateEnd.span_id).toBe(gateStart.span_id);
    expect(gateEnd.status).toBe('ok');
  });

  it('maps failure statuses from payloads', () => {
    const projector = new TraceProjector({ append: () => undefined, flush: () => undefined });
    projector.projectEvent(event('driver.session_started', 'session_1'));
    const driverEnd = projector.projectEvent(
      event('driver.run_result', 'result_1', { status: 'failed' }),
    )[0]!;
    expect(driverEnd.status).toBe('error');

    projector.projectEvent(event('gate.requested', 'gate_1'));
    const gateEnd = projector.projectEvent(
      event('gate.result', 'gate_result_1', { decision: 'deny' }),
    )[0]!;
    expect(gateEnd.status).toBe('error');
  });

  it('records unmatched end events as points instead of losing them', () => {
    const projector = new TraceProjector({ append: () => undefined, flush: () => undefined });
    const record = projector.projectEvent(
      event('gate.result', 'gate_result_1', { decision: 'allow' }),
    )[0]!;
    expect(record.phase).toBe('point');
    expect(record.kind).toBe('gate.eval');
    expect(record.status).toBe('ok');
  });

  it('turns unmapped event types into generic point records', () => {
    const projector = new TraceProjector({ append: () => undefined, flush: () => undefined });
    const record = projector.projectEvent(event('some.future.event', 'subject_x'))[0]!;
    expect(record.phase).toBe('point');
    expect(record.kind).toBe('event');
  });

  it('closes leftover open spans with open status', () => {
    const sink: TrajectorySpanRecord[] = [];
    const projector = new TraceProjector({
      append: (record) => sink.push(record),
      flush: () => undefined,
    });
    projector.projectEvent(event('run.created', 'run_1'));
    projector.projectEvent(event('driver.session_started', 'session_1'));

    const closed = projector.closeOpenSpans('run_1');
    expect(closed).toHaveLength(2);
    expect(closed.map((record) => record.status)).toEqual(['open', 'open']);
    expect(sink).toHaveLength(4);
  });

  it('assigns per-run sequence numbers in event order', () => {
    const projector = new TraceProjector({ append: () => undefined, flush: () => undefined });
    const first = projector.projectEvent(event('task.created', 'task_1'))[0]!;
    const second = projector.projectEvent(event('memory.context_pack_built', 'pack_1'))[0]!;
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
  });

  it('projects bounded input/output payloads from event payloads', () => {
    const projector = new TraceProjector({ append: () => undefined, flush: () => undefined });
    const start = projector.projectEvent(
      event('task.created', 'task_1', { spec: 'Do the thing', risk_level: 'low' }),
    )[0]!;
    expect(start.payload).toEqual({ input: { spec: 'Do the thing', risk_level: 'low' } });

    const end = projector.projectEvent(
      event('task.completed', 'task_1', { summary: 'done', artifact_refs: ['a1', 'a2'] }, T1),
    )[0]!;
    expect(end.payload).toEqual({ output: { summary: 'done', artifact_refs: ['a1', 'a2'] } });

    const point = projector.projectEvent(
      event('gate.result', 'g', { decision: 'allow', reason: 'ok' }),
    )[0]!;
    expect(point.payload).toEqual({ decision: 'allow', reason: 'ok' });
  });

  it('bounds event payload previews to keep records small', () => {
    const projector = new TraceProjector({ append: () => undefined, flush: () => undefined });
    const long = 'x'.repeat(1000);
    const start = projector.projectEvent(
      event('task.created', 'task_1', { spec: long }),
    )[0]!;
    const input = start.payload?.input as { spec: string };
    expect(input.spec.length).toBeLessThanOrEqual(401);
    expect(input.spec).toContain('…');
  });

  it('omits payload when the event payload is empty', () => {
    const projector = new TraceProjector({ append: () => undefined, flush: () => undefined });
    const start = projector.projectEvent(event('task.created', 'task_1', {}))[0]!;
    expect(start.payload).toBeUndefined();
  });

  it('projectDirect stamps shared sequence, timestamps and schema', () => {
    const sink: TrajectorySpanRecord[] = [];
    const projector = new TraceProjector({
      append: (record) => sink.push(record),
      flush: () => undefined,
    });
    projector.projectEvent(event('run.created', 'run_1'));
    const direct = projector.projectDirect({
      span_id: 'span_x',
      run_id: 'run_1',
      task_id: 'task_1',
      parent_span_id: 'span_parent',
      kind: 'agent.tool',
      phase: 'start',
      agent_id: 'role_a',
      started_at: T1,
      summary: 'invoke_driver',
      payload: { tool_call_id: 'call_1' },
    });
    expect(direct.sequence).toBe(2);
    expect(direct.created_at).toBe(T1);
    expect(direct.schema_version).toBe('v0');
    expect(direct.kind).toBe('agent.tool');
    expect(direct.parent_span_id).toBe('span_parent');
    expect(sink).toHaveLength(2);
  });

  it('projectDirect keeps per-run sequences independent of event projection', () => {
    const projector = new TraceProjector({ append: () => undefined, flush: () => undefined });
    projector.projectEvent(event('run.created', 'run_1'));
    const direct = projector.projectDirect({
      span_id: 'span_a',
      run_id: 'run_1',
      kind: 'agent.turn',
      phase: 'start',
    });
    const otherRun = projector.projectEvent({ ...event('task.created', 'task_2'), run_id: 'run_2' })[0]!;
    expect(direct.sequence).toBe(2);
    expect(otherRun.sequence).toBe(1);
  });

  it('projectDirect omits absent optional fields', () => {
    const projector = new TraceProjector({ append: () => undefined, flush: () => undefined });
    const direct = projector.projectDirect({
      span_id: 'span_b',
      run_id: 'run_1',
      kind: 'agent.execution',
      phase: 'end',
      status: 'ok',
    });
    expect(direct.agent_id).toBeUndefined();
    expect(direct.parent_span_id).toBeUndefined();
    expect(direct.summary).toBeUndefined();
    expect(direct.status).toBe('ok');
    expect(direct.sequence).toBe(1);
  });
});
