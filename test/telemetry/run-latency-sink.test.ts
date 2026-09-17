/**
 * run-latency 落盘与 AsyncLocalStorage 绑定的测试。
 *
 * 两件事各自守一条纪律：
 * - 文件 sink：一个 run 一个 `latency.jsonl`，每行可解析；写失败只丢 span。
 * - ALS 绑定：深层/并行调用自动归属同一个 run；没有 recorder 时零副作用。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileRunLatencyTraceSink,
  RunLatencyRecorder,
  getRunLatencyRecorder,
  recordRunLatencySpan,
  runWithRunLatencyRecorder,
  withRunLatencySpan,
  type RunLatencySpan,
  type RunLatencyTraceSink,
} from '../../src/telemetry';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'run-latency-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
  run_id: 'run_file',
  name: 'stage.gate',
  layer: 'stage',
  started_at: '2026-09-17T00:00:00.000Z',
  completed_at: '2026-09-17T00:00:00.100Z',
  duration_ms: 100,
  duration_source: 'monotonic',
  ok: true,
};

describe('FileRunLatencyTraceSink', () => {
  it('appends one parseable JSON line per span under the run directory', () => {
    const root = createTemporaryDirectory();
    const sink = new FileRunLatencyTraceSink(root);

    sink.append(sampleSpan);
    sink.append({ ...sampleSpan, name: 'stage.deliver' });

    const lines = readFileSync(path.join(root, 'run_file', 'latency.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ name: 'stage.gate', layer: 'stage' });
    expect(JSON.parse(lines[1]!)).toMatchObject({ name: 'stage.deliver' });
  });

  it('keeps runs in separate files', () => {
    const root = createTemporaryDirectory();
    const sink = new FileRunLatencyTraceSink(root);

    sink.append(sampleSpan);
    sink.append({ ...sampleSpan, run_id: 'run_other' });

    const firstRun = readFileSync(path.join(root, 'run_file', 'latency.jsonl'), 'utf-8').trim();
    const secondRun = readFileSync(path.join(root, 'run_other', 'latency.jsonl'), 'utf-8').trim();
    expect(JSON.parse(firstRun)).toMatchObject({ run_id: 'run_file' });
    expect(JSON.parse(secondRun)).toMatchObject({ run_id: 'run_other' });
  });

  it('never lets a write failure escape into the production run', () => {
    const sink = new FileRunLatencyTraceSink(path.join('\u0000invalid', 'root'));
    expect(() => sink.append(sampleSpan)).not.toThrow();
    // 失败过一次就不再重试，避免每条 span 都再吃一次失败路径。
    expect(() => sink.append(sampleSpan)).not.toThrow();
  });
});

describe('run-latency AsyncLocalStorage 绑定', () => {
  it('binds the recorder for nested spans and exposes it to plain functions', async () => {
    const sink = new CollectingSink();
    const recorder = createRecorder(sink, [0, 5, 10], ['a', 'b', 'c']);

    const observed: Array<string | undefined> = [];
    await runWithRunLatencyRecorder(recorder, async () => {
      await withRunLatencySpan('loop.read_run_state', {}, async () => {
        observed.push(getRunLatencyRecorder()?.run_id);
      });
      recordRunLatencySpan('driver.invoke', {
        started_at: 'a',
        completed_at: 'b',
        duration_ms: 1,
      });
    });

    expect(observed).toEqual(['run_latency']);
    expect(sink.spans.map((span) => span.name)).toEqual(['loop.read_run_state', 'driver.invoke']);
  });

  it('keeps parallel spans attributed to the same run', async () => {
    const sink = new CollectingSink();
    const recorder = createRecorder(sink, [0, 1, 0, 1], ['a', 'b', 'c', 'd']);

    await runWithRunLatencyRecorder(recorder, async () => {
      await Promise.all([
        withRunLatencySpan('facade.dispatch', { attempt: 1 }, async () => undefined),
        withRunLatencySpan('facade.dispatch', { attempt: 2 }, async () => undefined),
      ]);
    });

    expect(sink.spans.map((span) => span.attempt)).toEqual([1, 2]);
    expect(new Set(sink.spans.map((span) => span.run_id))).toEqual(new Set(['run_latency']));
  });

  it('runs the wrapped call untouched when no recorder is bound', async () => {
    const run = vi.fn(async () => 'direct');
    await expect(withRunLatencySpan('facade.run_total', {}, run)).resolves.toBe('direct');
    expect(run).toHaveBeenCalledTimes(1);
    expect(getRunLatencyRecorder()).toBeUndefined();
    expect(() =>
      recordRunLatencySpan('driver.invoke', {
        started_at: 'a',
        completed_at: 'b',
        duration_ms: 1,
      }),
    ).not.toThrow();
  });

  it('does not leak the recorder outside its scope', async () => {
    const sink = new CollectingSink();
    const recorder = createRecorder(sink, [0, 1], ['a', 'b']);

    await runWithRunLatencyRecorder(recorder, async () => undefined);

    expect(getRunLatencyRecorder()).toBeUndefined();
  });
});
