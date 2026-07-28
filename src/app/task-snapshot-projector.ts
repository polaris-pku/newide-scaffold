import { SCHEMA_VERSION, type TaskCreateRequest, type TaskStatus } from '../core';
import type { RunSnapshot } from '../protocol/run-snapshot';
import {
  councilResultEvidenceSchema,
  taskSnapshotSchema,
  type TaskRunSummary,
  type TaskSnapshot,
} from '../protocol/task-snapshot';

export interface TaskRunFact extends TaskRunSummary {
  revision: number;
  snapshot?: RunSnapshot;
}

export interface ProjectTaskSnapshotInput {
  task_id: string;
  task_request: TaskCreateRequest;
  created_at: string;
  runs: readonly TaskRunFact[];
}

export function projectTaskSnapshot(input: ProjectTaskSnapshotInput): TaskSnapshot {
  assertRunFacts(input.task_id, input.runs);
  const runs = [...input.runs].sort(compareNewestFirst);
  const current = runs.find((run) => run.status === 'running');
  const history = runs.filter((run) => run.status !== 'running');
  const latest = current ?? runs[0];
  const evidence = latest?.snapshot;
  const council = projectCouncil(latest, evidence);
  const councilResult = council?.result;
  const market = evidence?.market;
  const finalOutput = projectFinalOutput(evidence, councilResult);
  const error = projectError(latest, evidence);
  const status = projectTaskStatus(latest);
  const updatedAt = runTimestamp(latest) ?? input.created_at;

  return taskSnapshotSchema.parse({
    contract_version: 'task-snapshot.v0',
    schema_version: SCHEMA_VERSION,
    revision: runs.reduce((total, run) => total + run.revision + 1, 0),
    task: {
      task_id: input.task_id,
      ...(input.task_request.parent_task_id
        ? { parent_id: input.task_request.parent_task_id }
        : {}),
      status,
      ...(market?.winner_agent_id ? { owner_agent_id: market.winner_agent_id } : {}),
      ...(input.task_request.role_id ? { role_id: input.task_request.role_id } : {}),
      risk_level: input.task_request.risk_level ?? 'low',
      spec: input.task_request.spec,
      completion_criteria: [...input.task_request.completion_criteria],
      affected_paths: [...(input.task_request.affected_paths ?? [])],
      ...(input.task_request.budget ? { budget: { ...input.task_request.budget } } : {}),
      created_at: input.created_at,
      updated_at: updatedAt,
      schema_version: SCHEMA_VERSION,
    },
    ...(current ? { current_run: toRunSummary(current) } : {}),
    run_history: history.map(toRunSummary),
    ...(market ? { market: { ...market } } : {}),
    ...(council ? { council } : {}),
    ...(status === 'blocked'
      ? {
          waiting_reason: 'The previous backend process ended before a terminal result was saved.',
        }
      : {}),
    warnings: [...(councilResult?.warnings ?? [])],
    ...(error ? { error } : {}),
    ...(finalOutput ? { final_output: finalOutput } : {}),
  });
}

function assertRunFacts(taskId: string, runs: readonly TaskRunFact[]): void {
  const seen = new Set<string>();
  let running = 0;
  for (const run of runs) {
    if (run.task_id !== taskId) throw new Error(`Run ${run.run_id} belongs to another task`);
    if (seen.has(run.run_id)) throw new Error(`Duplicate run fact: ${run.run_id}`);
    seen.add(run.run_id);
    if (run.status === 'running') running += 1;
  }
  if (running > 1) throw new Error(`Task ${taskId} has multiple current runs`);
}

function projectTaskStatus(run: TaskRunFact | undefined): TaskStatus {
  if (!run) return 'created';
  if (run.status === 'interrupted') return 'blocked';
  return run.status;
}

function projectCouncil(
  latest: TaskRunFact | undefined,
  snapshot: RunSnapshot | undefined,
): TaskSnapshot['council'] {
  if (latest?.mode !== 'council' && !snapshot?.council) return undefined;
  const council = snapshot?.council;
  const parsedResult = councilResultEvidenceSchema.safeParse(council?.result);
  return {
    status: council?.status ?? projectCouncilStatus(latest?.status),
    ...(council?.decision_id ? { decision_id: council.decision_id } : {}),
    ...(isCouncilVerdict(council?.verdict) ? { verdict: council.verdict } : {}),
    ...(parsedResult.success ? { result: parsedResult.data } : {}),
  };
}

function projectCouncilStatus(
  status: TaskRunFact['status'] | undefined,
): 'running' | 'completed' | 'failed' | 'cancelled' {
  if (!status || status === 'interrupted') return 'failed';
  return status;
}

function isCouncilVerdict(
  value: string | undefined,
): value is 'select' | 'needs_human' | 'request_revision' | 'reject' {
  return (
    value === 'select' ||
    value === 'needs_human' ||
    value === 'request_revision' ||
    value === 'reject'
  );
}

function projectFinalOutput(
  snapshot: RunSnapshot | undefined,
  councilResult: NonNullable<TaskSnapshot['council']>['result'],
): TaskSnapshot['final_output'] {
  const output = snapshot?.final_output;
  if (!output) return undefined;
  const artifactRefs = [...output.artifact_refs];
  if (
    councilResult?.final_artifact_ref &&
    !artifactRefs.includes(councilResult.final_artifact_ref)
  ) {
    artifactRefs.push(councilResult.final_artifact_ref);
  }
  return {
    artifact_refs: artifactRefs,
    files_written: [...output.files_written],
    changed_files: [...(output.changed_files ?? [])],
    ...(output.response !== undefined ? { response: output.response } : {}),
    ...(councilResult?.final_artifact_sha256
      ? { sha256: councilResult.final_artifact_sha256 }
      : {}),
  };
}

function projectError(
  latest: TaskRunFact | undefined,
  snapshot: RunSnapshot | undefined,
): TaskSnapshot['error'] {
  const error = latest?.error ?? snapshot?.errors[0];
  return error
    ? { ...error, ...(error.details ? { details: { ...error.details } } : {}) }
    : undefined;
}

function toRunSummary(run: TaskRunFact): TaskRunSummary {
  const { revision: _revision, snapshot: _snapshot, ...summary } = run;
  return {
    ...summary,
    ...(summary.error
      ? {
          error: {
            ...summary.error,
            ...(summary.error.details ? { details: { ...summary.error.details } } : {}),
          },
        }
      : {}),
  };
}

function compareNewestFirst(left: TaskRunFact, right: TaskRunFact): number {
  const byTime = (runTimestamp(right) ?? '').localeCompare(runTimestamp(left) ?? '');
  return byTime || right.run_id.localeCompare(left.run_id);
}

function runTimestamp(run: TaskRunFact | undefined): string | undefined {
  return run?.completed_at ?? run?.started_at;
}
