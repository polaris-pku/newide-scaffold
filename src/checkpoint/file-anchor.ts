import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface FileAnchor {
  base_commit: string;
  snapshot_commit?: string;
  worktree_path: string;
  branch: string;
  modified_files: string[];
  /** true when git metadata was captured successfully */
  recoverable: boolean;
}

/**
 * Capture a best-effort Git file anchor for a workspace.
 * Never throws: unavailable anchors are marked recoverable=false.
 */
export function captureFileAnchor(worktreePath: string): FileAnchor {
  const resolved = path.resolve(worktreePath);
  if (!existsSync(resolved)) {
    return unavailableAnchor(resolved, 'worktree_missing');
  }

  try {
    const baseCommit = git(resolved, ['rev-parse', 'HEAD']);
    const branch = git(resolved, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = git(resolved, ['status', '--porcelain']);
    const modifiedFiles = status
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^[MADRCU?!]{1,2}\s+/, '').trim())
      .filter((line) => line.length > 0);
    return {
      base_commit: baseCommit,
      worktree_path: resolved,
      branch: branch || 'HEAD',
      modified_files: modifiedFiles,
      recoverable: true,
    };
  } catch {
    return unavailableAnchor(resolved, 'git_unavailable');
  }
}

function unavailableAnchor(worktreePath: string, reason: string): FileAnchor {
  return {
    base_commit: `unavailable:${reason}`,
    worktree_path: worktreePath,
    branch: 'unavailable',
    modified_files: [],
    recoverable: false,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  }).trim();
}
