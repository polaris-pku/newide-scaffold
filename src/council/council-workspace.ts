import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ArtifactRef } from '../core';
import {
  isMaterializableFileArtifact,
  readArtifactBytes,
} from '../coordinator/artifact-content';

const execFileAsync = promisify(execFile);

/** Shorten run_id folders under councilRoot to stay under Windows MAX_PATH. */
export function councilRunDirName(runId: string): string {
  return createHash('sha256').update(runId).digest('hex').slice(0, 12);
}

export function councilRunWorkspaceRoot(councilRoot: string, runId: string): string {
  return path.join(councilRoot, councilRunDirName(runId));
}

export async function prepareCouncilWorkspace(
  sourceWorkspace: string | undefined,
  targetWorkspace: string,
): Promise<void> {
  if (!sourceWorkspace) {
    await fs.mkdir(targetWorkspace, { recursive: true });
    return;
  }

  const source = path.resolve(sourceWorkspace);
  const target = path.resolve(targetWorkspace);
  if (source === target) return;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(target, { recursive: true, force: true });
  if (await isGitWorkspace(source)) {
    await execFileAsync(
      'git',
      [
        '-C',
        source,
        '-c',
        'core.longpaths=true',
        'worktree',
        'add',
        '--detach',
        target,
        'HEAD',
      ],
      {
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  } else {
    await fs.cp(source, target, {
      recursive: true,
      force: true,
      filter(candidate) {
        const resolved = path.resolve(candidate);
        if (resolved === target || resolved.startsWith(`${target}${path.sep}`)) return false;
        const relative = path.relative(source, resolved);
        const rootEntry = relative.split(path.sep)[0];
        return rootEntry !== '.git' && rootEntry !== '.newide';
      },
    });
  }
  // git worktree add does not copy untracked eval files such as .claude/settings.json
  // (gitignored so they never enter the scored patch). ACP still needs them in cwd.
  await copyEvalClaudeSettings(source, target);
}

async function copyEvalClaudeSettings(source: string, target: string): Promise<void> {
  const relative = path.join('.claude', 'settings.json');
  const from = path.join(source, relative);
  const to = path.join(target, relative);
  try {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export async function stageCouncilArtifacts(
  workspace: string,
  artifacts: readonly ArtifactRef[],
): Promise<void> {
  await fs.mkdir(workspace, { recursive: true });
  for (const artifact of artifacts) {
    if (!isMaterializableFileArtifact(artifact)) continue;
    const targetPath = artifact.content?.target_path;
    if (!targetPath) continue;
    const target = path.join(workspace, 'inputs', artifact.artifact_id, targetPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await readArtifactBytes(artifact));
  }
}

async function isGitWorkspace(workspace: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspace, 'rev-parse', '--is-inside-work-tree'],
      { maxBuffer: 1024 * 1024 },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
