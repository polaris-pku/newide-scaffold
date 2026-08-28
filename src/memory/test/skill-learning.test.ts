/**
 * 市场自学习（skill-learning）测试
 *
 * 验证：
 *   1. 纯函数：buildLearningQuery 聚合 persona+tags；computeTagSimilarity（Jaccard）；
 *      evaluateSkillLearning（persona 保底 / combined 阈值）
 *   2. learnSkillsForAgent：引入 tag+persona 匹配的技能、跳过不匹配、
 *      已引入去重（幂等）、每轮上限 maxSkillsPerAgentPerCycle
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { MARKET_POOL_ROLE_ID, type AgentHandle, type SkillRecord } from '../schemas';
import {
  buildLearningQuery,
  computeTagSimilarity,
  evaluateSkillLearning,
  learnSkillsForAgent,
} from '../services/skill-learning';

const embedding = new HashEmbeddingProvider(64);

function skill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'typescript service patterns',
    description_embedding: [],
    content: 'Content for the skill.',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['typescript'],
    promoted_at: now,
    agent_id: MARKET_POOL_ROLE_ID,
    market_status: 'available',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

async function seedLearner(
  repository: InMemoryRepository,
  tags: string[] = ['typescript'],
): Promise<AgentHandle> {
  await repository.initializeAgent({ role_id: 'learner', name: 'Learner', tags });
  await repository.savePersona('learner', {
    role_id: 'learner',
    version: 1,
    summary: 'typescript service expert',
    skills_overview: 'building typescript services',
    experience_coverage: 'api design',
    recent_performance: 'delivered services',
    notes: '',
    generated_at: nowTimestamp(),
  });
  return repository.getAgent('learner');
}

const learnOptions = {
  minPersonaSimilarity: 0,
  learnThreshold: 0.5,
  tagWeight: 0.5,
  personaWeight: 0.5,
  maxSkillsPerAgentPerCycle: 3,
};

describe('skill-learning 纯函数', () => {
  it('buildLearningQuery 聚合 persona 摘要 + 技能覆盖 + 标签', async () => {
    const handle = await seedLearner(new InMemoryRepository(embedding));
    const query = buildLearningQuery(handle);
    expect(query).toContain('typescript');
    expect(query).toContain('service');
    expect(query).toContain('api design');
  });

  it('computeTagSimilarity 计算 Jaccard', () => {
    expect(computeTagSimilarity(['typescript'], ['typescript'])).toBe(1);
    expect(computeTagSimilarity(['typescript'], ['rust'])).toBe(0);
    expect(computeTagSimilarity(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 5);
    expect(computeTagSimilarity(undefined, [])).toBe(0);
  });

  it('evaluateSkillLearning：persona 保底优先于阈值', () => {
    const opts = {
      minPersonaSimilarity: 0.3,
      learnThreshold: 0.5,
      tagWeight: 0.5,
      personaWeight: 0.5,
    };
    // 高 persona + 高 tag → 学习
    expect(
      evaluateSkillLearning({
        skill_id: 's',
        tag_similarity: 1,
        persona_similarity: 0.8,
        options: opts,
      }),
    ).toMatchObject({ learn: true, reason: 'learned' });
    // persona 低于保底 → 即使 tag 高也不学
    expect(
      evaluateSkillLearning({
        skill_id: 's',
        tag_similarity: 1,
        persona_similarity: 0.2,
        options: opts,
      }),
    ).toMatchObject({ learn: false, reason: 'persona_below_floor' });
    // persona 达标但 combined 低于阈值 → 不学
    expect(
      evaluateSkillLearning({
        skill_id: 's',
        tag_similarity: 0,
        persona_similarity: 0.4,
        options: opts,
      }),
    ).toMatchObject({ learn: false, reason: 'below_threshold' });
  });
});

describe('learnSkillsForAgent', () => {
  it('引入 tag+persona 匹配的市场技能，跳过不匹配的', async () => {
    const repository = new InMemoryRepository(embedding);
    await seedLearner(repository);
    await repository.ensureAgent(MARKET_POOL_ROLE_ID);

    const ts = skill({
      id: randomUUID(),
      description: 'typescript service contract patterns',
      tags: ['typescript'],
    });
    const rust = skill({
      id: randomUUID(),
      description: 'rust ownership lifetimes',
      tags: ['rust'],
    });
    await repository.saveSkill(MARKET_POOL_ROLE_ID, ts);
    await repository.saveSkill(MARKET_POOL_ROLE_ID, rust);

    const outcome = await learnSkillsForAgent(repository, embedding, 'learner', learnOptions);

    expect(outcome.imported_skill_ids).toEqual([ts.id]);
    expect(outcome.skipped_skill_ids).toContain(rust.id);

    // 引入副作用：learner 名下出现 ts 的副本（imported_from 溯源）
    const learnerSkills = await repository.listSkills('learner');
    expect(learnerSkills.some((s) => s.imported_from === ts.id)).toBe(true);
  });

  it('已引入过的技能去重（幂等）', async () => {
    const repository = new InMemoryRepository(embedding);
    await seedLearner(repository);
    await repository.ensureAgent(MARKET_POOL_ROLE_ID);
    const ts = skill({ id: randomUUID() });
    await repository.saveSkill(MARKET_POOL_ROLE_ID, ts);

    const first = await learnSkillsForAgent(repository, embedding, 'learner', learnOptions);
    expect(first.imported_skill_ids).toEqual([ts.id]);

    const second = await learnSkillsForAgent(repository, embedding, 'learner', learnOptions);
    expect(second.imported_skill_ids).toHaveLength(0);
    expect(second.skipped_skill_ids).toContain(ts.id);
  });

  it('每轮最多引入 maxSkillsPerAgentPerCycle 个', async () => {
    const repository = new InMemoryRepository(embedding);
    await seedLearner(repository);
    await repository.ensureAgent(MARKET_POOL_ROLE_ID);
    for (let index = 0; index < 5; index += 1) {
      await repository.saveSkill(
        MARKET_POOL_ROLE_ID,
        skill({ id: randomUUID(), description: `typescript skill ${index}` }),
      );
    }

    const outcome = await learnSkillsForAgent(repository, embedding, 'learner', {
      ...learnOptions,
      learnThreshold: 0.3,
      maxSkillsPerAgentPerCycle: 3,
    });

    expect(outcome.imported_skill_ids).toHaveLength(3);
  });
});
