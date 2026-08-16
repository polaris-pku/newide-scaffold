import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 100 * 1024 * 1024;

/** Portable repo-local default; override with NEWIDE_SWE_MIRRORS_ROOT. */
export const DEFAULT_SWE_MIRRORS_ROOT = path.join('.newide', 'eval-mirrors');

export interface EnsureRepoMirrorOptions {
  /** GitHub-style repo id, e.g. `conan-io/conan`. */
  repo: string;
  baseCommit: string;
  mirrorsRoot?: string;
  /** Override clone URL (tests / mirrors). Default: https://github.com/<repo>.git */
  cloneUrl?: string;
}

export interface EnsuredRepoMirror {
  mirrorPath: string;
  repo: string;
  baseCommit: string;
  /** True when this call performed a fresh clone. */
  cloned: boolean;
}

export function resolveMirrorsRoot(override?: string): string {
  const fromArg = override?.trim();
  if (fromArg) return path.resolve(fromArg);
  const fromEnv = process.env.NEWIDE_SWE_MIRRORS_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(DEFAULT_SWE_MIRRORS_ROOT);
}

export function repoMirrorSlug(repo: string): string {
  const trimmed = repo.trim();
  if (!trimmed || trimmed.includes('..') || path.isAbsolute(trimmed)) {
    throw new Error(`Invalid repo id "${repo}". Expected owner/name (e.g. conan-io/conan).`);
  }
  return trimmed.replaceAll('/', '__');
}

export function githubCloneUrl(repo: string): string {
  return `https://github.com/${repo.trim()}.git`;
}

export function mirrorPathForRepo(repo: string, mirrorsRoot?: string): string {
  return path.join(resolveMirrorsRoot(mirrorsRoot), repoMirrorSlug(repo));
}

/**
 * Lazily ensure a repo-level git mirror exists and contains `baseCommit`.
 * Does not pre-clone an entire subset — call only when an instance needs the repo.
 */
export async function ensureRepoMirror(
  options: EnsureRepoMirrorOptions,
): Promise<EnsuredRepoMirror> {
  const repo = options.repo.trim();
  const baseCommit = options.baseCommit.trim();
  if (!repo) throw new Error('repo is required');
  if (!baseCommit) throw new Error('baseCommit is required');

  const mirrorPath = mirrorPathForRepo(repo, options.mirrorsRoot);
  const cloneUrl = options.cloneUrl?.trim() || githubCloneUrl(repo);
  let cloned = false;

  await fs.mkdir(path.dirname(mirrorPath), { recursive: true });

  if (!(await isGitCheckout(mirrorPath))) {
    await removePathIfExists(mirrorPath);
    await runGit('.', [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      cloneUrl,
      mirrorPath,
    ]);
    cloned = true;
  }

  if (!(await hasCommit(mirrorPath, baseCommit))) {
    try {
      await runGit(mirrorPath, ['fetch', '--filter=blob:none', 'origin', baseCommit]);
    } catch {
      await runGit(mirrorPath, ['fetch', '--filter=blob:none', 'origin']);
    }
  }

  if (!(await hasCommit(mirrorPath, baseCommit))) {
    throw new Error(
      [
        `Mirror "${mirrorPath}" does not contain base_commit ${baseCommit}.`,
        `Tried clone/fetch from ${cloneUrl}.`,
      ].join(' '),
    );
  }

  return { mirrorPath, repo, baseCommit, cloned };
}

async function isGitCheckout(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  try {
    await runGit(dir, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

async function hasCommit(cwd: string, commit: string): Promise<boolean> {
  try {
    await runGit(cwd, ['rev-parse', '--verify', `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function removePathIfExists(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}
