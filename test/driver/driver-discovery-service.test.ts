/**
 * 自动发现编排的测试（探测 → 合并 → 落盘 → 注册）。
 *
 * 这里钉的是**失败分流**，它比成功路径更容易写错：
 * - 启动时探测失败要降级（后端必须起得来），显式刷新时探测失败要抛（前端才能提示重试）；
 * - 落盘失败在启动时只是告警（少几个 driver），在刷新时是错误（用户以为刷成功了）；
 * - runtime 注册失败不影响整轮成功：那只是某个 driver 不可选择；
 * - 并发刷新只探测一轮：连点两次不该让 ACP 起两批子进程。
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDriverDiscoveryRuntime,
  type DriverDiscoveryRegistryPort,
} from '../../src/driver/driver-discovery-service';
import { DriverProbeUnavailableError, type DriverProbeResult } from '../../src/driver/driver-probe-service';
import { DETECTED_DRIVER_PROFILES_FILE_NAME } from '../../src/driver/driver-discovery-file-store';

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

function probeResult(agentIds: readonly string[]): DriverProbeResult {
  return {
    schema_version: 'driver-probe.v1',
    generated_at: '2026-10-14T00:00:00.000Z',
    drivers: agentIds.map((agentId) => ({
      agentId,
      displayName: `${agentId} CLI`,
      launch: { command: 'npx', args: ['-y', agentId] },
      provenance: 'npx-on-demand',
      connectionType: 'acp',
      probedAt: '2026-10-14T00:00:00.000Z',
    })),
  };
}

function makeRuntime(options: {
  probe: (options?: unknown) => Promise<DriverProbeResult>;
  projectRoot?: string;
  stateRoot?: string;
  configuredProfiles?: readonly { driver_id: string; agent: string }[];
}) {
  const projectRoot = options.projectRoot ?? makeTempDir('newide-discovery-project-');
  const stateRoot = options.stateRoot ?? makeTempDir('newide-discovery-state-');
  const warnings: string[] = [];
  const runtime = createDriverDiscoveryRuntime({
    projectRoot,
    stateRoot,
    probe: { probe: options.probe as never },
    configuredProfiles: () => options.configuredProfiles ?? [],
    onWarning: (message) => warnings.push(message),
  });
  return { ...runtime, projectRoot, stateRoot, warnings };
}

/** 只满足发现服务需要的注册表桩。 */
function stubRegistry(
  outcomes: Record<string, { ok: true } | { ok: false; reason_code: string }> = {},
  alreadyRegistered: readonly string[] = [],
) {
  const registered = new Map<string, { agent: string }>(
    alreadyRegistered.map((driverId) => [driverId, { agent: driverId }]),
  );
  const failures = new Map<string, { reason_code: string; message: string }>();
  const registry: DriverDiscoveryRegistryPort & {
    registered: Map<string, { agent: string }>;
  } = {
    registered,
    registerDiscovered: (driverId, profile) => {
      const outcome = outcomes[driverId] ?? { ok: true };
      if (!outcome.ok) {
        const failure = { reason_code: outcome.reason_code, message: 'stub failure' };
        failures.set(driverId, failure);
        return { ok: false, ...failure };
      }
      registered.set(driverId, profile);
      failures.delete(driverId);
      return { ok: true, handle: { driver_id: driverId } as never };
    },
    hasRuntime: (driverId) => registered.has(driverId),
    failureOf: (driverId) => failures.get(driverId),
  };
  return registry;
}

describe('startup probe', () => {
  it('persists the auto profile and the discovery state', async () => {
    const { service, projectRoot, stateRoot } = makeRuntime({
      probe: async () => probeResult(['gemini']),
    });

    const snapshot = await service.startup();

    expect(snapshot.probe_status).toBe('ready');
    const driverId = snapshot.drivers[0]!.driver_id;
    expect(driverId.startsWith('discovered:gemini-')).toBe(true);
    expect(existsSync(join(projectRoot, '.agent', DETECTED_DRIVER_PROFILES_FILE_NAME))).toBe(true);
    expect(
      service.catalog().discoveredProfiles()[driverId],
    ).toEqual({ agent: 'gemini', description: 'gemini CLI' });
    expect(existsSync(join(stateRoot, 'driver-discovery.json'))).toBe(true);
  });

  it('does not block startup when the probe is unavailable', async () => {
    const { service, projectRoot, warnings } = makeRuntime({
      probe: async () => {
        throw new DriverProbeUnavailableError('probe module missing');
      },
    });

    const snapshot = await service.startup();

    expect(snapshot.probe_status).toBe('unavailable');
    expect(snapshot.drivers).toEqual([]);
    // 什么都没发现时不在别人的检出里留下一个空文件
    expect(existsSync(join(projectRoot, '.agent', DETECTED_DRIVER_PROFILES_FILE_NAME))).toBe(false);
    expect(warnings.join('\n')).toContain('DRIVER_DISCOVERY_PROBE_UNAVAILABLE');
  });

  it('warns instead of throwing when the results cannot be persisted', async () => {
    const { service, projectRoot, warnings } = makeRuntime({
      probe: async () => probeResult(['gemini']),
    });
    // 让 `.agent` 变成一个普通文件：mkdir 会失败，落盘必然出错。
    writeFileSync(join(projectRoot, '.agent'), 'not a directory', 'utf-8');

    await expect(service.startup()).resolves.toMatchObject({ probe_status: 'ready' });
    expect(warnings.join('\n')).toContain('failed to persist');
  });
});

describe('explicit refresh', () => {
  it('throws on probe failure but keeps the previous drivers', async () => {
    let failing = false;
    const { service } = makeRuntime({
      probe: async () => {
        if (failing) throw new DriverProbeUnavailableError('probe module missing');
        return probeResult(['gemini']);
      },
    });
    await service.startup();
    const driverId = Object.keys(service.discoveredProfiles())[0]!;

    failing = true;
    await expect(service.refresh()).rejects.toBeInstanceOf(DriverProbeUnavailableError);

    const snapshot = service.snapshot();
    expect(snapshot.probe_status).toBe('unavailable');
    // 历史 driver 仍在，只是不可选择
    expect(snapshot.drivers.map((driver) => driver.driver_id)).toEqual([driverId]);
    expect(snapshot.drivers[0]?.status).toBe('stale');
  });

  it('only probes once when refreshes overlap', async () => {
    const probe = vi.fn(async () => probeResult(['gemini']));
    const { service } = makeRuntime({ probe });

    const [first, second] = await Promise.all([service.refresh(), service.refresh()]);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it('registers discovered runtimes exactly once and reports failures', async () => {
    const { service } = makeRuntime({ probe: async () => probeResult(['gemini', 'codex']) });
    await service.startup();
    const registry = stubRegistry({
      [Object.keys(service.discoveredProfiles()).find((id) => id.includes('codex'))!]: {
        ok: false,
        reason_code: 'DRIVER_RUNNER_ENTRY_MISSING',
      },
    });
    service.attachRegistry(registry);

    service.syncRuntimes();
    service.syncRuntimes();

    expect(registry.registered.size).toBe(1);
    const failed = service
      .snapshot()
      .drivers.find((driver) => driver.status === 'failed');
    expect(failed).toMatchObject({
      status: 'failed',
      reason_code: 'DRIVER_RUNNER_ENTRY_MISSING',
      runtime_registered: false,
    });
    // 装成功的那个 driver 记的是「已注册」——同一轮里两种执行事实互不串台
    const ready = service.snapshot().drivers.find((driver) => driver.status === 'ready');
    expect(ready?.runtime_registered).toBe(true);
  });

  it('records the registration fact for a configured driver without inventing it', async () => {
    const { service } = makeRuntime({
      // 配置 driver 的 agent 也在探测结果里：catalog 只给「探测到过」的档案留记录
      probe: async () => probeResult(['gemini', 'claude']),
      configuredProfiles: [{ driver_id: 'acp-external', agent: 'claude' }],
    });
    await service.startup();
    const configuredRecord = (): { runtime_registered?: boolean } | undefined =>
      service.snapshot().drivers.find((driver) => driver.driver_id === 'acp-external');
    // 还没有 registry：不得凭空写一条「已注册」
    expect(configuredRecord()?.runtime_registered).toBe(false);

    // registry 自己装了配置 driver 的 runtime，这一格事实要跟着变真
    service.attachRegistry(stubRegistry({}, ['acp-external']));
    service.syncRuntimes();

    expect(configuredRecord()?.runtime_registered).toBe(true);
  });
});

describe('restart', () => {
  it('reuses the same ids and profiles read back from disk', async () => {
    const projectRoot = makeTempDir('newide-discovery-restart-project-');
    const stateRoot = makeTempDir('newide-discovery-restart-state-');
    const first = makeRuntime({
      probe: async () => probeResult(['gemini']),
      projectRoot,
      stateRoot,
    });
    await first.service.startup();
    const before = first.service.discoveredProfiles();

    // 「重启」：同样的 projectRoot/stateRoot，新的服务实例（历史来自磁盘上的两个文件）
    const second = makeRuntime({
      probe: async () => {
        throw new DriverProbeUnavailableError('probe module missing');
      },
      projectRoot,
      stateRoot,
    });

    expect(second.service.discoveredProfiles()).toEqual(before);
    expect(second.service.snapshot().probe_status).toBe('ready');
  });

  it('ignores a corrupt history instead of failing to start', async () => {
    const projectRoot = makeTempDir('newide-discovery-corrupt-project-');
    const stateRoot = makeTempDir('newide-discovery-corrupt-state-');
    mkdirSync(join(projectRoot, '.agent'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agent', DETECTED_DRIVER_PROFILES_FILE_NAME),
      'drivers: [broken\n',
      'utf-8',
    );
    writeFileSync(join(stateRoot, 'driver-discovery.json'), '{ nope', 'utf-8');

    const { service, warnings } = makeRuntime({
      probe: async () => probeResult(['gemini']),
      projectRoot,
      stateRoot,
    });

    await expect(service.startup()).resolves.toMatchObject({ probe_status: 'ready' });
    expect(warnings.join('\n')).toContain('ignoring');
    // 坏文件被这一轮探测的结果覆盖，重新变成一份好文件
    expect(service.snapshot().drivers).toHaveLength(1);
  });
});
