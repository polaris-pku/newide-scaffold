import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import { buildChangesetManifest } from '../../src/coordinator/changeset-manifest';
import type { GateResult } from '../../src/gate';

const tempDirs: string[] = [];

describe('buildChangesetManifest', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('distinguishes observed user workspace files from selected artifact content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-changeset-'));
    tempDirs.push(root);
    const workspace = path.join(root, 'workspace');
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await writeFile(path.join(workspace, 'src', 'existing.ts'), 'export const existing = true;\n');
    const selected = artifact('artifact_new', 'src/new.ts', 'export const added = true;\n');

    const manifest = await buildChangesetManifest({
      run_id: 'run_changeset',
      task_id: 'task_changeset',
      mode: 'council',
      base_ref: 'workspace-before-run:run_changeset',
      selected_artifacts: [selected],
      gate_results: [allowGate()],
      producer_agent_id: 'role_ts_engineer',
      task_worktree_path: path.join(root, 'worktree'),
      manifest_path: path.join(root, 'run', 'changeset-manifest.json'),
      delivery_receipt_path: path.join(root, 'run', 'delivery.json'),
      user_workspace_path: workspace,
      council_workspace_path: path.join(root, 'council'),
      observed_changed_files: ['src/existing.ts'],
    });

    expect(manifest).toMatchObject({
      manifest_id: expect.stringMatching(/^changeset_[a-f0-9]{24}$/),
      base: { kind: 'workspace_snapshot', ref: 'workspace-before-run:run_changeset' },
      paths: {
        task_worktree_path: path.join(root, 'worktree'),
        user_workspace_path: workspace,
        council_workspace_path: path.join(root, 'council'),
      },
      gate_result_refs: ['gate_result_allow'],
    });
    expect(manifest.entries).toEqual([
      expect.objectContaining({
        artifact_id: 'artifact_new',
        relative_paths: ['src/new.ts'],
        producer_agent_id: 'role_council_synthesizer',
        delivery_strategy: 'copy_file',
      }),
      expect.objectContaining({
        relative_paths: ['src/existing.ts'],
        producer_agent_id: 'role_ts_engineer',
        delivery_strategy: 'already_in_workspace',
      }),
    ]);
  });

  it('rejects a Council expected hash mismatch before delivery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-changeset-hash-'));
    tempDirs.push(root);
    const selected = artifact('artifact_hash', 'result.ts', 'actual');

    await expect(
      buildChangesetManifest({
        run_id: 'run_hash',
        task_id: 'task_hash',
        mode: 'council',
        base_ref: 'workspace-before-run:run_hash',
        selected_artifacts: [selected],
        gate_results: [allowGate()],
        producer_agent_id: 'role_ts_engineer',
        task_worktree_path: path.join(root, 'worktree'),
        manifest_path: path.join(root, 'run', 'changeset-manifest.json'),
        delivery_receipt_path: path.join(root, 'run', 'delivery.json'),
        expected_artifact_hashes: { artifact_hash: '0'.repeat(64) },
      }),
    ).rejects.toThrow('Artifact artifact_hash SHA256 mismatch');
  });

  it('rejects artifact paths that escape the delivery roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-changeset-escape-'));
    tempDirs.push(root);

    await expect(
      buildChangesetManifest({
        run_id: 'run_escape',
        task_id: 'task_escape',
        mode: 'single_agent',
        base_ref: 'workspace-before-run:run_escape',
        selected_artifacts: [artifact('artifact_escape', '../outside.ts', 'blocked')],
        gate_results: [allowGate()],
        producer_agent_id: 'role_ts_engineer',
        task_worktree_path: path.join(root, 'worktree'),
        manifest_path: path.join(root, 'run', 'changeset-manifest.json'),
        delivery_receipt_path: path.join(root, 'run', 'delivery.json'),
      }),
    ).rejects.toThrow('Changeset path escapes workspace');
  });
});

function artifact(id: string, targetPath: string, body: string): ArtifactRef {
  return {
    artifact_id: id,
    type: 'diff',
    uri: `artifact://diff/${id}`,
    producer_id: 'role_council_synthesizer',
    task_id: 'task_changeset',
    content: {
      kind: 'text',
      content_ref: `data:text/plain,${encodeURIComponent(body)}`,
      target_path: targetPath,
    },
    created_at: '2026-07-28T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function allowGate(): GateResult {
  return {
    gate_result_id: 'gate_result_allow',
    gate_id: 'production-command',
    gate_point: 'task.completed',
    request_id: 'gate_request_allow',
    decision: 'allow',
    reason: 'verified',
    required_actions: [],
    audit_ref: 'file:///gate-audit.json',
    created_at: '2026-07-28T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
