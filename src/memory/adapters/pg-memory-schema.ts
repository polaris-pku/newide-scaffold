/**
 * PgMemoryRepository 数据库 Schema
 *
 * 索引层 description_embedding 与载荷 JSON 同库（Spec §7.1）。
 * 调用 ensurePgMemorySchema 创建 extension 与表结构。
 * 只依赖最小 SqlPool 接口，pg.Pool 与 PGlite 适配器均可满足。
 */
import type { SqlPool } from '../ports/sql-pool';

/**
 * 存量行 `promoted_from` 的一次性回填（幂等，每次初始化都跑，正常情况下第二次起是空操作）。
 *
 * 列是后加的：更早的写入路径只把来源经验写进载荷 JSONB。不回填的话，这些技能在晋升归属
 * 校验里会被读成「没有来源」（判据查的是列，见 PgMemoryRepository.assertPromotedSkillReference），
 * 经验于是永远绑不上它们已经指向的技能。
 *
 * 三条判据都是为了「历史脏数据不能把整个初始化搞崩」——初始化失败等于整个记忆后端起不来：
 *
 * 1. 只在列为空时写：已经回填过（或本来就是晋升路径写进来的）的行一个字节都不动。
 * 2. 只认合法 UUID 形状：载荷是自由 JSON，`promoted_from` 里可能是任何东西（别的类型的
 *    id、手改过的字符串）。形状不对的行保持 NULL，读作「没有来源」，与「根本没有这个字段」
 *    同一个结论；形状判据在 WHERE 与 SET 里各出现一次，这样即使求值顺序变了也不会撞上
 *    `::uuid` 的 22P02。
 * 3. 同一 role 内两条技能指向同一来源时只回填 id 最小的那条：唯一索引随后就要建，都填
 *    进去会让 CREATE INDEX 直接失败。被跳过的行保持 NULL，与其他「来源为空」的行一样，
 *    不会伪装成一个可用的幂等键。
 */
const BACKFILL_PROMOTED_FROM_SQL = `
  UPDATE memory_skills AS target
  SET promoted_from = CASE
        WHEN target.payload->>'promoted_from'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (target.payload->>'promoted_from')::uuid
        ELSE NULL
      END
  WHERE target.promoted_from IS NULL
    AND target.payload->>'promoted_from'
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NOT EXISTS (
      SELECT 1 FROM memory_skills AS rival
      WHERE rival.role_id = target.role_id
        AND rival.id <> target.id
        AND lower(rival.promoted_from::text) = lower(target.payload->>'promoted_from')
    )
    AND NOT EXISTS (
      SELECT 1 FROM memory_skills AS rival
      WHERE rival.role_id = target.role_id
        AND rival.id < target.id
        AND rival.promoted_from IS NULL
        AND lower(rival.payload->>'promoted_from') = lower(target.payload->>'promoted_from')
    );
`;

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

  // 回填必须排在唯一索引**之前**：索引按 (role_id, promoted_from) 收敛，存量行若还停在
  // NULL，索引建得起来却挡不住「同一来源两条技能」——而那正是它要挡的东西。顺序反了不会
  // 报错，只会静默放过重复行。
  await pool.query(BACKFILL_PROMOTED_FROM_SQL);

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
