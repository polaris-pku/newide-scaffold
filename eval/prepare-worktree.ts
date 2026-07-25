import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getScaffoldRoot } from './paths';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 100 * 1024 * 1024;

export interface PrepareEphemeralWorktreeOptions {
  sourceRepo: string;
  baseCommit: string;
  runId: string;
  /** Defaults to `<scaffold>/.newide/eval-workspaces/<runId>` */
  outRoot?: string;
}

export interface PreparedEphemeralWorktree {
  worktreePath: string;
  sourceRepo: string;
  baseCommit: string;
  runId: string;
}

/**
 * Reject reused dirty trees. Relative to the working tree (not a temp index):
 * any staged/unstaged/untracked change fails.
 */
export async function assertWorktreeClean(worktreePath: string): Promise<void> {
  const root = await findGitRoot(worktreePath);
  const status = (await runGit(root, ['status', '--porcelain'])).trim();
  if (status.length > 0) {
    const preview = status.split('\n').slice(0, 8).join('\n');
    throw new Error(
      [
        `Worktree is dirty (refusing reuse): ${root}`,
        'Pass --allow-dirty-worktree only after intentionally modifying a disposable tree,',
        'or use --ephemeral-from <sourceRepo> to create a clean checkout at base_commit.',
        'Dirty preview:',
        preview,
      ].join('\n'),
    );
  }
}

/**
 * Create a detached git worktree at base_commit under
 * `.newide/eval-workspaces/<runId>/` (gitignored via `.newide/`).
 */
export async function prepareEphemeralWorktree(
  options: PrepareEphemeralWorktreeOptions,
): Promise<PreparedEphemeralWorktree> {
  const sourceRepo = await findGitRoot(options.sourceRepo);
  const baseCommit = options.baseCommit.trim();
  if (!baseCommit) {
    throw new Error('baseCommit is required for ephemeral worktree preparation.');
  }

  await runGit(sourceRepo, ['rev-parse', '--verify', `${baseCommit}^{commit}`]);

  const parent =
    options.outRoot?.trim() ||
    path.join(getScaffoldRoot(), '.newide', 'eval-workspaces', options.runId);
  const worktreePath = path.join(parent, 'repo');

  await fs.mkdir(parent, { recursive: true });
  await removePathIfExists(worktreePath);
  // Drop stale worktree registration if a previous run died mid-way.
  try {
    await runGit(sourceRepo, ['worktree', 'prune']);
  } catch {
    // ignore
  }

  await runGit(sourceRepo, ['worktree', 'add', '--detach', worktreePath, baseCommit]);
  await assertWorktreeClean(worktreePath);

  return {
    worktreePath,
    sourceRepo,
    baseCommit,
    runId: options.runId,
  };
}

export async function applyPatchToWorktree(
  worktreePath: string,
  patchContents: string,
): Promise<void> {
  const root = await findGitRoot(worktreePath);
  const patchPath = path.join(root, '.newide-eval-seed.patch');
  await fs.writeFile(patchPath, patchContents, 'utf-8');
  try {
    await runGit(root, ['apply', '--whitespace=nowarn', patchPath]);
  } finally {
    await fs.rm(patchPath, { force: true });
  }
}

export async function removeEphemeralWorktree(
  sourceRepo: string,
  worktreePath: string,
): Promise<void> {
  const root = await findGitRoot(sourceRepo);
  try {
    await runGit(root, ['worktree', 'remove', '--force', worktreePath]);
  } catch {
    await removePathIfExists(worktreePath);
    try {
      await runGit(root, ['worktree', 'prune']);
    } catch {
      // ignore
    }
  }
}

async function removePathIfExists(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

async function findGitRoot(worktreePath: string): Promise<string> {
  try {
    const root = await runGit(path.resolve(worktreePath), ['rev-parse', '--show-toplevel']);
    return path.resolve(root.trim());
  } catch (error) {
    throw new Error(`Path "${worktreePath}" is not inside a Git repository.`, { cause: error });
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}
