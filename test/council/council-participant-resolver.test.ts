import { describe, expect, it } from 'vitest';
import {
  AgentBoardCouncilParticipantResolver,
} from '../../src/council';
import type { AgentBoardListItem, AgentBoardQuery } from '../../src/memory';

describe('AgentBoardCouncilParticipantResolver', () => {
  it('binds Council seats to eligible persisted Agents and audits unavoidable reuse', async () => {
    const resolver = new AgentBoardCouncilParticipantResolver({
      boardQuery: boardQuery([
        agent('reviewer', ['council_only']),
        agent('role_ts_engineer', ['market_eligible']),
        agent('role_disabled', ['market_eligible'], 'retired'),
        agent('role_fullstack_engineer', ['market_eligible']),
      ]),
      allowedAgentIds: [
        'reviewer',
        'role_ts_engineer',
        'role_disabled',
        'role_fullstack_engineer',
      ],
      allowSeatReuse: true,
    });

    const participants = await resolver.resolve({
      run_id: 'run_council_identity',
      task_id: 'task_council_identity',
      question: 'Choose an implementation.',
    });

    expect(participants.map(({ seat, seat_index, agent_id }) => ({
      seat,
      seat_index,
      agent_id,
    }))).toEqual([
      { seat: 'proposer', seat_index: 0, agent_id: 'role_fullstack_engineer' },
      { seat: 'proposer', seat_index: 1, agent_id: 'role_ts_engineer' },
      { seat: 'reviewer', seat_index: 0, agent_id: 'role_ts_engineer' },
      { seat: 'synthesizer', seat_index: 0, agent_id: 'role_fullstack_engineer' },
    ]);
    expect(participants.every((participant) =>
      participant.conflict_flags?.includes('agent_reused_across_council_seats'),
    )).toBe(true);
    expect(participants.map((participant) => participant.participant_id)).toEqual(
      (await resolver.resolve({
        run_id: 'run_council_identity',
        task_id: 'task_council_identity',
        question: 'Choose an implementation.',
      })).map((participant) => participant.participant_id),
    );
  });

  it('rejects a Council when no eligible persisted Agent exists', async () => {
    const resolver = new AgentBoardCouncilParticipantResolver({
      boardQuery: boardQuery([agent('reviewer', ['council_only'])]),
      allowedAgentIds: ['reviewer'],
    });

    await expect(
      resolver.resolve({
        run_id: 'run_no_agent',
        task_id: 'task_no_agent',
        question: 'No eligible agent.',
      }),
    ).rejects.toThrow('No eligible persisted Agent');
  });
});

function agent(
  roleId: string,
  tags: string[],
  status = 'active',
): AgentBoardListItem {
  return {
    role_id: roleId,
    name: roleId,
    status,
    tags,
    skill_count: 0,
    experience_count: 0,
    persona_summary: roleId,
  };
}

function boardQuery(agents: AgentBoardListItem[]): AgentBoardQuery {
  return {
    async listAgents() {
      return agents;
    },
    async getAgent() {
      throw new Error('not used');
    },
    async listSkills() {
      throw new Error('not used');
    },
    async listExperiences() {
      throw new Error('not used');
    },
  };
}
