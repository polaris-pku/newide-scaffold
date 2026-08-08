/**
 * PersonaEvolutionProcessor 测试
 *
 * 验证：
 *   1. evolveAll 手动模式直接演化（version+1）
 *   2. checkAndEvolve 满足 policy（技能增长）时演化
 *   3. checkAndEvolve 不满足 policy 时跳过
 *   4. checkAndEvolve 无新数据时 no-op
 *   5. 反复演化 version 持续递增
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { DefaultPersonaTriggerPolicy } from '../adapters/default-persona-trigger-policy';
import { PersonaEvolutionProcessor } from '../runtime/persona-evolution-processor';
import { ruleBasedPersonaInduction } from '../services/rule-based-persona-induction';
import type { SkillRecord } from '../schemas';

// ──────────────────────────────────────────────
// 测试基础设施
// ──────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

async function createTestInfra(role_id = 'role_evolve_test') {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  await repository.initializeAgent({ role_id, name: 'Test Agent', tags: [] });
  await bufferRepository.ensureAgent(role_id);
  const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
  return { repository, memory, role_id };
}

function createSkill(overrides: Partial<SkillRecord> & { created_at: string }): SkillRecord {
  const id = randomUUID();
  const created_at = overrides.created_at;
  return {
    id,
    description: `Skill ${id.slice(0, 8)}`,
    description_embedding: [0.1, 0.2, 0.3],
    content: 'Skill content',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['test'],
    promoted_from: randomUUID(),
    promoted_at: created_at,
    agent_id: 'role_evolve_test',
    updated_at: created_at,
    // created_at 由 overrides 提供（required），展开会覆盖上面的 promoted_at/updated_at
    ...overrides,
  };
}

function defaultProcessor(): PersonaEvolutionProcessor {
  return new PersonaEvolutionProcessor(
    new DefaultPersonaTriggerPolicy(3, 7 * DAY, 30 * DAY),
    ruleBasedPersonaInduction,
  );
}

// ──────────────────────────────────────────────
// 测试用例
// ──────────────────────────────────────────────

describe('PersonaEvolutionProcessor', () => {
  describe('evolveAll — 手动模式', () => {
    it('直接演化 Persona（version+1）且写入生效', async () => {
      const { memory } = await createTestInfra('role_evolve_all');

      const before = await memory.getPersona();
      expect(before.version).toBe(1);

      const results = await defaultProcessor().evolveAll(memory);
      expect(results).toHaveLength(1);
      expect(results[0]!.check.eligible).toBe(true);
      expect(results[0]!.persona!.version).toBe(2);

      const after = await memory.getPersona();
      expect(after.version).toBe(2);
    });
  });

  describe('checkAndEvolve — 自动模式', () => {
    it('满足技能增长门控（新技能 >= 3）时演化', async () => {
      const { memory } = await createTestInfra('role_evolve_growth');

      // created_at 需严格晚于 persona.generated_at（毫秒级比较，避免同毫秒碰撞）
      const current = await memory.getPersona();
      const after = new Date(new Date(current.generated_at).getTime() + 1000).toISOString();
      for (let i = 0; i < 3; i++) {
        await memory.saveSkill(createSkill({ created_at: after }));
      }

      const results = await defaultProcessor().checkAndEvolve(memory);
      expect(results).toHaveLength(1);
      expect((await memory.getPersona()).version).toBe(2);
    });

    it('新增技能不足时不演化', async () => {
      const { memory } = await createTestInfra('role_evolve_not_enough');

      const now = nowTimestamp();
      await memory.saveSkill(createSkill({ created_at: now }));

      const results = await defaultProcessor().checkAndEvolve(memory);
      expect(results).toHaveLength(0);
      expect((await memory.getPersona()).version).toBe(1);
    });

    it('定期门控：距上次归纳超过周期且有新经验时演化', async () => {
      const { memory, role_id } = await createTestInfra('role_evolve_periodic');

      // 先把 persona 生成时间拨回 8 天前（模拟久未演化）
      const old = await memory.getPersona();
      await memory.savePersona({
        ...old,
        generated_at: new Date(Date.now() - 8 * DAY).toISOString(),
      });

      // 新增一条经验（created_at 在旧的 generated_at 之后）
      const now = nowTimestamp();
      await memory.saveExperience({
        id: randomUUID(),
        description: 'New experience',
        description_embedding: [0.1, 0.2, 0.3],
        content: 'content',
        confidence: 0.8,
        tags: ['test'],
        agent_id: role_id,
        type: 'positive',
        confidence_history: [{ value: 0.8, updated_at: now, reason: 'initial' }],
        referenced_count: 0,
        source_task_id: 'task_001',
        source_driver: 'test-driver',
        created_at: now,
        updated_at: now,
      });

      const results = await defaultProcessor().checkAndEvolve(memory);
      expect(results).toHaveLength(1);
      expect((await memory.getPersona()).version).toBe(2);
    });

    it('无新数据时 no-op（version 不变）', async () => {
      const { memory } = await createTestInfra('role_evolve_noop');

      const results = await defaultProcessor().checkAndEvolve(memory);
      expect(results).toHaveLength(0);
      expect((await memory.getPersona()).version).toBe(1);
    });

    it('反复演化 version 持续递增', async () => {
      const { memory } = await createTestInfra('role_evolve_repeat');

      const processor = defaultProcessor();

      const current = await memory.getPersona();
      const after = new Date(new Date(current.generated_at).getTime() + 1000).toISOString();

      // 第一轮：新增 3 个技能（晚于 persona 生成时间）触发演化
      for (let i = 0; i < 3; i++) {
        await memory.saveSkill(createSkill({ created_at: after }));
      }
      await processor.checkAndEvolve(memory);
      expect((await memory.getPersona()).version).toBe(2);

      // 第二轮：再新增 3 个技能（晚于新 persona 生成时间）再次触发
      const second = await memory.getPersona();
      const after2 = new Date(new Date(second.generated_at).getTime() + 1000).toISOString();
      for (let i = 0; i < 3; i++) {
        await memory.saveSkill(createSkill({ created_at: after2 }));
      }
      await processor.checkAndEvolve(memory);
      expect((await memory.getPersona()).version).toBe(3);
    });
  });
});
