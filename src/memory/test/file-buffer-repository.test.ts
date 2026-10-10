/**
 * file-buffer-repository 单元测试
 *
 * 验证 FileBufferRepository 在应用状态目录下的持久化读写、
 * pending/processed/dead_letter 迁移，以及进程重启后的状态恢复。
 */
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
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

async function createRepository(options: {
  /** 注入删除源文件的操作，用来在各平台上确定性地制造「目标已写入、源还在」的半成品 */
  removeSourceFile?: (path: string) => Promise<void>;
} = {}): Promise<{
  repo: FileBufferRepository;
  agentStateRoot: string;
}> {
  const agentStateRoot = await mkdtemp(join(tmpdir(), 'newide-buffer-'));
  tempDirs.push(agentStateRoot);
  return {
    repo: new FileBufferRepository({
      agentStateRoot,
      ...(options.removeSourceFile ? { removeSourceFile: options.removeSourceFile } : {}),
    }),
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

  it('getStoredBuffer 读得到已归档的缓冲区，缺席才返回 undefined', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_stored';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot('role_stored', sampleBufferSnapshot(), sampleAgentContext(role_id));
    await repo.saveBufferSnapshot(
      role_id,
      sampleBufferSnapshot({ task_id: 'task_buffer_002' }),
      sampleAgentContext(role_id),
    );

    await repo.markBufferProcessed(role_id, 1);
    await repo.markBufferDeadLetter(role_id, 2, 'extraction failed');

    // 归档（processed）之后快照与它的上下文都还在，只是不再属于 pending
    const processed = await repo.getStoredBuffer(role_id, 1);
    expect(processed).toMatchObject({ location: 'processed' });
    expect(processed?.snapshot.task_id).toBe('task_buffer_001');
    expect(processed?.snapshot.extraction_status).toBe('processed');
    expect(processed?.agentContext?.agent_id).toBe(role_id);
    await expect(repo.getPendingBuffer(role_id, 1)).resolves.toBeUndefined();

    const deadLettered = await repo.getStoredBuffer(role_id, 2);
    expect(deadLettered).toMatchObject({ location: 'dead_letter' });
    expect(deadLettered?.snapshot.task_id).toBe('task_buffer_002');

    await expect(repo.getStoredBuffer(role_id, 99)).resolves.toBeUndefined();
  });

  it('损坏的 pending 报告：读不出来就抛错并带上路径，不伪装成「没有这条」', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_corrupt';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await writeFile(
      join(agentStateRoot, role_id, 'buffer', 'pending', 'report_1.json'),
      '{ not json',
      'utf8',
    );

    await expect(repo.getPendingBuffer(role_id, 1)).rejects.toThrow(/Unreadable buffer report/);
    await expect(repo.getStoredBuffer(role_id, 1)).rejects.toThrow(/Unreadable buffer report/);
    // 定位信息要够：路径里含 role 与 seq
    await expect(repo.getStoredBuffer(role_id, 1)).rejects.toThrow(
      new RegExp(`role_corrupt.*report_1\\.json`),
    );
  });
});

/**
 * 「没有上下文」与「有上下文却读不出来」是两回事：前者是历史 Buffer 的正常形态
 * （写入侧本来就没做上下文清理），后者说明一份**声明过**的上下文丢了。降级成前者
 * 等于把丢失藏起来，所以这些用例把两种情形分别钉死。
 */
describe('FileBufferRepository：配对上下文的读取结果（缺失 ≠ 损坏）', () => {
  it('没有 context_snapshot_ref 且没有 context 文件：报 absent，报告本身照读', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_context_absent';
    const pendingDir = join(agentStateRoot, role_id, 'buffer', 'pending');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    // 抹掉引用并删掉上下文，模拟「历史 Buffer 从来没落过 context 文件」
    const { context_snapshot_ref: _dropped, ...withoutRef } = sampleBufferSnapshot();
    await writeFile(
      join(pendingDir, 'report_1.json'),
      `${JSON.stringify(withoutRef, null, 2)}\n`,
      'utf8',
    );
    await rm(join(pendingDir, 'context_1.json'), { force: true });

    const pending = await repo.getPendingBuffer(role_id, 1);
    expect(pending?.agentContextStatus).toBe('absent');
    expect(pending?.agentContext).toBeUndefined();
    expect(pending?.agentContextError).toBeUndefined();
    expect(pending?.snapshot.task_id).toBe('task_buffer_001');
  });

  it('声明了 context_snapshot_ref 却没有 context 文件：报 unreadable，不当作「没有上下文」', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_context_missing';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await rm(join(agentStateRoot, role_id, 'buffer', 'pending', 'context_1.json'), { force: true });

    const pending = await repo.getPendingBuffer(role_id, 1);
    expect(pending?.agentContextStatus).toBe('unreadable');
    expect(pending?.agentContext).toBeUndefined();
    expect(pending?.agentContextError).toMatch(/context_snapshot_ref=1[\s\S]*context_1\.json/);
  });

  it('context JSON 损坏：报 unreadable，带路径与原因', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_context_broken_json';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await writeFile(
      join(agentStateRoot, role_id, 'buffer', 'pending', 'context_1.json'),
      '{ not json',
      'utf8',
    );

    const pending = await repo.getPendingBuffer(role_id, 1);
    expect(pending?.agentContextStatus).toBe('unreadable');
    expect(pending?.agentContextError).toMatch(/role_context_broken_json.*context_1\.json/);
    // 报告那一半仍然可读：这是隔离，不是连坐
    expect(pending?.snapshot.task_id).toBe('task_buffer_001');
  });

  it('context schema 不匹配：与 JSON 损坏同样报 unreadable', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_context_bad_schema';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await writeFile(
      join(agentStateRoot, role_id, 'buffer', 'pending', 'context_1.json'),
      `${JSON.stringify({ snapshot_id: 'not-a-uuid', source_task_id: 'task_buffer_001' })}\n`,
      'utf8',
    );

    const pending = await repo.getPendingBuffer(role_id, 1);
    expect(pending?.agentContextStatus).toBe('unreadable');
    expect(pending?.agentContextError).toMatch(/Unreadable agent context/);
  });

  it('processed 与 dead_letter 分区里的配对文件遵守同一套读取规则', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_context_archived';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    for (const seq of [1, 2]) {
      await repo.saveBufferSnapshot(
        role_id,
        sampleBufferSnapshot({ task_id: `task_${String(seq)}` }),
        sampleAgentContext(role_id),
      );
    }
    await repo.markBufferProcessed(role_id, 1);
    await repo.markBufferDeadLetter(role_id, 2);

    // 归档区里读得出来的上下文正常返回
    const good = await repo.getStoredBuffer(role_id, 1);
    expect(good).toMatchObject({ location: 'processed', agentContextStatus: 'present' });

    // 归档后再损坏：同样报 unreadable，而不是「这条没有上下文」
    await writeFile(join(bufferDir, 'processed', 'context_1.json'), '{ not json', 'utf8');
    await writeFile(join(bufferDir, 'dead_letter', 'context_2.json'), '{ not json', 'utf8');

    const processed = await repo.getStoredBuffer(role_id, 1);
    expect(processed).toMatchObject({ location: 'processed', agentContextStatus: 'unreadable' });
    const deadLettered = await repo.getStoredBuffer(role_id, 2);
    expect(deadLettered).toMatchObject({ location: 'dead_letter', agentContextStatus: 'unreadable' });
  });
});

/**
 * archiveBuffer 是「ack 之后归档」这一步的交付面：ack 不能回滚，归档就必须把结果
 * 讲清楚——「早已不在 pending」（无需修复）和「归档动作真失败」（必须看得见）不能混。
 */
describe('FileBufferRepository.archiveBuffer', () => {
  it('pending → archived；重复归档 → already_archived，不重复计数', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_archive_ok';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));

    await expect(repo.archiveBuffer(role_id, 1)).resolves.toEqual({ status: 'archived' });
    await expect(repo.archiveBuffer(role_id, 1)).resolves.toEqual({ status: 'already_archived' });

    const meta = await repo.getBufferMeta(role_id);
    expect(meta).toMatchObject({ pending_count: 0, total_processed: 1 });
  });

  it('并发归档同一条 Buffer：只有一个 archived，其余 already_archived，计数只加一次', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_archive_race';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));

    // 归档是「读 pending → 搬 context → 搬 report → 刷 meta」四步，每步都有 await：
    // 不串行化的话两个调用都会在报告被搬走之前读到它，各自「成功」搬一次，
    // 而 total_processed 是读-改-写，会被加两次。
    const outcomes = await Promise.all([
      repo.archiveBuffer(role_id, 1),
      repo.archiveBuffer(role_id, 1),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      'already_archived',
      'archived',
    ]);
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      pending_count: 0,
      total_processed: 1,
      total_dead_letters: 0,
    });
    // 配对迁移没被并发破坏：报告与上下文都到了 processed，且能整对读回
    expect(await repo.listPendingBufferSeqs(role_id)).toEqual([]);
    const stored = await repo.getStoredBuffer(role_id, 1);
    expect(stored?.location).toBe('processed');
    expect(stored?.agentContextStatus).toBe('present');
  });

  it('Buffer 在 dead_letter → not_pending；不在任何分区 → missing', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_archive_elsewhere';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot());
    await repo.markBufferDeadLetter(role_id, 1, 'extraction failed');

    const deadLettered = await repo.archiveBuffer(role_id, 1);
    expect(deadLettered).toMatchObject({ status: 'not_pending', location: 'dead_letter' });
    expect(await repo.archiveBuffer(role_id, 99)).toMatchObject({ status: 'missing' });
  });

  it('归档动作真的失败（报告损坏）→ failed，且 Buffer 仍在 pending', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_archive_failed';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot());
    await writeFile(
      join(agentStateRoot, role_id, 'buffer', 'pending', 'report_1.json'),
      '{ not json',
      'utf8',
    );

    const outcome = await repo.archiveBuffer(role_id, 1);
    expect(outcome.status).toBe('failed');
    // 失败必须自带原因与定位：哪条Buffer、为什么
    const message = outcome.status === 'failed' ? outcome.message : '';
    expect(message).toMatch(/could not be archived/);
    expect(message).toMatch(/report_1\.json/);
    // Buffer 没被搬走：重试归档才有意义
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([1]);
  });
});

/**
 * 配对了 AgentContextSnapshot 的 Buffer（声明了 context_snapshot_ref）里，报告与上下文
 * 必须**同进同出**。核心不变量：report 是这条记录对外的「存在标记」——只要它还留在
 * pending，归档就没算数、缺口可查；一旦先把它搬进 processed 而上下文没跟上，就会留下
 * 一个被 already_archived 掩盖、再没人看得到的孤儿上下文。这一组把该不变量钉死。
 */
describe('FileBufferRepository：配对 Buffer 的归档原子性', () => {
  it('声明了引用却搬不动 context（文件丢失）：报 failed，绝不报 archived，报告留在 pending', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_pair_missing_context';
    const pendingDir = join(agentStateRoot, role_id, 'buffer', 'pending');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    // 让声明的上下文凭空消失：搬不动
    await rm(join(pendingDir, 'context_1.json'), { force: true });

    const outcome = await repo.archiveBuffer(role_id, 1);
    expect(outcome.status).toBe('failed');
    // 缺口看得见：报告仍在 pending，重试归档才有意义
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([1]);
    await expect(readFile(join(pendingDir, 'report_1.json'), 'utf8')).resolves.toBeTruthy();
  });

  it('context 搬运 I/O 失败（目标被占）：归档失败且报告不被先搬走', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_pair_io_fail';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    // 目标分区的 context 路径被一个非空目录占住：rename 搬不过去
    await mkdir(join(bufferDir, 'processed', 'context_1.json'), { recursive: true });
    await writeFile(join(bufferDir, 'processed', 'context_1.json', 'blocker'), 'x', 'utf8');

    const outcome = await repo.archiveBuffer(role_id, 1);
    expect(outcome.status).toBe('failed');
    // context 先搬、report 后搬：context 失败时 report 根本没动，不会出现半成品
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([1]);
    await expect(readFile(join(bufferDir, 'pending', 'report_1.json'), 'utf8')).resolves.toBeTruthy();
  });

  it('报告已归档、配对 context 仍留在 pending：补搬而不是误报 already_archived', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_pair_half';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    // 手工制造旧实现留下的半成品：report 进了 processed，context 还留在 pending
    await mkdir(join(bufferDir, 'processed'), { recursive: true });
    await writeFile(
      join(bufferDir, 'processed', 'report_1.json'),
      await readFile(join(bufferDir, 'pending', 'report_1.json'), 'utf8'),
      'utf8',
    );
    await rm(join(bufferDir, 'pending', 'report_1.json'));

    const outcome = await repo.archiveBuffer(role_id, 1);
    // 不是 already_archived：它其实缺了上下文那一半，这里是把它补回来的结果
    expect(outcome.status).toBe('archived');
    await expect(
      readFile(join(bufferDir, 'processed', 'context_1.json'), 'utf8'),
    ).resolves.toBeTruthy();
    await expect(readFile(join(bufferDir, 'pending', 'context_1.json'), 'utf8')).rejects.toThrow();
    await expect(repo.getStoredBuffer(role_id, 1)).resolves.toMatchObject({
      location: 'processed',
      agentContextStatus: 'present',
    });
  });

  it('报告已归档、配对 context 彻底不在：报 failed 而不是 already_archived', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_pair_lost';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await mkdir(join(bufferDir, 'processed'), { recursive: true });
    await writeFile(
      join(bufferDir, 'processed', 'report_1.json'),
      await readFile(join(bufferDir, 'pending', 'report_1.json'), 'utf8'),
      'utf8',
    );
    await rm(join(bufferDir, 'pending', 'report_1.json'));
    await rm(join(bufferDir, 'pending', 'context_1.json'), { force: true });

    const outcome = await repo.archiveBuffer(role_id, 1);
    expect(outcome.status).toBe('failed');
  });

  it('meta 写入失败不制造不可见缺口：归档照样落地，pending 不留残骸', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_meta_fail';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    // 让 buffer_meta.json 写不进去（被目录占位）
    await rm(join(bufferDir, 'buffer_meta.json'), { force: true });
    await mkdir(join(bufferDir, 'buffer_meta.json'), { recursive: true });

    const outcome = await repo.archiveBuffer(role_id, 1);
    // 计数器写不进去不该把一次已经落地的归档翻成失败（那会在 archive_backlog 里造出假缺口）
    expect(outcome.status).toBe('archived');
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([]);
    await expect(repo.getStoredBuffer(role_id, 1)).resolves.toMatchObject({ location: 'processed' });
  });

  it('历史 Buffer（无 context_snapshot_ref）缺 context 仍可正常归档', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_legacy_no_ref';
    await repo.ensureAgent(role_id);
    // 没有 agentContext → 写入侧不会留下 context_snapshot_ref，也不会有 context 文件
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot());

    await expect(repo.archiveBuffer(role_id, 1)).resolves.toEqual({ status: 'archived' });
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([]);
    await expect(
      readFile(join(agentStateRoot, role_id, 'buffer', 'processed', 'report_1.json'), 'utf8'),
    ).resolves.toBeTruthy();
  });

  it('死信搬运与恢复同样遵守配对规则：context 搬不动就拒绝', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_pair_dead_letter';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await rm(join(bufferDir, 'pending', 'context_1.json'), { force: true });

    // context 丢失 → 置死信也搬不动，必须抛错、报告留在 pending
    await expect(repo.markBufferDeadLetter(role_id, 1, 'extraction failed')).rejects.toThrow();
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([1]);
    await expect(readFile(join(bufferDir, 'pending', 'report_1.json'), 'utf8')).resolves.toBeTruthy();
  });
});

/**
 * 写入的并发与崩溃一致性。
 *
 * 序号分配是「读 meta → 算 seq → 写 context → 写 report → 刷 meta」，每一步之间都有 await：
 * 不串行化就会有两个调用读到同一个 cursor、算出同一个 seq，后来的把先写的 Buffer 顶掉，而
 * 两者都报成功。meta 又可能落后于目录（写失败或进程在 report 与 meta 之间崩了），只信
 * meta.cursor 就会复用已经用过的 seq。这一组把「seq 唯一且严格递增」「已写入的都读得回来」
 * 钉死。
 */
describe('FileBufferRepository：写入并发与崩溃一致性', () => {
  it('并发写入同一 role：seq 唯一且严格递增，每条都读得回来', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_save_concurrent';
    await repo.ensureAgent(role_id);

    const saved = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repo.saveBufferSnapshot(
          role_id,
          sampleBufferSnapshot({ task_id: `task_${String(index)}` }),
        ),
      ),
    );

    const seqs = saved.map((item) => item.seq).sort((left, right) => left - right);
    expect(new Set(seqs).size).toBe(8);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // 每一条都真的落了盘、内容没被后来的覆盖
    for (const item of saved) {
      const pending = await repo.getPendingBuffer(role_id, item.seq);
      expect(pending?.snapshot.task_id).toBe(item.snapshot.task_id);
    }
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      cursor: 8,
      pending_count: 8,
    });
  });

  it('并发写入配对 Buffer：context 与 report 成对，每条上下文都读得出来', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_save_concurrent_paired';
    await repo.ensureAgent(role_id);

    const saved = await Promise.all(
      Array.from({ length: 6 }, () =>
        repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id)),
      ),
    );

    expect(new Set(saved.map((item) => item.seq)).size).toBe(6);
    for (const item of saved) {
      const pending = await repo.getPendingBuffer(role_id, item.seq);
      expect(pending?.snapshot.context_snapshot_ref).toBe(String(item.seq));
      expect(pending?.agentContextStatus).toBe('present');
      expect(pending?.agentContext?.agent_id).toBe(role_id);
    }
  });

  it('meta 写入失败：report 落盘即为提交，seq 不复用', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_meta_write_fail';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    // 让 buffer_meta.json 的写入失败（但读得出来）：临时文件路径被非空目录占位
    await mkdir(join(bufferDir, 'buffer_meta.json.tmp'), { recursive: true });
    await writeFile(join(bufferDir, 'buffer_meta.json.tmp', 'blocker'), 'x', 'utf8');

    const first = await repo.saveBufferSnapshot(
      role_id,
      sampleBufferSnapshot({ task_id: 'task_meta_1' }),
      sampleAgentContext(role_id),
    );
    expect(first.seq).toBe(1);
    // meta 写不进去不该把一次已经落地的写入翻成失败：report 与 context 都在
    await expect(repo.getPendingBuffer(role_id, 1)).resolves.toMatchObject({
      snapshot: { task_id: 'task_meta_1' },
      agentContextStatus: 'present',
    });

    const second = await repo.saveBufferSnapshot(
      role_id,
      sampleBufferSnapshot({ task_id: 'task_meta_2' }),
    );
    // seq 由目录推导（不只是 meta.cursor），所以第二条不会复用 1 把第一条顶掉
    expect(second.seq).toBe(2);
    await expect(readFile(join(bufferDir, 'pending', 'report_1.json'), 'utf8')).resolves.toContain(
      'task_meta_1',
    );
    await expect(readFile(join(bufferDir, 'pending', 'report_2.json'), 'utf8')).resolves.toContain(
      'task_meta_2',
    );
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([1, 2]);

    // meta 一直落后于目录；一旦它能写了，计数就自愈（pending 从目录重数，cursor 取最大值）
    await rm(join(bufferDir, 'buffer_meta.json.tmp'), { recursive: true, force: true });
    const third = await repo.saveBufferSnapshot(
      role_id,
      sampleBufferSnapshot({ task_id: 'task_meta_3' }),
    );
    expect(third.seq).toBe(3);
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      cursor: 3,
      pending_count: 3,
    });
  });

  it('meta 落后于目录（崩溃在 meta 之前）：重启后 cursor 从目录恢复，绝不覆盖已有 report', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_restart_lag';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(
      role_id,
      sampleBufferSnapshot({ task_id: 'task_before_crash' }),
      sampleAgentContext(role_id),
    );

    // 手工把 meta 退回崩溃前的样子：report/context 已落盘，cursor 还停在 0
    await writeFile(
      join(bufferDir, 'buffer_meta.json'),
      `${JSON.stringify(
        { role_id, pending_count: 0, cursor: 0, total_processed: 0, total_dead_letters: 0 },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const restarted = new FileBufferRepository({ agentStateRoot });
    const saved = await restarted.saveBufferSnapshot(
      role_id,
      sampleBufferSnapshot({ task_id: 'task_after_crash' }),
    );

    expect(saved.seq).toBe(2);
    // 崩溃前那条 report 还在，内容没被覆盖
    await expect(restarted.getPendingBuffer(role_id, 1)).resolves.toMatchObject({
      snapshot: { task_id: 'task_before_crash' },
    });
    await expect(restarted.getBufferMeta(role_id)).resolves.toMatchObject({
      cursor: 2,
      pending_count: 2,
    });
    await expect(restarted.listPendingBufferSeqs(role_id)).resolves.toEqual([1, 2]);
  });

  it('配对 context 写入失败：整条写入不落地，修好后重试拿到同一个 seq', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_context_write_fail';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    // 先落一条，把下一个待分配的 seq 顶到 2
    const first = await repo.saveBufferSnapshot(
      role_id,
      sampleBufferSnapshot({ task_id: 'task_before_context_fail' }),
    );
    expect(first.seq).toBe(1);
    // 让 pending/context_2.json 写不进去（被非空目录占位）
    await mkdir(join(bufferDir, 'pending', 'context_2.json'), { recursive: true });
    await writeFile(join(bufferDir, 'pending', 'context_2.json', 'blocker'), 'x', 'utf8');

    await expect(
      repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id)),
    ).rejects.toThrow();

    // context 先落、report 后落：context 失败时 report 根本没写，pending 里没有半条新记录
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([1]);
    await expect(
      readFile(join(bufferDir, 'pending', 'report_2.json'), 'utf8'),
    ).rejects.toThrow();

    // 修好后重试：seq 仍从 2 开始（2 没有被任何 report 占用），落盘的是一对完整记录
    await rm(join(bufferDir, 'pending', 'context_2.json'), { recursive: true, force: true });
    const retried = await repo.saveBufferSnapshot(
      role_id,
      sampleBufferSnapshot({ task_id: 'task_after_context_fail' }),
      sampleAgentContext(role_id),
    );
    expect(retried.seq).toBe(2);
    await expect(repo.getPendingBuffer(role_id, 2)).resolves.toMatchObject({
      snapshot: { task_id: 'task_after_context_fail' },
      agentContextStatus: 'present',
    });
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([1, 2]);
  });
});

/**
 * 搬运的两个半成品失败：目标写入失败（源还完好）与源删除失败（目标已写入，同一条 Buffer
 * 同时躺在两个分区）。前者只是「没搬成」，后者更危险——一旦被报成 archived，调用方会以为
 * 它已经离开 pending，而重试又会再搬一次、重复计数。
 */
describe('FileBufferRepository：搬运失败与重试', () => {
  it('目标写入失败（processed report 路径被占）：failed，Buffer 仍只在 pending', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_move_dest_fail';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await mkdir(join(bufferDir, 'processed', 'report_1.json'), { recursive: true });
    await writeFile(join(bufferDir, 'processed', 'report_1.json', 'blocker'), 'x', 'utf8');

    const outcome = await repo.archiveBuffer(role_id, 1);
    expect(outcome.status).toBe('failed');
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([1]);
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({ total_processed: 0 });

    // 清掉障碍后重试：这次真的归档，计数只加一次
    await rm(join(bufferDir, 'processed', 'report_1.json'), { recursive: true, force: true });
    await expect(repo.archiveBuffer(role_id, 1)).resolves.toEqual({ status: 'archived' });
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      pending_count: 0,
      total_processed: 1,
    });
    await expect(repo.getStoredBuffer(role_id, 1)).resolves.toMatchObject({
      location: 'processed',
      agentContextStatus: 'present',
    });
  });

  it('源 report 删不掉：failed（不是 archived），重试后只归档一次、Buffer 只留在目标分区', async () => {
    let failNextRemoval = true;
    const { repo, agentStateRoot } = await createRepository({
      removeSourceFile: async (path) => {
        if (failNextRemoval) {
          failNextRemoval = false;
          throw Object.assign(new Error('EPERM: source is locked'), { code: 'EPERM' });
        }
        await unlink(path);
      },
    });
    const role_id = 'role_move_source_fail';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));

    const outcome = await repo.archiveBuffer(role_id, 1);
    // 绝不能报 archived：目标已写入、源还在，这一条其实同时躺在两个分区
    expect(outcome.status).toBe('failed');
    const message = outcome.status === 'failed' ? outcome.message : '';
    expect(message).toMatch(/partial/);
    await expect(
      readFile(join(bufferDir, 'pending', 'report_1.json'), 'utf8'),
    ).resolves.toBeTruthy();
    await expect(
      readFile(join(bufferDir, 'processed', 'report_1.json'), 'utf8'),
    ).resolves.toBeTruthy();
    // 半成品没有被算成一次成功归档
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({ total_processed: 0 });

    // 重试：目标会被同内容重写（幂等），源删掉之后才推进计数，只加一次
    await expect(repo.archiveBuffer(role_id, 1)).resolves.toEqual({ status: 'archived' });
    await expect(readFile(join(bufferDir, 'pending', 'report_1.json'), 'utf8')).rejects.toThrow();
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([]);
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      pending_count: 0,
      total_processed: 1,
    });
    await expect(repo.getStoredBuffer(role_id, 1)).resolves.toMatchObject({
      location: 'processed',
      agentContextStatus: 'present',
    });
  });

  it('死信搬运与死信恢复遵守同一套语义：源删不掉就失败，重试后不重复计数', async () => {
    let failNextRemoval = false;
    const { repo, agentStateRoot } = await createRepository({
      removeSourceFile: async (path) => {
        if (failNextRemoval) {
          failNextRemoval = false;
          throw Object.assign(new Error('EPERM: source is locked'), { code: 'EPERM' });
        }
        await unlink(path);
      },
    });
    const role_id = 'role_move_dead_letter';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));

    // 恢复路径的源删除失败：必须抛出去，不能把半成品当成功
    await repo.markBufferDeadLetter(role_id, 1, 'extraction failed');
    failNextRemoval = true;
    await expect(repo.restoreDeadLetter(role_id, 1)).rejects.toThrow(/both partitions/);
    await expect(
      readFile(join(bufferDir, 'dead_letter', 'report_1.json'), 'utf8'),
    ).resolves.toBeTruthy();
    await expect(
      readFile(join(bufferDir, 'pending', 'report_1.json'), 'utf8'),
    ).resolves.toBeTruthy();
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({ total_dead_letters: 1 });

    // 重试：报告回到 pending，死信计数减一且只减一次
    await repo.restoreDeadLetter(role_id, 1);
    await expect(
      readFile(join(bufferDir, 'dead_letter', 'report_1.json'), 'utf8'),
    ).rejects.toThrow();
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([1]);
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      pending_count: 1,
      total_dead_letters: 0,
    });
  });
});

/**
 * 补搬散落 context 时必须**校验内容**，不能只看文件在不在。
 *
 * 「文件在」与「内容能用」是两件事：损坏 / schema 不匹配的 context 若被当成「已经修好了」，
 * ack 之后这条上下文的损坏就再也没人看得见——下游以为自己拿到的是完整输入，实际少了一半。
 */
describe('FileBufferRepository：归档区的上下文损坏校验', () => {
  it('已归档的 context 损坏：报 failed，绝不报 already_archived', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_repair_corrupt';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await repo.archiveBuffer(role_id, 1);
    await writeFile(join(bufferDir, 'processed', 'context_1.json'), '{ not json', 'utf8');

    const outcome = await repo.archiveBuffer(role_id, 1);
    expect(outcome.status).toBe('failed');
    const message = outcome.status === 'failed' ? outcome.message : '';
    expect(message).toMatch(/incomplete/);
  });

  it('已归档的 context schema 不匹配：同样报 failed', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_repair_bad_schema';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await repo.archiveBuffer(role_id, 1);
    await writeFile(
      join(bufferDir, 'processed', 'context_1.json'),
      `${JSON.stringify({ snapshot_id: 'not-a-uuid', source_task_id: 'task_buffer_001' })}\n`,
      'utf8',
    );

    await expect(repo.archiveBuffer(role_id, 1)).resolves.toMatchObject({ status: 'failed' });
  });

  it('补搬的源 context 本身损坏：搬完重新校验仍失败，报 failed', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_repair_corrupt_source';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    // 手工制造半成品：report 已进 processed，context 还留在 pending —— 但它是坏的
    await mkdir(join(bufferDir, 'processed'), { recursive: true });
    await writeFile(
      join(bufferDir, 'processed', 'report_1.json'),
      await readFile(join(bufferDir, 'pending', 'report_1.json'), 'utf8'),
      'utf8',
    );
    await rm(join(bufferDir, 'pending', 'report_1.json'));
    await writeFile(join(bufferDir, 'pending', 'context_1.json'), '{ not json', 'utf8');

    const outcome = await repo.archiveBuffer(role_id, 1);
    expect(outcome.status).toBe('failed');
    // 搬是搬过去了，但内容仍然读不出来——不能因为「文件现在在目标分区」就报修好
    await expect(
      readFile(join(bufferDir, 'processed', 'context_1.json'), 'utf8'),
    ).resolves.toBeTruthy();
    await expect(repo.getStoredBuffer(role_id, 1)).resolves.toMatchObject({
      location: 'processed',
      agentContextStatus: 'unreadable',
    });
  });

  it('补搬的源 context 完好：报 archived，目标分区可整对读回', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_repair_healthy';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await mkdir(join(bufferDir, 'processed'), { recursive: true });
    await writeFile(
      join(bufferDir, 'processed', 'report_1.json'),
      await readFile(join(bufferDir, 'pending', 'report_1.json'), 'utf8'),
      'utf8',
    );
    await rm(join(bufferDir, 'pending', 'report_1.json'));

    await expect(repo.archiveBuffer(role_id, 1)).resolves.toEqual({ status: 'archived' });
    await expect(repo.getStoredBuffer(role_id, 1)).resolves.toMatchObject({
      location: 'processed',
      agentContextStatus: 'present',
    });
  });
});

/**
 * 「context 落了、report 没落」留下的孤儿 context。
 *
 * 配对写入的顺序是 context 先落、report 后落（report 才是提交点），所以 report 写失败时
 * 合法的残留就是一份**没人引用的** context 文件。两个后果必须一起堵住：
 *
 *   1. 那个 seq 已经烧掉了——下一次分配绝不能再用它（否则新 Buffer 会踩在同一份孤儿上）；
 *   2. 读侧不能把孤儿 context 绑给任何一条报告——只有声明过 context_snapshot_ref 的报告
 *      才有资格去读同 seq 的 context 文件。没有声明过的报告读回来必须是 absent。
 *
 * 这两条都不能靠「把孤儿删干净」来保证：删不掉（权限/占位/崩溃）正是要覆盖的情形。
 */
describe('FileBufferRepository：孤儿 context 与 seq 复用', () => {
  it('context 落了、report 写失败且孤儿清不掉：seq 烧掉，孤儿不被任何报告认领', async () => {
    const removed: string[] = [];
    const { repo, agentStateRoot } = await createRepository({
      removeSourceFile: async (path) => {
        removed.push(path);
        throw Object.assign(new Error('EPERM: context is locked'), { code: 'EPERM' });
      },
    });
    const role_id = 'role_orphan_context';
    const pendingDir = join(agentStateRoot, role_id, 'buffer', 'pending');
    await repo.ensureAgent(role_id);
    await expect(
      repo.saveBufferSnapshot(role_id, sampleBufferSnapshot({ task_id: 'task_first' })),
    ).resolves.toMatchObject({ seq: 1 });

    // 让 seq=2 的 report 写不进去：临时文件路径被非空目录占位（写 .tmp 就失败，
    // 连 rename 都到不了，pending 里因此不会出现任何叫 report_2.json 的东西）
    await mkdir(join(pendingDir, 'report_2.json.tmp'), { recursive: true });
    await writeFile(join(pendingDir, 'report_2.json.tmp', 'blocker'), 'x', 'utf8');

    await expect(
      repo.saveBufferSnapshot(
        role_id,
        sampleBufferSnapshot({ task_id: 'task_orphan' }),
        sampleAgentContext(role_id),
      ),
    ).rejects.toThrow();

    // 孤儿 context 确实落了盘、也确实没被清掉（清孤儿那次删除被注入的 EPERM 挡下）
    expect(removed.some((path) => path.endsWith('context_2.json'))).toBe(true);
    await expect(readFile(join(pendingDir, 'context_2.json'), 'utf8')).resolves.toBeTruthy();
    // report 一次都没落成：pending 里没有 report_2.json 这份报告
    await expect(readFile(join(pendingDir, 'report_2.json'), 'utf8')).rejects.toThrow();
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([1]);

    // 下一条 Buffer 绝不拿到 2：这个 seq 已经被那次 context 写入用掉了
    await rm(join(pendingDir, 'report_2.json.tmp'), { recursive: true, force: true });
    const next = await repo.saveBufferSnapshot(
      role_id,
      sampleBufferSnapshot({ task_id: 'task_next' }),
    );
    expect(next.seq).toBe(3);
    await expect(
      readFile(join(pendingDir, 'context_2.json'), 'utf8'),
    ).resolves.toBeTruthy();

    // 拿孤儿所在的 seq 写一条**没有** context_snapshot_ref 的历史报告：
    // 它必须报 absent，绝不把那份孤儿 context 当成自己的上下文
    const { context_snapshot_ref: _dropped, ...legacy } = sampleBufferSnapshot({
      task_id: 'task_legacy',
    });
    await writeFile(join(pendingDir, 'report_2.json'), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

    const legacyRead = await repo.getPendingBuffer(role_id, 2);
    expect(legacyRead?.snapshot.task_id).toBe('task_legacy');
    expect(legacyRead?.agentContextStatus).toBe('absent');
    expect(legacyRead?.agentContext).toBeUndefined();
    expect(legacyRead?.agentContextError).toBeUndefined();
    await expect(repo.getStoredBuffer(role_id, 2)).resolves.toMatchObject({
      location: 'pending',
      agentContextStatus: 'absent',
    });
    // 紧接着这条新 Buffer 本身没有上下文：它照样报 absent，不会被 seq=2 的孤儿影响
    await expect(repo.getPendingBuffer(role_id, 3)).resolves.toMatchObject({
      agentContextStatus: 'absent',
    });

    // 同一份文件损坏时：只有**声明了引用**的报告才会去读它，读坏了就如实报 unreadable
    const declaring = {
      ...sampleBufferSnapshot({ task_id: 'task_declaring' }),
      context_snapshot_ref: '2',
    };
    await writeFile(
      join(pendingDir, 'report_2.json'),
      `${JSON.stringify(declaring, null, 2)}\n`,
      'utf8',
    );
    await writeFile(join(pendingDir, 'context_2.json'), '{ not json', 'utf8');

    const broken = await repo.getPendingBuffer(role_id, 2);
    expect(broken?.agentContextStatus).toBe('unreadable');
    expect(broken?.agentContextError).toMatch(/context_2\.json/);
    expect(broken?.snapshot.task_id).toBe('task_declaring');
  });

  it('重启后仍不复用那个 seq：meta 也没记住时，靠目录里的 context 文件兜住', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_orphan_restart';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    const pendingDir = join(bufferDir, 'pending');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot({ task_id: 'task_first' }));

    // 手工制造孤儿：context 落了、report 没落
    await writeFile(
      join(pendingDir, 'context_4.json'),
      `${JSON.stringify(sampleAgentContext(role_id), null, 2)}\n`,
      'utf8',
    );
    // 并把 meta 退回「那次写入之前」的样子（游标没记住）：目录是唯一的记忆
    await writeFile(
      join(bufferDir, 'buffer_meta.json'),
      `${JSON.stringify(
        { role_id, pending_count: 1, cursor: 1, total_processed: 0, total_dead_letters: 0 },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const restarted = new FileBufferRepository({ agentStateRoot });
    const saved = await restarted.saveBufferSnapshot(
      role_id,
      sampleBufferSnapshot({ task_id: 'task_after_restart' }),
    );

    expect(saved.seq).toBe(5);
    // 孤儿没被静默删掉：它还在原地，只是再也不会被分配给谁、也不会被谁认领
    await expect(readFile(join(pendingDir, 'context_4.json'), 'utf8')).resolves.toBeTruthy();
    await expect(readFile(join(pendingDir, 'report_4.json'), 'utf8')).rejects.toThrow();
    await expect(restarted.getPendingBuffer(role_id, 4)).resolves.toBeUndefined();
    // 启动时的校正也把游标接回了目录里的真实上界
    await expect(restarted.ensureAgent(role_id)).resolves.toBeUndefined();
    await expect(restarted.getBufferMeta(role_id)).resolves.toMatchObject({
      cursor: 5,
      pending_count: 2,
    });
  });
});

/**
 * meta 是文件分区的**投影**，不是独立的事实来源。归档把 report / context 搬进
 * processed，这个事实已经落地；此刻写 meta 失败不该把归档翻成失败，但也绝不能让
 * total_processed / total_dead_letters 永久少计——它们是「++/--」的账本，丢一次就再也回不来。
 * 所以每个数字都从目录重数：写失败只是这次没写上，下一次成功操作（或下次启动）整体校正。
 */
describe('FileBufferRepository：归档 meta 的可恢复性', () => {
  /** 让 buffer_meta.json 写得进去就读得出来地失败：临时文件路径被非空目录占位 */
  async function blockMetaWrites(bufferDir: string): Promise<void> {
    await mkdir(join(bufferDir, 'buffer_meta.json.tmp'), { recursive: true });
    await writeFile(join(bufferDir, 'buffer_meta.json.tmp', 'blocker'), 'x', 'utf8');
  }

  it('归档时 meta 写不进去：归档照样落地，下一次成功操作把累计计数校正回来', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_meta_heal';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    for (const seq of [1, 2]) {
      await repo.saveBufferSnapshot(
        role_id,
        sampleBufferSnapshot({ task_id: `task_${String(seq)}` }),
        sampleAgentContext(role_id),
      );
    }

    await blockMetaWrites(bufferDir);
    await expect(repo.archiveBuffer(role_id, 1)).resolves.toEqual({ status: 'archived' });

    // 归档事实以文件分区为准：报告与上下文都已经离开 pending
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([2]);
    await expect(repo.getStoredBuffer(role_id, 1)).resolves.toMatchObject({
      location: 'processed',
      agentContextStatus: 'present',
    });
    // 而 meta 停在写失败之前：这一次归档的计数没记上
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      pending_count: 2,
      total_processed: 0,
    });

    // 放开 meta 之后下一次成功操作（一次保存）就把落后整体校正，而不是「补加一次」
    await rm(join(bufferDir, 'buffer_meta.json.tmp'), { recursive: true, force: true });
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot({ task_id: 'task_3' }));
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      pending_count: 2,
      total_processed: 1,
    });

    // 重复归档同一条（already_archived）与继续归档新的，都不会重复累计
    await expect(repo.archiveBuffer(role_id, 1)).resolves.toEqual({ status: 'already_archived' });
    await expect(repo.archiveBuffer(role_id, 2)).resolves.toEqual({ status: 'archived' });
    await expect(repo.archiveBuffer(role_id, 3)).resolves.toEqual({ status: 'archived' });
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      pending_count: 0,
      total_processed: 3,
    });
  });

  it('重启（ensureAgent）时按目录修复 meta：漏记的累计计数自己回来', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_meta_restart_heal';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await blockMetaWrites(bufferDir);
    await expect(repo.archiveBuffer(role_id, 1)).resolves.toEqual({ status: 'archived' });
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({ total_processed: 0 });

    await rm(join(bufferDir, 'buffer_meta.json.tmp'), { recursive: true, force: true });
    const restarted = new FileBufferRepository({ agentStateRoot });
    await restarted.ensureAgent(role_id);

    await expect(restarted.getBufferMeta(role_id)).resolves.toMatchObject({
      pending_count: 0,
      cursor: 1,
      total_processed: 1,
      total_dead_letters: 0,
    });
  });

  it('meta 本身损坏：启动时按目录重建，而不是让整个 buffer 存储不可用', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_meta_corrupt_heal';
    const bufferDir = join(agentStateRoot, role_id, 'buffer');
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await repo.markBufferDeadLetter(role_id, 1, 'extraction failed');
    await writeFile(join(bufferDir, 'buffer_meta.json'), '{ not json', 'utf8');

    const restarted = new FileBufferRepository({ agentStateRoot });
    await restarted.ensureAgent(role_id);

    await expect(restarted.getBufferMeta(role_id)).resolves.toMatchObject({
      cursor: 1,
      pending_count: 0,
      total_processed: 0,
      total_dead_letters: 1,
    });
  });
});
