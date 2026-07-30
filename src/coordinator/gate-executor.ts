import { SCHEMA_VERSION, createId, nowTimestamp } from '../core';
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

/**
 * The compatibility flow may deliver best-effort output when no production Gate
 * is configured, but this result is task-scoped rather than criterion-scoped and
 * therefore can never produce a verified RunOutcome.
 */
export class BestEffortGateExecutor implements IntegrationV0GateExecutor {
  async execute(input: GateExecutionInput): Promise<GateExecutionResult> {
    const hookPoint =
      input.phase === 'post_council' ? 'council.completed' : 'task.completed';
    return {
      hook_point: hookPoint,
      matched: false,
      gate_results: [
        {
          gate_result_id: createId('gate_result'),
          gate_id: 'best-effort-delivery',
          gate_point: hookPoint,
          request_id: createId('gate_request'),
          subject_id: input.task_id,
          subject_type: 'task',
          decision: 'allow',
          reason:
            'No executable production Gate is configured; delivery may continue as best_effort.',
          required_actions: ['configure-production-gate'],
          target_state: 'reviewing',
          created_at: nowTimestamp(),
          schema_version: SCHEMA_VERSION,
        },
      ],
    };
  }
}
