import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentExecutionResult } from '../protocol/agent-execution';
import type { CouncilParticipantBinding } from './council-participant';
import type { Proposal } from './contract';

export interface CouncilRoleRecovery {
  prepared: boolean;
  /** False proves interruption happened before the first Driver dispatch. */
  driver_dispatched?: boolean;
  workspace_before: Array<[string, string]>;
  session_id?: string;
  execution?: { result: AgentExecutionResult; phase_id: string };
}

interface CouncilRecoveryState {
  task_id: string;
  council_run_id: string;
  participants: CouncilParticipantBinding[];
  initial_proposals: Proposal[];
  proposals: Record<string, Proposal>;
  roles: Record<string, CouncilRoleRecovery>;
}

/** One file outside the role workspaces; atomic writes also run before stream callbacks. */
export class CouncilRecovery {
  private constructor(readonly file: string, readonly state: CouncilRecoveryState) {}

  static read(file: string, taskId: string): CouncilRecovery | undefined {
    let state: CouncilRecoveryState;
    try {
      state = JSON.parse(readFileSync(file, 'utf8')) as CouncilRecoveryState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (state.task_id !== taskId || !state.roles || !Array.isArray(state.participants)) {
      throw new Error('Invalid Council recovery state; refusing to restart the round');
    }
    return new CouncilRecovery(file, state);
  }

  static create(file: string, state: CouncilRecoveryState): CouncilRecovery {
    const recovery = new CouncilRecovery(file, state);
    recovery.save();
    return recovery;
  }

  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state));
    renameSync(temporary, this.file);
  }
}
