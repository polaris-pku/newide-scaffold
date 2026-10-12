/**
 * PgMemoryRepository 数据库 Schema
 *
 * 索引层 description_embedding 与载荷 JSON 同库（Spec §7.1）。
 * 调用 ensurePgMemorySchema 创建 extension 与表结构。
 * 只依赖最小 SqlPool 接口，pg.Pool 与 PGlite 适配器均可满足。
 */
import type { SqlPool } from '../ports/sql-pool';

/**
 * 存量技能「来源列 ↔ 载荷」的一次性对账（幂等，每次初始化都跑，正常情况下第二次起是空操作）。
 *
 * `memory_skills.promoted_from` 是后加的列：更早的写入路径只把来源经验写进载荷 JSONB，而列
 * 是晋升幂等键（部分唯一索引 `(role_id, promoted_from)`）与归属校验
 * （见 PgMemoryRepository.assertPromotedSkillReference）读的那一份。两者一旦不一致，同一条
 * 技能在三条读路上就有两个来源：`listSkills()`（读载荷，前端与 AgentBoard 看到的就是它）、
 * `saveSkillIfAbsent()`（幂等键是列）、`completePromotion()`（引用校验读列）。后果是经验绑
 * 不上一条「载荷说来自它」的技能，或者反过来接受一条它并没有晋升出来的技能。
 *
 * **载荷是唯一权威**，列在这段对账里只是被写的一方。分歧只有一个来源：修复前的 updateSkill
 * 只写载荷、不动列（见 2fc6ab03），所以列永远是更旧的那一半；而载荷是前端、检索与导出实际
 * 读的那一份。因此每一行的终局由载荷单独决定：
 *
 * 1. 载荷里是合法 UUID → 这一行认这个来源；列若不是它就改成它，列若为空就补上。
 * 2. 载荷里缺失、非法或不可转换（载荷是自由 JSON，可能是别的类型的 id 或是手改过的字符串）
 *    → 这一行**没有来源**：列清成 NULL，载荷里那个字段也一并删掉。两处一起清才是「不再分裂」
 *    ——只清列的话 `listSkills()` 会继续把一个读不懂的旧值当来源（Zod 直接解析失败），只清
 *    载荷的话幂等键与归属校验会继续认一个载荷已经不认的来源。
 * 3. 同一 role 下多行认了同一来源 → 保留 `id` 最小的那条，其余按第 2 条处理。唯一索引随后
 *    就要建，都留着会让 CREATE INDEX 直接失败、整个记忆后端起不来；被淘汰的行也不许再以任何
 *    形式暴露这个来源，否则它仍然是同一来源的第二个持有者。
 *
 * 这三条都不许把初始化搞崩（初始化失败等于整个记忆后端起不来），所以脏数据一律给出一个明确
 * 的终局——有来源，或没有来源——而不抛错。UUID 的形状判据只出现在 CASE 的「是 UUID」那一支
 * 之前，非 UUID 文本因此没有机会走到 `::uuid` 上（那会报 22P02）。
 *
 * 每行的终局收敛在下面这个 CTE 里：`keeps_source` 为假的行就属于「没有来源」那一类（载荷
 * 缺失 / 非法，或同来源里 id 不是最小的），后面三条语句都只读它。用窗口函数挑唯一保留者
 * 而不是相关子查询：初版那种 `NOT EXISTS (… rival.id < target.id …)` 是 O(n²)，而这段
 * 代码每次启动都要跑一遍。
 */
const PROMOTED_FROM_RECONCILIATION = `
  WITH resolved AS (
    SELECT
      id,
      role_id,
      payload,
      CASE
        WHEN payload->>'promoted_from'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (payload->>'promoted_from')::uuid
        ELSE NULL
      END AS payload_source
    FROM memory_skills
  ),
  planned AS (
    SELECT
      id,
      payload,
      payload_source,
      payload_source IS NOT NULL
        AND row_number() OVER (PARTITION BY role_id, payload_source ORDER BY id) = 1
        AS keeps_source
    FROM resolved
  )
`;

/**
 * 第一步：清掉列上不该留的来源。
 *
 * 终局是没有来源的行（载荷非法 / 缺失 / 被淘汰）在这里清成 NULL；终局有来源、但列上停着
 * 另一个值的行也在这里先清成 NULL。**先清后填**是为了唯一索引：两个 keep 行的列值互换
 * （A 的列停在 X 而载荷已经是 Y，B 的来源恰好是 X）时，一条 `SET promoted_from = <新值>`
 * 的 UPDATE 会在中途撞上唯一索引——Postgres 的唯一索引不延迟检查，同一语句里先写进去的
 * 新值还在。拆成两条语句后，中间态只有 NULL（部分索引不约束 NULL），任何时刻都不会出现
 * 同一 role 内的重复键。
 */
const CLEAR_PROMOTED_FROM_SQL = `
  ${PROMOTED_FROM_RECONCILIATION}
  UPDATE memory_skills AS target
  SET promoted_from = NULL
  FROM planned
  WHERE target.id = planned.id
    AND target.promoted_from IS DISTINCT FROM
      CASE WHEN planned.keeps_source THEN planned.payload_source END;
`;

/**
 * 第二步：终局没有来源的行，把载荷里的同名字段也删掉。
 *
 * 这一步是「载荷不许继续暴露旧来源」的落点：只清列的话，同一行在 `listSkills()` 里仍然带着
 * 来源，而在幂等键与归属校验里没有来源。`?` 是 jsonb 的「键存在」判据——键不存在时这条语句
 * 不碰它（重复执行因此是空操作）。
 */
const STRIP_PAYLOAD_PROMOTED_FROM_SQL = `
  ${PROMOTED_FROM_RECONCILIATION}
  UPDATE memory_skills AS target
  SET payload = target.payload - 'promoted_from'
  FROM planned
  WHERE target.id = planned.id
    AND NOT planned.keeps_source
    AND target.payload ? 'promoted_from';
`;

/**
 * 第三步：补上列（只写 NULL 的行）。
 *
 * 走到这里时，库里非 NULL 的列都已经等于该行的终局（上一步清干净了），而终局有来源的行是
 * 每个 (role_id, 来源) 恰好一条，所以这次只会把 NULL 填成终局值，不会撞唯一索引。第二步已经
 * 删掉了被淘汰行的载荷字段，但那不影响这里的判据：被淘汰的行本来就是同一个分组里 id 更大的
 * 那些，让它们离开分组不会改变剩下的那条排在第一位。
 */
const FILL_PROMOTED_FROM_SQL = `
  ${PROMOTED_FROM_RECONCILIATION}
  UPDATE memory_skills AS target
  SET promoted_from = planned.payload_source
  FROM planned
  WHERE target.id = planned.id
    AND planned.keeps_source
    AND target.promoted_from IS NULL;
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

  // Persona 演化标记（Phase 4-B）：可空，缺席即「这条演化流还没被人碰过」。
  //
  // 与 `persona` / `handle` 分列而不是塞进其中任何一个，理由是它属于**维护状态**：
  // `handle` 是前端与 Coordinator 读的那份载荷（不该多出 claim token、重试次数与失败原因），
  // 而 `persona` 是一次演化的产物（把「上一次怎么演化来的」记进产物会让两者互相耦合，
  // 前端 PATCH Persona 时还得决定这一组字段怎么办）。
  //
  // `ADD COLUMN IF NOT EXISTS` 而不是改 CREATE TABLE：已有库里这张表早就建好了，
  // 只改 CREATE 语句对它们等于没改。与 `promoted_from` 同一套迁移方式（幂等、可重复执行）。
  await pool.query(`ALTER TABLE memory_agents ADD COLUMN IF NOT EXISTS persona_evolution JSONB;`);

  // Persona 版本历史（Phase 4 修复 B）：每一版 Persona 的正文与来历。
  //
  // 为什么是单独一张表、而不是 Agent 行上的又一列：历史是**多行**（每演化一次、每回滚一次
  // 追加一行），而且它的两种读法（按角色列出全部版本、按版本号取一行）都要能吃上索引；塞进
  // 一个 JSONB 列会让「取第 3 版」变成把整份历史读出来再筛。
  //
  // 主键 `(role_id, persona_version)` 就是「同一角色同一版本号只有一行」这条不变量，也是
  // **历史不可变**的落点：三条写入路径（手工 / 演化 / 回滚）都靠 `ON CONFLICT DO NOTHING`
  // 让这个主键去挡第二次写入，没有任何 `DO UPDATE`——一行历史一旦落下就不再改。列
  // `persona_version` 与载荷里的 `persona.version` 同源（都由 personaVersionRecord 从正文
  // 派生），列存在的意义是让主键与排序用得上索引——Phase 3 的 `promoted_from` 曾经列与载荷
  // 分裂过一次，这里从一开始就只留一个权威（正文）。
  //
  // `ON DELETE CASCADE`：Agent 被删时历史跟着走（与经验、技能同一个处置）。退休归档保留的是
  // 最小字段，不承担「把每一版正文留在库里」的职责。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_persona_versions (
      role_id TEXT NOT NULL REFERENCES memory_agents(role_id) ON DELETE CASCADE,
      persona_version INT NOT NULL,
      payload JSONB NOT NULL,
      PRIMARY KEY (role_id, persona_version)
    );
  `);

  // 老 Agent 的**当前**版本补一行 `baseline`。
  //
  // Phase B 之前落库的版本没有历史：旧正文早已被覆盖，**补不出来**。能如实登记的只有「迁移
  // 这一刻的当前版本」这一件事，而它的来历（父版本、策略版本、run）不知道就是不知道——那几格
  // 缺席，不编。补它的理由有两个：回滚要有目标，以及「当前版本在历史里有一行」这条不变量
  // 从迁移那一刻起成立。
  //
  // 这一步同时是**修复步骤**：某个 Agent 的当前版本若因为「建 Agent 与写历史之间进程消失」
  // 而缺行，下一次启动照样补上。`DO NOTHING` 而不是 `DO UPDATE`——这里登记的是既有事实，
  // 不许改写历史；三条写入路径也只追加，不覆盖（见 PgMemoryRepository 的说明）。
  //
  // `created_at` 取正文自己的 `generated_at`：这一版什么时候生成的，正文自己带着答案，用迁移
  // 时刻是另一个意思（那一行是我们什么时候**登记**的）。两个正则护栏让脏数据**跳过**而不是
  // 把初始化搞崩：`version` 不是数字时 `::int` 会报错，`generated_at` 不是 ISO 串时读回来解析
  // 不了——跳过之后那个 Agent 就是「历史里没有行」，如实缺席，而不是整个记忆后端起不来。
  await pool.query(`
    INSERT INTO memory_persona_versions (role_id, persona_version, payload)
    SELECT
      role_id,
      (persona->>'version')::int,
      jsonb_build_object(
        'role_id', role_id,
        'persona_version', (persona->>'version')::int,
        'persona', persona,
        'source', 'baseline',
        'created_at', persona->>'generated_at'
      )
    FROM memory_agents
    WHERE persona->>'version' ~ '^[0-9]+$'
      AND persona->>'generated_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$'
    ON CONFLICT (role_id, persona_version) DO NOTHING;
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

  // 对账必须排在唯一索引**之前**：索引按 (role_id, promoted_from) 收敛，存量行若还停在该行
  // 载荷不认的来源上，索引建得起来却挡不住「同一来源两条技能」——而那正是它要挡的东西。顺序
  // 反了不会报错，只会静默放过重复行。三条语句的先后不能换，理由见各自常量的注释。
  await pool.query(CLEAR_PROMOTED_FROM_SQL);
  await pool.query(STRIP_PAYLOAD_PROMOTED_FROM_SQL);
  await pool.query(FILL_PROMOTED_FROM_SQL);

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
