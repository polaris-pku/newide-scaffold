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
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { nowTimestamp } from '../../core';
import { AgentManager } from '../runtime/agent-manager';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { InMemoryMemoryDeliveryRepository } from '../adapters/in-memory-memory-delivery';
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

/**
 * 跨存储一致性：Agent 的主实体（MemoryRepository）与从属存储（Buffer / Delivery）分属
 * 三个仓储，没有跨存储事务。这里钉死回滚与重试的规则——不允许出现「主实体已删除、从属
 * 存储没清干净又再也重试不了」或「主实体在、运行时却是半初始化」这两种状态。
 */
describe('Agent 生命周期跨存储一致性（补偿与可重试清理）', () => {
  async function setupWithDelivery() {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    const deliveryRepository = new InMemoryMemoryDeliveryRepository();
    const manager = await AgentManager.create(repository, bufferRepository, {
      tools: mockTools,
      deliveryRepository,
    });
    return { repository, bufferRepository, deliveryRepository, manager };
  }

  it('Buffer 初始化失败：createAgent 回滚，不留下半初始化 Agent', async () => {
    const { manager, repository, bufferRepository } = await setupWithDelivery();
    const spy = vi
      .spyOn(bufferRepository, 'ensureAgent')
      .mockRejectedValueOnce(new Error('buffer store unavailable'));

    await expect(manager.createAgent({ role_id: 'role_half', name: 'Half' })).rejects.toThrow(
      /buffer store unavailable/,
    );
    spy.mockRestore();

    // 主实体被回滚：既不在仓库里，也不在内存 map 里，listAgentIds 发现不了它
    await expect(repository.getAgent('role_half')).rejects.toThrow(/Agent not found/);
    expect(await repository.listAgentIds()).not.toContain('role_half');
    expect(manager.getAgent('role_half')).toBeUndefined();
  });

  it('Delivery 初始化失败：createAgent 回滚干净，可安全重试', async () => {
    const { manager, repository, deliveryRepository } = await setupWithDelivery();
    const spy = vi
      .spyOn(deliveryRepository, 'ensureAgent')
      .mockRejectedValueOnce(new Error('delivery store unavailable'));

    await expect(manager.createAgent({ role_id: 'role_deliv', name: 'D' })).rejects.toThrow(
      /delivery store unavailable/,
    );
    await expect(repository.getAgent('role_deliv')).rejects.toThrow(/Agent not found/);

    // 重试（spy 已耗尽）成功：回滚彻底才不会撞 initializeAgent 的「已存在」
    const handle = await manager.createAgent({ role_id: 'role_deliv', name: 'D' });
    expect(handle.role_id).toBe('role_deliv');
    spy.mockRestore();
  });

  it('Buffer 删除失败：主 Agent 仍在，重试可完成剩余清理', async () => {
    const { manager, repository, bufferRepository } = await setupWithDelivery();
    await manager.createAgent({ role_id: 'role_del_fail', name: 'X' });

    vi.spyOn(bufferRepository, 'deleteAgent').mockRejectedValueOnce(new Error('EIO buffer'));
    await expect(manager.deleteAgent('role_del_fail', { force: true })).rejects.toThrow(
      /EIO buffer/,
    );

    // 主实体没被删：它就是「还没清完」的标记，可被重新发现并重试
    await expect(repository.getAgent('role_del_fail')).resolves.toMatchObject({
      role_id: 'role_del_fail',
    });
    expect(manager.getAgent('role_del_fail')).toBeDefined();

    await manager.deleteAgent('role_del_fail', { force: true });
    await expect(repository.getAgent('role_del_fail')).rejects.toThrow(/Agent not found/);
    expect(manager.getAgent('role_del_fail')).toBeUndefined();
  });

  it('Delivery 删除失败：主 Agent 仍在，重试可完成剩余清理', async () => {
    const { manager, repository, deliveryRepository } = await setupWithDelivery();
    await manager.createAgent({ role_id: 'role_deliv_del', name: 'Y' });

    vi.spyOn(deliveryRepository, 'deleteAgent').mockRejectedValueOnce(new Error('EIO delivery'));
    await expect(manager.deleteAgent('role_deliv_del', { force: true })).rejects.toThrow(
      /EIO delivery/,
    );
    await expect(repository.getAgent('role_deliv_del')).resolves.toBeDefined();

    await manager.deleteAgent('role_deliv_del', { force: true });
    await expect(repository.getAgent('role_deliv_del')).rejects.toThrow(/Agent not found/);
  });

  it('退休收尾中途失败：主实体仍在，重试补完从属存储清理', async () => {
    const { manager, repository, bufferRepository } = await setupWithDelivery();
    await manager.createAgent({ role_id: 'role_retire_retry', name: 'Z' });

    // 归档写成功、随后 Buffer 清理失败
    const spy = vi
      .spyOn(bufferRepository, 'deleteAgent')
      .mockRejectedValueOnce(new Error('EIO buffer'));
    await expect(manager.retireAgent('role_retire_retry')).rejects.toThrow(/EIO buffer/);
    spy.mockRestore();

    // 归档已在（finalize 先写归档），实体也还在——可被重新发现并重试
    expect(await repository.getAgentArchive('role_retire_retry')).not.toBeNull();
    await expect(repository.getAgent('role_retire_retry')).resolves.toBeDefined();

    // 重试走已归档分支，把没做完的清理补上
    const retried = await manager.retireAgent('role_retire_retry');
    expect(retried.status).toBe('retired');
    await expect(repository.getAgent('role_retire_retry')).rejects.toThrow(/Agent not found/);
    expect(manager.getAgent('role_retire_retry')).toBeUndefined();
  });

  it('替代 Agent 的 Buffer 初始化失败：替代实体整段回滚，原 Agent 可安全重试退休', async () => {
    const { manager, repository, bufferRepository, deliveryRepository } = await setupWithDelivery();
    const sourceId = 'role_repl_buffer_fail';
    const replacementId = `${sourceId}__replacement`;
    await manager.createAgent({ role_id: sourceId, name: 'Source', tags: ['typescript'] });

    // 源 Agent 已完全建好，失败只发生在替代 Agent 的从属存储上
    const spy = vi
      .spyOn(bufferRepository, 'ensureAgent')
      .mockRejectedValueOnce(new Error('replacement buffer store unavailable'));

    await expect(
      manager.retireAgent(sourceId, { reason: 'persona_drift', replacement: 'clean_slate' }),
    ).rejects.toThrow(/replacement buffer store unavailable/);
    spy.mockRestore();

    // 替代 Agent 被回滚干净：仓库、内存 map、Buffer、交付存储都不留残渣。
    // 留下任何一样，listAgentIds 就会发现一个派发时必炸的半初始化 Agent。
    await expect(repository.getAgent(replacementId)).rejects.toThrow(/Agent not found/);
    expect(await repository.listAgentIds()).not.toContain(replacementId);
    expect(manager.getAgent(replacementId)).toBeUndefined();
    await expect(bufferRepository.listPendingBufferSeqs(replacementId)).rejects.toThrow(
      /Buffer store not found/,
    );
    await expect(
      deliveryRepository.listContextDeliveries({ role_id: replacementId }),
    ).resolves.toEqual([]);
    // 归档还没写：源 Agent 仍是 draining，连归档都没有，谈不上退休完成
    expect(await repository.getAgentArchive(sourceId)).toBeNull();

    // 重试：源 Agent 与退休意图都还在（pendingRetirement 没被失败清掉），
    // 所以这一次能真的退休，并按同一策略建出替代 Agent
    const retried = await manager.retireAgent(sourceId);
    expect(retried.status).toBe('retired');
    expect(retried.replacement_role_id).toBe(replacementId);
    await expect(repository.getAgent(sourceId)).rejects.toThrow(/Agent not found/);
    await expect(repository.getAgent(replacementId)).resolves.toMatchObject({
      status: 'created',
      tags: ['typescript'],
    });
    expect(manager.getAgent(replacementId)).toBeDefined();
  });

  it('seeded_slate 继承经验中途失败：替代 Agent 与其已写入的继承经验一并回滚', async () => {
    const { manager, repository, bufferRepository } = await setupWithDelivery();
    const sourceId = 'role_repl_seed_fail';
    const replacementId = `${sourceId}__replacement`;
    await manager.createAgent({ role_id: sourceId, name: 'Seed Source', tags: ['typescript'] });
    // 两条 Level A 经验（confidence >= 0.9 且 referenced_count >= 3）→ 都会被继承
    for (const taskId of ['task_seed_a', 'task_seed_b']) {
      await repository.saveExperience(sourceId, {
        id: randomUUID(),
        description: 'Level A lesson',
        description_embedding: [],
        content: 'Lesson content',
        confidence: 0.95,
        tags: ['typescript'],
        agent_id: sourceId,
        confidence_history: [],
        referenced_count: 4,
        source_task_id: taskId,
        source_driver: 'mock-driver',
        type: 'positive',
        created_at: nowTimestamp(),
        updated_at: nowTimestamp(),
      });
    }

    // 第 2 条继承经验写入失败 → 替代 Agent 主实体与第 1 条经验都已经落库了
    const originalSave = repository.saveExperience.bind(repository);
    let inheritedWrites = 0;
    const spy = vi
      .spyOn(repository, 'saveExperience')
      .mockImplementation(async (roleId, experience) => {
        if (roleId === replacementId) {
          inheritedWrites += 1;
          if (inheritedWrites === 2) throw new Error('inherited experience write failed');
        }
        return originalSave(roleId, experience);
      });

    await expect(
      manager.retireAgent(sourceId, { replacement: 'seeded_slate' }),
    ).rejects.toThrow(/inherited experience write failed/);
    spy.mockRestore();

    // 失败确实发生在写完第 1 条之后，否则这个用例没测到「部分继承」
    expect(inheritedWrites).toBe(2);
    // 主实体连带名下经验一起没了（级联删除），没有孤儿经验留下
    await expect(repository.getAgent(replacementId)).rejects.toThrow(/Agent not found/);
    await expect(repository.listExperiences(replacementId)).rejects.toThrow(/Agent not found/);
    await expect(bufferRepository.listPendingBufferSeqs(replacementId)).rejects.toThrow(
      /Buffer store not found/,
    );
    // 源 Agent 与它自己的两条经验都没被动过
    expect(await repository.listExperiences(sourceId)).toHaveLength(2);

    // 重试成功：替代 Agent 完整建起来并继承两条 Level A 经验
    const retried = await manager.retireAgent(sourceId);
    expect(retried.status).toBe('retired');
    expect(retried.replacement_role_id).toBe(replacementId);
    const inherited = await repository.listExperiences(replacementId);
    expect(inherited).toHaveLength(2);
    expect(inherited.every((item) => item.agent_id === replacementId)).toBe(true);
  });
});

