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
import type { DriverStreamEvent } from '../../src/driver/contract';
import {
  parseDriverStreamCliArgs,
  reconcileDriverStreamRun,
  replayDriverStream,
  renderDriverStreamReconcile,
} from '../../scripts/driver-stream-reconcile';

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

  it('passes for a run whose timeline kept every streamed event', async () => {
    await writeAudit();
    await writeTimeline(events.map((event, index) => timelineEntry(event, index + 1)));

    const result = await reconcileDriverStreamRun(runsRoot, 'run_1');
    expect(result).toMatchObject({
      missing: [],
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
    expect(empty.missing).toEqual(['driver-stream', 'timeline']);
    expect(empty.ok).toBe(true);

    await writeAudit();
    const noTimeline = await reconcileDriverStreamRun(runsRoot, 'run_1');
    expect(noTimeline.missing).toEqual(['timeline']);
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
