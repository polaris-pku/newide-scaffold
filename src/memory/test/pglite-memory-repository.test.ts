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
import type { SqlPool } from '../ports/sql-pool';

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
