import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, createId } from '../../src/core';
import type { GateResult } from '../../src/gate';
import {
  completionCriterionId,
  evaluateCompletionCriteria,
  type CompletionCriteriaEvaluationInput,
} from '../../src/coordinator/completion-criteria-evaluator';

describe('evaluateCompletionCriteria', () => {
  it('marks a run verified only when every criterion has audited allow evidence', () => {
    const criterion = 'Generated TypeScript passes the configured command gate';
    const result = evaluateCompletionCriteria({
      ...baseInput(),
      completion_criteria: [criterion],
      gate_results: [
        gateResult({
          subject_id: completionCriterionId(criterion, 0),
          subject_type: 'completion_criterion',
          decision: 'allow',
          audit_ref: 'file:///audit/gate-result.json',
        }),
      ],
    });

    expect(result.outcome).toMatchObject({
      status: 'verified',
      criteria: [
        {
          description: criterion,
          status: 'satisfied',
          audit_refs: ['file:///audit/gate-result.json'],
        },
      ],
    });
  });

  it('keeps successful output best_effort when criteria lack scoped evidence', () => {
    const result = evaluateCompletionCriteria(baseInput());

    expect(result.outcome.status).toBe('best_effort');
    expect(result.outcome.criteria[0]).toMatchObject({ status: 'unverified' });
  });

  it('blocks completion when required Gate evidence is absent', () => {
    const result = evaluateCompletionCriteria({ ...baseInput(), gate_results: [] });

    expect(result.outcome.status).toBe('blocked');
  });

  it('fails when a Gate denies the output', () => {
    const result = evaluateCompletionCriteria({
      ...baseInput(),
      gate_results: [gateResult({ decision: 'deny' })],
    });

    expect(result.outcome.status).toBe('failed');
  });

  it('does not treat a response-free and change-free run as complete', () => {
    const result = evaluateCompletionCriteria({
      ...baseInput(),
      artifact_manifest: {
        artifact_refs: [],
        changed_files: [],
        response_available: false,
        has_materializable_artifact: false,
        materialization_status: 'completed',
      },
    });

    expect(result.outcome.status).toBe('failed');
  });
});

function baseInput(): CompletionCriteriaEvaluationInput {
  return {
    completion_criteria: ['A real completion criterion'],
    gate_results: [gateResult({ decision: 'allow' })],
    artifact_manifest: {
      artifact_refs: ['artifact_1'],
      changed_files: ['src/result.ts'],
      response_available: true,
      has_materializable_artifact: true,
      materialization_status: 'completed',
    },
    execution_succeeded: true,
  };
}

function gateResult(overrides: Partial<GateResult>): GateResult {
  return {
    gate_result_id: createId('gate_result'),
    gate_id: 'completion-gate',
    gate_point: 'task.completed',
    request_id: createId('gate_request'),
    decision: 'allow',
    reason: 'Gate completed.',
    required_actions: [],
    created_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
    ...overrides,
  };
}
