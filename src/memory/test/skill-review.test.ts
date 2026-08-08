/**
 * skill-review 单元测试
 *
 * 验证 pending Skill 的审批状态迁移：approved/rejected 字段写入、来源经验
 * promoted_to 解除、严格状态机校验，以及批准后自动进入检索资格。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { nowTimestamp } from '../../core';
import { reviewSkill } from '../services/skill-review';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { retrieveMemoriesForTask } from '../adapters/memory-retrieval';
import type { ExperienceRecord, SkillRecord } from '../schemas';

// ═══════════════════════════════════════════
//  Test fixtures
// ═══════════════════════════════════════════

const ROLE_ID = 'role_test';
const REVIEWER = 'human-reviewer';

function makeExperience(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Use vitest for unit tests',
    description_embedding: [],
    content: 'Always use vitest instead of jest for new projects',
    confidence: 0.96,
    tags: ['testing', 'vitest'],
    agent_id: ROLE_ID,
    confidence_history: [{ value: 0.96, updated_at: now, reason: 'seed' }],
    referenced_count: 3,
    source_task_id: 'task_001',
    source_driver: 'mock-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Use vitest for unit tests',
    description_embedding: [],
    content: 'Always use vitest instead of jest for new projects',
    version: '1.0.0',
    review_status: 'pending',
    tags: ['testing', 'vitest'],
    promoted_at: now,
    agent_id: ROLE_ID,
    market_status: 'available',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ═══════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════

describe('reviewSkill', () => {
  let repository: InMemoryRepository;

  beforeEach(async () => {
    repository = new InMemoryRepository();
    await repository.initializeAgent({ role_id: ROLE_ID, name: 'Test Agent', tags: [] });
  });

  it('批准 pending Skill → 返回 review_status=approved 且写入审核字段', async () => {
    const skill = makeSkill();
    await repository.saveSkill(ROLE_ID, skill);

    const updated = await reviewSkill(repository, {
      role_id: ROLE_ID,
      skill_id: skill.id,
      decision: 'approved',
      reviewer: REVIEWER,
    });

    expect(updated.id).toBe(skill.id);
    expect(updated.review_status).toBe('approved');
    expect(updated.reviewed_by).toBe(REVIEWER);
    expect(updated.reviewed_at).toBeDefined();
    expect(new Date(updated.reviewed_at!).getTime()).toBeGreaterThanOrEqual(
      new Date(skill.updated_at).getTime(),
    );

    const persisted = (await repository.listSkills(ROLE_ID)).find((s) => s.id === skill.id);
    expect(persisted!.review_status).toBe('approved');
    expect(persisted!.reviewed_by).toBe(REVIEWER);
  });

  it('拒绝 pending Skill → 返回 review_status=rejected 且写入审核字段', async () => {
    const skill = makeSkill();
    await repository.saveSkill(ROLE_ID, skill);

    const updated = await reviewSkill(repository, {
      role_id: ROLE_ID,
      skill_id: skill.id,
      decision: 'rejected',
      reviewer: REVIEWER,
    });

    expect(updated.review_status).toBe('rejected');
    expect(updated.reviewed_by).toBe(REVIEWER);
    expect(updated.reviewed_at).toBeDefined();
  });

  it('拒绝时清除来源 Experience 的 promoted_to，允许该经验未来重新晋升', async () => {
    const experience = makeExperience();
    await repository.saveExperience(ROLE_ID, experience);
    const skill = makeSkill({ promoted_from: experience.id });
    await repository.saveSkill(ROLE_ID, skill);

    await reviewSkill(repository, {
      role_id: ROLE_ID,
      skill_id: skill.id,
      decision: 'rejected',
      reviewer: REVIEWER,
    });

    const updated = (await repository.listExperiences(ROLE_ID)).find(
      (e) => e.id === experience.id,
    );
    expect(updated).toBeDefined();
    expect(updated!.promoted_to).toBeUndefined();
  });

  it('批准时不影响来源 Experience 的 promoted_to', async () => {
    const experience = makeExperience();
    await repository.saveExperience(ROLE_ID, experience);
    const skill = makeSkill({ promoted_from: experience.id });
    await repository.saveSkill(ROLE_ID, skill);

    await reviewSkill(repository, {
      role_id: ROLE_ID,
      skill_id: skill.id,
      decision: 'approved',
      reviewer: REVIEWER,
    });

    const updated = (await repository.listExperiences(ROLE_ID)).find(
      (e) => e.id === experience.id,
    );
    expect(updated!.promoted_to).toBeUndefined();
  });

  it('Skill 不存在 → 抛错', async () => {
    await expect(
      reviewSkill(repository, {
        role_id: ROLE_ID,
        skill_id: randomUUID(),
        decision: 'approved',
        reviewer: REVIEWER,
      }),
    ).rejects.toThrow('Skill not found');
  });

  it('非 pending 状态（已 approved）→ 抛错', async () => {
    const skill = makeSkill({ review_status: 'approved' });
    await repository.saveSkill(ROLE_ID, skill);

    await expect(
      reviewSkill(repository, {
        role_id: ROLE_ID,
        skill_id: skill.id,
        decision: 'rejected',
        reviewer: REVIEWER,
      }),
    ).rejects.toThrow('Skill is not pending');
  });

  it('非 pending 状态（已 rejected）→ 抛错', async () => {
    const skill = makeSkill({ review_status: 'rejected' });
    await repository.saveSkill(ROLE_ID, skill);

    await expect(
      reviewSkill(repository, {
        role_id: ROLE_ID,
        skill_id: skill.id,
        decision: 'approved',
        reviewer: REVIEWER,
      }),
    ).rejects.toThrow('Skill is not pending');
  });
});

describe('reviewSkill 与检索资格', () => {
  const embedding = new HashEmbeddingProvider();

  it('批准前 pending Skill 不进入 searchSkills，批准后自动可检索', async () => {
    const repository = new InMemoryRepository(embedding);
    await repository.initializeAgent({ role_id: ROLE_ID, name: 'Test Agent', tags: [] });
    const skill = makeSkill();
    await repository.saveSkill(ROLE_ID, skill);

    const queryEmbedding = await embedding.embed(skill.description);
    const search = async () =>
      repository.searchSkills(ROLE_ID, {
        query_embedding: queryEmbedding,
        top_k: 5,
      });

    expect(await search()).toEqual([]);

    await reviewSkill(repository, {
      role_id: ROLE_ID,
      skill_id: skill.id,
      decision: 'approved',
      reviewer: REVIEWER,
    });

    const hits = await search();
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(skill.id);
  });

  it('rejected Skill 不进入检索', async () => {
    const repository = new InMemoryRepository(embedding);
    await repository.initializeAgent({ role_id: ROLE_ID, name: 'Test Agent', tags: [] });
    const skill = makeSkill();
    await repository.saveSkill(ROLE_ID, skill);

    await reviewSkill(repository, {
      role_id: ROLE_ID,
      skill_id: skill.id,
      decision: 'rejected',
      reviewer: REVIEWER,
    });

    const queryEmbedding = await embedding.embed(skill.description);
    const hits = await repository.searchSkills(ROLE_ID, {
      query_embedding: queryEmbedding,
      top_k: 5,
    });
    expect(hits).toEqual([]);
  });

  it('批准前不入选任务 Context，批准后入选 retrieveMemoriesForTask', async () => {
    const repository = new InMemoryRepository(embedding);
    await repository.initializeAgent({ role_id: ROLE_ID, name: 'Test Agent', tags: [] });
    const scope = createAgentMemoryScope(repository, new InMemoryBufferRepository(), ROLE_ID);

    const skill = makeSkill({ tags: ['vitest'] });
    await repository.saveSkill(ROLE_ID, skill);

    const retrieve = () =>
      retrieveMemoriesForTask(scope, { task_query: 'vitest testing' }, { embedding });

    const before = await retrieve();
    expect(before.skills).toEqual([]);

    await reviewSkill(repository, {
      role_id: ROLE_ID,
      skill_id: skill.id,
      decision: 'approved',
      reviewer: REVIEWER,
    });

    const after = await retrieve();
    expect(after.skills).toHaveLength(1);
    expect(after.skills[0]!.id).toBe(skill.id);
  });

  it('agent 无法检索 pending / rejected Skill，仅可检索 approved Skill', async () => {
    const repository = new InMemoryRepository(embedding);
    await repository.initializeAgent({ role_id: ROLE_ID, name: 'Test Agent', tags: [] });
    const scope = createAgentMemoryScope(repository, new InMemoryBufferRepository(), ROLE_ID);

    const pending = makeSkill({
      description: 'pending typescript skill',
      tags: ['typescript'],
    });
    const rejected = makeSkill({
      description: 'rejected typescript skill',
      tags: ['typescript'],
      review_status: 'rejected',
    });
    const approved = makeSkill({
      description: 'approved typescript skill',
      tags: ['typescript'],
      review_status: 'approved',
    });

    await repository.saveSkill(ROLE_ID, pending);
    await repository.saveSkill(ROLE_ID, rejected);
    await repository.saveSkill(ROLE_ID, approved);

    const result = await retrieveMemoriesForTask(
      scope,
      { task_query: 'typescript contract' },
      { embedding, selection: { recall_top_k: 0, min_tag_overlap: 1 } },
    );

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.id).toBe(approved.id);
    expect(result.skills[0]!.review_status).toBe('approved');
  });
});
