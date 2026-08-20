/**
 * Buffer 可观测 / 重试（M5：memory.getBufferState / getPendingBuffer /
 * retryExtraction 的存储层）测试
 *
 * 验证（内存 + 文件两套实现）：
 *   1. markBufferDeadLetter 后 listDeadLetterSeqs 可见、pending 不再包含
 *   2. restoreDeadLetter 恢复到 pending，extraction_status 回退 pending，meta 计数正确
 *   3. updateBufferRating 写入 pending 快照；非 pending 时报错
 */
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { FileBufferRepository } from '../adapters/file-buffer-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import type { BufferSnapshot } from '../schemas';

const ROLE = 'role_buffer';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function snapshot(seq: number): BufferSnapshot {
  const now = nowTimestamp();
  return {
    task_id: `task_${String(seq)}`,
    task_description: 'Do a task.',
    driver_return: {
      artifacts: [],
      summary: 'Done.',
      decisions: [],
      blockers: [],
      referenced_experiences: [],
      assumptions: [],
    },
    source_task_id: `task_${String(seq)}`,
    source_driver: 'test-driver',
    received_at: now,
    retry_count: 0,
    extraction_status: 'pending',
  };
}

describe.each([
  ['in-memory', () => new InMemoryBufferRepository()],
  [
    'file',
    () => {
      const root = `${os.tmpdir()}/newide-buffer-m5-${Math.random().toString(36).slice(2)}`;
      roots.push(root);
      return new FileBufferRepository({ agentStateRoot: root });
    },
  ],
] as const)('%s BufferRepository', (_name, factory) => {
  it('tracks and restores dead-letter buffers with correct meta', async () => {
    const repository = factory();
    await repository.ensureAgent(ROLE);
    await repository.saveBufferSnapshot(ROLE, snapshot(1));

    await repository.markBufferDeadLetter(ROLE, 1);
    expect(await repository.listPendingBufferSeqs(ROLE)).toEqual([]);
    expect(await repository.listDeadLetterSeqs(ROLE)).toEqual([1]);
    expect((await repository.getBufferMeta(ROLE)).total_dead_letters).toBe(1);

    await repository.restoreDeadLetter(ROLE, 1);
    expect(await repository.listDeadLetterSeqs(ROLE)).toEqual([]);
    const pending = await repository.getPendingBuffer(ROLE, 1);
    expect(pending!.snapshot.extraction_status).toBe('pending');
    const meta = await repository.getBufferMeta(ROLE);
    expect(meta.pending_count).toBe(1);
    expect(meta.total_dead_letters).toBe(0);
  });

  it('restoreDeadLetter throws for an unknown seq', async () => {
    const repository = factory();
    await repository.ensureAgent(ROLE);
    await expect(repository.restoreDeadLetter(ROLE, 99)).rejects.toThrow(/Dead-letter/);
  });

  it('updateBufferRating writes into a pending snapshot and rejects non-pending', async () => {
    const repository = factory();
    await repository.ensureAgent(ROLE);
    await repository.saveBufferSnapshot(ROLE, snapshot(1));

    await repository.updateBufferRating(ROLE, 1, 'resolved');
    expect((await repository.getPendingBuffer(ROLE, 1))!.snapshot.user_rating).toBe('resolved');

    await expect(repository.updateBufferRating(ROLE, 5, 'resolved')).rejects.toThrow(
      /Pending buffer not found/,
    );
  });
});
