/**
 * SynthesisAgentCouncilProvider
 *
 * Council 的真实 agent-backed MVP provider。它只依赖 B 方向 AgentExecutionFacade，
 * 不直接调用 A 方向 DriverRuntimeHandle。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from '../../core';
import {
  isMaterializableFileArtifact,
  readArtifactBytes,
} from '../../coordinator/artifact-content';
import type { AgentExecutionFacade, AgentExecutionResult } from '../../protocol/agent-execution';
import type {
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

export type CouncilRoleFailureCode =
  | 'COUNCIL_PROPOSAL_FAILED'
  | 'COUNCIL_REVIEW_FAILED'
  | 'COUNCIL_SYNTHESIS_FAILED';

type CouncilPhase = 'proposal' | 'review' | 'synthesis';

export class CouncilRoleExecutionError extends Error {
  readonly code: CouncilRoleFailureCode;
  readonly phase = 'council';

  constructor(
    readonly council_phase: CouncilPhase,
    readonly role_id: string,
    readonly agent_status: AgentExecutionResult['status'],
    readonly agent_run_id?: string,
    readonly driver_run_result_id?: string,
  ) {
    super(`Council ${council_phase} role failed`);
    this.name = 'CouncilRoleExecutionError';
    this.code = failureCode(council_phase);
  }

  get details(): Record<string, unknown> {
    return {
      phase: this.phase,
      council_phase: this.council_phase,
      role_id: this.role_id,
      agent_status: this.agent_status,
      ...(this.agent_run_id ? { agent_run_id: this.agent_run_id } : {}),
      ...(this.driver_run_result_id ? { driver_run_result_id: this.driver_run_result_id } : {}),
    };
  }
}

export interface SynthesisAgentCouncilProviderOptions {
  agentExecutionFacade: AgentExecutionFacade;
  councilRoot?: string;
}

export class SynthesisAgentCouncilProvider implements CouncilProvider {
  private readonly agentExecutionFacade: AgentExecutionFacade;
  private readonly councilRoot: string;

  constructor(options: SynthesisAgentCouncilProviderOptions) {
    this.agentExecutionFacade = options.agentExecutionFacade;
    this.councilRoot = options.councilRoot ?? '.newide/council';
  }

  async runCouncilRound(
    input: CouncilRoundInput,
    options?: CouncilExecutionOptions,
  ): Promise<CouncilRunResult> {
    const executionRunId = input.run_id ?? createId('run');
    const councilDir = path.join(this.councilRoot, executionRunId);
    const generatedResults: AgentExecutionResult[] = [];
    const diagnosticRefs: string[] = [];
    const generatedProposals: Proposal[] = [];

    for (const [roleId, label] of [
      ['proposer_a', 'A'],
      ['proposer_b', 'B'],
    ] as const) {
      const result = await this.tryRunRole(
        input,
        executionRunId,
        roleId,
        `Produce proposal ${label} for: ${input.question}. Work only in this isolated role workspace and create a concrete candidate file.`,
        input.evidence_pack?.artifact_refs ?? [],
        'proposal',
        path.join(councilDir, roleId),
        options,
        diagnosticRefs,
      );
      if (!result) continue;
      generatedResults.push(result);
      const proposal = buildProposal(input, result);
      generatedProposals.push(proposal);
      await emitLifecycle(options, completedProposalEvent(proposal, result));
    }

    const proposals = [...input.proposals, ...generatedProposals];
    const candidateArtifacts = [
      ...(input.candidate_artifacts ?? []),
      ...generatedResults.flatMap((result) => result.artifact_refs),
    ];
    const reviewerWorkspace = path.join(councilDir, 'reviewer');
    await stageArtifacts(reviewerWorkspace, candidateArtifacts);
    const reviewer = await this.tryRunRole(
      input,
      executionRunId,
      'reviewer',
      buildReviewerInstruction(input.question, proposals),
      proposals.flatMap((proposal) => proposal.artifact_refs),
      'review',
      reviewerWorkspace,
      options,
      diagnosticRefs,
    );
    if (reviewer) generatedResults.push(reviewer);
    const reviews = buildReviews(proposals, reviewer);
    if (reviewer) {
      await emitLifecycle(options, {
        type: 'council.review.completed',
        payload: {
          role_id: reviewer.role_id,
          agent_run_id: reviewer.agent_run_id,
          driver_run_result_id: reviewer.driver_run_result_id,
          agent_id: reviewer.agent_id,
          context_pack_ref: reviewer.context_pack_ref,
          memory_buffer_ref: reviewer.memory_buffer_ref,
          session_id: reviewer.session_id,
          proposal_ids: proposals.map((proposal) => proposal.proposal_id),
          review_ids: reviews.map((review) => review.review_id),
          artifact_refs: reviewer.artifact_refs.map((artifact) => artifact.artifact_id),
        },
      });
    }

    const synthesizerWorkspace = path.join(councilDir, 'synthesizer');
    await stageArtifacts(synthesizerWorkspace, candidateArtifacts);
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
        'synthesizer',
        buildSynthesisInstruction(input.question, round),
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
      ? buildSynthesis(input, proposals, reviews, synthesizer)
      : undefined;
    if (synthesis && synthesizer) {
      await emitLifecycle(options, {
        type: 'council.synthesis.completed',
        payload: {
          role_id: synthesizer.role_id,
          agent_run_id: synthesizer.agent_run_id,
          driver_run_result_id: synthesizer.driver_run_result_id,
          agent_id: synthesizer.agent_id,
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
        .slice(0, 1)
        .map((artifact) => artifact.artifact_id) ?? [];
    const generatedArtifactRefs = generatedResults.flatMap((result) => result.artifact_refs);
    const decision = buildDecision(input, synthesis, selectedArtifactRefs);

    return {
      council_run_id: createId('council_run'),
      ...(input.run_id ? { run_id: input.run_id } : {}),
      task_id: input.task_id,
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
    roleId: string,
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
        roleId,
        instruction,
        inputArtifactRefs,
        phase,
        workspacePath,
        options,
      );
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      if (!(error instanceof CouncilRoleExecutionError)) throw error;
      diagnosticRefs.push(`${error.code}:${roleId}`);
      return undefined;
    }
  }

  private async runRole(
    input: CouncilRoundInput,
    executionRunId: string,
    roleId: string,
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
          role_id: roleId,
          instruction,
          workspace_path: workspacePath,
          input_artifact_refs: inputArtifactRefs,
          context_policy: 'council_synthesis_default',
          schema_version: SCHEMA_VERSION,
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
      const failure = new CouncilRoleExecutionError(phase, roleId, 'failed');
      await emitFailureLifecycle(options, failure);
      throw failure;
    }
    options?.signal?.throwIfAborted();
    if (result.status !== 'completed') {
      const failure = new CouncilRoleExecutionError(
        phase,
        roleId,
        result.status,
        result.agent_run_id,
        result.driver_run_result_id,
      );
      await emitFailureLifecycle(options, failure);
      throw failure;
    }
    return result;
  }
}

function completedProposalEvent(
  proposal: Proposal,
  result: AgentExecutionResult,
): CouncilLifecycleEvent {
  return {
    type: 'council.proposal.completed',
    payload: {
      role_id: result.role_id,
      agent_run_id: result.agent_run_id,
      driver_run_result_id: result.driver_run_result_id,
      agent_id: result.agent_id,
      context_pack_ref: result.context_pack_ref,
      memory_buffer_ref: result.memory_buffer_ref,
      session_id: result.session_id,
      proposal_id: proposal.proposal_id,
      artifact_refs: proposal.artifact_refs,
    },
  };
}

function failedEvent(error: CouncilRoleExecutionError): CouncilLifecycleEvent {
  return { type: 'council.failed', payload: { code: error.code, ...error.details } };
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

function buildProposal(input: CouncilRoundInput, result: AgentExecutionResult): Proposal {
  return {
    proposal_id: createId('proposal'),
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    agent_id: result.role_id,
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
  result: AgentExecutionResult | undefined,
): Review[] {
  const parsed = result ? parseReviewPayload(result.response) : undefined;
  return proposals.map((proposal) => {
    const item = parsed?.find((candidate) => candidate.proposal_id === proposal.proposal_id);
    if (!item) {
      return {
        review_id: createId('review'),
        proposal_id: proposal.proposal_id,
        reviewer_id: result?.role_id ?? 'reviewer',
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
      reviewer_id: result?.role_id ?? 'reviewer',
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
  result: AgentExecutionResult,
): CouncilSynthesis {
  return {
    synthesis_id: createId('council_synthesis'),
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    synthesizer_id: result.role_id,
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
  const source = (response ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
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

function buildReviewerInstruction(question: string, proposals: readonly Proposal[]): string {
  return [
    `Review the isolated proposal inputs for: ${question}.`,
    `Proposal ids: ${proposals.map((proposal) => proposal.proposal_id).join(', ')}.`,
    'Return JSON only: {"reviews":[{"proposal_id":"...","verdict":"approve|reject|needs_revision","reason":"...","unmet_criteria":[],"evidence_refs":[]}]}.',
    'A successful tool call is not approval; verdict must be based on the proposal evidence.',
  ].join(' ');
}

function buildSynthesisInstruction(question: string, round: number): string {
  return [
    `Synthesis round ${String(round)} for: ${question}.`,
    'Read the staged proposal inputs and reviews.json in this isolated workspace.',
    'Create one concrete final candidate file in the workspace root.',
    'Do not merely describe a decision; a materializable file artifact is required.',
  ].join(' ');
}

async function stageArtifacts(workspace: string, artifacts: readonly ArtifactRef[]): Promise<void> {
  await fs.mkdir(workspace, { recursive: true });
  for (const artifact of artifacts) {
    if (!isMaterializableFileArtifact(artifact)) continue;
    const targetPath = artifact.content?.target_path;
    if (!targetPath) continue;
    const target = path.join(workspace, 'inputs', artifact.artifact_id, targetPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await readArtifactBytes(artifact));
  }
}
