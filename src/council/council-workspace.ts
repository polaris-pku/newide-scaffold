import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ArtifactRef } from '../core';
import {
  isMaterializableFileArtifact,
  readArtifactBytes,
} from '../coordinator/artifact-content';

const execFileAsync = promisify(execFile);

export async function prepareCouncilWorkspace(
  sourceWorkspace: string | undefined,
  targetWorkspace: string,
): Promise<void> {
  if (!sourceWorkspace) {
    await fs.mkdir(targetWorkspace, { recursive: true });
    return;
  }

  const source = path.resolve(sourceWorkspace);
  const target = path.resolve(targetWorkspace);
  if (source === target) return;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(target, { recursive: true, force: true });
  if (await isGitWorkspace(source)) {
    await execFileAsync('git', ['-C', source, 'worktree', 'add', '--detach', target, 'HEAD'], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return;
  }

  await fs.cp(source, target, {
    recursive: true,
    force: true,
    filter(candidate) {
      const resolved = path.resolve(candidate);
      if (resolved === target || resolved.startsWith(`${target}${path.sep}`)) return false;
      const relative = path.relative(source, resolved);
      const rootEntry = relative.split(path.sep)[0];
      return rootEntry !== '.git' && rootEntry !== '.newide';
    },
  });
}

export async function stageCouncilArtifacts(
  workspace: string,
  artifacts: readonly ArtifactRef[],
): Promise<void> {
  await fs.mkdir(workspace, { recursive: true });
  for (const artifact of artifacts) {
    if (!isMaterializableFileArtifact(artifact)) continue;
    const targetPath = artifact.content?.target_path;
    if (!targetPath) continue;
    const target = path.join(workspace, 'inputs', artifact.artifact_id, targetPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await readArtifactBytes(artifact));
  }
}

async function isGitWorkspace(workspace: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspace, 'rev-parse', '--is-inside-work-tree'],
      { maxBuffer: 1024 * 1024 },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
