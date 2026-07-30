import { createHash } from 'node:crypto';
import type { GateResult } from '../gate';
import type {
  CompletionCriterionResult,
  RunOutcome,
  RunOutcomeStatus,
} from './run-outcome';

export interface CompletionArtifactManifest {
  artifact_refs: string[];
  changed_files: string[];
  response_available: boolean;
  has_materializable_artifact: boolean;
  materialization_status: 'completed' | 'partial' | 'failed';
}

export interface CompletionCriteriaEvaluationInput {
  completion_criteria: readonly string[];
  gate_results: readonly GateResult[];
  artifact_manifest: CompletionArtifactManifest;
  execution_succeeded: boolean;
  cancelled?: boolean;
}

export interface CompletionCriteriaEvaluation {
  outcome: RunOutcome;
  artifact_manifest: CompletionArtifactManifest;
}

/**
 * Completion criteria are verified only by criterion-scoped Gate evidence.
 * A successful Driver and changed files are useful delivery evidence, but cannot
 * by themselves prove an arbitrary natural-language acceptance criterion.
 */
export function evaluateCompletionCriteria(
  input: CompletionCriteriaEvaluationInput,
): CompletionCriteriaEvaluation {
  const criteria = input.completion_criteria.map((description, index) =>
    evaluateCriterion(description, index, input.gate_results),
  );
  const status = determineOutcomeStatus(input, criteria);
  return {
    outcome: {
      status,
      reason: outcomeReason(status, criteria),
      criteria,
      gate_result_refs: input.gate_results.map((result) => result.gate_result_id),
      artifact_refs: [...input.artifact_manifest.artifact_refs],
    },
    artifact_manifest: {
      ...input.artifact_manifest,
      artifact_refs: [...input.artifact_manifest.artifact_refs],
      changed_files: [...input.artifact_manifest.changed_files],
    },
  };
}

export function completionCriterionId(description: string, index: number): string {
  const digest = createHash('sha256')
    .update(`${String(index)}\0${description}`)
    .digest('hex')
    .slice(0, 24);
  return `completion_criterion_${digest}`;
}

function evaluateCriterion(
  description: string,
  index: number,
  gateResults: readonly GateResult[],
): CompletionCriterionResult {
  const criterionId = completionCriterionId(description, index);
  const matching = gateResults.filter(
    (result) =>
      result.subject_type === 'completion_criterion' && result.subject_id === criterionId,
  );
  const failed = matching.some((result) => result.decision === 'deny');
  const verified = matching.some(
    (result) =>
      result.decision === 'allow' &&
      typeof result.audit_ref === 'string' &&
      result.audit_ref.length > 0,
  );
  return {
    criterion_id: criterionId,
    description,
    status: failed ? 'failed' : verified ? 'satisfied' : 'unverified',
    gate_result_refs: matching.map((result) => result.gate_result_id),
    audit_refs: matching.flatMap((result) => (result.audit_ref ? [result.audit_ref] : [])),
  };
}

function determineOutcomeStatus(
  input: CompletionCriteriaEvaluationInput,
  criteria: readonly CompletionCriterionResult[],
): RunOutcomeStatus {
  if (input.cancelled) return 'cancelled';
  if (!input.execution_succeeded) return 'failed';
  if (input.gate_results.some((result) => result.decision === 'deny')) return 'failed';
  if (
    input.gate_results.length === 0 ||
    input.gate_results.some(
      (result) => result.decision === 'ask' || result.decision === 'defer',
    )
  ) {
    return 'blocked';
  }
  if (
    input.artifact_manifest.materialization_status === 'failed' ||
    input.artifact_manifest.materialization_status === 'partial'
  ) {
    return 'failed';
  }
  const hasOutput =
    input.artifact_manifest.changed_files.length > 0 ||
    input.artifact_manifest.response_available;
  if (!hasOutput) return 'failed';
  if (
    criteria.length > 0 &&
    criteria.every((criterion) => criterion.status === 'satisfied')
  ) {
    return 'verified';
  }
  return 'best_effort';
}

function outcomeReason(
  status: RunOutcomeStatus,
  criteria: readonly CompletionCriterionResult[],
): string {
  switch (status) {
    case 'verified':
      return 'All completion criteria have criterion-scoped Gate evidence.';
    case 'best_effort':
      return criteria.length === 0
        ? 'Deliverable output exists, but the task defines no completion criteria.'
        : 'Deliverable output exists, but one or more completion criteria lack verified evidence.';
    case 'blocked':
      return 'Required Gate evidence is missing or awaiting a decision.';
    case 'cancelled':
      return 'Execution was cancelled before completion could be evaluated.';
    case 'failed':
      return 'Execution, Gate, or deliverable evidence failed.';
  }
}
