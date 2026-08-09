export type RunOutcomeStatus =
  | 'completed'
  | 'verified'
  | 'best_effort'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export type CompletionCriterionStatus = 'satisfied' | 'failed' | 'unverified';

export interface CompletionCriterionResult {
  criterion_id: string;
  description: string;
  status: CompletionCriterionStatus;
  gate_result_refs: string[];
  audit_refs: string[];
}

export interface RunOutcome {
  status: RunOutcomeStatus;
  reason: string;
  criteria: CompletionCriterionResult[];
  gate_result_refs: string[];
  artifact_refs: string[];
}

export function isCompletedRunOutcome(status: RunOutcomeStatus): boolean {
  return status === 'completed' || status === 'verified' || status === 'best_effort';
}
