import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Namespace for snapshot refs that keep safepoint commits reachable across `git gc`. */
const SNAPSHOT_REF_PREFIX = 'refs/newide/safepoints';

/**
 * Runtime/coordination files that must never enter a workspace snapshot.
 * Capturing them makes resume try to overwrite live SQLite handles and fails on Windows.
 */
const SNAPSHOT_EXCLUDE_GLOBS = [
  '*.sqlite',
  '*.sqlite-shm',
  '*.sqlite-wal',
  '*.sqlite-journal',
  '*.db',
  '*.db-shm',
  '*.db-wal',
] as const;

export interface FileAnchor {
  base_commit: string;
  /** Commit object holding the captured worktree content. Absent when not capturable. */
  snapshot_commit?: string;
  /** Ref keeping `snapshot_commit` reachable. Absent when the commit is dangling. */
  snapshot_ref?: string;
  worktree_path: string;
  branch: string;
  modified_files: string[];
  /** true only when snapshot content can actually be restored, not merely described */
  recoverable: boolean;
}

export interface CaptureFileAnchorOptions {
  /** Unique suffix for the snapshot ref, usually the checkpoint id. */
  label?: string;
}

/**
 * Capture a Git file anchor for a workspace, including a content snapshot.
 *
 * The snapshot is built through a throwaway index file, so neither the caller's
 * index nor the worktree is touched. Tracked modifications and untracked files are
 * both included. A ref under `refs/newide/safepoints` keeps the commit reachable so
 * it survives `git gc` between the interrupt and the resume.
 *
 * Never throws: an unusable workspace yields `recoverable: false` and no snapshot.
 */
export function captureFileAnchor(
  worktreePath: string,
  options: CaptureFileAnchorOptions = {},
): FileAnchor {
  const resolved = path.resolve(worktreePath);
  if (!existsSync(resolved)) {
    return unavailableAnchor(resolved, 'worktree_missing');
  }

  let baseCommit: string;
  let branch: string;
  let modifiedFiles: string[];
  try {
    baseCommit = git(resolved, ['rev-parse', 'HEAD']);
    branch = git(resolved, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD';
    modifiedFiles = readModifiedFiles(resolved);
  } catch {
    return unavailableAnchor(resolved, 'git_unavailable');
  }

  const snapshot = captureSnapshotCommit(resolved, baseCommit, options.label);
  if (!snapshot) {
    return {
      base_commit: baseCommit,
      worktree_path: resolved,
      branch,
      modified_files: modifiedFiles,
      recoverable: false,
    };
  }

  return {
    base_commit: baseCommit,
    snapshot_commit: snapshot.commit,
    ...(snapshot.ref ? { snapshot_ref: snapshot.ref } : {}),
    worktree_path: resolved,
    branch,
    modified_files: modifiedFiles,
    recoverable: true,
  };
}

export type FileAnchorVerification =
  | { status: 'ok'; snapshot_commit: string }
  | { status: 'unavailable'; reason: string };

/**
 * Check that an anchor's snapshot is still resolvable in the workspace repository.
 * Resume must call this before claiming it can restore workspace state.
 */
export function verifyFileAnchor(anchor: FileAnchor): FileAnchorVerification {
  if (!anchor.snapshot_commit) {
    return { status: 'unavailable', reason: 'no_snapshot_commit' };
  }
  if (!existsSync(anchor.worktree_path)) {
    return { status: 'unavailable', reason: 'worktree_missing' };
  }
  try {
    const type = git(anchor.worktree_path, ['cat-file', '-t', anchor.snapshot_commit]);
    if (type !== 'commit') {
      return { status: 'unavailable', reason: `snapshot_not_commit:${type}` };
    }
    return { status: 'ok', snapshot_commit: anchor.snapshot_commit };
  } catch {
    return { status: 'unavailable', reason: 'snapshot_unreachable' };
  }
}

export interface RestoreFileAnchorOptions {
  /**
   * Delete files present in the worktree but absent from the snapshot. Off by default:
   * these are usually leftovers from the interrupted run, but they can also be user
   * files, and silently deleting them is worse than reporting them.
   */
  prune_extra_files?: boolean;
}

export interface RestoreFileAnchorResult {
  status: 'restored' | 'skipped';
  /** Set when status is 'skipped'. */
  reason?: string;
  restored_files: string[];
  /** Present in the worktree but not in the snapshot. Deleted only when pruning. */
  extra_files: string[];
  pruned_files: string[];
}

/**
 * Restore workspace content from an anchor's snapshot commit.
 *
 * Uses a throwaway index so the caller's index is untouched. Snapshot files are written
 * over whatever is on disk. Files the snapshot does not know about are reported and,
 * only with `prune_extra_files`, removed.
 */
export function restoreFileAnchor(
  anchor: FileAnchor,
  options: RestoreFileAnchorOptions = {},
): RestoreFileAnchorResult {
  const verification = verifyFileAnchor(anchor);
  if (verification.status !== 'ok') {
    return {
      status: 'skipped',
      reason: verification.reason,
      restored_files: [],
      extra_files: [],
      pruned_files: [],
    };
  }

  const worktree = anchor.worktree_path;
  const indexDir = mkdtempSync(path.join(os.tmpdir(), 'newide-anchor-restore-'));
  const indexFile = path.join(indexDir, 'index');
  try {
    const snapshotFiles = listTreeFiles(worktree, verification.snapshot_commit).filter(
      (file) => !isRuntimeDatabasePath(file),
    );
    const beforeFiles = new Set(
      listWorktreeFiles(worktree).filter((file) => !isRuntimeDatabasePath(file)),
    );

    git(worktree, ['read-tree', verification.snapshot_commit], indexFile);
    excludeRuntimeDatabaseFiles(worktree, indexFile);
    git(worktree, ['checkout-index', '-a', '-f'], indexFile);

    const extraFiles = [...beforeFiles].filter((file) => !snapshotFiles.includes(file)).sort();
    const prunedFiles: string[] = [];
    if (options.prune_extra_files) {
      for (const file of extraFiles) {
        try {
          rmSync(path.join(worktree, file), { force: true });
          prunedFiles.push(file);
        } catch {
          // leave the file in place; it stays reported under extra_files
        }
      }
    }

    return {
      status: 'restored',
      restored_files: snapshotFiles,
      extra_files: extraFiles,
      pruned_files: prunedFiles,
    };
  } catch (error) {
    return {
      status: 'skipped',
      reason: `restore_failed:${error instanceof Error ? error.message : 'unknown'}`,
      restored_files: [],
      extra_files: [],
      pruned_files: [],
    };
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

/** Drop the snapshot ref for a checkpoint that is no longer needed. */
export function releaseFileAnchor(anchor: FileAnchor): void {
  if (!anchor.snapshot_ref || !existsSync(anchor.worktree_path)) return;
  try {
    git(anchor.worktree_path, ['update-ref', '-d', anchor.snapshot_ref]);
  } catch {
    // best effort; a stale ref only costs disk
  }
}

/**
 * Build a commit holding the current worktree content.
 *
 * Seeds a throwaway index from HEAD, stages everything including untracked files, writes
 * the tree, and commits it with HEAD as parent. Returns undefined rather than throwing so
 * a non-repo or read-only workspace degrades to a non-recoverable anchor.
 */
function captureSnapshotCommit(
  worktree: string,
  baseCommit: string,
  label?: string,
): { commit: string; ref?: string } | undefined {
  const indexDir = mkdtempSync(path.join(os.tmpdir(), 'newide-anchor-capture-'));
  const indexFile = path.join(indexDir, 'index');
  try {
    git(worktree, ['read-tree', baseCommit], indexFile);
    git(worktree, ['add', '-A'], indexFile);
    // Drop live coordination DBs / lockfiles so restore never fights an open SQLite handle.
    excludeRuntimeDatabaseFiles(worktree, indexFile);
    const tree = git(worktree, ['write-tree'], indexFile);
    const commit = git(worktree, [
      'commit-tree',
      tree,
      '-p',
      baseCommit,
      '-m',
      `newide safepoint${label ? ` ${label}` : ''}`,
    ]);

    // Keep the commit reachable so `git gc` cannot prune it before resume.
    let ref: string | undefined;
    if (label) {
      const candidate = `${SNAPSHOT_REF_PREFIX}/${sanitizeRefSegment(label)}`;
      try {
        git(worktree, ['update-ref', candidate, commit]);
        ref = candidate;
      } catch {
        // dangling commit is still usable within this gc window
      }
    }
    return ref ? { commit, ref } : { commit };
  } catch {
    return undefined;
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

function excludeRuntimeDatabaseFiles(worktree: string, indexFile: string): void {
  for (const pattern of SNAPSHOT_EXCLUDE_GLOBS) {
    try {
      git(worktree, ['rm', '-r', '--cached', '-f', '--ignore-unmatch', '--', pattern], indexFile);
    } catch {
      // pattern may match nothing
    }
  }
}

function isRuntimeDatabasePath(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return (
    base.endsWith('.sqlite') ||
    base.endsWith('.sqlite-shm') ||
    base.endsWith('.sqlite-wal') ||
    base.endsWith('.sqlite-journal') ||
    base.endsWith('.db') ||
    base.endsWith('.db-shm') ||
    base.endsWith('.db-wal')
  );
}

function readModifiedFiles(worktree: string): string[] {
  return git(worktree, ['status', '--porcelain'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[MADRCU?!]{1,2}\s+/, '').trim())
    .filter((line) => line.length > 0);
}

function listTreeFiles(worktree: string, commit: string): string[] {
  return splitLines(git(worktree, ['ls-tree', '-r', '--name-only', commit])).sort();
}

function listWorktreeFiles(worktree: string): string[] {
  return splitLines(
    git(worktree, ['ls-files', '--cached', '--others', '--exclude-standard']),
  ).sort();
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function sanitizeRefSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
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

function git(cwd: string, args: string[], indexFile?: string): string {
  // Force LF and no autocrlf so snapshot bytes match what the agent wrote, even on Windows.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.eol',
      GIT_CONFIG_VALUE_1: 'lf',
      ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
    },
  }).trim();
}
