import { createHash } from 'node:crypto';

export type CouncilSeat = 'proposer' | 'reviewer' | 'synthesizer';

/**
 * Council 席位与真实持久化 Agent 的单轮绑定。
 *
 * participant_id 标识本轮参与实例；agent_id 始终指向 B 仓库中的真实 Agent。
 * 同一 Agent 在候选不足时可以承担多个席位，但必须通过 conflict_flags 显式披露。
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

