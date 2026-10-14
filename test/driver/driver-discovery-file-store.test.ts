/**
 * 自动发现 profile 与 discovery state 持久化的测试。
 *
 * 重点钉住三件事：
 * - **只存能重建的最小 profile**：多一个键就判损坏——自动文件不该成为启动参数、环境变量或
 *   凭据的藏身地（用户想固定那些，应该写 `drivers.yaml`）；
 * - **坏文件不阻塞启动**：YAML/JSON 读不出来只降级为「没有历史发现结果」，并且错误信息里
 *   没有绝对路径（它会被前端间接看到）；
 * - **写入是原子且互斥的**：两个 backend 同时刷新不该写出半截文件。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DETECTED_DRIVER_PROFILES_FILE_NAME,
  DETECTED_DRIVER_PROFILES_VERSION,
  DriverDiscoveryFileError,
  DriverDiscoveryFileStore,
  driverDiscoveryStatePath,
  parseDetectedDriverProfiles,
  serializeDetectedDriverProfiles,
} from '../../src/driver/driver-discovery-file-store';
import { DRIVER_DISCOVERY_LOCK_BUSY, DRIVER_DISCOVERY_SCHEMA_VERSION } from '../../src/driver/driver-discovery-catalog';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeStore(
  overrides: { lock?: { timeoutMs?: number; retryMs?: number; staleMs?: number } } = {},
) {
  const projectRoot = makeTempDir('newide-driver-discovery-project-');
  const stateRoot = makeTempDir('newide-driver-discovery-state-');
  return {
    projectRoot,
    stateRoot,
    store: new DriverDiscoveryFileStore({
      projectRoot,
      stateRoot,
      ...(overrides.lock ? { lock: overrides.lock } : {}),
    }),
  };
}

const SNAPSHOT = {
  schema_version: DRIVER_DISCOVERY_SCHEMA_VERSION,
  generated_at: '2026-10-14T00:00:00.000Z',
  probe_status: 'ready' as const,
  drivers: [
    {
      driver_id: 'discovered:gemini-8a12f40e',
      agent_id: 'gemini',
      display_name: 'Gemini CLI',
      connection_type: 'acp' as const,
      provenance: 'npx-on-demand',
      probed_at: '2026-10-14T00:00:00.000Z',
      source: 'discovered' as const,
      status: 'ready' as const,
      runtime_registered: true,
    },
  ],
};

describe('auto-discovered profile file', () => {
  it('treats a missing file as "no history"', () => {
    const { store } = makeStore();

    expect(store.exists()).toBe(false);
    expect(store.readProfilesSafely()).toEqual({
      profiles: { version: DETECTED_DRIVER_PROFILES_VERSION, drivers: {} },
    });
  });

  it('round-trips the minimal profile and leaves no temp file behind', () => {
    const { projectRoot, store } = makeStore();
    store.writeProfiles({
      version: DETECTED_DRIVER_PROFILES_VERSION,
      drivers: { 'discovered:gemini-8a12f40e': { agent: 'gemini', description: 'Gemini CLI' } },
    });

    expect(store.readProfilesSafely().profiles.drivers).toEqual({
      'discovered:gemini-8a12f40e': { agent: 'gemini', description: 'Gemini CLI' },
    });
    const agentDir = join(projectRoot, '.agent');
    expect(readdirSync(agentDir)).toEqual([DETECTED_DRIVER_PROFILES_FILE_NAME]);
    expect(readFileSync(join(agentDir, DETECTED_DRIVER_PROFILES_FILE_NAME), 'utf-8')).toContain(
      '请勿手工编辑',
    );
  });

  it('degrades to "no auto profiles" when the YAML is broken', () => {
    const { projectRoot, store } = makeStore();
    mkdirSync(join(projectRoot, '.agent'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agent', DETECTED_DRIVER_PROFILES_FILE_NAME),
      'drivers: [unclosed\n',
      'utf-8',
    );

    const read = store.readProfilesSafely();

    expect(read.profiles.drivers).toEqual({});
    expect(read.error).toContain(DETECTED_DRIVER_PROFILES_FILE_NAME);
  });

  it('rejects a profile that carries more than agent and description', () => {
    // 自动文件是机器生成的：运行参数、环境变量、凭据声明的归属地是 drivers.yaml。
    expect(() =>
      parseDetectedDriverProfiles(
        [
          'version: 1',
          'drivers:',
          '  discovered:x-12345678:',
          '    agent: x',
          '    runtime:',
          '      runner_dir: /opt/acp',
          '',
        ].join('\n'),
        '/tmp/drivers.detected.local.yaml',
      ),
    ).toThrow(DriverDiscoveryFileError);

    expect(() =>
      parseDetectedDriverProfiles(
        'version: 1\ndrivers:\n  a:\n    agent: x\nroles:\n  reviewer: a\n',
        '/tmp/drivers.detected.local.yaml',
      ),
    ).toThrow(/unexpected shape/);
  });

  it('sorts drivers so the file diff stays stable', () => {
    const content = serializeDetectedDriverProfiles({
      version: DETECTED_DRIVER_PROFILES_VERSION,
      drivers: {
        'discovered:z-11111111': { agent: 'z' },
        'discovered:a-22222222': { agent: 'a' },
      },
    });

    expect(content.indexOf('discovered:a-22222222')).toBeLessThan(
      content.indexOf('discovered:z-11111111'),
    );
  });
});

describe('discovery state file', () => {
  it('writes only non-sensitive evidence', () => {
    const { stateRoot, store } = makeStore();
    store.writeState(SNAPSHOT);

    const raw = readFileSync(driverDiscoveryStatePath(stateRoot), 'utf-8');
    expect(store.readStateSafely().state).toEqual(SNAPSHOT);
    // 证据里不该出现启动命令、参数、凭据值与绝对路径
    expect(raw).not.toContain('launch');
    expect(raw).not.toContain('command');
    expect(raw).not.toContain('sk-');
    expect(raw).not.toContain(stateRoot);
    expect(raw).not.toContain(process.cwd());
  });

  it('degrades when the state file is corrupt', () => {
    const { stateRoot, store } = makeStore();
    writeFileSync(driverDiscoveryStatePath(stateRoot), '{ not json', 'utf-8');

    const read = store.readStateSafely();

    expect(read.state).toBeUndefined();
    expect(read.error).toContain('driver-discovery.json');
    expect(read.error).not.toContain(stateRoot);
  });
});

describe('cross-process write lock', () => {
  it('reports a stable, path-free error when another writer holds the lock', async () => {
    const { projectRoot, stateRoot, store } = makeStore();
    const holder = await store.acquireLock();
    const blocked = new DriverDiscoveryFileStore({
      projectRoot,
      stateRoot,
      lock: { timeoutMs: 0 },
    });

    try {
      await expect(blocked.acquireLock()).rejects.toMatchObject({
        name: 'DriverDiscoveryFileError',
        reason: 'lock_busy',
        reason_code: DRIVER_DISCOVERY_LOCK_BUSY,
      });
    } finally {
      holder.release();
    }
  });

  it('releases the lock so the next writer can take it', async () => {
    const { store } = makeStore();
    const first = await store.acquireLock();
    first.release();

    const second = await store.acquireLock();
    second.release();

    expect(existsSync(store.lockPath)).toBe(false);
  });
});
