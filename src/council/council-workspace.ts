import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

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
    return;
  }

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
