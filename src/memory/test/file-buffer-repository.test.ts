/**
 * file-buffer-repository 单元测试
 *
 * 验证 FileBufferRepository 在应用状态目录下的持久化读写、
 * pending/processed/dead_letter 迁移，以及进程重启后的状态恢复。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { FileBufferRepository } from '../adapters/file-buffer-repository';
import type { AgentContextSnapshot, BufferSnapshot, DriverReturn } from '../schemas';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createRepository(): Promise<{
  repo: FileBufferRepository;
  agentStateRoot: string;
}> {
  const agentStateRoot = await mkdtemp(join(tmpdir(), 'newide-buffer-'));
  tempDirs.push(agentStateRoot);
  return {
    repo: new FileBufferRepository({ agentStateRoot }),
    agentStateRoot,
  };
}

function sampleDriverReturn(): DriverReturn {
  return {
    artifacts: [],
    summary: 'Completed buffer persistence test task.',
    decisions: [],
    blockers: [],
    referenced_experiences: [],
    assumptions: [],
  };
}

function sampleBufferSnapshot(overrides: Partial<BufferSnapshot> = {}): BufferSnapshot {
  return {
    task_id: 'task_buffer_001',
    task_description: 'Implement FileBufferRepository.',
    driver_return: sampleDriverReturn(),
    source_task_id: 'task_buffer_001',
    source_driver: 'mock-driver',
    received_at: nowTimestamp(),
    retry_count: 0,
    extraction_status: 'pending',
    ...overrides,
  };
}

function sampleAgentContext(role_id: string): AgentContextSnapshot {
  return {
    snapshot_id: randomUUID(),
    source_task_id: 'task_buffer_001',
    agent_id: role_id,
    thinking_trace: 'Reasoning trace',
    planning_trace: 'Planning trace',
    driver_calls: [
      {
        call_id: 'call_001',
        driver_id: 'mock-driver',
        driver_return_ref: 'report_pending.json',
      },
    ],
    cleaned_at: nowTimestamp(),
    original_token_count: 1000,
    cleaned_token_count: 400,
    compression_ratio: 0.4,
  };
}

describe('FileBufferRepository', () => {
  it('ensureAgent creates buffer directory layout and initial meta', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_file_buffer';

    await repo.ensureAgent(role_id);

    const metaRaw = await readFile(
      join(agentStateRoot, role_id, 'buffer', 'buffer_meta.json'),
      'utf8',
    );
    const meta = JSON.parse(metaRaw) as { role_id: string; cursor: number; pending_count: number };

    expect(meta.role_id).toBe(role_id);
    expect(meta.cursor).toBe(0);
    expect(meta.pending_count).toBe(0);
  });

  it('saveBufferSnapshot writes pending files and increments seq', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_save';
    await repo.ensureAgent(role_id);

    const agentContext = sampleAgentContext(role_id);
    const saved = await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), agentContext);

    expect(saved.seq).toBe(1);
    expect(saved.snapshot.context_snapshot_ref).toBe('1');
    expect(saved.agent_context_snapshot?.driver_calls[0]?.driver_return_ref).toBe('report_1.json');

    const meta = await repo.getBufferMeta(role_id);
    expect(meta.cursor).toBe(1);
    expect(meta.pending_count).toBe(1);

    const pending = await repo.getPendingBuffer(role_id, 1);
    expect(pending?.snapshot.task_id).toBe('task_buffer_001');
    expect(pending?.agentContext?.agent_id).toBe(role_id);
  });

  it('listPendingBufferSeqs returns sorted seq list', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_list';
    await repo.ensureAgent(role_id);

    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot({ task_id: 'task_1' }));
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot({ task_id: 'task_2' }));
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot({ task_id: 'task_3' }));

    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([1, 2, 3]);
  });

  it('markBufferProcessed moves files to processed and updates meta', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_processed';
    await repo.ensureAgent(role_id);

    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await repo.markBufferProcessed(role_id, 1);

    await expect(repo.getPendingBuffer(role_id, 1)).resolves.toBeUndefined();
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([]);

    const processedReport = await readFile(
      join(agentStateRoot, role_id, 'buffer', 'processed', 'report_1.json'),
      'utf8',
    );
    const snapshot = JSON.parse(processedReport) as BufferSnapshot;
    expect(snapshot.extraction_status).toBe('processed');

    const meta = await repo.getBufferMeta(role_id);
    expect(meta.pending_count).toBe(0);
    expect(meta.total_processed).toBe(1);
  });

  it('markBufferDeadLetter moves files to dead_letter and updates meta', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_dead_letter';
    await repo.ensureAgent(role_id);

    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot());
    await repo.markBufferDeadLetter(role_id, 1);

    const deadLetterReport = await readFile(
      join(agentStateRoot, role_id, 'buffer', 'dead_letter', 'report_1.json'),
      'utf8',
    );
    const snapshot = JSON.parse(deadLetterReport) as BufferSnapshot;
    expect(snapshot.extraction_status).toBe('dead_letter');

    const meta = await repo.getBufferMeta(role_id);
    expect(meta.pending_count).toBe(0);
    expect(meta.total_dead_letters).toBe(1);
  });

  it('moves the paired context file with the report on processed / dead_letter / restore', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_context_migration';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);

    // 三条各自成对写入，随后分别走 processed / dead_letter / dead_letter→restore
    for (const seq of [1, 2, 3]) {
      await repo.saveBufferSnapshot(
        role_id,
        sampleBufferSnapshot({ task_id: `task_${seq}` }),
        sampleAgentContext(role_id),
      );
    }

    await repo.markBufferProcessed(role_id, 1);
    await repo.markBufferDeadLetter(role_id, 2);
    await repo.markBufferDeadLetter(role_id, 3);

    // 报告与它的上下文必须永远同进同出：留下孤儿报告，提取器就会以为
    // 「这次没有上下文」，而实际上只是搬丢了。
    await expect(readFile(join(bufferDir, 'processed', 'report_1.json'), 'utf8')).resolves.toBeTruthy();
    await expect(readFile(join(bufferDir, 'processed', 'context_1.json'), 'utf8')).resolves.toBeTruthy();
    await expect(readFile(join(bufferDir, 'dead_letter', 'report_2.json'), 'utf8')).resolves.toBeTruthy();
    await expect(readFile(join(bufferDir, 'dead_letter', 'context_2.json'), 'utf8')).resolves.toBeTruthy();
    await expect(readFile(join(bufferDir, 'pending', 'report_1.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(bufferDir, 'pending', 'context_1.json'), 'utf8')).rejects.toThrow();

    await repo.restoreDeadLetter(role_id, 3);

    const restored = await repo.getPendingBuffer(role_id, 3);
    expect(restored?.snapshot.task_id).toBe('task_3');
    expect(restored?.snapshot.extraction_status).toBe('pending');
    expect(restored?.agentContext?.agent_id).toBe(role_id);
  });

  it('survives repository restart against the same agentStateRoot', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_restart';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));

    const restarted = new FileBufferRepository({ agentStateRoot });
    await expect(restarted.listPendingBufferSeqs(role_id)).resolves.toEqual([1]);

    const pending = await restarted.getPendingBuffer(role_id, 1);
    expect(pending?.snapshot.task_id).toBe('task_buffer_001');
    expect(pending?.agentContext?.agent_id).toBe(role_id);

    const meta = await restarted.getBufferMeta(role_id);
    expect(meta.cursor).toBe(1);
    expect(meta.pending_count).toBe(1);
  });

  it('isolates buffer data by role_id under the same agentStateRoot', async () => {
    const { repo } = await createRepository();

    await repo.ensureAgent('role_a');
    await repo.ensureAgent('role_b');
    await repo.saveBufferSnapshot('role_a', sampleBufferSnapshot({ task_id: 'task_a' }));
    await repo.saveBufferSnapshot('role_b', sampleBufferSnapshot({ task_id: 'task_b' }));

    await expect(repo.listPendingBufferSeqs('role_a')).resolves.toEqual([1]);
    await expect(repo.listPendingBufferSeqs('role_b')).resolves.toEqual([1]);

    const pendingA = await repo.getPendingBuffer('role_a', 1);
    const pendingB = await repo.getPendingBuffer('role_b', 1);
    expect(pendingA?.snapshot.task_id).toBe('task_a');
    expect(pendingB?.snapshot.task_id).toBe('task_b');
  });

  it('throws when marking a missing pending buffer', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_missing';
    await repo.ensureAgent(role_id);

    await expect(repo.markBufferProcessed(role_id, 99)).rejects.toThrow(
      'Pending buffer not found: seq=99',
    );
  });

  it('throws when reading meta before ensureAgent', async () => {
    const { repo } = await createRepository();

    await expect(repo.getBufferMeta('role_uninitialized')).rejects.toThrow(
      'Buffer store not found for agent: role_uninitialized',
    );
  });
});
