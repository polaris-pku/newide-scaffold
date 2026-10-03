import { describe, expect, it } from 'vitest';
import { alignTimelineSequences, withAlignedTimeline } from '../../src/app/run-timeline-sequence';
import type { RunEvent } from '../../src/protocol/run-event';
import type { RunSnapshot } from '../../src/protocol/run-snapshot';

function event(eventId: string, sequence: number, type = 'handler.started'): RunEvent {
  return {
    event_id: eventId,
    sequence,
    run_id: 'run_1',
    task_id: 'task_1',
    type,
    source: 'coordinator',
    created_at: '2026-10-03T00:00:00.000Z',
    payload: {},
    schema_version: 'v0',
  };
}

function snapshotWith(timeline: RunEvent[]): RunSnapshot {
  return {
    schema_version: 'v0',
    run_id: 'run_1',
    task_id: 'task_1',
    mode: 'single_agent',
    status: 'running',
    current: { stage: 'executing', active_node_code: 'N3' },
    timeline,
    agent_runs: [],
    artifacts: [],
    gates: [],
    errors: [],
  } as RunSnapshot;
}

describe('alignTimelineSequences', () => {
  it('adopts the push-channel sequence for events both channels hold', () => {
    // 持久快照的 timeline 带的是 SQLite 行号（101、107…），推流通道是另一套号。
    // 同一个 event_id 在两条通道上必须给同一个数，否则前端跨通道排序会错。
    const persisted = [event('e1', 101), event('e2', 107)];
    const live = [event('e1', 3), event('e2', 9)];

    expect(alignTimelineSequences(persisted, live).map((item) => item.sequence)).toEqual([3, 9]);
  });

  it('lets a snapshot-only event borrow a position without displacing live events', () => {
    // 快照独有的事件（registry 不持有的 task.created 之类）借前一个号同位，
    // 绝不占新号——否则它会把紧随其后的 live 事件顶掉，破坏「两通道同号」。
    const persisted = [event('e1', 101, 'task.created'), event('e_live', 107)];
    const live = [event('e_live', 2)];

    const aligned = alignTimelineSequences(persisted, live);
    expect(aligned.map((item) => item.sequence)).toEqual([2, 2]);
    expect(aligned.map((item) => item.event_id)).toEqual(['e1', 'e_live']);
  });

  it('never displaces a live event even when a snapshot-only row carries a huge id', () => {
    // 这是定下「同位而非 +1」的原因：生产 run 开头的 task.created 带的是全局
    // AUTOINCREMENT 大号，若给它 previous + 1，后面几乎每个 live 事件都会被顶掉，
    // 等于把「两通道同号」彻底破坏。
    const persisted = [event('e1', 5), event('e_only', 9000, 'run.created'), event('e2', 6)];
    const live = [event('e1', 1), event('e2', 2)];

    const aligned = alignTimelineSequences(persisted, live);
    expect(aligned.map((item) => item.sequence)).toEqual([1, 1, 2]);
    // 不变量 1：两条通道都持有的事件号必须相同。
    expect(aligned.find((item) => item.event_id === 'e2')?.sequence).toBe(2);
  });

  it('keeps values non-decreasing with the array order authoritative', () => {
    const persisted = [event('a', 4), event('only', 5), event('b', 6)];
    const live = [event('a', 10), event('b', 11)];

    const sequences = alignTimelineSequences(persisted, live).map((item) => item.sequence);
    expect(sequences).toEqual([10, 10, 11]);
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]!).toBeGreaterThanOrEqual(sequences[index - 1]!);
    }
  });

  it('leaves the timeline untouched when there is no live observation', () => {
    const persisted = [event('e1', 101)];
    expect(alignTimelineSequences(persisted, [])).toEqual(persisted);
    expect(alignTimelineSequences([], [event('e1', 1)])).toEqual([]);
  });

  it('returns the same snapshot object when nothing needs rewriting', () => {
    // 没变化就别造新对象：调用方（RPC）每次拉快照都会走这里。
    const shared = event('e1', 1);
    const snapshot = snapshotWith([shared]);
    expect(withAlignedTimeline(snapshot, [event('e1', 1)])).toBe(snapshot);
  });

  it('returns a rewritten snapshot only when a sequence actually changes', () => {
    const snapshot = snapshotWith([event('e1', 101)]);
    const aligned = withAlignedTimeline(snapshot, [event('e1', 1)]);

    expect(aligned).not.toBe(snapshot);
    expect(aligned.timeline.map((item) => item.sequence)).toEqual([1]);
    // 其余字段原样保留。
    expect(aligned.run_id).toBe('run_1');
    expect(aligned.current).toEqual(snapshot.current);
  });
});
