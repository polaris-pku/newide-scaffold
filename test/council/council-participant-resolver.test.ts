import { describe, expect, it } from 'vitest';
import {
  AgentBoardCouncilParticipantResolver,
  readCouncilSeatAssignments,
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

  it('resolves the roster from a dynamic provider so runtime-created Agents participate', async () => {
    const board = [agent('role_ts_engineer', ['market_eligible'])];
    const resolver = new AgentBoardCouncilParticipantResolver({
      boardQuery: boardQuery(board),
      resolveAllowedAgentIds: async () => board.map((entry) => entry.role_id),
    });
    const input = {
      run_id: 'run_dynamic_roster',
      task_id: 'task_dynamic_roster',
      question: 'Choose an implementation.',
    };

    // 单 Agent 时 Council 不可用
    await expect(resolver.resolve(input)).rejects.toThrow(
      'Council requires at least two distinct persisted Agents',
    );

    // 运行时新增 Agent（memory.createAgent 后）无需重启即可参与
    board.push(agent('role_fullstack_engineer', ['market_eligible']));
    const participants = await resolver.resolve(input);

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

  it('selects the primary and remaining seats through independent auctions when enabled', async () => {
    const calls: Array<{
      seat: string;
      seat_index: number;
      candidate_agent_ids: string[];
      excluded_agent_ids: string[];
    }> = [];
    const winners = ['role_ts_engineer', 'role_reviewer', 'role_synthesizer'];
    const resolver = new AgentBoardCouncilParticipantResolver({
      boardQuery: boardQuery([
        agent('role_primary', ['market_eligible']),
        agent('role_ts_engineer', ['market_eligible']),
        agent('role_reviewer', ['market_eligible']),
        agent('role_synthesizer', ['market_eligible']),
      ]),
      allowedAgentIds: [
        'role_primary',
        'role_ts_engineer',
        'role_reviewer',
        'role_synthesizer',
      ],
      auctionEnabled: true,
      auctionSelector: async (input) => {
        calls.push({
          seat: input.seat,
          seat_index: input.seat_index,
          candidate_agent_ids: input.candidate_agent_ids,
          excluded_agent_ids: input.excluded_agent_ids,
        });
        return {
          agent_id: winners[calls.length - 1]!,
          selection_refs: [`audit_${calls.length}`],
        };
      },
    });

    const participants = await resolver.resolve({
      run_id: 'run_auction',
      task_id: 'task_auction',
      question: 'Choose an implementation.',
      primary_agent_id: 'role_primary',
    });

    expect(
      participants.map(({ seat, seat_index, agent_id }) => ({ seat, seat_index, agent_id })),
    ).toEqual([
      { seat: 'proposer', seat_index: 0, agent_id: 'role_primary' },
      { seat: 'proposer', seat_index: 1, agent_id: 'role_ts_engineer' },
      { seat: 'reviewer', seat_index: 0, agent_id: 'role_reviewer' },
      { seat: 'synthesizer', seat_index: 0, agent_id: 'role_synthesizer' },
    ]);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.seat)).toEqual(['proposer', 'reviewer', 'synthesizer']);
    expect(calls[0]?.excluded_agent_ids).toEqual(['role_primary']);
    expect(calls[1]?.excluded_agent_ids).toEqual(['role_primary', 'role_ts_engineer']);
    expect(participants[1]?.selection_refs).toEqual(['audit_1']);
  });

  it('binds Council seats to fixed role_ids when seatAssignments is configured', async () => {
    const resolver = new AgentBoardCouncilParticipantResolver({
      boardQuery: boardQuery([
        agent('role_primary', ['market_eligible']),
        agent('role_deputy', ['market_eligible']),
        agent('role_reviewer', ['market_eligible']),
        agent('role_synthesizer', ['market_eligible']),
      ]),
      allowedAgentIds: [
        'role_primary',
        'role_deputy',
        'role_reviewer',
        'role_synthesizer',
      ],
      seatAssignments: {
        proposer0: 'role_primary',
        proposer1: 'role_deputy',
        reviewer: 'role_reviewer',
        synthesizer: 'role_synthesizer',
      },
    });

    const participants = await resolver.resolve({
      run_id: 'run_fixed_seats',
      task_id: 'task_fixed_seats',
      question: 'Implement a feature.',
    });

    expect(participants.map(({ seat, seat_index, agent_id }) => ({
      seat,
      seat_index,
      agent_id,
    }))).toEqual([
      { seat: 'proposer', seat_index: 0, agent_id: 'role_primary' },
      { seat: 'proposer', seat_index: 1, agent_id: 'role_deputy' },
      { seat: 'reviewer', seat_index: 0, agent_id: 'role_reviewer' },
      { seat: 'synthesizer', seat_index: 0, agent_id: 'role_synthesizer' },
    ]);
    expect(participants.some((participant) => participant.conflict_flags?.length)).toBe(false);
  });

  it('rejects fixed seatAssignments when a mapped Agent is missing or not eligible', async () => {
    const resolver = new AgentBoardCouncilParticipantResolver({
      boardQuery: boardQuery([
        agent('role_primary', ['market_eligible']),
        agent('role_deputy', ['market_eligible']),
        agent('role_reviewer', ['market_eligible'], 'retired'),
      ]),
      allowedAgentIds: [
        'role_primary',
        'role_deputy',
        'role_reviewer',
        'role_synthesizer',
      ],
      seatAssignments: {
        proposer0: 'role_primary',
        proposer1: 'role_deputy',
        reviewer: 'role_reviewer',
        synthesizer: 'role_synthesizer',
      },
    });

    await expect(
      resolver.resolve({
        run_id: 'run_missing_seat',
        task_id: 'task_missing_seat',
        question: 'Missing synthesizer.',
      }),
    ).rejects.toThrow('role_reviewer has no eligible persisted Agent');
  });

  it('parses NEWIDE_COUNCIL_SEATS into a fixed seat mapping', () => {
    expect(
      readCouncilSeatAssignments(
        'role_primary,role_deputy,role_reviewer,role_synthesizer',
      ),
    ).toEqual({
      proposer0: 'role_primary',
      proposer1: 'role_deputy',
      reviewer: 'role_reviewer',
      synthesizer: 'role_synthesizer',
    });
    expect(readCouncilSeatAssignments(undefined)).toBeUndefined();
    expect(readCouncilSeatAssignments('  ')).toBeUndefined();
    expect(() =>
      readCouncilSeatAssignments('role_a,role_b,role_c'),
    ).toThrow('NEWIDE_COUNCIL_SEATS');
    expect(() =>
      readCouncilSeatAssignments('role a,role_b,role_c,role_d'),
    ).toThrow('NEWIDE_COUNCIL_SEATS');
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
