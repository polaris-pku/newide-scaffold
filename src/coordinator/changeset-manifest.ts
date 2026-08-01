import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, nowTimestamp, type ArtifactRef, type RunId, type TaskId } from '../core';
import type { GateResult } from '../gate';
import type { SelectionMode } from './artifact-finalizer';
import { readArtifactContentBytes, sha256 } from './artifact-content';

export type ChangesetDeliveryStrategy =
  | 'already_in_workspace'
  | 'copy_file'
  | 'apply_patch'
  | 'metadata_only';

export interface ChangesetManifestEntry {
  entry_id: string;
  artifact_id: string;
  artifact_ref?: ArtifactRef;
  source_path?: string;
  relative_paths: string[];
  sha256: string;
  producer_agent_id: string;
  gate_result_refs: string[];
  delivery_strategy: ChangesetDeliveryStrategy;
}

export interface ChangesetManifest {
  manifest_id: string;
  run_id: RunId;
  task_id: TaskId;
  mode: SelectionMode;
  base: {
    kind: 'workspace_snapshot';
    ref: string;
  };
  paths: {
    task_worktree_path: string;
    manifest_path: string;
    delivery_receipt_path: string;
    user_workspace_path?: string;
    council_workspace_path?: string;
  };
  entries: ChangesetManifestEntry[];
  gate_result_refs: string[];
  created_at: string;
  schema_version: string;
}

export interface BuildChangesetManifestInput {
  run_id: RunId;
  task_id: TaskId;
  mode: SelectionMode;
  base_ref: string;
  selected_artifacts: readonly ArtifactRef[];
  gate_results: readonly GateResult[];
  producer_agent_id: string;
  task_worktree_path: string;
  manifest_path: string;
  delivery_receipt_path: string;
  user_workspace_path?: string;
  council_workspace_path?: string;
  observed_changed_files?: readonly string[];
  expected_artifact_hashes?: Readonly<Record<string, string>>;
}

export async function buildChangesetManifest(
  input: BuildChangesetManifestInput,
): Promise<ChangesetManifest> {
  const gateResultRefs = input.gate_results.map((result) => result.gate_result_id);
  const observedEntries = await buildObservedWorkspaceEntries(input, gateResultRefs);
  const artifactEntries = dedupeArtifactEntriesByPath(
    await Promise.all(
      input.selected_artifacts.map((artifact) =>
        buildArtifactEntry(input, artifact, gateResultRefs),
      ),
    ),
  );
  const selectedPaths = new Set(
    artifactEntries.flatMap((entry) =>
      entry.relative_paths.map((relativePath) => normalizePathKey(relativePath)),
    ),
  );
  const entries = [
    ...artifactEntries,
    ...observedEntries.filter(
      (entry) =>
        !entry.relative_paths.some((relativePath) =>
          selectedPaths.has(normalizePathKey(relativePath)),
        ),
    ),
  ];
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        run_id: input.run_id,
        task_id: input.task_id,
        mode: input.mode,
        base_ref: input.base_ref,
        gate_result_refs: gateResultRefs,
        entries: entries.map((entry) => ({
          artifact_id: entry.artifact_id,
          relative_paths: entry.relative_paths,
          sha256: entry.sha256,
          producer_agent_id: entry.producer_agent_id,
          delivery_strategy: entry.delivery_strategy,
        })),
      }),
    )
    .digest('hex')
    .slice(0, 24);
  return {
    manifest_id: `changeset_${digest}`,
    run_id: input.run_id,
    task_id: input.task_id,
    mode: input.mode,
    base: { kind: 'workspace_snapshot', ref: input.base_ref },
    paths: {
      task_worktree_path: input.task_worktree_path,
      manifest_path: input.manifest_path,
      delivery_receipt_path: input.delivery_receipt_path,
      ...(input.user_workspace_path
        ? { user_workspace_path: path.resolve(input.user_workspace_path) }
        : {}),
      ...(input.council_workspace_path
        ? { council_workspace_path: path.resolve(input.council_workspace_path) }
        : {}),
    },
    entries,
    gate_result_refs: gateResultRefs,
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

export async function writeChangesetManifest(manifest: ChangesetManifest): Promise<void> {
  await fs.mkdir(path.dirname(manifest.paths.manifest_path), { recursive: true });
  await fs.writeFile(
    manifest.paths.manifest_path,
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );
}

async function buildObservedWorkspaceEntries(
  input: BuildChangesetManifestInput,
  gateResultRefs: string[],
): Promise<ChangesetManifestEntry[]> {
  if (!input.user_workspace_path) return [];
  const entries: ChangesetManifestEntry[] = [];
  for (const changedFile of input.observed_changed_files ?? []) {
    const relativePath = safeRelativePath(changedFile);
    const sourcePath = safeWorkspacePath(input.user_workspace_path, relativePath);
    const bytes = await fs.readFile(sourcePath).catch(() => undefined);
    if (!bytes) continue;
    const hash = sha256(bytes);
    entries.push({
      entry_id: changesetEntryId(`workspace:${relativePath}:${hash}`),
      artifact_id: `workspace_change_${hash.slice(0, 24)}`,
      source_path: sourcePath,
      relative_paths: [relativePath],
      sha256: hash,
      producer_agent_id: input.producer_agent_id,
      gate_result_refs: [...gateResultRefs],
      delivery_strategy: 'already_in_workspace',
    });
  }
  return entries;
}

async function buildArtifactEntry(
  input: BuildChangesetManifestInput,
  artifact: ArtifactRef,
  gateResultRefs: string[],
): Promise<ChangesetManifestEntry> {
  const content = artifact.content;
  const relativePaths = content?.target_path ? [safeRelativePath(content.target_path)] : [];
  const bytes =
    content && content.kind !== 'metadata'
      ? await readArtifactContentBytes(artifact)
      : Buffer.from(JSON.stringify(artifact), 'utf-8');
  const hash = sha256(bytes);
  const expectedHash = input.expected_artifact_hashes?.[artifact.artifact_id];
  if (expectedHash && expectedHash !== hash) {
    throw new Error(
      `Artifact ${artifact.artifact_id} SHA256 mismatch: expected ${expectedHash}, got ${hash}`,
    );
  }
  return {
    entry_id: changesetEntryId(`artifact:${artifact.artifact_id}:${hash}`),
    artifact_id: artifact.artifact_id,
    artifact_ref: artifact,
    relative_paths: relativePaths,
    sha256: hash,
    producer_agent_id: artifact.producer_id || input.producer_agent_id,
    gate_result_refs: [...gateResultRefs],
    delivery_strategy:
      content?.kind === 'text' || content?.kind === 'file'
        ? 'copy_file'
        : content?.kind === 'patch'
          ? 'apply_patch'
          : 'metadata_only',
  };
}

function changesetEntryId(value: string): string {
  return `changeset_entry_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function normalizePathKey(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Selected artifacts can include both a full workspace file and an Edit-tool
 * text snippet for the same path (e.g. `requests/utils.py` vs `requests\\utils.py`).
 * Keep one entry per path, preferring complete file content over snippets.
 */
function dedupeArtifactEntriesByPath(
  entries: readonly ChangesetManifestEntry[],
): ChangesetManifestEntry[] {
  const byPath = new Map<string, ChangesetManifestEntry>();
  for (const entry of entries) {
    const key = entry.relative_paths.map((relativePath) => normalizePathKey(relativePath)).join('|');
    if (!key) {
      // Keep pathless metadata entries as-is (append after path-keyed ones).
      continue;
    }
    const existing = byPath.get(key);
    if (!existing || preferArtifactEntry(entry, existing) === entry) {
      byPath.set(key, entry);
    }
  }
  const pathless = entries.filter((entry) => entry.relative_paths.length === 0);
  return [...byPath.values(), ...pathless];
}

function preferArtifactEntry(
  candidate: ChangesetManifestEntry,
  incumbent: ChangesetManifestEntry,
): ChangesetManifestEntry {
  const candidateKind = candidate.artifact_ref?.content?.kind;
  const incumbentKind = incumbent.artifact_ref?.content?.kind;
  if (candidateKind === 'file' && incumbentKind !== 'file') return candidate;
  if (incumbentKind === 'file' && candidateKind !== 'file') return incumbent;

  const candidateSource = candidate.artifact_ref?.metadata?.source;
  const incumbentSource = incumbent.artifact_ref?.metadata?.source;
  if (candidateSource === 'workspace-change' && incumbentSource !== 'workspace-change') {
    return candidate;
  }
  if (incumbentSource === 'workspace-change' && candidateSource !== 'workspace-change') {
    return incumbent;
  }

  // Prefer larger payloads when both are text/snippets (full file vs edit fragment).
  const candidateBytes = estimateEntryBytes(candidate);
  const incumbentBytes = estimateEntryBytes(incumbent);
  if (candidateBytes > incumbentBytes) return candidate;
  return incumbent;
}

function estimateEntryBytes(entry: ChangesetManifestEntry): number {
  const contentRef = entry.artifact_ref?.content?.content_ref;
  if (typeof contentRef === 'string' && contentRef.startsWith('data:')) {
    const comma = contentRef.indexOf(',');
    if (comma >= 0) {
      try {
        return decodeURIComponent(contentRef.slice(comma + 1)).length;
      } catch {
        return contentRef.length;
      }
    }
  }
  // File artifacts are typically much larger than edit snippets; use a high
  // sentinel when content is a file URL so they win over data: snippets.
  if (typeof contentRef === 'string' && contentRef.startsWith('file:')) {
    return Number.MAX_SAFE_INTEGER;
  }
  return 0;
}

function safeRelativePath(value: string): string {
  if (!value || path.isAbsolute(value)) {
    throw new Error(`Changeset path must be a non-empty relative path: ${value}`);
  }
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Changeset path escapes workspace: ${value}`);
  }
  return normalized;
}

function safeWorkspacePath(workspacePath: string, relativePath: string): string {
  const root = path.resolve(workspacePath);
  const target = path.resolve(root, relativePath);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Changeset path escapes workspace: ${relativePath}`);
  }
  return target;
}
