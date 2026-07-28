import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRunEvidenceStore } from '../../src/persistence/run-evidence-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('FileRunEvidenceStore', () => {
  it('writes and reads visible stage evidence with a URI and content hash', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-run-evidence-'));
    temporaryDirectories.push(root);
    const store = new FileRunEvidenceStore({ root });
    const evidence = {
      invocation_id: 'invocation_1',
      artifact_refs: ['artifact_1'],
      diagnostics: { attempts: 1 },
    };

    const reference = await store.writeStage({
      run_id: 'run_1',
      stage: 'execute_agent',
      evidence,
    });
    const stagePath = path.join(root, 'run_1', 'stages', 'execute_agent.json');
    const bytes = await readFile(stagePath);
    const expectedHash = createHash('sha256').update(bytes).digest('hex');

    expect(reference).toEqual({
      uri: pathToFileURL(stagePath).href,
      sha256: expectedHash,
    });
    expect(await store.readStage({ run_id: 'run_1', stage: 'execute_agent' })).toEqual({
      evidence,
      uri: pathToFileURL(stagePath).href,
      sha256: expectedHash,
    });
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(evidence);
  });

  it('returns undefined for an absent stage and leaves no temporary files after a write', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-run-evidence-'));
    temporaryDirectories.push(root);
    const store = new FileRunEvidenceStore({ root });

    await expect(
      store.readStage({ run_id: 'run_missing', stage: 'done' }),
    ).resolves.toBeUndefined();
    await store.writeStage({ run_id: 'run_2', stage: 'done', evidence: { status: 'completed' } });

    const entries = await readdir(path.join(root, 'run_2', 'stages'));
    expect(entries).toEqual(['done.json']);
  });

  it('keeps failure evidence separate from an already persisted stage result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-run-evidence-'));
    temporaryDirectories.push(root);
    const store = new FileRunEvidenceStore({ root });
    const result = { status: 'completed', artifact_ref: 'artifact_1' };
    const failure = { status: 'failed', code: 'invalid_contract' };

    await store.writeStage({ run_id: 'run_failure', stage: 'deliver', evidence: result });
    await store.writeFailure({ run_id: 'run_failure', stage: 'deliver', evidence: failure });

    await expect(store.readStage({ run_id: 'run_failure', stage: 'deliver' })).resolves.toMatchObject(
      { evidence: result },
    );
    await expect(
      store.readFailure({ run_id: 'run_failure', stage: 'deliver' }),
    ).resolves.toMatchObject({ evidence: failure });
    expect(await readdir(path.join(root, 'run_failure', 'stages'))).toEqual([
      'deliver.failure.json',
      'deliver.json',
    ]);
  });

  it('rejects path segments that could escape the run evidence root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-run-evidence-'));
    temporaryDirectories.push(root);
    const store = new FileRunEvidenceStore({ root });

    await expect(
      store.writeStage({ run_id: '../outside', stage: 'done', evidence: { status: 'failed' } }),
    ).rejects.toThrow(/run_id/i);
    await expect(
      store.readStage({ run_id: 'run_3', stage: '../outside' as 'done' }),
    ).rejects.toThrow(/stage/i);
    await expect(
      readFile(path.join(path.dirname(root), 'outside', 'stages', 'done.json')),
    ).rejects.toThrow();
  });
});
