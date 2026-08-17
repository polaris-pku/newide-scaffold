import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCouncilParticipantId } from '../../src/council/council-participant';
import {
  councilRunDirName,
  councilRunWorkspaceRoot,
} from '../../src/council/council-workspace';

describe('council workspace path shortening', () => {
  it('keeps participant and run folders short enough for deep experiment roots', () => {
    const runId = 'run_31807b90-9c36-4fbb-98f8-290612127a01';
    // Synthetic deep root (no machine-specific absolute prefix).
    const experimentRoot = path.join(
      'workspace',
      'project',
      '.newide-experiments',
      'sweevo-ablation',
      '2026-08-04T03-26-17-818Z-requests3-council',
      'B0',
      'state',
      'council',
    );
    const participantId = createCouncilParticipantId(
      runId,
      'proposer',
      0,
      'role_ts_engineer',
    );
    const worktreeRoot = path.join(
      councilRunWorkspaceRoot(experimentRoot, runId),
      participantId,
    );
    const nested = path.join(
      worktreeRoot,
      'requests',
      'packages',
      'urllib3',
      'packages',
      'ssl_match_hostname',
      '_implementation.py',
    );

    expect(participantId).toMatch(/^cp_p0_[0-9a-f]{8}$/);
    expect(councilRunDirName(runId)).toHaveLength(12);
    expect(councilRunDirName(runId)).toBe(
      createHash('sha256').update(runId).digest('hex').slice(0, 12),
    );
    expect(worktreeRoot.length).toBeLessThan(180);
    expect(nested.length).toBeLessThan(260);
  });
});
