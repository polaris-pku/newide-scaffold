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
      description_embedding vector(${dimensions}) NOT NULL,
      promoted_from UUID
    );
  `);

  // 晋升幂等的锚点：一条经验最多对应一条技能。列与索引都对已存在的库做 IF NOT EXISTS
  // 迁移（列在 payload JSONB 里也有，这里是把它提升为一等公民好让唯一约束能生效）。
  await pool.query(`ALTER TABLE memory_skills ADD COLUMN IF NOT EXISTS promoted_from UUID;`);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS memory_skills_promoted_from_uniq
      ON memory_skills (role_id, promoted_from) WHERE promoted_from IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_skills_role_id_idx
      ON memory_skills (role_id);
  `);

  // 经验的主键 id 就是幂等保存的锚点：两个 memory maintenance worker 同时处理同一条 Buffer
  // 时，提取出的经验带着同一个稳定 id（见 stableExperienceId），靠这个主键 + ON CONFLICT
  // DO NOTHING 收敛成一条，而不是靠「先查再插」——后者并发下会各插一次。
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_agent_archives (
      role_id TEXT PRIMARY KEY,
      payload JSONB NOT NULL
    );
  `);
}
