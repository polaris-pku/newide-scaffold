import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureRepoMirror,
  githubCloneUrl,
  mirrorEnsureLockPath,
  mirrorPathForRepo,
  repoMirrorSlug,
  resolveMirrorsRoot,
  withExclusiveFileLock,
} from '../../eval/ensure-repo-mirror';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function initLocalOrigin(origin: string): string {
  const gitEnv = {
    ...process.env,
    Path: `${process.env.Path ?? process.env.PATH ?? ''};C:\\Program Files\\Git\\cmd`,
    PATH: `${process.env.PATH ?? process.env.Path ?? ''};C:\\Program Files\\Git\\cmd`,
  };

  mkdirSync(origin, { recursive: true });
  execFileSync('git', ['init'], { cwd: origin, stdio: 'ignore', env: gitEnv });
  execFileSync('git', ['config', 'user.email', 'eval@newide.test'], {
    cwd: origin,
    stdio: 'ignore',
    env: gitEnv,
  });
  execFileSync('git', ['config', 'user.name', 'NewIDE Eval'], {
    cwd: origin,
    stdio: 'ignore',
    env: gitEnv,
  });
  writeFileSync(path.join(origin, 'README.md'), '# origin\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: origin, stdio: 'ignore', env: gitEnv });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: origin, stdio: 'ignore', env: gitEnv });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: origin,
    encoding: 'utf-8',
    env: gitEnv,
  }).trim();
}

async function withGitOnPath<T>(fn: () => Promise<T>): Promise<T> {
  const gitEnv = {
    Path: `${process.env.Path ?? process.env.PATH ?? ''};C:\\Program Files\\Git\\cmd`,
    PATH: `${process.env.PATH ?? process.env.Path ?? ''};C:\\Program Files\\Git\\cmd`,
  };
  const previousPath = process.env.Path;
  const previousPATH = process.env.PATH;
  process.env.Path = gitEnv.Path;
  process.env.PATH = gitEnv.PATH;
  try {
    return await fn();
  } finally {
    if (previousPath === undefined) delete process.env.Path;
    else process.env.Path = previousPath;
    if (previousPATH === undefined) delete process.env.PATH;
    else process.env.PATH = previousPATH;
  }
}

describe('ensure-repo-mirror helpers', () => {
  it('slugs owner/name repos', () => {
    expect(repoMirrorSlug('conan-io/conan')).toBe('conan-io__conan');
    expect(githubCloneUrl('conan-io/conan')).toBe('https://github.com/conan-io/conan.git');
  });

  it('resolves portable default mirrors root unless overridden', () => {
    const previous = process.env.NEWIDE_SWE_MIRRORS_ROOT;
    delete process.env.NEWIDE_SWE_MIRRORS_ROOT;
    try {
      expect(resolveMirrorsRoot()).toBe(path.resolve(process.cwd(), '.newide', 'eval-mirrors'));
      expect(mirrorPathForRepo('dask/dask', path.join('cache-root'))).toBe(
        path.join(path.resolve('cache-root'), 'dask__dask'),
      );
    } finally {
      if (previous === undefined) delete process.env.NEWIDE_SWE_MIRRORS_ROOT;
      else process.env.NEWIDE_SWE_MIRRORS_ROOT = previous;
    }
  });

  it('lazily clones a local origin into the mirrors root', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'newide-mirror-'));
    cleanup.push(scratch);
    const origin = path.join(scratch, 'origin');
    const mirrorsRoot = path.join(scratch, 'mirrors');
    const baseCommit = initLocalOrigin(origin);

    await withGitOnPath(async () => {
      const first = await ensureRepoMirror({
        repo: 'local/fixture',
        baseCommit,
        mirrorsRoot,
        cloneUrl: origin,
      });
      expect(first.cloned).toBe(true);
      expect(first.mirrorPath).toBe(path.join(mirrorsRoot, 'local__fixture'));
      expect(mirrorEnsureLockPath(first.mirrorPath)).toBe(`${first.mirrorPath}.ensure.lock`);

      const second = await ensureRepoMirror({
        repo: 'local/fixture',
        baseCommit,
        mirrorsRoot,
        cloneUrl: origin,
      });
      expect(second.cloned).toBe(false);
      expect(second.mirrorPath).toBe(first.mirrorPath);
    });
  });

  it('serializes concurrent cold-start clones of the same mirror', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'newide-mirror-parallel-'));
    cleanup.push(scratch);
    const origin = path.join(scratch, 'origin');
    const mirrorsRoot = path.join(scratch, 'mirrors');
    const baseCommit = initLocalOrigin(origin);

    await withGitOnPath(async () => {
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          ensureRepoMirror({
            repo: 'local/fixture',
            baseCommit,
            mirrorsRoot,
            cloneUrl: origin,
          }),
        ),
      );

      expect(new Set(results.map((row) => row.mirrorPath)).size).toBe(1);
      expect(results.filter((row) => row.cloned)).toHaveLength(1);
      expect(results.every((row) => row.baseCommit === baseCommit)).toBe(true);
    });
  });

  it('steals a lock left by a dead pid', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'newide-mirror-lock-'));
    cleanup.push(scratch);
    const lockPath = path.join(scratch, 'repo.ensure.lock');
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf-8' });
    const deadPid = dead.pid;
    expect(deadPid).toBeTypeOf('number');
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: deadPid, created_at: new Date().toISOString() })}\n`,
      'utf-8',
    );

    let ran = false;
    await withExclusiveFileLock(
      lockPath,
      async () => {
        ran = true;
      },
      { waitMs: 5_000, staleMs: 60_000 },
    );
    expect(ran).toBe(true);
  });
});
