/**
 * MemoryReindex（memory.reindex：切换 embedding 模型后全量重建向量索引）测试
 *
 * 验证：
 *   1. 维度不匹配时默认重算（模型切换后旧维度向量全部重算为新维度）
 *   2. 幂等：维度已匹配时默认跳过（重跑便宜）
 *   3. force=true 无条件重算（同维度换模型场景）
 *   4. 单 Agent 作用域：只重建指定 role_id；不存在的 role_id 抛错
 *   5. 全量重建包含市场池（__market__）技能（marketSearch 同样依赖向量）
 *   6. 直写向量不经仓库 withDescriptionEmbedding 守卫（不被旧 provider 二次 embed）
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { reindexMemory } from '../services/memory-reindex';
import { MARKET_POOL_ROLE_ID, type ExperienceRecord, type SkillRecord } from '../schemas';

function skill(agentId: string, description: string): SkillRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description,
    description_embedding: [],
    content: `Content for ${description}`,
    version: '1.0.0',
    review_status: 'approved',
    tags: ['typescript'],
    promoted_at: now,
    agent_id: agentId,
    created_at: now,
    updated_at: now,
  };
}

function experience(agentId: string, description: string): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description,
    description_embedding: [],
    content: `Content for ${description}`,
    confidence: 0.7,
    tags: ['typescript'],
    agent_id: agentId,
    confidence_history: [],
    referenced_count: 0,
    source_task_id: 'task_1',
    source_driver: 'test-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
  };
}

async function seedAgent(
  repository: InMemoryRepository,
  roleId: string,
): Promise<{ skillId: string; experienceId: string }> {
  await repository.initializeAgent({ role_id: roleId, name: roleId });
  const s = skill(roleId, `${roleId} skill`);
  const e = experience(roleId, `${roleId} experience`);
  await repository.saveSkill(roleId, s);
  await repository.saveExperience(roleId, e);
  return { skillId: s.id, experienceId: e.id };
}

describe('reindexMemory', () => {
  it('recomputes dimension-mismatched embeddings across all agents (model switch)', async () => {
    const repository = new InMemoryRepository(new HashEmbeddingProvider(32));
    await seedAgent(repository, 'role_alpha');
    await seedAgent(repository, 'role_beta');

    const result = await reindexMemory(repository, new HashEmbeddingProvider(8));

    expect(result).toMatchObject({
      scope: 'all',
      agents_processed: 2,
      skills_reindexed: 2,
      skills_skipped: 0,
      experiences_reindexed: 2,
      experiences_skipped: 0,
      failures: [],
      dimensions: 8,
    });
    // 存量 32 维向量全部重算为 8 维
    for (const roleId of ['role_alpha', 'role_beta']) {
      for (const s of await repository.listSkills(roleId)) {
        expect(s.description_embedding).toHaveLength(8);
      }
      for (const e of await repository.listExperiences(roleId)) {
        expect(e.description_embedding).toHaveLength(8);
      }
    }
  });

  it('is idempotent by default and re-runs cheaply when dimensions already match', async () => {
    const repository = new InMemoryRepository(new HashEmbeddingProvider(8));
    await seedAgent(repository, 'role_alpha');
    // 初始写入已按 8 维生成
    await reindexMemory(repository, new HashEmbeddingProvider(8));

    const result = await reindexMemory(repository, new HashEmbeddingProvider(8));

    expect(result).toMatchObject({
      agents_processed: 1,
      skills_reindexed: 0,
      skills_skipped: 1,
      experiences_reindexed: 0,
      experiences_skipped: 1,
      failures: [],
    });
  });

  it('force=true recomputes even when dimensions match (same-dimension model switch)', async () => {
    const repository = new InMemoryRepository(new HashEmbeddingProvider(8));
    await seedAgent(repository, 'role_alpha');

    const result = await reindexMemory(repository, new HashEmbeddingProvider(8), { force: true });

    expect(result).toMatchObject({
      agents_processed: 1,
      skills_reindexed: 1,
      experiences_reindexed: 1,
      skills_skipped: 0,
      experiences_skipped: 0,
    });
  });

  it('scopes to a single agent via role_id and rejects unknown agents', async () => {
    const repository = new InMemoryRepository(new HashEmbeddingProvider(32));
    await seedAgent(repository, 'role_alpha');
    await seedAgent(repository, 'role_beta');

    const result = await reindexMemory(repository, new HashEmbeddingProvider(8), {
      role_id: 'role_alpha',
    });

    expect(result).toMatchObject({
      scope: 'role',
      role_id: 'role_alpha',
      agents_processed: 1,
      skills_reindexed: 1,
      experiences_reindexed: 1,
    });
    // role_beta 不受影响，仍是 32 维
    expect((await repository.listSkills('role_beta'))[0]!.description_embedding).toHaveLength(32);

    await expect(
      reindexMemory(repository, new HashEmbeddingProvider(8), { role_id: 'role_missing' }),
    ).rejects.toThrow(/not found/i);
  });

  it('includes market pool skills in a full reindex', async () => {
    const repository = new InMemoryRepository(new HashEmbeddingProvider(32));
    await seedAgent(repository, 'role_alpha');
    // 市场池技能（retire 或 transfer 后归入 __market__）
    await repository.ensureAgent(MARKET_POOL_ROLE_ID);
    const marketSkillRecord = skill(MARKET_POOL_ROLE_ID, 'market skill');
    await repository.saveSkill(MARKET_POOL_ROLE_ID, marketSkillRecord);

    const result = await reindexMemory(repository, new HashEmbeddingProvider(8));

    expect(result.agents_processed).toBe(2); // role_alpha + 市场池
    expect(result.skills_reindexed).toBe(2);
    expect((await repository.listSkills(MARKET_POOL_ROLE_ID))[0]!.description_embedding).toHaveLength(
      8,
    );
  });

  it('writes the vector verbatim without the repository re-embedding guard', async () => {
    // 仓库以 32 维 provider 构造；重建用 8 维 provider 直写，仓库守卫不得用 32 维覆盖
    const repository = new InMemoryRepository(new HashEmbeddingProvider(32));
    await seedAgent(repository, 'role_alpha');

    await reindexMemory(repository, new HashEmbeddingProvider(8));

    const stored = (await repository.listSkills('role_alpha'))[0]!;
    expect(stored.description_embedding).toHaveLength(8);
    // 直写路径未走 updateSkill（不触发仓库 withDescriptionEmbedding 二次 embed）
    expect((await repository.listExperiences('role_alpha'))[0]!.description_embedding).toHaveLength(
      8,
    );
  });
});
