import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef, type TaskId } from '../core';

const execFileAsync = promisify(execFile);

export interface MaterializationFailure {
  artifact_id: string;
  reason: string;
}

export interface MaterializationResult {
  materialization_id: string;
  task_id: TaskId;
  worktree_path: string;
  materialized_artifacts: ArtifactRef[];
  files_written: string[];
  changed_files: string[];
  status: 'completed' | 'partial' | 'failed';
  failures: MaterializationFailure[];
  created_at: string;
  schema_version: string;
}

export interface MaterializationInput {
  task_id: TaskId;
  artifacts: ArtifactRef[];
}

export interface WorktreeMaterializerOptions {
  baseWorktreePath: string;
}

/**
 * WorktreeMaterializer: Writes selected artifacts to worktree directory.
 *
 * Current implementation (v0):
 * - Creates .newide/worktrees/<task_id>/ directory
 * - Writes artifact metadata as JSON files
 * - Returns MaterializationResult with files_written, worktree_path, materialized_artifacts
 *
 * Future implementation:
 * - Apply patches to actual source files
 * - Create git worktrees
 * - Handle merge conflicts
 */
export class WorktreeMaterializer {
  private readonly options: WorktreeMaterializerOptions;

  constructor(options: WorktreeMaterializerOptions) {
    this.options = options;
  }

  async materialize(input: MaterializationInput): Promise<MaterializationResult> {
    const worktreePath = path.join(this.options.baseWorktreePath, input.task_id);

    // Create worktree directory
    await fs.mkdir(worktreePath, { recursive: true });

    const filesWritten: string[] = [];
    const changedFiles: string[] = [];
    const materializedArtifacts: ArtifactRef[] = [];
    const failures: MaterializationFailure[] = [];

    // Write each artifact to worktree
    for (const artifact of input.artifacts) {
      try {
        if (artifact.content) {
          const written = await materializeContent(worktreePath, artifact);
          filesWritten.push(...written);
          // changed_files describes files materialized from deliverable content.
          // Metadata records remain auditable through files_written but are not
          // user deliverables and therefore must not enter changed_files.
          if (artifact.content.kind !== 'metadata') changedFiles.push(...written);
        } else if (
          artifact.type === 'patch' ||
          artifact.type === 'diff' ||
          artifact.type === 'driver_result'
        ) {
          // Metadata blobs: register, but never as a changed file.
          const artifactFile = path.join(worktreePath, `${artifact.artifact_id}.json`);
          await fs.writeFile(artifactFile, JSON.stringify(artifact, null, 2), 'utf-8');
          filesWritten.push(artifactFile);
        }
        materializedArtifacts.push(artifact);
      } catch (error) {
        failures.push({
          artifact_id: artifact.artifact_id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const uniqueFiles = [...new Set(filesWritten)];
    const uniqueChangedFiles = [...new Set(changedFiles)];
    const status =
      failures.length === 0 ? 'completed' : materializedArtifacts.length > 0 ? 'partial' : 'failed';

    return {
      materialization_id: createId('materialization'),
      task_id: input.task_id,
      worktree_path: worktreePath,
      materialized_artifacts: materializedArtifacts,
      files_written: uniqueFiles,
      changed_files: uniqueChangedFiles,
      status,
      failures,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  /**
   * Clean up worktree directory for a task.
   */
  async cleanup(taskId: TaskId): Promise<void> {
    const worktreePath = path.join(this.options.baseWorktreePath, taskId);
    try {
      await fs.rm(worktreePath, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory doesn't exist
    }
  }
}

async function materializeContent(worktreePath: string, artifact: ArtifactRef): Promise<string[]> {
  const content = artifact.content;
  if (!content) return [];
  if (content.kind === 'metadata') {
    const target = safeTargetPath(
      worktreePath,
      content.target_path ?? `${artifact.artifact_id}.json`,
    );
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(artifact, null, 2), 'utf-8');
    return [target];
  }

  const body = await readContentRef(content.content_ref);
  if (content.kind === 'patch') return applyPatch(worktreePath, artifact.artifact_id, body);
  if (!content.target_path) throw new Error(`${content.kind} artifact requires target_path`);
  const target = safeTargetPath(worktreePath, content.target_path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
  return [target];
}

async function readContentRef(contentRef: string): Promise<Buffer> {
  if (contentRef.startsWith('data:')) {
    const comma = contentRef.indexOf(',');
    if (comma < 0) throw new Error('Invalid data content_ref');
    const metadata = contentRef.slice(5, comma);
    const encoded = contentRef.slice(comma + 1);
    return metadata.endsWith(';base64')
      ? Buffer.from(encoded, 'base64')
      : Buffer.from(decodeURIComponent(encoded), 'utf-8');
  }
  const source = contentRef.startsWith('file:') ? fileURLToPath(contentRef) : contentRef;
  return fs.readFile(source);
}

async function applyPatch(
  worktreePath: string,
  artifactId: string,
  patchBody: Buffer,
): Promise<string[]> {
  const absoluteWorktree = path.resolve(worktreePath);
  const patchFile = path.join(absoluteWorktree, `.${artifactId}.patch`);
  const gitOptions = {
    cwd: absoluteWorktree,
    env: {
      ...process.env,
      GIT_CEILING_DIRECTORIES: path.dirname(absoluteWorktree),
    },
  };
  await fs.writeFile(patchFile, patchBody);
  try {
    await execFileAsync('git', ['apply', '--no-index', '--check', patchFile], gitOptions);
    const { stdout } = await execFileAsync(
      'git',
      ['apply', '--no-index', '--numstat', patchFile],
      gitOptions,
    );
    await execFileAsync('git', ['apply', '--no-index', patchFile], gitOptions);
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => safeTargetPath(worktreePath, line.split('\t').at(-1) ?? ''));
  } finally {
    await fs.rm(patchFile, { force: true });
  }
}

function safeTargetPath(worktreePath: string, targetPath: string): string {
  const root = path.resolve(worktreePath);
  const target = path.resolve(root, targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Artifact target escapes worktree: ${targetPath}`);
  }
  if (target === root) throw new Error('Artifact target_path must name a file');
  return path.join(worktreePath, path.relative(root, target));
}

/**
 * Factory function to create a WorktreeMaterializer with default base path.
 *
 * @param baseWorktreePath - defaults to '.newide/worktrees'
 */
export function createWorktreeMaterializer(
  baseWorktreePath = '.newide/worktrees',
): WorktreeMaterializer {
  return new WorktreeMaterializer({ baseWorktreePath });
}
