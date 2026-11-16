/** Shared workspace snapshots: project content excludes the Driver's local permission state. */
import { promises as fs, readdirSync, readFileSync } from 'node:fs';
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

/** Only the root Claude Code permission state; hooks, settings.json and nested files still count. */
function isDriverRuntimeState(workspacePath: string, absolutePath: string): boolean {
  const relative = toWorkspaceRelativePath(workspacePath, absolutePath);
  return (
    (process.platform === 'win32' ? relative.toLowerCase() : relative) ===
    '.claude/settings.local.json'
  );
}

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
      if (isDriverRuntimeState(workspacePath, absolutePath)) continue;
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

/**
 * 工作区**内容**快照：相对路径 → 文件字节 sha256。
 *
 * 与 {@link snapshotWorkspaceFiles} 的 size:mtime 元数据快照不同，内容快照能证明「同一份
 * 交付内容」：检查证据与最终交付对象用同一口径比较，不会因为 mtime 精度/相同大小而失真。
 * 忽略目录与元数据快照一致；读取失败的文件不进入快照（调用方据此判定覆盖不完整）。
 */
export type WorkspaceContentSnapshot = ReadonlyMap<string, string>;

export async function snapshotWorkspaceContent(
  workspacePath: string,
): Promise<WorkspaceContentSnapshot> {
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
      if (isDriverRuntimeState(workspacePath, absolutePath)) continue;
      const bytes = await fs.readFile(absolutePath).catch(() => undefined);
      if (bytes === undefined) continue;
      files.set(
        toWorkspaceRelativePath(workspacePath, absolutePath),
        createHash('sha256').update(bytes).digest('hex'),
      );
    }
  }

  await walk(workspacePath);
  return files;
}

/**
 * 同步内容快照：只用于 **driver 事件回调内** 的检查证据绑定。
 *
 * 事件回调与外部进程的文件修改之间没有原子性，异步快照会把「事件之后的修改」读进来，
 * 让旧检查冒充最终版本通过。这里在回调返回前同步完成读取，至少保证宿主观察到的事件
 * 顺序与快照顺序一致；做不到可靠绑定时，调用方降级为无指纹证据（finish 会拒绝）。
 */
export function snapshotWorkspaceContentSync(workspacePath: string): WorkspaceContentSnapshot {
  const files = new Map<string, string>();
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isDriverRuntimeState(workspacePath, absolutePath)) continue;
      try {
        const bytes = readFileSync(absolutePath);
        files.set(
          toWorkspaceRelativePath(workspacePath, absolutePath),
          createHash('sha256').update(bytes).digest('hex'),
        );
      } catch {
        // 读取失败的文件不进入快照：指纹因此不完整，finish 不会把它当成可信适用证据。
      }
    }
  };
  walk(workspacePath);
  return files;
}

/** 内容快照的 canonical 指纹（路径排序后哈希）；同一份内容恒得同一 hash。 */
export function hashWorkspaceContent(snapshot: WorkspaceContentSnapshot): string {
  const entries = [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
}

/** 内容差异：值（sha256）不同或文件新增/消失都算变化，按路径排序。 */
export function diffWorkspaceContent(
  before: WorkspaceContentSnapshot,
  after: WorkspaceContentSnapshot,
): string[] {
  const candidates = new Set([...before.keys(), ...after.keys()]);
  return [...candidates]
    .filter((file) => before.get(file) !== after.get(file))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * 以**内容快照**为基线收集交付产物：同一文件多次修改只交付最终内容；
 * 仅纳入可交付路径，避免把恢复前已有的无关文件算成本任务产物。
 */
export async function collectWorkspaceArtifactsFromContent(
  input: { task_id: string; workspace_path?: string },
  before: WorkspaceContentSnapshot | undefined,
  producerId = 'agent-execution-facade',
): Promise<ArtifactRef[]> {
  if (!input.workspace_path || !before) return [];
  const after = await snapshotWorkspaceContent(input.workspace_path);
  const changedFiles = diffWorkspaceContent(before, after).filter(isDeliverableWorkspacePath);
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
