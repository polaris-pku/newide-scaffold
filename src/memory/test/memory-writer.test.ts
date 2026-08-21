/**
 * MemoryWriter（M2：memory.createSkill / updateSkill / deleteSkill /
 * publishSkillToMarket / updateExperience / deleteExperience）测试
 *
 * 验证：
 *   1. createSkill：pending 默认 / autoApprove 直接 approved；embedding 由仓库补全；
 *      同 Agent 同内容幂等返回已存在项
 *   2. updateSkill：PATCH 语义；description 变更强制重算 embedding
 *   3. publishSkillToMarket：置 market_status='available'，保留归属
 *   4. updateExperience：confidence 调整写入 confidence_history 并重算 avg_confidence
 *   5. deleteSkill / deleteExperience：删除成功、不存在抛错
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import {
  createSkill,
  deleteExperience,
  deleteSkill,
  publishSkillToMarket,
  updateExperience,
  updateSkill,
} from '../services/memory-writer';
import type { ExperienceRecord } from '../schemas';

const ROLE = 'role_writer';

async function setup() {
  const repository = new InMemoryRepository();
  await repository.initializeAgent({ role_id: ROLE, name: 'Writer' });
  return repository;
}

function experience(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Write TypeScript services',
    description_embedding: [],
    content: 'Steps to write TS services',
    confidence: 0.6,
    tags: ['typescript'],
    agent_id: ROLE,
    confidence_history: [],
    referenced_count: 0,
    source_task_id: 'task_1',
    source_driver: 'test-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('createSkill', () => {
  it('creates a pending skill and lets the repository fill the embedding', async () => {
    const repository = await setup();
    const skill = await createSkill(repository, {
      role_id: ROLE,
      description: 'TS service patterns',
      content: 'Define explicit contracts and tests.',
      tags: ['typescript'],
    });

    expect(skill.review_status).toBe('pending');
    expect(skill.agent_id).toBe(ROLE);
    const stored = (await repository.listSkills(ROLE))[0]!;
    expect(stored.id).toBe(skill.id);
    expect(stored.description_embedding.length).toBeGreaterThan(0);
  });

  it('auto-approves when options.autoApprove is set', async () => {
    const repository = await setup();
    const skill = await createSkill(
      repository,
      { role_id: ROLE, description: 'd', content: 'c' },
      { autoApprove: true },
    );
    expect(skill.review_status).toBe('approved');
  });

  it('is idempotent for the same description and content', async () => {
    const repository = await setup();
    const first = await createSkill(repository, {
      role_id: ROLE,
      description: 'same',
      content: 'same content',
    });
    const second = await createSkill(repository, {
      role_id: ROLE,
      description: 'same',
      content: 'same content',
    });
    expect(second.id).toBe(first.id);
    expect(await repository.listSkills(ROLE)).toHaveLength(1);
  });
});

describe('updateSkill', () => {
  it('patches tags and keeps the embedding when description is unchanged', async () => {
    const repository = await setup();
    const created = await createSkill(repository, {
      role_id: ROLE,
      description: 'desc',
      content: 'content',
    });
    const embedding = created.description_embedding;

    const updated = await updateSkill(repository, ROLE, created.id, {
      tags: ['a', 'b'],
      market_status: 'available',
    });

    expect(updated.tags).toEqual(['a', 'b']);
    expect(updated.market_status).toBe('available');
    expect(updated.description_embedding).toEqual(embedding);
  });

  it('re-embeds when description changes', async () => {
    const repository = await setup();
    const created = await createSkill(repository, {
      role_id: ROLE,
      description: 'old description',
      content: 'content',
    });
    const updated = await updateSkill(repository, ROLE, created.id, {
      description: 'new description',
    });
    const stored = (await repository.listSkills(ROLE))[0]!;
    expect(updated.description).toBe('new description');
    expect(stored.description_embedding.length).toBeGreaterThan(0);
  });

  it('throws when the skill does not exist', async () => {
    const repository = await setup();
    await expect(
      updateSkill(repository, ROLE, randomUUID(), { tags: ['x'] }),
    ).rejects.toThrow(/Skill not found/);
  });
});

describe('publishSkillToMarket', () => {
  it('marks the skill available while keeping ownership', async () => {
    const repository = await setup();
    const created = await createSkill(repository, {
      role_id: ROLE,
      description: 'marketable',
      content: 'content',
    });
    const published = await publishSkillToMarket(repository, ROLE, created.id);
    expect(published.market_status).toBe('available');
    expect(published.agent_id).toBe(ROLE);
  });
});

describe('updateExperience', () => {
  it('adjusts confidence, appends history, and recomputes avg_confidence', async () => {
    const repository = await setup();
    await repository.saveExperience(ROLE, experience({ confidence: 0.6 }));
    const target = experience({ confidence: 0.8 });
    await repository.saveExperience(ROLE, target);

    const updated = await updateExperience(repository, ROLE, target.id, { confidence: 0.9 });

    expect(updated.confidence).toBe(0.9);
    expect(updated.confidence_history.at(-1)).toMatchObject({
      value: 0.9,
      reason: 'manual_adjustment',
    });
    const metrics = await repository.getMetrics(ROLE);
    expect(metrics.avg_confidence).toBeCloseTo((0.6 + 0.9) / 2);
  });

  it('rejects confidence outside [0, 1]', async () => {
    const repository = await setup();
    const target = experience();
    await repository.saveExperience(ROLE, target);
    await expect(
      updateExperience(repository, ROLE, target.id, { confidence: 1.5 }),
    ).rejects.toThrow(/Confidence must be within \[0, 1\]/);
  });
});

describe('deleteSkill / deleteExperience', () => {
  it('deletes a skill and throws when missing', async () => {
    const repository = await setup();
    const created = await createSkill(repository, {
      role_id: ROLE,
      description: 'doomed',
      content: 'content',
    });
    await deleteSkill(repository, ROLE, created.id);
    expect(await repository.listSkills(ROLE)).toHaveLength(0);
    await expect(deleteSkill(repository, ROLE, created.id)).rejects.toThrow(/Skill not found/);
  });

  it('deletes an experience and throws when missing', async () => {
    const repository = await setup();
    const target = experience();
    await repository.saveExperience(ROLE, target);
    await deleteExperience(repository, ROLE, target.id);
    expect(await repository.listExperiences(ROLE)).toHaveLength(0);
    await expect(deleteExperience(repository, ROLE, target.id)).rejects.toThrow(
      /Experience not found/,
    );
  });
});
