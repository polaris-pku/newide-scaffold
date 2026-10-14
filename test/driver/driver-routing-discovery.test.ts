/**
 * 自动发现的 driver 在 routing 快照里的样子。
 *
 * 这一层最容易出的错是「前端看到可选、执行时才炸」——所以判据全部收敛到 `selectable` 一个
 * 布尔值上，且它的来源只有一处：档案 → runtime → 探测结论 → 注入闸门。每条不可选择的情形
 * 都必须带**具体**原因码，前端才能区分「本轮没再发现」「连接类型不支持」「runtime 起不来」。
 *
 * 与 `driver-routing-service.test.ts` 分开：那边钉的是配置与 CAS 语义，这边钉的是探测事实
 * 如何进入投影。两边共用同一份 DriverRoutingService，但夹具不同（这里需要 catalog）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createDriverDiscoveryCatalog,
  type DriverDiscoveryCatalog,
  type DriverDiscoveryRecord,
} from '../../src/driver/driver-discovery-catalog';
import {
  DETECTED_DRIVER_PROFILES_VERSION,
  DriverDiscoveryFileStore,
} from '../../src/driver/driver-discovery-file-store';
import {
  DriverRoutingService,
  type DriverRoutingDriverAvailability,
} from '../../src/driver/driver-routing-service';
import type { DriverCapabilities, DriverRuntimeHandle } from '../../src/driver';

const tempDirs: string[] = [];
const DISCOVERED_ID = 'discovered:gemini-8a12f40e';

function makeTempDir(prefix = 'newide-discovered-routing-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** 只满足 handle 结构的最小桩；这些用例不真的调用 driver。 */
function makeHandle(driverId: string): DriverRuntimeHandle {
  const capabilities: DriverCapabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: false,
    supports_permission_events: false,
  };
  return {
    driver_id: driverId,
    capabilities,
    session_id: `${driverId}:session`,
    sendPrompt: () => {
      throw new Error('not exercised');
    },
    interrupt: async () => undefined,
    collectTranscript: async () => {
      throw new Error('not exercised');
    },
  };
}

const PROJECT_DRIVERS_YAML = [
  'version: 1',
  'default_driver: claude',
  'drivers:',
  '  claude:',
  '    agent: claude',
  '  codex:',
  '    agent: codex',
  'roles:',
  '  reviewer: codex',
  '',
].join('\n');

function writeProject(config: string): string {
  const projectRoot = makeTempDir();
  mkdirSync(join(projectRoot, '.agent'), { recursive: true });
  writeFileSync(join(projectRoot, '.agent', 'drivers.yaml'), config, 'utf-8');
  return projectRoot;
}

/** 把自动发现层写进项目，等价于「一轮成功探测并落盘之后」的状态。 */
function writeDiscoveredLayer(
  projectRoot: string,
  drivers: Record<string, { agent: string; description?: string }> = {
    [DISCOVERED_ID]: { agent: 'gemini', description: 'Gemini CLI' },
  },
): void {
  new DriverDiscoveryFileStore({ projectRoot, stateRoot: makeTempDir() }).writeProfiles({
    version: DETECTED_DRIVER_PROFILES_VERSION,
    drivers,
  });
}

function discoveryCatalog(
  records: readonly Partial<DriverDiscoveryRecord>[],
): DriverDiscoveryCatalog {
  return createDriverDiscoveryCatalog({
    configuredProfiles: () => [],
    initialProbeStatus: 'ready',
    initialRecords: records.map((record) => ({
      driver_id: DISCOVERED_ID,
      agent_id: 'gemini',
      display_name: 'Gemini CLI',
      connection_type: 'acp' as const,
      provenance: 'local-entry',
      probed_at: '2026-10-14T00:00:00.000Z',
      source: 'discovered' as const,
      status: 'ready' as const,
      runtime_registered: true,
      ...record,
    })),
  });
}

function createService(options: {
  projectRoot: string;
  catalog?: DriverDiscoveryCatalog;
  registryDriverIds?: readonly string[];
  runtimeFailures?: Readonly<Record<string, string>>;
  availabilityOf?: (driverId: string) => DriverRoutingDriverAvailability;
  discovery?: { refresh(options?: unknown): Promise<unknown> };
}): DriverRoutingService {
  const registryIds = options.registryDriverIds ?? [];
  const handles = new Map(registryIds.map((driverId) => [driverId, makeHandle(driverId)]));
  return new DriverRoutingService({
    projectRoot: options.projectRoot,
    env: {},
    homeDir: makeTempDir('newide-discovered-routing-home-'),
    registry: {
      listDriverIds: () => [...handles.keys()],
      hasRuntime: (driverId) => handles.has(driverId),
      get: (driverId) => {
        const handle = handles.get(driverId);
        if (!handle) throw new Error(`no runtime handle for ${driverId}`);
        return handle;
      },
      failureOf: (driverId) => {
        const reason = options.runtimeFailures?.[driverId];
        return reason ? { reason_code: reason, message: 'stub registration failure' } : undefined;
      },
    },
    knownRoleIds: async () => ['proposer', 'reviewer'],
    ...(options.catalog ? { catalog: options.catalog } : {}),
    ...(options.discovery ? { discovery: options.discovery } : {}),
    ...(options.availabilityOf
      ? { availabilityOf: (driverId: string) => options.availabilityOf!(driverId) }
      : {}),
  });
}

const WITH_DISCOVERED_RUNTIME = ['acp-external', 'claude', 'codex', DISCOVERED_ID];

describe('a probed driver', () => {
  it('is listed, selectable, and honest about what the probe proved', async () => {
    const projectRoot = writeProject(PROJECT_DRIVERS_YAML);
    writeDiscoveredLayer(projectRoot);
    const service = createService({
      projectRoot,
      catalog: discoveryCatalog([{}]),
      registryDriverIds: WITH_DISCOVERED_RUNTIME,
    });

    const snapshot = await service.getSnapshot();
    const driver = snapshot.drivers.find((item) => item.driver_id === DISCOVERED_ID);

    expect(driver).toMatchObject({
      agent: 'gemini',
      display_name: 'Gemini CLI',
      selectable: true,
      // 探测通过 ≠ 能跑完一次 Run：状态仍是 degraded，证据写进 limitations
      status: 'degraded',
      reason_code: 'AGENT_CLI_READINESS_NOT_VERIFIABLE',
    });
    expect(driver?.limitations?.[0]).toContain('ACP 探测通过');
  });

  it('shows its ACP display name instead of the generated description', async () => {
    const projectRoot = writeProject(PROJECT_DRIVERS_YAML);
    writeDiscoveredLayer(projectRoot, { [DISCOVERED_ID]: { agent: 'gemini' } });
    const service = createService({
      projectRoot,
      catalog: discoveryCatalog([{ display_name: 'Gemini Code Assist' }]),
      registryDriverIds: WITH_DISCOVERED_RUNTIME,
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.drivers.find((item) => item.driver_id === DISCOVERED_ID)).toMatchObject({
      display_name: 'Gemini Code Assist',
    });
  });
});

describe('a driver that is not selectable', () => {
  const cases: readonly {
    name: string;
    record: Partial<DriverDiscoveryRecord>;
    runtimeFailures?: Record<string, string>;
    runtimeIds?: readonly string[];
    expected: string;
  }[] = [
    {
      // 注册失败的现实形态就是「进程里没有它的 runtime + 记着失败原因」
      name: 'runtime registration failed',
      record: {},
      runtimeFailures: { [DISCOVERED_ID]: 'DRIVER_RUNTIME_REGISTRATION_FAILED' },
      runtimeIds: ['acp-external', 'claude', 'codex'],
      expected: 'DRIVER_RUNTIME_REGISTRATION_FAILED',
    },
    {
      name: 'not rediscovered this round',
      record: { status: 'stale', reason_code: 'DRIVER_DISCOVERY_STALE' },
      expected: 'DRIVER_DISCOVERY_STALE',
    },
    {
      name: 'connection type unsupported',
      record: {
        connection_type: 'pty',
        status: 'unsupported',
        reason_code: 'DRIVER_CONNECTION_TYPE_UNSUPPORTED',
      },
      expected: 'DRIVER_CONNECTION_TYPE_UNSUPPORTED',
    },
  ];

  for (const testCase of cases) {
    it(`carries the reason code when the ${testCase.name}`, async () => {
      const projectRoot = writeProject(PROJECT_DRIVERS_YAML);
      writeDiscoveredLayer(projectRoot);
      const service = createService({
        projectRoot,
        catalog: discoveryCatalog([testCase.record]),
        registryDriverIds: testCase.runtimeIds ?? WITH_DISCOVERED_RUNTIME,
        ...(testCase.runtimeFailures ? { runtimeFailures: testCase.runtimeFailures } : {}),
      });

      const snapshot = await service.getSnapshot();

      expect(snapshot.drivers.find((item) => item.driver_id === DISCOVERED_ID)).toMatchObject({
        selectable: false,
        status: 'unavailable',
        reason_code: testCase.expected,
      });
    });
  }

  it('cannot be saved as a role mapping', async () => {
    const projectRoot = writeProject(PROJECT_DRIVERS_YAML);
    writeDiscoveredLayer(projectRoot);
    const service = createService({
      projectRoot,
      catalog: discoveryCatalog([{ status: 'stale', reason_code: 'DRIVER_DISCOVERY_STALE' }]),
      registryDriverIds: WITH_DISCOVERED_RUNTIME,
    });
    const before = await service.getSnapshot();

    await expect(
      service.updateRouting({
        expected_revision: before.revision,
        default_driver: before.default_driver,
        roles: { reviewer: DISCOVERED_ID },
      }),
    ).rejects.toMatchObject({
      code: 'driver_not_selectable',
      data: { reason_code: 'DRIVER_DISCOVERY_STALE', field: 'roles.reviewer' },
    });
  });

  it('ignores an injected availability hook that would say otherwise', async () => {
    const projectRoot = writeProject(PROJECT_DRIVERS_YAML);
    writeDiscoveredLayer(projectRoot);
    const service = createService({
      projectRoot,
      catalog: discoveryCatalog([{ status: 'stale', reason_code: 'DRIVER_DISCOVERY_STALE' }]),
      registryDriverIds: WITH_DISCOVERED_RUNTIME,
      // 探测事实说「不可选」，策略钩子不该能把它翻过来
      availabilityOf: () => ({ selectable: true, status: 'configured' }),
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.drivers.find((item) => item.driver_id === DISCOVERED_ID)?.selectable).toBe(
      false,
    );
  });
});

describe('a selectable discovered driver', () => {
  it('can be saved as a role mapping', async () => {
    const projectRoot = writeProject(PROJECT_DRIVERS_YAML);
    writeDiscoveredLayer(projectRoot);
    const service = createService({
      projectRoot,
      catalog: discoveryCatalog([{}]),
      registryDriverIds: WITH_DISCOVERED_RUNTIME,
    });
    const before = await service.getSnapshot();

    const after = await service.updateRouting({
      expected_revision: before.revision,
      default_driver: before.default_driver,
      roles: { reviewer: DISCOVERED_ID },
    });

    expect(after.roles.find((role) => role.role_id === 'reviewer')?.driver_id).toBe(DISCOVERED_ID);
  });
});

describe('revision and Run isolation', () => {
  it('keeps the revision stable when the discovered set changes', async () => {
    const projectRoot = writeProject(PROJECT_DRIVERS_YAML);
    const revisionBefore = (
      await createService({ projectRoot, catalog: discoveryCatalog([]) }).getSnapshot()
    ).revision;

    writeDiscoveredLayer(projectRoot);
    const snapshot = await createService({
      projectRoot,
      catalog: discoveryCatalog([{}]),
      registryDriverIds: WITH_DISCOVERED_RUNTIME,
    }).getSnapshot();

    // revision 描述「有效 routing 状态」（default_driver + roles）；探测时间与 driver 增删不参与
    expect(snapshot.revision).toBe(revisionBefore);
    expect(snapshot.drivers.map((driver) => driver.driver_id)).toContain(DISCOVERED_ID);
  });

  it('does not disturb a Run frozen before a refresh', async () => {
    const projectRoot = writeProject(PROJECT_DRIVERS_YAML);
    const service = createService({
      projectRoot,
      catalog: discoveryCatalog([]),
      registryDriverIds: WITH_DISCOVERED_RUNTIME,
      discovery: { refresh: async () => undefined },
    });
    const frozen = service.freezeForRun('run-before-refresh');

    await service.refreshDriverDiscovery();

    expect(service.snapshotOfRun('run-before-refresh')).toEqual(frozen);
    expect(service.freezeForRun('run-before-refresh')).toEqual(frozen);
  });

  it('reloads the config after a refresh so new drivers become visible', async () => {
    const projectRoot = writeProject(PROJECT_DRIVERS_YAML);
    const probes: string[] = [];
    const service = createService({
      projectRoot,
      catalog: discoveryCatalog([]),
      registryDriverIds: WITH_DISCOVERED_RUNTIME,
      discovery: {
        refresh: async () => {
          probes.push('probe');
          // 刷新落盘之后，有效 driver 列表里才有它
          writeDiscoveredLayer(projectRoot);
        },
      },
    });
    expect(
      (await service.getSnapshot()).drivers.some((driver) => driver.driver_id === DISCOVERED_ID),
    ).toBe(false);

    const after = await service.refreshDriverDiscovery();

    expect(probes).toEqual(['probe']);
    // revision 只看 default_driver 与 roles：不强制重读配置就永远看不到新 driver
    expect(after.drivers.some((driver) => driver.driver_id === DISCOVERED_ID)).toBe(true);
  });

  it('does not change the UI routing mapping when refreshing', async () => {
    const projectRoot = writeProject(PROJECT_DRIVERS_YAML);
    const service = createService({
      projectRoot,
      catalog: discoveryCatalog([]),
      registryDriverIds: WITH_DISCOVERED_RUNTIME,
      discovery: { refresh: async () => undefined },
    });
    const before = await service.getSnapshot();

    const after = await service.refreshDriverDiscovery();

    expect(after.default_driver).toBe(before.default_driver);
    expect(after.roles).toEqual(before.roles);
    expect(after.revision).toBe(before.revision);
  });
});
