import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import type { DriverRunResult } from '../../src/driver';
import type { GateResult } from '../../src/gate';
import { buildCouncilProposalFromDriverResult } from '../../src/council/proposal-adapter';

describe('buildCouncilProposalFromDriverResult', () => {
  it('preserves the primary response and normalized report evidence', () => {
    const driver = createDriverResult([]);
    driver.response = 'Implemented bounded input validation.';
    expect(
      buildCouncilProposalFromDriverResult({
        run_id: 'run',
        task_id: 'task',
        driver_result: driver,
        gate_results: [],
      }).summary,
    ).toBe(driver.response);
    driver.diagnostics.driver_report = {
      summary: 'Reject invalid CSV header offsets.',
      artifacts: [],
      decisions: [
        {
          point: 'Validate header',
          options: ['early', 'late'],
          chosen: 'early',
          reason: 'Avoid indexing invalid input',
        },
      ],
      assumptions: [{ assumption: 'Header is nonnegative', risk_if_wrong: 'Wrong row selected' }],
      blockers: [
        { blocker: 'Integration tests unavailable', attempts: [], resolution: '', resolved: false },
      ],
      referenced_experiences: [],
    };
    const proposal = buildCouncilProposalFromDriverResult({
      run_id: 'run',
      task_id: 'task',
      driver_result: driver,
      gate_results: [],
    });
    expect(proposal.summary).toBe('Reject invalid CSV header offsets.');
    expect(proposal.claims?.[0]?.statement).toContain('Avoid indexing invalid input');
    expect(proposal.assumptions).toEqual(['Header is nonnegative']);
    expect(proposal.known_risks).toEqual(['Wrong row selected', 'Integration tests unavailable']);
  });
  it('builds a council proposal from driver artifacts and gate evidence', () => {
    const driverResult = createDriverResult([
      createArtifact('artifact_patch_001'),
      createArtifact('artifact_test_001'),
    ]);
    const gateResults = [createGateResult('gate_result_001'), createGateResult('gate_result_002')];

    const proposal = buildCouncilProposalFromDriverResult({
      run_id: 'run_001',
      task_id: 'task_001',
      driver_result: driverResult,
      gate_results: gateResults,
    });

    expect(proposal).toMatchObject({
      proposal_id: expect.stringMatching(/^proposal_/),
      run_id: 'run_001',
      task_id: 'task_001',
      agent_id: 'driver_001',
      artifact_refs: ['artifact_patch_001', 'artifact_test_001'],
      summary: 'Driver output artifacts for council review',
      claims: [],
      affected_paths: [],
      assumptions: [],
      known_risks: [],
      completion_evidence: ['gate_result_001', 'gate_result_002'],
      schema_version: SCHEMA_VERSION,
    });
    expect(proposal.created_at).toEqual(expect.any(String));
  });
});

function createArtifact(artifactId: string): ArtifactRef {
  return {
    artifact_id: artifactId,
    type: 'patch',
    uri: `artifact://patch/${artifactId}`,
    producer_id: 'driver_001',
    task_id: 'task_001',
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function createDriverResult(artifacts: ArtifactRef[]): DriverRunResult {
  return {
    driver_run_result_id: 'driver_result_001',
    session_id: 'session_001',
    status: 'succeeded',
    artifacts,
    transcript_ref: {
      artifact_id: 'artifact_transcript_001',
      type: 'transcript',
      uri: 'artifact://transcript/001',
      producer_id: 'driver_001',
      task_id: 'task_001',
      created_at: '2026-07-07T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    },
    tool_events: [],
    diagnostics: {
      driver_id: 'driver_001',
      duration_ms: 100,
      notes: [],
    },
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function createGateResult(gateResultId: string): GateResult {
  return {
    gate_result_id: gateResultId,
    gate_id: 'gate_001',
    gate_point: 'artifact.finalize',
    request_id: `request_${gateResultId}`,
    decision: 'allow',
    reason: 'ok',
    required_actions: [],
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
