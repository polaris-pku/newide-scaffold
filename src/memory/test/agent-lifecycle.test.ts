/**
 * Agent 生命周期（M1：memory.createAgent / updateAgent / deleteAgent）测试
 *
 * 验证：
 *   1. InMemoryRepository.updateAgentMeta：名称 / 标签更新并同步 AgentHandle
 *   2. InMemoryRepository.deleteAgent：删除后 getAgent 抛错、listAgentIds 排除
 *   3. AgentManager.deleteAgent 安全边界：活跃 Agent 拒绝、retired 后可删、
 *      市场池 Agent 拒绝
 *   4. AgentManager.deleteAgent 全链路：仓库 + buffer + 内存 map 一致，
 *      删除后 dispatchTask 返回 blocked
 *   5. 动态目录提供者（createAgentCatalogProvider）：运行时新增 Agent 立即可见
 */
import { describe, expect, it } from 'vitest';
import { AgentManager } from '../runtime/agent-manager';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { RepositoryAgentBoardQuery } from '../adapters/agent-board-query';
import { createAgentCatalogProvider } from '../../app/agent-catalog';
import { MARKET_POOL_ROLE_ID } from '../schemas';
import type { AgentToolConfig } from '../runtime/agent';
import type { AgentTaskRequest } from '../agent-types';

const mockTools: AgentToolConfig = {
  llm: {
    completeWithTools: async () => ({ content: 'Task completed. [done]', tool_calls: undefined }),
  },
  tools: [],
};

function task(id = 'task_lifecycle_001'): AgentTaskRequest {
  return {
    spec: 'Do a task.',
    task_id: id,
    call_id: `call_${id}`,
    source_driver: 'test-driver',
  };
}

async function setup() {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  const manager = await AgentManager.create(repository, bufferRepository, { tools: mockTools });
  return { repository, bufferRepository, manager };
}

describe('MemoryRepository agent lifecycle', () => {
  it('updateAgentMeta updates name and tags on the AgentHandle', async () => {
    const { repository } = await setup();
    await repository.initializeAgent({ role_id: 'role_a', name: 'Old Name', tags: ['x'] });

    await repository.updateAgentMeta('role_a', { name: 'New Name', tags: ['x', 'y'] });

    const handle = await repository.getAgent('role_a');
    expect(handle.name).toBe('New Name');
    expect(handle.tags).toEqual(['x', 'y']);
  });

  it('deleteAgent removes the agent and its owned experiences', async () => {
    const { repository } = await setup();
    await repository.initializeAgent({ role_id: 'role_a', name: 'A' });
    await repository.deleteAgent('role_a');

    await expect(repository.getAgent('role_a')).rejects.toThrow(/Agent not found/);
    expect(await repository.listAgentIds()).not.toContain('role_a');
  });

  it('deleteAgent rejects the market pool agent', async () => {
    const { repository } = await setup();
    await repository.ensureAgent(MARKET_POOL_ROLE_ID);
    await expect(repository.deleteAgent(MARKET_POOL_ROLE_ID)).rejects.toThrow(/market pool/);
  });
});

describe('AgentManager.deleteAgent', () => {
  it('rejects deletion of an active agent', async () => {
    const { manager } = await setup();
    await manager.createAgent({ role_id: 'role_active', name: 'Active' });

    await expect(manager.deleteAgent('role_active')).rejects.toThrow(/retired before deletion/);
  });

  it('deletes a retired agent end-to-end (repo + buffer + memory map)', async () => {
    const { manager, repository } = await setup();
    await manager.createAgent({ role_id: 'role_retired', name: 'Retired' });
    await manager.retireAgent('role_retired');

    await manager.deleteAgent('role_retired');

    expect(await manager.listAgentHandles()).toHaveLength(0);
    await expect(repository.getAgent('role_retired')).rejects.toThrow(/Agent not found/);
    const result = await manager.dispatchTask('role_retired', task());
    expect(result.status).toBe('blocked');
  });

  it('rejects deletion of the market pool agent', async () => {
    const { manager } = await setup();
    await expect(manager.deleteAgent(MARKET_POOL_ROLE_ID)).rejects.toThrow(/market pool/);
  });

  it('rejects deletion of an active agent without force, and hints at force', async () => {
    const { manager } = await setup();
    await manager.createAgent({ role_id: 'role_active_2', name: 'Active 2' });

    const err = await manager.deleteAgent('role_active_2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/must be retired before deletion/);
    expect((err as Error).message).toMatch(/force: true/);
  });

  it('force-deletes an active agent end-to-end (repo + buffer + memory map)', async () => {
    const { manager, repository, bufferRepository } = await setup();
    await manager.createAgent({ role_id: 'role_active_3', name: 'Active 3' });

    await manager.deleteAgent('role_active_3', { force: true });

    expect(await manager.listAgentHandles()).toHaveLength(0);
    await expect(repository.getAgent('role_active_3')).rejects.toThrow(/Agent not found/);
    const result = await manager.dispatchTask('role_active_3', task());
    expect(result.status).toBe('blocked');
    await expect(bufferRepository.listPendingBufferSeqs('role_active_3')).rejects.toThrow();
  });
});

describe('createAgentCatalogProvider', () => {
  it('includes agents created at runtime and excludes retired / council_only', async () => {
    const { repository } = await setup();
    await repository.initializeAgent({ role_id: 'role_a', name: 'A', tags: [] });
    const boardQuery = new RepositoryAgentBoardQuery(repository);
    const provider = createAgentCatalogProvider(boardQuery);

    expect(await provider()).toContain('role_a');

    // 运行时新增 Agent（等价 memory.createAgent 落库后）立即可见
    await repository.initializeAgent({ role_id: 'role_b', name: 'B', tags: [] });
    expect(await provider()).toContain('role_b');

    // retired 排除
    await repository.updateAgentStatus('role_b', 'retired');
    expect(await provider()).not.toContain('role_b');

    // council_only 排除
    await repository.initializeAgent({
      role_id: 'legacy_council',
      name: 'Legacy',
      tags: ['council_only'],
    });
    expect(await provider()).not.toContain('legacy_council');
  });
});
