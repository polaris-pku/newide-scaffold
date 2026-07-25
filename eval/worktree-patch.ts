import { execFile } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_PATCH_BUFFER = 100 * 1024 * 1024;

export interface CollectWorktreePatchOptions {
  baseRef?: string;
}

export async function collectWorktreePatch(
  worktreePath: string,
  options: CollectWorktreePatchOptions = {},
): Promise<string> {
  const root = await findGitRoot(worktreePath);
  const baseRef = options.baseRef?.trim() || 'HEAD';
  const temporaryDirectory = await fs.mkdtemp(path.join(tmpdir(), 'newide-eval-index-'));
  const temporaryIndex = path.join(temporaryDirectory, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };

  try {
    await runGit(root, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
    await runGit(root, ['read-tree', baseRef], env);
    await runGit(root, ['add', '-A', '--', '.'], env);
    const patch = await runGit(
      root,
      ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', baseRef, '--'],
      env,
    );
    if (!patch.trim()) {
      throw new Error(`No changes found in worktree "${root}" relative to ${baseRef}.`);
    }
    return patch;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function readBackendWorktreePath(summaryPath: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(summaryPath, 'utf-8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read backend summary "${summaryPath}".`, { cause: error });
  }
  if (!isRecord(raw) || typeof raw.worktree_path !== 'string' || !raw.worktree_path.trim()) {
    throw new Error(`Backend summary "${summaryPath}" does not contain a worktree_path.`);
  }
  return path.resolve(raw.worktree_path);
}

async function findGitRoot(worktreePath: string): Promise<string> {
  try {
    const root = await runGit(path.resolve(worktreePath), ['rev-parse', '--show-toplevel']);
    return path.resolve(root.trim());
  } catch (error) {
    throw new Error(`Worktree "${worktreePath}" is not inside a Git repository.`, {
      cause: error,
    });
  }
}

async function runGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env,
    encoding: 'utf-8',
    maxBuffer: MAX_PATCH_BUFFER,
  });
  return stdout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
