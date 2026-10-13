import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { ruleBasedSkillPromotion } from '../services/skill-promotion';
import {
  DefaultPromotionStrategy,
  DEFAULT_PROMOTION_STRATEGY_VERSION,
} from '../adapters/default-promotion-strategy';
import {
  comparePromotionCandidates,
  planPromotionCandidate,
  promotionInputSnapshotHash,
  promotionStateLabel,
  selectPromotionCandidates,
} from '../services/promotion-candidates';
import {
  AGENT_MISSING_PREFIX,
  assertPromotionDecisionConsistent,
  buildPromotedSkill,
  classifyPromotionFailure,
  executePromotionCandidate,
} from '../services/promotion-executor';
import { PromotionSkillIntegrityError } from '../services/promotion-integrity';
import { persistExtractedExperiences, stableExperienceId } from '../services/memory-cycle';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { PromotionStrategy } from '../ports/promotion-strategy';
import type { ExperienceSaveResult, SkillSaveResult } from '../ports/memory-repository';
import { ExperienceRecordSchema, SkillRecordSchema } from '../schemas';
import type { ExperiencePromotion, ExperienceRecord, SkillRecord } from '../schemas';
import type { CandidateExperience } from '../types';
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

/** 提取器产出的候选经验：与 ExperienceRecord 同形，但没有归属（agent_id） */
function makeCandidate(overrides: Partial<CandidateExperience> = {}): CandidateExperience {
  const { agent_id: _agent_id, ...candidate } = makeExperience();
  return { ...candidate, ...overrides };
}

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

/**
 * 晋升是两步写：先存 Skill、再把 Experience 的 promoted_to 指过去。第二步失败后重试（或
 * 两个调用并发）若每次都新建 Skill，就会攒出成对的重复技能，而 Experience 的 promoted_to
 * 只能指向其中一个——另一个变成没有任何来源的孤儿。幂等键是 (role_id, promoted_from)。
 */
describe('ruleBasedSkillPromotion：幂等', () => {
  let repository: FlakyUpdateRepository;
  let bufferRepository: InMemoryBufferRepository;
  let memory: AgentMemoryScope;

  beforeEach(async () => {
    repository = new FlakyUpdateRepository();
    bufferRepository = new InMemoryBufferRepository();
    await repository.initializeAgent({ role_id: 'role_test', name: 'Test Agent', tags: [] });
    await bufferRepository.ensureAgent('role_test');
    memory = createAgentMemoryScope(repository, bufferRepository, 'role_test');
  });

  it('updateExperience 失败后重试：复用已有 Skill，不生成第二个', async () => {
    const experience = makeExperience({ confidence: 0.99 });
    await repository.saveExperience('role_test', experience);
    repository.failNextUpdate = true;

    // 第一次：Skill 存进去了，回写 promoted_to 失败 → 整条抛出
    await expect(ruleBasedSkillPromotion(memory, defaultTask, [experience])).rejects.toThrow(
      'update failed',
    );
    expect(await repository.listSkills('role_test')).toHaveLength(1);
    const created = (await repository.listSkills('role_test'))[0]!;

    // 重试：experience 仍未被标记晋升（第二步没成功），但 Skill 已存在 → 复用
    const retried = await ruleBasedSkillPromotion(memory, defaultTask, [experience]);
    expect(retried.check.eligible).toBe(true);
    expect(retried.skill!.id).toBe(created.id);
    expect(retried.check.reasons.join(' ')).toContain('reused');

    const skills = await repository.listSkills('role_test');
    expect(skills).toHaveLength(1);
    // promoted_to 指向唯一那个 Skill
    const stored = (await repository.listExperiences('role_test')).find(
      (item) => item.id === experience.id,
    );
    expect(stored!.promoted_to).toBe(skills[0]!.id);
  });

  it('并发晋升同一条 Experience：只产生一条 Skill，promoted_to 指向它', async () => {
    const experience = makeExperience({ confidence: 0.99 });
    await repository.saveExperience('role_test', experience);

    const [left, right] = await Promise.all([
      ruleBasedSkillPromotion(memory, defaultTask, [experience]),
      ruleBasedSkillPromotion(memory, defaultTask, [experience]),
    ]);

    expect(left.skill!.id).toBe(right.skill!.id);
    const skills = await repository.listSkills('role_test');
    expect(skills).toHaveLength(1);
    expect(skills[0]!.promoted_from).toBe(experience.id);

    const stored = (await repository.listExperiences('role_test')).find(
      (item) => item.id === experience.id,
    );
    expect(stored!.promoted_to).toBe(skills[0]!.id);
  });

  it('saveSkillIfAbsent：promoted_from 为空时退化为普通保存，不做去重', async () => {
    const now = new Date().toISOString();
    const skill: SkillRecord = {
      id: '00000000-0000-0000-0000-0000000000a1',
      description: 'Imported skill',
      description_embedding: [0.1, 0.2, 0.3],
      content: 'Content',
      version: '1.0.0',
      review_status: 'pending',
      tags: [],
      promoted_at: now,
      agent_id: 'role_test',
      created_at: now,
      updated_at: now,
    };

    const first = await repository.saveSkillIfAbsent('role_test', skill);
    const second = await repository.saveSkillIfAbsent('role_test', skill);
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(await repository.listSkills('role_test')).toHaveLength(2);
  });
});

/**
 * 提取落库的并发幂等。
 *
 * 提取的粒度是**整条 Buffer**：一个 worker 处理 (role_id, buffer_seq) 时要把它提取出的
 * 全部经验写进去。稳定 id（stableExperienceId）只让**顺序重试**认得出「这条已经写过」，
 * 认不出**并发重入**——两个独立的 Memory Maintenance worker 同时处理同一条 Buffer 时，
 * 「先 listExperiences 再 saveExperience」是两次独立往返，两边都看不见对方那条：内存实现
 * 会攒出重复 id，PG 实现会有一方撞主键被抛异常。所以检查与写入必须在存储层原子完成。
 */
describe('提取落库的并发幂等（saveExperienceIfAbsent / persistExtractedExperiences）', () => {
  let repository: InMemoryRepository;
  let bufferRepository: InMemoryBufferRepository;
  let memory: AgentMemoryScope;

  beforeEach(async () => {
    repository = new InMemoryRepository();
    bufferRepository = new InMemoryBufferRepository();
    await repository.initializeAgent({ role_id: 'role_test', name: 'Test Agent', tags: [] });
    await bufferRepository.ensureAgent('role_test');
    memory = createAgentMemoryScope(repository, bufferRepository, 'role_test');
  });

  async function countOnce(): Promise<void> {
    const handle = await repository.getAgent('role_test');
    const metrics = await repository.getMetrics('role_test');
    const stored = await repository.listExperiences('role_test');
    expect(stored).toHaveLength(new Set(stored.map((item) => item.id)).size);
    expect(handle.experience_count).toBe(stored.length);
    expect(metrics.experience_count).toBe(stored.length);
    expect(handle.owned_exps).toHaveLength(stored.length);
    expect(new Set(handle.owned_exps).size).toBe(stored.length);
  }

  it('saveExperienceIfAbsent 并发保存同一 id：只留一条，两个调用方拿到同一条，计数只加一次', async () => {
    const experience = makeExperience();

    const [left, right] = await Promise.all([
      repository.saveExperienceIfAbsent('role_test', experience),
      repository.saveExperienceIfAbsent('role_test', experience),
    ]);

    // 一个真正写入，另一个幂等命中——谁都不收到冲突异常
    expect([left.created, right.created].filter(Boolean)).toHaveLength(1);
    expect(left.experience.id).toBe(experience.id);
    expect(right.experience.id).toBe(experience.id);
    await expect(repository.listExperiences('role_test')).resolves.toHaveLength(1);
    await countOnce();
  });

  it('两个 worker 并发处理同一条 Buffer：只留一批经验，两边拿到同一批，计数只加一次', async () => {
    const candidates = [makeCandidate(), makeCandidate(), makeCandidate()];

    const [left, right] = await Promise.all([
      persistExtractedExperiences(memory, 1, candidates),
      persistExtractedExperiences(memory, 1, candidates),
    ]);

    // 两边都拿到底层**持久化过**的那一批：id 是稳定 id，不是各写各的瞬时产物
    const expectedIds = candidates.map((_, index) => stableExperienceId('role_test', 1, index));
    expect(left.experiences.map((item) => item.id)).toEqual(expectedIds);
    expect(right.experiences.map((item) => item.id)).toEqual(expectedIds);
    expect(left.created + right.created).toBe(candidates.length);
    expect(left.already_present + right.already_present).toBe(candidates.length);

    const stored = await repository.listExperiences('role_test');
    expect(stored).toHaveLength(candidates.length);
    // agent_id 的权威仍是 memory.role_id：候选里的任何取值都不参与归属
    expect(stored.every((item) => item.agent_id === 'role_test')).toBe(true);
    await countOnce();
  });

  it('部分写入失败后重试整条 Buffer：已写的那条不重复，缺的补上', async () => {
    const flaky = new FlakyExperienceRepository();
    await flaky.initializeAgent({ role_id: 'role_test', name: 'Test Agent' });
    const scope = createAgentMemoryScope(flaky, bufferRepository, 'role_test');
    const candidates = [makeCandidate(), makeCandidate(), makeCandidate()];

    // 第 2 次写入失败：整条 Buffer 只落了第一条，调用方收到异常（不吞）
    flaky.failOnCall = 2;
    await expect(persistExtractedExperiences(scope, 5, candidates)).rejects.toThrow(
      'experience write failed',
    );
    await expect(flaky.listExperiences('role_test')).resolves.toHaveLength(1);

    // 重试整条 Buffer：第一条命中稳定 id 被跳过，只剩两条真正写入，最终正好三条
    flaky.failOnCall = null;
    const retried = await persistExtractedExperiences(scope, 5, candidates);
    expect(retried.created).toBe(2);
    expect(retried.already_present).toBe(1);
    await expect(flaky.listExperiences('role_test')).resolves.toHaveLength(3);

    const handle = await flaky.getAgent('role_test');
    expect(handle.experience_count).toBe(3);
    expect(new Set(handle.owned_exps).size).toBe(3);
  });
});

/** updateExperience 可以按需失败一次的仓库（模拟晋升第二步失败） */
class FlakyUpdateRepository extends InMemoryRepository {
  failNextUpdate = false;

  override async updateExperience(
    role_id: string,
    experience: ExperienceRecord,
  ): Promise<void> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('update failed');
    }
    return super.updateExperience(role_id, experience);
  }
}

/** saveExperienceIfAbsent 可以按调用序号失败一次的仓库（模拟「整条 Buffer 写到一半」） */
class FlakyExperienceRepository extends InMemoryRepository {
  /** 第 N 次 saveExperienceIfAbsent 调用抛错（从 1 起数）；null = 不注入失败 */
  failOnCall: number | null = null;
  private calls = 0;

  override async saveExperienceIfAbsent(
    role_id: string,
    experience: ExperienceRecord,
  ): Promise<ExperienceSaveResult> {
    this.calls += 1;
    if (this.failOnCall === this.calls) {
      throw new Error('experience write failed');
    }
    return super.saveExperienceIfAbsent(role_id, experience);
  }
}

// ═══════════════════════════════════════════
//  Phase 3-A：晋升策略（PromotionStrategy）
// ═══════════════════════════════════════════

/** 固定评估时刻：时间窗口的判据是「now 减 created_at」，不注入时钟就不可复现 */
const EVAL_NOW = '2026-10-10T12:00:00.000Z';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** 相对评估时刻「多少毫秒之前」创建的经验时间戳 */
function createdAgo(ms: number): string {
  return new Date(Date.parse(EVAL_NOW) - ms).toISOString();
}

function evaluate(
  strategy: PromotionStrategy,
  experience: ExperienceRecord,
  approval?: 'auto_approve' | 'manual_review',
) {
  return strategy.evaluate({
    role_id: 'role_test',
    experience,
    now: EVAL_NOW,
    ...(approval !== undefined ? { approval } : {}),
  });
}

describe('DefaultPromotionStrategy — 阈值判定', () => {
  it('默认配置下合格的正经验判为 pending_review（默认人工审核，不自动晋升）', async () => {
    const decision = await evaluate(
      new DefaultPromotionStrategy(),
      makeExperience({ confidence: 0.99 }),
    );

    expect(decision.verdict).toBe('pending_review');
    expect(decision.approval).toBe('manual_review');
    expect(decision.blocking_rules).toEqual([]);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it('auto_approve 模式下同一条经验判为 eligible', async () => {
    const decision = await evaluate(
      new DefaultPromotionStrategy({ approval: 'auto_approve' }),
      makeExperience({ confidence: 0.99 }),
    );

    expect(decision.verdict).toBe('eligible');
    expect(decision.blocking_rules).toEqual([]);
  });

  it('运行级 approval 覆盖策略配置', async () => {
    const strategy = new DefaultPromotionStrategy({ approval: 'manual_review' });

    const promoted = await evaluate(strategy, makeExperience({ confidence: 0.99 }), 'auto_approve');
    expect(promoted.verdict).toBe('eligible');
    expect(promoted.approval).toBe('auto_approve');
  });

  it('置信度门槛是严格大于：恰好等于阈值不通过', async () => {
    const decision = await evaluate(
      new DefaultPromotionStrategy(),
      makeExperience({ confidence: 0.95 }),
    );

    expect(decision.verdict).toBe('rejected');
    expect(decision.blocking_rules).toContain('below_confidence_threshold');
  });

  it('自定义置信度阈值同时决定通过与否', async () => {
    const low = makeExperience({ confidence: 0.6 });

    await expect(
      evaluate(new DefaultPromotionStrategy(), low),
    ).resolves.toMatchObject({ verdict: 'rejected' });

    const relaxed = await evaluate(new DefaultPromotionStrategy({ min_confidence: 0.5 }), low);
    expect(relaxed.verdict).toBe('pending_review');
  });

  it('负经验即使置信度很高也不晋升', async () => {
    const decision = await evaluate(
      new DefaultPromotionStrategy({ approval: 'auto_approve' }),
      makeExperience({ type: 'negative', confidence: 0.99 }),
    );

    expect(decision.verdict).toBe('rejected');
    expect(decision.blocking_rules).toContain('negative_experience');
  });

  it('被引用次数不足即拒绝，达到门槛才通过', async () => {
    const strategy = new DefaultPromotionStrategy({
      approval: 'auto_approve',
      min_referenced_count: 3,
    });

    const thin = await evaluate(strategy, makeExperience({ confidence: 0.99, referenced_count: 2 }));
    expect(thin.verdict).toBe('rejected');
    expect(thin.blocking_rules).toContain('insufficient_references');

    const enough = await evaluate(
      strategy,
      makeExperience({ confidence: 0.99, referenced_count: 3 }),
    );
    expect(enough.verdict).toBe('eligible');
  });

  it('时间窗口：太新的经验被拒，够老的经验通过', async () => {
    const strategy = new DefaultPromotionStrategy({
      approval: 'auto_approve',
      min_age_ms: ONE_DAY_MS,
    });

    const fresh = await evaluate(
      strategy,
      makeExperience({ confidence: 0.99, created_at: createdAgo(60 * 60 * 1000) }),
    );
    expect(fresh.verdict).toBe('rejected');
    expect(fresh.blocking_rules).toContain('too_recent');

    const aged = await evaluate(
      strategy,
      makeExperience({ confidence: 0.99, created_at: createdAgo(2 * ONE_DAY_MS) }),
    );
    expect(aged.verdict).toBe('eligible');
  });

  it('反馈质量：评分缺席时任何门槛都不满足', async () => {
    const strategy = new DefaultPromotionStrategy({
      approval: 'auto_approve',
      min_user_rating: 'resolved',
    });

    const unrated = await evaluate(strategy, makeExperience({ confidence: 0.99 }));
    expect(unrated.verdict).toBe('rejected');
    expect(unrated.blocking_rules).toContain('insufficient_user_rating');

    const notRated = await evaluate(
      strategy,
      makeExperience({ confidence: 0.99, source_user_rating: 'not_rated' }),
    );
    expect(notRated.verdict).toBe('rejected');

    const partial = await evaluate(
      strategy,
      makeExperience({ confidence: 0.99, source_user_rating: 'partially_resolved' }),
    );
    expect(partial.verdict).toBe('rejected');

    const resolved = await evaluate(
      strategy,
      makeExperience({ confidence: 0.99, source_user_rating: 'resolved' }),
    );
    expect(resolved.verdict).toBe('eligible');
  });

  it('已晋升的经验不会再被判为合格（promoted_to 有值）', async () => {
    const decision = await evaluate(
      new DefaultPromotionStrategy({ approval: 'auto_approve' }),
      makeExperience({ confidence: 0.99, promoted_to: '00000000-0000-0000-0000-000000000099' }),
    );

    expect(decision.verdict).toBe('rejected');
    expect(decision.blocking_rules).toContain('already_promoted');
  });

  it('已晋升的经验不会再被判为合格（只有晋升标记、还没绑 promoted_to 时也一样）', async () => {
    const decision = await evaluate(
      new DefaultPromotionStrategy({ approval: 'auto_approve' }),
      makeExperience({
        confidence: 0.99,
        promotion: {
          status: 'processed',
          attempt_count: 1,
          outcome: 'promoted',
          skill_id: '00000000-0000-0000-0000-000000000098',
          created_at: EVAL_NOW,
          updated_at: EVAL_NOW,
        },
      }),
    );

    expect(decision.verdict).toBe('rejected');
    expect(decision.blocking_rules).toContain('already_promoted');
  });

  it('多条规则同时不满足时全部记下来（不是遇到第一条就返回）', async () => {
    const decision = await evaluate(
      new DefaultPromotionStrategy({ min_referenced_count: 5, min_user_rating: 'resolved' }),
      makeExperience({ type: 'negative', confidence: 0.1, referenced_count: 0 }),
    );

    expect(decision.blocking_rules).toEqual(
      expect.arrayContaining([
        'negative_experience',
        'below_confidence_threshold',
        'insufficient_references',
        'insufficient_user_rating',
      ]),
    );
  });

  it('策略版本进入结果（默认与自定义都是）', async () => {
    const fallback = await evaluate(new DefaultPromotionStrategy(), makeExperience({ confidence: 0.99 }));
    expect(fallback.strategy_version).toBe(DEFAULT_PROMOTION_STRATEGY_VERSION);

    const strategy = new DefaultPromotionStrategy({ version: 'promotion-threshold.v2' });
    expect(strategy.version).toBe('promotion-threshold.v2');

    const decision = await evaluate(strategy, makeExperience({ confidence: 0.99 }));
    expect(decision.strategy_version).toBe('promotion-threshold.v2');
  });

  it('结论带上被判定的经验 id，便于逐条对账', async () => {
    const experience = makeExperience({ confidence: 0.99 });
    const decision = await evaluate(new DefaultPromotionStrategy(), experience);
    expect(decision.experience_id).toBe(experience.id);
  });

  it('配置非法时构造即抛错，不留到判定时才悄悄给错结论', () => {
    expect(() => new DefaultPromotionStrategy({ min_confidence: 1 })).toThrow(/min_confidence/);
    expect(() => new DefaultPromotionStrategy({ min_confidence: -0.1 })).toThrow(/min_confidence/);
    expect(() => new DefaultPromotionStrategy({ min_referenced_count: -1 })).toThrow(
      /min_referenced_count/,
    );
    expect(() => new DefaultPromotionStrategy({ min_age_ms: -1 })).toThrow(/min_age_ms/);
    expect(() => new DefaultPromotionStrategy({ version: '' })).toThrow(/version/);
  });
});

// ═══════════════════════════════════════════
//  Phase 3-A：候选规则与状态语义
// ═══════════════════════════════════════════

const STRATEGY_VERSION = DEFAULT_PROMOTION_STRATEGY_VERSION;

/** 候选规则的默认上下文：自动批准 + 当前策略版本 */
function candidateInput(
  overrides: Partial<Parameters<typeof planPromotionCandidate>[1]> = {},
): Parameters<typeof planPromotionCandidate>[1] {
  return {
    now: EVAL_NOW,
    strategy_version: STRATEGY_VERSION,
    approval: 'auto_approve',
    ...overrides,
  };
}

/** 构造一份已经判过 / 被持有过的晋升标记 */
function marker(overrides: Partial<ExperiencePromotion> = {}): ExperiencePromotion {
  return {
    status: 'processed',
    attempt_count: 1,
    outcome: 'rejected',
    strategy_version: STRATEGY_VERSION,
    evaluated_at: EVAL_NOW,
    created_at: EVAL_NOW,
    updated_at: EVAL_NOW,
    ...overrides,
  };
}

describe('候选规则（planPromotionCandidate / selectPromotionCandidates）', () => {
  it('从未评估的经验是候选', () => {
    expect(planPromotionCandidate(makeExperience(), candidateInput()).kind).toBe('claim');
  });

  it('已晋升的经验永远不再是候选', () => {
    const promoted = makeExperience({
      promoted_to: '00000000-0000-0000-0000-000000000099',
      promotion: marker({ outcome: 'promoted' }),
    });

    expect(planPromotionCandidate(promoted, candidateInput())).toEqual({
      kind: 'skip',
      reason: 'already_promoted',
    });
  });

  it('正在被别的 worker 持有（lease 未过期）时跳过', () => {
    const inFlight = makeExperience({
      promotion: marker({
        status: 'processing',
        outcome: undefined,
        claim_owner: 'other-worker',
        claim_token: 'claim_other',
        lease_expires_at: new Date(Date.parse(EVAL_NOW) + 60_000).toISOString(),
      }),
    });

    expect(planPromotionCandidate(inFlight, candidateInput())).toEqual({
      kind: 'skip',
      reason: 'in_flight',
    });
  });

  it('租约已过期的持有者不再拦住候选，先回收再 claim', () => {
    const expired = makeExperience({
      promotion: marker({
        status: 'processing',
        outcome: undefined,
        claim_owner: 'dead-worker',
        claim_token: 'claim_dead',
        lease_expires_at: new Date(Date.parse(EVAL_NOW) - 60_000).toISOString(),
      }),
    });

    expect(planPromotionCandidate(expired, candidateInput()).kind).toBe('expire_then_claim');
  });

  it('退避窗口未到时跳过（不是候选，也不是失败）', () => {
    const waiting = makeExperience({
      promotion: marker({
        status: 'pending',
        outcome: undefined,
        attempt_count: 1,
        last_error: 'storage_error: boom',
        next_retry_at: new Date(Date.parse(EVAL_NOW) + 60_000).toISOString(),
      }),
    });

    expect(planPromotionCandidate(waiting, candidateInput())).toEqual({
      kind: 'skip',
      reason: 'not_due',
    });
  });

  it('死信不会被自动重投', () => {
    const dead = makeExperience({ promotion: marker({ status: 'dead_letter', outcome: undefined }) });

    expect(planPromotionCandidate(dead, candidateInput())).toEqual({
      kind: 'skip',
      reason: 'dead_letter',
    });
  });

  it('同一策略版本下已拒绝的：输入没变不重评，输入变过就重评', () => {
    const experience = makeExperience({ promotion: marker({ outcome: 'rejected' }) });
    // 指纹缺席（这一版字段出现之前判下的结论）按「输入变过」处理：重评一次，而不是永远搁着
    // ——多评一次的代价，远小于一条经验永远不再被考虑
    expect(planPromotionCandidate(experience, candidateInput()).kind).toBe('reevaluate_then_claim');

    // 记下判定当时的输入：同一份输入不再重评。这里必须从**同一条** experience 派生——
    // 另造一条 `makeExperience()` 会拿到毫秒不同的 `updated_at`，而它也在指纹里，断言于是
    // 变成「两次 `new Date()` 会不会落在同一毫秒」的掷骰子（CI 上就是这样红的）。
    const judged = {
      ...experience,
      promotion: marker({
        outcome: 'rejected',
        input_snapshot_hash: promotionInputSnapshotHash(experience),
      }),
    };
    expect(planPromotionCandidate(judged, candidateInput())).toEqual({
      kind: 'skip',
      reason: 'evaluated_under_current_strategy',
    });

    const newer = candidateInput({ strategy_version: 'promotion-threshold.v2' });
    expect(planPromotionCandidate(judged, newer).kind).toBe('reevaluate_then_claim');
  });

  it('判完之后置信度被反馈抬上来，这条 rejected 会被重评——判据是输入内容，不是轮次', () => {
    const before = makeExperience({ confidence: 0.5 });
    const promotion = marker({
      outcome: 'rejected',
      input_snapshot_hash: promotionInputSnapshotHash(before),
    });

    // 同一份输入：不重评
    expect(planPromotionCandidate({ ...before, promotion }, candidateInput())).toEqual({
      kind: 'skip',
      reason: 'evaluated_under_current_strategy',
    });

    // 同一个 id、同一版策略，只有置信度与 updated_at 变了 —— 这正是反馈回写的形状。
    // 少了这一条重评，晋升通道就变成「一次定终身」：第一次看到时置信度还低的经验永远翻不了身。
    const afterFeedback = {
      ...before,
      confidence: 0.98,
      referenced_count: 1,
      updated_at: new Date(Date.parse(before.updated_at) + 1_000).toISOString(),
      promotion,
    };
    expect(planPromotionCandidate(afterFeedback, candidateInput()).kind).toBe(
      'reevaluate_then_claim',
    );
  });

  it('判为待审核的经验：人工审核模式下不再重评，转自动批准后重评', () => {
    const pendingReview = makeExperience({ promotion: marker({ outcome: 'pending_review' }) });

    expect(planPromotionCandidate(pendingReview, candidateInput({ approval: 'manual_review' }))).toEqual(
      { kind: 'skip', reason: 'waiting_for_manual_review' },
    );

    const reopened = planPromotionCandidate(pendingReview, candidateInput({ approval: 'auto_approve' }));
    expect(reopened.kind).toBe('reevaluate_then_claim');
    // 重评时把上一次的结论与投递痕迹一起清掉，回到「从没评过」的样子
    if (reopened.kind === 'reevaluate_then_claim') {
      expect(reopened.marker.status).toBe('pending');
      expect(reopened.marker.attempt_count).toBe(0);
      expect(reopened.marker.outcome).toBeUndefined();
      expect(reopened.marker.strategy_version).toBeUndefined();
      expect(reopened.marker.evaluated_at).toBeUndefined();
    }
  });

  it('selectPromotionCandidates 只留非跳过的，并按创建时间升序', () => {
    const older = makeExperience({ id: '00000000-0000-0000-0000-0000000000a1', created_at: createdAgo(2 * ONE_DAY_MS) });
    const newer = makeExperience({ id: '00000000-0000-0000-0000-0000000000a2', created_at: createdAgo(ONE_DAY_MS) });
    const promoted = makeExperience({
      id: '00000000-0000-0000-0000-0000000000a3',
      promoted_to: '00000000-0000-0000-0000-000000000099',
      created_at: createdAgo(3 * ONE_DAY_MS),
    });

    const selected = selectPromotionCandidates([newer, promoted, older], candidateInput());
    expect(selected.map((item) => item.id)).toEqual([older.id, newer.id]);
    expect(comparePromotionCandidates(older, newer)).toBeLessThan(0);
  });

  it('promotionStateLabel 把存储字段翻译成计划里的状态语义', () => {
    expect(promotionStateLabel(makeExperience())).toBe('unevaluated');
    expect(
      promotionStateLabel(
        makeExperience({
          promotion: marker({
            status: 'processing',
            outcome: undefined,
            lease_expires_at: new Date(Date.parse(EVAL_NOW) + 60_000).toISOString(),
          }),
        }),
      ),
    ).toBe('processing');
    expect(
      promotionStateLabel(
        makeExperience({
          promotion: marker({
            status: 'pending',
            outcome: undefined,
            attempt_count: 1,
            next_retry_at: new Date(Date.parse(EVAL_NOW) + 60_000).toISOString(),
          }),
        }),
      ),
    ).toBe('retryable');
    expect(
      promotionStateLabel(makeExperience({ promotion: marker({ status: 'dead_letter', outcome: undefined }) })),
    ).toBe('dead_letter');
    expect(
      promotionStateLabel(makeExperience({ promotion: marker({ outcome: 'promoted' }) })),
    ).toBe('promoted');
    expect(
      promotionStateLabel(makeExperience({ promotion: marker({ outcome: 'pending_review' }) })),
    ).toBe('pending_review');
    expect(promotionStateLabel(makeExperience({ promotion: marker({ outcome: 'rejected' }) }))).toBe(
      'rejected',
    );
  });
});

describe('旧 Experience 数据的兼容', () => {
  // 用真 UUID：makeExperience 的固定 id 是给不解析载荷的用例用的，这里要过 schema
  const legacyId = randomUUID();

  it('没有 promotion 字段的旧载荷照样解析，读作「从未评估」', () => {
    const legacy = makeExperience({ id: legacyId, confidence: 0.99 });
    const { promotion: _promotion, ...withoutPromotion } = legacy;

    expect('promotion' in withoutPromotion).toBe(false);

    const parsed = ExperienceRecordSchema.parse(JSON.parse(JSON.stringify(withoutPromotion)));
    expect(parsed.promotion).toBeUndefined();
    expect(promotionStateLabel(parsed)).toBe('unevaluated');
    expect(planPromotionCandidate(parsed, candidateInput()).kind).toBe('claim');
  });

  it('带晋升标记的载荷往返一次后字段不丢', () => {
    const marked = makeExperience({
      id: legacyId,
      confidence: 0.99,
      promotion: marker({ status: 'pending', outcome: undefined, attempt_count: 2 }),
    });

    const parsed = ExperienceRecordSchema.parse(JSON.parse(JSON.stringify(marked)));
    expect(parsed.promotion?.status).toBe('pending');
    expect(parsed.promotion?.attempt_count).toBe(2);
    expect(promotionStateLabel(parsed)).toBe('retryable');
  });
});

describe('人工审核模式不写 Skill', () => {
  it('claim → 判为 pending_review → 状态落地，全程没有任何 Skill 被写入', async () => {
    const role_id = 'role_manual_review';
    const repository = new InMemoryRepository();
    await repository.initializeAgent({ role_id, name: 'Manual Review Agent' });
    const experience = makeExperience({ confidence: 0.99, agent_id: role_id });
    await repository.saveExperience(role_id, experience);

    const strategy = new DefaultPromotionStrategy({ approval: 'manual_review' });
    const claimed = await repository.claimNextPromotionCandidate({
      role_id,
      owner: 'promotion-worker-1',
      now: EVAL_NOW,
      lease_ms: 60_000,
      strategy_version: strategy.version,
      approval: 'manual_review',
    });
    expect(claimed).toBeDefined();
    expect(claimed!.experience.promotion?.status).toBe('processing');

    const decision = await evaluate(strategy, claimed!.experience);
    expect(decision.verdict).toBe('pending_review');

    const settled = await repository.completePromotion({
      role_id,
      experience_id: experience.id,
      claim_token: claimed!.claim_token,
      outcome: 'pending_review',
      strategy_version: decision.strategy_version,
      input_snapshot_hash: promotionInputSnapshotHash(experience),
      reasons: decision.reasons,
      now: EVAL_NOW,
    });

    expect(settled?.promotion?.outcome).toBe('pending_review');
    expect(settled?.promotion?.strategy_version).toBe(strategy.version);
    expect(promotionStateLabel(settled!)).toBe('pending_review');
    // 关键断言：人工审核不提前写 Skill，也不把经验绑上技能
    expect(await repository.listSkills(role_id)).toHaveLength(0);
    expect(settled?.promoted_to).toBeUndefined();
  });
});

// ═══════════════════════════════════════════
//  Phase 3-B：晋升执行内核（executePromotionCandidate）
// ═══════════════════════════════════════════

const EXEC_NOW = '2026-10-10T12:00:00.000Z';
const EXEC_LEASE_MS = 60_000;

/** 自动批准模式的策略：判定与人工审核同一套，差在合格之后的出口 */
const autoApproveStrategy = new DefaultPromotionStrategy({ approval: 'auto_approve' });

/**
 * Skill 写入按给定异常失败的仓库。
 *
 * 造这个替身是为了走到**存储层故障**那几条分支：真实适配器在 Agent 行消失时会抛错，但要
 * 在本进程里造出「Agent 没了、经验还在」的状态，PG 侧被外键级联挡住、内存侧要绕过 API——
 * 与其伪造一个不可达的状态，不如直接让写入点按指定的异常失败，测分类与落盘的去向。
 */
class FailingSkillWriteRepository extends InMemoryRepository {
  constructor(private readonly failure: unknown) {
    super();
  }

  override async saveSkillIfAbsent(): Promise<SkillSaveResult> {
    throw this.failure;
  }
}

/**
 * 技能写入点把技能挂到**另一个 Agent** 名下（正常路径上不可能：id 与归属都由本执行器自己
 * 给，见 buildPromotedSkill）。
 *
 * 造这个替身是为了走到「回写引用不成立」那条分支，而且走的是**真**的 `completePromotion`：
 * 经验侧的 `promoted_to` 是一条跨表指针，写歪了没有任何东西会来修它，所以存储层必须把这条
 * 回写整个拒掉，执行器也必须把它认成永久错误——而不是拿一条永远不会成立的引用去占满重试
 * 名额，或者干脆把指针落上去。
 */
class ForeignSkillRepository extends InMemoryRepository {
  constructor(private readonly owner_role_id: string) {
    super();
  }

  override async saveSkillIfAbsent(_role_id: string, skill: SkillRecord): Promise<SkillSaveResult> {
    return super.saveSkillIfAbsent(this.owner_role_id, {
      ...skill,
      agent_id: this.owner_role_id,
    });
  }
}

/** 播种一个 Agent 与一条高置信度正经验，并 claim 到手 */
async function seedClaimedExperience(repository: InMemoryRepository, role_id: string) {
  await repository.initializeAgent({ role_id, name: 'Promotion Exec Agent' });
  const experience = makeExperience({
    id: randomUUID(),
    agent_id: role_id,
    confidence: 0.99,
    referenced_count: 1,
  });
  await repository.saveExperience(role_id, experience);
  const claimed = await repository.claimNextPromotionCandidate({
    role_id,
    owner: 'worker-1',
    now: EXEC_NOW,
    lease_ms: EXEC_LEASE_MS,
    strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
    approval: 'auto_approve',
  });
  expect(claimed).toBeDefined();
  return { experience, claimed: claimed! };
}

describe('classifyPromotionFailure', () => {
  it('Agent 不在了 → 不可重试的 delivery_missing（重投不会让 Agent 回来）', () => {
    const classified = classifyPromotionFailure(new Error(`${AGENT_MISSING_PREFIX} role_x`));
    expect(classified.code).toBe('delivery_missing');
    expect(classified.retryable).toBe(false);
  });

  it('PG 侧的外键冲突（归属行没了）落进同一个结论，而不是 unknown 白重投', () => {
    const violation = Object.assign(
      new Error('insert or update on table "memory_skills" violates foreign key constraint'),
      { code: '23503' },
    );
    const classified = classifyPromotionFailure(violation);
    expect(classified.code).toBe('delivery_missing');
    expect(classified.retryable).toBe(false);
  });

  it('载荷解析不了 → 不可重试的 payload_unreadable（重投读到的是同一份坏数据）', () => {
    const classified = classifyPromotionFailure(new ZodError([]));
    expect(classified.code).toBe('payload_unreadable');
    expect(classified.retryable).toBe(false);
  });

  it('连接类 errno → 可重试的 downstream_unavailable', () => {
    const classified = classifyPromotionFailure(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    expect(classified.code).toBe('downstream_unavailable');
    expect(classified.retryable).toBe(true);
  });

  it('认不出来的失败默认可重试：有上限的重投是安全的，判成永久失败才会让候选消失', () => {
    const classified = classifyPromotionFailure(new Error('boom'));
    expect(classified.code).toBe('unknown');
    expect(classified.retryable).toBe(true);
  });

  it('晋升引用不成立 → 不可重试的 storage_error（重投不会让一条不成立的引用成立）', () => {
    const classified = classifyPromotionFailure(
      new PromotionSkillIntegrityError('Promotion integrity: skill x does not exist.', {
        violation: 'missing',
        role_id: 'role_x',
        experience_id: 'exp_x',
        skill_id: 'skill_x',
      }),
    );
    expect(classified.code).toBe('storage_error');
    expect(classified.retryable).toBe(false);
    expect(classified.message).toContain('does not exist');
  });

  it('策略判定违反契约 → 不可重试的 payload_unreadable（形状不对与自相矛盾都算）', () => {
    const experience_id = 'exp_contract';
    const expected = {
      experience_id,
      approval: 'auto_approve' as const,
      strategy_version: 'promotion-threshold.v1',
    };
    const legal = {
      verdict: 'eligible',
      strategy_version: 'promotion-threshold.v1',
      approval: 'auto_approve',
      reasons: ['Candidate qualifies.'],
      blocking_rules: [],
      experience_id,
    };
    // 三类各自最贵的一种：形状不合法（`null`）、结论不认识（`typo`）、与本次执行对不上
    // （rejected 却拿不出挡住的规则）
    const decisions: unknown[] = [
      null,
      { ...legal, verdict: 'typo' },
      { ...legal, verdict: 'rejected', reasons: ['turned down'], blocking_rules: [] },
    ];

    for (const decision of decisions) {
      let thrown: unknown;
      try {
        assertPromotionDecisionConsistent(decision, expected);
      } catch (error) {
        thrown = error;
      }
      const classified = classifyPromotionFailure(thrown);
      // 一次配置错既不是抖动（重投读到的是同一份），也不该消失在 unknown 里白占重试名额
      expect(classified.code).toBe('payload_unreadable');
      expect(classified.retryable).toBe(false);
      expect(classified.message).toContain('retrying cannot fix it');
    }
  });
});

describe('buildPromotedSkill', () => {
  it('自动批准直接写 approved，审核人沿用既有系统那个值', () => {
    const experience = makeExperience({ id: randomUUID() });
    const skill = buildPromotedSkill('role_test', experience, EXEC_NOW, 'auto_approve');

    expect(skill.promoted_from).toBe(experience.id);
    expect(skill.agent_id).toBe('role_test');
    expect(skill.promoted_at).toBe(EXEC_NOW);
    expect(skill.review_status).toBe('approved');
    expect(skill.reviewed_by).toBe('system:auto-approval');
    expect(skill.reviewed_at).toBe(EXEC_NOW);
    // tags 是复制而不是共享同一数组：技能落库后经验再被改动不会串味
    expect(skill.tags).toEqual(experience.tags);
    expect(skill.tags).not.toBe(experience.tags);
  });

  it('人工审核写 pending，且不带审核人与审核时间', () => {
    const experience = makeExperience({ id: randomUUID() });
    const skill = buildPromotedSkill('role_test', experience, EXEC_NOW, 'manual_review');

    expect(skill.review_status).toBe('pending');
    expect(skill.reviewed_by).toBeUndefined();
    expect(skill.reviewed_at).toBeUndefined();
  });

  it('产出的技能自己就能过 SkillRecordSchema，不靠存储层兜底', () => {
    const experience = makeExperience({ id: randomUUID() });
    expect(() =>
      SkillRecordSchema.parse(
        buildPromotedSkill('role_test', experience, EXEC_NOW, 'auto_approve'),
      ),
    ).not.toThrow();
  });
});

describe('executePromotionCandidate — 失败分类与落盘', () => {
  it('Agent 不在了：直接死信，不占满重试名额，也不写技能', async () => {
    const role_id = `role_exec_missing_${randomUUID()}`;
    const repository = new FailingSkillWriteRepository(
      new Error(`${AGENT_MISSING_PREFIX} ${role_id}`),
    );
    const { claimed } = await seedClaimedExperience(repository, role_id);

    const result = await executePromotionCandidate(
      { repository, strategy: autoApproveStrategy, now: () => EXEC_NOW },
      claimed,
      { approval: 'auto_approve', now: EXEC_NOW },
    );

    expect(result.status).toBe('dead_letter');
    expect(result.failure?.code).toBe('delivery_missing');
    expect(result.failure?.retryable).toBe(false);

    const stored = (await repository.listExperiences(role_id))[0]!;
    expect(stored.promotion?.status).toBe('dead_letter');
    expect(stored.promotion?.last_error).toContain(AGENT_MISSING_PREFIX);
    // 「失败后 retry 不丢审计信息」：次数与原因都留在记录上
    expect(stored.promotion?.attempt_count).toBe(1);
    expect(await repository.listSkills(role_id)).toHaveLength(0);
    const metrics = await repository.getMetrics(role_id);
    expect(metrics.skill_count).toBe(0);
    expect(metrics.promoted_skill_count).toBe(0);
  });

  it('载荷读不懂：同样直接死信，原因落进 last_error', async () => {
    const role_id = `role_exec_corrupt_${randomUUID()}`;
    const repository = new FailingSkillWriteRepository(new ZodError([]));
    const { claimed } = await seedClaimedExperience(repository, role_id);

    const result = await executePromotionCandidate(
      { repository, strategy: autoApproveStrategy, now: () => EXEC_NOW },
      claimed,
      { approval: 'auto_approve', now: EXEC_NOW },
    );

    expect(result.status).toBe('dead_letter');
    expect(result.failure?.code).toBe('payload_unreadable');
    expect((await repository.listExperiences(role_id))[0]!.promotion?.status).toBe('dead_letter');
  });

  it('存储抖动：退避重投，退避没到期之前不会被重新 claim', async () => {
    const role_id = `role_exec_transient_${randomUUID()}`;
    const repository = new FailingSkillWriteRepository(new Error('boom'));
    const { experience, claimed } = await seedClaimedExperience(repository, role_id);

    const result = await executePromotionCandidate(
      { repository, strategy: autoApproveStrategy, now: () => EXEC_NOW },
      claimed,
      { approval: 'auto_approve', now: EXEC_NOW },
    );

    expect(result.status).toBe('retried');
    expect(result.failure?.code).toBe('unknown');
    expect(result.failure?.retryable).toBe(true);

    const stored = (await repository.listExperiences(role_id))[0]!;
    expect(stored.promotion?.status).toBe('pending');
    expect(stored.promotion?.attempt_count).toBe(1);
    expect(stored.promotion?.last_error).toBe('boom');
    expect(stored.promotion?.next_retry_at).toBeDefined();
    expect(promotionStateLabel(stored)).toBe('retryable');

    // 退避窗口之内不是候选——否则「重试」会退化成忙等
    await expect(
      repository.claimNextPromotionCandidate({
        role_id,
        owner: 'worker-2',
        now: EXEC_NOW,
        lease_ms: EXEC_LEASE_MS,
        strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
        approval: 'auto_approve',
      }),
    ).resolves.toBeUndefined();

    // 到期之后重新可 claim，且经验还是那一条，次数记到 2
    const due = stored.promotion!.next_retry_at!;
    const reclaimed = await repository.claimNextPromotionCandidate({
      role_id,
      owner: 'worker-2',
      now: due,
      lease_ms: EXEC_LEASE_MS,
      strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
      approval: 'auto_approve',
    });
    expect(reclaimed?.experience.id).toBe(experience.id);
    expect(reclaimed?.attempt_count).toBe(2);
  });

  it('回写引用不成立（技能挂在别的 Agent 名下）：不写 promoted_to，直接死信', async () => {
    const role_id = `role_exec_foreign_${randomUUID()}`;
    const owner_role_id = `role_exec_owner_${randomUUID()}`;
    const repository = new ForeignSkillRepository(owner_role_id);
    await repository.initializeAgent({ role_id: owner_role_id, name: 'Other Agent' });
    const { experience, claimed } = await seedClaimedExperience(repository, role_id);

    const result = await executePromotionCandidate(
      { repository, strategy: autoApproveStrategy, now: () => EXEC_NOW },
      claimed,
      { approval: 'auto_approve', now: EXEC_NOW },
    );

    // 永久错误：判成 storage_error + 不可重试，一次就进死信，不占重试名额
    expect(result.status).toBe('dead_letter');
    expect(result.failure?.code).toBe('storage_error');
    expect(result.failure?.retryable).toBe(false);
    expect(result.failure?.message).toMatch(/Promotion integrity/);

    const stored = (await repository.listExperiences(role_id))[0]!;
    expect(stored.id).toBe(experience.id);
    // 引用不成立时经验上不能留下任何指向：既没有 promoted_to，也没有结论
    expect(stored.promoted_to).toBeUndefined();
    expect(stored.promotion?.outcome).toBeUndefined();
    expect(stored.promotion?.skill_id).toBeUndefined();
    expect(stored.promotion?.status).toBe('dead_letter');
    expect(stored.promotion?.last_error).toMatch(/Promotion integrity/);
    // 被判失败的是**这条引用**，不是那次技能写入：技能确实落了库（挂在别人名下），审计里
    // 看得到它，人不该在「技能没写成功」这条错路上找
    expect(await repository.listSkills(owner_role_id)).toHaveLength(1);
  });
});
