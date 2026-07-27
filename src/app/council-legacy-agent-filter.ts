import type { AgentBoardListItem } from '../memory';

export const LEGACY_COUNCIL_AGENT_IDS = [
  'proposer_a',
  'proposer_b',
  'reviewer',
  'synthesizer',
] as const;

const LEGACY_COUNCIL_AGENT_ID_SET = new Set<string>(LEGACY_COUNCIL_AGENT_IDS);

/**
 * 只识别旧生产 seed 同时满足的 ID + council_only 标签，避免隐藏用户自己创建的同名 Agent。
 */
export function isLegacyCouncilPseudoAgent(
  agent: Pick<AgentBoardListItem, 'role_id' | 'tags'>,
): boolean {
  return (
    LEGACY_COUNCIL_AGENT_ID_SET.has(agent.role_id) &&
    agent.tags?.includes('council_only') === true
  );
}

export function filterLegacyCouncilPseudoAgents(
  agents: readonly AgentBoardListItem[],
): AgentBoardListItem[] {
  return agents.filter((agent) => !isLegacyCouncilPseudoAgent(agent));
}

