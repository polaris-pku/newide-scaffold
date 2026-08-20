/**
 * Memory 全局总览（memory.getOverview）service 测试
 *
 * 验证 computeMemoryOverview 的跨 Agent 聚合：
 * 状态分布、技能（待审核/市场在架）、经验总量、buffer 积压/死信、平均置信度。
 */
import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { computeMemoryOverview } from '../services/memory-overview';
import { nowTimestamp } from '../../core';
import type { BufferSnapshot, ExperienceRecord, SkillRecord } from '../schemas';

const NOW = nowTimestamp();

function skill(roleId: string, overrides: Partial<SkillRecord>): SkillRecord {
  return {
    id: 'skill_' + roleId,
    description: 'Skill description',
    description_embedding: [],
    content: 'Skill content.',
    version: '1',
    review_status: 'pending',
    tags: [],
    promoted_at: NOW,
    agent_id: roleId,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function experience(roleId: string, overrides: Partial<ExperienceRecord>): ExperienceRecord {
  return {
    id: 'exp_' + roleId,
    description: 'Experience description',
    description_embedding: [],
    content: 'Experience content.',
    confidence: 0.5,
    tags: [],
    agent_id: roleId,
    confidence_history: [],
    referenced_count: 0,
    source_task_id: 'task_1',
    source_driver: 'test-driver',
    type: 'positive',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function buffer(seq: number, taskId: string): BufferSnapshot {
  return {
    task_id: taskId,
    task_description: 'Do a task.',
    driver_return: {
      artifacts: [],
      summary: 'Done.',
      decisions: [],
      blockers: [],
      referenced_experiences: [],
      assumptions: [],
    },
    source_task_id: taskId,
    source_driver: 'test-driver',
    received_at: NOW,
    retry_count: 0,
    extraction_status: 'pending',
  };
}

describe('computeMemoryOverview', () => {
  it('returns an empty overview for an empty system', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();

    const overview = await computeMemoryOverview(repository, bufferRepository);

    expect(overview).toEqual({
      agents: { total: 0, by_status: {} },
      skills: { total: 0, pending_review: 0, in_market: 0 },
      experiences: { total: 0 },
      buffer: { pending: 0, dead_letters: 0 },
      quality: { avg_confidence: 0 },
    });
  });

  it('aggregates agents, skills, experiences and buffer health across agents', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();

    await repository.initializeAgent({ role_id: 'role_a', name: 'A' });
    await repository.initializeAgent({ role_id: 'role_b', name: 'B' });
    await repository.updateAgentStatus('role_b', 'retired', {
      retired_at: NOW,
      retired_reason: 'manual',
    });

    await repository.saveSkill(
      'role_a',
      skill('role_a', { review_status: 'pending' }),
    );
    await repository.saveSkill(
      'role_a',
      skill('role_a_2', {
        review_status: 'approved',
        market_status: 'available',
        reviewed_by: 'reviewer',
        reviewed_at: NOW,
      }),
    );
    await repository.saveExperience('role_a', experience('role_a', { confidence: 0.6 }));
    await repository.saveExperience('role_b', experience('role_b', { confidence: 0.9 }));

    await bufferRepository.ensureAgent('role_b');
    await bufferRepository.saveBufferSnapshot('role_b', buffer(1, 'task_1'));
    await bufferRepository.markBufferDeadLetter('role_b', 1);

    const overview = await computeMemoryOverview(repository, bufferRepository);

    expect(overview.agents).toEqual({
      total: 2,
      by_status: { created: 1, retired: 1 },
    });
    expect(overview.skills).toEqual({
      total: 2,
      pending_review: 1,
      in_market: 1,
    });
    expect(overview.experiences).toEqual({ total: 2 });
    expect(overview.buffer).toEqual({ pending: 0, dead_letters: 1 });
    expect(overview.quality.avg_confidence).toBeCloseTo(0.75, 5);
  });

  it('tolerates agents without initialized buffer stores', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();

    await repository.initializeAgent({ role_id: 'role_a', name: 'A' });
    // 不调用 bufferRepository.ensureAgent —— getBufferMeta 抛错应被容错为 0

    const overview = await computeMemoryOverview(repository, bufferRepository);
    expect(overview.buffer).toEqual({ pending: 0, dead_letters: 0 });
    expect(overview.agents.total).toBe(1);
  });
});
