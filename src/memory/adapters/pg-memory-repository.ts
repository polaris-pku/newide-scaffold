/**
 * PgMemoryRepository — MemoryRepository PostgreSQL + pgvector 适配器
 *
 * 长期记忆（Persona / Skills / Experiences）落盘至 PostgreSQL；
 * description_embedding 使用 pgvector 做余弦相似度 top-K 检索。
 * Buffer 队列见 BufferRepository。
 * 只依赖最小 SqlPool 接口，pg.Pool（外部 PostgreSQL）与 PGlitePool（嵌入式）
 * 均可注入；SQL 与 pgvector 语义完全一致。
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import type { SqlClient, SqlPool } from '../ports/sql-pool';
import {
  AgentArchiveRecordSchema,
  AgentHandleSchema,
  AgentMetricsSchema,
  ExperienceRecordSchema,
  MARKET_POOL_ROLE_ID,
  PersonaDefSchema,
  PersonaEvolutionMarkerSchema,
  SkillRecordSchema,
  canNameExperience,
  type AgentArchiveRecord,
  type AgentHandle,
  type AgentMetrics,
  type AgentStatus,
  type CreateAgentSpec,
  type ExperienceRecord,
  type PersonaDef,
  type PersonaEvolutionMarker,
  type RetiredReason,
  type SkillRecord,
} from '../schemas';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { PromotionApprovalMode } from '../ports/promotion-strategy';
import type {
  ClaimedPersonaEvolutionCandidate,
  ClaimedPromotionCandidate,
  ExperienceFeedbackApplication,
  ExperienceFeedbackResult,
  ExperienceSaveResult,
  MarketImportResult,
  MarketSearchOptions,
  MemoryRepository,
  MemoryVectorSearchOptions,
  PersonaEvolutionClaimRequest,
  PersonaEvolutionCompletionRequest,
  PersonaEvolutionCompletionResult,
  PersonaEvolutionFailureRequest,
  PersonaEvolutionRestoreOptions,
  PromotionCandidateQuery,
  PromotionClaimRequest,
  PromotionCompletionRequest,
  PromotionFailureRequest,
  PromotionRestoreOptions,
  RestoredPersonaEvolutionClaim,
  SkillSaveResult,
  TransferSkillToMarketOptions,
} from '../ports/memory-repository';
import {
  DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY,
  DEFAULT_PROMOTION_RETRY_POLICY,
  claimDeliveryRecord,
  completeDeliveryRecord,
  expireDeliveryClaimRecord,
  failDeliveryRecord,
  isDeliveryClaimExpired,
  newClaimToken,
  resetDeliveryForRetry,
  type DeliveryRetryPolicy,
} from '../services/delivery-lifecycle';
import {
  buildPersonaEvolutionSnapshot,
  personaEvolutionInputSnapshotHash,
  planPersonaEvolutionCandidate,
} from '../services/persona-evolution-candidates';
import {
  personaEvolutionSettlement,
  resolvePersonaEvolutionWrite,
} from '../services/persona-evolution-decision';
import {
  comparePromotionCandidates,
  planPromotionCandidate,
  selectPromotionCandidates,
  type PromotionCandidateInput,
} from '../services/promotion-candidates';
import {
  assertPromotedSkillReference,
  type PromotedSkillFacts,
} from '../services/promotion-integrity';
import {
  applyFeedbackToExperience,
  averageConfidence,
  isFeedbackApplied,
} from '../services/usage-feedback';
import { defaultHashEmbeddingProvider } from './hash-embedding-provider';
import {
  createSeedHandle,
  createSeedMetrics,
  createSeedPersona,
  DEFAULT_MIN_EXPERIENCE_CONFIDENCE,
  DEFAULT_MIN_SIMILARITY,
  isMarketEligibleSkill,
} from './memory-repository-seeds';
import { ensurePgMemorySchema } from './pg-memory-schema';

/** PgMemoryRepository 构造选项 */
export interface PgMemoryRepositoryOptions {
  /** 已配置的 SQL 连接池（pg.Pool 或 PGlite 适配器） */
  pool: SqlPool;
  /** 写入时补全 description_embedding；默认 HashEmbeddingProvider */
  embedding?: EmbeddingProvider;
  /** 首次访问前自动建表（默认 true） */
  autoMigrate?: boolean;
}

function toPgVector(values: number[]): string {
  return `[${values.join(',')}]`;
}

/**
 * 插入一条 Experience 之后推进 Agent 聚合根：计数 +1，owned_exps 追加该 id。
 *
 * 为什么整段用 SQL 表达而不是「读出来 → 在内存副本上改 → 整份 JSON 写回」：
 * 两个维护 worker 并发处理**不同**记录时，两边都会读到同一份旧 handle/metrics，各自
 * 算出 +1、各自覆盖回去，后写的那个把先写的整个抹掉——库里两条 Experience，聚合根只记
 * 一条。这里让数据库对**当前行**做增量：SET 表达式直接引用 handle/metrics，UPDATE 持有
 * 的行锁保证它读到的是最新提交的版本，因此谁都不会覆盖谁；owned_exps 用「包含检查 +
 * 追加」既不丢也不重复。这些语义对 pg.Pool 与 PGlite 是同一套 SQL。
 */
const EXPERIENCE_AGGREGATE_BUMP_SQL = `
  UPDATE memory_agents
  SET handle = jsonb_set(
        jsonb_set(
          jsonb_set(
            handle,
            '{owned_exps}',
            CASE
              WHEN COALESCE(handle->'owned_exps', '[]'::jsonb) @> jsonb_build_array($2::text)
                THEN handle->'owned_exps'
              ELSE COALESCE(handle->'owned_exps', '[]'::jsonb) || jsonb_build_array($2::text)
            END,
            true
          ),
          '{experience_count}',
          to_jsonb(COALESCE((handle->>'experience_count')::int, 0) + 1),
          true
        ),
        '{metric,experience_count}',
        to_jsonb(COALESCE((handle->'metric'->>'experience_count')::int, 0) + 1),
        false
      ),
      metrics = jsonb_set(
        metrics,
        '{experience_count}',
        to_jsonb(COALESCE((metrics->>'experience_count')::int, 0) + 1),
        true
      )
  WHERE role_id = $1
`;

/**
 * 插入一条 Skill 之后推进 Agent 聚合根：skill_count / promoted_skill_count +1、
 * owned_skills 追加该 id。与 EXPERIENCE_AGGREGATE_BUMP_SQL 同一套路数、同一组理由。
 */
const SKILL_AGGREGATE_BUMP_SQL = `
  UPDATE memory_agents
  SET handle = jsonb_set(
        jsonb_set(
          jsonb_set(
            handle,
            '{owned_skills}',
            CASE
              WHEN COALESCE(handle->'owned_skills', '[]'::jsonb) @> jsonb_build_array($2::text)
                THEN handle->'owned_skills'
              ELSE COALESCE(handle->'owned_skills', '[]'::jsonb) || jsonb_build_array($2::text)
            END,
            true
          ),
          '{skill_count}',
          to_jsonb(COALESCE((handle->>'skill_count')::int, 0) + 1),
          true
        ),
        '{metric,skill_count}',
        to_jsonb(COALESCE((handle->'metric'->>'skill_count')::int, 0) + 1),
        false
      ),
      metrics = jsonb_set(
        jsonb_set(
          metrics,
          '{skill_count}',
          to_jsonb(COALESCE((metrics->>'skill_count')::int, 0) + 1),
          true
        ),
        '{promoted_skill_count}',
        to_jsonb(COALESCE((metrics->>'promoted_skill_count')::int, 0) + 1),
        true
      )
  WHERE role_id = $1
`;

/**
 * 反馈应用的条件写最多重读几版。
 *
 * 每次没写进去都意味着「读之后有人改了同一条经验」——可能是另一条反馈，也可能是晋升
 * 写入。允许几次重读是为了吸收正常的并发抖动；一直抢不到就说明这条经验正被密集回写，
 * 此时把这条反馈还给交付层的退避重试（抛错 → 可重试失败）比在这里空转更合适。
 */
const EXPERIENCE_FEEDBACK_MAX_CAS_ATTEMPTS = 5;

/**
 * 反馈应用之后的条件写回 Agent 聚合指标（avg_confidence）。
 *
 * 条件（`metrics->>'avg_confidence'` 仍是读到的那一版）是一条**有序性护栏**：一次成功的
 * 反馈应用会把经验集合推到一个新状态，它算出的均值只有落在一个**还没有被别人推进过**的
 * 聚合上才算数。两个消费者并发回写**不同**经验时，各自读到的都是旧集合，后写的那一方若
 * 无条件整份覆盖，就会把先写那一方的均值抹掉——库里两条经验都更新了，`avg_confidence`
 * 却停在只反映其中一条的旧值。写不进去（rowCount=0）由调用方重读经验集合再来一遍，
 * 第二遍读到的是两份更新之后的集合，均值因此必然收敛到真实均值。
 *
 * handle 内嵌的 `metric` 快照与 `metrics` 列必须同时推进：`AgentBoardQuery` 读 handle、
 * `getMetrics` 读列，只写一个会让同一个聚合根在两个读口上给出两个答案。
 */
const FEEDBACK_AVG_CONFIDENCE_SQL = `
  UPDATE memory_agents
  SET metrics = jsonb_set(metrics, '{avg_confidence}', to_jsonb($3::double precision), true),
      handle = jsonb_set(handle, '{metric,avg_confidence}', to_jsonb($3::double precision), false)
  WHERE role_id = $1
    AND metrics->>'avg_confidence' = $2
`;

/**
 * 读取表内 description_embedding 列的 vector(N) 维度；列不存在返回 undefined。
 * 用于检测 embedding 模型切换后的维度漂移（migrateVectorColumnDimensions）。
 */
async function readVectorColumnDimensions(
  pool: SqlPool,
  table: string,
): Promise<number | undefined> {
  const result = await pool.query<{ type: string }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS type
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1 AND a.attname = 'description_embedding'`,
    [table],
  );
  const type = result.rows[0]?.type;
  const match = type ? /^vector\((\d+)\)$/.exec(type) : null;
  return match ? Number(match[1]) : undefined;
}

export class PgMemoryRepository implements MemoryRepository {
  private readonly pool: SqlPool;
  private readonly embedding: EmbeddingProvider;
  private readonly autoMigrate: boolean;
  private schemaReady: Promise<void> | undefined;
  /** 每个 role 一条排队链，见 withRoleLock */
  private readonly roleQueues = new Map<string, Promise<unknown>>();

  constructor(options: PgMemoryRepositoryOptions) {
    this.pool = options.pool;
    this.embedding = options.embedding ?? defaultHashEmbeddingProvider;
    this.autoMigrate = options.autoMigrate ?? true;
  }

  async ensureAgent(role_id: string): Promise<void> {
    await this.ensureSchema();
    const existing = await this.pool.query<{ role_id: string }>(
      'SELECT role_id FROM memory_agents WHERE role_id = $1',
      [role_id],
    );
    if (existing.rowCount === 0) {
      await this.initializeAgent({ role_id, name: role_id });
    }
  }

  async initializeAgent(spec: CreateAgentSpec): Promise<void> {
    await this.ensureSchema();
    const persona = createSeedPersona(spec.role_id, spec.persona_seed);
    const metrics = createSeedMetrics(spec.role_id);
    const handle = createSeedHandle(spec, persona, metrics);

    AgentHandleSchema.parse(handle);
    PersonaDefSchema.parse(persona);
    AgentMetricsSchema.parse(metrics);

    try {
      await this.pool.query(
        `INSERT INTO memory_agents (role_id, handle, persona, metrics)
         VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)`,
        [spec.role_id, JSON.stringify(handle), JSON.stringify(persona), JSON.stringify(metrics)],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(`Agent already exists: ${spec.role_id}`);
      }
      throw error;
    }
  }

  async listAgentIds(): Promise<string[]> {
    await this.ensureSchema();
    const result = await this.pool.query<{ role_id: string }>(
      'SELECT role_id FROM memory_agents WHERE role_id <> $1 ORDER BY role_id',
      [MARKET_POOL_ROLE_ID],
    );
    return result.rows.map((row) => row.role_id);
  }

  async updateAgentMeta(
    role_id: string,
    patch: { name?: string; tags?: string[] },
  ): Promise<void> {
    await this.ensureSchema();
    const handle = await this.getAgent(role_id);
    const nextHandle: AgentHandle = {
      ...handle,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    };
    AgentHandleSchema.parse(nextHandle);

    const result = await this.pool.query(
      `UPDATE memory_agents
       SET handle = $2::jsonb
       WHERE role_id = $1`,
      [role_id, JSON.stringify(nextHandle)],
    );
    if (result.rowCount === 0) {
      throw new Error(`Agent not found: ${role_id}`);
    }
  }

  async deleteAgent(role_id: string): Promise<void> {
    await this.ensureSchema();
    if (role_id === MARKET_POOL_ROLE_ID) {
      throw new Error(`Cannot delete market pool agent: ${role_id}`);
    }
    // memory_skills / memory_experiences 的 FK 均带 ON DELETE CASCADE，级联清理
    const result = await this.pool.query('DELETE FROM memory_agents WHERE role_id = $1', [
      role_id,
    ]);
    if (result.rowCount === 0) {
      throw new Error(`Agent not found: ${role_id}`);
    }
  }

  async archiveAgent(roleId: string, archive: AgentArchiveRecord): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO memory_agent_archives (role_id, payload)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (role_id) DO UPDATE SET payload = EXCLUDED.payload`,
      [roleId, JSON.stringify(archive)],
    );
  }

  async getAgentArchive(roleId: string): Promise<AgentArchiveRecord | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ payload: AgentArchiveRecord }>(
      'SELECT payload FROM memory_agent_archives WHERE role_id = $1',
      [roleId],
    );
    const row = result.rows[0];
    return row ? AgentArchiveRecordSchema.parse(row.payload) : null;
  }

  async getAgent(role_id: string): Promise<AgentHandle> {
    await this.ensureSchema();
    const row = await this.requireAgentRow(role_id);
    return AgentHandleSchema.parse(row.handle);
  }

  async getPersona(role_id: string): Promise<PersonaDef> {
    await this.ensureSchema();
    const row = await this.requireAgentRow(role_id);
    return PersonaDefSchema.parse(row.persona);
  }

  async getMetrics(role_id: string): Promise<AgentMetrics> {
    await this.ensureSchema();
    const row = await this.requireAgentRow(role_id);
    return AgentMetricsSchema.parse(row.metrics);
  }

  async listSkills(role_id: string): Promise<SkillRecord[]> {
    await this.ensureSchema();
    await this.requireAgentRow(role_id);
    const result = await this.pool.query<{ payload: SkillRecord }>(
      `SELECT payload
       FROM memory_skills
       WHERE role_id = $1
       ORDER BY payload->>'created_at' ASC`,
      [role_id],
    );
    return result.rows.map((row) => SkillRecordSchema.parse(row.payload));
  }

  async listExperiences(role_id: string): Promise<ExperienceRecord[]> {
    await this.ensureSchema();
    await this.requireAgentRow(role_id);
    const result = await this.pool.query<{ payload: ExperienceRecord }>(
      `SELECT payload
       FROM memory_experiences
       WHERE role_id = $1
       ORDER BY payload->>'created_at' ASC`,
      [role_id],
    );
    return result.rows.map((row) => ExperienceRecordSchema.parse(row.payload));
  }

  async searchSkills(role_id: string, options: MemoryVectorSearchOptions): Promise<SkillRecord[]> {
    await this.ensureSchema();
    await this.requireAgentRow(role_id);

    const min_similarity = options.min_similarity ?? DEFAULT_MIN_SIMILARITY;
    const result = await this.pool.query<{ payload: SkillRecord }>(
      `SELECT payload
       FROM memory_skills
       WHERE role_id = $1
         AND payload->>'review_status' = 'approved'
         AND COALESCE(payload->>'market_status', '') <> 'superseded'
         AND (1 - (description_embedding <=> $2::vector)) >= $3
       ORDER BY description_embedding <=> $2::vector ASC
       LIMIT $4`,
      [role_id, toPgVector(options.query_embedding), min_similarity, options.top_k],
    );

    return result.rows.map((row) => SkillRecordSchema.parse(row.payload));
  }

  async searchExperiences(
    role_id: string,
    options: MemoryVectorSearchOptions,
  ): Promise<ExperienceRecord[]> {
    await this.ensureSchema();
    await this.requireAgentRow(role_id);

    const min_confidence = options.min_confidence ?? DEFAULT_MIN_EXPERIENCE_CONFIDENCE;
    const min_similarity = options.min_similarity ?? DEFAULT_MIN_SIMILARITY;
    const result = await this.pool.query<{ payload: ExperienceRecord }>(
      `SELECT payload
       FROM memory_experiences
       WHERE role_id = $1
         AND payload->>'type' = 'positive'
         AND payload->>'promoted_to' IS NULL
         AND (payload->>'confidence')::double precision >= $2
         AND (1 - (description_embedding <=> $3::vector)) >= $4
       ORDER BY description_embedding <=> $3::vector ASC
       LIMIT $5`,
      [role_id, min_confidence, toPgVector(options.query_embedding), min_similarity, options.top_k],
    );

    return result.rows.map((row) => ExperienceRecordSchema.parse(row.payload));
  }

  async marketSearchSkills(options: MarketSearchOptions): Promise<SkillRecord[]> {
    await this.ensureSchema();

    const min_similarity = options.min_similarity ?? DEFAULT_MIN_SIMILARITY;
    const result = await this.pool.query<{ payload: SkillRecord }>(
      `SELECT payload
       FROM memory_skills
       WHERE role_id = $1
         AND payload->>'review_status' = 'approved'
         AND COALESCE(payload->>'market_status', '') <> 'superseded'
         AND ($2::text IS NULL OR role_id <> $2::text)
         AND (1 - (description_embedding <=> $3::vector)) >= $4
       ORDER BY description_embedding <=> $3::vector ASC
       LIMIT $5`,
      [
        MARKET_POOL_ROLE_ID,
        options.exclude_agent_id ?? null,
        toPgVector(options.query_embedding),
        min_similarity,
        options.top_k,
      ],
    );

    return result.rows.map((row) => SkillRecordSchema.parse(row.payload));
  }

  async marketImportSkill(role_id: string, source_skill_id: string): Promise<MarketImportResult> {
    await this.ensureSchema();
    await this.requireAgentRow(role_id);

    // 1. 定位源技能（memory_skills.id 为全局唯一主键，天然跨 Agent）
    const sourceResult = await this.pool.query<{ role_id: string; payload: SkillRecord }>(
      `SELECT role_id, payload FROM memory_skills WHERE id = $1`,
      [source_skill_id],
    );
    const sourceRow = sourceResult.rows[0];
    if (!sourceRow) {
      throw new Error(`Market skill not found: ${source_skill_id}`);
    }
    const source = SkillRecordSchema.parse(sourceRow.payload);
    if (!isMarketEligibleSkill(source)) {
      throw new Error(`Market skill not importable (review/status): ${source_skill_id}`);
    }

    // 2. 幂等：引入方已有该源技能的副本 → 直接返回已有副本
    const existingResult = await this.pool.query<{ payload: SkillRecord }>(
      `SELECT payload
       FROM memory_skills
       WHERE role_id = $1 AND payload->>'imported_from' = $2
       LIMIT 1`,
      [role_id, source_skill_id],
    );
    if (existingResult.rows[0]) {
      const imported = SkillRecordSchema.parse(existingResult.rows[0].payload);
      return { imported, source, created: false };
    }

    // 3. 事务：插入副本 + 更新源 imported_by + 更新引入方 handle/metrics
    const now = nowTimestamp();
    const copy: SkillRecord = {
      ...source,
      id: randomUUID(),
      agent_id: role_id,
      imported_from: source_skill_id,
      imported_by: undefined,
      promoted_from: undefined,
      created_at: now,
      updated_at: now,
    };
    const stored = await this.withDescriptionEmbedding(copy);
    SkillRecordSchema.parse(stored);

    const updatedSource: SkillRecord = {
      ...source,
      imported_by: [...(source.imported_by ?? []), role_id],
      updated_at: now,
    };
    SkillRecordSchema.parse(updatedSource);

    const handle = await this.getAgent(role_id);
    const metrics = await this.getMetrics(role_id);
    const nextMetrics: AgentMetrics = {
      ...metrics,
      skill_count: metrics.skill_count + 1,
      imported_skill_count: metrics.imported_skill_count + 1,
    };
    const nextHandle: AgentHandle = {
      ...handle,
      skill_count: handle.skill_count + 1,
      owned_skills: [...handle.owned_skills, stored.id],
      metric: nextMetrics,
    };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO memory_skills (id, role_id, payload, description_embedding)
         VALUES ($1, $2, $3::jsonb, $4::vector)`,
        [stored.id, role_id, JSON.stringify(stored), toPgVector(stored.description_embedding)],
      );
      await client.query(
        `UPDATE memory_skills SET payload = $2::jsonb WHERE id = $1`,
        [source_skill_id, JSON.stringify(updatedSource)],
      );
      await client.query(
        `UPDATE memory_agents
         SET handle = $2::jsonb, metrics = $3::jsonb
         WHERE role_id = $1`,
        [role_id, JSON.stringify(nextHandle), JSON.stringify(nextMetrics)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return { imported: stored, source: updatedSource, created: true };
  }

  async transferSkillToMarket(
    fromRoleId: string,
    skillId: string,
    options: TransferSkillToMarketOptions = {},
  ): Promise<SkillRecord> {
    await this.ensureSchema();
    await this.requireAgentRow(fromRoleId);
    // 首次迁移时自动初始化市场池 Agent
    await this.ensureAgent(MARKET_POOL_ROLE_ID);

    const sourceResult = await this.pool.query<{ payload: SkillRecord }>(
      `SELECT payload FROM memory_skills WHERE role_id = $1 AND id = $2`,
      [fromRoleId, skillId],
    );
    const sourceRow = sourceResult.rows[0];
    if (!sourceRow) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    const original = SkillRecordSchema.parse(sourceRow.payload);

    const now = nowTimestamp();
    const moved: SkillRecord = {
      ...original,
      agent_id: MARKET_POOL_ROLE_ID,
      market_status: options.market_status ?? original.market_status,
      origin_agent_id: original.origin_agent_id ?? original.agent_id,
      updated_at: now,
    };
    SkillRecordSchema.parse(moved);

    const sourceHandle = await this.getAgent(fromRoleId);
    const sourceMetrics = await this.getMetrics(fromRoleId);
    const marketHandle = await this.getAgent(MARKET_POOL_ROLE_ID);
    const marketMetrics = await this.getMetrics(MARKET_POOL_ROLE_ID);

    const nextSourceHandle: AgentHandle = {
      ...sourceHandle,
      skill_count: sourceHandle.skill_count - 1,
      owned_skills: sourceHandle.owned_skills.filter((id) => id !== skillId),
    };
    const nextSourceMetrics: AgentMetrics = {
      ...sourceMetrics,
      skill_count: sourceMetrics.skill_count - 1,
    };
    const nextMarketHandle: AgentHandle = {
      ...marketHandle,
      skill_count: marketHandle.skill_count + 1,
      owned_skills: [...marketHandle.owned_skills, skillId],
    };
    const nextMarketMetrics: AgentMetrics = {
      ...marketMetrics,
      skill_count: marketMetrics.skill_count + 1,
    };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE memory_skills
         SET role_id = $2::text, payload = $3::jsonb
         WHERE role_id = $1 AND id = $4`,
        [fromRoleId, MARKET_POOL_ROLE_ID, JSON.stringify(moved), skillId],
      );
      await client.query(
        `UPDATE memory_agents
         SET handle = $2::jsonb, metrics = $3::jsonb
         WHERE role_id = $1`,
        [fromRoleId, JSON.stringify(nextSourceHandle), JSON.stringify(nextSourceMetrics)],
      );
      await client.query(
        `UPDATE memory_agents
         SET handle = $2::jsonb, metrics = $3::jsonb
         WHERE role_id = $1`,
        [MARKET_POOL_ROLE_ID, JSON.stringify(nextMarketHandle), JSON.stringify(nextMarketMetrics)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return moved;
  }

  async saveExperience(role_id: string, experience: ExperienceRecord): Promise<void> {
    await this.ensureSchema();
    const stored = await this.withDescriptionEmbedding(experience);
    ExperienceRecordSchema.parse(stored);
    await this.withRoleLock(role_id, () =>
      this.insertExperienceRow(role_id, stored, { onConflictDoNothing: false }),
    );
  }

  /**
   * 幂等保存经验：唯一键是主键 `id`，靠 `ON CONFLICT (id) DO NOTHING` 让「查有没有 + 写进去」
   * 在数据库里原子完成。
   *
   * 与 saveSkillIfAbsent 同一套路数、同一组理由：两个独立 worker 可能同时处理同一个
   * `(role_id, buffer_seq)`，而「先 listExperiences 再逐条 saveExperience」是两次独立往返，
   * 两边都查不到对方那条，于是 PG 这一侧会有一方撞主键被抛异常、内存那一侧会攒出重复 id。
   * 撞上（rowCount === 0）时**不计数**，读回仓库里已有那条交给调用方——两个 worker 因此都
   * 拿到同一条已持久化的经验，谁都不会收到冲突异常。
   *
   * 不同 id 的并发写入走的是另一条路径（两次都真正插入），聚合根的计数与 owned_exps 由
   * EXPERIENCE_AGGREGATE_BUMP_SQL 在事务内对当前行增量得出，不会互相覆盖。
   */
  async saveExperienceIfAbsent(
    role_id: string,
    experience: ExperienceRecord,
  ): Promise<ExperienceSaveResult> {
    await this.ensureSchema();
    const stored = await this.withDescriptionEmbedding(experience);
    ExperienceRecordSchema.parse(stored);
    return this.withRoleLock(role_id, () =>
      this.insertExperienceRow(role_id, stored, { onConflictDoNothing: true }),
    );
  }

  /**
   * 事务内完成「插一条 Experience + 推进聚合根」两件事，任一步失败整条回滚。
   *
   * `onConflictDoNothing` 打开时同 id 命中不报错、不计数，回读已有那条返回（幂等路径）；
   * 关闭时同 id 命中按主键冲突抛出（普通保存路径）。
   */
  private async insertExperienceRow(
    role_id: string,
    stored: ExperienceRecord,
    options: { onConflictDoNothing: boolean },
  ): Promise<ExperienceSaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO memory_experiences (id, role_id, payload, description_embedding)
         VALUES ($1, $2, $3::jsonb, $4::vector)
         ${options.onConflictDoNothing ? 'ON CONFLICT (id) DO NOTHING' : ''}
         RETURNING id`,
        [stored.id, role_id, JSON.stringify(stored), toPgVector(stored.description_embedding)],
      );

      if (inserted.rowCount === 0) {
        // 已经有一条同 id 的经验：这次什么都不改（不计数）。用 COMMIT 而不是 ROLLBACK——
        // 回滚会把并发那一侧刚插进去的行一起带走，剩下的读回就成了空。
        await client.query('COMMIT');
        const existing = await this.findExperienceById(stored.id);
        if (!existing || existing.role_id !== role_id) {
          throw new Error(
            existing
              ? `Experience ${stored.id} conflicted but is owned by ${existing.role_id}, not ${role_id}`
              : `Experience ${stored.id} conflicted but could not be read back`,
          );
        }
        return { experience: existing.experience, created: false };
      }

      // 只有真正插进去才计数。计数失败（如 Agent 行不存在）连同上面的 INSERT 一起回滚，
      // 不会留下「有记录、没计数」的孤儿。
      const bumped = await client.query(EXPERIENCE_AGGREGATE_BUMP_SQL, [role_id, stored.id]);
      if (bumped.rowCount === 0) {
        throw new Error(`Agent not found: ${role_id}`);
      }
      await client.query('COMMIT');
      return { experience: stored, created: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 按主键读回一条经验（`ON CONFLICT` 的查询侧），连带它属于哪个 role。 */
  private async findExperienceById(
    id: string,
  ): Promise<{ role_id: string; experience: ExperienceRecord } | undefined> {
    const result = await this.pool.query<{ role_id: string; payload: unknown }>(
      `SELECT role_id, payload FROM memory_experiences WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { role_id: row.role_id, experience: ExperienceRecordSchema.parse(row.payload) };
  }

  async saveSkill(role_id: string, skill: SkillRecord): Promise<void> {
    await this.ensureSchema();
    const stored = await this.withDescriptionEmbedding(skill);
    SkillRecordSchema.parse(stored);
    await this.withRoleLock(role_id, () =>
      this.insertSkillRow(role_id, stored, { onConflictDoNothing: false }),
    );
  }

  /**
   * 幂等保存晋升技能：唯一键 `(role_id, promoted_from)`，由部分唯一索引
   * `memory_skills_promoted_from_uniq` 保证，写入用 ON CONFLICT DO NOTHING。
   *
   * 晋升是「先存 Skill、再回写 Experience.promoted_to」两步，第二步失败后重试会再次
   * 走到这里。靠数据库的唯一约束而不是「先查再插」：后者在并发下两次都查不到、各自插入，
   * 攒出成对的重复技能。冲突时回读已有那条返回，Experience 的 promoted_to 因此永远指向
   * 同一个技能。计数只在真正新建时才递增。
   *
   * 来源**不同**的并发晋升是另一条路径（两次都真正插入），聚合根的 skill_count 与
   * owned_skills 由 SKILL_AGGREGATE_BUMP_SQL 在事务内对当前行增量得出，不会互相覆盖。
   */
  async saveSkillIfAbsent(role_id: string, skill: SkillRecord): Promise<SkillSaveResult> {
    await this.ensureSchema();
    const stored = await this.withDescriptionEmbedding(skill);
    SkillRecordSchema.parse(stored);
    // promoted_from 为空（市场导入等）没有幂等键可用，退化为普通保存
    return this.withRoleLock(role_id, () =>
      this.insertSkillRow(role_id, stored, {
        onConflictDoNothing: stored.promoted_from !== undefined,
      }),
    );
  }

  /**
   * 事务内完成「插一条 Skill + 推进聚合根」两件事，任一步失败整条回滚。
   *
   * 语义与 insertExperienceRow 一致，唯一键换成部分唯一索引 `(role_id, promoted_from)`。
   */
  private async insertSkillRow(
    role_id: string,
    stored: SkillRecord,
    options: { onConflictDoNothing: boolean },
  ): Promise<SkillSaveResult> {
    const promotedFrom = stored.promoted_from ?? null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO memory_skills (id, role_id, payload, description_embedding, promoted_from)
         VALUES ($1, $2, $3::jsonb, $4::vector, $5)
         ${
           options.onConflictDoNothing
             ? 'ON CONFLICT (role_id, promoted_from) WHERE promoted_from IS NOT NULL DO NOTHING'
             : ''
         }
         RETURNING id`,
        [
          stored.id,
          role_id,
          JSON.stringify(stored),
          toPgVector(stored.description_embedding),
          promotedFrom,
        ],
      );

      if (inserted.rowCount === 0) {
        // 已经有一条同源的技能：这次什么都不改（不计数）。用 COMMIT 而不是 ROLLBACK——
        // 回滚会把并发那一侧刚插进去的行一起带走，剩下的读回就成了空。
        await client.query('COMMIT');
        if (promotedFrom === null) {
          // 只会发生在「没挂 ON CONFLICT 子句却报冲突」这种不该出现的组合上
          throw new Error(`Skill ${stored.id} conflicted without a promoted_from key`);
        }
        const existing = await this.findSkillByPromotedFrom(role_id, promotedFrom);
        if (!existing) {
          throw new Error(
            `Skill for promoted_from=${promotedFrom} conflicted but could not be read back`,
          );
        }
        return { skill: existing, created: false };
      }

      const bumped = await client.query(SKILL_AGGREGATE_BUMP_SQL, [role_id, stored.id]);
      if (bumped.rowCount === 0) {
        throw new Error(`Agent not found: ${role_id}`);
      }
      await client.query('COMMIT');
      return { skill: stored, created: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 读回一条 `promoted_from` 指向给定经验的技能（部分唯一索引的查询侧）。 */
  private async findSkillByPromotedFrom(
    role_id: string,
    promoted_from: string,
  ): Promise<SkillRecord | undefined> {
    const result = await this.pool.query<{ payload: unknown }>(
      `SELECT payload FROM memory_skills WHERE role_id = $1 AND promoted_from = $2`,
      [role_id, promoted_from],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return SkillRecordSchema.parse(row.payload);
  }

  async savePersona(role_id: string, persona: PersonaDef): Promise<void> {
    await this.ensureSchema();
    PersonaDefSchema.parse(persona);

    // AgentHandle 内嵌 persona 快照，AgentBoardQuery.getAgent 返回 handle.persona，需同步
    const handle = await this.getAgent(role_id);
    const nextHandle = { ...handle, persona };

    const result = await this.pool.query(
      `UPDATE memory_agents
       SET persona = $2::jsonb, handle = $3::jsonb
       WHERE role_id = $1`,
      [role_id, JSON.stringify(persona), JSON.stringify(nextHandle)],
    );

    if (result.rowCount === 0) {
      throw new Error(`Agent not found: ${role_id}`);
    }
  }

  /**
   * 覆盖写入一条技能：载荷、向量、以及 `promoted_from` 列**一起**更新。
   *
   * 列必须跟着载荷走：晋升归属校验（assertPromotedSkillReference）查的是列，幂等键也是列，
   * 只写载荷会让「列说没有来源、载荷说是某条经验」这种分裂状态留在库里，于是完整性判据与
   * 载荷各说各话——按载荷读的内存适配器认这条引用成立，按列读的 PG 认它不成立。
   *
   * 唯一键 (role_id, promoted_from) 靠下面这条部分唯一索引在这次 UPDATE 里兑现：改出来的
   * 来源若与同 role 的另一条技能撞车，Postgres 整条语句失败，行的载荷、向量、列全都停在
   * 改之前，不会留下「列改了、载荷没改」的半截状态。这里把驱动错误换成一句能直接看出
   * 撞在哪儿的说明，与内存适配器报同一件事。
   */
  async updateSkill(role_id: string, skill: SkillRecord): Promise<void> {
    await this.ensureSchema();
    const stored = await this.withDescriptionEmbedding(skill);
    SkillRecordSchema.parse(stored);
    const promotedFrom = stored.promoted_from ?? null;

    try {
      const result = await this.pool.query(
        `UPDATE memory_skills
         SET payload = $3::jsonb, description_embedding = $4::vector, promoted_from = $5
         WHERE role_id = $1 AND id = $2`,
        [
          role_id,
          stored.id,
          JSON.stringify(stored),
          toPgVector(stored.description_embedding),
          promotedFrom,
        ],
      );
      if (result.rowCount === 0) {
        throw new Error(`Skill not found: ${skill.id}`);
      }
    } catch (error) {
      if (!isUniqueViolation(error) || promotedFrom === null) throw error;
      throw new Error(
        `Skill for promoted_from=${promotedFrom} already exists in ${role_id}; ` +
          `skill ${stored.id} was left unchanged.`,
      );
    }
  }

  async updateExperience(role_id: string, experience: ExperienceRecord): Promise<void> {
    await this.ensureSchema();
    const stored = await this.withDescriptionEmbedding(experience);
    ExperienceRecordSchema.parse(stored);

    const result = await this.pool.query(
      `UPDATE memory_experiences
       SET payload = $3::jsonb, description_embedding = $4::vector
       WHERE role_id = $1 AND id = $2`,
      [role_id, stored.id, JSON.stringify(stored), toPgVector(stored.description_embedding)],
    );

    if (result.rowCount === 0) {
      throw new Error(`Experience not found: ${experience.id}`);
    }
  }

  /**
   * 反馈的原子幂等应用（数据库实现）。
   *
   * 与交付存储的 claim 同一手法：**读 → 在内存里算出下一条 → 条件 UPDATE**，条件里带上
   * 读到的那一版（`updated_at` / `confidence` / `referenced_count`）与「这条反馈还没应用过」
   * 的判据。写不进去就说明读之后有人改过这条经验，重读一遍再来；重读时可能发现这条反馈
   * 已经被对端应用（同一条反馈的并发重投），那时如实报 `already_applied`。
   *
   * 幂等判据交给数据库的 jsonb 包含运算（`confidence_history @> [{feedback_id}]`），而不是
   * 「先查再插」——后者在两次往返之间正是两个 worker 会同时通过的地方。任何一次成功写入
   * 都会把 `updated_at` 推到新的时刻，因此乐观锁令牌随之变化，不会出现两次写共用一版的情况。
   *
   * 「推进经验」与「推进聚合根」这两件事必须在**同一个事务**里、并且整段重试循环按 role
   * 串行（见 withRoleLock）：前者是条件写，后者只认「聚合还没被别人推进过」。少了事务，
   * 应用过经验却漏掉均值的那一版永远补不回来；少了串行，进程内两条反馈会各自读到对方的
   * 中间态。跨进程（外部 PostgreSQL）那一侧靠条件写本身成立，与 withRoleLock 的说明一致。
   *
   * 重试不是无上限的：连读好几版都被抢先，说明这条经验正被打字机式地并发回写，与其在这里
   * 转圈，不如把这条反馈还给交付层的退避重试（抛错即由调用方按可重试失败处理）。
   */
  async applyExperienceFeedback(
    role_id: string,
    input: ExperienceFeedbackApplication,
  ): Promise<ExperienceFeedbackResult> {
    await this.ensureSchema();
    await this.requireAgentRow(role_id);

    return this.withRoleLock(role_id, async () => {
      for (let attempt = 0; attempt < EXPERIENCE_FEEDBACK_MAX_CAS_ATTEMPTS; attempt += 1) {
        const applied = await this.applyFeedbackOnce(role_id, input);
        if (applied) return applied;
      }

      throw new Error(
        `Experience ${input.experience_id} kept changing while feedback ${input.feedback_id} was being applied; the delivery will be retried.`,
      );
    });
  }

  /**
   * 一次事务内的尝试：条件写经验 → 按事务内可见的经验集重算均值 → 条件写聚合指标。
   *
   * 返回 undefined 表示这一版被别人抢先（经验或聚合任一没写进去），调用方重读再来；
   * 返回一个结果表示已经定局（写进去了，或者经验缺席 / 这条反馈早就应用过）。
   */
  private async applyFeedbackOnce(
    role_id: string,
    input: ExperienceFeedbackApplication,
  ): Promise<ExperienceFeedbackResult | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await readExperienceRow(client, role_id, input.experience_id);
      if (!current) {
        await client.query('COMMIT');
        return { outcome: 'experience_missing' };
      }
      if (isFeedbackApplied(current, input.feedback_id)) {
        await client.query('COMMIT');
        return { outcome: 'already_applied', experience: current };
      }

      const next = applyFeedbackToExperience(current, input, nowTimestamp());
      const written = await writeExperienceIfUnchanged(
        client,
        role_id,
        current,
        next,
        input.feedback_id,
      );
      if (!written) {
        await client.query('ROLLBACK');
        return undefined;
      }

      // 事务内重读**全部**经验算均值：只有落在这个时刻的集合上，聚合才与经验集合同源
      // （另有一条反馈可能刚提交过另一条经验）。写回聚合同样带条件，见 SQL 常量。
      const experiences = await listExperienceRows(client, role_id);
      const metrics = await readAgentMetrics(client, role_id);
      if (!metrics) throw new Error(`Agent not found: ${role_id}`);

      const synced = await client.query(FEEDBACK_AVG_CONFIDENCE_SQL, [
        role_id,
        String(metrics.avg_confidence),
        averageConfidence(experiences),
      ]);
      if (synced.rowCount === 0) {
        // 聚合被另一次回写推进过：这一版均值已经过时，连同上面的经验写一起退回重来
        await client.query('ROLLBACK');
        return undefined;
      }

      await client.query('COMMIT');
      return { outcome: 'applied', experience: written };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // ── 技能晋升的状态面（Phase 3） ──────────────────────────────────
  //
  // 与交付存储的 claim 同一手法：**读 → 在内存里算出下一条 → 条件 UPDATE**，条件里带上
  // 读到的那一版（晋升标记的 status/attempt_count/claim_token/updated_at，外加经验载荷上
  // 会被别的写路径改动的三个字段）。写不进去就说明读之后有人改过这条经验，返回 undefined
  // 由调用方决定跳过还是稍后再来——绝不「读出来、改一份内存副本、整份覆盖回去」。
  //
  // 条件里为什么要带上 confidence / referenced_count / updated_at：晋升的写回是**整份载荷**，
  // 而反馈回写（applyExperienceFeedback）改的正是这三个。少了它们，一次晋升写回会把并发中
  // 刚应用上去的反馈整份抹掉——而那条反馈的交付可能已被 ack，损失不可追回。

  async listPromotionCandidates(query: PromotionCandidateQuery): Promise<ExperienceRecord[]> {
    await this.ensureSchema();
    const input = promotionCandidateInput(query);
    const candidates: ExperienceRecord[] = [];
    for (const role_id of await this.promotionRoleIds(query.role_id)) {
      candidates.push(...(await this.scanPromotionCandidates(role_id, input)));
    }
    candidates.sort(comparePromotionCandidates);
    return query.limit === undefined ? candidates : candidates.slice(0, Math.max(0, query.limit));
  }

  /**
   * claim 下一条候选：逐条尝试条件写。
   *
   * 「逐条」而不是「取第一条就放弃」的理由与交付侧相同：排在前面的那条可能刚被另一个
   * 进程条件更新走，这不该让整次 claim 空手而归。整个尝试在 role 的临界区里串行
   * （见 withRoleLock），跨进程那一侧靠条件写本身成立。
   */
  async claimNextPromotionCandidate(
    request: PromotionClaimRequest,
  ): Promise<ClaimedPromotionCandidate | undefined> {
    await this.ensureSchema();
    const input = promotionCandidateInput(request);
    const policy = request.policy ?? DEFAULT_PROMOTION_RETRY_POLICY;

    for (const role_id of await this.promotionRoleIds(request.role_id)) {
      const candidates = await this.scanPromotionCandidates(role_id, input);
      for (const candidate of candidates) {
        const written = await this.transitionPromotion(role_id, candidate.id, (current) => {
          // 扫描之后可能已经被别人改过，按重读后的当前版本重算计划
          const plan = planPromotionCandidate(current, input);
          if (plan.kind === 'skip') return undefined;
          const base =
            plan.kind === 'expire_then_claim'
              ? expireDeliveryClaimRecord(current.promotion!, { now: input.now, policy })
              : plan.marker;
          const claimedMarker = claimDeliveryRecord(base, {
            owner: request.owner,
            now: request.now,
            lease_ms: request.lease_ms,
            claim_token: newClaimToken(),
            policy,
          });
          if (claimedMarker) return { ...current, promotion: claimedMarker };
          // 回收之后可能直接进了死信（次数用满），claim 自然拿不到它——把回收结果落下来，
          // 否则这条记录的租约永远停在过期状态，每次扫描都白跑一遍
          return plan.kind === 'expire_then_claim' ? { ...current, promotion: base } : undefined;
        });
        const marker = written?.promotion;
        if (written && marker?.status === 'processing' && marker.claim_token) {
          return {
            role_id,
            experience: written,
            claim_token: marker.claim_token,
            attempt_count: marker.attempt_count,
          };
        }
      }
    }
    return undefined;
  }

  /**
   * 落一条结论（processing → processed）。
   *
   * 与其余状态转移同一条骨架（role 临界区 + 条件写），只是多一条**跨实体引用校验**：
   * `outcome='promoted'` 时 `promoted_to` 指向的技能必须存在、属于本 role、且来源就是这条
   * 经验（判据见 services/promotion-integrity.ts）。校验点刻意放在凭据成立**之后**、写入
   * **之前**：凭据不成立仍然是「这次没轮到我们」（返回 undefined，与既有 fencing 语义一致），
   * 凭据成立才轮得到回答「这条引用成不成立」——不成立就抛，经验一个字节都不动，既没有结论
   * 也没有 promoted_to。
   *
   * 「验过之后技能被删掉/被转走」的窗口由两件事一起关掉：校验跑在 role 临界区之内，且最终
   * 那笔条件写的谓词里带着同一条技能的存在性（`expectedSkillId`）。条件写没写进去时才回头
   * 复查一次——若复查发现引用已经不成立，那是完整性错误，不能伪装成「读到的这一版被别人
   * 改过」那种「这次没轮到我们」。
   *
   * `promoted` 以外的结论不接受技能引用：调用方递来的 `skill_id` 既不进标记、也不进
   * `promoted_to`。
   */
  async completePromotion(
    request: PromotionCompletionRequest,
  ): Promise<ExperienceRecord | undefined> {
    await this.ensureSchema();
    if (request.outcome === 'promoted' && request.skill_id === undefined) {
      throw new Error('completePromotion requires a skill_id when the outcome is "promoted".');
    }
    const promotedTo = request.outcome === 'promoted' ? request.skill_id : undefined;
    return this.transitionPromotion(
      request.role_id,
      request.experience_id,
      async (current) => {
        const marker = current.promotion;
        if (!marker) return undefined;
        const completed = completeDeliveryRecord(
          {
            ...marker,
            outcome: request.outcome,
            strategy_version: request.strategy_version,
            evaluated_at: request.now,
            skill_id: promotedTo,
            reasons: request.reasons,
          },
          {
            ...(request.owner !== undefined ? { owner: request.owner } : {}),
            claim_token: request.claim_token,
            now: request.now,
          },
        );
        if (!completed) return undefined;
        if (promotedTo !== undefined) {
          await this.assertPromotedSkillReference(
            request.role_id,
            request.experience_id,
            promotedTo,
          );
        }
        return {
          ...current,
          promotion: completed,
          // promoted_to 与结论在同一次条件写里落定：读到「Skill 已存在、经验还没绑上」的
          // 中间态，会让人把它当成没晋升过再晋升一次
          ...(promotedTo !== undefined ? { promoted_to: promotedTo } : {}),
        };
      },
      promotedTo,
    );
  }

  async failPromotion(request: PromotionFailureRequest): Promise<ExperienceRecord | undefined> {
    await this.ensureSchema();
    return this.transitionPromotion(request.role_id, request.experience_id, (current) => {
      const marker = current.promotion;
      if (!marker) return undefined;
      const failed = failDeliveryRecord(marker, {
        ...(request.owner !== undefined ? { owner: request.owner } : {}),
        claim_token: request.claim_token,
        now: request.now,
        error: request.error,
        retryable: request.retryable,
        policy: request.policy ?? DEFAULT_PROMOTION_RETRY_POLICY,
      });
      return failed ? { ...current, promotion: failed } : undefined;
    });
  }

  async restoreExpiredPromotionClaims(
    options: PromotionRestoreOptions,
  ): Promise<ExperienceRecord[]> {
    await this.ensureSchema();
    const policy = options.policy ?? DEFAULT_PROMOTION_RETRY_POLICY;
    const restored: ExperienceRecord[] = [];
    for (const role_id of await this.promotionRoleIds(options.role_id)) {
      for (const experience of await this.listPromotionRows(role_id)) {
        const marker = experience.promotion;
        if (!marker || !isDeliveryClaimExpired(marker, options.now)) continue;
        // 在临界区里重读一遍再判过期：列举到写入之间可能有人完成了它，
        // 那时过期判定已不成立，必须放过（否则会把一条已经晋升完的候选重投一次）
        const updated = await this.transitionPromotion(role_id, experience.id, (current) => {
          const currentMarker = current.promotion;
          if (!currentMarker || !isDeliveryClaimExpired(currentMarker, options.now)) return undefined;
          return {
            ...current,
            promotion: expireDeliveryClaimRecord(currentMarker, { now: options.now, policy }),
          };
        });
        if (updated) restored.push(updated);
      }
    }
    return restored;
  }

  async retryDeadLetterPromotion(request: {
    role_id: string;
    experience_id: string;
    now: string;
  }): Promise<ExperienceRecord | undefined> {
    await this.ensureSchema();
    return this.transitionPromotion(request.role_id, request.experience_id, (current) => {
      const marker = current.promotion;
      if (!marker) return undefined;
      const reset = resetDeliveryForRetry(marker, { now: request.now });
      return reset ? { ...current, promotion: reset } : undefined;
    });
  }

  // ── Persona 演化的状态面（Phase 4-B） ──────────────────────────────
  //
  // 与晋升同一套骨架（role 临界区里「读 → 算出下一版 → 条件写」），但状态与 Persona 落在
  // **同一行**（`memory_agents`），因此「凭据仍然成立」与「父版本仍然是当前版本」两道条件
  // 可以在同一条 UPDATE 的谓词里一起成立——不可能出现一个成立一个不成立。这正是把标记放在
  // Agent 记录上带来的红利。

  async getPersonaEvolutionMarker(
    role_id: string,
  ): Promise<PersonaEvolutionMarker | undefined> {
    await this.ensureSchema();
    const result = await this.pool.query<{ persona_evolution: unknown | null }>(
      `SELECT persona_evolution FROM memory_agents WHERE role_id = $1`,
      [role_id],
    );
    const row = result.rows[0];
    if (!row || row.persona_evolution === null || row.persona_evolution === undefined) {
      return undefined;
    }
    return PersonaEvolutionMarkerSchema.parse(row.persona_evolution);
  }

  async claimNextPersonaEvolutionCandidate(
    request: PersonaEvolutionClaimRequest,
  ): Promise<ClaimedPersonaEvolutionCandidate | undefined> {
    await this.ensureSchema();
    // 隐藏的市场池 Agent 已经被 listAgentIds 排除在外——它只是技能的归属容器，不演化
    const roles = request.role_id !== undefined ? [request.role_id] : await this.listAgentIds();
    for (const role_id of roles) {
      const claimed = await this.withRoleLock(role_id, () =>
        this.claimPersonaEvolutionLocked(role_id, request),
      );
      if (claimed) return claimed;
    }
    return undefined;
  }

  async completePersonaEvolution(
    request: PersonaEvolutionCompletionRequest,
  ): Promise<PersonaEvolutionCompletionResult> {
    await this.ensureSchema();
    const evolved = request.outcome === 'evolved';
    if (evolved) {
      const persona = request.persona;
      if (!persona) {
        throw new Error('completePersonaEvolution requires a persona when the outcome is "evolved".');
      }
      // 版本号只能由父版本推出：让调用方自报一个跳版本的值，等于允许它写出一个不属于它的版本
      if (persona.role_id !== request.role_id) {
        throw new Error(
          `completePersonaEvolution received a persona for ${persona.role_id}, not ${request.role_id}.`,
        );
      }
      if (persona.version !== request.parent_version + 1) {
        throw new Error(
          `completePersonaEvolution requires persona version ${String(request.parent_version + 1)} `
            + `(parent ${String(request.parent_version)} + 1); got ${String(persona.version)}.`,
        );
      }
    }

    return this.withRoleLock(request.role_id, async () => {
      const current = await this.readPersonaEvolutionRow(request.role_id);
      const marker = current?.marker;
      if (!current || !marker) return { kind: 'claim_lost' };

      // 凭据先判：不成立就什么都不写，落盘责任归当前持有者
      const settled = completeDeliveryRecord(
        personaEvolutionSettlement(marker, request),
        {
          ...(request.owner !== undefined ? { owner: request.owner } : {}),
          claim_token: request.claim_token,
          now: request.now,
        },
      );
      if (!settled) return { kind: 'claim_lost' };

      const applied = await this.writePersonaEvolutionSettlement(
        request.role_id,
        marker,
        settled,
        evolved
          ? { expected_parent_version: request.parent_version, persona: request.persona! }
          : undefined,
      );
      if (applied.kind === 'applied') {
        return {
          kind: 'applied',
          marker: settled,
          ...(evolved ? { persona: { ...request.persona! } } : {}),
        };
      }
      if (applied.kind === 'parent_conflict') {
        return {
          kind: 'parent_conflict',
          expected_parent_version: request.parent_version,
          current_version: applied.current_version,
        };
      }
      return { kind: 'claim_lost' };
    });
  }

  async failPersonaEvolution(
    request: PersonaEvolutionFailureRequest,
  ): Promise<PersonaEvolutionMarker | undefined> {
    await this.ensureSchema();
    return this.withRoleLock(request.role_id, async () => {
      const current = await this.readPersonaEvolutionRow(request.role_id);
      const marker = current?.marker;
      if (!marker) return undefined;

      const failed = failDeliveryRecord(marker, {
        ...(request.owner !== undefined ? { owner: request.owner } : {}),
        claim_token: request.claim_token,
        error: request.error,
        retryable: request.retryable,
        now: request.now,
        policy: request.policy ?? DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY,
      });
      if (!failed) return undefined;

      const written = await this.writePersonaEvolutionMarkerIfUnchanged(
        request.role_id,
        marker,
        failed,
      );
      return written ? failed : undefined;
    });
  }

  async restoreExpiredPersonaEvolutionClaims(
    options: PersonaEvolutionRestoreOptions,
  ): Promise<RestoredPersonaEvolutionClaim[]> {
    await this.ensureSchema();
    const policy = options.policy ?? DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY;
    const roles = options.role_id !== undefined ? [options.role_id] : await this.listAgentIds();
    const restored: RestoredPersonaEvolutionClaim[] = [];

    for (const role_id of roles) {
      // 每一条都在自己的临界区里重新判一次过期：列举之后已经被别人完成的候选不会被重投
      const entry = await this.withRoleLock(role_id, async () => {
        const current = await this.readPersonaEvolutionRow(role_id);
        const marker = current?.marker;
        if (!marker || !isDeliveryClaimExpired(marker, options.now)) return undefined;
        const updated = expireDeliveryClaimRecord(marker, { now: options.now, policy });
        const written = await this.writePersonaEvolutionMarkerIfUnchanged(role_id, marker, updated);
        return written ? { role_id, marker: updated } : undefined;
      });
      if (entry) restored.push(entry);
    }
    return restored;
  }

  async retryDeadLetterPersonaEvolution(request: {
    role_id: string;
    now: string;
  }): Promise<PersonaEvolutionMarker | undefined> {
    await this.ensureSchema();
    return this.withRoleLock(request.role_id, async () => {
      const current = await this.readPersonaEvolutionRow(request.role_id);
      const marker = current?.marker;
      if (!marker) return undefined;

      const reset = resetDeliveryForRetry(marker, { now: request.now });
      if (!reset) return undefined;

      const written = await this.writePersonaEvolutionMarkerIfUnchanged(
        request.role_id,
        marker,
        reset,
      );
      return written ? reset : undefined;
    });
  }

  /** 读一个角色的演化状态（Persona 与标记）。Agent 不存在时返回 undefined */
  private async readPersonaEvolutionRow(role_id: string): Promise<
    | {
        persona: PersonaDef;
        marker?: PersonaEvolutionMarker | undefined;
      }
    | undefined
  > {
    const result = await this.pool.query<{ persona: unknown; persona_evolution: unknown | null }>(
      `SELECT persona, persona_evolution FROM memory_agents WHERE role_id = $1`,
      [role_id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      persona: PersonaDefSchema.parse(row.persona),
      ...(row.persona_evolution === null || row.persona_evolution === undefined
        ? {}
        : { marker: PersonaEvolutionMarkerSchema.parse(row.persona_evolution) }),
    };
  }

  /**
   * 一个角色的一次 claim。**整段在 role 临界区里**：读 Persona、技能、经验，算快照与 hash，
   * 判计划，条件写标记——因此「据以判定的那份输入」与「据此写下的租约」来自同一次读。
   *
   * 已知的窗口（与晋升的执行内核同类，且同样自愈）：快照是从 `memory_skills` /
   * `memory_experiences` 两张表读出来的，跨进程的并发写入不在 role 临界区的保护范围内。
   * 若在读与写之间落下一条新经验，标记记下的 hash 就比库里的现状旧一版。后果是下一次运行
   * 会算出另一个 hash 并重新评估——判定与它记下的 hash 始终一致（两者都来自这一次读），
   * 因此不会出现「按旧快照判、按新快照记」这种自相矛盾的记录。
   */
  private async claimPersonaEvolutionLocked(
    role_id: string,
    request: PersonaEvolutionClaimRequest,
  ): Promise<ClaimedPersonaEvolutionCandidate | undefined> {
    const current = await this.readPersonaEvolutionRow(role_id);
    if (!current) return undefined;

    const [skills, experiences] = await Promise.all([
      this.listSkills(role_id),
      this.listExperiences(role_id),
    ]);
    const snapshot = buildPersonaEvolutionSnapshot({ role_id, skills, experiences });
    const input_snapshot_hash = personaEvolutionInputSnapshotHash(snapshot);
    const policy = request.policy ?? DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY;

    const plan = planPersonaEvolutionCandidate(current.marker, {
      now: request.now,
      strategy_version: request.strategy_version,
      approval: request.approval,
      input_snapshot_hash,
      policy,
    });
    if (plan.kind === 'skip') return undefined;

    const marker =
      plan.kind === 'expire_then_claim'
        ? expireDeliveryClaimRecord(current.marker!, { now: request.now, policy })
        : plan.marker;

    const claimed = claimDeliveryRecord(marker, {
      owner: request.owner,
      now: request.now,
      lease_ms: request.lease_ms,
      claim_token: newClaimToken(),
      policy,
    });
    if (!claimed) {
      // 回收之后可能直接进了死信（次数用满），claim 自然拿不到它——把回收结果写回去，
      // 否则这条标记的租约永远停在过期状态，每次扫描都白跑一遍
      if (plan.kind === 'expire_then_claim') {
        await this.writePersonaEvolutionMarkerIfUnchanged(role_id, current.marker!, marker);
      }
      return undefined;
    }

    const written = await this.writePersonaEvolutionMarkerIfUnchanged(
      role_id,
      current.marker,
      claimed,
    );
    if (!written) return undefined;

    return {
      role_id,
      marker: claimed,
      claim_token: claimed.claim_token!,
      attempt_count: claimed.attempt_count,
      persona: current.persona,
      snapshot,
      input_snapshot_hash,
    };
  }

  /**
   * 只写标记的条件写（claim / fail / 回收 / 人工重试都走它）。
   *
   * 谓词带的是**读到的这一版标记**（四个字段，全为 NULL 时要求这一行压根没有标记），因此
   * 跨进程的并发抢写只有一个能成功——这正是「两个 worker 并发 claim 同一角色只有一个拿到」
   * 在数据库上的落点。`current` 为 undefined 表示「读的时候还没有标记」。
   */
  private async writePersonaEvolutionMarkerIfUnchanged(
    role_id: string,
    current: PersonaEvolutionMarker | undefined,
    next: PersonaEvolutionMarker,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE memory_agents
       SET persona_evolution = $2::jsonb
       WHERE role_id = $1
         AND persona_evolution->>'status' IS NOT DISTINCT FROM $3
         AND persona_evolution->>'attempt_count' IS NOT DISTINCT FROM $4
         AND persona_evolution->>'claim_token' IS NOT DISTINCT FROM $5
         AND persona_evolution->>'updated_at' IS NOT DISTINCT FROM $6`,
      [
        role_id,
        JSON.stringify(next),
        current?.status ?? null,
        current === undefined ? null : String(current.attempt_count),
        current?.claim_token ?? null,
        current?.updated_at ?? null,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * 落一条结论的条件写。凭据与父版本两道条件在**同一条 UPDATE** 里成立。
   *
   * `handle` 用 `jsonb_set` 就地合并 `persona` 一个键，而不是整份覆盖：handle 里还嵌着
   * 技能计数、经验计数与指标快照，那些字段会被别的操作（晋升、反馈归并、任务收尾）独立推进。
   * 拿着 claim 那一刻读到的副本整份写回，等于把中间发生的每一次推进都回滚掉——这类丢更新
   * 在测试里几乎撞不上，在生产上表现为「技能数莫名其妙少了几个」。
   *
   * 谓词不成立时无法从 rowCount 区分是哪一道条件挡住的，因此重读一次那一行：父版本对不上
   * 就是**判定过期**（`parent_conflict`，可重投），否则是**凭据失效**（`claim_lost`）。
   * 这个区分不是细节：前者要重新读、重新判，后者说明这次压根没轮到我们。
   */
  private async writePersonaEvolutionSettlement(
    role_id: string,
    current: PersonaEvolutionMarker,
    next: PersonaEvolutionMarker,
    evolved: { expected_parent_version: number; persona: PersonaDef } | undefined,
  ): Promise<
    { kind: 'applied' } | { kind: 'claim_lost' } | { kind: 'parent_conflict'; current_version: number }
  > {
    const guard = [
      role_id,
      current.status,
      String(current.attempt_count),
      current.claim_token ?? null,
      current.updated_at,
    ];
    const result =
      evolved === undefined
        ? await this.pool.query(
            `UPDATE memory_agents
             SET persona_evolution = $2::jsonb
             WHERE role_id = $1
               AND persona_evolution->>'status' IS NOT DISTINCT FROM $3
               AND persona_evolution->>'attempt_count' IS NOT DISTINCT FROM $4
               AND persona_evolution->>'claim_token' IS NOT DISTINCT FROM $5
               AND persona_evolution->>'updated_at' IS NOT DISTINCT FROM $6`,
            [guard[0], JSON.stringify(next), guard[1], guard[2], guard[3], guard[4]],
          )
        : await this.pool.query(
            `UPDATE memory_agents
             SET persona = $2::jsonb,
                 handle = jsonb_set(handle, '{persona}', $2::jsonb),
                 persona_evolution = $3::jsonb
             WHERE role_id = $1
               AND (persona->>'version')::int = $4
               AND persona_evolution->>'status' IS NOT DISTINCT FROM $5
               AND persona_evolution->>'attempt_count' IS NOT DISTINCT FROM $6
               AND persona_evolution->>'claim_token' IS NOT DISTINCT FROM $7
               AND persona_evolution->>'updated_at' IS NOT DISTINCT FROM $8`,
            [
              guard[0],
              JSON.stringify(evolved.persona),
              JSON.stringify(next),
              String(evolved.expected_parent_version),
              guard[1],
              guard[2],
              guard[3],
              guard[4],
            ],
          );

    if ((result.rowCount ?? 0) > 0) return { kind: 'applied' };
    if (evolved === undefined) return { kind: 'claim_lost' };

    // 两道条件里到底是哪一道挡住的：重读一次当前版本，父版本对不上就是判定过期。
    // 判据取自 4-A 的 `resolvePersonaEvolutionWrite`——与内存实现、与 4-A 的单测共用同一份
    // 定义，因此「什么时候算冲突」不可能在两个后端之间漂移。
    const reread = await this.readPersonaEvolutionRow(role_id);
    if (reread) {
      const resolution = resolvePersonaEvolutionWrite({
        parent_version: evolved.expected_parent_version,
        current_version: reread.persona.version,
      });
      if (resolution.kind === 'conflict') {
        return { kind: 'parent_conflict', current_version: resolution.current_version };
      }
    }
    return { kind: 'claim_lost' };
  }

  /**
   * 促进晋升状态转移的公共骨架：role 临界区里「读 → 算出下一版 → 条件写」，转移函数返回
   * undefined 就什么都不写。
   *
   * `apply` 允许是异步的：`completePromotion` 要在「凭据已成立、载荷还没写」之间再查一次
   * 技能归属（见该方法）。这中间多出来的 await 不会削弱条件写的乐观并发——写下去的谓词
   * 带的是**读到的这一版**，等待期间有人改过就写不进去，与同步回调是同一种结果。
   *
   * `expectedSkillId` 是可选的外部引用守卫：给了它，条件写的谓词里就多一条「这条技能仍然
   * 存在、仍属于本 role、来源仍是这条经验」，因此不存在「刚验过就被删掉/被转走」的窗口。
   */
  private async transitionPromotion(
    role_id: string,
    experience_id: string,
    apply: (
      current: ExperienceRecord,
    ) => ExperienceRecord | undefined | Promise<ExperienceRecord | undefined>,
    expectedSkillId?: string,
  ): Promise<ExperienceRecord | undefined> {
    return this.withRoleLock(role_id, async () => {
      const current = await this.readPromotionRow(role_id, experience_id);
      if (!current) return undefined;
      const next = await apply(current);
      if (!next) return undefined;
      const written = await this.writePromotionIfUnchanged(role_id, current, next, expectedSkillId);
      if (written) return written;
      // 条件写不进去有两种原因：读到的这一版经验被别人改过（凭据/载荷/聚合字段），那是
      // 「这次没轮到我们」，返回 undefined 由调用方决定；或者刚验过的技能在写之前消失/
      // 被转走了（校验之后到写入之间只有别的进程能插进来），那是完整性错误，不能伪装成
      // 前一种让调用方以为稍后重试就轮得到它。
      if (expectedSkillId !== undefined) {
        await this.assertPromotedSkillReference(role_id, experience_id, expectedSkillId);
      }
      return undefined;
    });
  }

  /**
   * 校验「这条经验要指向的那条技能」确实存在、确实属于这个 role、且来源就是这条经验。
   *
   * 按 id 单独查（不带 role 条件）是刻意的：**跨 role 引用**与**根本不存在**是两种不同的
   * 完整性错误，带上 role 条件就会把前者读成后者，排查的人于是在「技能没了」这条错路上找。
   * 归属判据本身在 services/promotion-integrity.ts（与内存适配器共用一份）。
   *
   * 查的是 `promoted_from` 列而不是载荷里的同名字段：完整性判据必须与幂等键同源，否则两者
   * 可以各说各话。
   */
  private async assertPromotedSkillReference(
    role_id: string,
    experience_id: string,
    skill_id: string,
  ): Promise<void> {
    assertPromotedSkillReference(
      { role_id, experience_id, skill_id },
      await this.readSkillFactsById(skill_id),
    );
  }

  /**
   * 读出一条技能与归属校验有关的事实；查不到（或 id 根本不是 uuid）返回 undefined。
   *
   * 形状判断不是多余的谨慎：`id = $1::uuid` 碰到非 uuid 文本时 Postgres 直接报
   * `22P02 invalid_text_representation`，那会被通用分类读成「认不出来的失败」而白重投。
   * 「格式不对」与「不存在」对调用方是同一个结论——这条引用成不成立都一样——所以合并。
   */
  private async readSkillFactsById(skill_id: string): Promise<PromotedSkillFacts | undefined> {
    if (!UUID_PATTERN.test(skill_id)) return undefined;
    const result = await this.pool.query<{ role_id: string; promoted_from: string | null }>(
      `SELECT role_id, promoted_from FROM memory_skills WHERE id = $1::uuid`,
      [skill_id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      role_id: row.role_id,
      promoted_from: row.promoted_from ?? undefined,
    };
  }

  private async readPromotionRow(
    role_id: string,
    experience_id: string,
  ): Promise<ExperienceRecord | undefined> {
    const result = await this.pool.query<{ payload: unknown }>(
      `SELECT payload FROM memory_experiences WHERE role_id = $1 AND id = $2`,
      [role_id, experience_id],
    );
    const row = result.rows[0];
    return row ? ExperienceRecordSchema.parse(row.payload) : undefined;
  }

  /**
   * 条件写回经验的载荷（描述没变，因此**不动** description_embedding 列）。
   *
   * 谓词分两段：前四个定位「读到的这一版晋升标记」（四者都为 NULL 时要求这条经验压根
   * 还没有晋升标记），后三个挡住「读之后有别的写路径改过这条经验」——晋升写回的是整份
   * 载荷，少了后三个就会把并发中刚应用上去的反馈整份抹掉。
   *
   * `expectedSkillId` 给了就再加一段：这条技能仍然存在、仍属于本 role、来源仍是这条经验。
   * 这条引用是跨表的，`SELECT` 与 `UPDATE` 之间能插进来的只有别的进程（role 临界区管不到
   * 它），所以判据必须**作为写入谓词出现**，而不是只在写之前查一次——否则技能刚被删掉/被
   * 转移，引用照样落库，`promoted_to` 就成了指向别人的指针。
   */
  private async writePromotionIfUnchanged(
    role_id: string,
    current: ExperienceRecord,
    next: ExperienceRecord,
    expectedSkillId?: string,
  ): Promise<ExperienceRecord | undefined> {
    const marker = current.promotion;
    // $11 只可能来自 completePromotion：它在走到这里之前已经按 UUID_PATTERN 判过形状
    // （见 readSkillFactsById），因此 ::uuid 转换没有报 22P02 的机会。$2 是刚刚 SELECT
    // 到的经验 id，本来就是 uuid。
    const skillGuard =
      expectedSkillId === undefined
        ? ''
        : `
         AND EXISTS (
           SELECT 1 FROM memory_skills AS guarded
           WHERE guarded.id = $11::uuid
             AND guarded.role_id = $1
             AND guarded.promoted_from = $2::uuid
         )`;
    const params = [
      role_id,
      current.id,
      JSON.stringify(next),
      marker?.status ?? null,
      marker === undefined ? null : String(marker.attempt_count),
      marker?.claim_token ?? null,
      marker?.updated_at ?? null,
      current.updated_at,
      String(current.confidence),
      String(current.referenced_count),
    ];
    if (expectedSkillId !== undefined) params.push(expectedSkillId);
    const result = await this.pool.query<{ payload: unknown }>(
      `UPDATE memory_experiences
       SET payload = $3::jsonb
       WHERE role_id = $1 AND id = $2
         AND payload->'promotion'->>'status' IS NOT DISTINCT FROM $4
         AND payload->'promotion'->>'attempt_count' IS NOT DISTINCT FROM $5
         AND payload->'promotion'->>'claim_token' IS NOT DISTINCT FROM $6
         AND payload->'promotion'->>'updated_at' IS NOT DISTINCT FROM $7
         AND payload->>'updated_at' = $8
         AND payload->>'confidence' = $9
         AND payload->>'referenced_count' = $10${skillGuard}
       RETURNING payload`,
      params,
    );
    const row = result.rows[0];
    return row ? ExperienceRecordSchema.parse(row.payload) : undefined;
  }

  /** 扫描范围：给了 role 就只扫它，否则扫全部（隐藏的市场池 Agent 不算） */
  private async promotionRoleIds(role_id: string | undefined): Promise<string[]> {
    return role_id !== undefined ? [role_id] : this.listAgentIds();
  }

  /** 一次扫描的候选（过滤与排序都在共享规则里，SQL 只负责取数） */
  private async scanPromotionCandidates(
    role_id: string,
    input: PromotionCandidateInput,
  ): Promise<ExperienceRecord[]> {
    return selectPromotionCandidates(await this.listPromotionRows(role_id), input);
  }

  /**
   * 该 role 的全部经验（扫描面）。
   *
   * 读不懂的载荷**抛出**而不是跳过：一条坏记录悄悄消失会让「这条经验为什么一直没被晋升」
   * 无从回答，而抛错至少把它写进 run 的失败原因里（交付侧的「损坏记录不拦住列表」是另一种
   * 取舍——那里的记录是上游投进来的，这里是自己的记忆实体）。
   */
  private async listPromotionRows(role_id: string): Promise<ExperienceRecord[]> {
    const result = await this.pool.query<{ id: string; payload: unknown }>(
      `SELECT id, payload FROM memory_experiences
       WHERE role_id = $1
       ORDER BY payload->>'created_at' ASC, id ASC`,
      [role_id],
    );
    return result.rows.map((row) => {
      try {
        return ExperienceRecordSchema.parse(row.payload);
      } catch (error) {
        throw new Error(
          `Experience ${row.id} of ${role_id} could not be read for promotion: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  }

  async updateSkillEmbedding(role_id: string, skill_id: string, embedding: number[]): Promise<void> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE memory_skills
       SET payload = jsonb_set(payload, '{description_embedding}', $3::jsonb),
           description_embedding = $4::vector
       WHERE role_id = $1 AND id = $2`,
      [role_id, skill_id, JSON.stringify(embedding), toPgVector(embedding)],
    );

    if (result.rowCount === 0) {
      throw new Error(`Skill not found: ${skill_id}`);
    }
  }

  async updateExperienceEmbedding(
    role_id: string,
    experience_id: string,
    embedding: number[],
  ): Promise<void> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE memory_experiences
       SET payload = jsonb_set(payload, '{description_embedding}', $3::jsonb),
           description_embedding = $4::vector
       WHERE role_id = $1 AND id = $2`,
      [role_id, experience_id, JSON.stringify(embedding), toPgVector(embedding)],
    );

    if (result.rowCount === 0) {
      throw new Error(`Experience not found: ${experience_id}`);
    }
  }

  async deleteSkill(role_id: string, skill_id: string): Promise<void> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `DELETE FROM memory_skills WHERE role_id = $1 AND id = $2`,
      [role_id, skill_id],
    );
    if (result.rowCount === 0) {
      throw new Error(`Skill not found: ${skill_id}`);
    }
    await this.syncCounts(role_id);
  }

  async deleteExperience(role_id: string, experience_id: string): Promise<void> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `DELETE FROM memory_experiences WHERE role_id = $1 AND id = $2`,
      [role_id, experience_id],
    );
    if (result.rowCount === 0) {
      throw new Error(`Experience not found: ${experience_id}`);
    }
    await this.syncCounts(role_id);
  }

  async updateMetrics(
    role_id: string,
    update: (current: AgentMetrics) => AgentMetrics,
  ): Promise<void> {
    await this.ensureSchema();
    const current = await this.getMetrics(role_id);
    const next = update(current);
    AgentMetricsSchema.parse(next);
    const handle = await this.getAgent(role_id);
    const nextHandle = { ...handle, metric: next };

    const result = await this.pool.query(
      `UPDATE memory_agents
       SET metrics = $2::jsonb, handle = $3::jsonb
       WHERE role_id = $1`,
      [role_id, JSON.stringify(next), JSON.stringify(nextHandle)],
    );
    if (result.rowCount === 0) {
      throw new Error(`Agent not found: ${role_id}`);
    }
  }

  async updateAgentStatus(
    role_id: string,
    status: AgentStatus,
    options?: { retired_at?: string; retired_reason?: RetiredReason },
  ): Promise<void> {
    await this.ensureSchema();
    const handle = await this.getAgent(role_id);
    const nextHandle = {
      ...handle,
      status,
      ...(options?.retired_at !== undefined ? { retired_at: options.retired_at } : {}),
      ...(options?.retired_reason !== undefined
        ? { retired_reason: options.retired_reason }
        : {}),
    };
    AgentHandleSchema.parse(nextHandle);

    const result = await this.pool.query(
      `UPDATE memory_agents
       SET handle = $2::jsonb
       WHERE role_id = $1`,
      [role_id, JSON.stringify(nextHandle)],
    );
    if (result.rowCount === 0) {
      throw new Error(`Agent not found: ${role_id}`);
    }
  }

  /** 删除技能/经验后，同步 handle 与 metrics 中的计数（只读重算后写回） */
  private async syncCounts(role_id: string): Promise<void> {
    const [skills, experiences, handle, metrics] = await Promise.all([
      this.listSkills(role_id),
      this.listExperiences(role_id),
      this.getAgent(role_id),
      this.getMetrics(role_id),
    ]);
    const nextHandle: AgentHandle = {
      ...handle,
      skill_count: skills.length,
      experience_count: experiences.length,
      owned_skills: skills.map((skill) => skill.id),
      owned_exps: experiences.map((experience) => experience.id),
    };
    const nextMetrics: AgentMetrics = {
      ...metrics,
      skill_count: skills.length,
      experience_count: experiences.length,
    };
    await this.pool.query(
      `UPDATE memory_agents SET handle = $2::jsonb, metrics = $3::jsonb WHERE role_id = $1`,
      [role_id, JSON.stringify(nextHandle), JSON.stringify(nextMetrics)],
    );
  }

  private async ensureSchema(): Promise<void> {
    if (!this.autoMigrate) {
      return;
    }
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        await ensurePgMemorySchema(this.pool, this.embedding.dimensions);
        await this.migrateVectorColumnDimensions(this.embedding.dimensions);
      })();
    }
    await this.schemaReady;
  }

  /**
   * 切换 embedding 模型后，存量 vector(N) 列维度与当前 provider 不一致：
   * CREATE TABLE IF NOT EXISTS 不会改已有列。pgvector 的 vector 类型转换不允许
   * 改变维度（cast 直接报 "expected N dimensions, not M"），因此 DROP + ADD
   * 重建列；存量向量随列删除，由 memory.reindex 从载荷 JSON 重算回填
   * （重算前该列对旧行为 NULL，向量检索自然召回为空）。
   * 幂等：列维度一致时跳过。
   */
  private async migrateVectorColumnDimensions(dimensions: number): Promise<void> {
    for (const table of ['memory_skills', 'memory_experiences']) {
      const current = await readVectorColumnDimensions(this.pool, table);
      if (current !== undefined && current !== dimensions) {
        await this.pool.query(
          `ALTER TABLE ${table}
           DROP COLUMN description_embedding,
           ADD COLUMN description_embedding vector(${dimensions})`,
        );
      }
    }
  }

  private async requireAgentRow(role_id: string): Promise<{
    handle: unknown;
    persona: unknown;
    metrics: unknown;
  }> {
    const result = await this.pool.query<{ handle: unknown; persona: unknown; metrics: unknown }>(
      'SELECT handle, persona, metrics FROM memory_agents WHERE role_id = $1',
      [role_id],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Agent not found: ${role_id}`);
    }
    return row;
  }

  /**
   * 同一 role 上的写操作排队执行（按调用顺序串成一条链，先到先得）。
   *
   * 为什么需要它：生产默认走 PGlite，而 PGlite 只有一个连接——`connect()` 交回的是同一个
   * 会话，两个 worker 的 BEGIN/COMMIT 会互相插进对方的事务里，「插入 + 聚合根更新」这种
   * 多语句事务因此不是隔离边界。进程内按 role 串行化之后，事务边界才真正成立，插入与
   * 计数才能同生共死（见 insertExperienceRow / insertSkillRow）。
   *
   * 跨进程那一侧（外部 PostgreSQL）不靠这把锁：计数与 owned_* 的更新本身就是数据库侧对
   * 当前行的原子增量，即使两个调用方各在一条连接上也读不到对方的旧快照。
   */
  private async withRoleLock<T>(role_id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.roleQueues.get(role_id) ?? Promise.resolve();
    const running = previous.then(operation, operation);
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    this.roleQueues.set(role_id, settled);
    void settled.then(() => {
      if (this.roleQueues.get(role_id) === settled) this.roleQueues.delete(role_id);
    });
    return running;
  }

  private async withDescriptionEmbedding<T extends SkillRecord | ExperienceRecord>(
    record: T,
  ): Promise<T> {
    if (record.description_embedding.length === this.embedding.dimensions) {
      return record;
    }
    return {
      ...record,
      description_embedding: await this.embedding.embed(record.description),
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === '23505'
  );
}

/**
 * uuid 的形状判据（`memory_skills.id` 是 uuid 列）。
 *
 * 用处只有一个：把「不是 uuid」的引用挡在 `::uuid` 转换之前，让它以「不存在」的结论落在
 * 完整性错误上，而不是让 Postgres 报 22P02、被通用分类读成可重试的下游故障。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ═══════════════════════════════════════════
//  反馈应用的事务内读写（都走同一个 client）
// ═══════════════════════════════════════════

/**
 * 按 role + 主键读一条经验。
 *
 * 走调用方给的 client 而不是池：这几段读写必须落在同一个事务、同一条连接上，中间不能被
 * 别的语句插进来（PGlite 只有一个连接，混用池与 client 就等于把事务拆散）。
 */
async function readExperienceRow(
  client: SqlClient,
  role_id: string,
  experience_id: string,
): Promise<ExperienceRecord | undefined> {
  // 形状不对的 id 不可能在库里存在，先判掉：直接拿去比 uuid 列会抛 22P02，端口承诺的
  // experience_missing 因此永远走不到，异常还会被分类器当成瞬时故障反复重试。同一个输入
  // 在 InMemory 腿返回 missing、在这里抛错，正是契约分歧——判据与内存腿一致：查不到就是没有。
  if (!canNameExperience(experience_id)) return undefined;
  const result = await client.query<{ payload: unknown }>(
    `SELECT payload FROM memory_experiences WHERE role_id = $1 AND id = $2`,
    [role_id, experience_id],
  );
  const row = result.rows[0];
  return row ? ExperienceRecordSchema.parse(row.payload) : undefined;
}

/** 事务内读该 role 的全部经验（算聚合均值的那一份集合） */
async function listExperienceRows(client: SqlClient, role_id: string): Promise<ExperienceRecord[]> {
  const result = await client.query<{ payload: unknown }>(
    `SELECT payload FROM memory_experiences WHERE role_id = $1 ORDER BY payload->>'created_at' ASC`,
    [role_id],
  );
  return result.rows.map((row) => ExperienceRecordSchema.parse(row.payload));
}

/** 事务内读聚合指标（只取条件写需要的那一版 `avg_confidence`，其余字段不动） */
async function readAgentMetrics(
  client: SqlClient,
  role_id: string,
): Promise<AgentMetrics | undefined> {
  const result = await client.query<{ metrics: unknown }>(
    'SELECT metrics FROM memory_agents WHERE role_id = $1',
    [role_id],
  );
  const row = result.rows[0];
  return row ? AgentMetricsSchema.parse(row.metrics) : undefined;
}

/**
 * 条件写回经验的载荷（描述没变，因此**不动** description_embedding 列）。
 *
 * 条件里的四个值合起来是这一版的乐观锁令牌：任一被改过就写不进去，返回 undefined。
 * 返回写回之后的载荷（数据库侧真正落地的那一份），调用方据此报「已应用」。
 */
async function writeExperienceIfUnchanged(
  client: SqlClient,
  role_id: string,
  current: ExperienceRecord,
  next: ExperienceRecord,
  feedback_id: string,
): Promise<ExperienceRecord | undefined> {
  const result = await client.query<{ payload: unknown }>(
    `UPDATE memory_experiences
     SET payload = $3::jsonb
     WHERE role_id = $1 AND id = $2
       AND payload->>'updated_at' = $4
       AND payload->>'confidence' = $5
       AND payload->>'referenced_count' = $6
       AND NOT (payload -> 'confidence_history' @> $7::jsonb)
     RETURNING payload`,
    [
      role_id,
      current.id,
      JSON.stringify(next),
      current.updated_at,
      String(current.confidence),
      String(current.referenced_count),
      JSON.stringify([{ feedback_id }]),
    ],
  );
  const row = result.rows[0];
  return row ? ExperienceRecordSchema.parse(row.payload) : undefined;
}

/** 把扫描/claim 需要的语义参数收敛成一份（端口上的 Query 与 Request 都带这几个字段） */
function promotionCandidateInput(source: {
  now: string;
  strategy_version: string;
  approval: PromotionApprovalMode;
  policy?: DeliveryRetryPolicy;
}): PromotionCandidateInput {
  return {
    now: source.now,
    strategy_version: source.strategy_version,
    approval: source.approval,
    ...(source.policy !== undefined ? { policy: source.policy } : {}),
  };
}
