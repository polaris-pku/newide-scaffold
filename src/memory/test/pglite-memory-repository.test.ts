/**
 * PGlite 嵌入式 PostgreSQL 契约测试
 *
 * 使用 @electric-sql/pglite（WASM PostgreSQL + pgvector）在进程内运行，
 * 验证 PgMemoryRepository 的完整 SQL/pgvector 路径——无需外部 PostgreSQL、
 * 无需 Docker、无需 MEMORY_PG_TEST_URL，因此在 CI 中始终运行。
 * 用例与 pg-memory-repository.test.ts 保持一致（同一契约，两个引擎）。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { PgMemoryRepository } from '../adapters/pg-memory-repository';
import { ensurePgMemorySchema } from '../adapters/pg-memory-schema';
import { createPGlitePool } from '../adapters/pglite-pool';
import type { ExperienceRecord, SkillRecord } from '../schemas';
import type { SqlClient, SqlPool, SqlQueryResult } from '../ports/sql-pool';

/**
 * 代理 SqlPool：命中 predicate 的语句直接抛错，其余原样透传。
 *
 * 用来模拟「插进去了、聚合根更新那一步失败」——被测的仍然是真实的 SQL 路径，只把中间
 * 一步换成失败，因此能验证「插入与聚合根更新在同一事务里，一步失败整条回滚」。
 */
function createFailOnStatementPool(
  inner: SqlPool,
  shouldFail: (text: string) => boolean,
): SqlPool {
  const failIfMatched = <T>(text: string, params?: unknown[]): Promise<SqlQueryResult<T>> => {
    if (shouldFail(text)) {
      return Promise.reject(new Error('injected aggregate update failure'));
    }
    return inner.query<T>(text, params);
  };

  return {
    query: failIfMatched,
    connect: async (): Promise<SqlClient> => {
      const client = await inner.connect();
      return {
        query: <T>(text: string, params?: unknown[]) => {
          if (shouldFail(text)) {
            return Promise.reject(new Error('injected aggregate update failure'));
          }
          return client.query<T>(text, params);
        },
        release: () => client.release(),
      };
    },
    end: () => inner.end(),
  };
}

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

describe('PgMemoryRepository on embedded PGlite', () => {
  const embedding = new HashEmbeddingProvider();
  let pool: SqlPool;
  let repository: PgMemoryRepository;

  beforeAll(async () => {
    pool = await createPGlitePool();
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
    const role_id = `role_pglite_init_${randomUUID()}`;
    await repository.initializeAgent({
      role_id,
      name: 'PGlite Agent',
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
    const role_id = `role_pglite_save_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Save Agent' });

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
    const role_id = `role_pglite_search_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Search Agent' });

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
    const role_id = `role_pglite_exp_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Exp Agent' });

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
    const role_id = `role_pglite_update_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Update Agent' });

    const experience = createExperience(role_id);
    await repository.saveExperience(role_id, experience);

    const updated = { ...experience, content: 'updated content body' };
    await repository.updateExperience(role_id, updated);

    const stored = await repository.listExperiences(role_id);
    expect(stored[0]?.content).toBe('updated content body');
  });

  it('throws when agent or experience is missing', async () => {
    await expect(repository.getAgent('role_missing_pglite_agent')).rejects.toThrow(
      'Agent not found: role_missing_pglite_agent',
    );

    const role_id = `role_pglite_missing_exp_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Missing Exp' });
    await expect(repository.updateExperience(role_id, createExperience(role_id))).rejects.toThrow(
      'Experience not found',
    );
  });

  /**
   * 晋升幂等只有真的走一遍 SQL 才算验过：唯一键是 (role_id, promoted_from)，靠部分唯一索引
   * + ON CONFLICT DO NOTHING 保证，而不是「先查再插」（后者在并发下会各自插进去）。
   */
  it('saveSkillIfAbsent 幂等：同一经验只留一条技能，重试复用而非新建', async () => {
    const role_id = `role_pglite_promote_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Promote Agent' });

    const experience = createExperience(role_id);
    await repository.saveExperience(role_id, experience);
    const makePromoted = (): SkillRecord =>
      createSkill(role_id, { promoted_from: experience.id, review_status: 'pending' });

    const first = await repository.saveSkillIfAbsent(role_id, makePromoted());
    expect(first.created).toBe(true);

    // 重试（模拟回写 promoted_to 失败后整条重跑）：复用既有技能，不新增
    const retried = await repository.saveSkillIfAbsent(role_id, makePromoted());
    expect(retried.created).toBe(false);
    expect(retried.skill.id).toBe(first.skill.id);
    expect(retried.skill.promoted_from).toBe(experience.id);

    await expect(repository.listSkills(role_id)).resolves.toHaveLength(1);
    // 计数只在真正新建时加一次
    await expect(repository.getAgent(role_id)).resolves.toMatchObject({ skill_count: 1 });
  });

  it('saveSkillIfAbsent：promoted_from 为空时退化为普通保存', async () => {
    const role_id = `role_pglite_promote_null_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Null Promote Agent' });

    await repository.saveSkillIfAbsent(role_id, createSkill(role_id));
    await repository.saveSkillIfAbsent(role_id, createSkill(role_id));
    await expect(repository.listSkills(role_id)).resolves.toHaveLength(2);
  });

  /**
   * 经验落库的幂等锚点是主键 id（提取路径写进来的是稳定 id，见 stableExperienceId），
   * 靠 `INSERT ... ON CONFLICT (id) DO NOTHING` 收敛。两个 memory maintenance worker
   * 同时处理同一条 Buffer 时正是撞在这里：谁都不会写出副本，谁都不会收到主键冲突。
   */
  it('saveExperienceIfAbsent 幂等：同一 id 只留一条经验，重试复用而非新建，计数只加一次', async () => {
    const role_id = `role_pglite_exp_idem_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Experience Idempotency' });
    const experience = createExperience(role_id);

    const first = await repository.saveExperienceIfAbsent(role_id, experience);
    expect(first.created).toBe(true);
    expect(first.experience.id).toBe(experience.id);

    const retried = await repository.saveExperienceIfAbsent(role_id, experience);
    expect(retried.created).toBe(false);
    expect(retried.experience.id).toBe(experience.id);

    await expect(repository.listExperiences(role_id)).resolves.toHaveLength(1);
    await expect(repository.getAgent(role_id)).resolves.toMatchObject({
      experience_count: 1,
      owned_exps: [experience.id],
    });
    await expect(repository.getMetrics(role_id)).resolves.toMatchObject({ experience_count: 1 });
  });

  it('saveExperienceIfAbsent 并发同一 id：只留一条经验、计数只加一次，两边都拿到它', async () => {
    const role_id = `role_pglite_exp_race_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Experience Race' });
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
   * 不同 id 的经验并发写入——这是「逐个读、在内存副本上改、整份 JSON 覆盖回去」真正丢更新
   * 的形状：两个调用方各自读到同一份旧 handle/metrics，各插一条，再各自把**自己的旧快照**
   * 覆盖回 memory_agents。两条经验都落了库，聚合根却只记了一条，owned_exps 也只剩一个。
   * 修复后计数与 owned_exps 由数据库侧对当前行做原子增量得出，谁都不会被对方覆盖。
   */
  it('saveExperienceIfAbsent 并发不同 id：两条经验都保留，计数与 owned_exps 都不丢', async () => {
    const role_id = `role_pglite_exp_race_multi_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Experience Multi Race' });
    const expA = createExperience(role_id);
    const expB = createExperience(role_id);
    const expectedIds = [expA.id, expB.id].sort();

    const [left, right] = await Promise.all([
      repository.saveExperienceIfAbsent(role_id, expA),
      repository.saveExperienceIfAbsent(role_id, expB),
    ]);

    // 不同 id 不构成幂等命中：两次都是真正新建
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
   * 同一批 Buffer 里多条经验**顺序**写入的累计形态：每条都只加一次，最终计数等于条数。
   * 并发版本（上面那条）验的是不丢，这条验的是不重复。
   */
  it('saveExperienceIfAbsent 顺序写入多条：计数等于条数，owned_exps 无重复', async () => {
    const role_id = `role_pglite_exp_seq_multi_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Experience Sequential' });
    const experiences = [createExperience(role_id), createExperience(role_id), createExperience(role_id)];

    for (const experience of experiences) {
      const result = await repository.saveExperienceIfAbsent(role_id, experience);
      expect(result.created).toBe(true);
    }

    const handle = await repository.getAgent(role_id);
    expect(handle.experience_count).toBe(3);
    expect(handle.owned_exps).toHaveLength(3);
    expect(new Set(handle.owned_exps).size).toBe(3);
    await expect(repository.getMetrics(role_id)).resolves.toMatchObject({ experience_count: 3 });
  });

  /**
   * 不同来源的 Skill 并发晋升：唯一键是 (role_id, promoted_from)，两条来源不同因此都该留下，
   * 但聚合根是同一行 memory_agents，旧实现下后写的那个会用旧快照把先写的计数与
   * owned_skills 一起抹掉。
   */
  it('saveSkillIfAbsent 并发不同来源：两条技能都保留，计数与 owned_skills 都不丢', async () => {
    const role_id = `role_pglite_promote_multi_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Promote Multi Race' });
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
    expect(left.skill.promoted_from).toBe(expA.id);
    expect(right.skill.promoted_from).toBe(expB.id);

    const skills = await repository.listSkills(role_id);
    expect(skills).toHaveLength(2);
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

  /**
   * 同一来源的 Skill 并发晋升：唯一键把两条收敛成一条，计数（含 promoted_skill_count）
   * 只加一次——幂等命中不是「偷偷多记一个」。
   */
  it('saveSkillIfAbsent 并发同一来源：只留一条技能、计数只加一次，两边都拿到它', async () => {
    const role_id = `role_pglite_promote_race_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Promote Race' });
    const experience = createExperience(role_id);
    await repository.saveExperience(role_id, experience);
    const makePromoted = (): SkillRecord =>
      createSkill(role_id, { promoted_from: experience.id, review_status: 'pending' });

    const [left, right] = await Promise.all([
      repository.saveSkillIfAbsent(role_id, makePromoted()),
      repository.saveSkillIfAbsent(role_id, makePromoted()),
    ]);

    expect([left.created, right.created].filter(Boolean)).toHaveLength(1);
    expect(left.skill.id).toBe(right.skill.id);
    await expect(repository.listSkills(role_id)).resolves.toHaveLength(1);

    const handle = await repository.getAgent(role_id);
    expect(handle.skill_count).toBe(1);
    expect(handle.owned_skills).toHaveLength(1);
    await expect(repository.getMetrics(role_id)).resolves.toMatchObject({
      skill_count: 1,
      promoted_skill_count: 1,
    });
  });

  /**
   * 插入与聚合根更新必须同生共死：聚合根那一步失败时，已插进去的经验不能留下孤儿行，
   * 计数也不能停在半路。失败注入只拦下 UPDATE memory_agents，其余 SQL 走真实路径。
   */
  it('聚合根更新失败时整条事务回滚：经验不留孤儿、计数不变', async () => {
    const role_id = `role_pglite_rollback_exp_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Rollback Experience' });

    const failing = new PgMemoryRepository({
      pool: createFailOnStatementPool(pool, (text) => text.includes('UPDATE memory_agents')),
      embedding,
      autoMigrate: false,
    });
    const experience = createExperience(role_id);

    await expect(failing.saveExperienceIfAbsent(role_id, experience)).rejects.toThrow(
      'injected aggregate update failure',
    );

    await expect(repository.listExperiences(role_id)).resolves.toHaveLength(0);
    await expect(repository.getAgent(role_id)).resolves.toMatchObject({
      experience_count: 0,
      owned_exps: [],
    });
    await expect(repository.getMetrics(role_id)).resolves.toMatchObject({ experience_count: 0 });

    // 恢复后重写同一条：正常落库，计数从 0 加到 1，没有留下「写了一半」的痕迹
    const retried = await repository.saveExperienceIfAbsent(role_id, experience);
    expect(retried.created).toBe(true);
    await expect(repository.listExperiences(role_id)).resolves.toHaveLength(1);
    await expect(repository.getAgent(role_id)).resolves.toMatchObject({
      experience_count: 1,
      owned_exps: [experience.id],
    });
  });

  it('聚合根更新失败时整条事务回滚：技能不留孤儿、计数不变', async () => {
    const role_id = `role_pglite_rollback_skill_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'PGlite Rollback Skill' });
    const experience = createExperience(role_id);
    await repository.saveExperience(role_id, experience);

    const failing = new PgMemoryRepository({
      pool: createFailOnStatementPool(pool, (text) => text.includes('UPDATE memory_agents')),
      embedding,
      autoMigrate: false,
    });

    await expect(
      failing.saveSkillIfAbsent(
        role_id,
        createSkill(role_id, { promoted_from: experience.id, review_status: 'pending' }),
      ),
    ).rejects.toThrow('injected aggregate update failure');

    await expect(repository.listSkills(role_id)).resolves.toHaveLength(0);
    await expect(repository.getAgent(role_id)).resolves.toMatchObject({
      skill_count: 0,
      owned_skills: [],
    });
    await expect(repository.getMetrics(role_id)).resolves.toMatchObject({
      skill_count: 0,
      promoted_skill_count: 0,
    });
  });
});

describe('PGlitePool dataDir persistence', () => {
  const embedding = new HashEmbeddingProvider();
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'newide-pglite-persist-'));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('survives a fresh pool over the same dataDir', async () => {
    const role_id = `role_pglite_persist_${randomUUID()}`;
    const dataDir = path.join(tempDir, 'db');

    const firstPool = await createPGlitePool({ dataDir });
    const first = new PgMemoryRepository({ pool: firstPool, embedding });
    await first.initializeAgent({ role_id, name: 'Persisted Agent', persona_seed: 'Persist me' });
    await first.saveSkill(role_id, createSkill(role_id));
    await firstPool.end();

    const secondPool = await createPGlitePool({ dataDir });
    const second = new PgMemoryRepository({ pool: secondPool, embedding });
    await expect(second.getPersona(role_id)).resolves.toMatchObject({
      summary: 'Persist me',
    });
    await expect(second.listSkills(role_id)).resolves.toHaveLength(1);
    await secondPool.end();
  });
});
