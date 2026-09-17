/**
 * FileRunEventConsumptionSink 的落盘与副作用边界测试。
 *
 * 守两件事：汇总信号写到 run 自己的文件（而不是 run 的事件流），以及写不进去时
 * 只丢信号、不抛出。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileRunEventConsumptionSink,
  RunEventConsumptionRecorder,
  runWithRunEventConsumption,
  recordRunEventConsumed,
} from '../../src/telemetry';

const directories: string[] = [];

function createRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'newide-event-consumption-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('FileRunEventConsumptionSink', () => {
  it('把汇总写到 <root>/<run_id>/event-consumption.jsonl', async () => {
    const root = createRoot();
    const recorder = new RunEventConsumptionRecorder({
      run_id: 'run_sink',
      task_id: 'task_sink',
      sink: new FileRunEventConsumptionSink(root),
    });

    await runWithRunEventConsumption(recorder, async () => {
      recordRunEventConsumed('market.selected', { winner_agent_id: 'agent_a' });
    });
    await recorder.finish();

    const lines = readFileSync(
      path.join(root, 'run_sink', 'event-consumption.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event_type: string; payload: Record<string, unknown> });

    expect(lines.map((line) => line.event_type)).toEqual([
      'run.event_consumed',
      'run.event_committed_batch',
    ]);
    // 汇总必须带上分类明细，否则这个文件只能回答「多少条」、答不了「都是什么」。
    expect(lines[0]?.payload).toMatchObject({ total_events: 1, by_type: { 'market.selected': { count: 1 } } });
  });

  it('目录建不出来时只丢信号，不影响 run', async () => {
    const root = createRoot();
    // 用一个文件占住 <root>/<run_id> 这个路径，让 mkdir 必失败。
    writeFileSync(path.join(root, 'run_blocked'), 'not a directory');

    const recorder = new RunEventConsumptionRecorder({
      run_id: 'run_blocked',
      task_id: 'task_blocked',
      sink: new FileRunEventConsumptionSink(root),
    });

    await expect(recorder.finish()).resolves.toMatchObject({ total_events: 0 });
  });
});
