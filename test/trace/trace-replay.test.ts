import { describe, expect, it } from 'vitest';
import {
  buildSpanTree,
  mergeSpans,
  renderTrajectory,
  replayTrajectory,
  type TrajectoryTreeNode,
} from '../../src/trace/replay';
import type { TrajectorySpanRecord } from '../../src/trace/types';

const T = '2026-07-11T08:00:00.000Z';

function record(
  spanId: string,
  phase: TrajectorySpanRecord['phase'],
  kind: TrajectorySpanRecord['kind'],
  sequence: number,
  extra: Partial<TrajectorySpanRecord> = {},
): TrajectorySpanRecord {
  return {
    span_id: spanId,
    kind,
    phase,
    sequence,
    created_at: T,
    schema_version: 'v0',
    ...extra,
  };
}

function buildParallelFixture(): TrajectorySpanRecord[] {
  return [
    record('run_A', 'start', 'run', 1),
    record('task_A', 'start', 'task.run', 2, { parent_span_id: 'run_A' }),
    record('dA', 'start', 'driver.run', 3, { parent_span_id: 'task_A', agent_id: 'agent_a' }),
    record('dB', 'start', 'driver.run', 4, { parent_span_id: 'task_A', agent_id: 'agent_b' }),
    record('dA', 'end', 'driver.run', 5, { status: 'ok', duration_ms: 12 }),
    record('dB', 'end', 'driver.run', 6, { status: 'ok', duration_ms: 14 }),
    record('dC', 'start', 'driver.run', 7, { parent_span_id: 'task_A', agent_id: 'agent_c' }),
    record('dC', 'end', 'driver.run', 8, { status: 'error', duration_ms: 3 }),
    record('chk_1', 'point', 'checkpoint', 9, { summary: 'manual' }),
    record('task_A', 'end', 'task.run', 10, { status: 'ok' }),
    record('run_A', 'end', 'run', 11, { status: 'ok' }),
  ];
}

describe('mergeSpans', () => {
  it('merges start/end pairs into spans and keeps points', () => {
    const spans = mergeSpans(buildParallelFixture());
    expect(spans).toHaveLength(6);
    expect(spans.map((span) => span.phase)).toEqual([
      'span',
      'span',
      'span',
      'span',
      'span',
      'point',
    ]);
    const driverA = spans.find((span) => span.span_id === 'dA')!;
    expect(driverA.status).toBe('ok');
    expect(driverA.duration_ms).toBe(12);
    expect(driverA.agent_id).toBe('agent_a');
  });

  it('keeps orphan start records as open spans', () => {
    const spans = mergeSpans([record('orphan', 'start', 'driver.run', 1)]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.phase).toBe('span');
    expect(spans[0]!.status).toBeUndefined();
  });
});

describe('buildSpanTree', () => {
  it('rebuilds hierarchy and flags interleaved siblings as parallel', () => {
    const tree = buildSpanTree(mergeSpans(buildParallelFixture()));
    expect(tree).toHaveLength(1);
    const run = tree[0]!;
    expect(run.span.span_id).toBe('run_A');
    expect(run.parallel).toBe(false);

    const task = run.children[0]!;
    expect(task.span.span_id).toBe('task_A');

    const drivers = task.children;
    expect(drivers.map((node) => node.span.span_id)).toEqual(['dA', 'dB', 'dC', 'chk_1']);
    expect(drivers.map((node: TrajectoryTreeNode) => node.parallel)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    // The parentless checkpoint point stays inside the enclosing task.run span.
    expect(drivers[3]!.span.phase).toBe('point');
  });
});

describe('renderTrajectory', () => {
  it('renders an indented waterfall with parallel markers', () => {
    const tree = buildSpanTree(mergeSpans(buildParallelFixture()));
    const rendered = renderTrajectory(tree);
    expect(rendered).toContain('› run');
    expect(rendered).toContain('  › task.run');
    expect(rendered).toContain('    › driver.run [agent_a] ok 12ms');
    expect(rendered).toContain('    ∥ driver.run [agent_b] ok 14ms');
    expect(rendered).toContain('    › driver.run [agent_c] error 3ms');
    expect(rendered).toContain('• checkpoint  manual');
  });
});

describe('replayTrajectory', () => {
  it('returns records, merged spans, tree, and rendered text', () => {
    const records = buildParallelFixture();
    const replay = replayTrajectory(records, 'run_1');
    expect(replay.run_id).toBe('run_1');
    expect(replay.records).toHaveLength(11);
    expect(replay.spans).toHaveLength(6);
    expect(replay.tree).toHaveLength(1);
    expect(replay.rendered).toContain('∥ driver.run');
  });
});
