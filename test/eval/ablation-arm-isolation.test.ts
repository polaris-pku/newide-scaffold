import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareAblationArmIsolation,
  waitForRunMaintenance,
} from '../../scripts/ablation-arm-isolation';

describe('ablation arm isolation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.NEWIDE_ABLATION_ALLOW_EXISTING_MEMORY;
    delete process.env.NEWIDE_ABLATION_ALLOW_EXISTING_SCHEMA;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function experimentRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ablation-arm-'));
    tempDirs.push(dir);
    return dir;
  }

  it('gives every arm its own PGlite data directory and state root', async () => {
    const root = experimentRoot();

    const b0 = await prepareAblationArmIsolation({ experiment_root: root, arm: 'B0' });
    const b4 = await prepareAblationArmIsolation({ experiment_root: root, arm: 'B4' });

    expect(b0).toEqual({
      pglite_data_dir: join(root, 'B0', 'pglite'),
      state_root: join(root, 'B0', 'state'),
    });
    expect(b4.pglite_data_dir).not.toBe(b0.pglite_data_dir);
  });

  it('refuses to reuse an arm that already has memory', async () => {
    const root = experimentRoot();
    await prepareAblationArmIsolation({ experiment_root: root, arm: 'B0' });

    await expect(
      prepareAblationArmIsolation({ experiment_root: root, arm: 'B0' }),
    ).rejects.toThrow(/already has memory/);
  });

  it('resumes an existing arm only when the escape hatch is set', async () => {
    const root = experimentRoot();
    await prepareAblationArmIsolation({ experiment_root: root, arm: 'B0' });

    process.env.NEWIDE_ABLATION_ALLOW_EXISTING_MEMORY = '1';
    await expect(
      prepareAblationArmIsolation({ experiment_root: root, arm: 'B0' }),
    ).resolves.toMatchObject({ pglite_data_dir: join(root, 'B0', 'pglite') });

    // 旧名来自 Postgres-schema 时代，仍然被接受。
    delete process.env.NEWIDE_ABLATION_ALLOW_EXISTING_MEMORY;
    process.env.NEWIDE_ABLATION_ALLOW_EXISTING_SCHEMA = 'true';
    await expect(
      prepareAblationArmIsolation({ experiment_root: root, arm: 'B0' }),
    ).resolves.toMatchObject({ state_root: join(root, 'B0', 'state') });
  });

  it('treats a pre-created arm directory without memory as unused', async () => {
    const root = experimentRoot();
    mkdirSync(join(root, 'B1', 'state'), { recursive: true });

    await expect(
      prepareAblationArmIsolation({ experiment_root: root, arm: 'B1' }),
    ).resolves.toEqual({
      pglite_data_dir: join(root, 'B1', 'pglite'),
      state_root: join(root, 'B1', 'state'),
    });
  });

  it('waits for terminal maintenance belonging to the requested run', async () => {
    const request = async <T>(): Promise<T> =>
      ({
        maintenance: [
          { run_id: 'run_other', maintenance_ref: 'other', status: 'completed' },
          { run_id: 'run_target', maintenance_ref: 'target', status: 'completed' },
        ],
      }) as T;

    await expect(waitForRunMaintenance(request, 'run_target', 1_000)).resolves.toEqual({
      maintenance_ref: 'target',
      run_id: 'run_target',
      status: 'completed',
    });
  });
});
