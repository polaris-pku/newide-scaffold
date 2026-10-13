import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcpDriverProbeService,
  DriverProbeUnavailableError,
} from '../../src/driver/driver-probe-service';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('AcpDriverProbeService', () => {
  it('executes ACP probe and preserves its evidence shape', async () => {
    const runnerDir = mkdtempSync(path.join(tmpdir(), 'newide-acp-probe-'));
    tempDirs.push(runnerDir);
    const moduleDir = path.join(runnerDir, 'dist', 'src', 'driver-adapter');
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      path.join(moduleDir, 'probe.js'),
      `export async function probeAgents(opts) {
        return [{ agentId: opts.force ? 'forced' : 'claude', displayName: 'Claude Code',
          launch: { command: 'node', args: [] }, provenance: 'local-entry', connectionType: 'acp',
          initialize: { protocolVersion: 1, authMethods: 0 }, probedAt: '2026-10-13T00:00:00.000Z' }];
      }
      export async function probeAgent(id) { return id === 'missing' ? null : (await probeAgents({}))[0]; }`,
    );

    const service = new AcpDriverProbeService({ runnerDir });
    await expect(service.probe({ force: true })).resolves.toMatchObject({
      schema_version: 'driver-probe.v1',
      drivers: [{ agentId: 'forced', provenance: 'local-entry' }],
    });
  });

  it('reports a clear unavailable error when ACP has no probe module', async () => {
    const runnerDir = mkdtempSync(path.join(tmpdir(), 'newide-acp-probe-'));
    tempDirs.push(runnerDir);
    const service = new AcpDriverProbeService({ runnerDir });
    await expect(service.probe()).rejects.toBeInstanceOf(DriverProbeUnavailableError);
  });
});
