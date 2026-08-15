import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type ArtifactRef,
  type Checkpoint,
  type Event,
  type MergeAuthorization,
  type RoleProfileRef,
  type TaskCreateRequest,
} from '../core';
import { MockCouncil, type CouncilDecision, type EvidencePack, type Proposal } from '../council';
import { MockDriver, type DriverRunResult } from '../driver';
import { HookEngine, type HookResult } from '../hook';
import { DecisionAggregator, type GateRequest, type GateResult } from '../gate';
import { MockMemoryProvider, type ContextPack } from '../memory';
import { RuntimeOrchestrator, type RuntimeOrchestratorConfig } from './orchestrator';
import type { TelemetrySink } from '../telemetry/telemetry-sink';
import type { TraceSink } from '../trace';

export interface TimelineItem {
  name: string;
  id: string;
}

export interface BasicFlowResult {
  timeline: TimelineItem[];
  context_pack: ContextPack;
  driver_result: DriverRunResult;
  hook_result: HookResult;
  gate_requests: GateRequest[];
  gate_results: GateResult[];
  council_decision: CouncilDecision;
  merge_authorization: MergeAuthorization;
  checkpoint: Checkpoint;
  events: Event[];
  artifacts: ArtifactRef[];
}

export interface BasicFlowOptions {
  telemetry?: TelemetrySink;
  trace?: TraceSink;
}

export async function runBasicFlow(options?: BasicFlowOptions): Promise<BasicFlowResult> {
  const orchestratorConfig: RuntimeOrchestratorConfig = {
    ...(options?.telemetry ? { telemetry: options.telemetry } : {}),
    ...(options?.trace ? { trace: options.trace } : {}),
  };
  const orchestrator = new RuntimeOrchestrator(
    Object.keys(orchestratorConfig).length > 0 ? orchestratorConfig : undefined,
  );
  const timeline: TimelineItem[] = [];

  const taskRequest: TaskCreateRequest = {
    spec: 'Run the v0 mock A/B/C/D flow.',
    role_id: 'role_ts_engineer',
    risk_level: 'low',
    affected_paths: ['src/**'],
    completion_criteria: ['basic flow emits all required v0 events'],
  };
  const task = orchestrator.createTask(taskRequest);
  timeline.push({ name: 'TaskCreated', id: task.task_id });

  const run = orchestrator.createRun(task.task_id);
  timeline.push({ name: 'RunCreated', id: run.run_id });
  orchestrator.updateRunStatus(run.run_id, 'running');
  orchestrator.updateTaskStatus(task.task_id, 'claimed');
  orchestrator.updateTaskStatus(task.task_id, 'running');

  const roleProfileRef: RoleProfileRef = {
    role_id: 'role_ts_engineer',
    persona_ref: 'persona://role_ts_engineer/current',
    skill_refs: ['skill://typescript-contracts'],
    capability_tags: ['typescript', 'architecture', 'mock-runtime'],
    memory_policy: {
      allow_in_driver_context: true,
      allow_in_council_proposer: true,
      allow_in_council_judge: true,
      max_memory_items: 5,
    },
    schema_version: SCHEMA_VERSION,
  };

  const driver = new MockDriver();
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

  const memory = new MockMemoryProvider();
  const contextPack = await memory.buildContextPack({
    task_id: task.task_id,
    role_profile_ref: roleProfileRef,
    memory_refs: [
      {
        memory_id: 'memory_mock_contract',
        kind: 'experience',
        uri: 'memory://mock/contract-boundaries',
        summary: 'Keep v0 contracts stable while mocks stay simple.',
        schema_version: SCHEMA_VERSION,
      },
    ],
    artifact_refs: [],
  });
  const contextEvent = orchestrator.appendEvent({
    event_type: 'memory.context_pack_built',
    subject_id: contextPack.context_pack_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      role_id: contextPack.role_profile_ref.role_id,
      memory_refs: contextPack.memory_refs.map((memoryRef) => memoryRef.memory_id),
    },
  });
  timeline.push({ name: 'ContextPackBuilt', id: contextEvent.event_id });

  const driverResult = await driver.sendPrompt({
    task_id: task.task_id,
    run_id: run.run_id,
    prompt: 'Produce the deterministic v0 mock patch artifact.',
    context_pack_ref: {
      context_pack_id: contextPack.context_pack_id,
      task_id: contextPack.task_id,
      uri: `artifact://context/${task.task_id}/${contextPack.context_pack_id}`,
      schema_version: SCHEMA_VERSION,
    },
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
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

  const registeredArtifact = orchestrator.registerArtifact(driverResult.artifacts[0]!);
  orchestrator.registerArtifact(driverResult.transcript_ref);
  timeline.push({ name: 'ArtifactRegistered', id: registeredArtifact.artifact_id });

  const taskCompletedEvent = orchestrator.appendEvent({
    event_type: 'task.completed',
    subject_id: task.task_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      summary: 'Mock driver completed the task.',
      artifact_refs: [registeredArtifact.artifact_id],
    },
  });
  timeline.push({ name: 'TaskCompletedEvent', id: taskCompletedEvent.event_id });
  orchestrator.updateTaskStatus(task.task_id, 'reviewing');

  const hookEngine = new HookEngine({
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
          command: 'node -e "process.exit(0)"',
          retry_threshold: 1,
        },
      },
      hooks: {
        'task.completed': [{ gate: 'allow-gate', priority: 100, timeout: 30 }],
      },
    },
    aggregator: new DecisionAggregator(),
  });
  const hookResult = await hookEngine.handleEvent({
    ...taskCompletedEvent,
    event_type: 'task.completed',
  });
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

  const firstGateRequest = hookResult.gate_requests[0]!;
  const gateRequestEvent = orchestrator.appendEvent({
    event_type: 'gate.requested',
    subject_id: firstGateRequest.gate_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      gate_point: firstGateRequest.gate_point,
      subject_id: firstGateRequest.subject_id,
    },
  });
  timeline.push({ name: 'GateRequest', id: gateRequestEvent.event_id });

  const firstGateResult = hookResult.gate_results[0]!;
  const gateResultEvent = orchestrator.appendEvent({
    event_type: 'gate.result',
    subject_id: firstGateResult.gate_result_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      decision: firstGateResult.decision,
      reason: firstGateResult.reason,
      target_state: firstGateResult.target_state,
    },
  });
  timeline.push({ name: 'GateResult', id: gateResultEvent.event_id });

  const proposal: Proposal = {
    proposal_id: createId('proposal'),
    run_id: run.run_id,
    task_id: task.task_id,
    agent_id: driver.driver_id,
    artifact_refs: [registeredArtifact.artifact_id],
    summary: 'Use the deterministic mock patch artifact.',
    claims: [],
    affected_paths: [],
    assumptions: [],
    known_risks: [],
    completion_evidence: [firstGateResult.gate_result_id],
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
  const evidencePack: EvidencePack = {
    evidence_pack_id: createId('evidence_pack'),
    task_id: task.task_id,
    context_pack_ref: contextPack.context_pack_id,
    artifact_refs: [registeredArtifact.artifact_id],
    gate_result_refs: [firstGateResult.gate_result_id],
    summary: 'Mock patch artifact and deterministic gate result for v0 council decision.',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
  const council = new MockCouncil();
  const councilRunResult = await council.runCouncilRound({
    run_id: run.run_id,
    task_id: task.task_id,
    trigger: 'manual',
    decision_mode: 'advisory',
    question: 'Select the v0 mock patch artifact.',
    proposals: [proposal],
    evidence_pack: evidencePack,
    schema_version: SCHEMA_VERSION,
  });
  const councilDecision = councilRunResult.decision;
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
    },
  });
  timeline.push({ name: 'CouncilDecision', id: councilEvent.event_id });

  const mergeAuthorization: MergeAuthorization = {
    merge_authorization_id: createId('merge_authorization'),
    run_id: run.run_id,
    task_id: task.task_id,
    selected_artifact_refs: [registeredArtifact.artifact_id],
    gate_result_refs: [firstGateResult.gate_result_id],
    council_decision_ref: councilDecision.decision_id,
    status: firstGateResult.decision === 'allow' ? 'authorized' : 'blocked',
    reason: 'v0 mock merge authorization from gate result and council decision.',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
  const mergeEvent = orchestrator.appendEvent({
    event_type: 'merge.authorization',
    subject_id: mergeAuthorization.merge_authorization_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      status: mergeAuthorization.status,
      selected_artifact_refs: mergeAuthorization.selected_artifact_refs,
      gate_result_refs: mergeAuthorization.gate_result_refs,
      council_decision_ref: mergeAuthorization.council_decision_ref,
    },
  });
  timeline.push({ name: 'MergeAuthorization', id: mergeEvent.event_id });
  orchestrator.updateTaskStatus(task.task_id, 'merging');

  const checkpoint: Checkpoint = {
    checkpoint_id: createId('checkpoint'),
    checkpoint_type: 'full',
    task_id: task.task_id,
    agent_id: 'agent_mock_driver',
    trigger: 'manual',
    mechanical_snapshot: {
      base_commit: 'mock-base-commit',
      snapshot_commit: 'mock-snapshot-commit',
      worktree_path: '.',
      branch: 'main',
      modified_files: ['src/examples/basic-flow.ts'],
      diff_artifact_id: registeredArtifact.artifact_id,
    },
    semantic_handoff: {
      done: ['task created', 'context pack built', 'driver result registered', 'gate allowed'],
      in_progress: [],
      blocked_on: [],
      assumptions: ['Mock flow uses deterministic local providers.'],
      next_steps: ['Replace mocks with real adapters behind the same contracts.'],
      known_risks: ['v0 does not persist to SQLite yet.'],
    },
    runtime_state: {
      scheduler_policy: 'single_driver_mock',
      current_turn: 1,
      next_agent_ref: 'merger',
      resume_cursor: 'run.completed',
    },
    artifact_refs: [registeredArtifact.artifact_id, driverResult.transcript_ref.artifact_id],
    validity_status: 'valid',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
  const savedCheckpoint = orchestrator.saveCheckpoint(checkpoint);
  timeline.push({ name: 'CheckpointSaved', id: savedCheckpoint.checkpoint_id });

  orchestrator.updateTaskStatus(task.task_id, 'completed');
  const completedRun = orchestrator.updateRunStatus(run.run_id, 'completed');
  const runCompletedEvent = orchestrator.appendEvent({
    event_type: 'run.completed',
    subject_id: completedRun.run_id,
    run_id: completedRun.run_id,
    task_id: completedRun.task_id,
    payload: {
      checkpoint_id: savedCheckpoint.checkpoint_id,
      merge_authorization_id: mergeAuthorization.merge_authorization_id,
    },
  });
  timeline.push({ name: 'RunCompleted', id: runCompletedEvent.event_id });

  return {
    timeline,
    context_pack: contextPack,
    driver_result: driverResult,
    hook_result: hookResult,
    gate_requests: hookResult.gate_requests,
    gate_results: hookResult.gate_results,
    council_decision: councilDecision,
    merge_authorization: mergeAuthorization,
    checkpoint: savedCheckpoint,
    events: orchestrator.stores.events.list(),
    artifacts: orchestrator.stores.artifacts.list(),
  };
}
