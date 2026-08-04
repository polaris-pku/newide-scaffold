import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  prepareEphemeralWorktree,
  removeEphemeralWorktree,
} from '../../eval/prepare-worktree';
import { collectWorktreePatch } from '../../eval/worktree-patch';

const execFileAsync = promisify(execFile);

describe('prepareEphemeralWorktree', () => {
  it('exposes only the base commit and removes target tags, objects, and remotes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-eval-history-'));
    const sourceRepo = path.join(root, 'source');
    const outRoot = path.join(root, 'worktree');
    await runGit(root, ['init', sourceRepo]);
    await runGit(sourceRepo, ['config', 'user.email', 'eval@example.com']);
    await runGit(sourceRepo, ['config', 'user.name', 'Eval']);

    await writeFile(path.join(sourceRepo, 'value.txt'), 'base\n');
    await runGit(sourceRepo, ['add', 'value.txt']);
    await runGit(sourceRepo, ['commit', '-m', 'base']);
    const baseCommit = await runGit(sourceRepo, ['rev-parse', 'HEAD']);

    await writeFile(path.join(sourceRepo, 'value.txt'), 'gold\n');
    await runGit(sourceRepo, ['commit', '-am', 'target']);
    const targetCommit = await runGit(sourceRepo, ['rev-parse', 'HEAD']);
    await runGit(sourceRepo, ['tag', 'v2.0.0']);

    let prepared: Awaited<ReturnType<typeof prepareEphemeralWorktree>> | undefined;
    try {
      prepared = await prepareEphemeralWorktree({
        sourceRepo,
        baseCommit,
        runId: 'history-isolation',
        outRoot,
      });

      expect(await runGit(prepared.worktreePath, ['rev-parse', 'HEAD'])).toBe(baseCommit);
      expect(await runGit(prepared.worktreePath, ['rev-list', '--count', 'HEAD'])).toBe('1');
      expect(await runGit(prepared.worktreePath, ['tag', '--list'])).toBe('');
      expect(await runGit(prepared.worktreePath, ['remote'])).toBe('');
      await expect(
        runGit(prepared.worktreePath, ['cat-file', '-e', `${targetCommit}^{commit}`]),
      ).rejects.toThrow();
      await expect(
        runGit(prepared.worktreePath, ['rev-parse', '--verify', 'v2.0.0^{commit}']),
      ).rejects.toThrow();

      await mkdir(path.join(prepared.worktreePath, '.claude'), { recursive: true });
      await writeFile(
        path.join(prepared.worktreePath, '.claude', 'settings.json'),
        '{"permissions":{"deny":["WebFetch"]}}\n',
      );
      await writeFile(path.join(prepared.worktreePath, 'value.txt'), 'model change\n');
      const patch = await collectWorktreePatch(prepared.worktreePath);
      expect(patch).not.toContain('.claude/settings.json');
      expect(patch).toContain('model change');
    } finally {
      if (prepared) {
        await removeEphemeralWorktree(sourceRepo, prepared.worktreePath);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return stdout.trim();
}
