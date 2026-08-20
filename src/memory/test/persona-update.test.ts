/**
 * PersonaUpdate（M3：memory.updatePersona / regeneratePersona）测试
 *
 * 验证：
 *   1. mergePersonaPatch：PATCH 合并自由文本字段、version+1、generated_at 刷新
 *   2. regeneratePersona：委托归纳器基于当前 skills/experiences 写回新 Persona
 *      （注入规则版归纳器验证真实路径；注入无 persona 的归纳器验证抛错）
 */
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { ruleBasedPersonaInduction } from '../services/rule-based-persona-induction';
import { mergePersonaPatch, regeneratePersona, type PersonaInducer } from '../services/persona-update';

const ROLE = 'role_persona';

async function setup() {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  await repository.initializeAgent({
    role_id: ROLE,
    name: 'Persona Agent',
    persona_seed: 'Seed summary.',
  });
  return { repository, bufferRepository };
}

describe('mergePersonaPatch', () => {
  it('patches only provided fields and bumps version', async () => {
    const { repository } = await setup();
    const before = await repository.getPersona(ROLE);

    const updated = await mergePersonaPatch(repository, ROLE, {
      summary: 'New summary',
      notes: 'manual edit',
    });

    expect(updated.version).toBe(before.version + 1);
    expect(updated.summary).toBe('New summary');
    expect(updated.notes).toBe('manual edit');
    // 未提供的字段保持原值
    expect(updated.skills_overview).toBe(before.skills_overview);
    expect(updated.generated_at).not.toBe(before.generated_at);
    // 已落库
    expect((await repository.getPersona(ROLE)).summary).toBe('New summary');
  });
});

describe('regeneratePersona', () => {
  it('re-induces from skills and experiences via the injected inducer', async () => {
    const { repository, bufferRepository } = await setup();
    await repository.saveSkill(ROLE, {
      id: 'skill_1',
      description: 'TS services',
      description_embedding: [],
      content: 'content',
      version: '1.0.0',
      review_status: 'approved',
      tags: ['typescript'],
      promoted_at: nowTimestamp(),
      agent_id: ROLE,
      created_at: nowTimestamp(),
      updated_at: nowTimestamp(),
    });
    const before = await repository.getPersona(ROLE);

    const regenerated = await regeneratePersona(
      repository,
      bufferRepository,
      ROLE,
      ruleBasedPersonaInduction,
    );

    expect(regenerated.version).toBe(before.version + 1);
    expect(regenerated.skills_overview).toContain('1 skills promoted');
    expect((await repository.getPersona(ROLE)).version).toBe(before.version + 1);
  });

  it('throws when the inducer produces no persona', async () => {
    const { repository, bufferRepository } = await setup();
    const emptyInducer: PersonaInducer = async () => ({
      check: {
        eligible: false,
        auto_approved: false,
        reasons: ['blocked'],
        blocking_rules: ['no regeneration'],
      },
    });

    await expect(
      regeneratePersona(repository, bufferRepository, ROLE, emptyInducer),
    ).rejects.toThrow(/produced no persona/);
  });
});
