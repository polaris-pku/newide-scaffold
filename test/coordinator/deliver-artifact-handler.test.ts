import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import { DeliverArtifactHandler } from '../../src/coordinator/handlers/deliver-artifact-handler';

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

    const result = await handler.execute({
      workspace_path: workspace,
      final_artifact: artifact(body),
      expected_sha256: sha256,
    });

    expect(result).toEqual({
      artifact_ref: 'artifact_final',
      relative_path: 'src/final.ts',
      file_path: path.join(workspace, 'src/final.ts'),
      sha256,
      bytes_written: body.byteLength,
    });
    await expect(fs.readFile(result.file_path)).resolves.toEqual(body);
  });

  it('rejects a hash mismatch before completing delivery', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-delivery-mismatch-'));
    created.add(workspace);
    const handler = new DeliverArtifactHandler();

    await expect(
      handler.execute({
        workspace_path: workspace,
        final_artifact: artifact(Buffer.from('actual')),
        expected_sha256: '0'.repeat(64),
      }),
    ).rejects.toThrow('Council final artifact SHA256 mismatch');
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
        workspace_path: workspace,
        final_artifact: escaping,
        expected_sha256: createHash('sha256').update(body).digest('hex'),
      }),
    ).rejects.toThrow('Artifact target escapes workspace');
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
