import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CooperBenchCaseIdParts, CooperBenchCaseRef, CooperBenchSetting } from './types';

const CASE_ID_RE = /^(.+?)__(\d+)__f(\d+)_f(\d+)$/;

export function formatCooperBenchCaseId(ref: CooperBenchCaseRef): string {
  const [f1, f2] = ref.features;
  return `${ref.repo}__${ref.task_id}__f${f1}_f${f2}`;
}

export function parseCooperBenchCaseId(caseId: string): CooperBenchCaseIdParts {
  const match = CASE_ID_RE.exec(caseId);
  if (!match) {
    throw new Error(
      `Invalid CooperBench case_id "${caseId}". Expected repo__taskId__fN_fM (e.g. dottxt_ai_outlines_task__1655__f1_f3).`,
    );
  }
  const repo = match[1]!;
  const taskId = Number(match[2]);
  const f1 = Number(match[3]);
  const f2 = Number(match[4]);
  return {
    case_id: caseId,
    repo,
    task_id: taskId,
    features: [f1, f2],
  };
}

export function featureDirName(features: [number, number]): string {
  return `f${features[0]}_f${features[1]}`;
}

export function resolveTaskDir(datasetDir: string, repo: string, taskId: number): string {
  return join(datasetDir, repo, `task${taskId}`);
}

export function resolveFeaturePatchPath(
  datasetDir: string,
  repo: string,
  taskId: number,
  featureId: number,
): string {
  return join(resolveTaskDir(datasetDir, repo, taskId), `feature${featureId}`, 'feature.patch');
}

export function readGoldFeaturePatch(
  datasetDir: string,
  repo: string,
  taskId: number,
  featureId: number,
): string {
  const path = resolveFeaturePatchPath(datasetDir, repo, taskId, featureId);
  if (!existsSync(path)) {
    throw new Error(`Missing gold feature.patch: ${path}`);
  }
  return readFileSync(path, 'utf-8');
}

export function assertCaseExists(datasetDir: string, parts: CooperBenchCaseIdParts): void {
  const taskDir = resolveTaskDir(datasetDir, parts.repo, parts.task_id);
  if (!existsSync(taskDir)) {
    throw new Error(`CooperBench task not found: ${taskDir}`);
  }
  for (const featureId of parts.features) {
    const patchPath = resolveFeaturePatchPath(datasetDir, parts.repo, parts.task_id, featureId);
    if (!existsSync(patchPath)) {
      throw new Error(`CooperBench feature patch not found: ${patchPath}`);
    }
  }
}

export function parseCooperBenchSetting(value: string | undefined): CooperBenchSetting {
  const setting = (value ?? 'coop').trim();
  if (setting === 'solo' || setting === 'coop') {
    return setting;
  }
  throw new Error(`Invalid --setting "${value}". Expected solo|coop.`);
}
