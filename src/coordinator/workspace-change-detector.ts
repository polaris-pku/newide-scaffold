import { promises as fs } from 'node:fs';
import path from 'node:path';

const IGNORED_DIRECTORIES = new Set(['.git', '.newide', 'node_modules']);

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

function toWorkspaceRelativePath(workspacePath: string, absolutePath: string): string {
  return path.relative(workspacePath, absolutePath).split(path.sep).join('/');
}
