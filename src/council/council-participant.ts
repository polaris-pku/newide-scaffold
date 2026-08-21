import { createHash } from 'node:crypto';

export type CouncilSeat = 'proposer' | 'reviewer' | 'synthesizer';

/**
 * Council 席位与真实持久化 Agent 的单轮绑定。
 *
 * participant_id 标识本轮参与实例；agent_id 始终指向 B 仓库中的真实 Agent。
 * Council 至少绑定两个不同的真实 Agent；席位复用通过 conflict_flags 披露。
 * 单 Agent 运行才属于显式降级路径。
 */
export interface CouncilParticipantBinding {
  participant_id: string;
  seat: CouncilSeat;
  seat_index: number;
  agent_id: string;
  role_profile_ref?: string;
  selection_refs?: string[];
  conflict_flags?: string[];
}

const SEAT_CODE: Readonly<Record<CouncilSeat, string>> = {
  proposer: 'p',
  reviewer: 'r',
  synthesizer: 's',
};

/**
 * Short stable participant folder id.
 * Long names under deep experiment roots blow Windows MAX_PATH on git worktree add.
 */
export function createCouncilParticipantId(
  runId: string,
  seat: CouncilSeat,
  seatIndex: number,
  agentId: string,
): string {
  const digest = createHash('sha256')
    .update(`${runId}\0${seat}\0${String(seatIndex)}\0${agentId}`)
    .digest('hex')
    .slice(0, 8);
  return `cp_${SEAT_CODE[seat]}${String(seatIndex)}_${digest}`;
}
