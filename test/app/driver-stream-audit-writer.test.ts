/**
 * FileDriverStreamAuditWriter 的落盘形状与保留策略。
 *
 * 核心行为两条：一事件一行的信封追加；超过 maxBytesPerRun 后停止追加并留下一行
 * `truncated: true` 标记。上限判定读的是文件当前大小而非进程内计数，所以 writer
 * 重启后依然拒写——用「重新 new 一个 writer 写同一个 run 文件」验证这条。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DRIVER_STREAM_MAX_BYTES,
  FileDriverStreamAuditWriter,
} from '../../src/app/driver-stream-audit-writer';
import type { DriverStreamEvent } from '../../src/driver/contract';

function chunkEvent(sequence: number, text: string): DriverStreamEvent {
  return {
    schema_version: 'driver-event.v1',
    event_type: 'agent_message_chunk',
    task_id: 'task_1',
    run_id: 'run_1',
    sequence,
    created_at: '2026-01-01T00:00:00.000Z',
    payload: {
      sessionId: 'session_1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  };
}

async function readLines(
  runsRoot: string,
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(path.join(runsRoot, runId, 'driver-stream.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventLines(lines: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return lines.filter((line) => line.event !== undefined);
}

describe('FileDriverStreamAuditWriter', () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'driver-stream-audit-'));
  });

  afterEach(async () => {
    await fs.rm(runsRoot, { recursive: true, force: true });
  });

  it('appends one audit envelope per event', async () => {
    const writer = new FileDriverStreamAuditWriter(runsRoot);
    await writer.append('run_1', 'task_1', chunkEvent(1, 'hello'));
    await writer.append('run_1', 'task_1', chunkEvent(2, 'world'));

    const lines = await readLines(runsRoot, 'run_1');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      schema_version: 'driver-stream-audit.v1',
      run_id: 'run_1',
      task_id: 'task_1',
    });
    expect(lines[0].truncated).toBeUndefined();
    expect(lines[1].event).toEqual(chunkEvent(2, 'world'));
  });

  it('stops appending past the retention cap and leaves one truncation marker', async () => {
    const writer = new FileDriverStreamAuditWriter(runsRoot, 700);
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      await writer.append('run_1', 'task_1', chunkEvent(sequence, 'x'.repeat(200)));
    }

    const lines = await readLines(runsRoot, 'run_1');
    const markers = lines.filter((line) => line.truncated === true);
    expect(markers).toHaveLength(1);
    expect(lines.at(-1)?.truncated).toBe(true);
    // 事件在越线后确实停了，但越线前的完整行都保留着。
    expect(eventLines(lines).length).toBeGreaterThanOrEqual(1);
    expect(eventLines(lines).length).toBeLessThan(4);
  });

  it('keeps refusing appends after restart because the cap reads file size', async () => {
    const first = new FileDriverStreamAuditWriter(runsRoot, 700);
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      await first.append('run_1', 'task_1', chunkEvent(sequence, 'x'.repeat(200)));
    }
    const before = await readLines(runsRoot, 'run_1');

    const restarted = new FileDriverStreamAuditWriter(runsRoot, 700);
    await restarted.append('run_1', 'task_1', chunkEvent(7, 'x'.repeat(200)));
    const after = await readLines(runsRoot, 'run_1');

    // 重启后事件一条也不再进；最多多一行截断标记。
    expect(eventLines(after)).toHaveLength(eventLines(before).length);
  });

  it('keeps every line when the cap is disabled', async () => {
    const writer = new FileDriverStreamAuditWriter(runsRoot, Infinity);
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await writer.append('run_1', 'task_1', chunkEvent(sequence, 'x'.repeat(500)));
    }

    const lines = await readLines(runsRoot, 'run_1');
    expect(eventLines(lines)).toHaveLength(5);
    expect(lines.some((line) => line.truncated === true)).toBe(false);
  });

  it('flush resolves even for runs that never appended', async () => {
    const writer = new FileDriverStreamAuditWriter(runsRoot);
    await expect(writer.flush('run_missing')).resolves.toBeUndefined();
  });

  it('ships a positive default retention cap', () => {
    expect(DEFAULT_DRIVER_STREAM_MAX_BYTES).toBeGreaterThan(0);
  });
});
