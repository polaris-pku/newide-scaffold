/**
 * payload_ref 取回工具：引用解析、审计行读取、按 sequence 定位原始事件。
 *
 * 与 FileDriverStreamAuditWriter 是天然的一对——这里直接用 writer 落真实文件再
 * 取回，顺带验证两种形状的行（事件行 / 截断标记行）都能安全读过。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileDriverStreamAuditWriter } from '../../src/app/driver-stream-audit-writer';
import {
  parseDriverStreamRef,
  readDriverStreamAuditLines,
  resolveDriverStreamRef,
} from '../../src/app/driver-stream-refs';
import type { DriverStreamEvent } from '../../src/driver/contract';

function eventOf(sequence: number): DriverStreamEvent {
  return {
    schema_version: 'driver-event.v1',
    event_type: 'agent_message_chunk',
    task_id: 'task_1',
    run_id: 'run_1',
    sequence,
    created_at: '2026-01-01T00:00:00.000Z',
    payload: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `s${sequence}` } } },
  };
}

describe('driver-stream-refs', () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'driver-stream-refs-'));
  });

  afterEach(async () => {
    await fs.rm(runsRoot, { recursive: true, force: true });
  });

  it('parses well-formed refs and rejects everything else', () => {
    expect(parseDriverStreamRef('driver-stream.jsonl#sequence=12')).toBe(12);
    expect(parseDriverStreamRef('driver-stream.jsonl#sequence=abc')).toBeUndefined();
    expect(parseDriverStreamRef('elsewhere.jsonl#sequence=12')).toBeUndefined();
    expect(parseDriverStreamRef('')).toBeUndefined();
  });

  it('resolves a ref back to the original event written by the audit writer', async () => {
    const writer = new FileDriverStreamAuditWriter(runsRoot);
    await writer.append('run_1', 'task_1', eventOf(1));
    await writer.append('run_1', 'task_1', eventOf(2));

    const resolved = await resolveDriverStreamRef(runsRoot, 'run_1', 'driver-stream.jsonl#sequence=2');
    expect(resolved).toEqual(eventOf(2));
  });

  it('reads every line including truncation markers without choking', async () => {
    const writer = new FileDriverStreamAuditWriter(runsRoot, 260);
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await writer.append('run_1', 'task_1', eventOf(sequence));
    }

    const lines = await readDriverStreamAuditLines(runsRoot, 'run_1');
    expect(lines.some((line) => line.truncated === true)).toBe(true);
    expect(lines.every((line) => line.run_id === 'run_1')).toBe(true);
  });

  it('returns undefined for unknown runs and unreachable sequences', async () => {
    await expect(resolveDriverStreamRef(runsRoot, 'run_missing', 'driver-stream.jsonl#sequence=1')).resolves.toBeUndefined();

    const writer = new FileDriverStreamAuditWriter(runsRoot);
    await writer.append('run_1', 'task_1', eventOf(1));
    await expect(resolveDriverStreamRef(runsRoot, 'run_1', 'driver-stream.jsonl#sequence=99')).resolves.toBeUndefined();
    await expect(readDriverStreamAuditLines(runsRoot, 'run_missing')).resolves.toEqual([]);
  });
});
