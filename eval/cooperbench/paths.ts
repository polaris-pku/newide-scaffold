import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getScaffoldRoot, resolveRunDir } from '../paths';
import type { CooperBenchDatasetSubset, CooperBenchManifest } from './types';

const COOPERBENCH_EVAL_ROOT = dirname(fileURLToPath(import.meta.url));

export function getCooperBenchEvalRoot(): string {
  return COOPERBENCH_EVAL_ROOT;
}

export function loadCooperBenchManifest(manifestPath?: string): CooperBenchManifest {
  const path = manifestPath ?? join(getCooperBenchEvalRoot(), 'manifest.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as CooperBenchManifest;
}

function resolveMaybeRelative(candidate: string): string {
  if (candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) {
    return candidate;
  }
  return resolve(getScaffoldRoot(), candidate);
}

export function resolveCooperBenchRoot(manifest?: CooperBenchManifest): string {
  const fromEnv = process.env.NEWIDE_COOPERBENCH_ROOT?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const m = manifest ?? loadCooperBenchManifest();
  return resolveMaybeRelative(m.cooperbench_root);
}

export function resolveCooperBenchDatasetDir(manifest?: CooperBenchManifest): string {
  const fromEnv = process.env.NEWIDE_COOPERBENCH_DATASET_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const m = manifest ?? loadCooperBenchManifest();
  return resolveMaybeRelative(m.dataset_dir);
}

export function resolveCooperBenchSubsetPath(
  manifest: CooperBenchManifest,
  subsetId: string,
): string {
  const relativePath = manifest.subsets[subsetId];
  if (!relativePath) {
    const available = Object.keys(manifest.subsets);
    throw new Error(
      `Unknown CooperBench subset "${subsetId}". Available: ${available.join(', ') || 'none'}`,
    );
  }
  return resolve(getScaffoldRoot(), relativePath);
}

export function loadCooperBenchSubset(
  manifest: CooperBenchManifest,
  subsetId: string,
): CooperBenchDatasetSubset {
  const path = resolveCooperBenchSubsetPath(manifest, subsetId);
  const subset = JSON.parse(readFileSync(path, 'utf-8')) as CooperBenchDatasetSubset;
  if (subset.subset_id !== subsetId) {
    throw new Error(
      `CooperBench subset id mismatch: expected "${subsetId}", got "${subset.subset_id}"`,
    );
  }
  return subset;
}

export function resolveCooperBenchRunDir(runId: string, outRoot?: string): string {
  return resolveRunDir(runId, outRoot);
}

export { resolveRunDir };
