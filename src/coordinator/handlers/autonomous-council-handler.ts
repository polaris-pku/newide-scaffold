import type { ArtifactRef } from '../../core';
import type {
  CouncilExecutionOptions,
  CouncilProvider,
  CouncilResult,
  CouncilRunRequest,
  CouncilRunResult,
  Proposal,
  Review,
} from '../../council';
import { isMaterializableFileArtifact, readArtifactBytes, sha256 } from '../artifact-content';

export interface AutonomousCouncilHandlerOptions {
  councilProvider: CouncilProvider;
}

export interface AutonomousCouncilExecution {
  council_run_result: CouncilRunResult;
  council_result: CouncilResult;
  final_artifact: ArtifactRef;
}

export class AutonomousCouncilHandler {
  constructor(private readonly options: AutonomousCouncilHandlerOptions) {}

  async execute(
    input: CouncilRunRequest,
    options?: CouncilExecutionOptions,
  ): Promise<AutonomousCouncilExecution> {
    const runResult = await this.options.councilProvider.runCouncilRound(input, options);
    const artifacts = new Map(
      [...(input.candidate_artifacts ?? []), ...runResult.generated_artifact_refs].map((artifact) => [
        artifact.artifact_id,
        artifact,
      ]),
    );
    const selected = firstMaterializable(runResult.selected_artifact_refs, artifacts);
    const fallback = selected ? undefined : selectReviewedProposal(runResult.proposals, runResult.reviews, artifacts);
    const finalArtifact = selected ?? fallback;
    if (!finalArtifact) throw new Error('Council produced no materializable artifact');

    const unmetCriteria = unique(
      runResult.reviews.flatMap((review) => review.unmet_criteria ?? []),
    );
    const fullyApproved =
      runResult.reviews.length > 0 &&
      runResult.reviews.every(
        (review) => review.verdict === 'approve' && (review.unmet_criteria?.length ?? 0) === 0,
      );
    const verified = Boolean(selected && runResult.synthesis && fullyApproved);
    const warnings: string[] = [];
    if (fallback) warnings.push('Council synthesis was unavailable; selected a reviewed proposal.');
    if (!verified) {
      warnings.push(
        'Council verification did not fully pass; delivering the best available artifact.',
      );
    }
    const councilResult: CouncilResult = {
      quality: verified ? 'verified' : 'best_effort',
      final_artifact_ref: finalArtifact.artifact_id,
      final_artifact_sha256: sha256(await readArtifactBytes(finalArtifact)),
      warnings,
      unmet_criteria: unmetCriteria,
      verification_refs: runResult.reviews.map((review) => review.review_id),
      decision_record_ref: runResult.decision.decision_id,
    };
    const councilRunResult = { ...runResult, result: councilResult };
    return { council_run_result: councilRunResult, council_result: councilResult, final_artifact: finalArtifact };
  }
}

function firstMaterializable(
  artifactIds: readonly string[],
  artifacts: ReadonlyMap<string, ArtifactRef>,
): ArtifactRef | undefined {
  return artifactIds
    .map((artifactId) => artifacts.get(artifactId))
    .find((artifact): artifact is ArtifactRef => Boolean(artifact && isMaterializableFileArtifact(artifact)));
}

function selectReviewedProposal(
  proposals: readonly Proposal[],
  reviews: readonly Review[],
  artifacts: ReadonlyMap<string, ArtifactRef>,
): ArtifactRef | undefined {
  const reviewScore = new Map<string, number>();
  for (const review of reviews) {
    const score = review.verdict === 'approve' ? 2 : review.verdict === 'needs_revision' ? 1 : 0;
    reviewScore.set(review.proposal_id, Math.max(reviewScore.get(review.proposal_id) ?? -1, score));
  }
  return proposals
    .map((proposal, index) => ({
      proposal,
      index,
      score: reviewScore.get(proposal.proposal_id) ?? 0,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .flatMap(({ proposal }) => proposal.artifact_refs)
    .map((artifactId) => artifacts.get(artifactId))
    .find((artifact): artifact is ArtifactRef => Boolean(artifact && isMaterializableFileArtifact(artifact)));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
