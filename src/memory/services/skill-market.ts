/**
 * SkillMarket — 技能市场服务
 *
 * 对应 Spec §6.2 的 `skill.market_search` / `skill.market_import` 逻辑接口。
 * 技能市场是跨 Agent 共享的能力池：任意 Agent 可以检索（market_search）并
 * 引入（market_import）其他 Agent 晋升的、已审核通过的技能。
 *
 * 本服务保持纯函数式（只依赖 MemoryRepository + EmbeddingProvider），
 * 与 reviewSkill / disposeRetiredAssets 同一模式，便于单测。
 *
 * ## 语义
 *
 * - marketSearch：文本 query → embedding → 全库 top-K 向量召回
 *   （review_status=approved 且 market_status≠superseded，含 retired_unique 稀缺遗产）。
 * - marketImport：将市场技能克隆为引入方副本；副作用见
 *   MemoryRepository.marketImportSkill 的约定（imported_by / imported_skill_count）。
 */
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type {
  MarketImportResult,
  MarketSearchOptions,
  MemoryRepository,
} from '../ports/memory-repository';
import type { SkillRecord } from '../schemas';

/** 市场检索默认 top-K */
export const DEFAULT_MARKET_TOP_K = 10;

/** marketSearch 入参（文本 query，由服务内部负责 embedding） */
export interface MarketSearchQuery {
  /** 检索文本（自然语言，描述想找的技能） */
  query: string;
  /** 返回的最大条目数（默认 10） */
  top_k?: number;
  /** 最低余弦相似度（0~1） */
  min_similarity?: number;
  /** 排除的 Agent role_id（通常为调用方自身，避免推荐自己的技能） */
  exclude_agent_id?: string;
}

/**
 * 技能市场检索。
 *
 * @param repository - MemoryRepository 端口
 * @param embedding  - EmbeddingProvider（query 文本 → 向量）
 * @param query      - 检索参数（文本形式）
 * @returns 命中的市场技能（SkillRecord[]，含 description_embedding，调用方可按需剔除）
 */
export async function marketSearch(
  repository: MemoryRepository,
  embedding: EmbeddingProvider,
  query: MarketSearchQuery,
): Promise<SkillRecord[]> {
  const query_embedding = await embedding.embed(query.query);
  const options: MarketSearchOptions = {
    query_embedding,
    top_k: query.top_k ?? DEFAULT_MARKET_TOP_K,
    ...(query.min_similarity !== undefined ? { min_similarity: query.min_similarity } : {}),
    ...(query.exclude_agent_id !== undefined
      ? { exclude_agent_id: query.exclude_agent_id }
      : {}),
  };
  return repository.marketSearchSkills(options);
}

/**
 * 技能市场引入。
 *
 * @param repository      - MemoryRepository 端口
 * @param role_id         - 引入方 Agent
 * @param source_skill_id - 源市场技能 ID
 * @returns MarketImportResult（imported 副本 / source 更新后的源技能 / created 是否新建）
 * @throws 当源技能不存在、不可引入（非 approved / superseded）或引入方 Agent 不存在时抛错
 */
export async function marketImport(
  repository: MemoryRepository,
  role_id: string,
  source_skill_id: string,
): Promise<MarketImportResult> {
  // 校验引入方存在（不存在时 getAgent 抛错）
  await repository.getAgent(role_id);
  return repository.marketImportSkill(role_id, source_skill_id);
}
