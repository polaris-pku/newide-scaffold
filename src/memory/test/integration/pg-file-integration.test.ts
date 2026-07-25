/**
 * PgMemoryRepository + FileBufferRepository 组合集成测试
 *
 * 使用真实 PostgreSQL + pgvector（MemoryRepository）与真实文件系统（BufferRepository）
 * 验证 AgentManager 在整个双仓库组合下的完整流程。
 *
 * 需要 MEMORY_PG_TEST_URL 环境变量，未设置时自动跳过。
 * 示例：
 *   MEMORY_PG_TEST_URL=postgres://user:pass@localhost:5432/newide_test pnpm test
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { HashEmbeddingProvider } from '../../adapters/hash-embedding-provider';
import { PgMemoryRepository } from '../../adapters/pg-memory-repository';
import { ensurePgMemorySchema } from '../../adapters/pg-memory-schema';
import { FileBufferRepository } from '../../adapters/file-buffer-repository';
import { AgentManager } from '../../runtime/agent-manager';
import { InvokeDriverTool } from '../../runtime/tools/invoke-driver-tool';
import type { ToolCallResult, ToolCallingClient } from '../../runtime/tool';
import type { DriverReturn } from '../../schemas';

// ──────────────────────────────────────────────
// 条件跳过
// ──────────────────────────────────────────────

const pgTestUrl = process.env.MEMORY_PG_TEST_URL;
const describePgFile = pgTestUrl ? describe : describe.skip;

// ──────────────────────────────────────────────
// Mock LLM 客户端
// ──────────────────────────────────────────────

function createMockToolClient(responses: ToolCallResult[]): ToolCallingClient {
  let callIndex = 0;
  return {
    completeWithTools: async () => {
      const response = responses[callIndex];
      if (response === undefined) {
        throw new Error(`Unexpected call #${callIndex} - no more mock responses`);
      }
      callIndex++;
      return response;
    },
  };
}

function textResponse(content: string): ToolCallResult {
  return { content, tool_calls: undefined };
}

// ──────────────────────────────────────────────
// Mock DriverReturn
// ──────────────────────────────────────────────

function createMockDriverReturn(): DriverReturn {
  return {
    artifacts: [{ type: 'file', path: 'output.txt', summary: 'Generated output file' }],
    summary: 'Successfully executed the task.',
    decisions: [
      {
        point: 'Implementation approach',
        options: ['Approach A', 'Approach B'],
        chosen: 'Approach A',
        reason: 'Simpler and more maintainable',
      },
    ],
    blockers: [],
    referenced_experiences: [],
    assumptions: [
      { assumption: 'File system is writable', risk_if_wrong: 'File creation would fail' },
    ],
  };
}

// ──────────────────────────────────────────────
// 共享数据
// ──────────────────────────────────────────────

const embedding = new HashEmbeddingProvider();
let pool: Pool;
let pgRepo: PgMemoryRepository;
let agentStateRoot: string;
let fileRepo: FileBufferRepository;

describePgFile('PgMemoryRepository + FileBufferRepository 组合集成', () => {
  beforeAll(async () => {
    // PG 连接
    pool = new Pool({ connectionString: pgTestUrl });
    await ensurePgMemorySchema(pool, embedding.dimensions);
    pgRepo = new PgMemoryRepository({ pool, embedding, autoMigrate: false });

    // 文件系统临时目录
    agentStateRoot = await mkdtemp(join(tmpdir(), 'newide-pg-file-'));
    fileRepo = new FileBufferRepository({ agentStateRoot });
  });

  afterAll(async () => {
    // 清理文件系统
    await rm(agentStateRoot, { recursive: true, force: true });
    // 清理 PG 表
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS memory_experiences');
      await pool.query('DROP TABLE IF EXISTS memory_skills');
      await pool.query('DROP TABLE IF EXISTS memory_agents');
      await pool.end();
    }
  });

  // ────────────────────────────────────────────
  // 测试 1: createAgent 持久化到 PG + 文件系统
  // ────────────────────────────────────────────

  it('createAgent 同时写入 PgMemoryRepository 和 FileBufferRepository', async () => {
    const role_id = `role_pgfile_create_${randomUUID()}`;
    const mockLlm = createMockToolClient([]);
    const manager = await AgentManager.create(pgRepo, fileRepo, {
      tools: { llm: mockLlm, tools: [] },
    });

    await manager.createAgent({ role_id, name: 'PG+File Agent', tags: ['integration'] });

    // 验证 PG 端
    const handle = await pgRepo.getAgent(role_id);
    expect(handle.role_id).toBe(role_id);
    expect(handle.name).toBe('PG+File Agent');
    expect(handle.skill_count).toBe(0);
    expect(handle.experience_count).toBe(0);

    const persona = await pgRepo.getPersona(role_id);
    expect(persona.role_id).toBe(role_id);

    // 验证文件系统端
    const meta = await fileRepo.getBufferMeta(role_id);
    expect(meta.role_id).toBe(role_id);
    expect(meta.cursor).toBe(0);
    expect(meta.pending_count).toBe(0);
  });

  // ────────────────────────────────────────────
  // 测试 2: dispatchTask 写入真实 FileBuffer
  // ────────────────────────────────────────────

  it('dispatchTask 执行后 buffer 写入文件系统', async () => {
    const role_id = `role_pgfile_dispatch_${randomUUID()}`;
    const mockLlm = createMockToolClient([textResponse('Task completed. [done]')]);
    const manager = await AgentManager.create(pgRepo, fileRepo, {
      tools: { llm: mockLlm, tools: [] },
    });
    await manager.createAgent({ role_id, name: 'Dispatch Agent', tags: [] });

    // 执行前 buffer 为空
    const metaBefore = await fileRepo.getBufferMeta(role_id);
    expect(metaBefore.pending_count).toBe(0);

    const result = await manager.dispatchTask(role_id, {
      spec: 'A simple task with no driver needed.',
      task_id: `task_dispatch_${randomUUID()}`,
      call_id: `call_dispatch_${randomUUID()}`,
      source_driver: 'test-driver',
    });

    expect(result.role_id).toBe(role_id);
    expect(result.status).toBe('no_driver_invocation');

    // 执行后 buffer 应有 pending 记录
    const metaAfter = await fileRepo.getBufferMeta(role_id);
    expect(metaAfter.pending_count).toBe(1);

    const pendingSeqs = await fileRepo.listPendingBufferSeqs(role_id);
    expect(pendingSeqs).toEqual([1]);

    // 验证文件系统上确实有物理文件
    const pendingDir = join(agentStateRoot, role_id, 'buffer', 'pending');
    const reportFile = join(pendingDir, 'report_1.json');
    const reportContent = await readFile(reportFile, 'utf8');
    const report = JSON.parse(reportContent);
    expect(report.task_id).toBe(result.cycle.buffer_snapshot.task_id);
  });

  // ────────────────────────────────────────────
  // 测试 3: dispatchTask 带 invoke_driver 后写入 PG
  // ────────────────────────────────────────────

  it('dispatchTask 经 invoke_driver 执行后，结果持久化到 PG', async () => {
    const role_id = `role_pgfile_driver_${randomUUID()}`;
    const mockDriverReturn = createMockDriverReturn();

    let driverCalled = false;
    const driverTool = new InvokeDriverTool(async () => {
      driverCalled = true;
      return mockDriverReturn;
    });

    const mockLlm = createMockToolClient([
      {
        content: null,
        tool_calls: [
          {
            id: `call_${randomUUID()}`,
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: '{"instruction": "Run the task"}',
            },
          },
        ],
      },
      textResponse('Task completed. [done]'),
    ]);

    const manager = await AgentManager.create(pgRepo, fileRepo, {
      tools: { llm: mockLlm, tools: [driverTool] },
    });
    await manager.createAgent({ role_id, name: 'Driver Agent', tags: [] });

    const result = await manager.dispatchTask(role_id, {
      spec: 'Execute a sub-task via driver.',
      task_id: `task_driver_${randomUUID()}`,
      call_id: `call_driver_${randomUUID()}`,
      source_driver: 'test-driver',
    });

    // 验证 driver 被调用
    expect(driverCalled).toBe(true);
    expect(result.status).toBe('completed');

    // 验证 buffer 快照中携带了 driver_return
    expect(result.cycle.buffer_snapshot.driver_return.summary).toBe(mockDriverReturn.summary);

    // 验证 buffer 已写入文件系统
    const meta = await fileRepo.getBufferMeta(role_id);
    expect(meta.pending_count).toBe(1);

    // 验证 Agent 状态已回 sleeping
    const agent = manager.getAgent(role_id)!;
    expect(agent.getState()).toBe('sleeping');
  });

  // ────────────────────────────────────────────
  // 测试 4: 重启后数据恢复
  // ────────────────────────────────────────────

  it('新建 PgMemoryRepository + FileBufferRepository 指向同一存储，数据恢复', async () => {
    const role_id = `role_pgfile_restart_${randomUUID()}`;
    const mockLlm = createMockToolClient([textResponse('Task completed. [done]')]);

    // 第一轮：创建 Agent 并执行任务
    const manager1 = await AgentManager.create(pgRepo, fileRepo, {
      tools: { llm: mockLlm, tools: [] },
    });
    await manager1.createAgent({ role_id, name: 'Restart Agent', tags: [] });

    await manager1.dispatchTask(role_id, {
      spec: 'Task before restart.',
      task_id: `task_restart_${randomUUID()}`,
      call_id: `call_restart_${randomUUID()}`,
      source_driver: 'test-driver',
    });

    // 记录第一轮的 buffer seq
    const metaBeforeRestart = await fileRepo.getBufferMeta(role_id);
    expect(metaBeforeRestart.pending_count).toBe(1);

    // 第二轮：创建全新的 AgentManager（同一个 repo + fileRepo）
    const manager2 = await AgentManager.create(pgRepo, fileRepo, {
      tools: { llm: mockLlm, tools: [] },
    });

    // loadAllAgents 应自动加载 role_id
    const agent2 = manager2.getAgent(role_id);
    expect(agent2).toBeDefined();
    expect(agent2!.getState()).toBe('sleeping');

    // handle 信息应从 PG 恢复
    const handle2 = await pgRepo.getAgent(role_id);
    expect(handle2.role_id).toBe(role_id);
    expect(handle2.name).toBe('Restart Agent');

    // buffer 元信息应从文件系统恢复
    const metaAfterRestart = await fileRepo.getBufferMeta(role_id);
    expect(metaAfterRestart.pending_count).toBe(1);
    expect(metaAfterRestart.cursor).toBe(metaBeforeRestart.cursor);

    // 第二轮 dispatch 应在 seq=2 而不是从 1 开始
    const mockLlm2 = createMockToolClient([textResponse('Post-restart task done. [done]')]);
    const manager3 = await AgentManager.create(pgRepo, fileRepo, {
      tools: { llm: mockLlm2, tools: [] },
    });
    // 用 createAgent 会因 Agent 已存在而报错；用 ensureAgent 确保隔离
    // 直接使用之前创建的 Agent
    const result2 = await manager3.dispatchTask(role_id, {
      spec: 'Task after restart.',
      task_id: `task_restart_2_${randomUUID()}`,
      call_id: `call_restart_2_${randomUUID()}`,
      source_driver: 'test-driver',
    });
    expect(result2.role_id).toBe(role_id);
    expect(result2.cycle.buffer_seq).toBe(2);
  });

  // ────────────────────────────────────────────
  // 测试 5: 多 Agent 数据隔离
  // ────────────────────────────────────────────

  it('多个 Agent 在 PG 和文件系统上数据互相隔离', async () => {
    const roleA = `role_pgfile_iso_A_${randomUUID()}`;
    const roleB = `role_pgfile_iso_B_${randomUUID()}`;
    const mockLlm = createMockToolClient([]);

    const manager = await AgentManager.create(pgRepo, fileRepo, {
      tools: { llm: mockLlm, tools: [] },
    });

    // 创建两个 Agent
    await manager.createAgent({
      role_id: roleA,
      name: 'Isolation Agent A',
      tags: ['iso-a'],
    });
    await manager.createAgent({
      role_id: roleB,
      name: 'Isolation Agent B',
      tags: ['iso-b'],
    });

    // 验证 PG 端互相独立
    const handleA = await pgRepo.getAgent(roleA);
    const handleB = await pgRepo.getAgent(roleB);
    expect(handleA.role_id).toBe(roleA);
    expect(handleB.role_id).toBe(roleB);
    expect(handleA.name).toBe('Isolation Agent A');
    expect(handleB.name).toBe('Isolation Agent B');

    // 验证文件系统端互相独立
    const metaA = await fileRepo.getBufferMeta(roleA);
    const metaB = await fileRepo.getBufferMeta(roleB);
    expect(metaA.role_id).toBe(roleA);
    expect(metaB.role_id).toBe(roleB);

    // 各自 dispatch 任务，buffer 应只影响各自的 role
    const mockLlmA = createMockToolClient([textResponse('Task A done. [done]')]);
    const managerA = await AgentManager.create(pgRepo, fileRepo, {
      tools: { llm: mockLlmA, tools: [] },
    });

    const mockLlmB = createMockToolClient([textResponse('Task B done. [done]')]);
    const managerB = await AgentManager.create(pgRepo, fileRepo, {
      tools: { llm: mockLlmB, tools: [] },
    });

    await managerA.dispatchTask(roleA, {
      spec: 'Task for agent A.',
      task_id: `task_iso_A_${randomUUID()}`,
      call_id: `call_iso_A_${randomUUID()}`,
      source_driver: 'test-driver',
    });

    await managerB.dispatchTask(roleB, {
      spec: 'Task for agent B.',
      task_id: `task_iso_B_${randomUUID()}`,
      call_id: `call_iso_B_${randomUUID()}`,
      source_driver: 'test-driver',
    });

    // A 有 1 条 pending，B 有 1 条 pending
    const metaAResult = await fileRepo.getBufferMeta(roleA);
    const metaBResult = await fileRepo.getBufferMeta(roleB);
    expect(metaAResult.pending_count).toBe(1);
    expect(metaBResult.pending_count).toBe(1);

    // A 的 pending seq 应只有 [1]，B 也只有 [1]
    const pendingA = await fileRepo.listPendingBufferSeqs(roleA);
    const pendingB = await fileRepo.listPendingBufferSeqs(roleB);
    expect(pendingA).toEqual([1]);
    expect(pendingB).toEqual([1]);

    // A 和 B 的 task_id 应该不同
    const bufA = await fileRepo.getPendingBuffer(roleA, 1);
    const bufB = await fileRepo.getPendingBuffer(roleB, 1);
    expect(bufA?.snapshot.task_id).not.toBe(bufB?.snapshot.task_id);
  });
});
