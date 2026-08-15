/** Writes fallback terminal artifacts when the integration flow cannot finalize itself. */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppRunSnapshot } from './run-registry';
import { projectRunSnapshot } from './run-snapshot-projector';
import { projectTaskDriverUsage, type TaskDriverUsage } from './driver-usage-projector';

export interface RunTerminalOutputWriter {
  finalize(snapshot: AppRunSnapshot): Promise<RunTerminalOutputEvidence | void>;
}

export interface RunTerminalOutputEvidence {
  artifact_ref: string;
  sha256: string;
}

export class FileRunTerminalOutputWriter implements RunTerminalOutputWriter {
  constructor(private readonly runsRoot = '.newide/runs') {}

  async finalize(snapshot: AppRunSnapshot): Promise<RunTerminalOutputEvidence | undefined> {
    if (snapshot.status === 'running') return;
    const runDir = path.join(this.runsRoot, snapshot.run_id);
    await fs.mkdir(runDir, { recursive: true });
    const resultPath = path.join(runDir, 'result.json');
    const summaryPath = path.join(runDir, 'summary.json');
    const timelinePath = path.join(runDir, 'timeline.json');
    const frontendSnapshotPath = path.join(runDir, 'frontend-snapshot.json');

    const projected = projectRunSnapshot(snapshot);
    const tokenUsage = await projectTaskDriverUsage(this.runsRoot, snapshot.task_id);
    const fallbackWrites = [
      writeJsonIfMissing(resultPath, {
        ...projected,
        result_path: resultPath,
        summary_path: summaryPath,
        timeline_path: timelinePath,
        audit_path: path.join(runDir, 'audit.jsonl'),
        frontend_snapshot_path: frontendSnapshotPath,
      }),
      writeJsonIfMissing(
        summaryPath,
        buildBackendSummary(
          projected,
          {
            result_path: resultPath,
            summary_path: summaryPath,
            timeline_path: timelinePath,
            audit_path: path.join(runDir, 'audit.jsonl'),
            frontend_snapshot_path: frontendSnapshotPath,
          },
          tokenUsage,
        ),
      ),
      writeJsonIfMissing(timelinePath, snapshot.events),
    ];
    const serializedSnapshot = JSON.stringify(projected, null, 2);
    await Promise.all([
      ...fallbackWrites,
      fs.writeFile(frontendSnapshotPath, serializedSnapshot, 'utf-8'),
    ]);
    return {
      artifact_ref: pathToFileURL(path.resolve(frontendSnapshotPath)).href,
      sha256: createHash('sha256').update(serializedSnapshot).digest('hex'),
    };
  }
}

function buildBackendSummary(
  projected: ReturnType<typeof projectRunSnapshot>,
  paths: {
    result_path: string;
    summary_path: string;
    timeline_path: string;
    audit_path: string;
    frontend_snapshot_path: string;
  },
  tokenUsage: TaskDriverUsage,
): Record<string, unknown> {
  const delivery = projected.delivery_report;
  const finalOutput = projected.final_output;
  const worktreePath = delivery?.worktree_path;
  const filesWritten = finalOutput?.files_written ?? delivery?.files_written ?? [];
  const changedFiles = finalOutput?.changed_files ?? delivery?.changed_files ?? [];
  const artifactRefs = finalOutput?.artifact_refs ?? [];
  const memoryAblation = projected.timeline
    .map((event) => event.payload.memory_ablation ?? event.payload.ablation)
    .find((value): value is string => typeof value === 'string');
  const outcome =
    finalOutput?.outcome ??
    delivery?.outcome ??
    (projected.status === 'completed' ? 'completed_response' : 'failed');

  return {
    run_id: projected.run_id,
    task_id: projected.task_id,
    mode: projected.mode,
    status: projected.status,
    outcome,
    ...(projected.quality ? { run_outcome: projected.quality } : {}),
    ...(delivery?.session_id ? { session_id: delivery.session_id } : {}),
    ...(delivery?.response ? { response: delivery.response } : {}),
    ...(worktreePath ? { worktree_path: worktreePath } : {}),
    files_written: [...filesWritten],
    changed_files: [...changedFiles],
    artifact_refs: [...artifactRefs],
    artifacts_materialized: projected.artifacts.length,
    token_usage: tokenUsage,
    ...(memoryAblation ? { memory_ablation: memoryAblation } : {}),
    result_path: paths.result_path,
    summary_path: paths.summary_path,
    timeline_path: paths.timeline_path,
    audit_path: paths.audit_path,
    frontend_snapshot_path: paths.frontend_snapshot_path,
  };
}

async function writeJsonIfMissing(filePath: string, value: unknown): Promise<void> {
  try {
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    if (isAlreadyExistsError(error)) return;
    throw error;
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
