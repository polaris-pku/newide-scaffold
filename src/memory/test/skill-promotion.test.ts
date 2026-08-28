import { describe, it, expect, beforeEach } from 'vitest';
import { ruleBasedSkillPromotion } from '../services/skill-promotion';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { ExperienceRecord } from '../schemas';
import type { AgentTaskRequest } from '../agent-types';

// ═══════════════════════════════════════════
//  Test fixtures
// ═══════════════════════════════════════════

function makeExperience(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    description: 'Test experience',
    description_embedding: [0.1, 0.2, 0.3],
    content: 'Test content',
    confidence: 0.8,
    tags: ['test'],
    agent_id: 'role_test',
    confidence_history: [],
    referenced_count: 0,
    source_task_id: 'task_001',
    source_driver: 'mock-driver',
    type: 'positive',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const defaultTask: AgentTaskRequest = {
  spec: 'Test task',
  task_id: 'task_001',
};

/** 将经验存入 repository，模拟 processPendingBuffer 中 saveExperience 在 promote 之前执行 */
async function seedExperience(
  repository: InMemoryRepository,
  experience: ExperienceRecord,
): Promise<void> {
  await repository.saveExperience('role_test', experience);
}

// ═══════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════

describe('ruleBasedSkillPromotion', () => {
  let memory: AgentMemoryScope;
  let repository: InMemoryRepository;
  let bufferRepository: InMemoryBufferRepository;

  beforeEach(async () => {
    repository = new InMemoryRepository();
    bufferRepository = new InMemoryBufferRepository();
    await repository.initializeAgent({ role_id: 'role_test', name: 'Test Agent', tags: [] });
    await bufferRepository.ensureAgent('role_test');
    memory = createAgentMemoryScope(repository, bufferRepository, 'role_test');
  });

  it('confidence > 0.95 的正经验 → 晋升成功', async () => {
    const experience = makeExperience({ confidence: 0.96 });
    await seedExperience(repository, experience);
    const result = await ruleBasedSkillPromotion(memory, defaultTask, [experience]);

    expect(result.check.eligible).toBe(true);
    expect(result.check.auto_approved).toBe(false);
    expect(result.check.blocking_rules).toHaveLength(0);
    expect(result.skill).toBeDefined();
    expect(result.skill!.promoted_from).toBe(experience.id);
    expect(result.skill!.review_status).toBe('pending');
    expect(result.skill!.agent_id).toBe('role_test');
  });

  it('confidence === 0.95（边界）→ 不晋升', async () => {
    const experience = makeExperience({ confidence: 0.95 });
    const result = await ruleBasedSkillPromotion(memory, defaultTask, [experience]);

    expect(result.check.eligible).toBe(false);
    expect(result.skill).toBeUndefined();
    expect(result.check.blocking_rules.length).toBeGreaterThan(0);
  });

  it('confidence < 0.95 → 不晋升', async () => {
    const experience = makeExperience({ confidence: 0.8 });
    const result = await ruleBasedSkillPromotion(memory, defaultTask, [experience]);

    expect(result.check.eligible).toBe(false);
    expect(result.skill).toBeUndefined();
  });

  it('options.confidenceThreshold 下调后低置信度正经验可晋升（全自动化测评用）', async () => {
    const experience = makeExperience({ confidence: 0.6 });
    await seedExperience(repository, experience);
    const result = await ruleBasedSkillPromotion(memory, defaultTask, [experience], {
      confidenceThreshold: 0.5,
    });

    expect(result.check.eligible).toBe(true);
    expect(result.skill).toBeDefined();
    expect(result.skill!.promoted_from).toBe(experience.id);
    expect(result.skill!.review_status).toBe('pending');
  });

  it('options.confidenceThreshold 上调后高置信度经验也不晋升', async () => {
    const experience = makeExperience({ confidence: 0.8 });
    const result = await ruleBasedSkillPromotion(memory, defaultTask, [experience], {
      confidenceThreshold: 0.9,
    });

    expect(result.check.eligible).toBe(false);
    expect(result.skill).toBeUndefined();
    expect(result.check.blocking_rules.join(' ')).toContain('0.9');
  });

  it('负经验即使 confidence > 0.95 也不晋升', async () => {
    const experience = makeExperience({ confidence: 0.99, type: 'negative' });
    const result = await ruleBasedSkillPromotion(memory, defaultTask, [experience]);

    expect(result.check.eligible).toBe(false);
    expect(result.skill).toBeUndefined();
  });

  it('已晋升的 experience（promoted_to 已有值）→ 跳过', async () => {
    const experience = makeExperience({
      confidence: 0.99,
      promoted_to: '00000000-0000-0000-0000-000000000099',
    });
    const result = await ruleBasedSkillPromotion(memory, defaultTask, [experience]);

    expect(result.check.eligible).toBe(false);
    expect(result.skill).toBeUndefined();
  });

  it('空 experiences 数组 → 不晋升', async () => {
    const result = await ruleBasedSkillPromotion(memory, defaultTask, []);

    expect(result.check.eligible).toBe(false);
    expect(result.check.blocking_rules).toContain('No experiences to evaluate');
  });

  it('多个经验，第一个已晋升但第二个满足条件 → 晋升第二个', async () => {
    const first = makeExperience({
      id: '00000000-0000-0000-0000-000000000001',
      confidence: 0.99,
      promoted_to: '00000000-0000-0000-0000-000000000099',
      description: 'Already promoted',
    });
    const second = makeExperience({
      id: '00000000-0000-0000-0000-000000000002',
      confidence: 0.98,
      description: 'Should be promoted',
    });

    await seedExperience(repository, second);
    const result = await ruleBasedSkillPromotion(memory, defaultTask, [first, second]);

    expect(result.check.eligible).toBe(true);
    expect(result.skill!.promoted_from).toBe(second.id);
    expect(result.skill!.description).toBe('Should be promoted');
  });

  it('skill 的 content/description/tags 与 source experience 一致', async () => {
    const experience = makeExperience({
      confidence: 0.99,
      description: 'Use vitest for unit tests',
      content: 'Always use vitest instead of jest for new projects',
      tags: ['testing', 'vitest', 'best-practice'],
    });

    await seedExperience(repository, experience);
    const result = await ruleBasedSkillPromotion(memory, defaultTask, [experience]);

    expect(result.skill!.description).toBe('Use vitest for unit tests');
    expect(result.skill!.content).toBe('Always use vitest instead of jest for new projects');
    expect(result.skill!.tags).toEqual(['testing', 'vitest', 'best-practice']);
  });

  it('skill 的 review_status 为 pending', async () => {
    const experience = makeExperience({ confidence: 0.99 });
    await seedExperience(repository, experience);
    const result = await ruleBasedSkillPromotion(memory, defaultTask, [experience]);

    expect(result.skill!.review_status).toBe('pending');
  });

  it('晋升后原 experience 的 promoted_to 指向新 skill', async () => {
    const experience = makeExperience({ confidence: 0.99 });

    // 先将 experience 存入 repository 以便 updateExperience 生效
    await repository.saveExperience('role_test', experience);

    await ruleBasedSkillPromotion(memory, defaultTask, [experience]);

    const updated = (await repository.listExperiences('role_test')).find(
      (e) => e.id === experience.id,
    );
    expect(updated).toBeDefined();
    expect(updated!.promoted_to).toBeDefined();
    expect(updated!.promoted_to).not.toBe('');

    // 同时验证 skill 已存在于 repository
    const skills = await repository.listSkills('role_test');
    expect(skills).toHaveLength(1);
    expect(skills[0]!.id).toBe(updated!.promoted_to);
  });

  it('skill 的 version 为 1.0.0', async () => {
    const experience = makeExperience({ confidence: 0.99 });
    await seedExperience(repository, experience);
    const result = await ruleBasedSkillPromotion(memory, defaultTask, [experience]);

    expect(result.skill!.version).toBe('1.0.0');
  });
});
