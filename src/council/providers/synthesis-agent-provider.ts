/**
 * SynthesisAgentCouncilProvider
 *
 * Council 的真实 agent-backed MVP provider。它只依赖 B 方向 AgentExecutionFacade，
 * 不直接调用 A 方向 DriverRuntimeHandle。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from '../../core';
import { isMaterializableFileArtifact } from '../../coordinator/artifact-content';
import type { AgentExecutionFacade, AgentExecutionResult } from '../../protocol/agent-execution';
import type { CouncilParticipantResolver } from '../council-participant-resolver';
import type {
  CouncilParticipantBinding,
  CouncilSeat,
} from '../council-participant';
import type {
  CouncilArtifactMode,
  CouncilDecision,
  CouncilExecutionOptions,
  CouncilLifecycleEvent,
  CouncilOutput,
  CouncilProvider,
  CouncilRunResult,
  CouncilRoundInput,
  CouncilSynthesis,
  Proposal,
  Review,
} from '../contract';
import {
  councilRunWorkspaceRoot,
  prepareCouncilWorkspace,
  stageCouncilArtifacts,
} from '../council-workspace';
import { assertCouncilPlanArtifacts } from '../plan-artifact';

export type CouncilRoleFailureCode =
  | 'COUNCIL_PROPOSAL_FAILED'
  | 'COUNCIL_REVIEW_FAILED'
  | 'COUNCIL_SYNTHESIS_FAILED';

type CouncilPhase = 'proposal' | 'review' | 'synthesis';
type CouncilRoleFailureDetails = Record<string, unknown>;

export class CouncilRoleExecutionError extends Error {
  readonly code: CouncilRoleFailureCode;
  readonly phase = 'council';

  constructor(
    readonly council_phase: CouncilPhase,
    readonly participant: CouncilParticipantBinding,
    readonly agent_status: AgentExecutionResult['status'],
    readonly agent_run_id?: string,
    readonly driver_run_result_id?: string,
    readonly failure_details: CouncilRoleFailureDetails = {},
  ) {
    super(`Council ${council_phase} role failed`);
    this.name = 'CouncilRoleExecutionError';
    this.code = failureCode(council_phase);
  }

  get details(): Record<string, unknown> {
    return {
      phase: this.phase,
      council_phase: this.council_phase,
      ...participantAuditPayload(this.participant),
      agent_status: this.agent_status,
      ...(this.agent_run_id ? { agent_run_id: this.agent_run_id } : {}),
      ...(this.driver_run_result_id ? { driver_run_result_id: this.driver_run_result_id } : {}),
      ...(Object.keys(this.failure_details).length > 0
        ? { failure_details: { ...this.failure_details } }
        : {}),
    };
  }
}

export interface SynthesisAgentCouncilProviderOptions {
  agentExecutionFacade: AgentExecutionFacade;
  participantResolver?: CouncilParticipantResolver;
  councilRoot?: string;
}

export class SynthesisAgentCouncilProvider implements CouncilProvider {
  private readonly agentExecutionFacade: AgentExecutionFacade;
  private readonly participantResolver: CouncilParticipantResolver | undefined;
  private readonly councilRoot: string;

  constructor(options: SynthesisAgentCouncilProviderOptions) {
    this.agentExecutionFacade = options.agentExecutionFacade;
    this.participantResolver = options.participantResolver;
    this.councilRoot = options.councilRoot ?? '.newide/council';
  }

  async runCouncilRound(
    input: CouncilRoundInput,
    options?: CouncilExecutionOptions,
  ): Promise<CouncilRunResult> {
    const executionRunId = input.run_id ?? createId('run');
    const participants = await this.resolveParticipants(input, executionRunId);
    const proposers = participants
      .filter((participant) => participant.seat === 'proposer')
      .sort((left, right) => left.seat_index - right.seat_index);
    const reviewerParticipant = requireSeat(participants, 'reviewer');
    const synthesizerParticipant = requireSeat(participants, 'synthesizer');
    const councilDir = councilRunWorkspaceRoot(this.councilRoot, executionRunId);
    const generatedResults: AgentExecutionResult[] = [];
    const diagnosticRefs: string[] = [];
    const generatedProposals: Proposal[] = [];
    const representedAgentIds = new Set(
      input.proposals.flatMap((proposal) => (proposal.agent_id ? [proposal.agent_id] : [])),
    );

    for (const proposal of input.proposals) {
      const participant = proposers.find(
        (candidate) => candidate.agent_id === proposal.agent_id,
      );
      if (participant) {
        await emitLifecycle(options, completedReusedProposalEvent(proposal, participant));
      }
    }

    for (const participant of proposers) {
      if (representedAgentIds.has(participant.agent_id)) continue;
      const label = String.fromCharCode(65 + participant.seat_index);
      const workspace = participantWorkspace(councilDir, participant);
      await prepareCouncilWorkspace(input.workspace_path, workspace);
      const result = await this.tryRunRole(
        input,
        executionRunId,
        participant,
        buildProposalInstruction(input.question, label, options?.artifact_mode),
        input.evidence_pack?.artifact_refs ?? [],
        'proposal',
        workspace,
        options,
        diagnosticRefs,
      );
      if (!result) continue;
      generatedResults.push(result);
      const proposal = buildProposal(input, participant, result);
      generatedProposals.push(proposal);
      await emitLifecycle(options, completedProposalEvent(proposal, participant, result));
    }

    const proposals = [...input.proposals, ...generatedProposals];
    const candidateArtifacts = [
      ...(input.candidate_artifacts ?? []),
      ...generatedResults.flatMap((result) => result.artifact_refs),
    ];
    const reviewerWorkspace = participantWorkspace(councilDir, reviewerParticipant);
    await prepareCouncilWorkspace(input.workspace_path, reviewerWorkspace);
    await stageCouncilArtifacts(reviewerWorkspace, candidateArtifacts);
    const reviewer = await this.tryRunRole(
      input,
      executionRunId,
      reviewerParticipant,
      buildReviewerInstruction(input.question, proposals, options?.artifact_mode),
      proposals.flatMap((proposal) => proposal.artifact_refs),
      'review',
      reviewerWorkspace,
      options,
      diagnosticRefs,
    );
    if (reviewer) generatedResults.push(reviewer);
    const reviews = buildReviews(proposals, reviewerParticipant, reviewer);
    if (reviewer) {
      await emitLifecycle(options, {
        type: 'council.review.completed',
        payload: {
          ...participantAuditPayload(reviewerParticipant),
          agent_run_id: reviewer.agent_run_id,
          driver_run_result_id: reviewer.driver_run_result_id,
          context_pack_ref: reviewer.context_pack_ref,
          memory_buffer_ref: reviewer.memory_buffer_ref,
          session_id: reviewer.session_id,
          proposal_ids: proposals.map((proposal) => proposal.proposal_id),
          review_ids: reviews.map((review) => review.review_id),
          artifact_refs: reviewer.artifact_refs.map((artifact) => artifact.artifact_id),
        },
      });
    }

    const synthesizerWorkspace = participantWorkspace(councilDir, synthesizerParticipant);
    await prepareCouncilWorkspace(input.workspace_path, synthesizerWorkspace);
    await stageCouncilArtifacts(synthesizerWorkspace, candidateArtifacts);
    await fs.mkdir(synthesizerWorkspace, { recursive: true });
    await fs.writeFile(
      path.join(synthesizerWorkspace, 'reviews.json'),
      JSON.stringify(reviews, null, 2),
      'utf-8',
    );
    let synthesizer: AgentExecutionResult | undefined;
    const maxRounds = Math.min(Math.max(input.max_rounds ?? 2, 1), 2);
    for (let round = 1; round <= maxRounds; round += 1) {
      synthesizer = await this.tryRunRole(
        input,
        executionRunId,
        synthesizerParticipant,
        buildSynthesisInstruction(input.question, round, options?.artifact_mode),
        proposals.flatMap((proposal) => proposal.artifact_refs),
        'synthesis',
        synthesizerWorkspace,
        options,
        diagnosticRefs,
      );
      if (synthesizer) generatedResults.push(synthesizer);
      if (synthesizer?.artifact_refs.some(isMaterializableFileArtifact)) break;
    }

    const synthesis = synthesizer
      ? buildSynthesis(input, proposals, reviews, synthesizerParticipant, synthesizer)
      : undefined;
    if (synthesis && synthesizer) {
      await emitLifecycle(options, {
        type: 'council.synthesis.completed',
        payload: {
          ...participantAuditPayload(synthesizerParticipant),
          agent_run_id: synthesizer.agent_run_id,
          driver_run_result_id: synthesizer.driver_run_result_id,
          context_pack_ref: synthesizer.context_pack_ref,
          memory_buffer_ref: synthesizer.memory_buffer_ref,
          session_id: synthesizer.session_id,
          synthesis_id: synthesis.synthesis_id,
          artifact_refs: synthesis.artifact_refs,
        },
      });
    }
    const selectedArtifactRefs =
      synthesizer?.artifact_refs
        .filter(isMaterializableFileArtifact)
        .map((artifact) => artifact.artifact_id) ?? [];
    const generatedArtifactRefs = generatedResults.flatMap((result) => result.artifact_refs);
    const decision = buildDecision(input, synthesis, selectedArtifactRefs);

    return {
      council_run_id: createId('council_run'),
      ...(input.run_id ? { run_id: input.run_id } : {}),
      task_id: input.task_id,
      participants,
      proposals,
      reviews,
      ...(synthesis ? { synthesis } : {}),
      decision,
      output: buildOutput(input, decision, generatedArtifactRefs),
      generated_artifact_refs: generatedArtifactRefs,
      selected_artifact_refs: selectedArtifactRefs,
      ...(diagnosticRefs.length > 0 ? { diagnostic_refs: diagnosticRefs } : {}),
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  private async tryRunRole(
    input: CouncilRoundInput,
    executionRunId: string,
    participant: CouncilParticipantBinding,
    instruction: string,
    inputArtifactRefs: string[],
    phase: CouncilPhase,
    workspacePath: string,
    options: CouncilExecutionOptions | undefined,
    diagnosticRefs: string[],
  ): Promise<AgentExecutionResult | undefined> {
    try {
      return await this.runRole(
        input,
        executionRunId,
        participant,
        instruction,
        inputArtifactRefs,
        phase,
        workspacePath,
        options,
      );
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      if (!(error instanceof CouncilRoleExecutionError)) throw error;
      diagnosticRefs.push(`${error.code}:${participant.participant_id}`);
      return undefined;
    }
  }

  private async runRole(
    input: CouncilRoundInput,
    executionRunId: string,
    participant: CouncilParticipantBinding,
    instruction: string,
    inputArtifactRefs: string[] = input.evidence_pack?.artifact_refs ?? [],
    phase: CouncilPhase,
    workspacePath: string,
    options?: CouncilExecutionOptions,
  ): Promise<AgentExecutionResult> {
    await fs.mkdir(workspacePath, { recursive: true });
    let result: AgentExecutionResult;
    try {
      result = await this.agentExecutionFacade.runAgent(
        {
          task_id: input.task_id,
          run_id: executionRunId,
          role_id: participant.agent_id,
          participant_id: participant.participant_id,
          council_seat: participant.seat,
          council_seat_index: participant.seat_index,
          instruction: requireDriverDelegation(instruction),
          driver_instruction: instruction,
          workspace_path: workspacePath,
          input_artifact_refs: inputArtifactRefs,
          context_policy: `council_${participant.seat}`,
          schema_version: SCHEMA_VERSION,
          ...(input.memory_ablation ? { memory_ablation: input.memory_ablation } : {}),
        },
        options?.signal || options?.onDriverEvent
          ? {
              ...(options.signal ? { signal: options.signal } : {}),
              ...(options.onDriverEvent ? { onDriverEvent: options.onDriverEvent } : {}),
            }
          : undefined,
      );
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      const failure = new CouncilRoleExecutionError(
        phase,
        participant,
        'failed',
        undefined,
        undefined,
        errorDetails(error),
      );
      await emitFailureLifecycle(options, failure);
      throw failure;
    }
    options?.signal?.throwIfAborted();
    if (result.status !== 'completed') {
      const failure = new CouncilRoleExecutionError(
        phase,
        participant,
        result.status,
        result.agent_run_id,
        result.driver_run_result_id,
        agentFailureDetails(result),
      );
      await emitFailureLifecycle(options, failure);
      throw failure;
    }
    if (options?.artifact_mode === 'plan') {
      try {
        assertCouncilPlanArtifacts(result.artifact_refs, phase, {
          required: phase !== 'review',
        });
      } catch (error) {
        const failure = new CouncilRoleExecutionError(
          phase,
          participant,
          'failed',
          result.agent_run_id,
          result.driver_run_result_id,
          errorDetails(error),
        );
        await emitFailureLifecycle(options, failure);
        throw failure;
      }
    }
    return result;
  }

  private async resolveParticipants(
    input: CouncilRoundInput,
    executionRunId: string,
  ): Promise<CouncilParticipantBinding[]> {
    const participants =
      input.participants ??
      (await this.participantResolver?.resolve({
        run_id: executionRunId,
        task_id: input.task_id,
        question: input.question,
        ...(input.participant_profile_refs
          ? { participant_profile_refs: input.participant_profile_refs }
          : {}),
        ...(input.primary_agent_id ? { primary_agent_id: input.primary_agent_id } : {}),
      }));
    if (!participants) {
      throw new Error(
        'Council participants are required; configure a participant resolver or pass explicit bindings',
      );
    }
    return validateParticipants(participants);
  }
}

function completedProposalEvent(
  proposal: Proposal,
  participant: CouncilParticipantBinding,
  result: AgentExecutionResult,
): CouncilLifecycleEvent {
  return {
    type: 'council.proposal.completed',
    payload: {
      ...participantAuditPayload(participant),
      agent_run_id: result.agent_run_id,
      driver_run_result_id: result.driver_run_result_id,
      context_pack_ref: result.context_pack_ref,
      memory_buffer_ref: result.memory_buffer_ref,
      session_id: result.session_id,
      proposal_id: proposal.proposal_id,
      artifact_refs: proposal.artifact_refs,
    },
  };
}

function completedReusedProposalEvent(
  proposal: Proposal,
  participant: CouncilParticipantBinding,
): CouncilLifecycleEvent {
  return {
    type: 'council.proposal.completed',
    payload: {
      ...participantAuditPayload(participant),
      proposal_id: proposal.proposal_id,
      artifact_refs: proposal.artifact_refs,
      reused: true,
    },
  };
}

function failedEvent(error: CouncilRoleExecutionError): CouncilLifecycleEvent {
  return { type: 'council.role.failed', payload: { code: error.code, ...error.details } };
}

async function emitLifecycle(
  options: CouncilExecutionOptions | undefined,
  event: CouncilLifecycleEvent,
): Promise<void> {
  await options?.onLifecycleEvent?.(event);
}

async function emitFailureLifecycle(
  options: CouncilExecutionOptions | undefined,
  failure: CouncilRoleExecutionError,
): Promise<void> {
  try {
    await emitLifecycle(options, failedEvent(failure));
  } catch {
    // Preserve the stable Council role error when its failure observer is unavailable.
  }
}

function failureCode(phase: CouncilPhase): CouncilRoleFailureCode {
  if (phase === 'proposal') return 'COUNCIL_PROPOSAL_FAILED';
  if (phase === 'review') return 'COUNCIL_REVIEW_FAILED';
  return 'COUNCIL_SYNTHESIS_FAILED';
}

function errorDetails(error: unknown): CouncilRoleFailureDetails {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
    };
  }
  return { error_message: String(error) };
}

function agentFailureDetails(result: AgentExecutionResult): CouncilRoleFailureDetails {
  const details: CouncilRoleFailureDetails = {};
  const diagnostics = result.diagnostics;
  const dispatchStatus = diagnostics.dispatch_status;
  if (typeof dispatchStatus === 'string') details.dispatch_status = dispatchStatus;
  const driverErrorCode = diagnostics.driver_error_code;
  if (typeof driverErrorCode === 'string') details.driver_error_code = driverErrorCode;
  const driverError = diagnostics.driver_error;
  if (driverError && typeof driverError === 'object' && !Array.isArray(driverError)) {
    const record = driverError as Record<string, unknown>;
    if (typeof record.code === 'string') details.driver_error_code = record.code;
    if (typeof record.message === 'string') details.driver_error_message = record.message;
    if (typeof record.retryable === 'boolean') details.retryable = record.retryable;
  }
  return details;
}

function validateParticipants(
  input: readonly CouncilParticipantBinding[],
): CouncilParticipantBinding[] {
  const participants = input.map((participant) => ({
    ...participant,
    ...(participant.conflict_flags
      ? { conflict_flags: [...participant.conflict_flags] }
      : {}),
  }));
  const participantIds = new Set<string>();
  for (const participant of participants) {
    if (!/^[A-Za-z0-9_-]+$/.test(participant.participant_id)) {
      throw new Error(`Invalid Council participant_id: ${participant.participant_id}`);
    }
    if (!participant.agent_id.trim()) {
      throw new Error('Council participant agent_id must not be empty');
    }
    if (!Number.isInteger(participant.seat_index) || participant.seat_index < 0) {
      throw new Error(`Invalid Council seat_index for ${participant.participant_id}`);
    }
    if (participantIds.has(participant.participant_id)) {
      throw new Error(`Duplicate Council participant_id: ${participant.participant_id}`);
    }
    participantIds.add(participant.participant_id);
  }
  const proposers = participants.filter((participant) => participant.seat === 'proposer');
  if (proposers.length < 2 || new Set(proposers.map((item) => item.seat_index)).size !== proposers.length) {
    throw new Error('Council requires at least two distinct proposer seats');
  }
  for (const seat of ['reviewer', 'synthesizer'] as const) {
    if (participants.filter((participant) => participant.seat === seat).length !== 1) {
      throw new Error(`Council requires exactly one ${seat} seat`);
    }
  }
  return participants;
}

function requireSeat(
  participants: readonly CouncilParticipantBinding[],
  seat: Exclude<CouncilSeat, 'proposer'>,
): CouncilParticipantBinding {
  return participants.find((participant) => participant.seat === seat)!;
}

function participantWorkspace(
  councilDir: string,
  participant: CouncilParticipantBinding,
): string {
  return path.join(councilDir, participant.participant_id);
}

function participantAuditPayload(
  participant: CouncilParticipantBinding,
): Record<string, unknown> {
  return {
    participant_id: participant.participant_id,
    seat: participant.seat,
    council_seat: participant.seat,
    seat_index: participant.seat_index,
    agent_id: participant.agent_id,
    ...(participant.role_profile_ref
      ? { role_profile_ref: participant.role_profile_ref }
      : {}),
    ...(participant.selection_refs ? { selection_refs: [...participant.selection_refs] } : {}),
    ...(participant.conflict_flags
      ? { conflict_flags: participant.conflict_flags }
      : {}),
  };
}

function requireDriverDelegation(instruction: string): string {
  return [
    instruction,
    '',
    'Council execution requirement: call the invoke_driver tool before marking the task complete. Do not complete this role only from the top-level Agent.',
  ].join('\n');
}

function buildProposal(
  input: CouncilRoundInput,
  participant: CouncilParticipantBinding,
  result: AgentExecutionResult,
): Proposal {
  return {
    proposal_id: createId('proposal'),
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    agent_id: result.agent_id ?? participant.agent_id,
    artifact_refs: result.artifact_refs.map((artifact) => artifact.artifact_id),
    summary: result.response?.trim() || `${result.role_id} generated a council proposal.`,
    claims: [],
    affected_paths: result.artifact_refs.flatMap((artifact) =>
      artifact.content?.target_path ? [artifact.content.target_path] : [],
    ),
    assumptions: [],
    known_risks: [],
    completion_evidence: [result.driver_run_result_id],
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function buildReviews(
  proposals: readonly Proposal[],
  participant: CouncilParticipantBinding,
  result: AgentExecutionResult | undefined,
): Review[] {
  const parsed = result ? parseReviewPayload(result.response) : undefined;
  return proposals.map((proposal) => {
    const item = parsed?.find((candidate) => candidate.proposal_id === proposal.proposal_id);
    if (!item) {
      return {
        review_id: createId('review'),
        proposal_id: proposal.proposal_id,
        reviewer_id: result?.agent_id ?? participant.agent_id,
        verdict: 'needs_revision',
        reason: result
          ? 'Reviewer did not return a valid structured review for this proposal.'
          : 'Reviewer execution failed; proposal remains unverified.',
        unmet_criteria: ['structured_review'],
        evidence_refs: [],
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      };
    }
    return {
      review_id: createId('review'),
      proposal_id: proposal.proposal_id,
      reviewer_id: result?.agent_id ?? participant.agent_id,
      verdict: item.verdict,
      reason: item.reason,
      unmet_criteria: [...item.unmet_criteria],
      evidence_refs: [...item.evidence_refs],
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  });
}

function buildSynthesis(
  input: CouncilRoundInput,
  proposals: Proposal[],
  reviews: Review[],
  participant: CouncilParticipantBinding,
  result: AgentExecutionResult,
): CouncilSynthesis {
  return {
    synthesis_id: createId('council_synthesis'),
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    synthesizer_id: result.agent_id ?? participant.agent_id,
    input_proposal_ids: proposals.map((proposal) => proposal.proposal_id),
    input_review_ids: reviews.map((review) => review.review_id),
    artifact_refs: result.artifact_refs.map((artifact) => artifact.artifact_id),
    summary: result.response?.trim() || 'Synthesis agent produced a final candidate artifact.',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function buildDecision(
  input: CouncilRoundInput,
  synthesis: CouncilSynthesis | undefined,
  selectedArtifactRefs: string[],
): CouncilDecision {
  const hasSelection = selectedArtifactRefs.length > 0;
  return {
    decision_id: createId('council_decision'),
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    decision_mode: input.decision_mode,
    selected_artifact_refs: selectedArtifactRefs,
    verdict: hasSelection ? 'select' : 'request_revision',
    reason: hasSelection
      ? 'Synthesis agent produced the selected final candidate artifact.'
      : 'Synthesis was unavailable; Coordinator must select the best reviewed proposal.',
    evidence_refs: [
      ...(synthesis ? [synthesis.synthesis_id] : []),
      ...(input.evidence_pack ? [input.evidence_pack.evidence_pack_id] : []),
    ],
    can_create_merge_authorization: false,
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function buildOutput(
  input: CouncilRoundInput,
  decision: CouncilDecision,
  generatedArtifactRefs: ArtifactRef[],
): CouncilOutput {
  return {
    output_id: createId('council_output'),
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    status: decision.verdict === 'select' ? 'selected' : 'request_revision',
    decision_ref: decision.decision_id,
    selected_artifact_refs: decision.selected_artifact_refs,
    generated_artifact_refs: generatedArtifactRefs,
    required_next_actions:
      decision.verdict === 'select' ? ['post_council_gate'] : ['coordinator_best_effort_selection'],
    blocked_by: [],
    can_create_merge_authorization: false,
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

interface ParsedReview {
  proposal_id: string;
  verdict: Review['verdict'];
  reason: string;
  unmet_criteria: string[];
  evidence_refs: string[];
}

function parseReviewPayload(response: string | undefined): ParsedReview[] | undefined {
  const raw = (response ?? '').trim();
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(
    (match) => match[1]?.trim() ?? '',
  );
  for (const source of [raw, ...fenced].filter(Boolean)) {
    const parsed = parseReviewCandidate(source);
    if (parsed) return parsed;
  }
  return undefined;
}

function parseReviewCandidate(source: string): ParsedReview[] | undefined {
  try {
    const value = JSON.parse(source) as { reviews?: unknown };
    if (!Array.isArray(value.reviews)) return undefined;
    return value.reviews.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const proposalId = Reflect.get(entry, 'proposal_id');
      const verdict = Reflect.get(entry, 'verdict');
      const reason = Reflect.get(entry, 'reason');
      const unmetCriteria = Reflect.get(entry, 'unmet_criteria');
      const evidenceRefs = Reflect.get(entry, 'evidence_refs');
      if (
        typeof proposalId !== 'string' ||
        !['approve', 'reject', 'needs_revision'].includes(String(verdict)) ||
        typeof reason !== 'string' ||
        !Array.isArray(unmetCriteria) ||
        !unmetCriteria.every((item) => typeof item === 'string') ||
        !Array.isArray(evidenceRefs) ||
        !evidenceRefs.every((item) => typeof item === 'string')
      ) {
        return [];
      }
      return [
        {
          proposal_id: proposalId,
          verdict: verdict as Review['verdict'],
          reason,
          unmet_criteria: unmetCriteria,
          evidence_refs: evidenceRefs,
        },
      ];
    });
  } catch {
    return undefined;
  }
}

function buildProposalInstruction(
  question: string,
  label: string,
  artifactMode: CouncilArtifactMode | undefined,
): string {
  if (artifactMode !== 'plan') {
    return `Produce proposal ${label} for: ${question}. Work only in this isolated role workspace and implement a concrete candidate solution.`;
  }
  return [
    `Produce independent implementation Plan ${label} for: ${question}.`,
    'Use your role Persona, Skills, and Memory to reason about the best approach.',
    'Do not modify product files or implement the solution.',
    'Write the complete Plan to the relative path council-plan.md in the current role workspace; never construct an absolute path.',
    'Include affected files, ordered steps, risks, and verification.',
  ].join(' ');
}

function buildReviewerInstruction(
  question: string,
  proposals: readonly Proposal[],
  artifactMode: CouncilArtifactMode | undefined,
): string {
  if (artifactMode === 'plan') {
    return [
      `Review the staged Council Plan inputs for: ${question}.`,
      `Proposal ids: ${proposals.map((proposal) => proposal.proposal_id).join(', ')}.`,
      'Read only the staged inputs/**/council-plan.md files; do not inspect unrelated source files or run tests.',
      'Compare scope, implementation feasibility, unnecessary changes, risks, and verification coverage.',
      'Do not modify product files.',
      'Return JSON only: {"reviews":[{"proposal_id":"...","verdict":"approve|reject|needs_revision","reason":"...","unmet_criteria":[],"evidence_refs":[]}]}.',
    ].join(' ');
  }
  return [
    `Review the isolated proposal inputs for: ${question}.`,
    `Proposal ids: ${proposals.map((proposal) => proposal.proposal_id).join(', ')}.`,
    'Return JSON only: {"reviews":[{"proposal_id":"...","verdict":"approve|reject|needs_revision","reason":"...","unmet_criteria":[],"evidence_refs":[]}]}.',
    'A successful tool call is not approval; verdict must be based on the proposal evidence.',
  ].join(' ');
}

function buildSynthesisInstruction(
  question: string,
  round: number,
  artifactMode: CouncilArtifactMode | undefined,
): string {
  if (artifactMode === 'plan') {
    return [
      `Synthesis round ${String(round)} for: ${question}.`,
      'Read only inputs/**/council-plan.md and reviews.json; do not inspect unrelated source files or run tests.',
      'Resolve material review concerns and write one executable final Plan to final-plan.md.',
      'Use the relative path final-plan.md in the current role workspace; never construct an absolute path.',
      'Do not implement the Plan or modify product files.',
      'The final Plan must identify affected files, ordered steps, risks, and verification.',
    ].join(' ');
  }
  return [
    `Synthesis round ${String(round)} for: ${question}.`,
    'Read the staged proposal inputs and reviews.json in this isolated workspace.',
    'Implement the concrete final candidate changes in the repository workspace.',
    'Do not merely describe a decision; at least one materializable file change is required.',
  ].join(' ');
}
