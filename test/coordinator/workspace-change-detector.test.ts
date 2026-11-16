/** Project snapshots must exclude only Driver runtime state, not project configuration. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isDeliverableWorkspacePath,
  snapshotWorkspaceFiles,
  snapshotWorkspaceContent,
  snapshotWorkspaceContentSync,
  hashWorkspaceContent,
  diffWorkspaceFiles,
} from '../../src/coordinator/workspace-change-detector';

it('ignores root local permission state consistently while tracking other .claude files', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-workspace-state-'));
  try {
    await fs.mkdir(path.join(workspace, '.claude'));
    await fs.mkdir(path.join(workspace, 'nested', '.claude'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.claude', 'settings.json'), 'project config');
    await fs.writeFile(
      path.join(workspace, 'nested', '.claude', 'settings.local.json'),
      'nested config',
    );
    const beforeFiles = await snapshotWorkspaceFiles(workspace);
    const beforeContent = await snapshotWorkspaceContent(workspace);
    await fs.writeFile(
      path.join(workspace, '.claude', 'settings.local.json'),
      '{"permissions":{}}',
    );
    expect(diffWorkspaceFiles(beforeFiles, await snapshotWorkspaceFiles(workspace))).toEqual([]);
    expect(await snapshotWorkspaceContent(workspace)).toEqual(beforeContent);
    expect(hashWorkspaceContent(snapshotWorkspaceContentSync(workspace))).toBe(
      hashWorkspaceContent(beforeContent),
    );
    expect([...beforeContent.keys()].sort()).toEqual([
      '.claude/settings.json',
      'nested/.claude/settings.local.json',
    ]);
    await fs.writeFile(path.join(workspace, '.claude', 'settings.json'), 'changed project config');
    expect(await snapshotWorkspaceContent(workspace)).not.toEqual(beforeContent);
    expect(snapshotWorkspaceContentSync(workspace)).toEqual(
      await snapshotWorkspaceContent(workspace),
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

describe('isDeliverableWorkspacePath', () => {
  it('keeps source files and rejects generated Python caches', () => {
    expect(isDeliverableWorkspacePath('src/solver.py')).toBe(true);
    expect(isDeliverableWorkspacePath('src/__pycache__/solver.cpython-312.pyc')).toBe(false);
    expect(isDeliverableWorkspacePath('src\\__pycache__\\solver.pyc')).toBe(false);
    expect(isDeliverableWorkspacePath('.pytest_cache/v/cache/nodeids')).toBe(false);
    expect(isDeliverableWorkspacePath('src/typecheck.pyi')).toBe(true);
  });
});
