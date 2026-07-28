import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type Checkpoint,
  type Event,
  type Message,
  type MessageId,
  type RoleProfileRef,
  type SchemaVersion,
  type TaskCreateRequest,
  type Timestamp,
} from '../core';
import path from 'node:path';
import {
  MockDriver,
  runDriverPromptWithSignal,
  type DriverRunResult,
  type DriverRuntimeHandle,
} from '../driver';
import type { AgentExecutionFacade, AgentExecutionResult } from '../protocol/agent-execution';
import { HookEngine, type HookEvent, type HookResult } from '../hook';
import { DecisionAggregator, type GateResult } from '../gate';
import { MockMemoryProvider } from '../memory';
import { RuntimeOrchestrator } from './orchestrator';
import type { TelemetrySink } from '../telemetry/telemetry-sink';
import {
  ArtifactSelector,
  type ArtifactSelectionResult,
  type SelectionMode,
} from './artifact-finalizer';
import { buildDriverRunResultFromAgentExecution } from './agent-execution-driver-result';
import {
  WorktreeMaterializer,
  type MaterializationInput,
  type MaterializationResult,
} from './worktree-materializer';
import {
  MockCouncil,
  type CouncilDecision,
  type CouncilProvider,
  type EvidencePack,
} from '../council';
import { buildCouncilRunOutputPaths, writeCouncilRunOutputs } from '../council/council-run-output';
import { InMemoryMailboxStore, type MessageDelivery } from './mailbox-store';
import {
  sendDriverCompletedMessage,
  sendDriverRequestedMessage,
  sendTaskAssignedMessage,
} from './mailbox-handoff';
import { buildArtifactOutputs, type ArtifactOutput } from './artifact-output';
import {
  buildRunOutputPaths,
  buildRunResultManifest,
  writeIntegrationRunOutputs,
  type IntegrationRunResultManifest,
} from './run-result';
import { buildFrontendRunSnapshot, type FrontendRunSnapshot } from './frontend-run-snapshot';

export interface IntegrationV0TimelineItem {
  name: string;
  id: string;
}

export interface IntegrationV0Summary {
  run_id: string;
  task_id: string;
  mode: SelectionMode;
  status: 'completed' | 'failed';
  failure?: IntegrationV0Failure;
  worktree_path: string;
  /** F-eval ablation tag (B0–B3); echoed for --backend-summary alignment. */
  memory_ablation?: 'B0' | 'B1' | 'B2' | 'B3';
  artifacts_materialized: number;
  files_written: string[];
  changed_files: string[];
  materialization_status: MaterializationResult['status'];
  materialization_failures: MaterializationResult['failures'];
  artifact_outputs: ArtifactOutput[];
  driver_diagnostics: {
    driver_id: string;
    duration_ms: number;
  };
  checkpoint_id: string;
  checkpoint_path: string;
  mailbox_message_refs: MessageId[];
  mailbox_thread_id: string;
  council_decision_path?: string;
  council_proposals_path?: string;
  council_reviews_path?: string;
  council_synthesis_path?: string;
  council_output_path?: string;
  council_decision_id?: string;
  council_decision_mode?: CouncilDecision['decision_mode'];
  council_verdict?: CouncilDecision['verdict'];
  council_selected_artifact_refs?: string[];
  council_can_create_merge_authorization?: boolean;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface IntegrationV0Failure {
  code:
    | 'DRIVER_FAILED'
    | 'GATE_DENIED'
    | 'GATE_BLOCKED'
    | 'ARTIFACT_NOT_SELECTED'
    | 'MATERIALIZATION_FAILED'
    | 'MATERIALIZATION_PARTIAL';
  message: string;
  details: Record<string, unknown>;
}

export interface IntegrationV0HookEngine {
  handleEvent(event: HookEvent): Promise<HookResult>;
}

export interface IntegrationV0Materializer {
  materialize(input: MaterializationInput): Promise<MaterializationResult>;
}

export interface IntegrationV0Options {
  driver?: DriverRuntimeHandle;
  driverPrompt?: string;
  agentExecutionFacade?: AgentExecutionFacade;
  enableCouncil?: boolean;
  councilProvider?: CouncilProvider;
  hookEngine?: IntegrationV0HookEngine;
  materializer?: IntegrationV0Materializer;
  worktreePath?: string;
  runsRoot?: string;
  /** F Harness memory ablation; recorded on summary + context_pack events. */
  memoryAblation?: 'B0' | 'B1' | 'B2' | 'B3';
  telemetry?: TelemetrySink;
  signal?: AbortSignal;
  onEvent?: (event: Event) => void;
  onRunCreated?: (identity: { run_id: string; task_id: string }) => void;
}

export interface IntegrationV0Result {
  run_id: string;
  task_id: string;
  timeline: IntegrationV0TimelineItem[];
  driver_result: DriverRunResult;
  agent_execution_result?: AgentExecutionResult;
  selection_result: ArtifactSelectionResult;
  materialization_result: MaterializationResult;
  mailbox_thread: Message[];
  mailbox_deliveries: MessageDelivery[];
  summary: IntegrationV0Summary;
  frontend_snapshot: FrontendRunSnapshot;
  result_manifest: IntegrationRunResultManifest;
}

/**
 * Integration v0 Flow: End-to-end integration from task creation to worktree materialization.
 *
 * This is a v0 runner that connects A-B-C-D modules:
 * - A: Driver (MockDriver or ExternalDriverRuntime)
 * - B: Memory (MockMemoryProvider)
 * - C: Coordinator (RuntimeOrchestrator, ArtifactSelector, InMemoryMailboxStore)
 * - D: Gate (HookEngine)
 *
 * Key features:
 * - Real mailbox send/ack mechanism (task.assigned, driver.requested, driver.completed)
 * - Persistent output to .newide/runs/<run_id>/ (result.json, summary.json, timeline.json)
 * - Support single_agent (default) and council modes
 * - Support MockDriver (default) and external driver injection
 */
export async function runIntegrationV0Flow(
  options?: IntegrationV0Options,
): Promise<IntegrationV0Result> {
  options?.signal?.throwIfAborted();
  const orchestrator = new RuntimeOrchestrator({
    ...(options?.telemetry ? { telemetry: options.telemetry } : {}),
    ...(options?.onEvent ? { onEvent: options.onEvent } : {}),
  });
  const mailbox = new InMemoryMailboxStore();
  const timeline: IntegrationV0TimelineItem[] = [];
  const mailboxMessageRefs: MessageId[] = [];

  // 1. Create task
  const taskRequest: TaskCreateRequest = {
    spec: options?.driverPrompt || 'Run the integration v0 flow',
    role_id: 'role_ts_engineer',
    risk_level: 'low',
    affected_paths: ['src/**'],
    completion_criteria: ['integration v0 flow completes successfully'],
  };
  const task = orchestrator.createTask(taskRequest);
  timeline.push({ name: 'TaskCreated', id: task.task_id });

  // 2. Create run
  const run = orchestrator.createRun(task.task_id);
  options?.onRunCreated?.({ run_id: run.run_id, task_id: task.task_id });
  const threadId = run.run_id; // Use run_id as thread_id for v0
  timeline.push({ name: 'RunCreated', id: run.run_id });
  orchestrator.updateRunStatus(run.run_id, 'running');
  orchestrator.updateTaskStatus(task.task_id, 'claimed');
  orchestrator.updateTaskStatus(task.task_id, 'running');

  // 3. Select driver (injected or default MockDriver)
  const driver = options?.driver ?? new MockDriver();

  // 4. Mailbox: send task.assigned
  const taskAssignedResult = sendTaskAssignedMessage({
    mailbox,
    thread_id: threadId,
    task_id: task.task_id,
    driver_id: driver.driver_id,
    driver_session_id: driver.session_id,
  });
  mailboxMessageRefs.push(taskAssignedResult.message.message_id);

  // Record mailbox message sent event
  const taskAssignedEvent = orchestrator.appendEvent({
    event_type: 'mailbox.message_sent',
    subject_id: taskAssignedResult.message.message_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      message_type: 'task.assigned',
      from_agent_id: 'coordinator',
      to_agent_id: driver.driver_id,
    },
  });
  timeline.push({ name: 'MailboxMessageSent (task.assigned)', id: taskAssignedEvent.event_id });

  // 5. Build context pack (B: Memory)
  const roleProfileRef: RoleProfileRef = {
    role_id: 'role_ts_engineer',
    persona_ref: 'persona://role_ts_engineer/current',
    skill_refs: ['skill://typescript-integration'],
    capability_tags: ['typescript', 'integration', 'v0'],
    memory_policy: {
      allow_in_driver_context: true,
      allow_in_council_proposer: true,
      allow_in_council_judge: true,
      max_memory_items: 5,
    },
    schema_version: SCHEMA_VERSION,
  };

  const memory = new MockMemoryProvider();
  const contextPack = await memory.buildContextPack({
    task_id: task.task_id,
    role_profile_ref: roleProfileRef,
    memory_refs: [
      {
        memory_id: 'memory_integration_v0',
        kind: 'experience',
        uri: 'memory://integration/v0',
        summary: 'Integration v0 flow connects A-B-C-D modules.',
        schema_version: SCHEMA_VERSION,
      },
    ],
    artifact_refs: [],
  });
  options?.signal?.throwIfAborted();
  const memoryAblation = options?.memoryAblation;
  const contextEvent = orchestrator.appendEvent({
    event_type: 'memory.context_pack_built',
    subject_id: contextPack.context_pack_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      role_id: contextPack.role_profile_ref.role_id,
      memory_refs: contextPack.memory_refs.map((memoryRef) => memoryRef.memory_id),
      ...(memoryAblation ? { ablation: memoryAblation } : {}),
    },
  });
  timeline.push({ name: 'ContextPackBuilt', id: contextEvent.event_id });

  // 6. Start driver session
  const sessionEvent = orchestrator.appendEvent({
    event_type: 'driver.session_started',
    subject_id: driver.session_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      driver_id: driver.driver_id,
      capabilities: driver.capabilities,
    },
  });
  timeline.push({ name: 'DriverSessionStarted', id: sessionEvent.event_id });

  // 7. Mailbox: send driver.requested
  const driverRequestedResult = sendDriverRequestedMessage({
    mailbox,
    thread_id: threadId,
    task_id: task.task_id,
    run_id: run.run_id,
    driver_id: driver.driver_id,
    prompt: options?.driverPrompt || taskRequest.spec,
  });
  mailboxMessageRefs.push(driverRequestedResult.message.message_id);

  // Record mailbox message sent event
  const driverRequestedEvent = orchestrator.appendEvent({
    event_type: 'mailbox.message_sent',
    subject_id: driverRequestedResult.message.message_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      message_type: 'driver.requested',
      from_agent_id: 'coordinator',
      to_agent_id: driver.driver_id,
      requires_ack: true,
    },
  });
  timeline.push({
    name: 'MailboxMessageSent (driver.requested)',
    id: driverRequestedEvent.event_id,
  });

  const driverRequestedAckEvent = orchestrator.appendEvent({
    event_type: 'mailbox.message_acked',
    subject_id: driverRequestedResult.acked_delivery.delivery_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      message_id: driverRequestedResult.message.message_id,
      message_type: 'driver.requested',
      acked_by: driver.driver_id,
    },
  });
  timeline.push({
    name: 'MailboxMessageAcked (driver.requested)',
    id: driverRequestedAckEvent.event_id,
  });

  // 8. Call driver directly, or route through B AgentExecutionFacade when explicitly injected.
  const prompt = options?.driverPrompt || taskRequest.spec;
  const contextPackRef = {
    context_pack_id: contextPack.context_pack_id,
    task_id: contextPack.task_id,
    uri: `artifact://context/${task.task_id}/${contextPack.context_pack_id}`,
    schema_version: SCHEMA_VERSION,
  };
  let agentExecutionResult: AgentExecutionResult | undefined;
  let driverResult: DriverRunResult;
  if (options?.agentExecutionFacade) {
    const agentExecutionRequest = {
      task_id: task.task_id,
      run_id: run.run_id,
      role_id: task.role_id ?? 'role_ts_engineer',
      instruction: prompt,
      input_artifact_refs: contextPack.artifact_refs,
      context_policy: 'integration_v0_default',
      schema_version: SCHEMA_VERSION,
    };
    const agentExecutionRequestedEvent = orchestrator.appendEvent({
      event_type: 'agent.execution_requested',
      subject_id: run.run_id,
      run_id: run.run_id,
      task_id: task.task_id,
      payload: {
        role_id: agentExecutionRequest.role_id,
        context_policy: agentExecutionRequest.context_policy,
        input_artifact_refs: agentExecutionRequest.input_artifact_refs,
      },
    });
    timeline.push({
      name: 'AgentExecutionRequested',
      id: agentExecutionRequestedEvent.event_id,
    });
    agentExecutionResult = await options.agentExecutionFacade.runAgent(agentExecutionRequest, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    driverResult = buildDriverRunResultFromAgentExecution({
      result: agentExecutionResult,
      session_id: driver.session_id,
      schema_version: SCHEMA_VERSION,
    });
  } else {
    driverResult = await runDriverPromptWithSignal(
      driver,
      {
        task_id: task.task_id,
        run_id: run.run_id,
        prompt,
        context_pack_ref: contextPackRef,
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      },
      options?.signal,
    );
  }
  options?.signal?.throwIfAborted();

  if (agentExecutionResult) {
    const agentExecutionEvent = orchestrator.appendEvent({
      event_type: 'agent.execution_completed',
      subject_id: agentExecutionResult.agent_run_id,
      run_id: run.run_id,
      task_id: task.task_id,
      payload: {
        role_id: agentExecutionResult.role_id,
        status: agentExecutionResult.status,
        artifact_refs: agentExecutionResult.artifact_refs.map((artifact) => artifact.artifact_id),
      },
    });
    timeline.push({ name: 'AgentExecutionCompleted', id: agentExecutionEvent.event_id });
  }

  // 9. Mailbox: send driver.completed
  const driverCompletedResult = sendDriverCompletedMessage({
    mailbox,
    thread_id: threadId,
    task_id: task.task_id,
    run_id: run.run_id,
    driver_id: driver.driver_id,
    driver_result: driverResult,
  });
  mailboxMessageRefs.push(driverCompletedResult.message.message_id);

  // Record mailbox message sent event
  const driverCompletedEvent = orchestrator.appendEvent({
    event_type: 'mailbox.message_sent',
    subject_id: driverCompletedResult.message.message_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      message_type: 'driver.completed',
      from_agent_id: driver.driver_id,
      to_agent_id: 'coordinator',
      status: driverResult.status,
    },
  });
  timeline.push({
    name: 'MailboxMessageSent (driver.completed)',
    id: driverCompletedEvent.event_id,
  });

  const driverResultEvent = orchestrator.appendEvent({
    event_type: 'driver.run_result',
    subject_id: driverResult.driver_run_result_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      status: driverResult.status,
      artifact_refs: driverResult.artifacts.map((artifact) => artifact.artifact_id),
      transcript_ref: driverResult.transcript_ref.artifact_id,
    },
  });
  timeline.push({ name: 'DriverRunResult', id: driverResultEvent.event_id });

  // 10. Register artifacts
  for (const artifact of driverResult.artifacts) {
    orchestrator.registerArtifact(artifact);
  }
  orchestrator.registerArtifact(driverResult.transcript_ref);
  if (driverResult.artifacts.length > 0) {
    timeline.push({ name: 'ArtifactRegistered', id: driverResult.artifacts[0]!.artifact_id });
  }

  // 11. Run gates (D: Gate)
  orchestrator.updateTaskStatus(task.task_id, 'reviewing');
  const taskCompletedEvent = orchestrator.appendEvent({
    event_type: 'task.completed',
    subject_id: task.task_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      summary: 'Driver completed the task.',
      artifact_refs: driverResult.artifacts.map((a) => a.artifact_id),
    },
  });
  timeline.push({ name: 'TaskCompleted', id: taskCompletedEvent.event_id });

  const hookEngine =
    options?.hookEngine ??
    new HookEngine({
      config: {
        version: 'hook-0.1',
        settings: {
          fail_fast: false,
          default_timeout: 30,
          parallel: false,
          output_format: 'json',
          emergency_env_var: 'AGENT_EMERGENCY_SKIP',
        },
        gates: {
          'allow-gate': {
            type: 'command',
            run: 'node -e "process.exit(0)"',
            retry_threshold: 1,
          },
        },
        hooks: {
          'task.completed': [{ gate: 'allow-gate', priority: 100, timeout: 30 }],
          'council.completed': [{ gate: 'allow-gate', priority: 100, timeout: 30 }],
        },
      },
      aggregator: new DecisionAggregator(),
    });

  const hookResult = await hookEngine.handleEvent({
    ...taskCompletedEvent,
    event_type: 'task.completed',
  });
  options?.signal?.throwIfAborted();

  const hookEvent = orchestrator.appendEvent({
    event_type: 'hook.matched',
    subject_id: taskCompletedEvent.event_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      hook_point: hookResult.hook_point,
      matched: hookResult.matched,
    },
  });
  timeline.push({ name: 'HookMatched', id: hookEvent.event_id });

  const preGateResults: GateResult[] = [...hookResult.gate_results];
  for (const gateResult of preGateResults) {
    const gateResultEvent = orchestrator.appendEvent({
      event_type: 'gate.result',
      subject_id: gateResult.gate_result_id,
      run_id: run.run_id,
      task_id: task.task_id,
      payload: {
        phase: options?.enableCouncil ? 'pre_council' : 'pre_selection',
        gate_result_id: gateResult.gate_result_id,
        gate_id: gateResult.gate_id,
        request_id: gateResult.request_id,
        decision: gateResult.decision,
        reason: gateResult.reason,
        target_state: gateResult.target_state,
        required_actions: gateResult.required_actions,
      },
    });
    timeline.push({ name: 'GateResult', id: gateResultEvent.event_id });
  }

  // 12. Artifact selection (C: Coordinator)
  const evidencePack: EvidencePack = {
    evidence_pack_id: createId('evidence_pack'),
    task_id: task.task_id,
    context_pack_ref: contextPack.context_pack_id,
    artifact_refs: driverResult.artifacts.map((a) => a.artifact_id),
    gate_result_refs: preGateResults.map((g) => g.gate_result_id),
    summary: 'Driver artifacts and gate results for v0 artifact selection.',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };

  const selectorOptions: {
    mode: SelectionMode;
    councilProvider?: CouncilProvider;
  } = {
    mode: options?.enableCouncil ? 'council' : 'single_agent',
  };
  if (options?.enableCouncil) {
    selectorOptions.councilProvider = options.councilProvider ?? new MockCouncil();
  }
  const selector = new ArtifactSelector(selectorOptions);
  const councilStartedAtMs = options?.enableCouncil ? Date.now() : undefined;
  if (options?.enableCouncil) {
    const councilStartedEvent = orchestrator.appendEvent({
      event_type: 'council.started',
      subject_id: run.run_id,
      run_id: run.run_id,
      task_id: task.task_id,
      payload: {
        trigger: 'user_choice',
        decision_mode: 'advisory',
        candidate_artifact_refs: evidencePack.artifact_refs,
        gate_result_refs: evidencePack.gate_result_refs,
      },
    });
    timeline.push({ name: 'CouncilStarted', id: councilStartedEvent.event_id });
  }

  const selectionResult = await selector.selectArtifacts(
    {
      run_id: run.run_id,
      task_id: task.task_id,
      driver_result: driverResult,
      gate_results: preGateResults,
      evidence_pack: evidencePack,
      question: task.spec,
    },
    {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.enableCouncil
        ? {
            onCouncilLifecycleEvent: (event) => {
              const domainEvent = orchestrator.appendEvent({
                event_type: event.type,
                subject_id:
                  typeof event.payload.agent_run_id === 'string'
                    ? event.payload.agent_run_id
                    : run.run_id,
                run_id: run.run_id,
                task_id: task.task_id,
                payload: event.payload,
              });
              timeline.push({ name: event.type, id: domainEvent.event_id });
            },
          }
        : {}),
    },
  );
  options?.signal?.throwIfAborted();

  if (selectionResult.council_decision) {
    const councilDecision = selectionResult.council_decision;
    const councilEvent = orchestrator.appendEvent({
      event_type: 'council.decision',
      subject_id: councilDecision.decision_id,
      run_id: run.run_id,
      task_id: task.task_id,
      payload: {
        decision_mode: councilDecision.decision_mode,
        selected_proposal_id: councilDecision.selected_proposal_id,
        verdict: councilDecision.verdict,
        comparison_ref: councilDecision.comparison_ref,
        can_create_merge_authorization: councilDecision.can_create_merge_authorization,
        termination_reason: councilDecision.verdict,
        current_round_count: 1,
        decision_packet_ref: councilDecision.decision_id,
      },
    });
    timeline.push({ name: 'CouncilDecision', id: councilEvent.event_id });
  }

  let councilCompletedEvent: Event | undefined;
  if (selectionResult.council_run_result) {
    const councilRunResult = selectionResult.council_run_result;
    councilCompletedEvent = orchestrator.appendEvent({
      event_type: 'council.completed',
      subject_id: councilRunResult.council_run_id,
      run_id: run.run_id,
      task_id: task.task_id,
      payload: {
        decision_id: councilRunResult.decision.decision_id,
        synthesis_id: councilRunResult.synthesis?.synthesis_id,
        verdict: councilRunResult.decision.verdict,
        selected_artifact_refs: councilRunResult.selected_artifact_refs,
        generated_artifact_refs: councilRunResult.generated_artifact_refs.map(
          (artifact) => artifact.artifact_id,
        ),
        total_rounds: 1,
        duration_ms: Date.now() - (councilStartedAtMs ?? Date.now()),
      },
    });
    timeline.push({ name: 'CouncilCompleted', id: councilCompletedEvent.event_id });
  }

  const selectionEvent = orchestrator.appendEvent({
    event_type: 'artifact.selected',
    subject_id: selectionResult.selection_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      mode: selectionResult.mode,
      selected_count: selectionResult.selected_artifacts.length,
    },
  });
  timeline.push({ name: 'ArtifactSelected', id: selectionEvent.event_id });

  const postCouncilGateResults: GateResult[] = [];
  const postCouncilGatesRequired = Boolean(councilCompletedEvent);
  if (councilCompletedEvent) {
    const postCouncilHookResult = await hookEngine.handleEvent({
      ...councilCompletedEvent,
      event_type: 'council.completed',
    });
    options?.signal?.throwIfAborted();
    const usedGateResultIds = new Set(preGateResults.map((gate) => gate.gate_result_id));
    for (const sourceGateResult of postCouncilHookResult.gate_results) {
      const duplicateId = usedGateResultIds.has(sourceGateResult.gate_result_id);
      const gateResult = duplicateId
        ? { ...sourceGateResult, gate_result_id: createId('gate_result') }
        : sourceGateResult;
      usedGateResultIds.add(gateResult.gate_result_id);
      postCouncilGateResults.push(gateResult);
      const gateResultEvent = orchestrator.appendEvent({
        event_type: 'gate.result',
        subject_id: gateResult.gate_result_id,
        run_id: run.run_id,
        task_id: task.task_id,
        payload: {
          phase: 'post_council',
          ...(duplicateId ? { source_gate_result_id: sourceGateResult.gate_result_id } : {}),
          gate_result_id: gateResult.gate_result_id,
          gate_id: gateResult.gate_id,
          request_id: gateResult.request_id,
          decision: gateResult.decision,
          reason: gateResult.reason,
          target_state: gateResult.target_state,
          required_actions: gateResult.required_actions,
        },
      });
      timeline.push({ name: 'PostCouncilGateResult', id: gateResultEvent.event_id });
    }
  }

  const preGatesPassed =
    preGateResults.length > 0 && preGateResults.every((gate) => gate.decision === 'allow');
  const postCouncilGatesPassed =
    !postCouncilGatesRequired ||
    (postCouncilGateResults.length > 0 &&
      postCouncilGateResults.every((gate) => gate.decision === 'allow'));
  const combinedGateResults = [...preGateResults, ...postCouncilGateResults];

  // 13. Worktree materialization (C: Coordinator)
  const materializer =
    options?.materializer ??
    new WorktreeMaterializer({
      baseWorktreePath: options?.worktreePath || '.newide/worktrees',
    });

  let materializationResult: MaterializationResult;
  const materializationSkipped = postCouncilGatesRequired && !postCouncilGatesPassed;
  if (materializationSkipped) {
    materializationResult = {
      materialization_id: createId('materialization'),
      task_id: task.task_id,
      worktree_path: path.join(options?.worktreePath ?? '.newide/worktrees', task.task_id),
      materialized_artifacts: [],
      files_written: [],
      changed_files: [],
      status: 'failed',
      failures: [
        {
          artifact_id: selectionResult.selected_artifacts[0]?.artifact_id ?? 'materializer',
          reason: 'Post-council gate did not allow materialization',
        },
      ],
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  } else {
    try {
      materializationResult = await materializer.materialize({
        task_id: task.task_id,
        artifacts: selectionResult.selected_artifacts,
      });
    } catch {
      materializationResult = {
        materialization_id: createId('materialization'),
        task_id: task.task_id,
        worktree_path: path.join(options?.worktreePath ?? '.newide/worktrees', task.task_id),
        materialized_artifacts: [],
        files_written: [],
        changed_files: [],
        status: 'failed',
        failures: [
          {
            artifact_id: selectionResult.selected_artifacts[0]?.artifact_id ?? 'materializer',
            reason: 'Materializer failed',
          },
        ],
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      };
    }
  }
  options?.signal?.throwIfAborted();

  const materializationEvent = orchestrator.appendEvent({
    event_type: 'worktree.materialized',
    subject_id: materializationResult.materialization_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      worktree_path: materializationResult.worktree_path,
      files_written: materializationResult.files_written.length,
      changed_files: materializationResult.changed_files,
      status: materializationResult.status,
      failures: materializationResult.failures,
      ...(materializationSkipped ? { skipped: true } : {}),
    },
  });
  timeline.push({ name: 'WorktreeMaterialized', id: materializationEvent.event_id });

  // 14. Calculate flow completion status
  const driverSucceeded = driverResult.status === 'succeeded';
  const gatesPassed = preGatesPassed && (!postCouncilGatesRequired || postCouncilGatesPassed);
  const hasSelectedArtifact = selectionResult.selected_artifacts.length > 0;
  const materialized =
    materializationResult.status === 'completed' && materializationResult.files_written.length > 0;
  const flowCompleted = driverSucceeded && gatesPassed && hasSelectedArtifact && materialized;
  const failure = buildIntegrationFailure({
    driverResult,
    preGateResults,
    postCouncilGateResults,
    postCouncilGatesRequired,
    hasSelectedArtifact,
    materializationResult,
  });

  // 15. Save checkpoint (C: Coordinator long-running state)
  const diffArtifactId =
    selectionResult.selected_artifacts.length > 0
      ? selectionResult.selected_artifacts[0]!.artifact_id
      : undefined;

  const mechanicalSnapshot: Checkpoint['mechanical_snapshot'] = {
    base_commit: 'demo-head',
    snapshot_commit: 'demo-head',
    worktree_path: materializationResult.worktree_path,
    branch: 'integration-v0-demo',
    modified_files: materializationResult.files_written,
  };
  if (diffArtifactId) {
    mechanicalSnapshot.diff_artifact_id = diffArtifactId;
  }

  const doneSteps: string[] = ['task created'];
  if (driverSucceeded) doneSteps.push('driver completed');
  if (gatesPassed) doneSteps.push('gates passed');
  if (hasSelectedArtifact) doneSteps.push('artifacts selected');
  if (materialized) doneSteps.push('worktree materialized');

  const blockedOn: string[] = [];
  if (!driverSucceeded) blockedOn.push('driver execution failed');
  if (!gatesPassed) blockedOn.push('gates blocked or not evaluated');
  if (!hasSelectedArtifact) blockedOn.push('no artifacts selected');
  if (!materialized) blockedOn.push('worktree materialization failed');

  const checkpoint: Checkpoint = {
    checkpoint_id: createId('checkpoint'),
    checkpoint_type: 'full',
    task_id: task.task_id,
    agent_id: driverResult.diagnostics.driver_id,
    trigger: 'manual',
    mechanical_snapshot: mechanicalSnapshot,
    semantic_handoff: {
      done: doneSteps,
      in_progress: [],
      blocked_on: blockedOn,
      assumptions: flowCompleted
        ? [
            'Integration v0 flow completed successfully',
            'Artifacts materialized to worktree',
            `Gate results: ${combinedGateResults.map((gate) => gate.gate_result_id).join(', ')}`,
          ]
        : [
            'Integration v0 flow partially completed',
            `Driver: ${driverResult.status}`,
            `Gates: ${gatesPassed ? 'passed' : 'blocked or not evaluated'}`,
            `Artifacts: ${hasSelectedArtifact ? 'selected' : 'none'}`,
            `Gate results: ${combinedGateResults.map((gate) => gate.gate_result_id).join(', ')}`,
          ],
      next_steps: flowCompleted
        ? ['Ready for user review', 'Can be resumed if needed']
        : ['Review failure points', 'May need retry or manual intervention'],
      known_risks: ['Checkpoint is in-memory only', 'Resume not yet implemented'],
    },
    runtime_state: {
      scheduler_policy: selectionResult.mode === 'council' ? 'council' : 'single_agent',
      current_turn: 1,
      next_agent_ref: 'user_review',
      resume_cursor: 'worktree.materialized',
    },
    artifact_refs: [
      ...selectionResult.selected_artifacts.map((a) => a.artifact_id),
      driverResult.transcript_ref.artifact_id,
    ],
    validity_status: 'valid',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };

  const savedCheckpoint = orchestrator.saveCheckpoint(checkpoint);
  timeline.push({ name: 'CheckpointSaved', id: savedCheckpoint.checkpoint_id });

  // 16. Mark run as completed or failed
  const finalTaskStatus = flowCompleted ? 'completed' : 'failed';
  const finalRunStatus = flowCompleted ? 'completed' : 'failed';
  orchestrator.updateTaskStatus(task.task_id, finalTaskStatus);
  orchestrator.updateRunStatus(run.run_id, finalRunStatus);
  const runCompletedEvent = orchestrator.appendEvent({
    event_type: flowCompleted ? 'run.completed' : 'run.failed',
    subject_id: run.run_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      status: finalRunStatus,
      ...(failure
        ? { code: failure.code, message: failure.message, details: failure.details }
        : {}),
    },
  });
  timeline.push({
    name: flowCompleted ? 'RunCompleted' : 'RunFailed',
    id: runCompletedEvent.event_id,
  });

  // 17. Build summary
  const outputPaths = buildRunOutputPaths(run.run_id, options?.runsRoot);
  const councilRunOutputPaths = selectionResult.council_run_result
    ? buildCouncilRunOutputPaths(run.run_id, options?.runsRoot)
    : undefined;
  if (selectionResult.council_run_result && councilRunOutputPaths) {
    await writeCouncilRunOutputs({
      paths: councilRunOutputPaths,
      result: selectionResult.council_run_result,
    });
  }

  const artifactOutputs = buildArtifactOutputs({
    artifacts: selectionResult.selected_artifacts,
    materialized_record_paths: materializationResult.files_written,
  });
  const summary: IntegrationV0Summary = {
    run_id: run.run_id,
    task_id: task.task_id,
    mode: selectionResult.mode,
    status: finalRunStatus,
    ...(failure ? { failure } : {}),
    worktree_path: materializationResult.worktree_path,
    ...(memoryAblation ? { memory_ablation: memoryAblation } : {}),
    artifacts_materialized: materializationResult.materialized_artifacts.length,
    files_written: materializationResult.files_written,
    changed_files: materializationResult.changed_files,
    materialization_status: materializationResult.status,
    materialization_failures: materializationResult.failures,
    artifact_outputs: artifactOutputs,
    driver_diagnostics: {
      driver_id: driverResult.diagnostics.driver_id,
      duration_ms: driverResult.diagnostics.duration_ms,
    },
    checkpoint_id: savedCheckpoint.checkpoint_id,
    checkpoint_path: outputPaths.checkpoint_path,
    mailbox_message_refs: mailboxMessageRefs,
    mailbox_thread_id: threadId,
    ...(selectionResult.council_decision && councilRunOutputPaths
      ? {
          council_decision_path: councilRunOutputPaths.decision_path,
          council_proposals_path: councilRunOutputPaths.proposals_path,
          council_reviews_path: councilRunOutputPaths.reviews_path,
          ...(selectionResult.council_run_result?.synthesis
            ? { council_synthesis_path: councilRunOutputPaths.synthesis_path }
            : {}),
          ...(selectionResult.council_run_result?.output
            ? { council_output_path: councilRunOutputPaths.output_path }
            : {}),
          council_decision_id: selectionResult.council_decision.decision_id,
          council_decision_mode: selectionResult.council_decision.decision_mode,
          council_verdict: selectionResult.council_decision.verdict,
          council_selected_artifact_refs: selectionResult.council_decision.selected_artifact_refs,
          council_can_create_merge_authorization:
            selectionResult.council_decision.can_create_merge_authorization,
        }
      : {}),
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
  const mailboxThread = mailbox.listThread(threadId);
  const mailboxDeliveries = mailbox.listDeliveries();
  const eventLog = orchestrator.stores.events.list();
  const frontendSnapshotLinks = {
    result_path: outputPaths.result_path,
    summary_path: outputPaths.summary_path,
    timeline_path: outputPaths.timeline_path,
    checkpoint_path: outputPaths.checkpoint_path,
    message_thread_path: outputPaths.message_thread_path,
    event_log_path: outputPaths.event_log_path,
    audit_path: outputPaths.audit_path,
    frontend_snapshot_path: outputPaths.frontend_snapshot_path,
  };
  const frontendSnapshot = buildFrontendRunSnapshot({
    task,
    summary,
    timeline,
    checkpoint: savedCheckpoint,
    message_thread: mailboxThread,
    ...(selectionResult.council_run_result
      ? { council_run_result: selectionResult.council_run_result }
      : {}),
    links: frontendSnapshotLinks,
  });
  const resultManifest = buildRunResultManifest({
    run_id: run.run_id,
    task_id: task.task_id,
    status: finalRunStatus,
    mode: selectionResult.mode,
    driver_id: driverResult.diagnostics.driver_id,
    artifact_outputs: artifactOutputs,
    changed_files: materializationResult.changed_files,
    materialization_status: materializationResult.status,
    materialization_failures: materializationResult.failures,
    result_path: outputPaths.result_path,
    summary_path: outputPaths.summary_path,
    timeline_path: outputPaths.timeline_path,
    checkpoint_path: outputPaths.checkpoint_path,
    message_thread_path: outputPaths.message_thread_path,
    event_log_path: outputPaths.event_log_path,
    audit_path: outputPaths.audit_path,
    frontend_snapshot_path: outputPaths.frontend_snapshot_path,
    ...(summary.council_decision_path
      ? {
          council_decision_path: summary.council_decision_path,
          council_proposals_path: summary.council_proposals_path,
          council_reviews_path: summary.council_reviews_path,
          council_synthesis_path: summary.council_synthesis_path,
          council_output_path: summary.council_output_path,
          council_verdict: summary.council_verdict,
          council_decision_mode: summary.council_decision_mode,
        }
      : {}),
    created_at: summary.created_at,
    schema_version: SCHEMA_VERSION,
  });

  // 18. Persist summary, timeline, checkpoint, and result manifest.
  await writeIntegrationRunOutputs({
    paths: outputPaths,
    summary,
    timeline,
    checkpoint: savedCheckpoint,
    message_thread: mailboxThread,
    event_log: eventLog,
    frontend_snapshot: frontendSnapshot,
    result_manifest: resultManifest,
  });

  return {
    run_id: run.run_id,
    task_id: task.task_id,
    timeline,
    driver_result: driverResult,
    ...(agentExecutionResult ? { agent_execution_result: agentExecutionResult } : {}),
    selection_result: selectionResult,
    materialization_result: materializationResult,
    mailbox_thread: mailboxThread,
    mailbox_deliveries: mailboxDeliveries,
    summary,
    frontend_snapshot: frontendSnapshot,
    result_manifest: resultManifest,
  };
}

function buildIntegrationFailure(input: {
  driverResult: DriverRunResult;
  preGateResults: GateResult[];
  postCouncilGateResults: GateResult[];
  postCouncilGatesRequired: boolean;
  hasSelectedArtifact: boolean;
  materializationResult: MaterializationResult;
}): IntegrationV0Failure | undefined {
  if (input.driverResult.status !== 'succeeded') {
    return {
      code: 'DRIVER_FAILED',
      message: input.driverResult.error?.message ?? 'Driver execution failed',
      details: { phase: 'driver', ...(input.driverResult.error ?? {}) },
    };
  }
  if (input.preGateResults.length === 0) {
    return {
      code: 'GATE_BLOCKED',
      message: 'Required gates were not evaluated',
      details: {
        phase: 'gate',
        gate_phase: input.postCouncilGatesRequired ? 'pre_council' : 'pre_selection',
        gate_results: [],
      },
    };
  }
  const preGatePhase = input.postCouncilGatesRequired ? 'pre_council' : 'pre_selection';
  const preDenied = input.preGateResults.find((gate) => gate.decision === 'deny');
  if (preDenied) {
    return {
      code: 'GATE_DENIED',
      message: `Gate ${preDenied.gate_id} denied the run`,
      details: { phase: 'gate', gate_phase: preGatePhase, gate_results: input.preGateResults },
    };
  }
  const preBlocked = input.preGateResults.find(
    (gate) => gate.decision === 'ask' || gate.decision === 'defer',
  );
  if (preBlocked) {
    return {
      code: 'GATE_BLOCKED',
      message: `Gate ${preBlocked.gate_id} blocked the run`,
      details: { phase: 'gate', gate_phase: preGatePhase, gate_results: input.preGateResults },
    };
  }
  if (input.postCouncilGatesRequired && input.postCouncilGateResults.length === 0) {
    return {
      code: 'GATE_BLOCKED',
      message: 'Required post-council gates were not evaluated',
      details: { phase: 'gate', gate_phase: 'post_council', gate_results: [] },
    };
  }
  const postDenied = input.postCouncilGateResults.find((gate) => gate.decision === 'deny');
  if (postDenied) {
    return {
      code: 'GATE_DENIED',
      message: `Gate ${postDenied.gate_id} denied the run`,
      details: {
        phase: 'gate',
        gate_phase: 'post_council',
        gate_results: input.postCouncilGateResults,
      },
    };
  }
  const postBlocked = input.postCouncilGateResults.find(
    (gate) => gate.decision === 'ask' || gate.decision === 'defer',
  );
  if (postBlocked) {
    return {
      code: 'GATE_BLOCKED',
      message: `Gate ${postBlocked.gate_id} blocked the run`,
      details: {
        phase: 'gate',
        gate_phase: 'post_council',
        gate_results: input.postCouncilGateResults,
      },
    };
  }
  if (!input.hasSelectedArtifact) {
    return {
      code: 'ARTIFACT_NOT_SELECTED',
      message: 'No artifact was selected',
      details: { phase: 'artifact_selection' },
    };
  }
  const materializationDetails = {
    phase: 'materialization',
    status: input.materializationResult.status,
    worktree_path: input.materializationResult.worktree_path,
    files_written: input.materializationResult.files_written,
    changed_files: input.materializationResult.changed_files,
    failures: input.materializationResult.failures,
  };
  if (input.materializationResult.status === 'failed') {
    return {
      code: 'MATERIALIZATION_FAILED',
      message: 'Worktree materialization failed',
      details: materializationDetails,
    };
  }
  if (input.materializationResult.status === 'partial') {
    return {
      code: 'MATERIALIZATION_PARTIAL',
      message: 'Worktree materialization completed partially',
      details: materializationDetails,
    };
  }
  if (input.materializationResult.files_written.length === 0) {
    return {
      code: 'MATERIALIZATION_FAILED',
      message: 'Worktree materialization wrote no files',
      details: materializationDetails,
    };
  }
  return undefined;
}
