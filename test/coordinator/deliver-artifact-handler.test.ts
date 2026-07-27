import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import { DeliverArtifactHandler } from '../../src/coordinator/handlers/deliver-artifact-handler';
import type { ChangesetManifest } from '../../src/coordinator/changeset-manifest';

describe('DeliverArtifactHandler', () => {
  const created = new Set<string>();

  afterEach(async () => {
    await Promise.all([...created].map((entry) => fs.rm(entry, { recursive: true, force: true })));
    created.clear();
  });

  it('writes the exact final artifact and verifies its workspace SHA256', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-delivery-'));
    created.add(workspace);
    const body = Buffer.from('export const finalValue = 42;\n');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const handler = new DeliverArtifactHandler();

    const changeset = manifest(workspace, artifact(body), sha256);
    const result = await handler.execute({ manifest: changeset });

    expect(result).toMatchObject({
      manifest_id: 'changeset_final',
      idempotency_key: 'deliver:changeset_final',
      workspace_path: workspace,
      artifact_ref: 'artifact_final',
      relative_path: 'src/final.ts',
      file_path: path.join(workspace, 'src/final.ts'),
      sha256,
      bytes_written: body.byteLength,
      files: [
        {
          artifact_ref: 'artifact_final',
          relative_path: 'src/final.ts',
          file_path: path.join(workspace, 'src/final.ts'),
          sha256,
          bytes_written: body.byteLength,
        },
      ],
    });
    await expect(fs.readFile(result.file_path)).resolves.toEqual(body);
    await expect(fs.readFile(changeset.paths.delivery_receipt_path, 'utf-8')).resolves.toContain(
      'changeset_final',
    );
  });

  it('rejects a hash mismatch before completing delivery', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-delivery-mismatch-'));
    created.add(workspace);
    const handler = new DeliverArtifactHandler();

    await expect(
      handler.execute({
        manifest: manifest(workspace, artifact(Buffer.from('actual')), '0'.repeat(64)),
      }),
    ).rejects.toThrow('Changeset entry changeset_entry_final SHA256 mismatch');
    await expect(fs.stat(path.join(workspace, 'src/final.ts'))).rejects.toThrow();
  });

  it('rejects an artifact target that escapes the user workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-delivery-escape-'));
    created.add(workspace);
    const body = Buffer.from('blocked');
    const escaping = artifact(body);
    escaping.content = { ...escaping.content!, target_path: '../outside.txt' };

    await expect(
      new DeliverArtifactHandler().execute({
        manifest: manifest(
          workspace,
          escaping,
          createHash('sha256').update(body).digest('hex'),
        ),
      }),
    ).rejects.toThrow('Artifact target escapes workspace');
  });

  it('returns the same durable receipt for the same manifest idempotency key', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-delivery-replay-'));
    created.add(workspace);
    const body = Buffer.from('stable delivery');
    const changeset = manifest(
      workspace,
      artifact(body),
      createHash('sha256').update(body).digest('hex'),
    );
    const handler = new DeliverArtifactHandler();

    const first = await handler.execute({ manifest: changeset });
    const second = await handler.execute({ manifest: changeset });

    expect(second).toEqual(first);
  });
});

function artifact(body: Buffer): ArtifactRef {
  return {
    artifact_id: 'artifact_final',
    type: 'diff',
    uri: 'artifact://diff/artifact_final',
    producer_id: 'synthesizer',
    task_id: 'task_final',
    content: {
      kind: 'text',
      content_ref: `data:text/plain;base64,${body.toString('base64')}`,
      target_path: 'src/final.ts',
      media_type: 'text/typescript',
    },
    created_at: '2026-07-18T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function manifest(
  workspacePath: string,
  finalArtifact: ArtifactRef,
  expectedSha256: string,
): ChangesetManifest {
  return {
    manifest_id: 'changeset_final',
    run_id: 'run_final',
    task_id: 'task_final',
    mode: 'council',
    base: { kind: 'workspace_snapshot', ref: 'workspace-before-run:run_final' },
    paths: {
      task_worktree_path: path.join(workspacePath, '.newide', 'worktree'),
      manifest_path: path.join(workspacePath, '.newide', 'changeset-manifest.json'),
      delivery_receipt_path: path.join(workspacePath, '.newide', 'delivery.json'),
      user_workspace_path: workspacePath,
    },
    entries: [
      {
        entry_id: 'changeset_entry_final',
        artifact_id: finalArtifact.artifact_id,
        artifact_ref: finalArtifact,
        relative_paths: [finalArtifact.content!.target_path!],
        sha256: expectedSha256,
        producer_agent_id: finalArtifact.producer_id,
        gate_result_refs: ['gate_result_final'],
        delivery_strategy: 'copy_file',
      },
    ],
    gate_result_refs: ['gate_result_final'],
    created_at: '2026-07-18T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
