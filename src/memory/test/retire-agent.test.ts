/**
 * AgentManager.retireAgent 测试
 *
 * 验证：
 *   1. 退休后状态置为 retired，写入 retired_at / retired_reason
 *   2. 退休后 dispatchTask 返回 blocked
 *   3. 退休后 collectCompetitionClaims 返回 unavailable
 *   4. 资产处置：approved Skill 保留并标记 retired_unique，rejected Skill 丢弃；
 *      高置信经验保留、低置信经验丢弃
 *   5. seeded_slate 创建替代 Agent 并继承 Level A 经验
 *   6. 幂等：重复 retire 返回 retired 且不重复处置
 *   7. dispatchTask 会累计 Metrics（won/completed/partial）
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { AgentManager } from '../runtime/agent-manager';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import type { ExperienceRecord, SkillRecord } from '../schemas';
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
  it('退休后状态置为 retired，并写入 retired_at / retired_reason', async () => {
    const { repository, manager } = await setup();
    await manager.dispatchTask(ROLE, task());

    const result = await manager.retireAgent(ROLE, { reason: 'inactivity' });
    expect(result).toMatchObject({
      role_id: ROLE,
      status: 'retired',
      retired_reason: 'inactivity',
    });
    expect(result.retired_at).toBeTruthy();

    const handle = await repository.getAgent(ROLE);
    expect(handle.status).toBe('retired');
    expect(handle.retired_at).toBe(result.retired_at);
    expect(handle.retired_reason).toBe('inactivity');
  });

  it('退休后 dispatchTask 返回 blocked', async () => {
    const { manager } = await setup();
    await manager.retireAgent(ROLE);

    const result = await manager.dispatchTask(ROLE, task('task_after_retire'));
    expect(result.status).toBe('blocked');
    expect(result.cycle.buffer_snapshot.driver_return.summary).toContain('retired');
  });

  it('退休后 collectCompetitionClaims 返回 unavailable', async () => {
    const { manager } = await setup();
    await manager.retireAgent(ROLE);

    const batch = await manager.collectCompetitionClaims(task('task_claim_after_retire'));
    expect(batch.summary.unavailable).toBe(1);
    expect(batch.summary.participated).toBe(0);
    expect(batch.claims).toHaveLength(0);
  });

  it('资产处置：approved Skill 保留并标记 retired_unique，已引入技能归市场 available，rejected 丢弃；高置信经验保留、低置信丢弃', async () => {
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

    const skills = await repository.listSkills(ROLE);
    expect(skills).toHaveLength(2);
    const byId = new Map(skills.map((s) => [s.id, s]));
    expect(byId.get(goodSkill.id)?.market_status).toBe('retired_unique');
    expect(byId.get(importedSkill.id)?.market_status).toBe('available');

    const experiences = await repository.listExperiences(ROLE);
    expect(experiences).toHaveLength(1);
    expect(experiences[0]!.id).toBe(highExp.id);
  });

  it('seeded_slate 创建替代 Agent 并继承 Level A 经验', async () => {
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
    expect((await repository.listAgentIds()).sort()).toEqual(
      [ROLE, replacementId!].sort(),
    );

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

  it('幂等：重复 retire 返回 retired 且不重复处置', async () => {
    const { repository, manager } = await setup();
    await repository.saveExperience(ROLE, experience({ confidence: 0.9 }));

    const first = await manager.retireAgent(ROLE);
    expect(first.asset_disposition.experiences_retained).toBe(1);

    const second = await manager.retireAgent(ROLE);
    expect(second.status).toBe('retired');
    expect(second.asset_disposition).toEqual({
      skills_retained: 0,
      skills_discarded: 0,
      experiences_retained: 0,
      experiences_discarded: 0,
    });

    // 经验仍在（未因二次调用被再次处置/删除）
    const experiences = await repository.listExperiences(ROLE);
    expect(experiences).toHaveLength(1);
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
