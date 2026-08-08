/**
 * ruleBasedPersonaInduction 测试
 *
 * 验证规则版 Persona 归纳：
 *   1. 空数据（无经验/技能）时的字段生成
 *   2. 有经验/技能时基于数据启发式生成
 *   3. version 递增 + memory.savePersona / getAgent().persona 同步
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { ruleBasedPersonaInduction } from '../services/rule-based-persona-induction';
import type { ExperienceRecord, SkillRecord } from '../schemas';

// ──────────────────────────────────────────────
// 测试基础设施
// ──────────────────────────────────────────────

async function createTestInfra(role_id = 'role_persona_test') {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  await repository.initializeAgent({ role_id, name: 'Test Agent', tags: [] });
  await bufferRepository.ensureAgent(role_id);
  const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
  return { repository, memory, role_id };
}

function createExperience(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  const now = nowTimestamp();
  const id = randomUUID();
  return {
    id,
    description: `Experience ${id.slice(0, 8)}`,
    description_embedding: [0.1, 0.2, 0.3],
    content: 'Test content',
    confidence: 0.8,
    tags: ['test'],
    agent_id: 'role_test',
    type: 'positive',
    confidence_history: [{ value: 0.8, updated_at: now, reason: 'initial' }],
    referenced_count: 0,
    source_task_id: 'task_001',
    source_driver: 'test-driver',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function createSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = nowTimestamp();
  const id = randomUUID();
  return {
    id,
    description: `Skill ${id.slice(0, 8)}`,
    description_embedding: [0.1, 0.2, 0.3],
    content: 'Skill content',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['test'],
    promoted_from: randomUUID(),
    promoted_at: now,
    agent_id: 'role_test',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// 测试用例
// ──────────────────────────────────────────────

describe('ruleBasedPersonaInduction', () => {
  it('空数据时生成 v2 Persona 且字段为占位文案', async () => {
    const { memory, role_id } = await createTestInfra('role_persona_empty');

    const current = await memory.getPersona();
    expect(current.version).toBe(1);

    const outcome = await ruleBasedPersonaInduction(memory, {
      role_id,
      currentPersona: current,
      experiences: [],
      skills: [],
    });

    expect(outcome.check.eligible).toBe(true);
    expect(outcome.persona).toBeDefined();
    expect(outcome.persona!.version).toBe(2);
    expect(outcome.persona!.skills_overview).toBe('No skills yet.');
    expect(outcome.persona!.experience_coverage).toBe('No experiences yet.');
    expect(outcome.persona!.recent_performance).toBe(current.recent_performance);
    expect(outcome.persona!.generated_at > current.generated_at).toBe(true);

    // 写入生效：scope 与 AgentBoard 读取路径（handle.persona）均同步
    const stored = await memory.getPersona();
    expect(stored.version).toBe(2);
    const agent = await memory.getAgent();
    expect(agent.persona.version).toBe(2);
  });

  it('有经验与技能时生成基于数据的概述字段', async () => {
    const { memory, role_id } = await createTestInfra('role_persona_seeded');

    await memory.saveExperience(
      createExperience({ description: 'Debug service latency', tags: ['debug', 'perf'] }),
    );
    await memory.saveExperience(
      createExperience({
        description: 'Handle payment webhook',
        tags: ['webhook'],
        confidence: 0.95,
      }),
    );
    await memory.saveSkill(
      createSkill({ description: 'Optimize SQL queries', tags: ['sql', 'perf'] }),
    );

    const current = await memory.getPersona();
    const experiences = await memory.listExperiences();
    const skills = await memory.listSkills();

    const outcome = await ruleBasedPersonaInduction(memory, {
      role_id,
      currentPersona: current,
      experiences,
      skills,
    });

    expect(outcome.persona).toBeDefined();
    // 技能概述包含数量与最新技能描述
    expect(outcome.persona!.skills_overview).toContain('1 skills promoted');
    expect(outcome.persona!.skills_overview).toContain('Optimize SQL queries');
    // 经验概述包含正负统计
    expect(outcome.persona!.experience_coverage).toContain('2 experiences');
    expect(outcome.persona!.experience_coverage).toContain('2 positive');
    // summary 保留当前定位
    expect(outcome.persona!.summary).toBe(current.summary);
  });

  it('version 持续递增', async () => {
    const { memory, role_id } = await createTestInfra('role_persona_evolve');

    const first = await memory.getPersona();
    await ruleBasedPersonaInduction(memory, {
      role_id,
      currentPersona: first,
      experiences: [],
      skills: [],
    });

    const second = await memory.getPersona();
    expect(second.version).toBe(2);
    await ruleBasedPersonaInduction(memory, {
      role_id,
      currentPersona: second,
      experiences: [],
      skills: [],
    });

    const third = await memory.getPersona();
    expect(third.version).toBe(3);
  });
});
