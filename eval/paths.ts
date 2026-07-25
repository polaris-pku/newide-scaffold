import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalDatasetSubset, EvalManifest } from './types';

const EVAL_ROOT = dirname(fileURLToPath(import.meta.url));
const SCAFFOLD_ROOT = resolve(EVAL_ROOT, '..');

export function getScaffoldRoot(): string {
  return process.env.NEWIDE_SCAFFOLD_ROOT?.trim() || SCAFFOLD_ROOT;
}

export function getEvalRoot(): string {
  return join(getScaffoldRoot(), 'eval');
}

export function loadManifest(manifestPath?: string): EvalManifest {
  const path = manifestPath ?? join(getEvalRoot(), 'manifest.json');
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as EvalManifest;
}

export function resolveFromScaffold(relativePath: string): string {
  return resolve(getScaffoldRoot(), relativePath);
}

export function resolveDatasetJsonl(manifest: EvalManifest, override?: string): string {
  const candidate = override?.trim() || manifest.dataset_jsonl;
  if (candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) {
    return candidate;
  }
  return resolveFromScaffold(candidate);
}

export function resolveDatasetSubsetPath(manifest: EvalManifest, subsetId: string): string {
  const relativePath = manifest.subsets?.[subsetId];
  if (!relativePath) {
    const available = Object.keys(manifest.subsets ?? {});
    throw new Error(
      `Unknown dataset subset "${subsetId}". Available subsets: ${available.join(', ') || 'none'}`,
    );
  }
  return resolveFromScaffold(relativePath);
}

export function loadDatasetSubset(manifest: EvalManifest, subsetId: string): EvalDatasetSubset {
  const path = resolveDatasetSubsetPath(manifest, subsetId);
  const raw = readFileSync(path, 'utf-8');
  const subset = JSON.parse(raw) as EvalDatasetSubset;
  if (subset.subset_id !== subsetId) {
    throw new Error(
      `Dataset subset id mismatch: expected "${subsetId}", got "${subset.subset_id}"`,
    );
  }
  return subset;
}

export function resolveRunDir(runId: string, outRoot?: string): string {
  const base = outRoot?.trim() || join(getScaffoldRoot(), '.newide', 'eval');
  return join(base, runId);
}

export function resolveSweEvoRoot(): string | undefined {
  const fromEnv = process.env.NEWIDE_SWE_EVO_ROOT?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const sibling = resolve(getScaffoldRoot(), '..', 'SWE-EVO');
  return sibling;
}
