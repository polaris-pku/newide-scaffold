import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type ArtifactRef,
  type Event,
} from '../core';
import {
  ArtifactSelector,
  WorktreeMaterializer,
} from '../coordinator';
import {
  buildChangesetManifest,
  writeChangesetManifest,
  type ChangesetManifest,
} from '../coordinator/changeset-manifest';
import { buildDriverRunResultFromAgentExecution } from '../coordinator/agent-execution-driver-result';
import { buildRunOutputPaths } from '../coordinator/run-result';
import { DeliverArtifactHandler } from '../coordinator/handlers/deliver-artifact-handler';
import {
  evaluateCompletionCriteria,
  type CompletionCriteriaEvaluation,
} from '../coordinator/completion-criteria-evaluator';
import { readArtifactContentBytes, sha256 } from '../coordinator/artifact-content';
import type { SelectAgentHandler } from '../coordinator/handlers/select-agent-handler';
import { AutonomousCouncilHandler } from '../coordinator/handlers/autonomous-council-handler';
import type { IntegrationV0GateExecutor } from '../coordinator/gate-executor';
import type { CouncilProvider, CouncilRunResult, EvidencePack } from '../council';
import type { GateResult } from '../gate';
import type { TaskResumeCursor } from '../persistence';
import type { AgentExecutionFacade, AgentExecutionResult } from '../protocol/agent-execution';
import type {
  CouncilStageExecutor,
  DeliverStageExecutor,
  ExecuteAgentStageExecutor,
  GateStageExecutor,
  SelectAgentStageExecutor,
  TaskExecutionLoopExecutors,
  TaskStageExecutionContext,
} from './task-execution-loop';

export interface ProductionStageExecutorDependencies {
  selectAgentHandler: Pick<SelectAgentHandler, 'execute'>;
  agentExecutionFacade: AgentExecutionFacade;
  councilProvider: CouncilProvider;
  gateExecutor: IntegrationV0GateExecutor;
  bootstrapAgentIds: readonly string[];
  runsRoot: string;
  councilRoot: string;
  worktreesRoot: string;
  deliverArtifactHandler?: DeliverArtifactHandler;
}

interface ProductionSelectionState {
  mode: 'single_agent' | 'council';
  selected_artifacts: ArtifactRef[];
  producer_agent_id: string;
  response: string;
  session_id: string;
  driver_id: string;
  expected_sha256: string;
  manifest_ref: string;
  council_run_result?: CouncilRunResult;
}

interface ProductionStageState {
  schema_version: string;
  run_id: string;
  task_id: string;
  primary?: {
    result: AgentExecutionResult;
  };
  selection?: ProductionSelectionState;
  gate?: {
    gate_results: GateResult[];
    completion_evaluation: CompletionCriteriaEvaluation;
    manifest: ChangesetManifest;
    materialization: {
      worktree_path: string;
      files_written: string[];
      changed_files: string[];
      status: 'completed' | 'partial' | 'failed';
      failures: Array<{ artifact_id: string; reason: string }>;
    };
  };
  delivery?: {
    manifest_id: string;
    idempotency_key: string;
    files: Array<{
      artifact_ref: string;
      relative_path: string;
      file_path: string;
      sha256: string;
      bytes_written: number;
    }>;
  };
}

/**
 * Production TaskExecutionLoop adapters.
 *
 * Every stage calls an existing real boundary: AgentMarket, AgentExecutionFacade,
 * CouncilProvider, production Gate, canonical ChangesetManifest, worktree
 * materialization and idempotent Deliver. Cross-stage state is written under the
 * run directory so a stage never relies on process-memory handoff.
 */
export function createProductionStageExecutors(
  dependencies: ProductionStageExecutorDependencies,
): TaskExecutionLoopExecutors {
  const stateStore = new ProductionStageStateStore(dependencies.runsRoot);
  const deliverArtifactHandler =
    dependencies.deliverArtifactHandler ?? new DeliverArtifactHandler();

  const selectAgent: SelectAgentStageExecutor = {
    async execute(context) {
      context.signal?.throwIfAborted();
      const candidateIds =
        context.cursor_input.candidate_ids.length > 0
          ? context.cursor_input.candidate_ids
          : context.task_request.role_id
            ? [context.task_request.role_id]
          : [...dependencies.bootstrapAgentIds];
      const result = await dependencies.selectAgentHandler.execute({
        task_id: context.task_id,
        task_description: context.task_request.spec,
        bootstrap_agent_ids: candidateIds,
        seed: context.cursor_input.seed,
      });
      emit(context, 'market.selected', result.winner_agent_id, {
        winner_agent_id: result.winner_agent_id,
        winner_bid_id: result.winner_bid_id,
        ledger_ref: result.ledger_ref,
        audit_ref: result.audit_ref,
        policy_version: result.ledger.policy_version,
        seed: result.ledger.seed,
      });
      return {
        winner_agent_id: result.winner_agent_id,
        evidence: {
          winner_agent_id: result.winner_agent_id,
          winner_bid_id: result.winner_bid_id,
          ledger_ref: result.ledger_ref,
          audit_ref: result.audit_ref,
          policy_version: result.ledger.policy_version,
          seed: result.ledger.seed,
        },
        artifact_refs: [result.ledger_ref, result.audit_ref],
      };
    },
  };

  const executeAgent: ExecuteAgentStageExecutor = {
    async execute(context) {
      context.signal?.throwIfAborted();
      const executionWorkspace =
        context.mode === 'council'
          ? path.join(dependencies.councilRoot, context.run_id, 'primary')
          : context.workspace_path;
      await fs.mkdir(executionWorkspace, { recursive: true });
      emit(context, 'agent.execution_requested', context.run_id, {
        role_id: context.cursor_input.winner_agent_id,
        workspace_path: executionWorkspace,
      });
      const result = await dependencies.agentExecutionFacade.runAgent(
        {
          task_id: context.task_id,
          run_id: context.run_id,
          role_id: context.cursor_input.winner_agent_id,
          instruction: context.task_request.spec,
          workspace_path: executionWorkspace,
          input_artifact_refs: [],
          context_policy: 'production_task_loop',
          schema_version: SCHEMA_VERSION,
          ...(context.session_id ? { session_id: context.session_id } : {}),
        },
        {
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.on_driver_event ? { onDriverEvent: context.on_driver_event } : {}),
        },
      );
      if (result.status !== 'completed') {
        throw new Error(`Primary Agent ended with status ${result.status}`);
      }
      const selection = await selectionState({
        context,
        mode: 'single_agent',
        artifacts: result.artifact_refs,
        producerAgentId: result.agent_id ?? result.role_id,
        response: result.response,
        sessionId: result.session_id,
        driverId: String(result.diagnostics.driver_id ?? result.role_id),
        runsRoot: dependencies.runsRoot,
      });
      await stateStore.update(context.run_id, context.task_id, {
        primary: { result },
        selection,
      });
      emit(context, 'memory.context_pack_built', result.context_pack_ref, {
        agent_id: result.agent_id ?? result.role_id,
        role_id: result.role_id,
        context_pack_ref: result.context_pack_ref,
        memory_buffer_ref: result.memory_buffer_ref,
        diagnostics: result.diagnostics,
      });
      emit(context, 'agent.execution_completed', result.agent_run_id, {
        agent_id: result.agent_id ?? result.role_id,
        role_id: result.role_id,
        status: result.status,
        session_id: result.session_id,
        response: result.response,
        artifact_refs: result.artifact_refs.map((artifact) => artifact.artifact_id),
        transcript_ref: result.transcript_ref.artifact_id,
        context_pack_ref: result.context_pack_ref,
        memory_buffer_ref: result.memory_buffer_ref,
        driver_run_result_id: result.driver_run_result_id,
        diagnostics: result.diagnostics,
      });
      if (context.mode === 'single_agent') {
        emit(context, 'artifact.selected', selection.manifest_ref, {
          mode: 'single_agent',
          selected_artifact_refs: result.artifact_refs.map((artifact) => artifact.artifact_id),
        });
      }
      return {
        changeset_ref: selection.manifest_ref,
        expected_sha256: selection.expected_sha256,
        agent_id: result.agent_id ?? result.role_id,
        session_id: result.session_id,
        evidence: {
          status: result.status,
          agent_id: result.agent_id ?? result.role_id,
          role_id: result.role_id,
          session_id: result.session_id,
          context_pack_ref: result.context_pack_ref,
          memory_buffer_ref: result.memory_buffer_ref,
          driver_run_result_id: result.driver_run_result_id,
          artifact_refs: result.artifact_refs.map((artifact) => artifact.artifact_id),
          changeset_ref: selection.manifest_ref,
          expected_sha256: selection.expected_sha256,
        },
        artifact_refs: [
          result.transcript_ref.artifact_id,
          ...result.artifact_refs.map((artifact) => artifact.artifact_id),
        ],
      };
    },
  };

  const council: CouncilStageExecutor = {
    async execute(context) {
      context.signal?.throwIfAborted();
      const state = await stateStore.require(context.run_id);
      const primary = state.primary?.result;
      if (!primary) throw new Error('Council stage has no persisted Primary Agent result');
      const driverResult = buildDriverRunResultFromAgentExecution({
        result: primary,
        session_id: primary.session_id,
        schema_version: SCHEMA_VERSION,
      });
      const evidencePack: EvidencePack = {
        evidence_pack_id: createId('evidence_pack'),
        task_id: context.task_id,
        context_pack_ref: primary.context_pack_ref,
        artifact_refs: driverResult.artifacts.map((artifact) => artifact.artifact_id),
        gate_result_refs: [],
        summary: 'Persisted Primary Agent evidence for production Council stage.',
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      };
      emit(context, 'council.started', context.run_id, {
        trigger: context.cursor_input.trigger,
        candidate_artifact_refs: evidencePack.artifact_refs,
      });
      const selector = new ArtifactSelector({
        mode: 'council',
        councilProvider: dependencies.councilProvider,
        councilHandler: new AutonomousCouncilHandler({
          councilProvider: dependencies.councilProvider,
        }),
      });
      const selected = await selector.selectArtifacts(
        {
          run_id: context.run_id,
          task_id: context.task_id,
          driver_result: driverResult,
          gate_results: [],
          evidence_pack: evidencePack,
          question: context.task_request.spec,
          workspace_path: context.workspace_path,
        },
        {
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.on_driver_event ? { onDriverEvent: context.on_driver_event } : {}),
          onCouncilLifecycleEvent: (event) =>
            emit(context, event.type, context.run_id, event.payload),
        },
      );
      if (selected.selected_artifacts.length === 0) {
        throw new Error('Council produced no selected artifact');
      }
      const councilRunResult = selected.council_run_result;
      if (!councilRunResult) throw new Error('Council stage returned no CouncilRunResult');
      const selection = await selectionState({
        context,
        mode: 'council',
        artifacts: selected.selected_artifacts,
        producerAgentId:
          councilRunResult.participants?.find(
            (participant) => participant.seat === 'synthesizer',
          )?.agent_id ??
          primary.agent_id ??
          primary.role_id,
        response: councilRunResult.decision.reason || primary.response,
        sessionId: primary.session_id,
        driverId: String(primary.diagnostics.driver_id ?? primary.role_id),
        runsRoot: dependencies.runsRoot,
        councilRunResult,
      });
      await stateStore.update(context.run_id, context.task_id, { selection });
      emit(context, 'council.decision', councilRunResult.decision.decision_id, {
        ...councilRunResult.decision,
        participants: councilRunResult.participants ?? [],
      });
      emit(context, 'council.completed', councilRunResult.council_run_id, {
        decision_id: councilRunResult.decision.decision_id,
        verdict: councilRunResult.decision.verdict,
        decision_mode: councilRunResult.decision.decision_mode,
        selected_artifact_refs: councilRunResult.selected_artifact_refs,
        participants: councilRunResult.participants,
        proposals: councilRunResult.proposals,
        reviews: councilRunResult.reviews,
        synthesis: councilRunResult.synthesis,
        output: councilRunResult.output,
        result: councilRunResult.result,
      });
      emit(context, 'artifact.selected', selection.manifest_ref, {
        mode: 'council',
        selected_artifact_refs: selected.selected_artifacts.map(
          (artifact) => artifact.artifact_id,
        ),
      });
      return {
        changeset_ref: selection.manifest_ref,
        expected_sha256: selection.expected_sha256,
        evidence: {
          council_run_id: councilRunResult.council_run_id,
          decision: councilRunResult.decision,
          participants: councilRunResult.participants,
          selected_artifact_refs: councilRunResult.selected_artifact_refs,
          changeset_ref: selection.manifest_ref,
          expected_sha256: selection.expected_sha256,
        },
        artifact_refs: selected.selected_artifacts.map((artifact) => artifact.artifact_id),
      };
    },
  };

  const gate: GateStageExecutor = {
    async execute(context) {
      context.signal?.throwIfAborted();
      const state = await stateStore.require(context.run_id);
      const selection = state.selection;
      if (!selection) throw new Error('Gate stage has no persisted artifact selection');
      if (
        context.cursor_input.changeset_ref !== selection.manifest_ref ||
        context.cursor_input.expected_sha256 !== selection.expected_sha256
      ) {
        throw new Error('Gate stage selection identity does not match the persisted state');
      }
      const gateResult = await dependencies.gateExecutor.execute({
        run_id: context.run_id,
        task_id: context.task_id,
        phase: context.mode === 'council' ? 'post_council' : 'pre_selection',
        workspace_path: context.workspace_path,
        completion_criteria: context.task_request.completion_criteria,
        artifact_refs: selection.selected_artifacts.map((artifact) => artifact.artifact_id),
      });
      for (const result of gateResult.gate_results) {
        emit(context, 'gate.result', result.gate_result_id, {
          phase: context.mode === 'council' ? 'post_council' : 'pre_selection',
          ...result,
        });
      }
      const denied = gateResult.gate_results.find((result) => result.decision === 'deny');
      const blocked = gateResult.gate_results.find(
        (result) => result.decision === 'ask' || result.decision === 'defer',
      );
      const manifest = await buildChangesetManifest({
        run_id: context.run_id,
        task_id: context.task_id,
        mode: selection.mode,
        base_ref: `workspace-before-run:${context.run_id}`,
        selected_artifacts: selection.selected_artifacts,
        gate_results: gateResult.gate_results,
        producer_agent_id: selection.producer_agent_id,
        task_worktree_path: path.join(dependencies.worktreesRoot, context.task_id),
        manifest_path: pathFromFileRef(selection.manifest_ref),
        delivery_receipt_path: buildRunOutputPaths(
          context.run_id,
          dependencies.runsRoot,
        ).delivery_receipt_path,
        user_workspace_path: context.workspace_path,
        ...(context.mode === 'council'
          ? {
              council_workspace_path: path.join(dependencies.councilRoot, context.run_id),
            }
          : {}),
      });
      await writeChangesetManifest(manifest);
      const materialization = await new WorktreeMaterializer({
        baseWorktreePath: dependencies.worktreesRoot,
      }).materialize({ task_id: context.task_id, manifest });
      const completionEvaluation = evaluateCompletionCriteria({
        completion_criteria: context.task_request.completion_criteria,
        gate_results: gateResult.gate_results,
        artifact_manifest: {
          artifact_refs: selection.selected_artifacts.map((artifact) => artifact.artifact_id),
          changed_files: materialization.changed_files,
          response_available: selection.response.trim().length > 0,
          has_materializable_artifact: manifest.entries.some(
            (entry) =>
              entry.delivery_strategy === 'copy_file' ||
              entry.delivery_strategy === 'already_in_workspace',
          ),
          materialization_status: materialization.status,
        },
        execution_succeeded: true,
      });
      await stateStore.update(context.run_id, context.task_id, {
        gate: {
          gate_results: gateResult.gate_results,
          completion_evaluation: completionEvaluation,
          manifest,
          materialization: {
            worktree_path: materialization.worktree_path,
            files_written: materialization.files_written,
            changed_files: materialization.changed_files,
            status: materialization.status,
            failures: materialization.failures,
          },
        },
      });
      emit(context, 'worktree.materialized', manifest.manifest_id, {
        changeset_manifest_ref: selection.manifest_ref,
        worktree_path: materialization.worktree_path,
        files_written: materialization.files_written,
        changed_files: materialization.changed_files,
        status: materialization.status,
        failures: materialization.failures,
      });
      emit(context, 'completion.evaluated', context.run_id, {
        outcome: completionEvaluation.outcome,
        changeset_manifest_ref: selection.manifest_ref,
        changeset_manifest_id: manifest.manifest_id,
        worktree_path: materialization.worktree_path,
      });
      const status =
        denied || completionEvaluation.outcome.status === 'failed'
          ? 'denied'
          : blocked || completionEvaluation.outcome.status === 'blocked'
            ? 'blocked'
            : 'allowed';
      return {
        status,
        ...(status === 'allowed'
          ? {}
          : {
              error: {
                code: denied ? 'gate_denied' : 'gate_blocked',
                message:
                  denied?.reason ??
                  blocked?.reason ??
                  completionEvaluation.outcome.reason,
                details: {
                  gate_result_refs: gateResult.gate_results.map(
                    (result) => result.gate_result_id,
                  ),
                  run_outcome: completionEvaluation.outcome,
                },
              },
            }),
        evidence: {
          hook_point: gateResult.hook_point,
          matched: gateResult.matched,
          gate_results: gateResult.gate_results,
          run_outcome: completionEvaluation.outcome,
          changeset_manifest_ref: selection.manifest_ref,
          changeset_manifest_id: manifest.manifest_id,
          materialization,
        },
        artifact_refs: [
          selection.manifest_ref,
          ...gateResult.gate_results.flatMap((result) =>
            result.audit_ref ? [result.audit_ref] : [],
          ),
          ...materialization.files_written,
        ],
      };
    },
  };

  const deliver: DeliverStageExecutor = {
    async execute(context) {
      context.signal?.throwIfAborted();
      const state = await stateStore.require(context.run_id);
      const gateState = state.gate;
      const selection = state.selection;
      if (!gateState || !selection) {
        throw new Error('Deliver stage has no persisted Gate-approved ChangesetManifest');
      }
      if (
        context.cursor_input.changeset_ref !== selection.manifest_ref ||
        context.cursor_input.expected_sha256 !== selection.expected_sha256
      ) {
        throw new Error('Deliver stage changeset identity does not match the Gate-approved state');
      }
      const delivery = await deliverArtifactHandler.execute({ manifest: gateState.manifest });
      await stateStore.update(context.run_id, context.task_id, {
        delivery: {
          manifest_id: delivery.manifest_id,
          idempotency_key: delivery.idempotency_key,
          files: delivery.files,
        },
      });
      emit(context, 'artifact.delivered', gateState.manifest.manifest_id, {
        manifest_id: delivery.manifest_id,
        changeset_manifest_ref: selection.manifest_ref,
        idempotency_key: delivery.idempotency_key,
        workspace_path: delivery.workspace_path,
        delivery_receipt_path: gateState.manifest.paths.delivery_receipt_path,
        files: delivery.files,
        quality: gateState.completion_evaluation.outcome,
      });
      const firstFile = delivery.files[0]?.file_path ?? context.workspace_path;
      return {
        final_output: {
          artifact_ref: selection.manifest_ref,
          sha256: selection.expected_sha256,
          workspace_path: firstFile,
        },
        ...(gateState.completion_evaluation.outcome.status === 'best_effort'
          ? { warnings: [gateState.completion_evaluation.outcome.reason] }
          : {}),
        evidence: {
          manifest_id: delivery.manifest_id,
          changeset_manifest_ref: selection.manifest_ref,
          idempotency_key: delivery.idempotency_key,
          delivery_receipt_path: gateState.manifest.paths.delivery_receipt_path,
          files: delivery.files,
          run_outcome: gateState.completion_evaluation.outcome,
        },
        artifact_refs: [
          selection.manifest_ref,
          pathToFileURL(gateState.manifest.paths.delivery_receipt_path).href,
          ...delivery.files.map((file) => pathToFileURL(file.file_path).href),
        ],
      };
    },
  };

  return {
    select_agent: selectAgent,
    execute_agent: executeAgent,
    council,
    gate,
    deliver,
  };
}

async function selectionState(input: {
  context: TaskStageExecutionContext<'execute_agent'> | TaskStageExecutionContext<'council'>;
  mode: 'single_agent' | 'council';
  artifacts: ArtifactRef[];
  producerAgentId: string;
  response: string;
  sessionId: string;
  driverId: string;
  runsRoot: string;
  councilRunResult?: CouncilRunResult;
}): Promise<ProductionSelectionState> {
  const outputPaths = buildRunOutputPaths(input.context.run_id, input.runsRoot);
  return {
    mode: input.mode,
    selected_artifacts: input.artifacts.map((artifact) => ({ ...artifact })),
    producer_agent_id: input.producerAgentId,
    response: input.response,
    session_id: input.sessionId,
    driver_id: input.driverId,
    expected_sha256: await artifactSetHash(input.artifacts, input.response),
    manifest_ref: pathToFileURL(outputPaths.changeset_manifest_path).href,
    ...(input.councilRunResult ? { council_run_result: input.councilRunResult } : {}),
  };
}

async function artifactSetHash(artifacts: readonly ArtifactRef[], response: string): Promise<string> {
  const entries = await Promise.all(
    artifacts.map(async (artifact) => {
      let artifactHash = artifact.sha256;
      if (!artifactHash || !/^[a-f0-9]{64}$/.test(artifactHash)) {
        const bytes = await readArtifactContentBytes(artifact).catch(() =>
          Buffer.from(JSON.stringify(artifact), 'utf8'),
        );
        artifactHash = sha256(bytes);
      }
      return `${artifact.artifact_id}:${artifactHash}`;
    }),
  );
  return createHash('sha256')
    .update(JSON.stringify({ entries: entries.sort(), response }))
    .digest('hex');
}

function emit<TCursor extends TaskResumeCursor>(
  context: TaskStageExecutionContext<TCursor>,
  eventType: string,
  subjectId: string,
  payload: Record<string, unknown>,
): void {
  if (!context.on_event) return;
  const event: Event = {
    event_id: createId('event'),
    event_type: eventType,
    subject_id: subjectId,
    task_id: context.task_id,
    run_id: context.run_id,
    payload,
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
  context.on_event(event);
}

class ProductionStageStateStore {
  constructor(private readonly runsRoot: string) {}

  async require(runId: string): Promise<ProductionStageState> {
    const state = await this.read(runId);
    if (!state) throw new Error(`Run ${runId} has no production stage state`);
    return state;
  }

  async update(
    runId: string,
    taskId: string,
    patch: Partial<Omit<ProductionStageState, 'schema_version' | 'run_id' | 'task_id'>>,
  ): Promise<void> {
    const current =
      (await this.read(runId)) ??
      ({
        schema_version: SCHEMA_VERSION,
        run_id: runId,
        task_id: taskId,
      } satisfies ProductionStageState);
    if (current.task_id !== taskId) throw new Error(`Run ${runId} belongs to another Task`);
    const target = this.path(runId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      temporary,
      JSON.stringify({ ...current, ...patch }, null, 2),
      'utf8',
    );
    await fs.rename(temporary, target);
  }

  private async read(runId: string): Promise<ProductionStageState | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.path(runId), 'utf8')) as ProductionStageState;
    } catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  private path(runId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Invalid run_id: ${runId}`);
    return path.join(this.runsRoot, runId, 'production-stage-state.json');
  }
}

function pathFromFileRef(reference: string): string {
  const url = new URL(reference);
  if (url.protocol !== 'file:') throw new Error(`Expected file ChangesetManifest ref: ${reference}`);
  return decodeURIComponent(url.pathname);
}
