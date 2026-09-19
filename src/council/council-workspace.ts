import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ArtifactRef } from '../core';
import { isMaterializableFileArtifact, readArtifactBytes } from '../coordinator/artifact-content';

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
      ['-C', source, '-c', 'core.longpaths=true', 'worktree', 'add', '--detach', target, 'HEAD'],
      {
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    await copyDirtyGitFiles(source, target);
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

/**
 * A detached worktree starts from HEAD, while a task workspace may already
 * contain the user's staged, unstaged, or untracked inputs. Materialize those
 * differences after creating the isolated worktree so Council participants see
 * the same task baseline without changing the source checkout.
 */
async function copyDirtyGitFiles(source: string, target: string): Promise<void> {
  const tracked = await gitPathList(source, ['diff', '--name-only', '-z', 'HEAD']);
  const untracked = await gitPathList(source, ['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = new Set([...tracked, ...untracked]);
  for (const relative of paths) {
    const normalized = relative.replaceAll('\\', '/');
    if (
      !normalized ||
      path.posix.isAbsolute(normalized) ||
      path.win32.isAbsolute(normalized) ||
      normalized.split('/').includes('..')
    ) {
      throw new Error(`Git workspace path escapes source: ${relative}`);
    }
    const from = path.join(source, normalized);
    const to = path.join(target, normalized);
    try {
      await fs.access(from);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.cp(from, to, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A tracked file deleted in the source checkout must also be absent from
      // the participant worktree instead of silently reappearing from HEAD.
      await fs.rm(to, { recursive: true, force: true });
    }
  }
}

async function gitPathList(source: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['-C', source, ...args], {
    encoding: 'buffer',
    maxBuffer: 10 * 1024 * 1024,
  });
  return Buffer.from(stdout)
    .toString('utf8')
    .split('\0')
    .filter((value) => value.length > 0);
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
    if (!/^[A-Za-z0-9_-]+$/.test(artifact.artifact_id)) {
      throw new Error(`Invalid Council artifact id: ${artifact.artifact_id}`);
    }
    const relative = targetPath.replaceAll('\\', '/');
    if (
      path.posix.isAbsolute(relative) ||
      path.win32.isAbsolute(relative) ||
      relative.split('/').includes('..')
    ) {
      throw new Error(`Council artifact target escapes workspace: ${targetPath}`);
    }
    const target = path.join(workspace, 'inputs', artifact.artifact_id, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await readArtifactBytes(artifact));
  }
}

async function isGitWorkspace(workspace: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspace, 'rev-parse', '--show-toplevel'],
      { maxBuffer: 1024 * 1024 },
    );
    // A project nested inside another repository must not clone that parent's HEAD.
    return (await fs.realpath(stdout.trim())) === (await fs.realpath(workspace));
  } catch {
    return false;
  }
}
