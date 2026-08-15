/**
 * PgMemoryRepository — MemoryRepository PostgreSQL + pgvector 适配器
 *
 * 长期记忆（Persona / Skills / Experiences）落盘至 PostgreSQL；
 * description_embedding 使用 pgvector 做余弦相似度 top-K 检索。
 * Buffer 队列见 BufferRepository。
 * 只依赖最小 SqlPool 接口，pg.Pool（外部 PostgreSQL）与 PGlitePool（嵌入式）
 * 均可注入；SQL 与 pgvector 语义完全一致。
 */
import type { SqlPool } from '../ports/sql-pool';
import {
  AgentHandleSchema,
  AgentMetricsSchema,
  ExperienceRecordSchema,
  PersonaDefSchema,
  SkillRecordSchema,
  type AgentHandle,
  type AgentMetrics,
  type CreateAgentSpec,
  type ExperienceRecord,
  type PersonaDef,
  type SkillRecord,
} from '../schemas';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { MemoryRepository, MemoryVectorSearchOptions } from '../ports/memory-repository';
import { defaultHashEmbeddingProvider } from './hash-embedding-provider';
import {
  createSeedHandle,
  createSeedMetrics,
  createSeedPersona,
  DEFAULT_MIN_EXPERIENCE_CONFIDENCE,
  DEFAULT_MIN_SIMILARITY,
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

export class PgMemoryRepository implements MemoryRepository {
  private readonly pool: SqlPool;
  private readonly embedding: EmbeddingProvider;
  private readonly autoMigrate: boolean;
  private schemaReady: Promise<void> | undefined;

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
      'SELECT role_id FROM memory_agents ORDER BY role_id',
    );
    return result.rows.map((row) => row.role_id);
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

  async saveExperience(role_id: string, experience: ExperienceRecord): Promise<void> {
    await this.ensureSchema();
    const stored = await this.withDescriptionEmbedding(experience);
    ExperienceRecordSchema.parse(stored);

    const handle = await this.getAgent(role_id);
    const metrics = await this.getMetrics(role_id);

    handle.experience_count += 1;
    handle.owned_exps.push(stored.id);
    metrics.experience_count += 1;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO memory_experiences (id, role_id, payload, description_embedding)
         VALUES ($1, $2, $3::jsonb, $4::vector)`,
        [stored.id, role_id, JSON.stringify(stored), toPgVector(stored.description_embedding)],
      );
      await client.query(
        `UPDATE memory_agents
         SET handle = $2::jsonb, metrics = $3::jsonb
         WHERE role_id = $1`,
        [role_id, JSON.stringify(handle), JSON.stringify(metrics)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveSkill(role_id: string, skill: SkillRecord): Promise<void> {
    await this.ensureSchema();
    const stored = await this.withDescriptionEmbedding(skill);
    SkillRecordSchema.parse(stored);

    const handle = await this.getAgent(role_id);
    const metrics = await this.getMetrics(role_id);

    handle.skill_count += 1;
    handle.owned_skills.push(stored.id);
    metrics.skill_count += 1;
    metrics.promoted_skill_count += 1;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO memory_skills (id, role_id, payload, description_embedding)
         VALUES ($1, $2, $3::jsonb, $4::vector)`,
        [stored.id, role_id, JSON.stringify(stored), toPgVector(stored.description_embedding)],
      );
      await client.query(
        `UPDATE memory_agents
         SET handle = $2::jsonb, metrics = $3::jsonb
         WHERE role_id = $1`,
        [role_id, JSON.stringify(handle), JSON.stringify(metrics)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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

  async updateSkill(role_id: string, skill: SkillRecord): Promise<void> {
    await this.ensureSchema();
    const stored = await this.withDescriptionEmbedding(skill);
    SkillRecordSchema.parse(stored);

    const result = await this.pool.query(
      `UPDATE memory_skills
       SET payload = $3::jsonb, description_embedding = $4::vector
       WHERE role_id = $1 AND id = $2`,
      [role_id, stored.id, JSON.stringify(stored), toPgVector(stored.description_embedding)],
    );

    if (result.rowCount === 0) {
      throw new Error(`Skill not found: ${skill.id}`);
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

  private async ensureSchema(): Promise<void> {
    if (!this.autoMigrate) {
      return;
    }
    if (!this.schemaReady) {
      this.schemaReady = ensurePgMemorySchema(this.pool, this.embedding.dimensions);
    }
    await this.schemaReady;
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
