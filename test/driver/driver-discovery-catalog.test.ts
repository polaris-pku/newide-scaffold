/**
 * Driver 自动发现目录的测试（合并规则 / 稳定身份 / 并发）。
 *
 * 这些规则的共同点是「错了不会报错，只会静默地把某个 driver 指错」：id 不稳定会让 UI routing
 * 悬空，配置事实被探测事实覆盖会让用户配的启动方式消失，并发合并会让旧 probe 覆盖新 probe。
 * 所以每一条都用纯单元测试钉住。
 */

import { describe, expect, it } from 'vitest';

import {
  createDriverDiscoveryCatalog,
  DISCOVERED_DRIVER_ID_PREFIX,
  DRIVER_CONNECTION_TYPE_UNSUPPORTED,
  DRIVER_DISCOVERY_STALE,
  DRIVER_RUNTIME_REGISTRATION_FAILED,
  driverIdForDiscoveredAgent,
  type DriverDiscoveryCatalog,
  type DriverDiscoveryCatalogOptions,
  type DriverDiscoveryConfiguredProfile,
} from '../../src/driver/driver-discovery-catalog';
import type { DriverProbe, DriverProbeResult } from '../../src/driver/driver-probe-service';

const PROBED_AT = '2026-10-14T00:00:00.000Z';

function probe(overrides: Partial<DriverProbe> & { agentId: string }): DriverProbe {
  return {
    displayName: overrides.agentId,
    // 刻意塞进「不该进 profile」的东西：启动命令、参数里的绝对路径与看起来像凭据的值。
    launch: { command: 'npx', args: ['-y', 'some-agent', '--api-key=sk-secret'] },
    provenance: 'npx-on-demand',
    connectionType: 'acp',
    probedAt: PROBED_AT,
    ...overrides,
  };
}

function probeResult(drivers: DriverProbe[]): DriverProbeResult {
  return { schema_version: 'driver-probe.v1', generated_at: PROBED_AT, drivers };
}

function catalog(
  configuredProfiles: readonly DriverDiscoveryConfiguredProfile[] = [],
  overrides: Partial<Omit<DriverDiscoveryCatalogOptions, 'configuredProfiles'>> = {},
): DriverDiscoveryCatalog {
  return createDriverDiscoveryCatalog({
    configuredProfiles: () => configuredProfiles,
    now: () => new Date(PROBED_AT),
    ...overrides,
  });
}

describe('stable discovered driver ids', () => {
  it('derives the id from the agent id alone', async () => {
    expect(driverIdForDiscoveredAgent('gemini')).toMatch(
      new RegExp(`^${DISCOVERED_DRIVER_ID_PREFIX}gemini-[0-9a-f]{8}$`),
    );
    // 规范化只留 ASCII 小写字母数字，连续分隔符折叠，首尾去掉
    expect(driverIdForDiscoveredAgent('Goose CLI')).toMatch(
      /^discovered:goose-cli-[0-9a-f]{8}$/,
    );
    // 规范化会撞名，哈希后缀保证不同 agentId 仍得到不同 id
    expect(driverIdForDiscoveredAgent('Goose CLI')).not.toBe(
      driverIdForDiscoveredAgent('goose-cli'),
    );
    // 同一个 agentId 在任何轮次都是同一个 id
    expect(driverIdForDiscoveredAgent('claude')).toBe(driverIdForDiscoveredAgent('claude'));
  });

  it('keeps the id stable when the display name changes', async () => {
    const first = await catalog().mergeProbe(
      probeResult([probe({ agentId: 'gemini', displayName: 'Gemini CLI' })]),
    );
    const second = await catalog().mergeProbe(
      probeResult([probe({ agentId: 'gemini', displayName: 'Gemini (beta)' })]),
    );

    expect(first.drivers.map((driver) => driver.driver_id)).toEqual(
      second.drivers.map((driver) => driver.driver_id),
    );
    expect(second.drivers[0]?.display_name).toBe('Gemini (beta)');
  });
});

describe('merging probe results into the catalog', () => {
  it('lets a configured profile keep its own driver id for the same agent', async () => {
    const result = await catalog([{ driver_id: 'acp-external', agent: 'claude' }]).mergeProbe(
      probeResult([probe({ agentId: 'claude' })]),
    );

    expect(result.drivers).toHaveLength(1);
    expect(result.drivers[0]).toMatchObject({
      driver_id: 'acp-external',
      agent_id: 'claude',
      source: 'configured',
      status: 'ready',
    });
    expect(result.drivers[0]?.driver_id.startsWith(DISCOVERED_DRIVER_ID_PREFIX)).toBe(false);
  });

  it('generates only a minimal profile for a newly discovered agent', async () => {
    const discovery = catalog();
    await discovery.mergeProbe(
      probeResult([probe({ agentId: 'gemini', displayName: 'Gemini CLI' })]),
    );

    const profiles = discovery.discoveredProfiles();
    const driverId = Object.keys(profiles)[0]!;
    expect(profiles[driverId]).toEqual({ agent: 'gemini', description: 'Gemini CLI' });
    // 启动命令、参数、环境变量、凭据一律不落进 profile
    const serialized = JSON.stringify(profiles);
    expect(serialized).not.toContain('npx');
    expect(serialized).not.toContain('launch');
    expect(serialized).not.toContain('sk-secret');
  });

  it('never invents a driver id from the display name or position', async () => {
    const result = await catalog().mergeProbe(
      probeResult([
        probe({ agentId: 'a', displayName: 'Zed' }),
        probe({ agentId: 'b', displayName: 'a' }),
      ]),
    );

    expect(result.drivers.map((driver) => driver.driver_id)).toEqual([
      driverIdForDiscoveredAgent('a'),
      driverIdForDiscoveredAgent('b'),
    ]);
  });

  it('keeps a previously discovered driver as stale instead of dropping it', async () => {
    const discovery = catalog();
    await discovery.mergeProbe(probeResult([probe({ agentId: 'gemini' })]));
    const driverId = Object.keys(discovery.discoveredProfiles())[0]!;

    const result = await discovery.mergeProbe(probeResult([probe({ agentId: 'codex' })]));

    const stale = result.drivers.find((driver) => driver.driver_id === driverId);
    expect(stale).toMatchObject({ status: 'stale', reason_code: DRIVER_DISCOVERY_STALE });
    // profile 与 id 都保留：UI routing 可能正引用着它，删掉就成了悬空引用
    expect(discovery.discoveredProfiles()[driverId]).toEqual({
      agent: 'gemini',
      description: 'gemini',
    });
    expect(discovery.discoveredDriverIds()).toContain(driverId);
  });

  it('marks a non-acp connection type as unsupported', async () => {
    const result = await catalog().mergeProbe(
      probeResult([probe({ agentId: 'legacy', connectionType: 'pty' })]),
    );

    expect(result.drivers[0]).toMatchObject({
      status: 'unsupported',
      connection_type: 'pty',
      reason_code: DRIVER_CONNECTION_TYPE_UNSUPPORTED,
    });
  });

  it('keeps probe failures from deleting history', async () => {
    const discovery = catalog([{ driver_id: 'acp-external', agent: 'claude' }]);
    await discovery.mergeProbe(probeResult([probe({ agentId: 'claude' }), probe({ agentId: 'gemini' })]));

    const failed = discovery.markProbeFailure('DRIVER_DISCOVERY_PROBE_UNAVAILABLE');

    expect(failed.probe_status).toBe('unavailable');
    // 配置 driver 的存在性不依赖探测：探测失败不该让手工配好的 driver 变成不可选
    expect(failed.drivers.find((driver) => driver.source === 'configured')).toMatchObject({
      status: 'ready',
    });
    expect(failed.drivers.find((driver) => driver.source === 'discovered')).toMatchObject({
      status: 'stale',
      reason_code: DRIVER_DISCOVERY_STALE,
    });
    expect(failed.drivers).toHaveLength(2);
  });

  it('records runtime registration as a separate fact', async () => {
    const discovery = catalog();
    await discovery.mergeProbe(probeResult([probe({ agentId: 'gemini' })]));
    const driverId = Object.keys(discovery.discoveredProfiles())[0]!;

    discovery.recordRuntimeFailure(driverId, DRIVER_RUNTIME_REGISTRATION_FAILED);
    expect(discovery.recordOf(driverId)).toMatchObject({
      status: 'failed',
      reason_code: DRIVER_RUNTIME_REGISTRATION_FAILED,
      runtime_registered: false,
    });
    expect(discovery.runtimeStatus(driverId)).toEqual({
      registered: false,
      reason_code: DRIVER_RUNTIME_REGISTRATION_FAILED,
    });

    discovery.recordRuntimeRegistered(driverId);
    expect(discovery.recordOf(driverId)).toMatchObject({ status: 'ready', runtime_registered: true });
    expect(discovery.recordOf(driverId)?.reason_code).toBeUndefined();
  });

  it('does not let a runtime success overwrite a discovery verdict', async () => {
    const discovery = catalog();
    await discovery.mergeProbe(probeResult([probe({ agentId: 'gemini' })]));
    const driverId = Object.keys(discovery.discoveredProfiles())[0]!;
    await discovery.mergeProbe(probeResult([]));

    discovery.recordRuntimeRegistered(driverId);

    // 「本轮没再探测到」比「进程里还留着旧 runtime」更上游，不能被改写成 ready
    expect(discovery.recordOf(driverId)?.status).toBe('stale');
  });
});

describe('concurrent merges', () => {
  it('serializes merges so the last probe wins', async () => {
    const discovery = catalog();
    const first = discovery.mergeProbe(probeResult([probe({ agentId: 'first' })]));
    const second = discovery.mergeProbe(probeResult([probe({ agentId: 'second' })]));

    await Promise.all([first, second]);

    const current = discovery.current();
    // 后一次探测的结果完整生效，且没有和第一次混在一起
    const ids = current.drivers.map((driver) => driver.agent_id);
    expect(ids).toContain('second');
    expect(ids).toContain('first');
    expect(current.drivers.find((driver) => driver.agent_id === 'first')?.status).toBe('stale');
  });
});
