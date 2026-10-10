/**
 * pg-memory-repository 集成测试
 *
 * 需要 PostgreSQL + pgvector。未设置 MEMORY_PG_TEST_URL 时自动跳过。
 * 示例：MEMORY_PG_TEST_URL=postgres://user:pass@localhost:5432/newide_test pnpm test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { nowTimestamp } from '../../core';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { PgMemoryRepository } from '../adapters/pg-memory-repository';
import { ensurePgMemorySchema } from '../adapters/pg-memory-schema';
import type { ExperienceRecord, SkillRecord } from '../schemas';

const pgTestUrl = process.env.MEMORY_PG_TEST_URL;
const describePg = pgTestUrl ? describe : describe.skip;

function createExperience(
  role_id: string,
  overrides: Partial<ExperienceRecord> = {},
): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Handle TypeScript contract boundaries.',
    description_embedding: [],
    content: 'full experience content body',
    confidence: 0.8,
    tags: ['typescript', 'contracts'],
    agent_id: role_id,
    confidence_history: [{ value: 0.8, updated_at: now, reason: 'seed' }],
    referenced_count: 1,
    source_task_id: 'task_seed',
    source_driver: 'mock-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function createSkill(role_id: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Write stable TypeScript interfaces.',
    description_embedding: [],
    content: 'full skill content body',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['typescript'],
    promoted_at: now,
    agent_id: role_id,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describePg('PgMemoryRepository', () => {
  const embedding = new HashEmbeddingProvider();
  let pool: Pool;
  let repository: PgMemoryRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: pgTestUrl });
    await ensurePgMemorySchema(pool, embedding.dimensions);
    repository = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS memory_experiences');
      await pool.query('DROP TABLE IF EXISTS memory_skills');
      await pool.query('DROP TABLE IF EXISTS memory_agents');
      await pool.end();
    }
  });

  it('initializeAgent persists persona and metrics', async () => {
    const role_id = `role_pg_init_${randomUUID()}`;
    await repository.initializeAgent({
      role_id,
      name: 'PG Agent',
      persona_seed: 'Backend specialist',
    });

    const persona = await repository.getPersona(role_id);
    expect(persona.summary).toBe('Backend specialist');
    expect(persona.role_id).toBe(role_id);

    const handle = await repository.getAgent(role_id);
    expect(handle.skill_count).toBe(0);
    expect(handle.experience_count).toBe(0);
  });

  it('saveSkill and saveExperience update counts and survive reconnect', async () => {
    const role_id = `role_pg_save_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PG Save Agent' });

    await repository.saveSkill(role_id, createSkill(role_id));
    await repository.saveExperience(role_id, createExperience(role_id));

    const restarted = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    const handle = await restarted.getAgent(role_id);
    expect(handle.skill_count).toBe(1);
    expect(handle.experience_count).toBe(1);
    await expect(restarted.listSkills(role_id)).resolves.toHaveLength(1);
    await expect(restarted.listExperiences(role_id)).resolves.toHaveLength(1);
  });

  it('searchSkills returns top-K by cosine similarity', async () => {
    const role_id = `role_pg_search_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PG Search Agent' });

    const query = 'payment gateway refactor';
    const queryEmbedding = await embedding.embed(query);

    await repository.saveSkill(
      role_id,
      createSkill(role_id, {
        description: 'Payment gateway refactor patterns',
        description_embedding: queryEmbedding,
      }),
    );
    await repository.saveSkill(
      role_id,
      createSkill(role_id, {
        description: 'Unrelated gardening tips',
        description_embedding: await embedding.embed('gardening soil tips'),
      }),
    );

    const hits = await repository.searchSkills(role_id, {
      query_embedding: queryEmbedding,
      top_k: 1,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.description).toContain('Payment gateway');
  });

  it('searchExperiences filters by confidence and similarity', async () => {
    const role_id = `role_pg_exp_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PG Exp Agent' });

    const queryEmbedding = await embedding.embed('typescript contract boundaries');

    await repository.saveExperience(
      role_id,
      createExperience(role_id, {
        description: 'TypeScript contract boundary patterns',
        description_embedding: queryEmbedding,
        confidence: 0.9,
      }),
    );
    await repository.saveExperience(
      role_id,
      createExperience(role_id, {
        description: 'Low confidence note',
        description_embedding: queryEmbedding,
        confidence: 0.1,
      }),
    );

    const hits = await repository.searchExperiences(role_id, {
      query_embedding: queryEmbedding,
      top_k: 10,
      min_confidence: 0.5,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.description).toContain('TypeScript contract');
  });

  it('updateExperience replaces stored payload', async () => {
    const role_id = `role_pg_update_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PG Update Agent' });

    const experience = createExperience(role_id);
    await repository.saveExperience(role_id, experience);

    const updated = { ...experience, content: 'updated content body' };
    await repository.updateExperience(role_id, updated);

    const stored = await repository.listExperiences(role_id);
    expect(stored[0]?.content).toBe('updated content body');
  });

  /**
   * 经验幂等保存的真并发验证：唯一键是主键 id，靠 `ON CONFLICT (id) DO NOTHING` 收敛。
   * 两个 memory maintenance worker 同时处理同一条 Buffer 时，各自算出的稳定 id 相同，
   * 两边并发跑 SQL——谁都不会写出副本，谁都不会收到主键冲突。真 PG 上是两条连接真正并行，
   * 交错最凶，所以这条在这里最有说服力（PGlite 的单连接版本见
   * pglite-memory-repository.test.ts，同一契约两个引擎）。
   */
  it('saveExperienceIfAbsent 并发同一 id：一条经验、计数一次，两边都拿到它', async () => {
    const role_id = `role_pg_exp_race_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PG Experience Race' });
    const experience = createExperience(role_id);

    const [left, right] = await Promise.all([
      repository.saveExperienceIfAbsent(role_id, experience),
      repository.saveExperienceIfAbsent(role_id, experience),
    ]);

    expect([left.created, right.created].filter(Boolean)).toHaveLength(1);
    expect(left.experience.id).toBe(experience.id);
    expect(right.experience.id).toBe(experience.id);
    await expect(repository.listExperiences(role_id)).resolves.toHaveLength(1);
    await expect(repository.getAgent(role_id)).resolves.toMatchObject({
      experience_count: 1,
      owned_exps: [experience.id],
    });
    await expect(repository.getMetrics(role_id)).resolves.toMatchObject({ experience_count: 1 });
  });

  /**
   * 不同 id 的并发写入：两条经验都该留下，聚合根也必须两条都记。这是「读出来 → 在内存副本
   * 上 +1 → 整份 JSON 覆盖回去」真正丢更新的形状——两条连接各自读到旧的 handle/metrics，
   * 后写的那个把先写的计数与 owned_exps 一起抹掉。修复后计数与 owned_exps 由数据库侧对
   * 当前行原子增量得出，谁的旧快照都覆盖不了谁。
   */
  it('saveExperienceIfAbsent 并发不同 id：两条经验都保留，计数与 owned_exps 都不丢', async () => {
    const role_id = `role_pg_exp_race_multi_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PG Experience Multi Race' });
    const expA = createExperience(role_id);
    const expB = createExperience(role_id);
    const expectedIds = [expA.id, expB.id].sort();

    const [left, right] = await Promise.all([
      repository.saveExperienceIfAbsent(role_id, expA),
      repository.saveExperienceIfAbsent(role_id, expB),
    ]);

    expect(left.created).toBe(true);
    expect(right.created).toBe(true);

    const stored = await repository.listExperiences(role_id);
    expect(stored.map((item) => item.id).sort()).toEqual(expectedIds);

    const handle = await repository.getAgent(role_id);
    expect(handle.experience_count).toBe(2);
    expect([...handle.owned_exps].sort()).toEqual(expectedIds);
    expect(handle.metric.experience_count).toBe(2);
    await expect(repository.getMetrics(role_id)).resolves.toMatchObject({ experience_count: 2 });
  });

  /**
   * 不同来源的并发晋升：唯一键是 (role_id, promoted_from)，两条来源不同因此都该留下，
   * 但聚合根是同一行 memory_agents，旧实现下后写的那个会抹掉先写的计数与 owned_skills。
   */
  it('saveSkillIfAbsent 并发不同来源：两条技能都保留，计数与 owned_skills 都不丢', async () => {
    const role_id = `role_pg_promote_multi_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PG Promote Multi Race' });
    const expA = createExperience(role_id);
    const expB = createExperience(role_id);
    await repository.saveExperience(role_id, expA);
    await repository.saveExperience(role_id, expB);

    const [left, right] = await Promise.all([
      repository.saveSkillIfAbsent(
        role_id,
        createSkill(role_id, { promoted_from: expA.id, review_status: 'pending' }),
      ),
      repository.saveSkillIfAbsent(
        role_id,
        createSkill(role_id, { promoted_from: expB.id, review_status: 'pending' }),
      ),
    ]);

    expect(left.created).toBe(true);
    expect(right.created).toBe(true);

    const skills = await repository.listSkills(role_id);
    const expectedIds = [left.skill.id, right.skill.id].sort();
    expect(skills.map((item) => item.id).sort()).toEqual(expectedIds);

    const handle = await repository.getAgent(role_id);
    expect(handle.skill_count).toBe(2);
    expect([...handle.owned_skills].sort()).toEqual(expectedIds);
    expect(handle.metric.skill_count).toBe(2);
    await expect(repository.getMetrics(role_id)).resolves.toMatchObject({
      skill_count: 2,
      promoted_skill_count: 2,
    });
  });

  it('throws when agent or experience is missing', async () => {
    await expect(repository.getAgent('role_missing_pg_agent')).rejects.toThrow(
      'Agent not found: role_missing_pg_agent',
    );

    const role_id = `role_pg_missing_exp_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PG Missing Exp' });
    await expect(repository.updateExperience(role_id, createExperience(role_id))).rejects.toThrow(
      'Experience not found',
    );
  });
});
