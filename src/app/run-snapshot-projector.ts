import type { FrontendRunSnapshot } from '../coordinator/frontend-run-snapshot';
import type { RunSnapshot } from '../protocol/run-snapshot';
import type { AppRunSnapshot } from './run-registry';

export function projectRunSnapshot(input: AppRunSnapshot): RunSnapshot {
  const rich = input.snapshot;
  const task = rich?.task;
  const artifacts = asRecords(rich?.artifacts ?? []);
  const finalStatus = terminalStatus(input.status);
  const runStarted = input.events.find((event) => event.type === 'run.started');
  const terminalEvent = [...input.events]
    .reverse()
    .find((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type));

  return {
    ...(task ? { contract_version: 'frontend-workflow.v0.1' as const } : {}),
    schema_version: input.schema_version,
    run_id: input.run_id,
    task_id: input.task_id,
    mode: input.mode,
    status: input.status,
    current: { ...input.current, ...(task ? { task_status: task.status } : {}) },
    ...(task
      ? {
          task: {
            task_id: task.task_id,
            status: task.status,
            spec: task.spec,
            completion_criteria: [...task.completion_criteria],
            risk_level: task.risk_level,
            affected_paths: [...(task.affected_paths ?? [])],
            ...(task.role_id ? { role_id: task.role_id } : {}),
            ...(task.budget ? { budget: { ...task.budget } } : {}),
            created_at: task.created_at,
            updated_at: task.updated_at,
            schema_version: task.schema_version,
          },
          run: {
            run_id: input.run_id,
            task_id: input.task_id,
            status: input.status,
            mode: input.mode,
            session_id: rich.run.session_id,
            event_ids: input.events.map((event) => event.event_id),
            ...(runStarted ? { started_at: runStarted.created_at } : {}),
            ...(terminalEvent ? { completed_at: terminalEvent.created_at } : {}),
            checkpoint_id: rich.checkpoint.checkpoint_id,
          },
          flow: {
            active_node_code: rich.flow.active_node_code,
            node_statuses: asRecords(rich.flow.node_statuses),
          },
          delivery_report: {
            worktree_path: rich.delivery_report.worktree_path,
            files_written: [...rich.delivery_report.files_written],
            changed_files: [...rich.delivery_report.changed_files],
            artifacts_materialized: rich.delivery_report.artifacts_materialized,
            outcome: rich.delivery_report.outcome,
            response: rich.delivery_report.response,
            session_id: rich.delivery_report.session_id,
            tool_events: asRecords(rich.delivery_report.tool_events),
          },
          links: asRecord(rich.links),
        }
      : {}),
    timeline: [...input.events],
    agent_runs: input.events
      .filter((event) => event.source === 'agent')
      .map((event) => ({
        event_id: event.event_id,
        type: event.type,
        created_at: event.created_at,
        ...event.payload,
      })),
    artifacts,
    gates: input.events
      .filter((event) => event.source === 'gate')
      .map((event) => ({
        event_id: event.event_id,
        type: event.type,
        created_at: event.created_at,
        ...event.payload,
      })),
    ...(rich?.market ? { market: { ...rich.market } } : {}),
    ...(input.mode === 'council' ? { council: projectCouncil(input, rich) } : {}),
    ...(rich?.checkpoint ? { checkpoint: asRecord(rich.checkpoint) } : {}),
    errors: input.error ? [{ ...input.error }] : [],
    ...(finalStatus
      ? {
          final_output: {
            status: finalStatus,
            artifact_refs: artifactIds(artifacts),
            files_written: [...(rich?.delivery_report.files_written ?? [])],
            ...(rich?.delivery_report
              ? {
                  changed_files: [...rich.delivery_report.changed_files],
                  outcome: rich.delivery_report.outcome,
                  response: rich.delivery_report.response,
                  session_id: rich.delivery_report.session_id,
                  tool_events: asRecords(rich.delivery_report.tool_events),
                }
              : {}),
          },
        }
      : {}),
  };
}

function projectCouncil(
  input: AppRunSnapshot,
  rich: FrontendRunSnapshot | undefined,
): NonNullable<RunSnapshot['council']> {
  const council = rich?.council;
  return {
    enabled: true,
    status: input.status,
    ...(council?.decision_id ? { decision_id: council.decision_id } : {}),
    ...(council?.verdict ? { verdict: council.verdict } : {}),
    ...(council?.decision_mode ? { decision_mode: council.decision_mode } : {}),
    selected_artifact_refs: [...(council?.selected_artifact_refs ?? [])],
    required_next_actions: [...(council?.output?.required_next_actions ?? [])],
    blocked_by: [...(council?.output?.blocked_by ?? [])],
    can_create_merge_authorization: council?.can_create_merge_authorization ?? false,
    ...(council?.proposals ? { proposals: asRecords(council.proposals) } : {}),
    ...(council?.reviews ? { reviews: asRecords(council.reviews) } : {}),
    ...(council?.synthesis ? { synthesis: asRecord(council.synthesis) } : {}),
    ...(council?.output ? { output: asRecord(council.output) } : {}),
    ...(council?.result ? { result: asRecord(council.result) } : {}),
  };
}

function terminalStatus(
  status: AppRunSnapshot['status'],
): 'completed' | 'failed' | 'cancelled' | undefined {
  return status === 'running' ? undefined : status;
}

function artifactIds(artifacts: Record<string, unknown>[]): string[] {
  return artifacts.flatMap((artifact) =>
    typeof artifact.artifact_id === 'string' ? [artifact.artifact_id] : [],
  );
}

function asRecords(values: readonly unknown[]): Record<string, unknown>[] {
  return values.map(asRecord);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? { ...value } : { value };
}
