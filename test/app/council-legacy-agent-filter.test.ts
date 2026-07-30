import { describe, expect, it } from 'vitest';
import {
  filterLegacyCouncilPseudoAgents,
  isLegacyCouncilPseudoAgent,
} from '../../src/app/council-legacy-agent-filter';
import type { AgentBoardListItem } from '../../src/memory';

describe('legacy Council Agent filter', () => {
  it('hides only known pseudo Agents with the legacy council_only tag', () => {
    const agents = [
      agent('proposer_a', ['council_only']),
      agent('reviewer', ['user_owned']),
      agent('role_ts_engineer', ['market_eligible']),
    ];

    expect(filterLegacyCouncilPseudoAgents(agents).map((item) => item.role_id)).toEqual([
      'reviewer',
      'role_ts_engineer',
    ]);
    expect(isLegacyCouncilPseudoAgent(agents[0]!)).toBe(true);
    expect(isLegacyCouncilPseudoAgent(agents[1]!)).toBe(false);
  });
});

function agent(roleId: string, tags: string[]): AgentBoardListItem {
  return {
    role_id: roleId,
    name: roleId,
    status: 'created',
    tags,
    skill_count: 0,
    experience_count: 0,
    persona_summary: roleId,
  };
}
