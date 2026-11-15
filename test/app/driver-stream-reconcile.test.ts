/**
 * driver-stream 重放与对账脚本的取数与渲染测试。
 *
 * 守四件事：干净 run 对账通过；投影丢失点按序号指出；类型漂移被指认；缺数据时
 * 如实写进 missing 而不是报错——「没有数据」不能被读成「对账通过」。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileDriverStreamAuditWriter } from '../../src/app/driver-stream-audit-writer';
import { projectDriverStreamLifecycleEvent } from '../../src/app/driver-stream-projection';
import { ROLE_DISPATCH_EVENT } from '../../src/app/run-dispatch-events';
import type { DriverStreamEvent } from '../../src/driver/contract';
import {
  buildExecutionBrief,
  buildExecutionEvidence,
  hashExecutionBrief,
  hashExecutionEvidence,
} from '../../src/driver';
import { RunDispatchJournal } from '../../src/persistence';
import {
  parseDriverStreamCliArgs,
  reconcileDriverStreamRun,
  replayDriverStream,
  renderDriverStreamReconcile,
} from '../../scripts/driver-stream-reconcile';

const JOURNAL_IDENTITY = { run_id: 'run_1', task_id: 'task_1', role_id: 'role_1' };

function streamEvent(sequence: number, update: Record<string, unknown>): DriverStreamEvent {
  return {
    schema_version: 'driver-event.v1',
    event_type: String(update.sessionUpdate),
    task_id: 'task_1',
    run_id: 'run_1',
    session_id: 'session_1',
    sequence,
    created_at: '2026-01-01T00:00:00.000Z',
    payload: { sessionId: 'session_1', update },
  };
}

function timelineEntry(
  event: DriverStreamEvent,
  index: number,
  streamSequence?: number,
): Record<string, unknown> {
  const projected = projectDriverStreamLifecycleEvent(event, streamSequence)!;
  return {
    event_id: `run_event_${index}`,
    sequence: index,
    run_id: 'run_1',
    task_id: 'task_1',
    type: projected.event_type,
    source: 'driver',
    created_at: projected.created_at,
    payload: projected.payload,
    schema_version: 'v0',
  };
}

describe('driver-stream-reconcile', () => {
  let runsRoot: string;
  let runDir: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(os.tmpdir(), 'driver-stream-reconcile-'));
    runDir = path.join(runsRoot, 'run_1');
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  const events = [
    streamEvent(1, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    }),
    streamEvent(2, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc_1',
      title: 'Edit',
      kind: 'edit',
    }),
    streamEvent(3, { sessionUpdate: 'tool_call_update', toolCallId: 'tc_1', status: 'completed' }),
  ];

  async function writeAudit(): Promise<void> {
    const writer = new FileDriverStreamAuditWriter(runsRoot);
    for (const event of events) await writer.append('run_1', 'task_1', event);
  }

  async function writeTimeline(entries: Array<Record<string, unknown>>): Promise<void> {
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'timeline.json'), JSON.stringify(entries), 'utf8');
  }

  /** 用真实 Journal 写 N 个已 settled 的派工（阶段 4 的三方对账对象）。 */
  async function writeDispatchJournal(dispatchIds: readonly string[]): Promise<void> {
    const journal = await RunDispatchJournal.open({ runDir, identity: JOURNAL_IDENTITY });
    for (const [index, dispatchId] of dispatchIds.entries()) {
      const acceptedAt = `2026-01-01T00:00:0${index}.000Z`;
      const brief = buildExecutionBrief({
        identity: {
          dispatch_id: dispatchId,
          run_id: JOURNAL_IDENTITY.run_id,
          task_id: JOURNAL_IDENTITY.task_id,
          role_id: JOURNAL_IDENTITY.role_id,
          sequence: index + 1,
          accepted_at: acceptedAt,
        },
        request: { kind: 'execute', instruction: `do ${dispatchId}` },
      }).brief;
      await journal.appendAccepted({
        brief,
        brief_sha256: hashExecutionBrief(brief),
        budget_before: {
          dispatches_left: 10,
          role_tokens_left: 100_000,
          deadline_at: '2026-01-01T01:00:00.000Z',
        },
      });
      await journal.appendDispatched({ dispatch_id: dispatchId });
      const evidence = buildExecutionEvidence({
        dispatch_id: dispatchId,
        observation: {
          transport: { evidence: 'execution_unconfirmed' },
          result: { status: 'succeeded', response: 'done' },
        },
      });
      const ref = await journal.appendEvidence({ dispatch_id: dispatchId, evidence });
      expect(ref.sha256).toBe(hashExecutionEvidence(evidence));
      await journal.appendSettled({
        dispatch_id: dispatchId,
        status: 'succeeded',
        evidence,
        evidence_sha256: ref.sha256,
        violations: [],
      });
    }
    await journal.close();
  }

  /**
   * 一条「settled unknown → 真实迟到回执对账 succeeded」的 Journal（R4-02 的三方对账对象）。
   * 原始 settled 行保持 unknown；reconciled 是后续追加的可信收束事实。
   */
  async function writeReconciledDispatchJournal(): Promise<void> {
    const journal = await RunDispatchJournal.open({ runDir, identity: JOURNAL_IDENTITY });
    const brief = buildExecutionBrief({
      identity: {
        dispatch_id: 'dsp_late',
        run_id: JOURNAL_IDENTITY.run_id,
        task_id: JOURNAL_IDENTITY.task_id,
        role_id: JOURNAL_IDENTITY.role_id,
        sequence: 1,
        accepted_at: '2026-01-01T00:00:00.000Z',
      },
      request: { kind: 'execute', instruction: 'do dsp_late' },
    }).brief;
    await journal.appendAccepted({
      brief,
      brief_sha256: hashExecutionBrief(brief),
      budget_before: {
        dispatches_left: 10,
        role_tokens_left: 100_000,
        deadline_at: '2026-01-01T01:00:00.000Z',
      },
    });
    await journal.appendDispatched({ dispatch_id: 'dsp_late' });
    const unknownEvidence = buildExecutionEvidence({
      dispatch_id: 'dsp_late',
      observation: { transport: { evidence: 'execution_unconfirmed' } },
    });
    const unknownSidecar = await journal.appendEvidence({
      dispatch_id: 'dsp_late',
      evidence: unknownEvidence,
    });
    await journal.appendSettled({
      dispatch_id: 'dsp_late',
      status: 'unknown',
      evidence: unknownEvidence,
      evidence_sha256: unknownSidecar.sha256,
      violations: [],
    });
    const reconciledEvidence = buildExecutionEvidence({
      dispatch_id: 'dsp_late',
      observation: {
        transport: { evidence: 'execution_unconfirmed' },
        result: { status: 'succeeded', response: 'late ok' },
      },
    });
    await journal.appendReconciled({
      dispatch_id: 'dsp_late',
      status: 'succeeded',
      reason: 'late driver result reconciled after timeout/cancel (no replay)',
      evidence: reconciledEvidence,
      evidence_sha256: hashExecutionEvidence(reconciledEvidence),
    });
    await journal.close();
  }

  async function writeSummary(dispatchSummary: Record<string, unknown>): Promise<void> {
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, 'summary.json'),
      JSON.stringify({ run_id: 'run_1', dispatch_summary: dispatchSummary }),
      'utf8',
    );
  }

  /** timeline 里的派工生命周期事件（accepted/started/settled），带 dispatch_id 身份。 */
  function dispatchTimeline(dispatchIds: readonly string[]): Array<Record<string, unknown>> {
    const base = {
      run_id: 'run_1',
      task_id: 'task_1',
      source: 'agent',
      schema_version: 'v0',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    return dispatchIds.flatMap((dispatchId, index) => [
      {
        ...base,
        event_id: `evt_accepted_${dispatchId}`,
        sequence: 100 + index * 3 + 1,
        type: ROLE_DISPATCH_EVENT.accepted,
        payload: { dispatch_id: dispatchId, kind: 'execute' },
      },
      {
        ...base,
        event_id: `evt_started_${dispatchId}`,
        sequence: 100 + index * 3 + 2,
        type: ROLE_DISPATCH_EVENT.started,
        payload: { dispatch_id: dispatchId, kind: 'execute' },
      },
      {
        ...base,
        event_id: `evt_settled_${dispatchId}`,
        sequence: 100 + index * 3 + 3,
        type: ROLE_DISPATCH_EVENT.settled,
        payload: { dispatch_id: dispatchId, kind: 'execute', status: 'succeeded', violations: [] },
      },
    ]);
  }

  function summaryFacts(ids: readonly string[], total = ids.length): Record<string, unknown> {
    return {
      total,
      by_status: { succeeded: total },
      last_dispatch: {
        dispatch_id: ids.at(-1) ?? 'dsp_1',
        status: 'succeeded',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      unknown: { count: 0, dispatch_ids: [] },
      violations: { count: 0, kinds: [] },
    };
  }

  it('passes for a run whose timeline kept every streamed event', async () => {
    await writeAudit();
    await writeTimeline(events.map((event, index) => timelineEntry(event, index + 1)));

    const result = await reconcileDriverStreamRun(runsRoot, 'run_1');
    expect(result).toMatchObject({
      // 该 run 没有 Journal / dispatch_summary：派工三方对账没得对，如实进 missing。
      missing: ['journal', 'summary'],
      truncated: false,
      audit_events: 3,
      timeline_driver_events: 3,
      missing_in_timeline: [],
      unexpected_in_timeline: [],
      type_mismatches: [],
      ok: true,
    });
  });

  it('names the exact sequences a projection dropped', async () => {
    await writeAudit();
    // 中间那条 tool_call 在 timeline 里缺席。
    await writeTimeline([
      timelineEntry(events[0], 1),
      timelineEntry(events[2], 2),
    ]);

    const result = await reconcileDriverStreamRun(runsRoot, 'run_1');
    expect(result.missing_in_timeline).toEqual([2]);
    expect(result.ok).toBe(false);
  });

  it('points at type drift between the stream and the stored timeline', async () => {
    await writeAudit();
    const drifted = timelineEntry(events[1], 2);
    drifted.type = 'driver.tool_completed';
    await writeTimeline([timelineEntry(events[0], 1), drifted, timelineEntry(events[2], 3)]);

    const result = await reconcileDriverStreamRun(runsRoot, 'run_1');
    expect(result.type_mismatches).toEqual([
      { sequence: 2, replayed: 'driver.tool_started', timeline: 'driver.tool_completed' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('replays every stream event in envelope order', async () => {
    await writeAudit();
    const replay = await replayDriverStream(runsRoot, 'run_1');

    expect(replay.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(replay.events.map((event) => event.event_type)).toEqual([
      'driver.agent_message_chunk',
      'driver.tool_started',
      'driver.tool_completed',
    ]);
    expect(replay.audit_events).toBe(3);
  });

  it('degrades without error when either side is missing', async () => {
    const empty = await reconcileDriverStreamRun(runsRoot, 'run_1');
    expect(empty.missing).toEqual(['driver-stream', 'journal', 'summary', 'timeline']);
    expect(empty.ok).toBe(true);
    // 缺数据时不做派工差集：没有来源就不比较，也不编造 id。
    expect(empty.dispatch.missing_in_timeline).toEqual([]);
    expect(empty.dispatch.unexpected_in_timeline).toEqual([]);

    await writeAudit();
    const noTimeline = await reconcileDriverStreamRun(runsRoot, 'run_1');
    expect(noTimeline.missing).toEqual(['journal', 'summary', 'timeline']);
    expect(noTimeline.timeline_driver_events).toBe(0);
  });

  it('reports truncation as context for any diff', async () => {
    const writer = new FileDriverStreamAuditWriter(runsRoot, 260);
    for (const event of events) await writer.append('run_1', 'task_1', event);

    const replay = await replayDriverStream(runsRoot, 'run_1');
    expect(replay.truncated).toBe(true);
  });

  it('does not read invoke-colliding legacy sequences as diffs', async () => {
    // 两次 invoke 各自从 sequence=1 重置、类型组成不同：老配对会把后一次覆盖前
    // 一次、报出成片假「类型不一致」。退化键下按同键类型多重集配对，不算差异。
    const colliding = [
      streamEvent(1, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }),
      streamEvent(2, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_1',
        title: 'Edit',
        kind: 'edit',
      }),
      streamEvent(1, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 't' } }),
      streamEvent(3, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_1',
        status: 'completed',
      }),
    ];
    const writer = new FileDriverStreamAuditWriter(runsRoot);
    for (const event of colliding) await writer.append('run_1', 'task_1', event);
    await writeTimeline(colliding.map((event, index) => timelineEntry(event, index + 1)));

    const result = await reconcileDriverStreamRun(runsRoot, 'run_1');
    expect(result.key).toBe('sequence');
    expect(result.type_mismatches).toEqual([]);
    expect(result.missing_in_timeline).toEqual([]);
    expect(result.unexpected_in_timeline).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('pairs precisely by stream_sequence when both sides carry it', async () => {
    const colliding = [
      streamEvent(1, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }),
      streamEvent(2, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_1',
        title: 'Edit',
        kind: 'edit',
      }),
      streamEvent(1, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 't' } }),
    ];
    const writer = new FileDriverStreamAuditWriter(runsRoot);
    for (const [index, event] of colliding.entries()) {
      await writer.append('run_1', 'task_1', event, index + 1);
    }
    // timeline 少了 stream_sequence=3 那条：唯一键下丢失点精确到序号。
    await writeTimeline([
      timelineEntry(colliding[0], 1, 1),
      timelineEntry(colliding[1], 2, 2),
    ]);

    const result = await reconcileDriverStreamRun(runsRoot, 'run_1');
    expect(result.key).toBe('stream_sequence');
    expect(result.missing_in_timeline).toEqual([3]);
    expect(result.ok).toBe(false);
  });

  it('reconciles dispatch identity and counts across timeline, summary, and journal', async () => {
    await writeDispatchJournal(['dsp_1', 'dsp_2']);
    await writeSummary(summaryFacts(['dsp_1', 'dsp_2']));
    await writeTimeline(dispatchTimeline(['dsp_1', 'dsp_2']));

    const result = await reconcileDriverStreamRun(runsRoot, 'run_1');

    expect(result.dispatch).toMatchObject({
      journal: {
        total: 2,
        by_status: { succeeded: 2 },
        dispatch_ids: ['dsp_1', 'dsp_2'],
        settled_ids: ['dsp_1', 'dsp_2'],
      },
      // summary 只显式列出 last_dispatch 与 unknown ids，身份比较只用这组 known ids。
      summary: { total: 2, by_status: { succeeded: 2 }, known_ids: ['dsp_2'] },
      missing_in_timeline: [],
      unexpected_in_timeline: [],
      summary_ids_missing_in_timeline: [],
      summary_ids_not_in_journal: [],
      count_mismatches: [],
      ok: true,
    });
    expect(result.dispatch.timeline).toEqual({
      dispatch_ids: ['dsp_1', 'dsp_2'],
      settled_ids: ['dsp_1', 'dsp_2'],
    });
    expect(renderDriverStreamReconcile([result])).toContain('派工身份/计数一致');
  });

  it('R4-02: counts a reconciled unknown by its effective status across journal, summary and timeline', async () => {
    await writeReconciledDispatchJournal();
    await writeSummary({
      total: 1,
      by_status: { succeeded: 1 },
      last_dispatch: {
        dispatch_id: 'dsp_late',
        kind: 'execute',
        status: 'succeeded',
        updated_at: '2026-01-01T00:00:10.000Z',
      },
    });
    await writeTimeline([
      {
        event_id: 'evt_late_accepted',
        sequence: 101,
        run_id: 'run_1',
        task_id: 'task_1',
        type: ROLE_DISPATCH_EVENT.accepted,
        source: 'agent',
        created_at: '2026-01-01T00:00:00.000Z',
        payload: { dispatch_id: 'dsp_late', kind: 'execute' },
        schema_version: 'v0',
      },
      {
        event_id: 'evt_late_started',
        sequence: 102,
        run_id: 'run_1',
        task_id: 'task_1',
        type: ROLE_DISPATCH_EVENT.started,
        source: 'agent',
        created_at: '2026-01-01T00:00:01.000Z',
        payload: { dispatch_id: 'dsp_late', kind: 'execute' },
        schema_version: 'v0',
      },
      {
        event_id: 'evt_late_settled',
        sequence: 103,
        run_id: 'run_1',
        task_id: 'task_1',
        type: ROLE_DISPATCH_EVENT.settled,
        source: 'agent',
        created_at: '2026-01-01T00:00:05.000Z',
        payload: { dispatch_id: 'dsp_late', kind: 'execute', status: 'unknown', violations: [] },
        schema_version: 'v0',
      },
      {
        event_id: 'evt_late_reconciled',
        sequence: 104,
        run_id: 'run_1',
        task_id: 'task_1',
        type: ROLE_DISPATCH_EVENT.reconciled,
        source: 'agent',
        created_at: '2026-01-01T00:00:09.000Z',
        payload: { dispatch_id: 'dsp_late', status: 'succeeded', source: 'late_result' },
        schema_version: 'v0',
      },
    ]);

    const result = await reconcileDriverStreamRun(runsRoot, 'run_1');

    // Journal 原始 settled 行仍是 unknown，但报告摘要按有效状态计数，三方对账通过。
    expect(result.dispatch).toMatchObject({
      journal: {
        total: 1,
        by_status: { succeeded: 1 },
        dispatch_ids: ['dsp_late'],
        settled_ids: ['dsp_late'],
      },
      summary: { total: 1, by_status: { succeeded: 1 }, known_ids: ['dsp_late'] },
      count_mismatches: [],
      ok: true,
    });
  });

  it('names the dispatch ids that timeline dropped and the counts that disagree', async () => {
    await writeDispatchJournal(['dsp_1', 'dsp_2']);
    await writeSummary(summaryFacts(['dsp_1', 'dsp_2']));
    // timeline 少了 dsp_2 的三条生命周期事件。
    await writeTimeline(dispatchTimeline(['dsp_1']));

    const result = await reconcileDriverStreamRun(runsRoot, 'run_1');

    expect(result.dispatch.missing_in_timeline).toEqual(['dsp_2']);
    expect(result.dispatch.summary_ids_missing_in_timeline).toEqual(['dsp_2']);
    expect(result.dispatch.count_mismatches).toEqual([
      { metric: 'timeline.dispatch_ids', expected: 2, actual: 1 },
    ]);
    expect(result.dispatch.ok).toBe(false);

    const rendered = renderDriverStreamReconcile([result]);
    expect(rendered).toContain('Journal 已 settled 但 timeline 缺席: dsp_2');
    expect(rendered).toContain('summary 列出但 timeline 无事件: dsp_2');
  });

  it('reports summary-vs-journal count disagreement instead of trusting either side', async () => {
    await writeDispatchJournal(['dsp_1', 'dsp_2']);
    // summary 声称 3 个派工，Journal 折叠只有 2 个：计数差如实上报。
    await writeSummary(summaryFacts(['dsp_1', 'dsp_2'], 3));
    await writeTimeline(dispatchTimeline(['dsp_1', 'dsp_2']));

    const result = await reconcileDriverStreamRun(runsRoot, 'run_1');

    expect(result.dispatch.count_mismatches).toEqual([
      { metric: 'total', expected: 2, actual: 3 },
      { metric: 'by_status.succeeded', expected: 2, actual: 3 },
    ]);
    expect(result.dispatch.ok).toBe(false);
    expect(renderDriverStreamReconcile([result])).toContain('计数不一致 total: 2 != 3');
  });

  it('treats a corrupt journal as an unavailable dispatch source in missing', async () => {
    await writeAudit();
    await writeTimeline(events.map((event, index) => timelineEntry(event, index + 1)));
    await mkdir(path.join(runDir, 'journal'), { recursive: true });
    await writeFile(path.join(runDir, 'journal', 'dispatches.jsonl'), '{"broken":', 'utf8');

    const result = await reconcileDriverStreamRun(runsRoot, 'run_1');

    expect(result.missing).toContain('journal');
    expect(result.dispatch).not.toHaveProperty('journal');
    // 损坏 Journal 不参与比较：不把「读不出」算成「没有差异」之外的差异。
    expect(result.dispatch.missing_in_timeline).toEqual([]);
  });

  it('parses cli args and demands an explicit scope', () => {
    expect(parseDriverStreamCliArgs(['--all'], {})).toMatchObject({ all: true, replay: false });
    expect(parseDriverStreamCliArgs(['--run', 'run_1', '--replay'], {})).toMatchObject({
      runId: 'run_1',
      replay: true,
    });
    expect(() => parseDriverStreamCliArgs([], {})).toThrow(/需要 --run/);
  });

  it('renders a human-readable diff line per discrepancy', async () => {
    await writeAudit();
    await writeTimeline([timelineEntry(events[0], 1)]);

    const rendered = renderDriverStreamReconcile([await reconcileDriverStreamRun(runsRoot, 'run_1')]);
    expect(rendered).toContain('DIFF');
    expect(rendered).toContain('丢失于 timeline');
  });
});
