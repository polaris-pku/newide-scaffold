import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTrajectoryWriter, parseTrajectoryLine } from '../../src/trace/trace-writer';
import type { TrajectorySpanRecord } from '../../src/trace/types';

const tempDirs: string[] = [];

function record(sequence: number, phase: TrajectorySpanRecord['phase']): TrajectorySpanRecord {
  return {
    span_id: 'span_1',
    run_id: 'run_1',
    task_id: 'task_1',
    kind: 'driver.run',
    phase,
    status: phase === 'end' ? 'ok' : undefined,
    ...(phase === 'end' ? { duration_ms: 5 } : {}),
    sequence,
    created_at: '2026-07-11T08:00:00.000Z',
    schema_version: 'v0',
  };
}

describe('FileTrajectoryWriter', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('appends one JSON record per line and loads them back in order', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'trace-writer-'));
    tempDirs.push(runsRoot);
    const writer = new FileTrajectoryWriter(runsRoot);

    await writer.append(record(1, 'start'));
    await writer.append(record(2, 'end'));

    const contents = await readFile(path.join(runsRoot, 'run_1', 'trajectory.jsonl'), 'utf-8');
    expect(contents.trim().split('\n')).toHaveLength(2);

    const loaded = await writer.load('run_1');
    expect(loaded.map((entry) => entry.phase)).toEqual(['start', 'end']);
    expect(loaded[0]!.sequence).toBe(1);
    expect(loaded[1]!.status).toBe('ok');
  });

  it('flushes queued appends for a run', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'trace-writer-'));
    tempDirs.push(runsRoot);
    const writer = new FileTrajectoryWriter(runsRoot);

    void writer.append(record(1, 'start'));
    void writer.append(record(2, 'end'));
    await writer.flush('run_1');

    expect((await writer.load('run_1')).length).toBe(2);
  });

  it('returns an empty list for a run with no trajectory file', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'trace-writer-'));
    tempDirs.push(runsRoot);
    const writer = new FileTrajectoryWriter(runsRoot);
    expect(await writer.load('missing_run')).toEqual([]);
  });

  it('skips malformed lines when loading', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'trace-writer-'));
    tempDirs.push(runsRoot);
    const writer = new FileTrajectoryWriter(runsRoot);
    await writer.append(record(1, 'start'));
    await writer.append({ ...record(2, 'end'), sequence: 2 });

    const filePath = path.join(runsRoot, 'run_1', 'trajectory.jsonl');
    const contents = await readFile(filePath, 'utf-8');
    await (await import('node:fs/promises')).writeFile(
      filePath,
      `${contents}not-json\n{"span_id":1}\n`,
    );

    expect(await writer.load('run_1')).toHaveLength(2);
  });

  it('parses a valid line and rejects malformed lines', () => {
    expect(parseTrajectoryLine(JSON.stringify(record(1, 'start')))).not.toBeNull();
    expect(parseTrajectoryLine('garbage')).toBeNull();
    expect(parseTrajectoryLine('{"span_id":1}')).toBeNull();
  });
});
