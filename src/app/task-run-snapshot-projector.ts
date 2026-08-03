import { SCHEMA_VERSION } from '../core';
import type {
  PersistedCoordinationEvent,
  PersistedRunState,
  PersistedTaskAggregate,
  TaskResumeCursor,
} from '../persistence';
import { runSnapshotSchema, type RunSnapshot } from '../protocol/run-snapshot';
import { projectRunEventSource } from '../protocol/run-event';
import type { RunOutcome } from '../coordinator/run-outcome';
import { buildRunOutputPaths } from '../coordinator/run-result';

export function projectPersistedRunSnapshot(
  aggregate: PersistedTaskAggregate,
  runId: string,
  runsRoot = '.newide/runs',
): RunSnapshot {
  const run = aggregate.runs.find((candidate) => candidate.run_id === runId);
  if (!run) throw new Error(`Run ${runId} does not belong to Task ${aggregate.task.task_id}`);
  const events = aggregate.events.filter((event) => event.run_id === runId);
  const timeline = events.map((event) => ({
    event_id: event.event_id,
    sequence: event.sequence,
    run_id: runId,
    task_id: aggregate.task.task_id,
    type: event.event_type,
    source: projectRunEventSource(event.event_type),
    created_at: event.created_at,
    payload: { ...event.payload },
    schema_version: event.schema_version,
  }));
  const delivered = lastEvent(events, 'artifact.delivered');
  const completion = lastEvent(events, 'completion.evaluated');
  const agent = lastEvent(events, 'agent.execution_completed');
  const market = lastEvent(events, 'market.selected');
  const projectedMarket = market ? marketProjection(market) : undefined;
  const council = lastEvent(events, 'council.completed');
  const quality = asRunOutcome(completion?.payload.outcome);
  const deliveredFiles = asRecords(delivered?.payload.files);
  const filesWritten = deliveredFiles.flatMap((file) =>
    typeof file.file_path === 'string' ? [file.file_path] : [],
  );
  const changedFiles = deliveredFiles.flatMap((file) =>
    typeof file.relative_path === 'string' ? [file.relative_path] : [],
  );
  const deliveredArtifactRefs = deliveredFiles.flatMap((file) =>
    typeof file.artifact_ref === 'string' ? [file.artifact_ref] : [],
  );
  const councilArtifactRefs = stringArray(council?.payload.selected_artifact_refs);
  const agentArtifactRefs = stringArray(agent?.payload.artifact_refs);
  const artifactRefs = unique(
    deliveredArtifactRefs.length > 0
      ? deliveredArtifactRefs
      : councilArtifactRefs.length > 0
        ? councilArtifactRefs
        : agentArtifactRefs,
  );
  const status = runStatus(run);
  const stage = currentStage(aggregate.runtime_state.resume_cursor, run.status);
  const activeNodeCode = nodeCode(aggregate.runtime_state.resume_cursor, run.status);
  const response = stringValue(agent?.payload.response) ?? '';
  const sessionId = run.session_id ?? stringValue(agent?.payload.session_id);
  const worktreePath =
    stringValue(completion?.payload.worktree_path) ??
    stringValue(delivered?.payload.workspace_path);
  const outputPaths = buildRunOutputPaths(runId, runsRoot);
  const { run_dir: _runDir, ...standardLinks } = outputPaths;
  const links = compactRecord({
    ...standardLinks,
    changeset_manifest_ref:
      stringValue(completion?.payload.changeset_manifest_ref) ??
      stringValue(delivered?.payload.changeset_manifest_ref),
    changeset_manifest_id:
      stringValue(completion?.payload.changeset_manifest_id) ??
      stringValue(delivered?.payload.manifest_id),
    delivery_receipt_path: stringValue(delivered?.payload.delivery_receipt_path),
  });

  return runSnapshotSchema.parse({
    contract_version: 'frontend-workflow.v0.1',
    schema_version: SCHEMA_VERSION,
    run_id: run.run_id,
    task_id: run.task_id,
    mode: run.mode,
    status,
    ...(quality ? { quality } : {}),
    current: {
      stage,
      active_node_code: activeNodeCode,
      task_status: aggregate.task.status,
    },
    task: {
      task_id: aggregate.task.task_id,
      status: aggregate.task.status,
      spec: aggregate.task.spec,
      completion_criteria: [...aggregate.task.completion_criteria],
      risk_level: aggregate.task.risk_level,
      affected_paths: [...aggregate.task.affected_paths],
      ...(aggregate.task.role_id ? { role_id: aggregate.task.role_id } : {}),
      ...(aggregate.task.budget ? { budget: { ...aggregate.task.budget } } : {}),
      created_at: aggregate.task.created_at,
      updated_at: aggregate.task.updated_at,
      schema_version: aggregate.task.schema_version,
    },
    run: {
      run_id: run.run_id,
      task_id: run.task_id,
      status: run.status,
      mode: run.mode,
      ...(sessionId ? { session_id: sessionId } : {}),
      event_ids: events.map((event) => event.event_id),
      ...(run.started_at ? { started_at: run.started_at } : {}),
      ...(run.completed_at ? { completed_at: run.completed_at } : {}),
    },
    flow: {
      active_node_code: activeNodeCode,
      node_statuses: stageNodeStatuses(events),
    },
    delivery_report: {
      ...(worktreePath ? { worktree_path: worktreePath } : {}),
      files_written: filesWritten,
      changed_files: changedFiles,
      artifacts_materialized: deliveredFiles.length,
      ...(status === 'completed'
        ? {
            outcome: filesWritten.length > 0 ? 'completed_files' : 'completed_response',
          }
        : { outcome: 'failed' }),
      response,
      ...(sessionId ? { session_id: sessionId } : {}),
      tool_events: [],
      ...(quality ? { quality } : {}),
    },
    links,
    timeline,
    agent_runs: events
      .filter((event) => event.event_type.startsWith('agent.'))
      .map(eventRecord),
    artifacts: artifactRefs.map((artifactRef) => ({ artifact_id: artifactRef })),
    gates: events
      .filter((event) => event.event_type === 'gate.result')
      .map(eventRecord),
    ...(projectedMarket ? { market: projectedMarket } : {}),
    ...(run.mode === 'council'
      ? { council: councilProjection(council, status) }
      : {}),
    errors: run.error ? [{ ...run.error }] : [],
    ...(status !== 'running'
      ? {
          final_output: {
            status,
            artifact_refs: artifactRefs,
            files_written: filesWritten,
            changed_files: changedFiles,
            ...(status === 'completed'
              ? {
                  outcome:
                    filesWritten.length > 0 ? 'completed_files' : 'completed_response',
                }
              : { outcome: 'failed' }),
            response,
            ...(sessionId ? { session_id: sessionId } : {}),
            tool_events: [],
            ...(quality ? { quality } : {}),
          },
        }
      : {}),
  });
}

function runStatus(
  run: PersistedRunState,
): 'running' | 'completed' | 'failed' | 'cancelled' {
  if (run.status === 'created' || run.status === 'running') return 'running';
  if (run.status === 'interrupted') return 'failed';
  return run.status;
}

function currentStage(
  cursor: TaskResumeCursor,
  status: PersistedRunState['status'],
): 'executing' | 'council' | 'delivery' | 'intervention' {
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') {
    return 'intervention';
  }
  if (cursor === 'council') return 'council';
  if (cursor === 'gate' || cursor === 'deliver' || cursor === 'done') return 'delivery';
  if (cursor === 'mailbox_wait') return 'intervention';
  return 'executing';
}

function nodeCode(cursor: TaskResumeCursor, status: PersistedRunState['status']): string {
  if (status !== 'created' && status !== 'running') return 'N18';
  switch (cursor) {
    case 'select_agent':
      return 'N3';
    case 'execute_agent':
      return 'N8';
    case 'council':
      return 'N14';
    case 'gate':
      return 'N13';
    case 'deliver':
    case 'done':
      return 'N18';
    case 'mailbox_wait':
      return 'N16';
  }
}

function stageNodeStatuses(events: readonly PersistedCoordinationEvent[]) {
  const completed = new Set(
    events
      .filter((event) => event.event_type === 'handler.completed')
      .flatMap((event) => {
        const cursor = stringValue(event.payload.cursor);
        return cursor ? [cursor] : [];
      }),
  );
  const cursorByCode: Readonly<Record<string, string>> = {
    N3: 'select_agent',
    N8: 'execute_agent',
    N13: 'gate',
    N14: 'council',
    N18: 'deliver',
  };
  return Array.from({ length: 19 }, (_, index) => {
    const code = `N${String(index)}`;
    const cursor = cursorByCode[code];
    return {
      code,
      ...(cursor ? { cursor } : {}),
      status: cursor && completed.has(cursor) ? 'done' : 'pending',
    };
  });
}

function marketProjection(
  event: PersistedCoordinationEvent,
): RunSnapshot['market'] | undefined {
  const projected = {
    winner_agent_id: stringValue(event.payload.winner_agent_id),
    winner_bid_id: stringValue(event.payload.winner_bid_id),
    ledger_ref: stringValue(event.payload.ledger_ref),
    audit_ref: stringValue(event.payload.audit_ref),
    policy_version: stringValue(event.payload.policy_version),
    seed: stringValue(event.payload.seed),
  };
  if (Object.values(projected).some((value) => value === undefined)) return undefined;
  return projected as NonNullable<RunSnapshot['market']>;
}

function councilProjection(
  event: PersistedCoordinationEvent | undefined,
  status: 'running' | 'completed' | 'failed' | 'cancelled',
): NonNullable<RunSnapshot['council']> {
  const payload = event?.payload ?? {};
  const output = asRecord(payload.output);
  return {
    enabled: true,
    status,
    ...(stringValue(payload.decision_id) ? { decision_id: stringValue(payload.decision_id) } : {}),
    ...(stringValue(payload.verdict) ? { verdict: stringValue(payload.verdict) } : {}),
    ...(stringValue(payload.decision_mode)
      ? { decision_mode: stringValue(payload.decision_mode) }
      : {}),
    selected_artifact_refs: stringArray(payload.selected_artifact_refs),
    required_next_actions: stringArray(output?.required_next_actions),
    blocked_by: stringArray(output?.blocked_by),
    can_create_merge_authorization: output?.can_create_merge_authorization === true,
    participants: asRecords(payload.participants),
    proposals: asRecords(payload.proposals),
    reviews: asRecords(payload.reviews),
    ...(asRecord(payload.synthesis) ? { synthesis: asRecord(payload.synthesis) } : {}),
    ...(output ? { output } : {}),
    ...(asRecord(payload.result) ? { result: asRecord(payload.result) } : {}),
  };
}

function eventRecord(event: PersistedCoordinationEvent): Record<string, unknown> {
  return {
    event_id: event.event_id,
    type: event.event_type,
    created_at: event.created_at,
    ...event.payload,
  };
}

function lastEvent(
  events: readonly PersistedCoordinationEvent[],
  eventType: string,
): PersistedCoordinationEvent | undefined {
  return [...events].reverse().find((event) => event.event_type === eventType);
}

function asRunOutcome(value: unknown): RunOutcome | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !['verified', 'best_effort', 'failed', 'blocked', 'cancelled'].includes(
      String(record.status),
    ) ||
    typeof record.reason !== 'string' ||
    !Array.isArray(record.criteria) ||
    !Array.isArray(record.gate_result_refs) ||
    !Array.isArray(record.artifact_refs)
  ) {
    return undefined;
  }
  return record as unknown as RunOutcome;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const record = asRecord(entry);
        return record ? [record] : [];
      })
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === 'string' ? [entry] : []))
    : [];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function compactRecord(
  value: Record<string, string | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
