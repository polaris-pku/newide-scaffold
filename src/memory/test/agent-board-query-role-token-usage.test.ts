/**
 * Agent Board 上角色的累计用量取自**账本**，而不是档案。
 *
 * 档案里的 `AgentMetrics.token_cost_total` 只有种子把它初始化成 0，全仓没有写入方，所以
 * 这一组真正守的是**两种「没有数字」不能混为一谈**：
 *
 * - 账本里有这个角色的行、合计恰好是 0 → 显示 0（那是真数）；
 * - 账本里没有这个角色的行 / 调用方没接账本 → 保留档案原值，不编一个 0。
 *
 * 最后一条「不改存储」是刻意的：`memory_agents.metrics` 是整块 JSONB 覆盖写，往它上面
 * 做累计正是账本当初要绕开的失效模式（两个角色并发丢一次自增）。覆盖只发生在这一层
 * 只读投影里。
 */
import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { RepositoryAgentBoardQuery } from '../adapters/agent-board-query';
import type { RoleTokenUsageReader } from '../ports/role-token-usage';

/** 只回一个固定值的取数口，并记下它被问过哪些角色。 */
function readerReturning(value: number | undefined): {
  reader: RoleTokenUsageReader;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    reader: {
      totalBilledTokens: (roleId: string) => {
        asked.push(roleId);
        return value;
      },
    },
  };
}

/** 建一个角色，并把档案里那一格设成 `persistedTokens`。 */
async function seedAgent(roleId: string, persistedTokens: number): Promise<InMemoryRepository> {
  const repo = new InMemoryRepository();
  await repo.initializeAgent({ role_id: roleId, name: roleId });
  if (persistedTokens !== 0) {
    await repo.updateMetrics(roleId, (metrics) => ({ ...metrics, token_cost_total: persistedTokens }));
  }
  return repo;
}

describe('RepositoryAgentBoardQuery — 角色累计用量', () => {
  it('账本有数时覆盖档案里那一格，且只问被查询的角色', async () => {
    const repo = await seedAgent('role_a', 0);
    const { reader, asked } = readerReturning(163_420);
    const query = new RepositoryAgentBoardQuery(repo, reader);

    const view = await query.getAgent('role_a');

    expect(view.metrics.raw.token_cost_total).toBe(163_420);
    expect(asked).toEqual(['role_a']);
  });

  it('账本合计确实是 0 时覆盖成 0——「有行且为 0」与「没有行」不是一回事', async () => {
    const repo = await seedAgent('role_a', 777);
    const query = new RepositoryAgentBoardQuery(repo, readerReturning(0).reader);

    expect((await query.getAgent('role_a')).metrics.raw.token_cost_total).toBe(0);
  });

  it('取不到时保留档案原值，不把缺席折算成 0', async () => {
    const repo = await seedAgent('role_a', 777);
    const query = new RepositoryAgentBoardQuery(repo, readerReturning(undefined).reader);

    expect((await query.getAgent('role_a')).metrics.raw.token_cost_total).toBe(777);
  });

  it('没接账本时行为与从前一致', async () => {
    const repo = await seedAgent('role_a', 777);
    const query = new RepositoryAgentBoardQuery(repo);

    expect((await query.getAgent('role_a')).metrics.raw.token_cost_total).toBe(777);
  });

  it('覆盖只发生在投影层：存储里那一格不被改动', async () => {
    const repo = await seedAgent('role_a', 5);
    const query = new RepositoryAgentBoardQuery(repo, readerReturning(1000).reader);

    const view = await query.getAgent('role_a');

    expect(view.metrics.raw.token_cost_total).toBe(1000);
    expect((await repo.getMetrics('role_a')).token_cost_total).toBe(5);
    // 其余字段与派生指标照旧
    expect(view.role_id).toBe('role_a');
    expect(view.metrics.raw.role_id).toBe('role_a');
    expect(view.metrics.derived.success_rate).toBe(0);
  });
});
