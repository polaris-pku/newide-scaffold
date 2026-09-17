/**
 * RunLatencyRecorder 的计时与副作用边界测试。
 *
 * 守三件事：耗时口径（单调钟 / 墙钟回退）、失败也要落 span、观测出错不能影响
 * 被测调用。span 词汇表的不变式另见 run-latency-spans.test.ts。
 */

import { describe, expect, it } from 'vitest';
import {
  NoopRunLatencyTraceSink,
  RunLatencyRecorder,
  agentToolSpan,
  appendRunLatencySpan,
  driverMilestoneSpan,
  type RunLatencySpan,
  type RunLatencyTraceSink,
} from '../../src/telemetry';

class CollectingSink implements RunLatencyTraceSink {
  readonly spans: RunLatencySpan[] = [];

  append(span: RunLatencySpan): void {
    this.spans.push(span);
  }
}

/** 用给定序列构造单调钟与墙钟，便于断言精确耗时。 */
function createRecorder(
  sink: RunLatencyTraceSink,
  ticks: number[] = [],
  wallClock: string[] = [],
): RunLatencyRecorder {
  let tickIndex = 0;
  let wallIndex = 0;
  return new RunLatencyRecorder({
    run_id: 'run_latency',
    task_id: 'task_latency',
    sink,
    monotonicNow: () => {
      const value = ticks[Math.min(tickIndex, ticks.length - 1)] ?? 0;
      tickIndex += 1;
      return value;
    },
    now: () => wallClock[Math.min(wallIndex++, wallClock.length - 1)] ?? '2026-09-17T00:00:00.000Z',
  });
}

const sampleSpan: RunLatencySpan = {
  run_id: 'run_sample',
  name: 'stage.gate',
  layer: 'stage',
  started_at: '2026-09-17T00:00:00.000Z',
  completed_at: '2026-09-17T00:00:00.100Z',
  duration_ms: 100,
  duration_source: 'monotonic',
  ok: true,
};

describe('RunLatencyRecorder 计时', () => {
  it('records monotonic duration, wall clock bounds and identity', async () => {
    const sink = new CollectingSink();
    const recorder = createRecorder(
      sink,
      [100, 145.5],
      ['2026-09-17T00:00:00.000Z', '2026-09-17T00:00:01.000Z'],
    );

    await expect(recorder.span('facade.retrieve_memory', {}, async () => 'ok')).resolves.toBe('ok');

    expect(sink.spans[0]).toMatchObject({
      run_id: 'run_latency',
      task_id: 'task_latency',
      name: 'facade.retrieve_memory',
      layer: 'facade',
      started_at: '2026-09-17T00:00:00.000Z',
      completed_at: '2026-09-17T00:00:01.000Z',
      duration_ms: 45.5,
      duration_source: 'monotonic',
      ok: true,
    });
    expect(recorder.spanCount).toBe(1);
  });

  it('carries role, attempt, round and derived meta onto the span', async () => {
    const sink = new CollectingSink();
    const recorder = createRecorder(sink, [0, 10], ['a', 'b']);

    await recorder.span(
      agentToolSpan('query_memory'),
      {
        role_id: 'role_ts_engineer',
        attempt: 2,
        round: 3,
        meta: { tool: 'query_memory' },
        metaFrom: (value: { hit_count: number }) => ({ hit_count: value.hit_count }),
      },
      async () => ({ hit_count: 0 }),
    );

    expect(sink.spans[0]).toMatchObject({
      name: 'agent.tool.query_memory',
      layer: 'agent',
      role_id: 'role_ts_engineer',
      attempt: 2,
      round: 3,
      meta: { tool: 'query_memory', hit_count: 0 },
    });
  });

  it('records failed spans and rethrows the original error', async () => {
    const sink = new CollectingSink();
    const recorder = createRecorder(sink, [0, 8], ['a', 'b']);
    const failure = new Error('driver transport failed');

    await expect(
      recorder.span('driver.invoke', {}, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(sink.spans[0]).toMatchObject({
      name: 'driver.invoke',
      ok: false,
      duration_ms: 8,
      error: 'driver transport failed',
    });
  });

  it('falls back to wall clock when the monotonic clock goes backwards', async () => {
    const sink = new CollectingSink();
    const recorder = createRecorder(
      sink,
      [500, 400],
      ['2026-09-17T00:00:00.000Z', '2026-09-17T00:00:02.500Z'],
    );

    await recorder.span('facade.retrieve_memory', {}, async () => undefined);

    expect(sink.spans[0]).toMatchObject({ duration_source: 'wall_clock', duration_ms: 2500 });
  });

  it('records externally measured driver milestones through record()', () => {
    const sink = new CollectingSink();
    const recorder = createRecorder(sink);

    recorder.record(driverMilestoneSpan('driver.first_output'), {
      started_at: '2026-09-17T00:00:00.000Z',
      completed_at: '2026-09-17T00:00:00.250Z',
      duration_ms: 250,
      meta: { prompt_bytes: 1918 },
    });

    expect(sink.spans[0]).toMatchObject({
      name: 'driver.first_output',
      layer: 'driver',
      duration_source: 'monotonic',
      ok: true,
      duration_ms: 250,
      meta: { prompt_bytes: 1918 },
    });
  });
});

describe('观测出错不能影响被测调用', () => {
  it('ignores a throwing metaFrom', async () => {
    const sink = new CollectingSink();
    const recorder = createRecorder(sink, [0, 1], ['a', 'b']);

    const value = await recorder.span(
      'facade.retrieve_memory',
      {
        metaFrom: () => {
          throw new Error('meta exploded');
        },
      },
      async () => 'still returned',
    );

    expect(value).toBe('still returned');
    expect(sink.spans[0]?.meta).toBeUndefined();
    expect(sink.spans[0]?.ok).toBe(true);
  });

  it('swallows sink failures through the shared append helper', async () => {
    const throwing: RunLatencyTraceSink = {
      append: () => {
        throw new Error('disk full');
      },
    };
    const recorder = new RunLatencyRecorder({ run_id: 'run_x', sink: throwing });

    await expect(recorder.span('facade.run_total', {}, async () => 'survived')).resolves.toBe(
      'survived',
    );
    expect(recorder.spanCount).toBe(1);

    expect(() => appendRunLatencySpan(throwing, sampleSpan)).not.toThrow();
    const collecting = new CollectingSink();
    appendRunLatencySpan(collecting, sampleSpan);
    expect(collecting.spans).toHaveLength(1);
    expect(new NoopRunLatencyTraceSink().append(sampleSpan)).toBeUndefined();
  });
});
