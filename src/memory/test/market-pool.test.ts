/**
 * 技能市场池（方案 A：固定 __market__ Agent）测试
 *
 * 验证：
 *   1. transferSkillToMarket 迁移技能：agent_id → __market__、id 不变、
 *      origin_agent_id 记录原创建者、market_status 可指定或沿用原值
 *   2. 副作用：源 Agent 计数递减、市场池计数递增、市场池自动初始化
 *   3. 隐藏：__market__ 不暴露在 listAgentIds（不进 Board / 竞标 / loadAllAgents）
 *   4. 迁移后技能仍可被市场检索与市场引入命中（闭环）
 *   5. 异常：技能不存在抛错
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { defaultHashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { MARKET_POOL_ROLE_ID, type SkillRecord } from '../schemas';
import { marketImport } from '../services/skill-market';

const embedding = defaultHashEmbeddingProvider;

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Write TypeScript services',
    description_embedding: [],
    content: 'Steps to write TS services',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['typescript'],
    promoted_at: now,
    agent_id: 'src',
    market_status: 'available',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

async function setup() {
  const repository = new InMemoryRepository();
  await repository.initializeAgent({ role_id: 'src', name: 'Source Agent', tags: [] });
  await repository.initializeAgent({ role_id: 'dst', name: 'Destination Agent', tags: [] });
  const skillRec = makeSkill();
  await repository.saveSkill('src', skillRec);
  return { repository, skillRec };
}

describe('MemoryRepository.transferSkillToMarket', () => {
  it('迁移技能到市场池：agent_id → __market__、id 不变、origin_agent_id 记录原创建者', async () => {
    const { repository, skillRec } = await setup();

    const moved = await repository.transferSkillToMarket('src', skillRec.id, {
      market_status: 'retired_unique',
    });

    expect(moved.id).toBe(skillRec.id);
    expect(moved.agent_id).toBe(MARKET_POOL_ROLE_ID);
    expect(moved.origin_agent_id).toBe('src');
    expect(moved.market_status).toBe('retired_unique');

    // 源 Agent 名下技能清空、计数同步
    expect(await repository.listSkills('src')).toHaveLength(0);
    expect((await repository.getAgent('src')).skill_count).toBe(0);

    // 市场池持有技能、计数同步
    const pooled = await repository.listSkills(MARKET_POOL_ROLE_ID);
    expect(pooled).toHaveLength(1);
    expect(pooled[0]!.id).toBe(skillRec.id);
    expect((await repository.getAgent(MARKET_POOL_ROLE_ID)).skill_count).toBe(1);

    // 市场池不出现在普通 Agent 列表（不进 Board / 竞标 / loadAllAgents）
    expect(await repository.listAgentIds()).not.toContain(MARKET_POOL_ROLE_ID);
  });

  it('不传 market_status 时沿用原值', async () => {
    const { repository, skillRec } = await setup();
    const moved = await repository.transferSkillToMarket('src', skillRec.id);
    expect(moved.market_status).toBe('available');
    expect(moved.origin_agent_id).toBe('src');
  });

  it('迁移后市场检索与市场引入仍可命中该技能（闭环）', async () => {
    const { repository, skillRec } = await setup();
    await repository.transferSkillToMarket('src', skillRec.id, {
      market_status: 'retired_unique',
    });

    const found = await repository.marketSearchSkills({
      query_embedding: await embedding.embed('typescript'),
      top_k: 10,
      min_similarity: -1,
    });
    expect(found.map((skill) => skill.id)).toContain(skillRec.id);

    // 其他 Agent 从市场池引入该技能
    const imported = await marketImport(repository, 'dst', skillRec.id);
    expect(imported.created).toBe(true);
    expect(imported.imported.agent_id).toBe('dst');
    expect(imported.imported.imported_from).toBe(skillRec.id);
    // 副本沿袭源技能的根创建者，溯源到 __market__ 技能的原创建者
    expect(imported.imported.origin_agent_id).toBe('src');
  });

  it('技能不存在时抛错', async () => {
    const { repository } = await setup();
    await expect(
      repository.transferSkillToMarket('src', '00000000-0000-0000-0000-00000000ffff'),
    ).rejects.toThrow('Skill not found');
  });
});
