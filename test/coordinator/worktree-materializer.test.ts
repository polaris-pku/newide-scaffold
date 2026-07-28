import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  WorktreeMaterializer,
  createWorktreeMaterializer,
  type MaterializationInput,
} from '../../src/coordinator/worktree-materializer';
import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from '../../src/core';

describe('WorktreeMaterializer', () => {
  // Use .newide/test-worktrees for test results (similar to .claude/ directory)
  const testBaseDir = '.newide/test-worktrees';
  let materializer: WorktreeMaterializer;

  beforeEach(() => {
    materializer = new WorktreeMaterializer({ baseWorktreePath: testBaseDir });
  });

  afterEach(async () => {
    // Clean up test directories
    try {
      await fs.rm(testBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore if directory doesn't exist
    }
  });

  const createMockArtifact = (type: 'patch' | 'diff' | 'transcript' = 'patch'): ArtifactRef => ({
    artifact_id: createId('artifact'),
    type,
    uri: `artifact://${type}/test`,
    producer_id: 'test-producer',
    task_id: 'task-1',
    metadata: { content: `mock ${type} content` },
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  });

  describe('materialize', () => {
    it('writes inline text content to its target path', async () => {
      const artifact: ArtifactRef = {
        ...createMockArtifact('patch'),
        content: {
          kind: 'text',
          content_ref: 'data:text/plain,hello%20newIDE',
          target_path: 'output/hello.txt',
          media_type: 'text/plain',
        },
      };

      const result = await materializer.materialize({ task_id: 'task-1', artifacts: [artifact] });

      const target = path.join(testBaseDir, 'task-1', 'output/hello.txt');
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe('hello newIDE');
      expect(result).toMatchObject({
        status: 'completed',
        changed_files: [target],
        failures: [],
      });
    });

    it('copies file content into a safe target path', async () => {
      const source = path.join(testBaseDir, 'source.txt');
      await fs.mkdir(testBaseDir, { recursive: true });
      await fs.writeFile(source, 'copied content', 'utf-8');
      const artifact: ArtifactRef = {
        ...createMockArtifact('diff'),
        content: {
          kind: 'file',
          content_ref: source,
          target_path: 'copied/result.txt',
        },
      };

      const result = await materializer.materialize({ task_id: 'task-1', artifacts: [artifact] });

      const target = path.join(testBaseDir, 'task-1', 'copied/result.txt');
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe('copied content');
      expect(result.changed_files).toEqual([target]);
    });

    it('does not report metadata records as user file changes', async () => {
      const artifact: ArtifactRef = {
        ...createMockArtifact('patch'),
        content: {
          kind: 'metadata',
          content_ref: 'metadata://inline',
          target_path: 'records/result.json',
          media_type: 'application/json',
        },
      };

      const result = await materializer.materialize({ task_id: 'task-1', artifacts: [artifact] });

      expect(result.status).toBe('completed');
      expect(result.files_written).toHaveLength(1);
      expect(result.changed_files).toEqual([]);
    });

    it('applies a patch artifact inside the task worktree', async () => {
      const patch = [
        'diff --git a/hello.txt b/hello.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/hello.txt',
        '@@ -0,0 +1 @@',
        '+hello from patch',
        '',
      ].join('\n');
      const artifact: ArtifactRef = {
        ...createMockArtifact('patch'),
        content: {
          kind: 'patch',
          content_ref: `data:text/x-diff,${encodeURIComponent(patch)}`,
          media_type: 'text/x-diff',
        },
      };

      const result = await materializer.materialize({ task_id: 'task-1', artifacts: [artifact] });

      const target = path.join(testBaseDir, 'task-1', 'hello.txt');
      expect(result.status).toBe('completed');
      expect(result.failures).toEqual([]);
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe('hello from patch\n');
      expect(result.changed_files).toContain(target);
    });

    it('rejects target paths outside the task worktree', async () => {
      const artifact: ArtifactRef = {
        ...createMockArtifact('patch'),
        content: {
          kind: 'text',
          content_ref: 'data:text/plain,blocked',
          target_path: '../outside.txt',
        },
      };

      const result = await materializer.materialize({ task_id: 'task-1', artifacts: [artifact] });

      expect(result).toMatchObject({
        status: 'failed',
        changed_files: [],
        failures: [{ artifact_id: artifact.artifact_id }],
      });
      await expect(fs.stat(path.join(testBaseDir, 'outside.txt'))).rejects.toThrow();
    });

    it('reports partial materialization when one artifact fails', async () => {
      const valid: ArtifactRef = {
        ...createMockArtifact('patch'),
        content: {
          kind: 'text',
          content_ref: 'data:text/plain,valid',
          target_path: 'valid.txt',
        },
      };
      const invalid: ArtifactRef = {
        ...createMockArtifact('patch'),
        content: {
          kind: 'text',
          content_ref: 'data:text/plain,invalid',
          target_path: '../invalid.txt',
        },
      };

      const result = await materializer.materialize({
        task_id: 'task-1',
        artifacts: [valid, invalid],
      });

      expect(result.status).toBe('partial');
      expect(result.materialized_artifacts).toEqual([valid]);
      expect(result.failures).toEqual([
        expect.objectContaining({ artifact_id: invalid.artifact_id }),
      ]);
    });

    it('should create worktree directory', async () => {
      const input: MaterializationInput = {
        task_id: 'task-1',
        artifacts: [createMockArtifact('patch')],
      };

      const result = await materializer.materialize(input);

      expect(result.worktree_path).toBe(path.join(testBaseDir, 'task-1'));

      // Verify directory exists
      const stat = await fs.stat(result.worktree_path);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should write patch artifacts to worktree', async () => {
      const artifact = createMockArtifact('patch');
      const input: MaterializationInput = {
        task_id: 'task-1',
        artifacts: [artifact],
      };

      const result = await materializer.materialize(input);

      expect(result.files_written).toHaveLength(1);
      expect(result.files_written[0]).toContain(artifact.artifact_id);

      // Verify file exists and contains artifact data
      const fileContent = await fs.readFile(result.files_written[0]!, 'utf-8');
      const parsed = JSON.parse(fileContent);
      expect(parsed.artifact_id).toBe(artifact.artifact_id);
      expect(parsed.type).toBe('patch');
    });

    it('should write diff artifacts to worktree', async () => {
      const artifact = createMockArtifact('diff');
      const input: MaterializationInput = {
        task_id: 'task-1',
        artifacts: [artifact],
      };

      const result = await materializer.materialize(input);

      expect(result.files_written).toHaveLength(1);
      expect(result.materialized_artifacts).toHaveLength(1);
    });

    it('should not write transcript artifacts (v0 limitation)', async () => {
      const artifact = createMockArtifact('transcript');
      const input: MaterializationInput = {
        task_id: 'task-1',
        artifacts: [artifact],
      };

      const result = await materializer.materialize(input);

      expect(result.files_written).toHaveLength(0);
      expect(result.materialized_artifacts).toHaveLength(1); // Still tracked, just not written
    });

    it('should write multiple artifacts', async () => {
      const artifacts = [
        createMockArtifact('patch'),
        createMockArtifact('diff'),
        createMockArtifact('patch'),
      ];
      const input: MaterializationInput = {
        task_id: 'task-1',
        artifacts,
      };

      const result = await materializer.materialize(input);

      expect(result.files_written).toHaveLength(3);
      expect(result.materialized_artifacts).toHaveLength(3);
    });

    it('should return MaterializationResult with correct structure', async () => {
      const input: MaterializationInput = {
        task_id: 'task-1',
        artifacts: [createMockArtifact('patch')],
      };

      const result = await materializer.materialize(input);

      expect(result.materialization_id).toMatch(/^materialization_/);
      expect(result.task_id).toBe('task-1');
      expect(result.worktree_path).toBeDefined();
      expect(result.materialized_artifacts).toHaveLength(1);
      expect(result.files_written).toHaveLength(1);
      expect(result.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.schema_version).toBe(SCHEMA_VERSION);
    });

    it('should handle empty artifacts list', async () => {
      const input: MaterializationInput = {
        task_id: 'task-1',
        artifacts: [],
      };

      const result = await materializer.materialize(input);

      expect(result.files_written).toHaveLength(0);
      expect(result.materialized_artifacts).toHaveLength(0);

      // Directory should still be created
      const stat = await fs.stat(result.worktree_path);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should handle multiple materializations for different tasks', async () => {
      const input1: MaterializationInput = {
        task_id: 'task-1',
        artifacts: [createMockArtifact('patch')],
      };

      const input2: MaterializationInput = {
        task_id: 'task-2',
        artifacts: [createMockArtifact('diff')],
      };

      const result1 = await materializer.materialize(input1);
      const result2 = await materializer.materialize(input2);

      expect(result1.worktree_path).not.toBe(result2.worktree_path);
      expect(result1.files_written).toHaveLength(1);
      expect(result2.files_written).toHaveLength(1);

      // Both directories should exist
      const stat1 = await fs.stat(result1.worktree_path);
      const stat2 = await fs.stat(result2.worktree_path);
      expect(stat1.isDirectory()).toBe(true);
      expect(stat2.isDirectory()).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should remove worktree directory', async () => {
      const input: MaterializationInput = {
        task_id: 'task-1',
        artifacts: [createMockArtifact('patch')],
      };

      const result = await materializer.materialize(input);

      // Verify directory exists
      const stat = await fs.stat(result.worktree_path);
      expect(stat.isDirectory()).toBe(true);

      // Cleanup
      await materializer.cleanup('task-1');

      // Verify directory is gone
      await expect(fs.stat(result.worktree_path)).rejects.toThrow();
    });

    it('should not throw when cleaning up non-existent directory', async () => {
      await expect(materializer.cleanup('non-existent-task')).resolves.not.toThrow();
    });
  });

  describe('factory function', () => {
    it('should create materializer with default base path', () => {
      const m = createWorktreeMaterializer();
      expect(m).toBeInstanceOf(WorktreeMaterializer);
    });

    it('should create materializer with custom base path', () => {
      const m = createWorktreeMaterializer('/custom/path');
      expect(m).toBeInstanceOf(WorktreeMaterializer);
    });
  });

  describe('worktree path structure', () => {
    it('should use task_id as worktree subdirectory', async () => {
      const input: MaterializationInput = {
        task_id: 'task-abc-123',
        artifacts: [createMockArtifact('patch')],
      };

      const result = await materializer.materialize(input);

      expect(result.worktree_path).toBe(path.join(testBaseDir, 'task-abc-123'));
    });

    it('should write artifacts as <artifact_id>.json files', async () => {
      const artifact = createMockArtifact('patch');
      const input: MaterializationInput = {
        task_id: 'task-1',
        artifacts: [artifact],
      };

      const result = await materializer.materialize(input);

      expect(result.files_written[0]).toBe(
        path.join(testBaseDir, 'task-1', `${artifact.artifact_id}.json`),
      );
    });
  });
});
