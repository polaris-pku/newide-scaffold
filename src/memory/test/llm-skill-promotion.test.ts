import { describe, it, expect, beforeEach } from 'vitest';
import { LlmSkillPromotion } from '../adapters/llm-skill-promotion';
import { MockLlmClient } from '../adapters/mock-llm-client';
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
    description: 'Used JWT for auth',
    description_embedding: [0.1, 0.2, 0.3],
    content:
      'JWT authentication proved more reliable than session-based approach. Implemented token refresh and validation middleware.',
    confidence: 0.97,
    tags: ['auth', 'jwt'],
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

describe('LlmSkillPromotion', () => {
  let memory: AgentMemoryScope;
  let repository: InMemoryRepository;

  beforeEach(async () => {
    repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    await repository.initializeAgent({ role_id: 'role_test', name: 'Test Agent', tags: [] });
    await bufferRepository.ensureAgent('role_test');
    memory = createAgentMemoryScope(repository, bufferRepository, 'role_test');
  });

  it('正常流程：LLM 返回有效 JSON → skill 被 LLM 改写', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          description: 'Prefer JWT-based authentication over sessions',
          content:
            'When implementing authentication:\n1. Use JWT for stateless auth\n2. Implement refresh token rotation\n3. Add validation middleware',
          tags: ['authentication', 'jwt', 'security', 'best-practice'],
        }),
      },
    ]);
    const promoter = new LlmSkillPromotion(llm);
    const experience = makeExperience();
    await seedExperience(repository, experience);

    const result = await promoter.promote(memory, defaultTask, [experience]);

    expect(result.check.eligible).toBe(true);
    expect(result.skill).toBeDefined();
    expect(result.skill!.description).toBe('Prefer JWT-based authentication over sessions');
    expect(result.skill!.content).toContain('refresh token rotation');
    expect(result.skill!.tags).toContain('authentication');
    expect(result.skill!.tags).toContain('jwt');
    expect(result.skill!.promoted_from).toBe(experience.id);
    expect(result.skill!.review_status).toBe('pending');
  });

  it('LLM 抛异常 → 降级到 rule-based（description/content/tags 原样复制）', async () => {
    const llm = new MockLlmClient([{ response: 'ERROR:Network timeout' }]);
    const promoter = new LlmSkillPromotion(llm);
    const experience = makeExperience();
    await seedExperience(repository, experience);

    const result = await promoter.promote(memory, defaultTask, [experience]);

    expect(result.check.eligible).toBe(true);
    expect(result.skill).toBeDefined();
    // 降级后 description 是经验原文，不是 LLM 改写的版本
    expect(result.skill!.description).toBe('Used JWT for auth');
    expect(result.skill!.content).toContain('JWT authentication');
    expect(result.skill!.tags).toEqual(['auth', 'jwt']);
  });

  it('JSON 格式错误 → 降级到 rule-based', async () => {
    const llm = new MockLlmClient([{ response: 'not valid json at all' }]);
    const promoter = new LlmSkillPromotion(llm);
    const experience = makeExperience();
    await seedExperience(repository, experience);

    const result = await promoter.promote(memory, defaultTask, [experience]);

    expect(result.check.eligible).toBe(true);
    expect(result.skill).toBeDefined();
    expect(result.skill!.description).toBe('Used JWT for auth');
  });

  it('缺少 description 字段 → 降级', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({ content: 'Only content', tags: [] }),
      },
    ]);
    const promoter = new LlmSkillPromotion(llm);
    await seedExperience(repository, makeExperience());

    const result = await promoter.promote(memory, defaultTask, [makeExperience()]);

    expect(result.check.eligible).toBe(true);
    expect(result.skill).toBeDefined();
    expect(result.skill!.description).toBe('Used JWT for auth');
  });

  it('空 experiences 数组 → 不晋升', async () => {
    const llm = new MockLlmClient([]);
    const promoter = new LlmSkillPromotion(llm);

    const result = await promoter.promote(memory, defaultTask, []);

    expect(result.check.eligible).toBe(false);
    expect(result.skill).toBeUndefined();
  });

  it('confidence <= 0.95 → 不晋升（系统检查先行，不调用 LLM）', async () => {
    // Mock 会抛 ERROR 因为没有配置响应，但由于系统检查先于 LLM 调用，不会触发
    const llm = new MockLlmClient([{ response: 'ERROR:Should not be called' }]);
    const promoter = new LlmSkillPromotion(llm);
    const experience = makeExperience({ confidence: 0.9 });
    await seedExperience(repository, experience);

    const result = await promoter.promote(memory, defaultTask, [experience]);

    expect(result.check.eligible).toBe(false);
    expect(result.skill).toBeUndefined();
  });

  it('confidenceThreshold 下调后低置信度经验调用 LLM 晋升（全自动化测评用）', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          description: 'Prefer stable identifiers over positional indexes',
          content: 'Use stable keys to avoid breakage.',
          tags: ['best-practice'],
        }),
      },
    ]);
    const promoter = new LlmSkillPromotion(llm, { confidenceThreshold: 0.5 });
    const experience = makeExperience({ confidence: 0.6 });
    await seedExperience(repository, experience);

    const result = await promoter.promote(memory, defaultTask, [experience]);

    expect(result.check.eligible).toBe(true);
    expect(result.skill).toBeDefined();
    expect(result.skill!.description).toBe('Prefer stable identifiers over positional indexes');
    expect(result.skill!.review_status).toBe('pending');
  });

  it('负经验 → 不晋升', async () => {
    const llm = new MockLlmClient([{ response: 'ERROR:Should not be called' }]);
    const promoter = new LlmSkillPromotion(llm);
    const experience = makeExperience({ type: 'negative', confidence: 0.99 });

    const result = await promoter.promote(memory, defaultTask, [experience]);

    expect(result.check.eligible).toBe(false);
    expect(result.skill).toBeUndefined();
  });

  it('已晋升的 experience → 不晋升', async () => {
    const llm = new MockLlmClient([{ response: 'ERROR:Should not be called' }]);
    const promoter = new LlmSkillPromotion(llm);
    const experience = makeExperience({
      promoted_to: '00000000-0000-0000-0000-000000000099',
    });

    const result = await promoter.promote(memory, defaultTask, [experience]);

    expect(result.check.eligible).toBe(false);
    expect(result.skill).toBeUndefined();
  });

  it('LLM 返回空 tags 不影响晋升', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          description: 'Use JWT auth',
          content: 'JWT is more scalable',
          tags: [],
        }),
      },
    ]);
    const promoter = new LlmSkillPromotion(llm);
    const experience = makeExperience();
    await seedExperience(repository, experience);

    const result = await promoter.promote(memory, defaultTask, [experience]);

    expect(result.check.eligible).toBe(true);
    expect(result.skill).toBeDefined();
    expect(result.skill!.tags).toEqual([]);
  });

  it('多个经验中第一个 eligible 被 LLM 提升', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          description: 'LLM-enhanced skill',
          content: 'LLM generated content',
          tags: ['llm'],
        }),
      },
    ]);
    const promoter = new LlmSkillPromotion(llm);
    const first = makeExperience({
      id: 'id-001',
      confidence: 0.99,
      promoted_to: 'existing-skill',
      description: 'Already promoted',
    });
    const second = makeExperience({
      id: 'id-002',
      confidence: 0.98,
      description: 'Eligible experience',
    });
    await seedExperience(repository, second);

    const result = await promoter.promote(memory, defaultTask, [first, second]);

    expect(result.check.eligible).toBe(true);
    expect(result.skill).toBeDefined();
    expect(result.skill!.description).toBe('LLM-enhanced skill');
    expect(result.skill!.promoted_from).toBe(second.id);
  });
});
