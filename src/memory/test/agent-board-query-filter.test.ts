/**
 * AgentBoardQuery 过滤/分页（M6）测试
 *
 * 验证：
 *   1. listAgents(status) 按生命周期状态过滤
 *   2. listSkills：审核状态 / 标签 / 关键词（不区分大小写）/ offset+limit
 *   3. listExperiences：类型 / 置信度区间 / 标签 / 关键词 / 分页
 */
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { RepositoryAgentBoardQuery } from '../adapters/agent-board-query';
import { InMemoryRepository } from '../adapters/in-memory-repository';

const ROLE = 'role_filter';

async function setup() {
  const repository = new InMemoryRepository();
  await repository.initializeAgent({ role_id: ROLE, name: 'Filter Me' });
  await repository.initializeAgent({ role_id: 'role_retired', name: 'Retired' });
  await repository.updateAgentStatus('role_retired', 'retired');
  const query = new RepositoryAgentBoardQuery(repository);
  return { repository, query };
}

function skill(id: string, overrides: Partial<Parameters<InMemoryRepository['saveSkill']>[1]> = {}) {
  return {
    id,
    description: `Skill ${id}`,
    description_embedding: [],
    content: `Content ${id}`,
    version: '1.0.0',
    review_status: 'pending' as const,
    tags: ['typescript'],
    promoted_at: nowTimestamp(),
    agent_id: ROLE,
    created_at: nowTimestamp(),
    updated_at: nowTimestamp(),
    ...overrides,
  };
}

function experience(
  id: string,
  overrides: Partial<Parameters<InMemoryRepository['saveExperience']>[1]> = {},
) {
  return {
    id,
    description: `Experience ${id}`,
    description_embedding: [],
    content: `Content ${id}`,
    confidence: 0.5,
    tags: ['typescript'],
    agent_id: ROLE,
    confidence_history: [],
    referenced_count: 0,
    source_task_id: `task_${id}`,
    source_driver: 'test-driver',
    type: 'positive' as const,
    created_at: nowTimestamp(),
    updated_at: nowTimestamp(),
    ...overrides,
  };
}

describe('RepositoryAgentBoardQuery filters (M6)', () => {
  it('filters listAgents by lifecycle status', async () => {
    const { query } = await setup();
    const active = await query.listAgents('created');
    expect(active.map((agent) => agent.role_id)).toContain(ROLE);
    expect(active.map((agent) => agent.role_id)).not.toContain('role_retired');
    const retired = await query.listAgents('retired');
    expect(retired.map((agent) => agent.role_id)).toEqual(['role_retired']);
  });

  it('filters and paginates skills', async () => {
    const { repository, query } = await setup();
    await repository.saveSkill(ROLE, skill('s1', { review_status: 'approved', tags: ['typescript'] }));
    await repository.saveSkill(ROLE, skill('s2', { review_status: 'pending', tags: ['python'] }));
    await repository.saveSkill(ROLE, skill('s3', { review_status: 'approved', tags: ['typescript'] }));

    expect((await query.listSkills(ROLE, { review_status: 'approved' })).map((s) => s.id)).toEqual([
      's1',
      's3',
    ]);
    expect((await query.listSkills(ROLE, { tag: 'python' })).map((s) => s.id)).toEqual(['s2']);
    expect((await query.listSkills(ROLE, { keyword: 'CONTENT S3' })).map((s) => s.id)).toEqual([
      's3',
    ]);
    expect((await query.listSkills(ROLE, { offset: 1, limit: 1 })).map((s) => s.id)).toEqual([
      's2',
    ]);
  });

  it('filters and paginates experiences', async () => {
    const { repository, query } = await setup();
    await repository.saveExperience(ROLE, experience('e1', { confidence: 0.9, type: 'positive' }));
    await repository.saveExperience(ROLE, experience('e2', { confidence: 0.3, type: 'negative', tags: ['bug'] }));
    await repository.saveExperience(ROLE, experience('e3', { confidence: 0.7, type: 'positive' }));

    expect((await query.listExperiences(ROLE, { type: 'negative' })).map((e) => e.id)).toEqual([
      'e2',
    ]);
    expect(
      (await query.listExperiences(ROLE, { confidence_min: 0.6, confidence_max: 0.95 })).map(
        (e) => e.id,
      ),
    ).toEqual(['e1', 'e3']);
    expect((await query.listExperiences(ROLE, { tag: 'bug' })).map((e) => e.id)).toEqual(['e2']);
    expect((await query.listExperiences(ROLE, { keyword: 'EXPERIENCE E1' })).map((e) => e.id)).toEqual([
      'e1',
    ]);
    expect((await query.listExperiences(ROLE, { offset: 1, limit: 1 })).map((e) => e.id)).toEqual([
      'e2',
    ]);
  });
});
