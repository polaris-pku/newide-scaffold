import { createHash } from 'node:crypto';

export type CouncilSeat = 'proposer' | 'reviewer' | 'synthesizer';

/**
 * Council 席位与真实持久化 Agent 的单轮绑定。
 *
 * participant_id 标识本轮参与实例；agent_id 始终指向 B 仓库中的真实 Agent。
 * 正常 Council 要求每个席位绑定不同的真实 Agent。只有显式降级运行
 * 才允许同一 Agent 承担多个席位，并通过 conflict_flags 披露。
 */
export interface CouncilParticipantBinding {
  participant_id: string;
  seat: CouncilSeat;
  seat_index: number;
  agent_id: string;
  role_profile_ref?: string;
  conflict_flags?: string[];
}

export function createCouncilParticipantId(
  runId: string,
  seat: CouncilSeat,
  seatIndex: number,
  agentId: string,
): string {
  const digest = createHash('sha256')
    .update(`${runId}\0${seat}\0${String(seatIndex)}\0${agentId}`)
    .digest('hex')
    .slice(0, 16);
  return `council_participant_${seat}_${String(seatIndex)}_${digest}`;
}
