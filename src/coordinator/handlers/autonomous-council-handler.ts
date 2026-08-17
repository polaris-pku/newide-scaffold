import type { ArtifactRef } from '../../core';
import {
  reconcileCouncilOutcome,
  type CouncilExecutionOptions,
  type CouncilProvider,
  type CouncilResult,
  type CouncilRunRequest,
  type CouncilRunResult,
  type Proposal,
  type Review,
} from '../../council';
import { isMaterializableFileArtifact, readArtifactBytes, sha256 } from '../artifact-content';

export interface AutonomousCouncilHandlerOptions {
  councilProvider: CouncilProvider;
}

export interface AutonomousCouncilExecution {
  council_run_result: CouncilRunResult;
  council_result: CouncilResult;
  final_artifact: ArtifactRef;
  final_artifacts: ArtifactRef[];
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
    const selected = materializableArtifacts(runResult.selected_artifact_refs, artifacts);
    const fallback = selected.length > 0
      ? []
      : selectReviewedProposalArtifacts(runResult.proposals, runResult.reviews, artifacts);
    const finalArtifacts = selected.length > 0 ? selected : fallback;
    const finalArtifact = finalArtifacts[0];
    if (!finalArtifact) throw new Error('Council produced no materializable artifact');

    const unmetCriteria = unique(
      runResult.reviews.flatMap((review) => review.unmet_criteria ?? []),
    );
    const fullyApproved =
      runResult.reviews.length > 0 &&
      runResult.reviews.every(
        (review) => review.verdict === 'approve' && (review.unmet_criteria?.length ?? 0) === 0,
      );
    const identityConflict = runResult.participants?.some((participant) =>
      participant.conflict_flags?.some((flag) =>
        ['agent_reused_across_council_seats', 'best_effort_identity'].includes(flag),
      ),
    );
    const verified = Boolean(
      selected.length > 0 && runResult.synthesis && fullyApproved && !identityConflict,
    );
    const warnings: string[] = [];
    if (fallback.length > 0) {
      warnings.push('Council synthesis was unavailable; selected the best available proposal.');
    }
    if (identityConflict) {
      warnings.push('Council reused a persisted Agent across seats; identity reuse was audited.');
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
    const councilRunResult = reconcileCouncilOutcome(
      { ...runResult, result: councilResult },
      councilResult,
    );
    return {
      council_run_result: councilRunResult,
      council_result: councilResult,
      final_artifact: finalArtifact,
      final_artifacts: finalArtifacts,
    };
  }
}

function materializableArtifacts(
  artifactIds: readonly string[],
  artifacts: ReadonlyMap<string, ArtifactRef>,
): ArtifactRef[] {
  return artifactIds
    .map((artifactId) => artifacts.get(artifactId))
    .filter(
      (artifact): artifact is ArtifactRef =>
        Boolean(artifact && isMaterializableFileArtifact(artifact)),
    );
}

function selectReviewedProposalArtifacts(
  proposals: readonly Proposal[],
  reviews: readonly Review[],
  artifacts: ReadonlyMap<string, ArtifactRef>,
): ArtifactRef[] {
  const reviewScore = new Map<string, number>();
  for (const review of reviews) {
    const score = review.verdict === 'approve' ? 2 : review.verdict === 'needs_revision' ? 1 : 0;
    reviewScore.set(review.proposal_id, Math.max(reviewScore.get(review.proposal_id) ?? -1, score));
  }
  const selectedProposal = proposals
    .map((proposal, index) => ({
      proposal,
      index,
      score: reviewScore.get(proposal.proposal_id) ?? 0,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.proposal;
  if (!selectedProposal) return [];
  return selectedProposal.artifact_refs
    .map((artifactId) => artifacts.get(artifactId))
    .filter(
      (artifact): artifact is ArtifactRef =>
        Boolean(artifact && isMaterializableFileArtifact(artifact)),
    );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
