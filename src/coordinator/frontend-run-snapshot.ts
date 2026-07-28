/**
 * Coordinator 前端运行快照模块。
 *
 * 这个文件只负责把 integration-v0 已有输出整理成前端可读 view model。
 * 它不读取/写入文件，不调用 driver、gate、council 或 mailbox，也不修改 task/run 状态。
 */
import type { Checkpoint, Message, MessageId, SchemaVersion, Task, Timestamp } from '../core';
import type { ArtifactOutput } from './artifact-output';
import type { RunResultStatus, IntegrationRunOutputPaths } from './run-result';
import type { SelectionMode } from './artifact-finalizer';
import type { CouncilDecision, CouncilResult, CouncilRunResult } from '../council';
import type { DriverToolEvent } from '../driver/contract';

export type FrontendStage = 'executing' | 'council' | 'delivery';
export type FrontendTimelineLevel = 'info' | 'success' | 'warning' | 'council';

export interface FrontendMarketSelection {
  winner_agent_id: string;
  winner_bid_id: string;
  ledger_ref: string;
  audit_ref: string;
  policy_version: string;
  seed: string;
}

export interface FrontendRunSnapshotSummary {
  run_id: string;
  task_id: string;
  mode: SelectionMode;
  status: RunResultStatus;
  outcome: 'completed_files' | 'completed_response' | 'failed';
  session_id: string;
  response: string;
  tool_events: DriverToolEvent[];
  worktree_path: string;
  artifacts_materialized: number;
  files_written: string[];
  changed_files: string[];
  artifact_outputs: ArtifactOutput[];
  driver_diagnostics: {
    driver_id: string;
    duration_ms: number;
  };
  checkpoint_id: string;
  checkpoint_path: string;
  mailbox_message_refs: MessageId[];
  mailbox_thread_id: string;
  market?: FrontendMarketSelection;
  council_decision_path?: string;
  council_proposals_path?: string;
  council_reviews_path?: string;
  council_synthesis_path?: string;
  council_output_path?: string;
  council_result_path?: string;
  council_result?: CouncilResult;
  council_decision_id?: string;
  council_decision_mode?: CouncilDecision['decision_mode'];
  council_verdict?: CouncilDecision['verdict'];
  council_selected_artifact_refs?: string[];
  council_can_create_merge_authorization?: boolean;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface FrontendRunSnapshotTimelineItem {
  id: string;
  name: string;
}

export interface FrontendRunNodeStatus {
  code: string;
  status: 'pending' | 'active' | 'done' | 'blocked' | 'updated';
  event_type?: string;
  event_id?: string;
}

export interface BuildFrontendRunSnapshotInput {
  task: Task;
  summary: FrontendRunSnapshotSummary;
  timeline: readonly FrontendRunSnapshotTimelineItem[];
  checkpoint: Checkpoint;
  message_thread: readonly Message[];
  council_run_result?: CouncilRunResult;
  links: Omit<IntegrationRunOutputPaths, 'run_dir'>;
}

export interface FrontendRunSnapshot {
  snapshot_type: 'coordinator.frontend_run_snapshot.v0';
  schema_version: SchemaVersion;
  generated_at: Timestamp;
  run_id: string;
  task_id: string;
  task: Task;
  current: {
    stage: FrontendStage;
    task_status: RunResultStatus;
    active_node_code: string;
  };
  run: {
    run_id: string;
    task_id: string;
    status: RunResultStatus;
    mode: SelectionMode;
    driver_id: string;
    session_id: string;
    created_at: Timestamp;
  };
  flow: {
    active_node_code: string;
    node_statuses: FrontendRunNodeStatus[];
  };
  timeline: Array<{
    id: string;
    name: string;
    level: FrontendTimelineLevel;
    source: string;
    text: string;
  }>;
  delivery_report: {
    worktree_path: string;
    files_written: string[];
    changed_files: string[];
    artifacts_materialized: number;
    outcome: FrontendRunSnapshotSummary['outcome'];
    response: string;
    session_id: string;
    tool_events: DriverToolEvent[];
    driver_diagnostics: FrontendRunSnapshotSummary['driver_diagnostics'];
  };
  artifacts: ArtifactOutput[];
  checkpoint: {
    checkpoint_id: string;
    trigger: Checkpoint['trigger'];
    validity_status: Checkpoint['validity_status'];
    semantic_handoff: Checkpoint['semantic_handoff'];
    mechanical_snapshot: Checkpoint['mechanical_snapshot'];
  };
  mailbox: {
    thread_id: string;
    message_refs: MessageId[];
    messages: Message[];
  };
  market?: FrontendMarketSelection;
  council?: {
    decision_path: string;
    proposals_path?: string;
    reviews_path?: string;
    synthesis_path?: string;
    output_path?: string;
    result_path?: string;
    decision_id: string;
    decision_mode: CouncilDecision['decision_mode'];
    verdict: CouncilDecision['verdict'];
    reason: string;
    evidence_refs: string[];
    risk_signals: string[];
    selected_artifact_refs: string[];
    can_create_merge_authorization: boolean;
    proposals: CouncilRunResult['proposals'];
    reviews: CouncilRunResult['reviews'];
    synthesis?: CouncilRunResult['synthesis'];
    output?: CouncilRunResult['output'];
    result?: CouncilResult;
  };
  links: Omit<IntegrationRunOutputPaths, 'run_dir'>;
}

export function buildFrontendRunSnapshot(
  input: BuildFrontendRunSnapshotInput,
): FrontendRunSnapshot {
  const activeNodeCode = input.summary.status === 'completed' ? 'N18' : 'N8';
  return {
    snapshot_type: 'coordinator.frontend_run_snapshot.v0',
    schema_version: input.summary.schema_version,
    generated_at: input.summary.created_at,
    run_id: input.summary.run_id,
    task_id: input.summary.task_id,
    task: { ...input.task },
    current: {
      stage: getFrontendStage(input.summary),
      task_status: input.summary.status,
      active_node_code: activeNodeCode,
    },
    run: {
      run_id: input.summary.run_id,
      task_id: input.summary.task_id,
      status: input.summary.status,
      mode: input.summary.mode,
      driver_id: input.summary.driver_diagnostics.driver_id,
      session_id: input.summary.session_id,
      created_at: input.summary.created_at,
    },
    flow: {
      active_node_code: activeNodeCode,
      node_statuses: buildNodeStatuses(input.timeline),
    },
    timeline: input.timeline.map((item) => ({
      id: item.id,
      name: item.name,
      level: getTimelineLevel(item.name),
      source: getTimelineSource(item.name),
      text: item.name,
    })),
    delivery_report: {
      worktree_path: input.summary.worktree_path,
      files_written: [...input.summary.files_written],
      changed_files: [...input.summary.changed_files],
      artifacts_materialized: input.summary.artifacts_materialized,
      outcome: input.summary.outcome,
      response: input.summary.response,
      session_id: input.summary.session_id,
      tool_events: input.summary.tool_events.map((event) => ({ ...event })),
      driver_diagnostics: input.summary.driver_diagnostics,
    },
    artifacts: [...input.summary.artifact_outputs],
    checkpoint: {
      checkpoint_id: input.checkpoint.checkpoint_id,
      trigger: input.checkpoint.trigger,
      validity_status: input.checkpoint.validity_status,
      semantic_handoff: input.checkpoint.semantic_handoff,
      mechanical_snapshot: input.checkpoint.mechanical_snapshot,
    },
    mailbox: {
      thread_id: input.summary.mailbox_thread_id,
      message_refs: [...input.summary.mailbox_message_refs],
      messages: [...input.message_thread],
    },
    ...(input.summary.market ? { market: { ...input.summary.market } } : {}),
    ...(input.summary.council_decision_path &&
    input.summary.council_decision_id &&
    input.summary.council_decision_mode &&
    input.summary.council_verdict
      ? {
          council: {
            decision_path: input.summary.council_decision_path,
            ...(input.summary.council_proposals_path
              ? { proposals_path: input.summary.council_proposals_path }
              : {}),
            ...(input.summary.council_reviews_path
              ? { reviews_path: input.summary.council_reviews_path }
              : {}),
            ...(input.summary.council_synthesis_path
              ? { synthesis_path: input.summary.council_synthesis_path }
              : {}),
            ...(input.summary.council_output_path
              ? { output_path: input.summary.council_output_path }
              : {}),
            ...(input.summary.council_result_path
              ? { result_path: input.summary.council_result_path }
              : {}),
            decision_id: input.summary.council_decision_id,
            decision_mode: input.summary.council_decision_mode,
            verdict: input.summary.council_verdict,
            reason: input.council_run_result?.decision.reason ?? '',
            evidence_refs: [...(input.council_run_result?.decision.evidence_refs ?? [])],
            risk_signals: [
              ...new Set(
                input.council_run_result?.proposals.flatMap((proposal) => proposal.known_risks) ??
                  [],
              ),
            ],
            selected_artifact_refs: [...(input.summary.council_selected_artifact_refs ?? [])],
            can_create_merge_authorization:
              input.summary.council_can_create_merge_authorization ?? false,
            proposals: [...(input.council_run_result?.proposals ?? [])],
            reviews: [...(input.council_run_result?.reviews ?? [])],
            ...(input.council_run_result?.synthesis
              ? { synthesis: input.council_run_result.synthesis }
              : {}),
            ...(input.council_run_result?.output
              ? { output: input.council_run_result.output }
              : {}),
            ...(input.summary.council_result ? { result: input.summary.council_result } : {}),
          },
        }
      : {}),
    links: input.links,
  };
}

const TIMELINE_NODE_CODES: Readonly<Record<string, string>> = {
  TaskCreated: 'N2',
  RunCreated: 'N3',
  ContextPackBuilt: 'N5',
  DriverSessionStarted: 'N6',
  DriverRunResult: 'N8',
  ArtifactRegistered: 'N9',
  TaskCompleted: 'N10',
  HookMatched: 'N11',
  GateResult: 'N13',
  CouncilStarted: 'N14',
  CouncilDecision: 'N14',
  CouncilCompleted: 'N14',
  CheckpointSaved: 'N16',
  RunCompleted: 'N18',
  RunFailed: 'N18',
};

function buildNodeStatuses(
  timeline: readonly FrontendRunSnapshotTimelineItem[],
): FrontendRunNodeStatus[] {
  const observed = new Map<string, FrontendRunSnapshotTimelineItem>();
  for (const item of timeline) {
    const code = TIMELINE_NODE_CODES[item.name];
    if (code) observed.set(code, item);
  }

  return Array.from({ length: 19 }, (_, index) => {
    const code = `N${index}`;
    const item = observed.get(code);
    return item
      ? {
          code,
          status: item.name === 'RunFailed' ? 'blocked' : 'done',
          event_type: item.name,
          event_id: item.id,
        }
      : { code, status: 'pending' };
  });
}

function getFrontendStage(summary: FrontendRunSnapshotSummary): FrontendStage {
  if (summary.mode === 'council') {
    return 'council';
  }
  return summary.status === 'completed' || summary.status === 'failed' ? 'delivery' : 'executing';
}

function getTimelineLevel(name: string): FrontendTimelineLevel {
  if (name.includes('Failed')) return 'warning';
  if (name.includes('Council')) return 'council';
  if (name.includes('Completed')) return 'success';
  return 'info';
}

function getTimelineSource(name: string): string {
  if (name.includes('Driver')) return 'Driver';
  if (name.includes('Gate') || name.includes('Hook')) return 'Gate';
  if (name.includes('Council')) return 'Council';
  return 'Coordinator';
}
