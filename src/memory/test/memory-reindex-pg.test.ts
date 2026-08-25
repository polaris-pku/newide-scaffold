/**
 * PgMemoryRepository 向量索引重建路径测试（PGlite 嵌入式 PostgreSQL + pgvector）
 *
 * 验证 memory.reindex 在 Pg 路径的端到端行为：
 *   1. 切换 embedding 模型（维度变化）后，首次访问自动把 vector(N) 列 ALTER 到新维度
 *   2. reindexMemory 直写向量：载荷 JSON 与 description_embedding 列同步更新
 *   3. 重建后向量检索（searchSkills）按新维度可用
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { PgMemoryRepository } from '../adapters/pg-memory-repository';
import { createPGlitePool } from '../adapters/pglite-pool';
import { reindexMemory } from '../services/memory-reindex';
import type { ExperienceRecord, SkillRecord } from '../schemas';
import type { SqlPool } from '../ports/sql-pool';

function createExperience(role_id: string): ExperienceRecord {
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
  };
}

function createSkill(role_id: string): SkillRecord {
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
  };
}

describe('PgMemoryRepository reindex path on embedded PGlite', () => {
  const roleId = `role_pg_reindex_${randomUUID()}`;
  let pool: SqlPool;

  beforeAll(async () => {
    pool = await createPGlitePool();
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS memory_experiences');
      await pool.query('DROP TABLE IF EXISTS memory_skills');
      await pool.query('DROP TABLE IF EXISTS memory_agents');
      await pool.end();
    }
  });

  it('migrates the vector column dimension and rebuilds embeddings end-to-end', async () => {
    // 旧模型：32 维写入
    const oldRepo = new PgMemoryRepository({ pool, embedding: new HashEmbeddingProvider(32) });
    await oldRepo.initializeAgent({ role_id: roleId, name: 'Reindex Agent' });
    await oldRepo.saveSkill(roleId, createSkill(roleId));
    await oldRepo.saveExperience(roleId, createExperience(roleId));
    expect((await oldRepo.listSkills(roleId))[0]!.description_embedding).toHaveLength(32);

    // 新模型：8 维。新仓库首次访问触发列维度迁移 vector(32) → vector(8)
    const newRepo = new PgMemoryRepository({ pool, embedding: new HashEmbeddingProvider(8) });
    await newRepo.listAgentIds(); // 触发 ensureSchema → migrateVectorColumnDimensions
    const columnType = await pool.query<{ type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relname = 'memory_skills' AND a.attname = 'description_embedding'`,
    );
    expect(columnType.rows[0]!.type).toBe('vector(8)');

    // 重建索引：存量 32 维全部重算为 8 维
    const result = await reindexMemory(newRepo, new HashEmbeddingProvider(8));
    expect(result).toMatchObject({
      agents_processed: 1,
      skills_reindexed: 1,
      skills_skipped: 0,
      experiences_reindexed: 1,
      experiences_skipped: 0,
      failures: [],
      dimensions: 8,
    });

    // 载荷 JSON（listSkills 读取来源）与向量列均已是 8 维
    const skills = await newRepo.listSkills(roleId);
    expect(skills[0]!.description_embedding).toHaveLength(8);
    const experiences = await newRepo.listExperiences(roleId);
    expect(experiences[0]!.description_embedding).toHaveLength(8);

    // 重建后向量检索按新维度可用（query 用与技能描述相同的 8 维向量 → 相似度 1）
    const queryEmbedding = await new HashEmbeddingProvider(8).embed(
      skills[0]!.description,
    );
    const hits = await newRepo.searchSkills(roleId, {
      query_embedding: queryEmbedding,
      top_k: 5,
      min_similarity: 0,
    });
    expect(hits.map((skill) => skill.id)).toEqual([skills[0]!.id]);
  });
});
