/**
 * UsageFeedback（方向 2：用后验证回写）测试
 *
 * 验证：
 *   1. fully_effective：confidence +0.1（封顶 0.98）、referenced_count+1、
 *      追加 confidence_history（reason='usage_validation:fully_effective'）
 *   2. partially_effective：confidence +0.05
 *   3. ineffective：confidence −0.1（下限 0.1 截断）
 *   4. not_applicable：confidence 不变，referenced_count 仍 +1
 *   5. 置信度封顶 0.98（保持 0.95 晋升门槛可达、又不饱和到 1.0）
 *   6. 引用不存在的经验 id → 静默跳过（skipped_missing）
 *   7. 空引用 → no-op
 *   8. 重算 avg_confidence
 */
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { applyUsageFeedback, type UsageReference } from '../services/usage-feedback';
import type { ExperienceRecord } from '../schemas';

const ROLE = 'role_usage';

async function setup() {
  const repository = new InMemoryRepository();
  await repository.initializeAgent({ role_id: ROLE, name: 'Usage Feedback' });
  return { repository };
}

function experience(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: `exp_${Math.random().toString(36).slice(2)}`,
    description: 'A reusable lesson',
    description_embedding: [],
    content: 'lesson content',
    confidence: 0.6,
    tags: ['typescript'],
    agent_id: ROLE,
    confidence_history: [],
    referenced_count: 0,
    source_task_id: 'task_origin',
    source_driver: 'test-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function reference(
  experience_id: string,
  effectiveness: UsageReference['effectiveness'],
): UsageReference {
  return { experience_id, applied: true, effectiveness, note: 'test' };
}

describe('applyUsageFeedback', () => {
  it('fully_effective: confidence +0.1, referenced_count+1, history + avg recompute', async () => {
    const { repository } = await setup();
    const target = experience({ confidence: 0.6 });
    await repository.saveExperience(ROLE, target);

    const result = await applyUsageFeedback(repository, ROLE, [
      reference(target.id, 'fully_effective'),
    ]);

    expect(result.updated_experiences).toBe(1);
    expect(result.skipped_missing).toBe(0);
    // 明细：供磁盘 evidence JSON 核对置信度增长
    expect(result.details).toEqual([
      {
        experience_id: target.id,
        description: target.description,
        effectiveness: 'fully_effective',
        from_confidence: 0.6,
        to_confidence: 0.7,
        referenced_count: 1,
      },
    ]);
    const updated = (await repository.listExperiences(ROLE))[0]!;
    expect(updated.confidence).toBeCloseTo(0.7);
    expect(updated.referenced_count).toBe(1);
    expect(updated.confidence_history.at(-1)).toMatchObject({
      value: 0.7,
      reason: 'usage_validation:fully_effective',
    });
    expect((await repository.getMetrics(ROLE)).avg_confidence).toBeCloseTo(0.7);
  });

  it('partially_effective: confidence +0.05', async () => {
    const { repository } = await setup();
    const target = experience({ confidence: 0.6 });
    await repository.saveExperience(ROLE, target);

    await applyUsageFeedback(repository, ROLE, [
      reference(target.id, 'partially_effective'),
    ]);

    const updated = (await repository.listExperiences(ROLE))[0]!;
    expect(updated.confidence).toBeCloseTo(0.65);
    expect(updated.referenced_count).toBe(1);
  });

  it('ineffective: confidence -0.1 with a 0.1 floor', async () => {
    const { repository } = await setup();
    const high = experience({ confidence: 0.6 });
    const low = experience({ confidence: 0.05 });
    await repository.saveExperience(ROLE, high);
    await repository.saveExperience(ROLE, low);

    await applyUsageFeedback(repository, ROLE, [
      reference(high.id, 'ineffective'),
      reference(low.id, 'ineffective'),
    ]);

    const experiences = await repository.listExperiences(ROLE);
    expect(experiences.find((e) => e.id === high.id)!.confidence).toBeCloseTo(0.5);
    expect(experiences.find((e) => e.id === low.id)!.confidence).toBeCloseTo(0.1);
  });

  it('not_applicable: confidence unchanged, referenced_count still +1', async () => {
    const { repository } = await setup();
    const target = experience({ confidence: 0.6 });
    await repository.saveExperience(ROLE, target);

    await applyUsageFeedback(repository, ROLE, [
      reference(target.id, 'not_applicable'),
    ]);

    const updated = (await repository.listExperiences(ROLE))[0]!;
    expect(updated.confidence).toBeCloseTo(0.6);
    expect(updated.referenced_count).toBe(1);
  });

  it('caps confidence at 0.98 so the 0.95 promotion gate stays reachable but not saturated', async () => {
    const { repository } = await setup();
    const target = experience({ confidence: 0.95 });
    await repository.saveExperience(ROLE, target);

    await applyUsageFeedback(repository, ROLE, [
      reference(target.id, 'fully_effective'),
      reference(target.id, 'fully_effective'),
    ]);

    const updated = (await repository.listExperiences(ROLE))[0]!;
    expect(updated.confidence).toBeCloseTo(0.98);
    expect(updated.referenced_count).toBe(2);
  });

  it('repeated fully_effective uses cross the 0.95 promotion gate', async () => {
    const { repository } = await setup();
    const target = experience({ confidence: 0.8 });
    await repository.saveExperience(ROLE, target);

    await applyUsageFeedback(repository, ROLE, [
      reference(target.id, 'fully_effective'),
      reference(target.id, 'fully_effective'),
    ]);

    const updated = (await repository.listExperiences(ROLE))[0]!;
    expect(updated.confidence).toBeGreaterThan(0.95);
  });

  it('skips missing experience ids without failing', async () => {
    const { repository } = await setup();
    const result = await applyUsageFeedback(repository, ROLE, [
      reference('exp_missing', 'fully_effective'),
    ]);

    expect(result).toEqual({
      updated_experiences: 0,
      skipped_missing: 1,
      details: [],
    });
    await expect(repository.listExperiences(ROLE)).resolves.toEqual([]);
  });

  it('empty references is a no-op', async () => {
    const { repository } = await setup();
    const result = await applyUsageFeedback(repository, ROLE, []);
    expect(result).toEqual({ updated_experiences: 0, skipped_missing: 0, details: [] });
  });

  it('records one detail entry per distinct reference, accumulating within a batch', async () => {
    const { repository } = await setup();
    const target = experience({ confidence: 0.7 });
    await repository.saveExperience(ROLE, target);

    const result = await applyUsageFeedback(repository, ROLE, [
      reference(target.id, 'fully_effective'),
      reference(target.id, 'partially_effective'),
    ]);

    expect(result.details).toHaveLength(2);
    expect(result.details[0]).toMatchObject({
      effectiveness: 'fully_effective',
      from_confidence: 0.7,
      to_confidence: 0.8,
      referenced_count: 1,
    });
    expect(result.details[1]).toMatchObject({
      effectiveness: 'partially_effective',
      from_confidence: 0.8,
      to_confidence: 0.85,
      referenced_count: 2,
    });
  });
});
