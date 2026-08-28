/**
 * SkillPromotionProcessor 测试
 *
 * 验证：
 *   1. promoteAll 晋升所有符合条件的经验
 *   2. promoteAll 无符合条件的经验返回空
 *   3. checkAndPromote 满足 policy 时晋升
 *   4. checkAndPromote 不满足 policy 时跳过
 *   5. 已晋升的经验被跳过
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { DefaultPromotionTriggerPolicy } from '../adapters/default-promotion-trigger-policy';
import { SkillPromotionProcessor } from '../runtime/skill-promotion-processor';
import { ruleBasedSkillPromotion } from '../services/skill-promotion';
import type { ExperienceRecord } from '../schemas';

// ──────────────────────────────────────────────
// 测试基础设施
// ──────────────────────────────────────────────

async function createTestInfra(role_id = 'role_promote_test') {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  await repository.initializeAgent({ role_id, name: 'Test Agent', tags: [] });
  await bufferRepository.ensureAgent(role_id);
  const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
  return { repository, bufferRepository, memory, role_id };
}

function createExperience(
  overrides: Partial<ExperienceRecord> & { id?: string } = {},
): ExperienceRecord {
  const now = nowTimestamp();
  const id = overrides.id ?? randomUUID();
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

// ──────────────────────────────────────────────
// 测试用例
// ──────────────────────────────────────────────

describe('SkillPromotionProcessor', () => {
  describe('promoteAll — 手动模式', () => {
    it('晋升所有符合条件的经验', async () => {
      const { memory } = await createTestInfra('role_promote_all');

      // 保存 3 条高置信度经验
      const exp1 = createExperience({ confidence: 0.96 });
      const exp2 = createExperience({ confidence: 0.97 });
      const exp3 = createExperience({ confidence: 0.99 });
      await memory.saveExperience(exp1);
      await memory.saveExperience(exp2);
      await memory.saveExperience(exp3);

      const processor = new SkillPromotionProcessor(
        new DefaultPromotionTriggerPolicy(5, 0.98, 86400000),
        ruleBasedSkillPromotion,
      );

      const results = await processor.promoteAll(memory);
      expect(results).toHaveLength(3);

      // 验证晋升成功
      for (const result of results) {
        expect(result.check.eligible).toBe(true);
        expect(result.skill).toBeDefined();
        expect(result.skill!.promoted_from).toBeDefined();
      }

      // 验证 experiences 的 promoted_to 已更新
      const allExps = await memory.listExperiences();
      const promotedExps = allExps.filter((e) => e.promoted_to !== undefined);
      expect(promotedExps).toHaveLength(3);

      // 验证技能已创建
      const skills = await memory.listSkills();
      expect(skills).toHaveLength(3);
    });

    it('无符合条件的经验时返回空数组', async () => {
      const { memory } = await createTestInfra('role_promote_none');

      // 保存低置信度经验
      const exp = createExperience({ confidence: 0.5 });
      await memory.saveExperience(exp);

      const processor = new SkillPromotionProcessor(
        new DefaultPromotionTriggerPolicy(5, 0.98, 86400000),
        ruleBasedSkillPromotion,
      );

      const results = await processor.promoteAll(memory);
      expect(results).toHaveLength(0);
    });

    it('confidenceThreshold 下调后低置信度经验可晋升（全自动化测评用）', async () => {
      const { memory } = await createTestInfra('role_promote_low_threshold');

      // 保存低于默认 0.95、但高于下调后阈值的经验
      const exp = createExperience({ confidence: 0.6 });
      await memory.saveExperience(exp);

      const processor = new SkillPromotionProcessor(
        new DefaultPromotionTriggerPolicy(5, 0.98, 86400000),
        ruleBasedSkillPromotion,
        { confidenceThreshold: 0.5 },
      );

      const results = await processor.promoteAll(memory);
      expect(results).toHaveLength(1);
      expect(results[0]!.check.eligible).toBe(true);
      expect(results[0]!.skill).toBeDefined();

      const skills = await memory.listSkills();
      expect(skills).toHaveLength(1);
    });

    it('跳过已晋升的经验', async () => {
      const { memory } = await createTestInfra('role_promote_skip');

      // 保存 2 条经验：一条已晋升，一条未晋升
      const promotedExp = createExperience({
        confidence: 0.96,
        promoted_to: 'existing-skill-id',
      });
      const eligibleExp = createExperience({ confidence: 0.97 });
      await memory.saveExperience(promotedExp);
      await memory.saveExperience(eligibleExp);

      const processor = new SkillPromotionProcessor(
        new DefaultPromotionTriggerPolicy(5, 0.98, 86400000),
        ruleBasedSkillPromotion,
      );

      const results = await processor.promoteAll(memory);
      expect(results).toHaveLength(1);
      expect(results[0]!.check.eligible).toBe(true);
    });

    it('跳过负经验（type=negative）', async () => {
      const { memory } = await createTestInfra('role_promote_negative');

      const negativeExp = createExperience({
        confidence: 0.96,
        type: 'negative',
      });
      await memory.saveExperience(negativeExp);

      const processor = new SkillPromotionProcessor(
        new DefaultPromotionTriggerPolicy(5, 0.98, 86400000),
        ruleBasedSkillPromotion,
      );

      const results = await processor.promoteAll(memory);
      expect(results).toHaveLength(0);
    });
  });

  describe('checkAndPromote — 自动模式', () => {
    it('满足容量门控（eligible_count >= 5）时晋升', async () => {
      const { memory } = await createTestInfra('role_check_capacity');

      // 保存 5 条高置信度经验
      for (let i = 0; i < 5; i++) {
        await memory.saveExperience(createExperience({ confidence: 0.96 }));
      }

      const processor = new SkillPromotionProcessor(
        new DefaultPromotionTriggerPolicy(5, 0.98, 86400000),
        ruleBasedSkillPromotion,
      );

      const results = await processor.checkAndPromote(memory);
      expect(results).toHaveLength(5);
    });

    it('不满足 policy 时跳过', async () => {
      const { memory } = await createTestInfra('role_check_skip');

      // 仅 2 条高置信度经验（minEligibleCount=5）
      for (let i = 0; i < 2; i++) {
        await memory.saveExperience(createExperience({ confidence: 0.96 }));
      }

      const processor = new SkillPromotionProcessor(
        new DefaultPromotionTriggerPolicy(5, 0.98, 86400000),
        ruleBasedSkillPromotion,
      );

      const results = await processor.checkAndPromote(memory);
      expect(results).toHaveLength(0);
    });

    it('满足高信门控（has_high_confidence）时晋升', async () => {
      const { memory } = await createTestInfra('role_check_high_conf');

      // 1 条超高置信度经验 + 一些低置信度的
      await memory.saveExperience(createExperience({ confidence: 0.99 }));
      await memory.saveExperience(createExperience({ confidence: 0.5 }));
      await memory.saveExperience(createExperience({ confidence: 0.3 }));

      const processor = new SkillPromotionProcessor(
        new DefaultPromotionTriggerPolicy(10, 0.98, 86400000),
        ruleBasedSkillPromotion,
      );

      const results = await processor.checkAndPromote(memory);
      // 虽然 eligible_count=1 < 10, 但 has_high_confidence=true => 触发
      // 只有 confidence 0.99 的会被晋升（0.5 和 0.3 低于 0.95 门槛）
      expect(results).toHaveLength(1);
      expect(results[0]!.check.eligible).toBe(true);
    });

    it('使用已有技能的 promoted_at 计算 last_promotion_at', async () => {
      const { memory, repository } = await createTestInfra('role_check_timegate');

      // 创建一个旧技能（模拟很久前晋升过）
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const oldSkill = {
        id: randomUUID(),
        description: 'Old skill',
        description_embedding: [0.1, 0.2, 0.3],
        content: 'Old skill content',
        version: '1.0.0',
        review_status: 'pending' as const,
        tags: ['old'],
        promoted_from: randomUUID(),
        promoted_at: oldDate,
        agent_id: 'role_check_timegate',
        created_at: oldDate,
        updated_at: oldDate,
      };
      await repository.saveSkill('role_check_timegate', oldSkill);

      // 保存 1 条高置信度经验
      await memory.saveExperience(createExperience({ confidence: 0.96 }));

      // maxStalenessMs=100ms, 老技能在 48h 前 => 时间门控触发
      const processor = new SkillPromotionProcessor(
        new DefaultPromotionTriggerPolicy(10, 0.98, 100),
        ruleBasedSkillPromotion,
      );

      const results = await processor.checkAndPromote(memory);
      expect(results).toHaveLength(1);
    });

    it('没有 eligible 经验时返回空数组', async () => {
      const { memory } = await createTestInfra('role_check_empty');

      const processor = new SkillPromotionProcessor(
        new DefaultPromotionTriggerPolicy(5, 0.98, 86400000),
        ruleBasedSkillPromotion,
      );

      const results = await processor.checkAndPromote(memory);
      expect(results).toHaveLength(0);
    });
  });
});
