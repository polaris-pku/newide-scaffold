import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from '../core';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.newide',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);

export type WorkspaceFileSnapshot = ReadonlyMap<string, string>;

export async function snapshotWorkspaceFiles(
  workspacePath: string,
): Promise<WorkspaceFileSnapshot> {
  const files = new Map<string, string>();

  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(absolutePath, { bigint: true }).catch(() => undefined);
      if (!stat) continue;
      files.set(
        toWorkspaceRelativePath(workspacePath, absolutePath),
        `${stat.size}:${stat.mtimeNs}`,
      );
    }
  }

  await walk(workspacePath);
  return files;
}

export function diffWorkspaceFiles(
  before: WorkspaceFileSnapshot,
  after: WorkspaceFileSnapshot,
): string[] {
  const candidates = new Set([...before.keys(), ...after.keys()]);
  return [...candidates]
    .filter((file) => before.get(file) !== after.get(file))
    .sort((left, right) => left.localeCompare(right));
}

/** Capture complete files against the start of a logical execution, including its retries. */
export async function collectWorkspaceArtifacts(
  input: { task_id: string; workspace_path?: string },
  before: WorkspaceFileSnapshot | undefined,
  producerId = 'agent-execution-facade',
): Promise<ArtifactRef[]> {
  if (!input.workspace_path || !before) return [];
  const after = await snapshotWorkspaceFiles(input.workspace_path);
  const changedFiles = diffWorkspaceFiles(before, after).filter(isDeliverableWorkspacePath);
  const artifacts: ArtifactRef[] = [];
  for (const relativePath of changedFiles) {
    const absolutePath = path.resolve(input.workspace_path, relativePath);
    const stat = await fs.stat(absolutePath).catch(() => undefined);
    if (!stat?.isFile() || stat.size > 5 * 1024 * 1024) continue;
    const bytes = await fs.readFile(absolutePath).catch(() => undefined);
    if (!bytes) continue;
    artifacts.push({
      artifact_id: createId('artifact'),
      type: 'patch',
      uri: `artifact://workspace-file/${encodeURIComponent(input.task_id)}/${encodeURIComponent(relativePath)}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      producer_id: producerId,
      task_id: input.task_id,
      metadata: {
        source: 'workspace-change',
        workspace_path: input.workspace_path,
        target_path: relativePath,
      },
      content: {
        kind: 'file',
        content_ref: pathToFileURL(absolutePath).href,
        target_path: relativePath,
        media_type: mediaTypeFor(relativePath),
      },
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    });
  }
  return artifacts;
}

export function normalizeArtifactTargetPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Prefer complete current workspace files over Driver edit snippets. */
export function mergeArtifacts(
  driverArtifacts: readonly ArtifactRef[],
  workspaceArtifacts: readonly ArtifactRef[],
): ArtifactRef[] {
  const result: ArtifactRef[] = [];
  const seenTargets = new Set<string>();
  for (const artifact of [...workspaceArtifacts, ...driverArtifacts]) {
    const target = artifact.content?.target_path;
    const key = target ? normalizeArtifactTargetPath(target) : undefined;
    if (key && seenTargets.has(key)) continue;
    if (key) seenTargets.add(key);
    result.push(artifact);
  }
  return result;
}

function mediaTypeFor(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === '.ts') return 'text/typescript';
  if (extension === '.tsx') return 'text/tsx';
  if (extension === '.js' || extension === '.jsx') return 'text/javascript';
  if (extension === '.json') return 'application/json';
  if (extension === '.css') return 'text/css';
  if (extension === '.html') return 'text/html';
  return 'text/plain';
}

/** Files that can represent intentional source changes and may become delivery artifacts. */
export function isDeliverableWorkspacePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return (
    parts.every(
      (part) =>
        part !== '.claude' &&
        part !== '.newide' &&
        part !== '__pycache__' &&
        part !== '.pytest_cache' &&
        part !== '.mypy_cache' &&
        part !== '.ruff_cache',
    ) &&
    !parts.some((part) => part.startsWith('.')) &&
    !/\.py[co]$/i.test(normalized) &&
    !normalized.endsWith('_report.txt') &&
    path.basename(normalized) !== '.DS_Store'
  );
}

function toWorkspaceRelativePath(workspacePath: string, absolutePath: string): string {
  return path.relative(workspacePath, absolutePath).split(path.sep).join('/');
}
