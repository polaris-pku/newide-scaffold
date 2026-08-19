/** Writes fallback terminal artifacts when the integration flow cannot finalize itself. */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppRunSnapshot } from './run-registry';
import { projectRunSnapshot } from './run-snapshot-projector';
import {
  isDriverStreamUsage,
  preferDriverUsage,
  projectTaskDriverUsage,
  type TaskDriverUsage,
} from './driver-usage-projector';

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
    await mergeDriverUsageIntoSummary(summaryPath, tokenUsage);
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
  const memoryAblation = resolveMemoryAblation(projected.timeline);
  const proxyTokenUsage = resolveTokenUsageFromTimeline(projected.timeline);
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
    ...(proxyTokenUsage ? { token_usage: proxyTokenUsage } : {}),
    ...(tokenUsage.available ? { driver_usage: tokenUsage } : {}),
    ...(memoryAblation ? { memory_ablation: memoryAblation } : {}),
    result_path: paths.result_path,
    summary_path: paths.summary_path,
    timeline_path: paths.timeline_path,
    audit_path: paths.audit_path,
    frontend_snapshot_path: paths.frontend_snapshot_path,
  };
}

/**
 * Prefer context_pack_built, but fall back to earlier ablation-tagged events.
 * Council rescue paths may skip context_pack_built when primary status !== completed.
 */
function resolveMemoryAblation(
  timeline: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
): string | undefined {
  const preferredTypes = [
    'memory.context_pack_built',
    'agent.execution_requested',
    'agent.execution_completed',
  ];
  for (const type of preferredTypes) {
    const value = timeline
      .filter((event) => event.type === type)
      .map((event) => event.payload.ablation ?? event.payload.memory_ablation)
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
    if (value) return value;
  }
  return timeline
    .map((event) => event.payload.ablation ?? event.payload.memory_ablation)
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
}

function resolveTokenUsageFromTimeline(
  timeline: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
):
  | {
      schema_version: 'newide.token_usage.v1';
      source: 'proxy';
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      total_input_tokens: number;
      total_tokens: number;
      call_count: number;
      sources: ['proxy'];
      by_source: {
        proxy: {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          total_input_tokens: number;
          total_tokens: number;
          call_count: number;
        };
      };
    }
  | undefined {
  const usageEvents = timeline.filter((event) => event.type === 'proxy.llm_usage_recorded');
  if (usageEvents.length === 0) return undefined;
  let input = 0;
  let output = 0;
  for (const event of usageEvents) {
    const nextInput = Number(event.payload.input_tokens ?? 0);
    const nextOutput = Number(event.payload.output_tokens ?? 0);
    if (!Number.isFinite(nextInput) || !Number.isFinite(nextOutput)) continue;
    input += nextInput;
    output += nextOutput;
  }
  const proxy = {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: input,
    total_tokens: input + output,
    call_count: usageEvents.length,
  };
  return {
    schema_version: 'newide.token_usage.v1',
    source: 'proxy',
    ...proxy,
    sources: ['proxy'],
    by_source: { proxy },
  };
}

async function mergeDriverUsageIntoSummary(
  summaryPath: string,
  driverUsage: TaskDriverUsage,
): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(summaryPath, 'utf8')) as Record<string, unknown>;
    const preferred = preferDriverUsage(
      isDriverStreamUsage(raw.driver_usage) ? raw.driver_usage : raw.token_usage,
      driverUsage,
    );
    let changed = false;
    if (preferred && raw.driver_usage !== preferred) {
      raw.driver_usage = preferred;
      changed = true;
    }
    if (isDriverStreamUsage(raw.token_usage)) {
      delete raw.token_usage;
      changed = true;
    }
    if (!changed) return;
    await fs.writeFile(summaryPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
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
