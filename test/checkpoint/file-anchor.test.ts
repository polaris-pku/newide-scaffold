import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureFileAnchor,
  releaseFileAnchor,
  restoreFileAnchor,
  verifyFileAnchor,
} from '../../src/checkpoint';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('workspace file anchor', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(os.tmpdir(), 'newide-anchor-test-'));
    git(workspace, ['init', '-q']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(workspace, 'tracked.txt'), 'committed\n');
    git(workspace, ['add', '-A']);
    git(workspace, ['commit', '-qm', 'base']);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('captures tracked edits and untracked files, then restores their content', () => {
    writeFileSync(path.join(workspace, 'tracked.txt'), 'agent edit\n');
    writeFileSync(path.join(workspace, 'untracked.txt'), 'agent output\n');

    const anchor = captureFileAnchor(workspace, { label: 'checkpoint_1' });
    expect(anchor.recoverable).toBe(true);
    expect(anchor.snapshot_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(anchor.snapshot_ref).toBe('refs/newide/safepoints/checkpoint_1');
    expect(verifyFileAnchor(anchor)).toMatchObject({ status: 'ok' });

    // Simulate the interrupted run leaving the workspace in a wrong state.
    writeFileSync(path.join(workspace, 'tracked.txt'), 'corrupted\n');
    rmSync(path.join(workspace, 'untracked.txt'));

    const result = restoreFileAnchor(anchor);
    expect(result.status).toBe('restored');
    expect(result.restored_files).toEqual(['tracked.txt', 'untracked.txt']);
    expect(readFileSync(path.join(workspace, 'tracked.txt'), 'utf8')).toBe('agent edit\n');
    expect(readFileSync(path.join(workspace, 'untracked.txt'), 'utf8')).toBe('agent output\n');
  });

  it('does not disturb the caller index or worktree while capturing', () => {
    writeFileSync(path.join(workspace, 'staged.txt'), 'staged\n');
    git(workspace, ['add', 'staged.txt']);
    const statusBefore = git(workspace, ['status', '--porcelain']);

    captureFileAnchor(workspace, { label: 'checkpoint_2' });

    expect(git(workspace, ['status', '--porcelain'])).toBe(statusBefore);
  });

  it('reports files the snapshot does not know about and prunes only on request', () => {
    const anchor = captureFileAnchor(workspace, { label: 'checkpoint_3' });
    writeFileSync(path.join(workspace, 'leftover.txt'), 'from killed run\n');

    const reported = restoreFileAnchor(anchor);
    expect(reported.extra_files).toEqual(['leftover.txt']);
    expect(reported.pruned_files).toEqual([]);
    expect(existsSync(path.join(workspace, 'leftover.txt'))).toBe(true);

    const pruned = restoreFileAnchor(anchor, { prune_extra_files: true });
    expect(pruned.pruned_files).toEqual(['leftover.txt']);
    expect(existsSync(path.join(workspace, 'leftover.txt'))).toBe(false);
  });

  it('refuses to claim recovery for a non-git workspace', () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'newide-anchor-plain-'));
    try {
      const anchor = captureFileAnchor(plain);
      expect(anchor.recoverable).toBe(false);
      expect(anchor.snapshot_commit).toBeUndefined();
      expect(verifyFileAnchor(anchor)).toMatchObject({
        status: 'unavailable',
        reason: 'no_snapshot_commit',
      });
      expect(restoreFileAnchor(anchor).status).toBe('skipped');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('reports a missing workspace instead of throwing', () => {
    const anchor = captureFileAnchor(path.join(workspace, 'does-not-exist'));
    expect(anchor.recoverable).toBe(false);
    expect(anchor.base_commit).toBe('unavailable:worktree_missing');
  });

  it('releases the snapshot ref when the checkpoint is retired', () => {
    const anchor = captureFileAnchor(workspace, { label: 'checkpoint_4' });
    expect(anchor.snapshot_ref).toBeDefined();

    releaseFileAnchor(anchor);

    expect(() => git(workspace, ['rev-parse', '--verify', anchor.snapshot_ref!])).toThrow();
  });
});
