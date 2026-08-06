import type {
  CouncilExecutionOptions,
  CouncilOutcome,
  CouncilProvider,
  CouncilResult,
  CouncilRoundInput,
  CouncilRunResult,
} from './contract';

export type CouncilStrategyName = 'classic' | 'adaptive_lead';

export interface CouncilStrategy {
  readonly name: CouncilStrategyName;
  runCouncilRound(
    input: CouncilRoundInput,
    options?: CouncilExecutionOptions,
  ): Promise<CouncilRunResult>;
}

/**
 * Keeps the existing Council execution contract while publishing a stable
 * strategy-independent outcome envelope.
 */
export class ClassicCouncilStrategy implements CouncilStrategy {
  readonly name = 'classic' as const;

  constructor(private readonly provider: CouncilProvider) {}

  async runCouncilRound(
    input: CouncilRoundInput,
    options?: CouncilExecutionOptions,
  ): Promise<CouncilRunResult> {
    const result = await this.provider.runCouncilRound(input, options);
    return withOutcome(result, buildOutcome(result));
  }
}

/**
 * Adaptive process gaps remain auditable, but they do not override the
 * Council decision. A selected final artifact is sufficient for completion;
 * stricter quality attestation can evolve independently.
 */
export class AdaptiveLeadCouncilStrategy implements CouncilStrategy {
  readonly name = 'adaptive_lead' as const;

  constructor(private readonly provider: CouncilProvider) {}

  async runCouncilRound(
    input: CouncilRoundInput,
    options?: CouncilExecutionOptions,
  ): Promise<CouncilRunResult> {
    const result = await this.provider.runCouncilRound(input, options);
    const base = buildOutcome(result);
    const unresolved = adaptiveUnresolvedIssues(result);
    const warnings = [...base.warnings, ...unresolved.map((issue) => `adaptive_lead: ${issue}`)];
    const outcome: CouncilOutcome = {
      ...base,
      unresolved_issues: [...base.unresolved_issues, ...unresolved],
      warnings,
    };
    return withOutcome(result, outcome);
  }
}

export class StrategicCouncilProvider implements CouncilProvider {
  constructor(private readonly strategy: CouncilStrategy) {}

  get strategyName(): CouncilStrategyName {
    return this.strategy.name;
  }

  runCouncilRound(
    input: CouncilRoundInput,
    options?: CouncilExecutionOptions,
  ): Promise<CouncilRunResult> {
    return this.strategy.runCouncilRound(input, options);
  }
}

export function createCouncilStrategyProvider(
  provider: CouncilProvider,
  strategyName: CouncilStrategyName = readCouncilStrategy(),
): StrategicCouncilProvider {
  const strategy =
    strategyName === 'classic'
      ? new ClassicCouncilStrategy(provider)
      : new AdaptiveLeadCouncilStrategy(provider);
  return new StrategicCouncilProvider(strategy);
}

export function readCouncilStrategy(value = process.env.NEWIDE_COUNCIL_STRATEGY): CouncilStrategyName {
  const normalized = value?.trim() || 'classic';
  if (normalized === 'classic' || normalized === 'adaptive_lead') return normalized;
  throw new Error(
    `Unsupported NEWIDE_COUNCIL_STRATEGY: ${normalized}. Expected classic or adaptive_lead.`,
  );
}

export function reconcileCouncilOutcome(
  result: CouncilRunResult,
  councilResult: CouncilResult,
): CouncilRunResult {
  if (!result.outcome) return result;
  return {
    ...result,
    outcome: {
      ...result.outcome,
      quality: councilResult.quality,
      unresolved_issues: unique([
        ...result.outcome.unresolved_issues,
        ...councilResult.unmet_criteria,
      ]),
      warnings: unique([
        ...result.outcome.warnings.filter(
          (warning) => warning !== 'Council quality attestation is not available yet.',
        ),
        ...councilResult.warnings,
      ]),
    },
  };
}

function withOutcome(result: CouncilRunResult, outcome: CouncilOutcome): CouncilRunResult {
  return result.outcome ? result : { ...result, outcome };
}

function buildOutcome(result: CouncilRunResult): CouncilOutcome {
  const participantRoleIds = unique([
    ...(result.participants?.map((participant) => participant.agent_id) ?? []),
    ...result.proposals.flatMap((proposal) => (proposal.agent_id ? [proposal.agent_id] : [])),
    ...(result.synthesis ? [result.synthesis.synthesizer_id] : []),
  ]);
  const selectedArtifactRefs = [...result.selected_artifact_refs];
  const status =
    ['needs_human', 'request_revision', 'reject'].includes(result.decision.verdict) ||
    ['needs_human', 'request_revision', 'rejected'].includes(result.output?.status ?? '')
      ? 'needs_human'
      : result.decision.verdict === 'select' && selectedArtifactRefs.length > 0
        ? 'completed'
        : 'failed';
  const warnings = [...(result.result?.warnings ?? [])];
  if (!result.result) warnings.push('Council quality attestation is not available yet.');
  return {
    status,
    participant_role_ids: participantRoleIds,
    selected_artifact_refs: selectedArtifactRefs,
    decision_summary: result.decision.reason,
    quality: result.result?.quality ?? 'best_effort',
    unresolved_issues: [...(result.result?.unmet_criteria ?? [])],
    warnings: unique(warnings),
    audit_refs: auditRefs(result),
  };
}

function adaptiveUnresolvedIssues(result: CouncilRunResult): string[] {
  const proposalAgentIds = result.proposals
    .map((proposal) => proposal.agent_id)
    .filter((agentId): agentId is string => Boolean(agentId));
  const distinctProposers = new Set(proposalAgentIds);
  const issues: string[] = [];
  if (distinctProposers.size < 2) {
    issues.push('at least two independent proposer role_ids are required');
  }
  for (const proposal of result.proposals) {
    const externallyReviewed = result.reviews.some(
      (review) =>
        review.proposal_id === proposal.proposal_id &&
        review.reviewer_id !== proposal.agent_id,
    );
    if (!externallyReviewed) {
      issues.push(`proposal ${proposal.proposal_id} lacks a review by another role_id`);
    }
  }
  const leadId = result.synthesis?.synthesizer_id;
  if (!leadId) {
    issues.push('a real lead synthesis is required');
  } else if (distinctProposers.has(leadId)) {
    issues.push(`lead ${leadId} is also a proposer; independent lead evidence is required`);
  }
  if (result.decision.verdict !== 'select' || result.selected_artifact_refs.length === 0) {
    issues.push('adaptive Council did not select a final artifact');
  }
  if (result.participants?.some((participant) => participant.conflict_flags?.length)) {
    issues.push('participant identity reuse was reported');
  }
  return unique(issues);
}

function auditRefs(result: CouncilRunResult): string[] {
  return unique([
    result.council_run_id,
    ...result.proposals.map((proposal) => proposal.proposal_id),
    ...result.reviews.map((review) => review.review_id),
    ...(result.synthesis ? [result.synthesis.synthesis_id] : []),
    result.decision.decision_id,
    ...(result.output ? [result.output.output_id] : []),
    ...(result.comparison_refs ?? []),
    ...(result.diagnostic_refs ?? []),
    ...(result.result?.verification_refs ?? []),
  ]);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
