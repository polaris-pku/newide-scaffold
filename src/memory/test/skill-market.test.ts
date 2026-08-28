/**
 * 技能市场（Skill Market）测试
 *
 * 验证：
 *   1. marketSearchSkills 仅检索市场池（__market__）内的技能：
 *      - 未迁入市场池的 Agent 技能（即使 approved / publish 标记）不可被检索到
 *      - 迁入市场池后按资格过滤（approved 且非 superseded），排除 rejected / superseded
 *   2. marketImportSkill 克隆副本：新 id、agent_id=引入方、imported_from=源技能 id
 *   3. 引入副作用：源技能 imported_by 追加、引入方 imported_skill_count++ / skill_count++
 *   4. 幂等：重复引入返回 created=false，不重复克隆、imported_by 不重复
 *   5. 异常：源技能不存在 / 不可引入（rejected / superseded）时抛错
 *   6. 服务层 marketSearch（文本 query → embedding）与 marketImport（校验引入方存在）
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { defaultHashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { marketSearch, marketImport } from '../services/skill-market';
import { MARKET_POOL_ROLE_ID, type SkillRecord } from '../schemas';

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

async function setupMarket() {
  const repository = new InMemoryRepository();
  await repository.initializeAgent({ role_id: 'src', name: 'Source Agent', tags: [] });
  await repository.initializeAgent({ role_id: 'dst', name: 'Destination Agent', tags: [] });

  const tsSkill = makeSkill({
    id: '00000000-0000-0000-0000-000000000001',
    description: 'typescript interfaces',
  });
  const rejectedSkill = makeSkill({
    id: '00000000-0000-0000-0000-000000000002',
    description: 'typescript anti-pattern',
    review_status: 'rejected',
  });
  const supersededSkill = makeSkill({
    id: '00000000-0000-0000-0000-000000000003',
    description: 'typescript legacy',
    market_status: 'superseded',
  });
  const rustSkill = makeSkill({
    id: '00000000-0000-0000-0000-000000000004',
    description: 'rust ownership',
    agent_id: 'dst',
  });

  await repository.saveSkill('src', tsSkill);
  await repository.saveSkill('src', rejectedSkill);
  await repository.saveSkill('src', supersededSkill);
  await repository.saveSkill('dst', rustSkill);

  return { repository, tsSkill, rejectedSkill, supersededSkill, rustSkill };
}

describe('MemoryRepository.marketSearchSkills', () => {
  it('仅检索市场池（__market__）内的技能；未迁入市场池的 Agent 技能不可被检索', async () => {
    const { repository, tsSkill, rustSkill, rejectedSkill, supersededSkill } =
      await setupMarket();
    const queryEmbedding = await embedding.embed('typescript');

    // 迁入市场池前：任何 Agent 的技能（即使 approved）都不可被检索到
    const before = await repository.marketSearchSkills({
      query_embedding: queryEmbedding,
      top_k: 10,
      min_similarity: -1,
    });
    expect(before).toHaveLength(0);

    // 将 tsSkill 迁入市场池（模拟退休资产处置）
    await repository.transferSkillToMarket('src', tsSkill.id, {
      market_status: 'retired_unique',
    });

    const results = await repository.marketSearchSkills({
      query_embedding: queryEmbedding,
      top_k: 10,
      min_similarity: -1,
    });
    const ids = results.map((skill) => skill.id);
    expect(ids).toContain(tsSkill.id);
    // 仍归 src / dst 的未退休技能（即使 approved）不可被检索
    expect(ids).not.toContain(rustSkill.id);
    // 资格过滤：rejected / superseded 排除
    expect(ids).not.toContain(rejectedSkill.id);
    expect(ids).not.toContain(supersededSkill.id);
    // 最相关的 typescript 技能应排在最前
    expect(ids[0]).toBe(tsSkill.id);
  });

  it('exclude_agent_id 排除市场池时返回空；排除其他 Agent 不影响市场池结果', async () => {
    const { repository, tsSkill } = await setupMarket();
    await repository.transferSkillToMarket('src', tsSkill.id, {
      market_status: 'retired_unique',
    });
    const queryEmbedding = await embedding.embed('typescript');

    // 排除未退休 Agent（dst）不影响市场池结果（其技能本就不在市场池）
    const excludingOther = await repository.marketSearchSkills({
      query_embedding: queryEmbedding,
      top_k: 10,
      min_similarity: -1,
      exclude_agent_id: 'dst',
    });
    expect(excludingOther.map((skill) => skill.id)).toEqual([tsSkill.id]);

    // 排除市场池本身 → 空
    const excludingMarket = await repository.marketSearchSkills({
      query_embedding: queryEmbedding,
      top_k: 10,
      min_similarity: -1,
      exclude_agent_id: MARKET_POOL_ROLE_ID,
    });
    expect(excludingMarket).toHaveLength(0);
  });

  it('top_k 限制返回条数', async () => {
    const { repository, tsSkill } = await setupMarket();
    await repository.transferSkillToMarket('src', tsSkill.id, {
      market_status: 'retired_unique',
    });
    const queryEmbedding = await embedding.embed('typescript');

    const results = await repository.marketSearchSkills({
      query_embedding: queryEmbedding,
      top_k: 1,
      min_similarity: -1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(tsSkill.id);
  });
});

describe('MemoryRepository.marketImportSkill', () => {
  it('克隆副本并产生副作用（source.imported_by / 引入方 imported_skill_count）', async () => {
    const { repository, tsSkill } = await setupMarket();

    const result = await repository.marketImportSkill('dst', tsSkill.id);

    expect(result.created).toBe(true);
    // 副本：新 id、agent_id=引入方、imported_from=源技能 id
    expect(result.imported.id).not.toBe(tsSkill.id);
    expect(result.imported.agent_id).toBe('dst');
    expect(result.imported.imported_from).toBe(tsSkill.id);
    expect(result.imported.description).toBe(tsSkill.description);
    expect(result.imported.review_status).toBe('approved');

    // 源技能 imported_by 追加引入方
    expect(result.source.imported_by).toEqual(['dst']);

    // 引入方 metrics：imported_skill_count++ 且 skill_count++
    const dstHandle = await repository.getAgent('dst');
    expect(dstHandle.metric.imported_skill_count).toBe(1);
    expect(dstHandle.skill_count).toBe(2); // 原有 rust + 引入副本
    expect(dstHandle.owned_skills).toContain(result.imported.id);

    // 源技能在源 Agent 中已被持久化 imported_by
    const srcSkills = await repository.listSkills('src');
    expect(srcSkills.find((skill) => skill.id === tsSkill.id)?.imported_by).toEqual(['dst']);
  });

  it('幂等：重复引入返回 created=false 且不重复克隆 / 不重复写 imported_by', async () => {
    const { repository, tsSkill } = await setupMarket();

    const first = await repository.marketImportSkill('dst', tsSkill.id);
    const second = await repository.marketImportSkill('dst', tsSkill.id);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.imported.id).toBe(first.imported.id);
    expect(second.source.imported_by).toEqual(['dst']);

    // 副本只有一个
    const dstSkills = await repository.listSkills('dst');
    expect(dstSkills.filter((skill) => skill.imported_from === tsSkill.id)).toHaveLength(1);
    expect((await repository.getAgent('dst')).metric.imported_skill_count).toBe(1);
  });

  it('源技能不存在时抛错', async () => {
    const { repository } = await setupMarket();
    await expect(
      repository.marketImportSkill('dst', '00000000-0000-0000-0000-00000000ffff'),
    ).rejects.toThrow('Market skill not found');
  });

  it('不可引入（rejected）时抛错', async () => {
    const { repository, rejectedSkill } = await setupMarket();
    await expect(repository.marketImportSkill('dst', rejectedSkill.id)).rejects.toThrow(
      'Market skill not importable',
    );
  });

  it('不可引入（superseded）时抛错', async () => {
    const { repository, supersededSkill } = await setupMarket();
    await expect(repository.marketImportSkill('dst', supersededSkill.id)).rejects.toThrow(
      'Market skill not importable',
    );
  });
});

describe('services/skill-market（marketSearch / marketImport）', () => {
  it('marketSearch 用文本 query 检索市场池，返回相关技能', async () => {
    const { repository, tsSkill } = await setupMarket();
    await repository.transferSkillToMarket('src', tsSkill.id, {
      market_status: 'retired_unique',
    });

    const results = await marketSearch(repository, embedding, {
      query: 'typescript',
      top_k: 5,
      exclude_agent_id: 'dst',
    });

    expect(results.map((skill) => skill.id)).toEqual([tsSkill.id]);
  });

  it('marketImport 校验引入方存在，不存在时抛错', async () => {
    const { repository, tsSkill } = await setupMarket();
    await expect(marketImport(repository, 'missing-agent', tsSkill.id)).rejects.toThrow(
      'Agent not found',
    );
  });

  it('marketImport 委托给 repository 并返回结果', async () => {
    const { repository, tsSkill } = await setupMarket();
    const result = await marketImport(repository, 'dst', tsSkill.id);
    expect(result.created).toBe(true);
    expect(result.imported.agent_id).toBe('dst');
  });
});
