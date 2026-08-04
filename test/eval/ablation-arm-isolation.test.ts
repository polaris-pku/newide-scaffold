import { describe, expect, it } from 'vitest';
import {
  buildAblationSchemaName,
  waitForRunMaintenance,
  withSearchPath,
} from '../../scripts/ablation-arm-isolation';

describe('ablation arm isolation', () => {
  it('derives a stable, arm-specific PostgreSQL schema', () => {
    const root = 'D:\\experiments\\2026-08-03T06-39-48-333Z';

    expect(buildAblationSchemaName(root, 'B0')).toBe(
      'eval_2026_08_03t06_39_48_333z_b0',
    );
    expect(buildAblationSchemaName(root, 'B1')).toBe(
      'eval_2026_08_03t06_39_48_333z_b1',
    );
  });

  it('sets an isolated search_path while preserving connection parameters', () => {
    const result = new URL(
      withSearchPath(
        'postgresql://newide:secret@127.0.0.1:55432/newide_b0?sslmode=disable',
        'eval_run_b0',
      ),
    );

    expect(result.searchParams.get('sslmode')).toBe('disable');
    expect(result.searchParams.get('options')).toBe(
      '-csearch_path=eval_run_b0,public',
    );
  });

  it('rejects unsafe schema names', () => {
    expect(() =>
      withSearchPath('postgresql://localhost/newide_b0', 'eval_run;drop schema public'),
    ).toThrow('Invalid PostgreSQL schema name');
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
