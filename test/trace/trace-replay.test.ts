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

  it('merges start input and end output payloads into one span', () => {
    const records = [
      record('tool_1', 'start', 'agent.tool', 1, {
        payload: { input: { args: '{"q":"x"}' } },
      }),
      record('tool_1', 'end', 'agent.tool', 2, {
        status: 'ok',
        payload: { output: { results: 3 } },
      }),
    ];
    const spans = mergeSpans(records);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.payload).toEqual({ input: { args: '{"q":"x"}' }, output: { results: 3 } });
  });

  it('carries payload on point records into merged spans', () => {
    const spans = mergeSpans([
      record('pt_1', 'point', 'checkpoint', 1, { payload: { trigger: 'manual' } }),
    ]);
    expect(spans[0]!.payload).toEqual({ trigger: 'manual' });
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

  it('attaches a parentless lifecycle span (agent.execution) to the enclosing open span', () => {
    const records = [
      record('run_A', 'start', 'run', 1),
      record('agent_1', 'start', 'agent.execution', 2, { agent_id: 'role_a' }),
      record('agent_1', 'end', 'agent.execution', 3, { status: 'ok' }),
      record('run_A', 'end', 'run', 4, { status: 'ok' }),
    ];
    const tree = buildSpanTree(mergeSpans(records));
    expect(tree).toHaveLength(1);
    expect(tree[0]!.span.span_id).toBe('run_A');
    const agent = tree[0]!.children.find((node) => node.span.span_id === 'agent_1');
    expect(agent).toBeDefined();
    expect(agent!.span.kind).toBe('agent.execution');
    expect(agent!.span.status).toBe('ok');
  });

  it('nests a later parentless run span under the still-open task.run span', () => {
    const records = [
      record('task_A', 'start', 'task.run', 1),
      record('run_A', 'start', 'run', 2),
      record('run_A', 'end', 'run', 3, { status: 'ok' }),
      record('task_A', 'end', 'task.run', 4, { status: 'ok' }),
    ];
    const tree = buildSpanTree(mergeSpans(records));
    expect(tree).toHaveLength(1);
    expect(tree[0]!.span.span_id).toBe('task_A');
    expect(tree[0]!.children[0]!.span.span_id).toBe('run_A');
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

  it('renders in/out lines for spans and io lines for points', () => {
    const records = [
      record('tool_1', 'start', 'agent.tool', 1, {
        payload: { input: { tool_call_id: 'call_1', args: '{"q":"x"}' } },
      }),
      record('tool_1', 'end', 'agent.tool', 2, {
        status: 'ok',
        summary: 'invoke_driver → ok',
        payload: { output: { status: 'completed' } },
      }),
      record('pt_1', 'point', 'checkpoint', 3, { summary: 'manual', payload: { trigger: 'manual' } }),
    ];
    const rendered = renderTrajectory(buildSpanTree(mergeSpans(records)));
    expect(rendered).toContain('in: {"tool_call_id":"call_1","args":"{\\"q\\":\\"x\\"}"}');
    expect(rendered).toContain('out: {"status":"completed"}');
    expect(rendered).toContain('io: {"trigger":"manual"}');
  });

  it('does not render io lines without payloads', () => {
    const rendered = renderTrajectory(buildSpanTree(mergeSpans(buildParallelFixture())));
    expect(rendered).not.toContain('in :');
    expect(rendered).not.toContain('out:');
    expect(rendered).not.toContain('io :');
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
