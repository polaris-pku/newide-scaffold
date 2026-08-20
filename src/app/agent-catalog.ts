/**
 * 动态 Agent 目录提供者
 *
 * 生产运行时过去把 MARKET_AGENT_CATALOG 硬编码成固定 allowlist，导致
 * 运行时新增的 Agent（memory.createAgent）不会进入选人 / 议会 / 邮箱协作。
 * 本助手把「候选 Agent 集合」改为从 AgentBoard 实时查询：每次选择时读取
 * repository 当前状态，剔除 retired 与 council_only 遗留伪 Agent。
 * 消费方（BAgentProjectionAdapter / CouncilParticipantResolver / mailbox）
 * 通过注入此提供者实现目录动态化。
 */
import type { AgentBoardQuery } from '../memory';

/** 动态目录提供者：返回当前可参与协作的 Agent role_id 列表（非 retired、非 council_only） */
export function createAgentCatalogProvider(
  boardQuery: AgentBoardQuery,
): () => Promise<readonly string[]> {
  return async () => {
    const agents = await boardQuery.listAgents();
    return agents
      .filter(
        (agent) => agent.status !== 'retired' && !agent.tags?.includes('council_only'),
      )
      .map((agent) => agent.role_id)
      .sort();
  };
}
