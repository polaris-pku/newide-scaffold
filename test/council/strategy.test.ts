import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, nowTimestamp, type ArtifactRef } from '../../src/core';
import type {
  CouncilProvider,
  CouncilRunResult,
  CouncilRoundInput,
  Proposal,
  Review,
} from '../../src/council';
import {
  createCouncilStrategyProvider,
  readCouncilStrategy,
} from '../../src/council';

describe('Council strategy boundary', () => {
  it('defaults to classic and preserves the provider result', async () => {
    const original = councilResult();
    const provider = createCouncilStrategyProvider(staticProvider(original));

    expect(readCouncilStrategy(undefined)).toBe('classic');
    expect(provider.strategyName).toBe('classic');
    await expect(provider.runCouncilRound(baseInput())).resolves.toMatchObject({
      council_run_id: original.council_run_id,
      outcome: {
        status: 'completed',
        quality: 'best_effort',
        selected_artifact_refs: ['artifact_final'],
      },
    });
  });

  it('accepts an adaptive lead result when independent evidence is present', async () => {
    const result = councilResult({ adaptive: true });
    const provider = createCouncilStrategyProvider(staticProvider(result), 'adaptive_lead');

    const output = await provider.runCouncilRound(baseInput());

    expect(output.outcome).toMatchObject({
      status: 'completed',
      participant_role_ids: ['role_a', 'role_b', 'role_reviewer', 'role_lead'],
      selected_artifact_refs: ['artifact_final'],
    });
    expect(output.outcome?.unresolved_issues).toEqual([]);
  });

  it('completes after selecting a final artifact while preserving adaptive warnings', async () => {
    const result = councilResult();
    const provider = createCouncilStrategyProvider(staticProvider(result), 'adaptive_lead');

    const output = await provider.runCouncilRound(baseInput());

    expect(output.outcome?.status).toBe('completed');
    expect(output.outcome?.quality).toBe('best_effort');
    expect(output.outcome?.unresolved_issues).toContain(
      'proposal proposal_b lacks a review by another role_id',
    );
  });

  it('rejects an unknown strategy instead of silently falling back', () => {
    expect(() => readCouncilStrategy('unknown')).toThrow('NEWIDE_COUNCIL_STRATEGY');
  });
});

function staticProvider(result: CouncilRunResult): CouncilProvider {
  return {
    async runCouncilRound(_input: CouncilRoundInput) {
      return result;
    },
  };
}

function baseInput(): CouncilRoundInput {
  return {
    run_id: 'run_strategy',
    task_id: 'task_strategy',
    trigger: 'manual',
    decision_mode: 'advisory',
    question: 'Choose a candidate.',
    proposals: [],
    schema_version: SCHEMA_VERSION,
  };
}

function councilResult(options: { adaptive?: boolean } = {}): CouncilRunResult {
  const proposalA = proposal('proposal_a', 'role_a', 'artifact_a');
  const proposalB = proposal('proposal_b', 'role_b', 'artifact_b');
  const reviews: Review[] = [
    review('review_a', proposalA.proposal_id, 'role_reviewer'),
    review(
      'review_b',
      proposalB.proposal_id,
      options.adaptive ? 'role_reviewer' : 'role_b',
    ),
  ];
  const finalArtifact = artifact('artifact_final');
  return {
    council_run_id: 'council_strategy_001',
    run_id: 'run_strategy',
    task_id: 'task_strategy',
    participants: [
      participant('participant_a', 'proposer', 0, 'role_a'),
      participant('participant_b', 'proposer', 1, 'role_b'),
      participant('participant_reviewer', 'reviewer', 0, 'role_reviewer'),
      participant('participant_lead', 'synthesizer', 0, 'role_lead'),
    ],
    proposals: [proposalA, proposalB],
    reviews,
    synthesis: {
      synthesis_id: 'synthesis_001',
      run_id: 'run_strategy',
      task_id: 'task_strategy',
      synthesizer_id: 'role_lead',
      input_proposal_ids: [proposalA.proposal_id, proposalB.proposal_id],
      input_review_ids: reviews.map((reviewItem) => reviewItem.review_id),
      artifact_refs: [finalArtifact.artifact_id],
      summary: 'lead synthesis',
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    },
    decision: {
      decision_id: 'decision_001',
      run_id: 'run_strategy',
      task_id: 'task_strategy',
      decision_mode: 'advisory',
      selected_artifact_refs: [finalArtifact.artifact_id],
      verdict: 'select',
      reason: 'lead selected the final artifact',
      evidence_refs: ['synthesis_001'],
      can_create_merge_authorization: false,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    },
    generated_artifact_refs: [finalArtifact],
    selected_artifact_refs: [finalArtifact.artifact_id],
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function participant(
  participantId: string,
  seat: 'proposer' | 'reviewer' | 'synthesizer',
  seatIndex: number,
  agentId: string,
) {
  return {
    participant_id: participantId,
    seat,
    seat_index: seatIndex,
    agent_id: agentId,
  };
}

function proposal(proposalId: string, agentId: string, artifactId: string): Proposal {
  return {
    proposal_id: proposalId,
    run_id: 'run_strategy',
    task_id: 'task_strategy',
    agent_id: agentId,
    artifact_refs: [artifactId],
    summary: proposalId,
    claims: [],
    affected_paths: [],
    assumptions: [],
    known_risks: [],
    completion_evidence: [],
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function review(reviewId: string, proposalId: string, reviewerId: string): Review {
  return {
    review_id: reviewId,
    proposal_id: proposalId,
    reviewer_id: reviewerId,
    verdict: 'approve',
    reason: 'reviewed',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function artifact(artifactId: string): ArtifactRef {
  return {
    artifact_id: artifactId,
    type: 'patch',
    uri: `artifact://patch/${artifactId}`,
    producer_id: 'role_lead',
    task_id: 'task_strategy',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}
