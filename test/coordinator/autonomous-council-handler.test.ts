import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import { AutonomousCouncilHandler } from '../../src/coordinator/handlers/autonomous-council-handler';
import type { CouncilProvider, CouncilRunResult, Review } from '../../src/council';

describe('AutonomousCouncilHandler', () => {
  it('returns a verified CouncilResult for an approved synthesis artifact', async () => {
    const finalArtifact = artifact('artifact_synthesis', 'final.ts', 'verified output\n');
    const handler = new AutonomousCouncilHandler({
      councilProvider: provider(runResult({ finalArtifact, reviews: [review('approve')] })),
    });

    const output = await handler.execute(request());

    expect(output.final_artifact.artifact_id).toBe('artifact_synthesis');
    expect(output.council_result).toEqual({
      quality: 'verified',
      final_artifact_ref: 'artifact_synthesis',
      final_artifact_sha256: sha('verified output\n'),
      warnings: [],
      unmet_criteria: [],
      verification_refs: ['review_approve'],
      decision_record_ref: 'decision_001',
    });
    expect(output.council_run_result.result).toEqual(output.council_result);
  });

  it('automatically completes with best_effort when review criteria remain unmet', async () => {
    const finalArtifact = artifact('artifact_synthesis', 'final.ts', 'best effort\n');
    const handler = new AutonomousCouncilHandler({
      councilProvider: provider(
        runResult({ finalArtifact, reviews: [review('needs_revision', ['tests'])] }),
      ),
    });

    const output = await handler.execute(request());

    expect(output.council_result).toMatchObject({
      quality: 'best_effort',
      final_artifact_ref: 'artifact_synthesis',
      warnings: ['Council verification did not fully pass; delivering the best available artifact.'],
      unmet_criteria: ['tests'],
    });
  });

  it('falls back to the highest-ranked materializable proposal when synthesis is unavailable', async () => {
    const proposalA = artifact('artifact_a', 'a.ts', 'A\n');
    const proposalB = artifact('artifact_b', 'b.ts', 'B\n');
    const value = runResult({
      finalArtifact: undefined,
      proposalArtifacts: [proposalA, proposalB],
      reviews: [review('reject', ['correctness'], 'proposal_a'), review('approve', [], 'proposal_b')],
    });
    const handler = new AutonomousCouncilHandler({ councilProvider: provider(value) });

    const output = await handler.execute(request());

    expect(output.final_artifact.artifact_id).toBe('artifact_b');
    expect(output.council_result).toMatchObject({
      quality: 'best_effort',
      final_artifact_ref: 'artifact_b',
      warnings: expect.arrayContaining(['Council synthesis was unavailable; selected a reviewed proposal.']),
    });
  });

  it('fails only when no participant produced a materializable artifact', async () => {
    const handler = new AutonomousCouncilHandler({
      councilProvider: provider(runResult({ finalArtifact: undefined, proposalArtifacts: [] })),
    });

    await expect(handler.execute(request())).rejects.toThrow(
      'Council produced no materializable artifact',
    );
  });
});

function request() {
  return {
    run_id: 'run_001',
    task_id: 'task_001',
    trigger: 'user_choice' as const,
    decision_mode: 'advisory' as const,
    question: 'Produce the final artifact.',
    proposals: [],
    schema_version: SCHEMA_VERSION,
  };
}

function provider(result: CouncilRunResult): CouncilProvider {
  return { async runCouncilRound() { return result; } };
}

function runResult(input: {
  finalArtifact?: ArtifactRef;
  proposalArtifacts?: ArtifactRef[];
  reviews?: Review[];
}): CouncilRunResult {
  const proposalArtifacts = input.proposalArtifacts ?? [];
  return {
    council_run_id: 'council_run_001',
    run_id: 'run_001',
    task_id: 'task_001',
    proposals: proposalArtifacts.map((item, index) => ({
      proposal_id: `proposal_${index === 0 ? 'a' : 'b'}`,
      run_id: 'run_001',
      task_id: 'task_001',
      artifact_refs: [item.artifact_id],
      summary: 'proposal',
      affected_paths: [item.content!.target_path!],
      assumptions: [],
      known_risks: [],
      completion_evidence: [],
      created_at: '2026-07-18T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    })),
    reviews: input.reviews ?? [],
    ...(input.finalArtifact
      ? {
          synthesis: {
            synthesis_id: 'synthesis_001',
            run_id: 'run_001',
            task_id: 'task_001',
            synthesizer_id: 'synthesizer',
            input_proposal_ids: [],
            input_review_ids: [],
            artifact_refs: [input.finalArtifact.artifact_id],
            summary: 'synthesis',
            created_at: '2026-07-18T00:00:00.000Z',
            schema_version: SCHEMA_VERSION,
          },
        }
      : {}),
    decision: {
      decision_id: 'decision_001',
      run_id: 'run_001',
      task_id: 'task_001',
      decision_mode: 'advisory',
      selected_artifact_refs: input.finalArtifact ? [input.finalArtifact.artifact_id] : [],
      verdict: input.finalArtifact ? 'select' : 'request_revision',
      reason: 'decision',
      evidence_refs: [],
      can_create_merge_authorization: false,
      created_at: '2026-07-18T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    },
    generated_artifact_refs: [
      ...proposalArtifacts,
      ...(input.finalArtifact ? [input.finalArtifact] : []),
    ],
    selected_artifact_refs: input.finalArtifact ? [input.finalArtifact.artifact_id] : [],
    created_at: '2026-07-18T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function review(
  verdict: Review['verdict'],
  unmetCriteria: string[] = [],
  proposalId = 'proposal_a',
): Review {
  return {
    review_id: `review_${verdict}`,
    proposal_id: proposalId,
    reviewer_id: 'reviewer',
    verdict,
    reason: verdict,
    unmet_criteria: unmetCriteria,
    evidence_refs: [],
    created_at: '2026-07-18T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function artifact(id: string, targetPath: string, body: string): ArtifactRef {
  return {
    artifact_id: id,
    type: 'diff',
    uri: `artifact://diff/${id}`,
    producer_id: 'agent',
    task_id: 'task_001',
    content: {
      kind: 'text',
      content_ref: `data:text/plain,${encodeURIComponent(body)}`,
      target_path: targetPath,
    },
    created_at: '2026-07-18T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function sha(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}
