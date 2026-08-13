import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 100 * 1024 * 1024;
/** Wait this long for another process to finish clone/fetch before failing. */
const DEFAULT_MIRROR_LOCK_WAIT_MS = 60 * 60 * 1000;
/** Steal a lock only when the holder PID is dead, or the lock is older than this. */
const DEFAULT_MIRROR_LOCK_STALE_MS = 60 * 60 * 1000;

/**
 * Default mirror cache: `<cwd>/.newide/eval-mirrors`
 * (override with NEWIDE_SWE_MIRRORS_ROOT or --mirrors-root).
 */
export const DEFAULT_SWE_MIRRORS_ROOT_SEGMENTS = ['.newide', 'eval-mirrors'] as const;

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

export function defaultSweMirrorsRoot(cwd: string = process.cwd()): string {
  return path.resolve(cwd, ...DEFAULT_SWE_MIRRORS_ROOT_SEGMENTS);
}

export function resolveMirrorsRoot(override?: string): string {
  const fromArg = override?.trim();
  if (fromArg) return path.resolve(fromArg);
  const fromEnv = process.env.NEWIDE_SWE_MIRRORS_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return defaultSweMirrorsRoot();
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

export function mirrorEnsureLockPath(mirrorPath: string): string {
  return `${mirrorPath}.ensure.lock`;
}

/**
 * Lazily ensure a repo-level git mirror exists and contains `baseCommit`.
 * Does not pre-clone an entire subset — call only when an instance needs the repo.
 *
 * Clone/fetch of a given mirror path is serialized across processes via a sibling
 * lockfile so parallel ablation arms cannot corrupt a cold-start cache.
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

  await fs.mkdir(path.dirname(mirrorPath), { recursive: true });

  return withExclusiveFileLock(mirrorEnsureLockPath(mirrorPath), async () => {
    let cloned = false;

    if (!(await isGitCheckout(mirrorPath))) {
      await removePathIfExists(mirrorPath);
      // Full object clone (no blob:none). prepareEphemeralWorktree uses
      // `git clone --no-local` from this mirror; partial clones cannot serve
      // blobs via upload-pack when lazy fetching is disabled.
      await runGit('.', ['clone', '--no-checkout', cloneUrl, mirrorPath]);
      cloned = true;
    }

    if (!(await hasCommit(mirrorPath, baseCommit))) {
      try {
        await runGit(mirrorPath, ['fetch', 'origin', baseCommit]);
      } catch {
        await runGit(mirrorPath, ['fetch', 'origin']);
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
  });
}

/**
 * Cross-process exclusive lock via O_EXCL lockfile.
 * Holder writes pid + timestamp; waiters steal only if the pid is dead or the lock is stale.
 */
export async function withExclusiveFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: { waitMs?: number; staleMs?: number },
): Promise<T> {
  const waitMs = options?.waitMs ?? readPositiveIntEnv(
    'NEWIDE_SWE_MIRROR_LOCK_WAIT_MS',
    DEFAULT_MIRROR_LOCK_WAIT_MS,
  );
  const staleMs = options?.staleMs ?? readPositiveIntEnv(
    'NEWIDE_SWE_MIRROR_LOCK_STALE_MS',
    DEFAULT_MIRROR_LOCK_STALE_MS,
  );
  const deadline = Date.now() + waitMs;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (Date.now() < deadline) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
          'utf-8',
        );
        return await fn();
      } finally {
        await handle.close().catch(() => undefined);
        await fs.unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await tryStealStaleLock(lockPath, staleMs)) continue;
      await sleep(50 + Math.floor(Math.random() * 50));
    }
  }

  throw new Error(
    `Timed out after ${String(waitMs)}ms waiting for mirror lock: ${lockPath}`,
  );
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

async function tryStealStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf-8');
  } catch (error) {
    // Lock disappeared between EEXIST and read — retry acquire.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }

  let holderPid: number | undefined;
  let createdAtMs: number | undefined;
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; created_at?: unknown };
    if (typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)) {
      holderPid = Math.floor(parsed.pid);
    }
    if (typeof parsed.created_at === 'string') {
      const parsedMs = Date.parse(parsed.created_at);
      if (Number.isFinite(parsedMs)) createdAtMs = parsedMs;
    }
  } catch {
    // Non-JSON lock body: fall back to mtime-only staleness below.
  }

  if (holderPid !== undefined && holderPid !== process.pid && !isPidAlive(holderPid)) {
    await fs.unlink(lockPath).catch(() => undefined);
    return true;
  }

  if (createdAtMs === undefined) {
    try {
      createdAtMs = (await fs.stat(lockPath)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }

  if (Date.now() - createdAtMs > staleMs) {
    await fs.unlink(lockPath).catch(() => undefined);
    return true;
  }

  return false;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we cannot signal it.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
