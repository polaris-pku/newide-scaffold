/**
 * Coordinator 运行输出模块。
 *
 * 这个文件负责 `.newide/runs/<run_id>/` 下的输出路径和结果文件写入：
 * result.json、summary.json、timeline.json、checkpoint.json、message-thread.json、
 * event-log.json、frontend-snapshot.json。
 * 它不生成 checkpoint 语义，不生成 timeline 事件，不修改 task/run 状态，
 * 也不调用 driver、gate、council 或 mailbox。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SchemaVersion, TaskId, RunId, Timestamp } from '../core';
import type { SelectionMode } from './artifact-finalizer';
import type { ArtifactOutput } from './artifact-output';
import type { CouncilDecision } from '../council';
import type { MaterializationFailure, MaterializationResult } from './worktree-materializer';

export type RunResultStatus = 'completed' | 'failed';

export interface IntegrationRunOutputPaths {
  run_dir: string;
  result_path: string;
  summary_path: string;
  timeline_path: string;
  checkpoint_path: string;
  message_thread_path: string;
  event_log_path: string;
  audit_path: string;
  frontend_snapshot_path: string;
}

export interface IntegrationRunResultManifest {
  run_id: RunId;
  task_id: TaskId;
  status: RunResultStatus;
  mode: SelectionMode;
  driver_id: string;
  artifact_outputs: ArtifactOutput[];
  changed_files: string[];
  materialization_status: MaterializationResult['status'];
  materialization_failures: MaterializationFailure[];
  result_path: string;
  summary_path: string;
  timeline_path: string;
  checkpoint_path: string;
  message_thread_path: string;
  event_log_path: string;
  audit_path: string;
  frontend_snapshot_path: string;
  council_decision_path?: string;
  council_proposals_path?: string;
  council_reviews_path?: string;
  council_synthesis_path?: string;
  council_output_path?: string;
  council_result_path?: string;
  council_verdict?: CouncilDecision['verdict'];
  council_decision_mode?: CouncilDecision['decision_mode'];
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface WriteIntegrationRunOutputsInput {
  paths: IntegrationRunOutputPaths;
  summary: unknown;
  timeline: unknown;
  checkpoint: unknown;
  message_thread: unknown;
  event_log: unknown;
  frontend_snapshot: unknown;
  result_manifest: IntegrationRunResultManifest;
}

export function buildRunOutputPaths(
  runId: RunId,
  runsRoot = '.newide/runs',
): IntegrationRunOutputPaths {
  const runDir = path.join(runsRoot, runId);
  return {
    run_dir: runDir,
    result_path: path.join(runDir, 'result.json'),
    summary_path: path.join(runDir, 'summary.json'),
    timeline_path: path.join(runDir, 'timeline.json'),
    checkpoint_path: path.join(runDir, 'checkpoint.json'),
    message_thread_path: path.join(runDir, 'message-thread.json'),
    event_log_path: path.join(runDir, 'event-log.json'),
    audit_path: path.join(runDir, 'audit.jsonl'),
    frontend_snapshot_path: path.join(runDir, 'frontend-snapshot.json'),
  };
}

export interface BuildRunResultManifestInput {
  run_id: RunId;
  task_id: TaskId;
  status: RunResultStatus;
  mode: SelectionMode;
  driver_id: string;
  artifact_outputs: readonly ArtifactOutput[];
  changed_files: readonly string[];
  materialization_status: MaterializationResult['status'];
  materialization_failures: readonly MaterializationFailure[];
  result_path: string;
  summary_path: string;
  timeline_path: string;
  checkpoint_path: string;
  message_thread_path: string;
  event_log_path: string;
  audit_path: string;
  frontend_snapshot_path: string;
  council_decision_path?: string;
  council_proposals_path?: string;
  council_reviews_path?: string;
  council_synthesis_path?: string;
  council_output_path?: string;
  council_result_path?: string;
  council_verdict?: CouncilDecision['verdict'];
  council_decision_mode?: CouncilDecision['decision_mode'];
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export function buildRunResultManifest(
  input: BuildRunResultManifestInput,
): IntegrationRunResultManifest {
  return {
    run_id: input.run_id,
    task_id: input.task_id,
    status: input.status,
    mode: input.mode,
    driver_id: input.driver_id,
    artifact_outputs: [...input.artifact_outputs],
    changed_files: [...input.changed_files],
    materialization_status: input.materialization_status,
    materialization_failures: [...input.materialization_failures],
    result_path: input.result_path,
    summary_path: input.summary_path,
    timeline_path: input.timeline_path,
    checkpoint_path: input.checkpoint_path,
    message_thread_path: input.message_thread_path,
    event_log_path: input.event_log_path,
    audit_path: input.audit_path,
    frontend_snapshot_path: input.frontend_snapshot_path,
    ...(input.council_decision_path ? { council_decision_path: input.council_decision_path } : {}),
    ...(input.council_proposals_path
      ? { council_proposals_path: input.council_proposals_path }
      : {}),
    ...(input.council_reviews_path ? { council_reviews_path: input.council_reviews_path } : {}),
    ...(input.council_synthesis_path
      ? { council_synthesis_path: input.council_synthesis_path }
      : {}),
    ...(input.council_output_path ? { council_output_path: input.council_output_path } : {}),
    ...(input.council_result_path ? { council_result_path: input.council_result_path } : {}),
    ...(input.council_verdict ? { council_verdict: input.council_verdict } : {}),
    ...(input.council_decision_mode ? { council_decision_mode: input.council_decision_mode } : {}),
    created_at: input.created_at,
    schema_version: input.schema_version,
  };
}

export async function writeRunResultManifest(
  filePath: string,
  manifest: IntegrationRunResultManifest,
): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
}

export async function writeIntegrationRunOutputs(
  input: WriteIntegrationRunOutputsInput,
): Promise<void> {
  await fs.mkdir(input.paths.run_dir, { recursive: true });
  await fs.writeFile(input.paths.summary_path, JSON.stringify(input.summary, null, 2), 'utf-8');
  await fs.writeFile(input.paths.timeline_path, JSON.stringify(input.timeline, null, 2), 'utf-8');
  await fs.writeFile(
    input.paths.checkpoint_path,
    JSON.stringify(input.checkpoint, null, 2),
    'utf-8',
  );
  await fs.writeFile(
    input.paths.message_thread_path,
    JSON.stringify(input.message_thread, null, 2),
    'utf-8',
  );
  await fs.writeFile(input.paths.event_log_path, JSON.stringify(input.event_log, null, 2), 'utf-8');
  await fs.writeFile(
    input.paths.frontend_snapshot_path,
    JSON.stringify(input.frontend_snapshot, null, 2),
    'utf-8',
  );
  await writeRunResultManifest(input.paths.result_path, input.result_manifest);
}
