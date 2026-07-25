/**
 * pg-memory-repository 集成测试
 *
 * 需要 PostgreSQL + pgvector。未设置 MEMORY_PG_TEST_URL 时自动跳过。
 * 示例：MEMORY_PG_TEST_URL=postgres://user:pass@localhost:5432/newide_test pnpm test
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { nowTimestamp } from '../../core';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { PgMemoryRepository } from '../adapters/pg-memory-repository';
import { ensurePgMemorySchema } from '../adapters/pg-memory-schema';
import type { ExperienceRecord, SkillRecord } from '../schemas';

function loadEnv(): void {
  const envPath = resolve(__dirname, '../.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
loadEnv();

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
