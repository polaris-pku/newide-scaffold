import { describe, expect, it } from 'vitest';
import { isDeliverableWorkspacePath } from '../../src/coordinator/workspace-change-detector';

describe('isDeliverableWorkspacePath', () => {
  it('keeps source files and rejects generated Python caches', () => {
    expect(isDeliverableWorkspacePath('src/solver.py')).toBe(true);
    expect(isDeliverableWorkspacePath('src/__pycache__/solver.cpython-312.pyc')).toBe(false);
    expect(isDeliverableWorkspacePath('src\\__pycache__\\solver.pyc')).toBe(false);
    expect(isDeliverableWorkspacePath('.pytest_cache/v/cache/nodeids')).toBe(false);
    expect(isDeliverableWorkspacePath('src/typecheck.pyi')).toBe(true);
  });
});
