import type { AgentBoardListItem, AgentBoardQuery } from '../memory';
import {
  createCouncilParticipantId,
  type CouncilParticipantBinding,
  type CouncilSeat,
} from './council-participant';

export interface CouncilParticipantResolutionInput {
  run_id: string;
  task_id: string;
  question: string;
  participant_profile_refs?: string[];
}

export interface CouncilParticipantResolver {
  resolve(input: CouncilParticipantResolutionInput): Promise<CouncilParticipantBinding[]>;
}

export interface AgentBoardCouncilParticipantResolverOptions {
  boardQuery: AgentBoardQuery;
  allowedAgentIds: readonly string[];
  ensureAgent?: (agentId: string) => Promise<void>;
  /**
   * Seat reuse is an explicit degraded-mode decision. Normal Council runs
   * require one distinct persisted Agent per seat.
   */
  allowSeatReuse?: boolean;
}

/**
 * 从 B AgentBoard 的真实 Agent 中解析 Council 席位。
 *
 * 当前 MVP 固定为两个 proposer、一个 reviewer 和一个 synthesizer。
 * 正常运行要求四个互不重复的真实 Agent；只有调用方显式允许时才复用。
 */
export class AgentBoardCouncilParticipantResolver implements CouncilParticipantResolver {
  private readonly boardQuery: AgentBoardQuery;
  private readonly allowedAgentIds: ReadonlySet<string>;
  private readonly ensureAgent: ((agentId: string) => Promise<void>) | undefined;
  private readonly allowSeatReuse: boolean;

  constructor(options: AgentBoardCouncilParticipantResolverOptions) {
    this.boardQuery = options.boardQuery;
    this.allowedAgentIds = new Set(options.allowedAgentIds);
    this.ensureAgent = options.ensureAgent;
    this.allowSeatReuse = options.allowSeatReuse ?? false;
  }

  async resolve(
    input: CouncilParticipantResolutionInput,
  ): Promise<CouncilParticipantBinding[]> {
    if (this.ensureAgent) {
      for (const agentId of [...this.allowedAgentIds].sort(compareCodeUnits)) {
        await this.ensureAgent(agentId);
      }
    }
    const agents = await this.boardQuery.listAgents();
    const candidates = orderCandidates(
      agents.filter(
        (agent) =>
          this.allowedAgentIds.has(agent.role_id) &&
          ['created', 'active', 'idle'].includes(agent.status) &&
          !agent.tags?.includes('council_only'),
      ),
      input.participant_profile_refs,
    );
    if (candidates.length === 0) {
      throw new Error('No eligible persisted Agent is available for Council participation');
    }
    if (candidates.length < 4 && !this.allowSeatReuse) {
      throw new Error(
        `Council requires four distinct persisted Agents; found ${candidates.length}. ` +
          'Explicitly enable seat reuse for a best-effort run.',
      );
    }

    const assignments: Array<{ seat: CouncilSeat; seat_index: number; agent_id: string }> = [
      { seat: 'proposer', seat_index: 0, agent_id: candidates[0]!.role_id },
      {
        seat: 'proposer',
        seat_index: 1,
        agent_id: candidates[1]?.role_id ?? candidates[0]!.role_id,
      },
      {
        seat: 'reviewer',
        seat_index: 0,
        agent_id: candidates[2]?.role_id ?? candidates[1]?.role_id ?? candidates[0]!.role_id,
      },
      {
        seat: 'synthesizer',
        seat_index: 0,
        agent_id: candidates[3]?.role_id ?? candidates[0]!.role_id,
      },
    ];
    const usage = countAgentUsage(assignments);

    return assignments.map((assignment) => ({
      participant_id: createCouncilParticipantId(
        input.run_id,
        assignment.seat,
        assignment.seat_index,
        assignment.agent_id,
      ),
      seat: assignment.seat,
      seat_index: assignment.seat_index,
      agent_id: assignment.agent_id,
      role_profile_ref: assignment.agent_id,
      ...(usage.get(assignment.agent_id)! > 1
        ? {
            conflict_flags: [
              'agent_reused_across_council_seats',
              'best_effort_identity',
            ],
          }
        : {}),
    }));
  }
}

function orderCandidates(
  agents: readonly AgentBoardListItem[],
  preferredAgentIds: readonly string[] | undefined,
): AgentBoardListItem[] {
  const preference = new Map(
    (preferredAgentIds ?? []).map((agentId, index) => [agentId, index] as const),
  );
  return [...agents].sort((left, right) => {
    const leftPreference = preference.get(left.role_id) ?? Number.MAX_SAFE_INTEGER;
    const rightPreference = preference.get(right.role_id) ?? Number.MAX_SAFE_INTEGER;
    if (leftPreference !== rightPreference) return leftPreference - rightPreference;
    return compareCodeUnits(left.role_id, right.role_id);
  });
}

function countAgentUsage(
  assignments: readonly { agent_id: string }[],
): Map<string, number> {
  const usage = new Map<string, number>();
  for (const assignment of assignments) {
    usage.set(assignment.agent_id, (usage.get(assignment.agent_id) ?? 0) + 1);
  }
  return usage;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
