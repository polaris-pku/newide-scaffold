import type { GateResult } from '../gate';

export type ProductionGatePhase = 'pre_selection' | 'pre_council' | 'post_council';

export interface GateExecutionInput {
  run_id: string;
  task_id: string;
  phase: ProductionGatePhase;
  workspace_path: string;
  completion_criteria: readonly string[];
  artifact_refs: readonly string[];
}

export interface GateExecutionResult {
  hook_point: 'task.completed' | 'council.completed';
  matched: boolean;
  gate_results: GateResult[];
}

export interface IntegrationV0GateExecutor {
  execute(input: GateExecutionInput): Promise<GateExecutionResult>;
}

/** No production Gate is configured. Materialization and delivery still proceed. */
export class BestEffortGateExecutor implements IntegrationV0GateExecutor {
  async execute(input: GateExecutionInput): Promise<GateExecutionResult> {
    const hookPoint =
      input.phase === 'post_council' ? 'council.completed' : 'task.completed';
    return {
      hook_point: hookPoint,
      matched: false,
      gate_results: [],
    };
  }
}
