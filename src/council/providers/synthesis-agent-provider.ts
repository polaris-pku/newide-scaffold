/**
 * SynthesisAgentCouncilProvider
 *
 * Council 的真实 agent-backed MVP provider。它只依赖 B 方向 AgentExecutionFacade，
 * 不直接调用 A 方向 DriverRuntimeHandle。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from '../../core';
import type { DriverStreamEvent } from '../../driver/contract';
import { extractJsonObject } from '../../driver/driver-return-converter';
import {
  isMaterializableFileArtifact,
  readArtifactBytes,
} from '../../coordinator/artifact-content';
import type { AgentExecutionFacade, AgentExecutionResult } from '../../protocol/agent-execution';
import type { CouncilParticipantResolver } from '../council-participant-resolver';
import type { CouncilParticipantBinding, CouncilSeat } from '../council-participant';
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
import {
  assertCouncilPlanArtifacts,
  isCouncilPlanArtifact,
  isCouncilReviewArtifact,
} from '../plan-artifact';
import { proposalReportFields } from '../proposal-adapter';
import { collectWorkspaceArtifacts, mergeArtifacts, snapshotWorkspaceFiles, type WorkspaceFileSnapshot } from '../../coordinator/workspace-change-detector';

export type CouncilRoleFailureCode =
  | 'COUNCIL_PROPOSAL_FAILED'
  | 'COUNCIL_REVIEW_FAILED'
  | 'COUNCIL_SYNTHESIS_FAILED';

type CouncilPhase = 'proposal' | 'review' | 'synthesis';
type CouncilRoleFailureDetails = Record<string, unknown>;

interface CouncilRoleExecution {
  result: AgentExecutionResult;
  phase_id: string;
}

class CouncilRoleInactivityError extends Error {
  constructor(
    readonly participant: CouncilParticipantBinding,
    readonly council_phase: CouncilPhase,
    readonly inactivity_timeout_ms: number,
    readonly session_id?: string,
  ) {
    super(
      `Council ${council_phase} Driver stopped emitting events for ${String(inactivity_timeout_ms)}ms`,
    );
    this.name = 'CouncilRoleInactivityError';
  }
}

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
      ...(this.failure_details.council_run_id
        ? { council_run_id: this.failure_details.council_run_id }
        : {}),
      ...(this.failure_details.phase_id ? { phase_id: this.failure_details.phase_id } : {}),
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
  /** Steer only after a started Driver turn stops emitting all stream events. */
  roleInactivityTimeoutMs?: number;
}

export class SynthesisAgentCouncilProvider implements CouncilProvider {
  private readonly agentExecutionFacade: AgentExecutionFacade;
  private readonly participantResolver: CouncilParticipantResolver | undefined;
  private readonly councilRoot: string;
  private readonly roleInactivityTimeoutMs: number | undefined;

  constructor(options: SynthesisAgentCouncilProviderOptions) {
    this.agentExecutionFacade = options.agentExecutionFacade;
    this.participantResolver = options.participantResolver;
    this.councilRoot = options.councilRoot ?? '.newide/council';
    this.roleInactivityTimeoutMs = positiveTimeout(
      options.roleInactivityTimeoutMs,
      'roleInactivityTimeoutMs',
    );
  }

  async runCouncilRound(
    input: CouncilRoundInput,
    options?: CouncilExecutionOptions,
  ): Promise<CouncilRunResult> {
    const executionRunId = input.run_id ?? createId('run');
    const councilRunId = createId('council_run');
    const participants = await this.resolveParticipants(input, executionRunId, options);
    await emitLifecycle(options, {
      type: 'council.participants.selected',
      payload: {
        council_run_id: councilRunId,
        selection_mode: input.participants
          ? 'explicit'
          : (this.participantResolver?.selectionMode ?? 'explicit'),
        participants: participants.map((participant) => ({ ...participant })),
      },
    });
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
      const participant = proposers.find((candidate) => candidate.agent_id === proposal.agent_id);
      if (participant) {
        await emitLifecycle(
          options,
          completedReusedProposalEvent(councilRunId, proposal, participant),
        );
      }
    }

    const proposalExecutions = await Promise.all(
      proposers.map(async (participant) => {
        if (representedAgentIds.has(participant.agent_id)) return undefined;
        const label = String.fromCharCode(65 + participant.seat_index);
        const workspace = participantWorkspace(councilDir, participant);
        const execution = await this.tryRunRole(
          input,
          executionRunId,
          councilRunId,
          participant,
          buildProposalInstruction(input.question, label, options?.artifact_mode),
          input.evidence_pack?.artifact_refs ?? [],
          'proposal',
          workspace,
          options,
          diagnosticRefs,
          2,
          () => prepareCouncilWorkspace(input.workspace_path, workspace),
        );
        return execution ? { execution, participant } : undefined;
      }),
    );
    for (const completed of proposalExecutions) {
      if (!completed) continue;
      const { execution, participant } = completed;
      const result = execution?.result;
      if (!result) continue;
      generatedResults.push(result);
      const proposal = buildProposal(input, participant, result);
      generatedProposals.push(proposal);
      await emitLifecycle(
        options,
        completedProposalEvent(councilRunId, execution.phase_id, proposal, participant, result),
      );
    }

    const proposals = [...input.proposals, ...generatedProposals];
    const candidateArtifacts = [
      ...(input.candidate_artifacts ?? []),
      ...generatedResults.flatMap((result) => result.artifact_refs),
    ];
    const reviewerWorkspace = participantWorkspace(councilDir, reviewerParticipant);
    let parsedReviews: ParsedReview[] | undefined;
    const reviewerExecution = await this.tryRunRole(
      input,
      executionRunId,
      councilRunId,
      reviewerParticipant,
      buildReviewerInstruction(input.question, proposals, options?.artifact_mode),
      proposals.flatMap((proposal) => proposal.artifact_refs),
      'review',
      reviewerWorkspace,
      options,
      diagnosticRefs,
      2,
      async () => {
        await prepareCouncilWorkspace(
          options?.artifact_mode === 'plan' ? undefined : input.workspace_path,
          reviewerWorkspace,
        );
        await stageCouncilArtifacts(reviewerWorkspace, candidateArtifacts);
        await writeProposalManifest(reviewerWorkspace, proposals, candidateArtifacts);
      },
      async (result) => {
        parsedReviews = await readReviews(result, reviewerWorkspace);
        if (!coversEveryProposal(proposals, parsedReviews)) {
          throw new CouncilRoleExecutionError(
            'review',
            reviewerParticipant,
            'failed',
            result.agent_run_id,
            result.driver_run_result_id,
            {
              reason:
                'Write reviews.json with exactly one structured review for each proposal in proposals.json.',
              retryable: true,
              session_id: result.session_id,
            },
          );
        }
      },
    );
    const reviewer = reviewerExecution?.result;
    if (reviewer) generatedResults.push(reviewer);
    // 评审缺失时不做任何替代：兜底编一条 needs_revision 等于把没审过的提案记成已否决
    // （2026-09-20 的批次里，14 条 approve 就是这样被静默改写成 reject 的）。同 Session
    // 重试已在 tryRunRole 里用满；走到这里就不再有评审，于是跳过合成——决策没有可选产物，
    // 上层据此让这次 run 失败，而不是产出一个没经过评审的结果。
    const reviews =
      reviewer !== undefined && coversEveryProposal(proposals, parsedReviews)
        ? buildReviews(proposals, reviewerParticipant, reviewer, parsedReviews)
        : [];
    const reviewed = reviews.length > 0;
    if (reviewer) {
      await emitLifecycle(options, {
        type: 'council.review.completed',
        payload: {
          council_run_id: councilRunId,
          phase_id: reviewerExecution!.phase_id,
          phase: 'review',
          ...participantAuditPayload(reviewerParticipant),
          agent_run_id: reviewer.agent_run_id,
          driver_run_result_id: reviewer.driver_run_result_id,
          context_pack_ref: reviewer.context_pack_ref,
          memory_buffer_ref: reviewer.memory_buffer_ref,
          session_id: reviewer.session_id,
          proposal_ids: proposals.map((proposal) => proposal.proposal_id),
          review_ids: reviews.map((review) => review.review_id),
          reviews: reviews.map((review) => ({ ...review })),
          artifact_refs: reviewer.artifact_refs.map((artifact) => artifact.artifact_id),
        },
      });
    }

    let synthesizer: AgentExecutionResult | undefined;
    let synthesis: CouncilSynthesis | undefined;
    if (reviewed) {
      const synthesizerWorkspace = participantWorkspace(councilDir, synthesizerParticipant);
      const maxRounds = Math.min(Math.max(input.max_rounds ?? 2, 1), 2);
      const synthesisExecution = await this.tryRunRole(
        input,
        executionRunId,
        councilRunId,
        synthesizerParticipant,
        buildSynthesisInstruction(input.question, 1, options?.artifact_mode),
        proposals.flatMap((proposal) => proposal.artifact_refs),
        'synthesis',
        synthesizerWorkspace,
        options,
        diagnosticRefs,
        maxRounds,
        async () => {
          await prepareCouncilWorkspace(
            options?.artifact_mode === 'plan' ? undefined : input.workspace_path,
            synthesizerWorkspace,
          );
          await stageCouncilArtifacts(synthesizerWorkspace, candidateArtifacts);
          await writeProposalManifest(synthesizerWorkspace, proposals, candidateArtifacts);
          await fs.writeFile(
            path.join(synthesizerWorkspace, 'reviews.json'),
            JSON.stringify(reviews, null, 2),
            'utf-8',
          );
        },
      );
      synthesizer = synthesisExecution?.result;
      const synthesisPhaseId = synthesisExecution?.phase_id;
      if (synthesizer) generatedResults.push(synthesizer);

      synthesis = synthesizer
        ? buildSynthesis(input, proposals, reviews, synthesizerParticipant, synthesizer)
        : undefined;
      if (synthesis && synthesizer) {
        await emitLifecycle(options, {
          type: 'council.synthesis.completed',
          payload: {
            council_run_id: councilRunId,
            ...(synthesisPhaseId ? { phase_id: synthesisPhaseId } : {}),
            phase: 'synthesis',
            ...participantAuditPayload(synthesizerParticipant),
            agent_run_id: synthesizer.agent_run_id,
            driver_run_result_id: synthesizer.driver_run_result_id,
            context_pack_ref: synthesizer.context_pack_ref,
            memory_buffer_ref: synthesizer.memory_buffer_ref,
            session_id: synthesizer.session_id,
            synthesis_id: synthesis.synthesis_id,
            synthesis: { ...synthesis },
            artifact_refs: synthesis.artifact_refs,
          },
        });
      }
    }
    const selectedArtifactRefs =
      synthesizer?.artifact_refs
        .filter(isMaterializableFileArtifact)
        .map((artifact) => artifact.artifact_id) ?? [];
    const generatedArtifactRefs = generatedResults.flatMap((result) => result.artifact_refs);
    const decision = buildDecision(input, synthesis, selectedArtifactRefs);

    return {
      council_run_id: councilRunId,
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
    councilRunId: string,
    participant: CouncilParticipantBinding,
    instruction: string,
    inputArtifactRefs: string[],
    phase: CouncilPhase,
    workspacePath: string,
    options: CouncilExecutionOptions | undefined,
    diagnosticRefs: string[],
    maxAttempts: number,
    prepare?: () => Promise<void>,
    validate?: (result: AgentExecutionResult) => Promise<void>,
  ): Promise<CouncilRoleExecution | undefined> {
    let sessionId: string | undefined;
    let recoveryReason: string | undefined;
    let workspaceBefore: WorkspaceFileSnapshot | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      options?.signal?.throwIfAborted();
      const phaseId = createId('council_phase');
      await emitLifecycle(options, {
        type: 'council.phase.started',
        payload: {
          council_run_id: councilRunId,
          phase_id: phaseId,
          phase,
          attempt,
          ...(recoveryReason
            ? {
                recovery: sessionId ? 'same_session_continuation' : 'workspace_continuation',
                recovery_reason: recoveryReason,
                ...(sessionId ? { session_id: sessionId } : {}),
              }
            : {}),
          ...participantAuditPayload(participant),
          input_artifact_refs: [...inputArtifactRefs],
        },
      });
      try {
        if (attempt === 1) {
          await prepare?.();
          workspaceBefore = await snapshotWorkspaceFiles(workspacePath);
        }
        const execution = await this.runRoleWithInactivitySteering(
          input,
          executionRunId,
          councilRunId,
          participant,
          recoveryReason
            ? `${buildFinalizationInstruction(instruction, phase, options?.artifact_mode)} Previous attempt: ${recoveryReason}`
            : instruction,
          inputArtifactRefs,
          phase,
          workspacePath,
          options,
          phaseId,
          this.roleInactivityTimeoutMs,
          sessionId,
          attempt > 1 ? workspaceBefore : undefined,
        );
        await validate?.(execution.result);
        for (const warning of (execution.result.diagnostics.council_warnings as string[]) ?? []) {
          diagnosticRefs.push(`${participant.participant_id}:${warning}`);
        }
        return { result: execution.result, phase_id: phaseId };
      } catch (error) {
        if (options?.signal?.aborted) throw error;
        const retry = attempt < maxAttempts && isRecoverableRoleFailure(error);
        const failure = await this.toRoleFailure(
          error,
          phase,
          participant,
          councilRunId,
          phaseId,
          { attempt, will_retry: retry },
          options,
        );
        diagnosticRefs.push(`${failure.code}:${participant.participant_id}`);
        if (!retry) return undefined;
        const details = failure.failure_details;
        sessionId = typeof details.session_id === 'string' ? details.session_id : undefined;
        recoveryReason = String(
          details.reason ??
            details.driver_error_message ??
            details.error_message ??
            failure.message,
        );
      }
    }
    return undefined;
  }

  private async runRoleWithInactivitySteering(
    input: CouncilRoundInput,
    executionRunId: string,
    councilRunId: string,
    participant: CouncilParticipantBinding,
    instruction: string,
    inputArtifactRefs: string[],
    phase: CouncilPhase,
    workspacePath: string,
    options: CouncilExecutionOptions | undefined,
    phaseId: string,
    inactivityTimeoutMs: number | undefined,
    sessionId?: string,
    workspaceBefore?: WorkspaceFileSnapshot,
  ): Promise<{ result: AgentExecutionResult }> {
    const driverRunId = `${executionRunId}_${phaseId}`;
    if (!inactivityTimeoutMs) {
      return {
        result: await this.runRole(
          input,
          driverRunId,
          councilRunId,
          participant,
          instruction,
          inputArtifactRefs,
          phase,
          workspacePath,
          options?.onDriverEvent
            ? {
                ...options,
                onDriverEvent: (event) =>
                  options.onDriverEvent?.({ ...event, run_id: executionRunId }),
              }
            : options,
          phaseId,
          sessionId,
          workspaceBefore,
        ),
      };
    }
    const inactivity = createInactivitySignal(
      options?.signal,
      inactivityTimeoutMs,
      participant,
      phase,
    );
    let observedSessionId = sessionId;
    try {
      const result = await this.runRole(
        input,
        driverRunId,
        councilRunId,
        participant,
        instruction,
        inputArtifactRefs,
        phase,
        workspacePath,
        {
          ...options,
          signal: inactivity.signal,
          onDriverEvent: (event) => {
            if (event.session_id) observedSessionId = event.session_id;
            inactivity.observe(event);
            options?.onDriverEvent?.({ ...event, run_id: executionRunId });
          },
        },
        phaseId,
        sessionId,
        workspaceBefore,
      );
      return { result };
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      if (inactivity.triggered()) {
        throw new CouncilRoleInactivityError(
          participant,
          phase,
          inactivityTimeoutMs,
          observedSessionId,
        );
      }
      throw error;
    } finally {
      inactivity.dispose();
    }
  }

  private async toRoleFailure(
    error: unknown,
    phase: CouncilPhase,
    participant: CouncilParticipantBinding,
    councilRunId: string,
    phaseId: string,
    additionalDetails: CouncilRoleFailureDetails,
    options: CouncilExecutionOptions | undefined,
  ): Promise<CouncilRoleExecutionError> {
    const roleFailure = error instanceof CouncilRoleExecutionError ? error : undefined;
    const failure = new CouncilRoleExecutionError(
      phase,
      participant,
      roleFailure?.agent_status ?? 'failed',
      roleFailure?.agent_run_id,
      roleFailure?.driver_run_result_id,
      {
        ...errorDetails(error),
        ...roleFailure?.failure_details,
        ...additionalDetails,
        council_run_id: councilRunId,
        phase_id: phaseId,
      },
    );
    await emitFailureLifecycle(options, failure);
    return failure;
  }

  private async runRole(
    input: CouncilRoundInput,
    executionRunId: string,
    councilRunId: string,
    participant: CouncilParticipantBinding,
    instruction: string,
    inputArtifactRefs: string[] = input.evidence_pack?.artifact_refs ?? [],
    phase: CouncilPhase,
    workspacePath: string,
    options?: CouncilExecutionOptions,
    phaseId?: string,
    sessionId?: string,
    workspaceBefore?: WorkspaceFileSnapshot,
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
          ...(sessionId ? { session_id: sessionId } : {}),
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
        {
          ...errorDetails(error),
          council_run_id: councilRunId,
          ...(phaseId ? { phase_id: phaseId } : {}),
        },
      );
      throw failure;
    }
    options?.signal?.throwIfAborted();
    if (workspaceBefore && result.status === 'completed') {
      result = {
        ...result,
        artifact_refs: mergeArtifacts(result.artifact_refs, await collectWorkspaceArtifacts(
          { task_id: input.task_id, workspace_path: workspacePath },
          workspaceBefore,
          String(result.diagnostics.driver_id ?? result.role_id),
        )),
      };
    }
    if (hasBlockingMailboxRequest(result)) {
      const failure = new CouncilRoleExecutionError(
        phase,
        participant,
        'failed',
        result.agent_run_id,
        result.driver_run_result_id,
        {
          council_run_id: councilRunId,
          ...(phaseId ? { phase_id: phaseId } : {}),
          reason: 'Council roles cannot suspend the whole round for a Mailbox reply.',
          fallback_action: 'continue_with_available_evidence',
          retryable: true,
          session_id: result.session_id,
        },
      );
      throw failure;
    }
    if (result.status !== 'completed') {
      const failure = new CouncilRoleExecutionError(
        phase,
        participant,
        result.status,
        result.agent_run_id,
        result.driver_run_result_id,
        {
          ...agentFailureDetails(result),
          council_run_id: councilRunId,
          ...(phaseId ? { phase_id: phaseId } : {}),
        },
      );
      throw failure;
    }
    if (options?.artifact_mode === 'plan') {
      try {
        assertCouncilPlanArtifacts(result.artifact_refs, phase, {
          required: phase !== 'review',
        });
      } catch (error) {
        const valid = result.artifact_refs.filter(
          (artifact) =>
            isCouncilPlanArtifact(artifact) ||
            (phase === 'review' && isCouncilReviewArtifact(artifact)),
        );
        if (valid.length > 0) {
          return {
            ...result,
            artifact_refs: result.artifact_refs.filter(
              (artifact) => !isMaterializableFileArtifact(artifact) || valid.includes(artifact),
            ),
            diagnostics: { ...result.diagnostics, council_warnings: [String(error)] },
          };
        }
        const failure = new CouncilRoleExecutionError(
          phase,
          participant,
          'failed',
          result.agent_run_id,
          result.driver_run_result_id,
          {
            ...errorDetails(error),
            council_run_id: councilRunId,
            ...(phaseId ? { phase_id: phaseId } : {}),
            retryable: true,
            session_id: result.session_id,
          },
        );
        throw failure;
      }
    }
    if (phase !== 'review' && !result.artifact_refs.some(isMaterializableFileArtifact)) {
      throw new CouncilRoleExecutionError(
        phase,
        participant,
        'failed',
        result.agent_run_id,
        result.driver_run_result_id,
        {
          reason: `Council ${phase} produced no materializable artifact; persist the assigned output before returning.`,
          retryable: true,
          session_id: result.session_id,
        },
      );
    }
    return result;
  }

  private async resolveParticipants(
    input: CouncilRoundInput,
    executionRunId: string,
    options?: CouncilExecutionOptions,
  ): Promise<CouncilParticipantBinding[]> {
    const participants =
      input.participants ??
      (await this.participantResolver?.resolve(
        {
          run_id: executionRunId,
          task_id: input.task_id,
          question: input.question,
          ...(input.participant_profile_refs
            ? { participant_profile_refs: input.participant_profile_refs }
            : {}),
          ...(input.primary_agent_id ? { primary_agent_id: input.primary_agent_id } : {}),
        },
        options?.onLifecycleEvent ? { onLifecycleEvent: options.onLifecycleEvent } : undefined,
      ));
    if (!participants) {
      throw new Error(
        'Council participants are required; configure a participant resolver or pass explicit bindings',
      );
    }
    return validateParticipants(participants);
  }
}

function hasBlockingMailboxRequest(result: AgentExecutionResult): boolean {
  if (result.diagnostics.mailbox_wait === true) return true;
  const outcomes = result.diagnostics.mailbox_outcomes;
  return (
    Array.isArray(outcomes) &&
    outcomes.some(
      (outcome) =>
        outcome !== null &&
        typeof outcome === 'object' &&
        Reflect.get(outcome, 'kind') === 'request' &&
        Reflect.get(outcome, 'wait_for_reply') === true,
    )
  );
}

function isRecoverableRoleFailure(error: unknown): boolean {
  if (error instanceof CouncilRoleInactivityError) return true;
  if (!(error instanceof CouncilRoleExecutionError)) return false;
  // The facade already retries artifact-free transport failures. Do not multiply that budget.
  if (Number(error.failure_details.driver_attempts ?? 0) >= 2) return false;
  if (error.agent_status === 'cancelled' || error.failure_details.retryable === false) return false;
  return error.agent_status === 'interrupted' || error.failure_details.retryable === true;
}

async function writeProposalManifest(
  workspace: string,
  proposals: readonly Proposal[],
  artifacts: readonly ArtifactRef[],
): Promise<void> {
  await fs.writeFile(
    path.join(workspace, 'proposals.json'),
    JSON.stringify(
      {
        proposals: proposals.map((proposal) => ({
          ...proposal,
          files: artifacts
            .filter(
              (artifact) =>
                proposal.artifact_refs.includes(artifact.artifact_id) &&
                isMaterializableFileArtifact(artifact),
            )
            .map((artifact) => ({
              artifact_id: artifact.artifact_id,
              path: `inputs/${artifact.artifact_id}/${artifact.content!.target_path!.replaceAll('\\', '/')}`,
            })),
        })),
      },
      null,
      2,
    ),
    'utf-8',
  );
}

async function readReviews(
  result: AgentExecutionResult,
  workspace: string,
): Promise<ParsedReview[] | undefined> {
  const artifact = result.artifact_refs.find(isCouncilReviewArtifact);
  if (artifact) return parseReviewPayload((await readArtifactBytes(artifact)).toString('utf8'));
  try {
    const file = await fs.realpath(path.join(workspace, 'reviews.json'));
    const root = await fs.realpath(workspace);
    if (!file.startsWith(`${root}${path.sep}`))
      throw new Error('Review file escapes Council workspace');
    return parseReviewPayload(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return parseReviewPayload(result.response);
}

function completedProposalEvent(
  councilRunId: string,
  phaseId: string,
  proposal: Proposal,
  participant: CouncilParticipantBinding,
  result: AgentExecutionResult,
): CouncilLifecycleEvent {
  return {
    type: 'council.proposal.completed',
    payload: {
      council_run_id: councilRunId,
      phase_id: phaseId,
      phase: 'proposal',
      ...participantAuditPayload(participant),
      agent_run_id: result.agent_run_id,
      driver_run_result_id: result.driver_run_result_id,
      context_pack_ref: result.context_pack_ref,
      memory_buffer_ref: result.memory_buffer_ref,
      session_id: result.session_id,
      proposal_id: proposal.proposal_id,
      proposal: { ...proposal },
      artifact_refs: proposal.artifact_refs,
    },
  };
}

function completedReusedProposalEvent(
  councilRunId: string,
  proposal: Proposal,
  participant: CouncilParticipantBinding,
): CouncilLifecycleEvent {
  return {
    type: 'council.proposal.completed',
    payload: {
      council_run_id: councilRunId,
      ...participantAuditPayload(participant),
      proposal_id: proposal.proposal_id,
      proposal: { ...proposal },
      artifact_refs: proposal.artifact_refs,
      reused: true,
      phase: 'proposal',
    },
  };
}

function failedEvent(error: CouncilRoleExecutionError): CouncilLifecycleEvent {
  return {
    type: 'council.role.failed',
    payload: {
      code: error.code,
      ...error.details,
      phase: error.council_phase,
      attempt: error.failure_details.attempt,
      will_retry: error.failure_details.will_retry === true,
      fallback_action: error.failure_details.will_retry === true ? 'retry_role' : 'continue_with_available_evidence',
    },
  };
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
  if (error instanceof CouncilRoleInactivityError) {
    return {
      error_name: error.name,
      error_message: error.message,
      inactivity_timeout_ms: error.inactivity_timeout_ms,
      ...(error.session_id ? { session_id: error.session_id } : {}),
    };
  }
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      ...(typeof Reflect.get(error, 'retryable') === 'boolean'
        ? { retryable: Reflect.get(error, 'retryable') }
        : {}),
    };
  }
  return { error_message: String(error) };
}

function positiveTimeout(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function createInactivitySignal(
  parent: AbortSignal | undefined,
  inactivityTimeoutMs: number,
  participant: CouncilParticipantBinding,
  phase: CouncilPhase,
): {
  signal: AbortSignal;
  observe(event: DriverStreamEvent): void;
  triggered(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let inactive = false;
  let started = false;
  let timer: NodeJS.Timeout | undefined;
  const abortFromParent = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      inactive = true;
      controller.abort(new CouncilRoleInactivityError(participant, phase, inactivityTimeoutMs));
    }, inactivityTimeoutMs);
    timer.unref?.();
  };
  return {
    signal: controller.signal,
    observe: (event) => {
      if (
        ['driver.turn_completed', 'driver.turn_failed', 'driver.turn_cancelled'].includes(
          event.event_type,
        )
      ) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        started = false;
        return;
      }
      if (!started) {
        if (event.event_type !== 'driver.turn_started') return;
        started = true;
      }
      arm();
    },
    triggered: () => inactive,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

function agentFailureDetails(result: AgentExecutionResult): CouncilRoleFailureDetails {
  const details: CouncilRoleFailureDetails = {
    session_id: result.session_id,
    driver_attempts: result.diagnostics.driver_attempts,
  };
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
    ...(participant.conflict_flags ? { conflict_flags: [...participant.conflict_flags] } : {}),
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
  if (
    proposers.length < 2 ||
    new Set(proposers.map((item) => item.seat_index)).size !== proposers.length
  ) {
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

function participantWorkspace(councilDir: string, participant: CouncilParticipantBinding): string {
  return path.join(councilDir, participant.participant_id);
}

function participantAuditPayload(participant: CouncilParticipantBinding): Record<string, unknown> {
  return {
    participant_id: participant.participant_id,
    seat: participant.seat,
    council_seat: participant.seat,
    seat_index: participant.seat_index,
    agent_id: participant.agent_id,
    ...(participant.role_profile_ref ? { role_profile_ref: participant.role_profile_ref } : {}),
    ...(participant.selection_refs ? { selection_refs: [...participant.selection_refs] } : {}),
    ...(participant.conflict_flags ? { conflict_flags: participant.conflict_flags } : {}),
  };
}

function requireDriverDelegation(instruction: string): string {
  return [
    instruction,
    '',
    'Council execution requirement: call the invoke_driver tool before marking the task complete. Do not complete this role only from the top-level Agent.',
    'This Council phase must finish without waiting for another role. Do not send blocking Mailbox requests; record missing information in your report and continue with available evidence.',
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
    ...proposalReportFields(result.response, result.diagnostics.driver_report),
    affected_paths: result.artifact_refs.flatMap((artifact) =>
      artifact.content?.target_path ? [artifact.content.target_path] : [],
    ),
    completion_evidence: [result.driver_run_result_id],
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

/** 每个提案必须恰好有一条结构化评审；多一条少一条都算这次评审没有交付。 */
function coversEveryProposal(
  proposals: readonly Proposal[],
  parsed: ParsedReview[] | undefined,
): parsed is ParsedReview[] {
  return (
    parsed !== undefined &&
    proposals.every(
      (proposal) =>
        parsed.filter((review) => review.proposal_id === proposal.proposal_id).length === 1,
    )
  );
}

function buildReviews(
  proposals: readonly Proposal[],
  participant: CouncilParticipantBinding,
  result: AgentExecutionResult,
  parsed: readonly ParsedReview[],
): Review[] {
  return proposals.map((proposal) => {
    const item = parsed.find((candidate) => candidate.proposal_id === proposal.proposal_id);
    if (!item) {
      // coversEveryProposal 已在上游守过；这里报错而不是编造一条裁决。
      throw new Error(`Reviewer returned no structured review for ${proposal.proposal_id}`);
    }
    return {
      review_id: createId('review'),
      proposal_id: proposal.proposal_id,
      reviewer_id: result.agent_id ?? participant.agent_id,
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
    summary: proposalReportFields(result.response, result.diagnostics.driver_report).summary,
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
      ? synthesis?.summary || 'Synthesis agent produced the selected final candidate artifact.'
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
  const tagged = [
    ...raw.matchAll(/<<<DRIVER_RETURN>>>\s*([\s\S]*?)\s*<<<END_DRIVER_RETURN>>>/g),
  ].map((match) => match[1]?.trim() ?? '');
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(
    (match) => match[1]?.trim() ?? '',
  );
  for (const source of [raw, ...tagged, ...fenced].filter(Boolean)) {
    const parsed = parseReviewCandidate(source);
    if (parsed && parsed.length > 0) return parsed;
  }
  return parseEmbeddedReviewPayload(raw);
}

/**
 * 从文本任意位置抽出内嵌的评审报文。
 *
 * 真实 Driver 很少把评审报文当成整段回复：它通常裹在散文里、放在 `<<<DRIVER_RETURN>>>`
 * 标记块中，或直接挂在六字段报告对象上，而且常常没有代码围栏。整段解析、标记块解析和围栏
 * 解析都会落空，报文就此丢掉——2026-09-20 的 A3 批次里 14 题有 10 题就是这么退回模板裁决的。
 *
 * 这里以 `"reviews"` 为锚点，由内向外尝试每一个包裹它的 `{`，取第一个能解析成完整评审报文的
 * 候选。步数设上限，避免在超长回复上退化成二次方扫描。
 */
function parseEmbeddedReviewPayload(raw: string): ParsedReview[] | undefined {
  const anchor = raw.indexOf('"reviews"');
  if (anchor < 0) return undefined;
  const maxAttempts = 400;
  let attempts = 0;
  for (
    let start = raw.lastIndexOf('{', anchor);
    start >= 0 && attempts < maxAttempts;
    start = raw.lastIndexOf('{', start - 1)
  ) {
    attempts += 1;
    const candidate = extractJsonObject(raw, start);
    if (!candidate) continue;
    const parsed = parseReviewCandidate(candidate);
    if (parsed && parsed.length > 0) return parsed;
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
        !reason.trim() ||
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
      'Read proposals.json for proposal summaries and the exact mapping from proposal_id to staged input files. Read only those files inside this workspace; do not inspect parent directories, run state, market ledgers, other sessions or driver streams.',
      'Compare scope, implementation feasibility, unnecessary changes, risks, and verification coverage.',
      'Do not modify product files.',
      'Write reviews.json in this workspace: {"reviews":[{"proposal_id":"...","verdict":"approve|reject|needs_revision","reason":"...","unmet_criteria":[],"evidence_refs":[]}]}. Include exactly one review per proposal. Then return the normal structured Driver report.',
    ].join(' ');
  }
  return [
    `Review the isolated proposal inputs for: ${question}.`,
    `Proposal ids: ${proposals.map((proposal) => proposal.proposal_id).join(', ')}.`,
    'Use proposals.json to map each proposal_id to its staged files. Stay inside this workspace; do not inspect parent directories, run state, market ledgers or driver streams.',
    'Write reviews.json: {"reviews":[{"proposal_id":"...","verdict":"approve|reject|needs_revision","reason":"...","unmet_criteria":[],"evidence_refs":[]}]}. Include exactly one review per proposal. Then return the normal structured Driver report.',
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
      'Read proposals.json, its listed input files, and reviews.json. Stay inside this workspace; do not inspect parent directories, run state, market ledgers, other sessions or driver streams.',
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
    'Explain the selected approach and how review concerns were addressed in the Driver report summary.',
  ].join(' ');
}

function buildFinalizationInstruction(
  originalInstruction: string,
  phase: CouncilPhase,
  artifactMode: CouncilArtifactMode | undefined,
): string {
  const requiredArtifact =
    artifactMode === 'plan'
      ? phase === 'synthesis'
        ? 'final-plan.md'
        : phase === 'proposal'
          ? 'council-plan.md'
          : 'reviews.json'
      : undefined;
  return [
    originalInstruction,
    'STEERED CONTINUATION: continue the assigned work from the current Session and workspace.',
    'Inspect work already completed, avoid repeating it, and finish the remaining role responsibility.',
    ...(requiredArtifact ? [`Ensure ${requiredArtifact} exists before returning.`] : []),
    'Return the required structured Driver report in this turn.',
  ].join(' ');
}
