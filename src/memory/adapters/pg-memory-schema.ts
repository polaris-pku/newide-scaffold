/**
 * PgMemoryRepository 数据库 Schema
 *
 * 索引层 description_embedding 与载荷 JSON 同库（Spec §7.1）。
 * 调用 ensurePgMemorySchema 创建 extension 与表结构。
 * 只依赖最小 SqlPool 接口，pg.Pool 与 PGlite 适配器均可满足。
 */
import type { SqlPool } from '../ports/sql-pool';

export async function ensurePgMemorySchema(pool: SqlPool, dimensions: number): Promise<void> {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid embedding dimensions: ${dimensions}`);
  }

  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_agents (
      role_id TEXT PRIMARY KEY,
      handle JSONB NOT NULL,
      persona JSONB NOT NULL,
      metrics JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_skills (
      id UUID PRIMARY KEY,
      role_id TEXT NOT NULL REFERENCES memory_agents(role_id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      description_embedding vector(${dimensions}) NOT NULL
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_skills_role_id_idx
      ON memory_skills (role_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_experiences (
      id UUID PRIMARY KEY,
      role_id TEXT NOT NULL REFERENCES memory_agents(role_id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      description_embedding vector(${dimensions}) NOT NULL
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_experiences_role_id_idx
      ON memory_experiences (role_id);
  `);
}
