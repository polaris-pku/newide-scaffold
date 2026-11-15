/**
 * 阶段 4：派工进度投影（run-dispatch-events → dispatch_summary / dispatch_progress）。
 *
 * 断言的是**最终对外可观察的口径**：身份按 dispatch_id 去重、状态按契约折叠
 * （accepted-only=not_executed、started-only=unknown）、继承与当前分开、终止原因如实。
 */
import { describe, expect, it } from 'vitest';
import {
  buildExecutionBrief,
  DispatchRecordSchema,
  hashExecutionBrief,
  DISPATCH_RECORD_SCHEMA_VERSION,
  type DispatchRecord,
  type ExecutionBrief,
} from '../../src/driver';
import { projectDispatchFacts } from '../../src/app/run-dispatch-projection';
import type { DispatchTimelineEvent } from '../../src/app/run-dispatch-projection';
import { ROLE_DISPATCH_EVENT } from '../../src/app/run-dispatch-events';

let timeCursor = Date.parse('2026-11-15T00:00:00.000Z');

function nextTime(): string {
  timeCursor += 1_000;
  return new Date(timeCursor).toISOString();
}

function event(
  type: string,
  payload: Record<string, unknown>,
  createdAt = nextTime(),
): DispatchTimelineEvent {
  return { type, payload, created_at: createdAt };
}

function accepted(dispatchId: string, kind = 'execute'): DispatchTimelineEvent {
  return event(ROLE_DISPATCH_EVENT.accepted, {
    dispatch_id: dispatchId,
    kind,
    read_only: kind === 'investigate',
    session_mode: 'fresh',
    sequence: 1,
  });
}

function started(dispatchId: string): DispatchTimelineEvent {
  return event(ROLE_DISPATCH_EVENT.started, { dispatch_id: dispatchId, kind: 'execute' });
}

function settled(
  dispatchId: string,
  status: string,
  extra: Record<string, unknown> = {},
): DispatchTimelineEvent {
  return event(ROLE_DISPATCH_EVENT.settled, {
    dispatch_id: dispatchId,
    kind: 'execute',
    status,
    violations: [],
    evidence_ref: { path: `journal/evidence/${dispatchId}.json`, sha256: 'a'.repeat(64) },
    ...extra,
  });
}

describe('projectDispatchFacts', () => {
  it('returns nothing for a legacy timeline without dispatch facts (no fabricated zero)', () => {
    const projection = projectDispatchFacts([
      event('agent.execution_requested', { role_id: 'role_ts_engineer' }),
      event('agent.execution_completed', { role_id: 'role_ts_engineer' }),
    ]);
    expect(projection).toEqual({});
    expect(projection.summary).toBeUndefined();
    expect(projection.progress).toBeUndefined();
  });

  it('folds accepted-only to not_executed and started-without-settled to unknown', () => {
    const projection = projectDispatchFacts([
      accepted('dsp_accepted_only'),
      accepted('dsp_unknown'),
      started('dsp_unknown'),
    ]);

    expect(projection.summary).toMatchObject({
      total: 2,
      by_status: { not_executed: 1, unknown: 1 },
      unknown: { count: 1, dispatch_ids: ['dsp_unknown'] },
      violations: { count: 0, kinds: [] },
    });
  });

  it('counts a dispatch exactly once even when its events are replayed', () => {
    const projection = projectDispatchFacts([
      accepted('dsp_1'),
      started('dsp_1'),
      settled('dsp_1', 'succeeded'),
      // 同一身份的事件重放（订阅重连 / 投影重复读取）不重复计数。
      settled('dsp_1', 'succeeded'),
      accepted('dsp_1'),
    ]);

    expect(projection.summary).toMatchObject({
      total: 1,
      by_status: { succeeded: 1 },
      unknown: { count: 0 },
    });
  });

  it('lets a late reconciled result close an unknown without overwriting a settled terminal', () => {
    const projection = projectDispatchFacts([
      accepted('dsp_late'),
      started('dsp_late'),
      settled('dsp_late', 'unknown'),
      event(ROLE_DISPATCH_EVENT.reconciled, {
        dispatch_id: 'dsp_late',
        status: 'succeeded',
        source: 'late_result',
      }),
      accepted('dsp_failed'),
      started('dsp_failed'),
      settled('dsp_failed', 'failed'),
      // 已发终态不得被 reconciled 改写。
      event(ROLE_DISPATCH_EVENT.reconciled, {
        dispatch_id: 'dsp_failed',
        status: 'succeeded',
        source: 'late_result',
      }),
    ]);

    expect(projection.summary?.by_status).toEqual({ succeeded: 1, failed: 1 });
    expect(projection.summary?.unknown.count).toBe(0);
  });

  it('keeps violation count and kinds deduped per dispatch', () => {
    const projection = projectDispatchFacts([
      accepted('dsp_violation', 'investigate'),
      started('dsp_violation'),
      settled('dsp_violation', 'failed', {
        violations: ['read_only_changed', 'read_only_changed', 'scope_unconfirmed'],
      }),
    ]);

    expect(projection.summary?.violations).toEqual({
      count: 2,
      kinds: ['read_only_changed', 'scope_unconfirmed'],
    });
  });

  it('reports the most recent dispatch as last_dispatch', () => {
    const projection = projectDispatchFacts([
      accepted('dsp_old'),
      started('dsp_old'),
      settled('dsp_old', 'succeeded'),
      accepted('dsp_new', 'verify'),
      started('dsp_new'),
    ]);

    expect(projection.summary?.last_dispatch).toMatchObject({
      dispatch_id: 'dsp_new',
      kind: 'verify',
      status: 'unknown',
    });
  });

  it('separates inherited parent-chain dispatches from the current run counts', () => {
    const projection = projectDispatchFacts([
      // 父链投影：同一 source_run_id 重复出现只算一次。
      event(ROLE_DISPATCH_EVENT.inherited, {
        source_run_id: 'run_parent',
        dispatch_count: 3,
        by_status: { succeeded: 2, unknown: 1 },
        unresolved_dispatch_ids: ['dsp_parent_unknown'],
        violations: { count: 0, kinds: [] },
      }),
      event(ROLE_DISPATCH_EVENT.inherited, {
        source_run_id: 'run_parent',
        dispatch_count: 3,
        by_status: { succeeded: 2, unknown: 1 },
        unresolved_dispatch_ids: ['dsp_parent_unknown'],
        violations: { count: 0, kinds: [] },
      }),
      // 多级继承：祖父 Run。
      event(ROLE_DISPATCH_EVENT.inherited, {
        source_run_id: 'run_grandparent',
        dispatch_count: 1,
        by_status: { succeeded: 1 },
        unresolved_dispatch_ids: [],
        violations: { count: 1, kinds: ['read_only_changed'] },
      }),
      accepted('dsp_current'),
      started('dsp_current'),
      settled('dsp_current', 'succeeded'),
    ]);

    expect(projection.summary).toMatchObject({
      total: 1,
      by_status: { succeeded: 1 },
      inherited: {
        total: 4,
        by_status: { succeeded: 3, unknown: 1 },
        unresolved_dispatch_ids: ['dsp_parent_unknown'],
      },
    });
    // 当前 total 不含继承，继承不重复累加。
    expect(projection.summary?.total).toBe(1);
    expect(projection.summary?.inherited?.source_run_ids).toEqual([
      'run_parent',
      'run_grandparent',
    ]);
  });

  it('reports an in-flight dispatch only while the run is still running', () => {
    const events = [accepted('dsp_running'), started('dsp_running')];

    const running = projectDispatchFacts(events, { running: true });
    expect(running.progress?.current).toMatchObject({
      dispatch_id: 'dsp_running',
      state: 'started',
    });

    const terminal = projectDispatchFacts(events, { running: false });
    expect(terminal.progress?.current).toBeUndefined();
    // 终态 Run 上同一份事件仍是 unknown 事实，而不是「正在派工」。
    expect(terminal.summary?.by_status).toEqual({ unknown: 1 });
  });

  it('projects plan, finish request, termination reason and controlled evidence refs', () => {
    const projection = projectDispatchFacts([
      event(ROLE_DISPATCH_EVENT.plan_updated, { plan: 'first plan' }),
      event(ROLE_DISPATCH_EVENT.plan_updated, { plan: 'final plan' }),
      accepted('dsp_a'),
      started('dsp_a'),
      settled('dsp_a', 'succeeded'),
      event(ROLE_DISPATCH_EVENT.finish_requested, {
        status: 'completed',
        verification_count: 2,
        unresolved_count: 0,
      }),
      event(ROLE_DISPATCH_EVENT.role_terminated, {
        code: 'budget_dispatches',
        actor: 'host',
        message: 'dispatch budget exhausted',
      }),
    ]);

    expect(projection.progress).toMatchObject({
      plan: { plan: 'final plan' },
      finish_requested: { status: 'completed' },
      terminated: { code: 'budget_dispatches', actor: 'host' },
      evidence_refs: [
        { dispatch_id: 'dsp_a', path: 'journal/evidence/dsp_a.json', sha256: 'a'.repeat(64) },
      ],
    });
    expect(projection.progress?.current).toBeUndefined();
  });

  it('never includes instructions, transcripts or oversized payloads in the projection', () => {
    const projection = projectDispatchFacts([
      event(ROLE_DISPATCH_EVENT.accepted, {
        dispatch_id: 'dsp_1',
        kind: 'execute',
        // 事件本身就不该带整段指令；即使旧/坏数据带上，投影也不把它搬进对外字段。
        instruction: 'x'.repeat(10_000),
        transcript: 'y'.repeat(10_000),
      }),
      settled('dsp_1', 'succeeded', { summary: 'full summary must not leak' }),
    ]);

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('xxxxxxxxxx');
    expect(serialized).not.toContain('full summary must not leak');
  });
});

let recordSequence = 0;

/** 构造一条 Journal 折叠记录（真实 schema 校验，不手写半真对象）。 */
function journalRecord(input: {
  dispatch_id: string;
  status?: DispatchRecord['status'];
  phase?: DispatchRecord['phase'];
  kind?: ExecutionBrief['kind'];
  dispatched_at?: string;
  settled_at?: string;
  evidence_sha256?: string;
  reconciled?: { status: 'succeeded' | 'failed' | 'unknown'; at?: string };
}): DispatchRecord {
  recordSequence += 1;
  const acceptedAt = '2026-11-15T00:00:00.000Z';
  const brief = buildExecutionBrief({
    identity: {
      dispatch_id: input.dispatch_id,
      run_id: 'run_current',
      task_id: 'task_1',
      role_id: 'role_1',
      sequence: recordSequence,
      accepted_at: acceptedAt,
    },
    request: { kind: input.kind ?? 'execute', instruction: `do ${input.dispatch_id}` },
  }).brief;
  return DispatchRecordSchema.parse({
    schema_version: DISPATCH_RECORD_SCHEMA_VERSION,
    dispatch_id: input.dispatch_id,
    run_id: 'run_current',
    task_id: 'task_1',
    role_id: 'role_1',
    sequence: recordSequence,
    phase: input.phase ?? 'settled',
    status: input.status ?? 'succeeded',
    brief,
    brief_sha256: hashExecutionBrief(brief),
    violations: [],
    accepted_at: acceptedAt,
    ...(input.dispatched_at !== undefined ? { dispatched_at: input.dispatched_at } : {}),
    ...(input.settled_at !== undefined ? { settled_at: input.settled_at } : {}),
    ...(input.evidence_sha256 !== undefined
      ? { evidence_sha256: input.evidence_sha256 }
      : {}),
    ...(input.reconciled !== undefined
      ? {
          reconciled: {
            status: input.reconciled.status,
            reason: 'late driver result reconciled after timeout/cancel (no replay)',
            at: input.reconciled.at ?? '2026-11-15T00:01:00.000Z',
          },
        }
      : {}),
  });
}

/**
 * 阶段 4 审核修复（R4-01 / R4-02）：事件是投影、Journal 是事实源。
 *
 * 这些用例覆盖「只缺 settled」「全部事件缺失」「原始 unknown + 可信 reconciled」三种
 * 事实缺口，断言投影仍能给出正确摘要/进度，且按 dispatch_id 幂等、继承不混入当前计数。
 */
describe('projectDispatchFacts with Journal facts', () => {
  it('recovers summary and evidence refs when only the settled event is missing', () => {
    const projection = projectDispatchFacts(
      [accepted('dsp_missing_settled'), started('dsp_missing_settled')],
      {
        running: false,
        journal_records: [
          journalRecord({
            dispatch_id: 'dsp_missing_settled',
            status: 'succeeded',
            dispatched_at: '2026-11-15T00:00:05.000Z',
            settled_at: '2026-11-15T00:00:09.000Z',
            evidence_sha256: 'b'.repeat(64),
          }),
        ],
      },
    );

    expect(projection.summary).toMatchObject({
      total: 1,
      by_status: { succeeded: 1 },
      unknown: { count: 0 },
      last_dispatch: { dispatch_id: 'dsp_missing_settled', status: 'succeeded' },
    });
    expect(projection.progress?.evidence_refs).toEqual([
      {
        dispatch_id: 'dsp_missing_settled',
        path: 'journal/evidence/dsp_missing_settled.json',
        sha256: 'b'.repeat(64),
      },
    ]);
  });

  it('rebuilds the whole summary from Journal when every dispatch event is missing, idempotently', () => {
    const records = [
      journalRecord({
        dispatch_id: 'dsp_1',
        status: 'succeeded',
        dispatched_at: '2026-11-15T00:00:05.000Z',
        settled_at: '2026-11-15T00:00:09.000Z',
      }),
      journalRecord({
        dispatch_id: 'dsp_2',
        status: 'unknown',
        phase: 'dispatched',
        dispatched_at: '2026-11-15T00:00:15.000Z',
      }),
    ];

    const once = projectDispatchFacts([], { running: false, journal_records: records });
    expect(once.summary).toMatchObject({
      total: 2,
      by_status: { succeeded: 1, unknown: 1 },
      unknown: { count: 1, dispatch_ids: ['dsp_2'] },
    });

    // 重复读取/重复恢复拿同一批事实：不放大计数；与已存在的事件叠加也只算一次。
    const twice = projectDispatchFacts([], { running: false, journal_records: records });
    expect(twice.summary?.total).toBe(2);
    const merged = projectDispatchFacts([accepted('dsp_1'), started('dsp_1')], {
      running: false,
      journal_records: records,
    });
    expect(merged.summary?.total).toBe(2);
    expect(merged.summary?.by_status).toEqual({ succeeded: 1, unknown: 1 });
  });

  it('counts a settled-unknown record by its effective reconciled status, raw record untouched', () => {
    const record = journalRecord({
      dispatch_id: 'dsp_late',
      status: 'unknown',
      settled_at: '2026-11-15T00:00:09.000Z',
      reconciled: { status: 'succeeded' },
    });
    // Journal 原始记录仍保留 unknown：有效状态只是对外解释，不改写历史事实。
    expect(record.status).toBe('unknown');

    const projection = projectDispatchFacts([], {
      running: false,
      journal_records: [record],
    });
    expect(projection.summary?.by_status).toEqual({ succeeded: 1 });
    expect(projection.summary?.unknown).toEqual({ count: 0, dispatch_ids: [] });
  });

  it('keeps parent-chain inherited counts separate from journal-recovered current dispatches', () => {
    const projection = projectDispatchFacts(
      [
        event(ROLE_DISPATCH_EVENT.inherited, {
          source_run_id: 'run_parent',
          dispatch_count: 2,
          by_status: { succeeded: 2 },
          unresolved_dispatch_ids: [],
          violations: { count: 0, kinds: [] },
        }),
      ],
      {
        running: false,
        journal_records: [journalRecord({ dispatch_id: 'dsp_current' })],
      },
    );

    expect(projection.summary).toMatchObject({
      total: 1,
      by_status: { succeeded: 1 },
      inherited: { total: 2, by_status: { succeeded: 2 } },
    });
  });

  it('keeps a journal-only in-flight dispatch current while running, unknown after terminal', () => {
    const records = [
      journalRecord({
        dispatch_id: 'dsp_flying',
        status: 'unknown',
        phase: 'dispatched',
        dispatched_at: '2026-11-15T00:00:05.000Z',
      }),
    ];

    const running = projectDispatchFacts([], { running: true, journal_records: records });
    expect(running.progress?.current).toMatchObject({
      dispatch_id: 'dsp_flying',
      state: 'started',
    });
    expect(running.summary?.by_status).toEqual({ unknown: 1 });

    const terminal = projectDispatchFacts([], { running: false, journal_records: records });
    expect(terminal.progress?.current).toBeUndefined();
    expect(terminal.summary?.by_status).toEqual({ unknown: 1 });

    // accepted-only 记录同样保持「在飞 accepted」，不会被补投影折成已结束的 not_executed。
    const acceptedOnly = [
      journalRecord({ dispatch_id: 'dsp_queued', status: 'not_executed', phase: 'accepted' }),
    ];
    const queued = projectDispatchFacts([], { running: true, journal_records: acceptedOnly });
    expect(queued.progress?.current).toMatchObject({ dispatch_id: 'dsp_queued', state: 'accepted' });
    expect(queued.summary?.by_status).toEqual({ not_executed: 1 });
  });
});
