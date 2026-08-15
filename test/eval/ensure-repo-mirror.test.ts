import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureRepoMirror,
  githubCloneUrl,
  mirrorPathForRepo,
  repoMirrorSlug,
  resolveMirrorsRoot,
} from '../../eval/ensure-repo-mirror';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('ensure-repo-mirror helpers', () => {
  it('slugs owner/name repos', () => {
    expect(repoMirrorSlug('conan-io/conan')).toBe('conan-io__conan');
    expect(githubCloneUrl('conan-io/conan')).toBe('https://github.com/conan-io/conan.git');
  });

  it('uses a portable repo-local mirrors root unless overridden', () => {
    const previous = process.env.NEWIDE_SWE_MIRRORS_ROOT;
    delete process.env.NEWIDE_SWE_MIRRORS_ROOT;
    try {
      expect(resolveMirrorsRoot()).toBe(path.resolve('.newide', 'eval-mirrors'));
      expect(mirrorPathForRepo('dask/dask', 'D:\\cache')).toBe(
        path.join(path.resolve('D:\\cache'), 'dask__dask'),
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
    mkdirSync(origin, { recursive: true });

    const gitEnv = {
      ...process.env,
      Path: `${process.env.Path ?? process.env.PATH ?? ''};C:\\Program Files\\Git\\cmd`,
      PATH: `${process.env.PATH ?? process.env.Path ?? ''};C:\\Program Files\\Git\\cmd`,
    };

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
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: origin,
      encoding: 'utf-8',
      env: gitEnv,
    }).trim();

    const previousPath = process.env.Path;
    const previousPATH = process.env.PATH;
    process.env.Path = gitEnv.Path;
    process.env.PATH = gitEnv.PATH;
    try {
      const first = await ensureRepoMirror({
        repo: 'local/fixture',
        baseCommit,
        mirrorsRoot,
        cloneUrl: origin,
      });
      expect(first.cloned).toBe(true);
      expect(first.mirrorPath).toBe(path.join(mirrorsRoot, 'local__fixture'));

      const second = await ensureRepoMirror({
        repo: 'local/fixture',
        baseCommit,
        mirrorsRoot,
        cloneUrl: origin,
      });
      expect(second.cloned).toBe(false);
      expect(second.mirrorPath).toBe(first.mirrorPath);
    } finally {
      if (previousPath === undefined) delete process.env.Path;
      else process.env.Path = previousPath;
      if (previousPATH === undefined) delete process.env.PATH;
      else process.env.PATH = previousPATH;
    }
  });
});
