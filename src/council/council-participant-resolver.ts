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
  primary_agent_id?: string;
}

export interface CouncilParticipantResolver {
  resolve(input: CouncilParticipantResolutionInput): Promise<CouncilParticipantBinding[]>;
}

export interface CouncilParticipantAuctionInput {
  run_id: string;
  task_id: string;
  question: string;
  seat: CouncilSeat;
  seat_index: number;
  candidate_agent_ids: string[];
  excluded_agent_ids: string[];
}

export interface CouncilParticipantAuctionResult {
  agent_id: string;
  selection_refs?: string[];
}

export type CouncilParticipantAuctionSelector = (
  input: CouncilParticipantAuctionInput,
) => Promise<CouncilParticipantAuctionResult>;

/**
 * 固定 Council 席位映射。配置后按 role_id 精确绑定 4 个席位，杜绝复用；
 * 未配置时回退到 board 顺序分配（向后兼容）。
 */
export interface CouncilSeatAssignments {
  proposer0: string;
  proposer1: string;
  reviewer: string;
  synthesizer: string;
}

export interface AgentBoardCouncilParticipantResolverOptions {
  boardQuery: AgentBoardQuery;
  /** 静态允许名册（与 resolveAllowedAgentIds 二选一；两者都提供时优先动态提供者） */
  allowedAgentIds?: readonly string[];
  /** 动态名册提供者：每次 resolve 时查询，支持运行时新增 Agent（memory.createAgent） */
  resolveAllowedAgentIds?: () => Promise<readonly string[]>;
  ensureAgent?: (agentId: string) => Promise<void>;
  seatAssignments?: CouncilSeatAssignments;
  auctionSelector?: CouncilParticipantAuctionSelector;
  auctionEnabled?: boolean;
  proposerCount?: number;
}

/**
 * 从 B AgentBoard 的真实 Agent 中解析 Council 席位。
 *
 * 默认绑定两个 proposer、一个 reviewer 和一个 synthesizer；动态竞标模式
 * 可以配置更多 proposer。两个不同的真实 Agent 即可正常启动；复用会被审计。
 * 单 Agent 运行直接阻断。
 */
export class AgentBoardCouncilParticipantResolver implements CouncilParticipantResolver {
  private readonly boardQuery: AgentBoardQuery;
  private readonly allowedAgentIds: ReadonlySet<string> | undefined;
  private readonly resolveAllowedAgentIds: (() => Promise<readonly string[]>) | undefined;
  private readonly ensureAgent: ((agentId: string) => Promise<void>) | undefined;
  private readonly seatAssignments: CouncilSeatAssignments | undefined;
  private readonly auctionSelector: CouncilParticipantAuctionSelector | undefined;
  private readonly auctionEnabled: boolean;
  private readonly proposerCount: number;

  constructor(options: AgentBoardCouncilParticipantResolverOptions) {
    this.boardQuery = options.boardQuery;
    this.allowedAgentIds = options.allowedAgentIds ? new Set(options.allowedAgentIds) : undefined;
    this.resolveAllowedAgentIds = options.resolveAllowedAgentIds;
    this.ensureAgent = options.ensureAgent;
    this.seatAssignments = options.seatAssignments;
    this.auctionSelector = options.auctionSelector;
    this.auctionEnabled = options.auctionEnabled === true;
    this.proposerCount = options.proposerCount ?? 2;
    if (!Number.isInteger(this.proposerCount) || this.proposerCount < 2) {
      throw new Error('Council proposerCount must be an integer greater than or equal to 2');
    }
  }

  async resolve(
    input: CouncilParticipantResolutionInput,
  ): Promise<CouncilParticipantBinding[]> {
    const allowed = await this.resolveAllowedSet();
    if (this.ensureAgent) {
      for (const agentId of [...allowed].sort(compareCodeUnits)) {
        await this.ensureAgent(agentId);
      }
    }
    const agents = await this.boardQuery.listAgents();
    if (this.seatAssignments) {
      return this.resolveFixedSeats(input, agents, allowed);
    }
    if (this.auctionEnabled) {
      return this.resolveAuctionSeats(input, agents);
    }
    const candidates = orderCandidates(
      agents.filter(
        (agent) =>
          allowed.has(agent.role_id) &&
          ['created', 'active', 'idle'].includes(agent.status) &&
          !agent.tags?.includes('council_only'),
      ),
      input.participant_profile_refs,
    );
    if (candidates.length === 0) {
      throw new Error('No eligible persisted Agent is available for Council participation');
    }
    if (candidates.length < 2) {
      throw new Error(
        `Council requires at least two distinct persisted Agents; found ${candidates.length}.`,
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

  private async resolveAuctionSeats(
    input: CouncilParticipantResolutionInput,
    agents: readonly AgentBoardListItem[],
  ): Promise<CouncilParticipantBinding[]> {
    if (!this.auctionSelector) {
      throw new Error('Council auction mode requires an auction selector');
    }
    const candidates = orderCandidates(
      agents.filter(
        (agent) =>
          this.allowedAgentIds.has(agent.role_id) &&
          ['created', 'active', 'idle'].includes(agent.status) &&
          !agent.tags?.includes('council_only'),
      ),
      input.participant_profile_refs,
    );
    if (candidates.length < 2) {
      throw new Error(
        `Council requires at least two distinct persisted Agents; found ${candidates.length}.`,
      );
    }
    const candidateAgentIds = candidates.map((candidate) => candidate.role_id);
    const primary = input.primary_agent_id ?? candidates[0]!.role_id;
    if (!this.allowedAgentIds.has(primary) || !candidateAgentIds.includes(primary)) {
      throw new Error(`Council primary Agent ${primary} is not eligible for auction participation`);
    }
    const assignments: CouncilParticipantBinding[] = [];
    const used = new Set<string>();
    assignments.push(this.binding(input, 'proposer', 0, primary));
    used.add(primary);

    for (let seatIndex = 1; seatIndex < this.proposerCount; seatIndex += 1) {
      const selected = await this.selectAuctionSeat(input, 'proposer', seatIndex, candidates, used);
      assignments.push(this.binding(input, 'proposer', seatIndex, selected.agent_id, selected.selection_refs));
      used.add(selected.agent_id);
    }
    for (const seat of ['reviewer', 'synthesizer'] as const) {
      const selected = await this.selectAuctionSeat(input, seat, 0, candidates, used);
      assignments.push(this.binding(input, seat, 0, selected.agent_id, selected.selection_refs));
      used.add(selected.agent_id);
    }
    const usage = countAgentUsage(assignments);
    return assignments.map((assignment) =>
      usage.get(assignment.agent_id)! > 1
        ? {
            ...assignment,
            conflict_flags: [
              ...(assignment.conflict_flags ?? []),
              'agent_reused_across_council_seats',
              'best_effort_identity',
            ],
          }
        : assignment,
    );
  }

  private async selectAuctionSeat(
    input: CouncilParticipantResolutionInput,
    seat: CouncilSeat,
    seatIndex: number,
    candidates: readonly AgentBoardListItem[],
    used: ReadonlySet<string>,
  ): Promise<CouncilParticipantAuctionResult> {
    const candidateAgentIds = candidates.map((candidate) => candidate.role_id);
    const available = candidateAgentIds.filter((agentId) => !used.has(agentId));
    const selected = await this.auctionSelector!({
      run_id: input.run_id,
      task_id: input.task_id,
      question: input.question,
      seat,
      seat_index: seatIndex,
      candidate_agent_ids: available.length > 0 ? available : candidateAgentIds,
      excluded_agent_ids: [...used],
    });
    if (!candidateAgentIds.includes(selected.agent_id)) {
      throw new Error(`Council auction selected ineligible Agent ${selected.agent_id}`);
    }
    return selected;
  }

  private binding(
    input: CouncilParticipantResolutionInput,
    seat: CouncilSeat,
    seatIndex: number,
    agentId: string,
    selectionRefs: readonly string[] = [],
  ): CouncilParticipantBinding {
    return {
      participant_id: createCouncilParticipantId(input.run_id, seat, seatIndex, agentId),
      seat,
      seat_index: seatIndex,
      agent_id: agentId,
      role_profile_ref: agentId,
      ...(selectionRefs.length > 0 ? { selection_refs: [...selectionRefs] } : {}),
    };
  }

  /**
   * 按固定 seatAssignments 映射绑定 4 个席位。每个 role_id 必须存在、在
   * allowed 名单内且 eligible；缺失直接抛错，不复用（保持 4 席位身份独立）。
   */
  private async resolveFixedSeats(
    input: CouncilParticipantResolutionInput,
    agents: readonly AgentBoardListItem[],
    allowed: ReadonlySet<string>,
  ): Promise<CouncilParticipantBinding[]> {
    const assignments = this.seatAssignments!;
    const agentByRole = new Map(agents.map((agent) => [agent.role_id, agent] as const));
    const entries: Array<{ seat: CouncilSeat; seat_index: number; roleId: string }> = [
      { seat: 'proposer', seat_index: 0, roleId: assignments.proposer0 },
      { seat: 'proposer', seat_index: 1, roleId: assignments.proposer1 },
      { seat: 'reviewer', seat_index: 0, roleId: assignments.reviewer },
      { seat: 'synthesizer', seat_index: 0, roleId: assignments.synthesizer },
    ];
    const uniqueRoles = new Set(entries.map((entry) => entry.roleId));
    if (uniqueRoles.size !== 4) {
      throw new Error(
        'Council seatAssignments must map to four distinct role_ids (proposer0/proposer1/reviewer/synthesizer).',
      );
    }
    for (const entry of entries) {
      if (!allowed.has(entry.roleId)) {
        throw new Error(`Council seat role_id ${entry.roleId} is not in the allowed roster`);
      }
      const agent = agentByRole.get(entry.roleId);
      if (!agent || !['created', 'active', 'idle'].includes(agent.status)) {
        throw new Error(
          `Council seat role_id ${entry.roleId} has no eligible persisted Agent`,
        );
      }
    }
    return entries.map((entry) => ({
      participant_id: createCouncilParticipantId(
        input.run_id,
        entry.seat,
        entry.seat_index,
        entry.roleId,
      ),
      seat: entry.seat,
      seat_index: entry.seat_index,
      agent_id: entry.roleId,
      role_profile_ref: entry.roleId,
    }));
  }
  /**
   * 解析本次 resolve 的允许名册：优先动态提供者（支持运行时新增 Agent），
   * 否则回退静态 allowlist（两者都未提供时为空集合）。
   */
  private async resolveAllowedSet(): Promise<ReadonlySet<string>> {
    if (this.resolveAllowedAgentIds) {
      return new Set(await this.resolveAllowedAgentIds());
    }
    return this.allowedAgentIds ?? new Set();
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

/**
 * 从 NEWIDE_COUNCIL_SEATS 环境变量解析固定席位映射。
 * 格式：<proposer0>,<proposer1>,<reviewer>,<synthesizer>（逗号分隔 4 个 role_id）。
 * 未配置时返回 undefined（回退 board 顺序分配）。
 */
export function readCouncilSeatAssignments(
  value: string | undefined,
): CouncilSeatAssignments | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length !== 4 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error(
      'NEWIDE_COUNCIL_SEATS must be exactly four comma-separated role_ids: <proposer0>,<proposer1>,<reviewer>,<synthesizer>',
    );
  }
  const [proposer0, proposer1, reviewer, synthesizer] = parts as [
    string,
    string,
    string,
    string,
  ];
  return { proposer0, proposer1, reviewer, synthesizer };
}
