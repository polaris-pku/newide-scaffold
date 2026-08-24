/**
 * AgentManager.retireAgent 测试（预退休 + 归档删除语义）
 *
 * 验证：
 *   1. 退休后：实体从仓库/内存删除，归档（role_id/name/时间/原因/资产处置计数）保留
 *   2. 退休后 dispatchTask 返回 blocked、collectCompetitionClaims 不再产生声明
 *   3. 资产处置：保留 Skill 迁移到市场池（__market__，retired_unique/available），
 *      rejected Skill 丢弃；经验仅计数，随实体级联删除
 *   4. seeded_slate 创建替代 Agent 并继承 Level A 经验，替代者立即进内存 map
 *   5. 幂等：重复 retire 返回归档摘要且不重复处置
 *   6. 预退休：有在跑任务时返回 pre_retired，任务完成后 dispatchTask 收尾自动退休
 *   7. dispatchTask 会累计 Metrics（won/completed/partial）
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { AgentManager } from '../runtime/agent-manager';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { MARKET_POOL_ROLE_ID, type ExperienceRecord, type SkillRecord } from '../schemas';
import type { AgentToolConfig } from '../runtime/agent';
import type { AgentTaskRequest } from '../agent-types';

const ROLE = 'role_retire';

const mockTools: AgentToolConfig = {
  llm: {
    completeWithTools: async () => ({ content: 'Task completed. [done]', tool_calls: undefined }),
  },
  tools: [],
};

async function setup() {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  const manager = await AgentManager.create(repository, bufferRepository, { tools: mockTools });
  await manager.createAgent({ role_id: ROLE, name: 'Retire Me', tags: ['typescript', 'backend'] });
  return { repository, bufferRepository, manager };
}

function task(id = 'task_retire_001'): AgentTaskRequest {
  return {
    spec: 'Do a task.',
    task_id: id,
    call_id: `call_${id}`,
    source_driver: 'test-driver',
  };
}

function skill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Write TypeScript services',
    description_embedding: [],
    content: 'Steps to write TS services',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['typescript'],
    promoted_at: now,
    agent_id: ROLE,
    market_status: 'available',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function experience(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'A reusable lesson',
    description_embedding: [],
    content: 'Lesson content',
    confidence: 0.8,
    tags: ['typescript'],
    agent_id: ROLE,
    confidence_history: [{ value: 0.8, updated_at: now, reason: 'seed' }],
    referenced_count: 1,
    source_task_id: 'task_001',
    source_driver: 'mock-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('AgentManager.retireAgent', () => {
  it('退休后实体删除、归档保留（retired_at / retired_reason / asset_disposition）', async () => {
    const { repository, manager } = await setup();
    await manager.dispatchTask(ROLE, task());

    const result = await manager.retireAgent(ROLE, { reason: 'inactivity' });
    expect(result).toMatchObject({
      role_id: ROLE,
      status: 'retired',
      retired_reason: 'inactivity',
    });
    expect(result.retired_at).toBeTruthy();

    // 实体已删：仓库与内存 map 均不再存在
    await expect(repository.getAgent(ROLE)).rejects.toThrow(/Agent not found/);
    expect(manager.getAgent(ROLE)).toBeUndefined();
    expect(await repository.listAgentIds()).not.toContain(ROLE);

    // 归档保留必要字段
    const archive = await repository.getAgentArchive(ROLE);
    expect(archive).toMatchObject({
      role_id: ROLE,
      name: 'Retire Me',
      status: 'retired',
      retired_reason: 'inactivity',
      tags: ['typescript', 'backend'],
    });
    expect(archive!.retired_at).toBe(result.retired_at);
  });

  it('退休后 dispatchTask 返回 blocked', async () => {
    const { manager } = await setup();
    await manager.retireAgent(ROLE);

    const result = await manager.dispatchTask(ROLE, task('task_after_retire'));
    expect(result.status).toBe('blocked');
  });

  it('退休后 collectCompetitionClaims 不再产生该 Agent 的声明（已驱逐）', async () => {
    const { manager } = await setup();
    await manager.retireAgent(ROLE);

    const batch = await manager.collectCompetitionClaims(task('task_claim_after_retire'));
    expect(batch.claims).toHaveLength(0);
    expect(batch.summary.total).toBe(0);
    expect(batch.summary.unavailable).toBe(0);
  });

  it('资产处置：保留 Skill 迁移到市场池，rejected 丢弃；经验仅计数并随实体删除', async () => {
    const { repository, manager } = await setup();
    const goodSkill = skill();
    const importedSkill = skill({ imported_by: ['role_other'] });
    const rejectedSkill = skill({ review_status: 'rejected' });
    const highExp = experience({ confidence: 0.85, referenced_count: 4 });
    const lowExp = experience({ confidence: 0.3, referenced_count: 0 });

    await repository.saveSkill(ROLE, goodSkill);
    await repository.saveSkill(ROLE, importedSkill);
    await repository.saveSkill(ROLE, rejectedSkill);
    await repository.saveExperience(ROLE, highExp);
    await repository.saveExperience(ROLE, lowExp);

    const result = await manager.retireAgent(ROLE);
    expect(result.asset_disposition).toEqual({
      skills_retained: 2,
      skills_discarded: 1,
      experiences_retained: 1,
      experiences_discarded: 1,
    });

    // 实体删除：退休 Agent 名下技能/经验不再可查
    await expect(repository.listSkills(ROLE)).rejects.toThrow(/Agent not found/);

    // 保留技能迁移到市场池，溯源 origin_agent_id
    const pooled = await repository.listSkills(MARKET_POOL_ROLE_ID);
    expect(pooled).toHaveLength(2);
    const byId = new Map(pooled.map((s) => [s.id, s]));
    expect(byId.get(goodSkill.id)?.market_status).toBe('retired_unique');
    expect(byId.get(importedSkill.id)?.market_status).toBe('available');
    for (const pooledSkill of pooled) {
      expect(pooledSkill.agent_id).toBe(MARKET_POOL_ROLE_ID);
      expect(pooledSkill.origin_agent_id).toBe(ROLE);
    }

    // 市场池 Agent 自动创建，但不暴露在普通 Agent 列表里
    expect(await repository.getAgent(MARKET_POOL_ROLE_ID)).toBeDefined();
    expect(await repository.listAgentIds()).not.toContain(MARKET_POOL_ROLE_ID);

    // 归档记录经验计数（经验记录随实体级联删除）
    const archive = await repository.getAgentArchive(ROLE);
    expect(archive!.asset_disposition).toEqual(result.asset_disposition);
  });

  it('seeded_slate 创建替代 Agent 并继承 Level A 经验，源实体删除', async () => {
    const { repository, manager } = await setup();
    const levelA = experience({ confidence: 0.95, referenced_count: 4 });
    const levelB = experience({ confidence: 0.75, referenced_count: 1 });
    await repository.saveExperience(ROLE, levelA);
    await repository.saveExperience(ROLE, levelB);

    const result = await manager.retireAgent(ROLE, {
      reason: 'persona_drift',
      replacement: 'seeded_slate',
    });

    const replacementId = result.replacement_role_id;
    expect(replacementId).toBe(`${ROLE}__replacement`);
    // 源实体已删，只剩替代 Agent
    expect((await repository.listAgentIds()).sort()).toEqual([replacementId!].sort());
    expect(await repository.getAgentArchive(ROLE)).not.toBeNull();

    const replacementHandle = await repository.getAgent(replacementId!);
    expect(replacementHandle.status).toBe('created');
    expect(replacementHandle.tags).toEqual(['typescript', 'backend']);
    expect(replacementHandle.persona.summary).toContain('typescript');

    // 只继承 Level A（至多 2 条）
    const inherited = await repository.listExperiences(replacementId!);
    expect(inherited).toHaveLength(1);
    expect(inherited[0]!.id).not.toBe(levelA.id);
    expect(inherited[0]!.agent_id).toBe(replacementId);

    // 替代 Agent 立即进入内存 map
    expect(manager.getAgent(replacementId!)).toBeDefined();
  });

  it('幂等：重复 retire 返回归档摘要且不重复处置', async () => {
    const { repository, manager } = await setup();
    await repository.saveExperience(ROLE, experience({ confidence: 0.9 }));

    const first = await manager.retireAgent(ROLE);
    expect(first.asset_disposition?.experiences_retained).toBe(1);

    const second = await manager.retireAgent(ROLE);
    expect(second.status).toBe('retired');
    // 返回归档摘要（首次处置的结果），不重复处置
    expect(second.asset_disposition).toEqual(first.asset_disposition);

    // 实体已删，归档仍在
    await expect(repository.getAgent(ROLE)).rejects.toThrow(/Agent not found/);
    expect(await repository.getAgentArchive(ROLE)).not.toBeNull();
  });

  it('预退休：有在跑任务时返回 pre_retired，任务完成后自动退休', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    const gate = createDeferred<void>();
    const manager = await AgentManager.create(repository, bufferRepository, {
      tools: {
        llm: {
          completeWithTools: async () => {
            await gate.promise;
            return { content: 'Task completed. [done]', tool_calls: undefined };
          },
        },
        tools: [],
      },
    });
    await manager.createAgent({ role_id: ROLE, name: 'PreRetire', tags: [] });

    // 启动一个在跑任务（LLM 被 gate 卡住）
    const dispatchPromise = manager.dispatchTask(ROLE, task('task_pre_retire'));
    await tick();

    // 预退休：返回 pre_retired，不真正退休
    const retireResult = await manager.retireAgent(ROLE, { reason: 'manual' });
    expect(retireResult).toMatchObject({ role_id: ROLE, status: 'pre_retired', pending: true });

    // 预退休期间仍不可被竞标选中
    const batch = await manager.collectCompetitionClaims(task('task_claim_while_pre_retired'));
    expect(batch.claims).toHaveLength(0);

    // 放行 LLM → 任务完成 → dispatchTask 收尾自动 finalize
    gate.resolve();
    const dispatchResult = await dispatchPromise;
    expect(dispatchResult.status).toBe('no_driver_invocation');

    // 现在真正退休：实体删除、归档保留
    expect(await repository.getAgentArchive(ROLE)).toMatchObject({
      role_id: ROLE,
      status: 'retired',
      retired_reason: 'manual',
    });
    expect(await repository.listAgentIds()).not.toContain(ROLE);
  });

  it('dispatchTask 会累计 Metrics（won/completed/partial）', async () => {
    const { repository, manager } = await setup();
    await manager.dispatchTask(ROLE, task('task_metrics'));
    const m = await repository.getMetrics(ROLE);
    expect(m.tasks_won).toBe(1);
    expect(m.tasks_completed).toBe(1);
    expect(m.tasks_partial).toBe(1); // no_driver_invocation → partial
    expect(m.last_won_at).toBeTruthy();
  });
});

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
