/**
 * Role → Driver 路由服务的测试。
 *
 * 覆盖四件事：
 * - **投影**：`getConfig` 只暴露非敏感字段；status/selectable/reason_code 与「CLI 未验证」
 *   的诚实降级一致；
 * - **规范化与 revision**：roles 排序、值等于 default 的 key 被删除、revision 可复现且不含
 *   时间戳/路径/随机数；
 * - **更新与错误**：未知 driver / 不可选择 / revision 冲突 / 落盘失败各自的错误码与 data，
 *   以及「失败不改内存、不改文件」；
 * - **Run 隔离**：Run 创建时冻结的映射不随后续保存改变，新 Run 拿到新映射；进程重启后从
 *   文件重建同样的 snapshot。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { DriverCapabilities, DriverRuntimeHandle } from '../../src/driver';
import {
  DriverRoutingError,
  DriverRoutingService,
  effectiveUiRoutingDocument,
  computeUiRoutingRevision,
  normalizeUiDriverRoutingDocument,
  uiDriverRoutingPath,
  type DriverRoutingDriverAvailability,
} from '../../src/driver';
import { driverRoutingSnapshotSchema } from '../../src/protocol/driver-routing';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'newide-driver-routing-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** 只满足 handle 结构的最小桩；service 测试不真的调用 driver。 */
class StubDriver implements DriverRuntimeHandle {
  readonly capabilities: DriverCapabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: false,
    supports_permission_events: false,
  };

  constructor(readonly driver_id: string) {}

  get session_id(): string {
    return `${this.driver_id}:session`;
  }

  sendPrompt(): never {
    throw new Error('StubDriver.sendPrompt is not exercised');
  }

  async interrupt(): Promise<void> {}

  async collectTranscript(): Promise<never> {
    throw new Error('StubDriver.collectTranscript is not exercised');
  }
}

/** 只保留 service 真正需要的两个方法的注册表桩。 */
function stubRegistry(driverIds: readonly string[]) {
  const handles = new Map(driverIds.map((id) => [id, new StubDriver(id)]));
  return {
    listDriverIds: () => [...handles.keys()],
    get: (driverId: string): DriverRuntimeHandle => {
      const handle = handles.get(driverId);
      if (!handle) throw new Error(`no handle for ${driverId}`);
      return handle;
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

function writeProject(projectRoot: string, yaml = PROJECT_DRIVERS_YAML): void {
  mkdirSync(join(projectRoot, '.agent'), { recursive: true });
  writeFileSync(join(projectRoot, '.agent', 'drivers.yaml'), yaml, 'utf-8');
}

function createService(options: {
  projectRoot: string;
  knownRoleIds?: readonly string[];
  availabilityOf?: (driverId: string) => DriverRoutingDriverAvailability;
  registryDriverIds?: readonly string[];
}): DriverRoutingService {
  const knownRoleIds = options.knownRoleIds ?? ['proposer', 'reviewer'];
  return new DriverRoutingService({
    projectRoot: options.projectRoot,
    env: {},
    homeDir: makeTempDir('newide-driver-routing-home-'),
    registry: stubRegistry(options.registryDriverIds ?? ['acp-external', 'claude', 'codex']),
    knownRoleIds: async () => knownRoleIds,
    ...(options.availabilityOf
      ? { availabilityOf: (driverId: string) => options.availabilityOf!(driverId) }
      : {}),
  });
}

describe('driver routing snapshot', () => {
  it('projects the default driver, effective drivers and role sources', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({ projectRoot });

    const snapshot = await service.getSnapshot();

    expect(snapshot.schema_version).toBe('driver-routing.v1');
    expect(snapshot.scope).toBe('project');
    expect(snapshot.default_driver).toBe('claude');
    // 内置层永远提供 acp-external（零配置的历史 driver），按 driver_id 排序后排在 claude 之前
    expect(snapshot.drivers.map((driver) => driver.driver_id)).toEqual([
      'acp-external',
      'claude',
      'codex',
    ]);
    // CLI 就绪情况本仓验证不了 → 诚实降级，但依然可选。
    expect(snapshot.drivers.every((driver) => driver.selectable)).toBe(true);
    expect(snapshot.drivers.every((driver) => driver.status === 'degraded')).toBe(true);
    expect(snapshot.drivers.every((driver) => driver.reason_code === 'AGENT_CLI_READINESS_NOT_VERIFIABLE')).toBe(true);

    // active role ∪ 显式配置 role，按 role_id 排序
    expect(snapshot.roles.map((role) => role.role_id)).toEqual(['proposer', 'reviewer']);
    expect(snapshot.roles).toContainEqual({
      role_id: 'reviewer',
      driver_id: 'codex',
      effective_driver_id: 'codex',
      source: 'role_override',
      known_role: true,
    });
    expect(snapshot.roles).toContainEqual({
      role_id: 'proposer',
      driver_id: 'claude',
      effective_driver_id: 'claude',
      source: 'default',
      known_role: true,
    });
    expect(snapshot.orphan_roles).toEqual([]);
  });

  it('lists configured roles that are missing from the directory as orphans', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot, PROJECT_DRIVERS_YAML.replace('  reviewer: codex', '  reviewer: codex\n  retired_role: claude'));
    const service = createService({ projectRoot, knownRoleIds: ['proposer', 'reviewer'] });

    const snapshot = await service.getSnapshot();

    // orphan 仍在 roles 里出现（不静默删除），并额外标记到 orphan_roles
    expect(snapshot.roles.map((role) => role.role_id)).toEqual([
      'proposer',
      'retired_role',
      'reviewer',
    ]);
    expect(snapshot.orphan_roles).toEqual([
      {
        role_id: 'retired_role',
        driver_id: 'claude',
        effective_driver_id: 'claude',
        source: 'role_override',
        known_role: false,
      },
    ]);
  });

  it('never leaks runtime env, credentials, runner paths or commands', async () => {
    const projectRoot = makeTempDir();
    writeProject(
      projectRoot,
      [
        'version: 1',
        'default_driver: claude',
        'drivers:',
        '  claude:',
        '    agent: claude',
        '    description: Claude through the adapter',
        '    runtime:',
        '      runner_dir: C:/very/secret/runner/path',
        '      env:',
        '        SUPER_SECRET_TOKEN: super-secret-value',
        '    credentials:',
        '      env:',
        '        - ANTHROPIC_API_KEY',
        '    limitations:',
        '      - CLI not verified',
        '',
      ].join('\n'),
    );
    const service = createService({ projectRoot });

    const snapshot = await service.getSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('very/secret/runner');
    expect(serialized).not.toContain('SUPER_SECRET_TOKEN');
    expect(serialized).not.toContain('ANTHROPIC_API_KEY');
    const claude = snapshot.drivers.find((driver) => driver.driver_id === 'claude');
    expect(claude?.limitations).toEqual(['CLI not verified']);
    expect(claude?.description).toBe('Claude through the adapter');
  });

  it('rejects unknown fields through its strict output schema', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const snapshot = await createService({ projectRoot }).getSnapshot();

    expect(() =>
      driverRoutingSnapshotSchema.parse({ ...snapshot, runtime: { env: {} } }),
    ).toThrow();
  });
});

describe('revision and normalization', () => {
  it('is reproducible across processes and independent of role order', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const first = createService({ projectRoot });
    const second = createService({ projectRoot });

    const a = await first.getSnapshot();
    const b = await second.getSnapshot();

    expect(a.revision).toBe(b.revision);
    expect(a.revision).toMatch(/^sha256:[0-9a-f]{64}$/);

    const unordered = computeUiRoutingRevision(
      normalizeUiDriverRoutingDocument({
        default_driver: 'claude',
        roles: { zeta: 'codex', alpha: 'codex' },
      }),
    );
    const ordered = computeUiRoutingRevision(
      normalizeUiDriverRoutingDocument({
        default_driver: 'claude',
        roles: { alpha: 'codex', zeta: 'codex' },
      }),
    );
    expect(unordered).toBe(ordered);

    // 值等于 default 的 key 在规范化时被删除，因此不改变 revision
    const withRedundant = computeUiRoutingRevision(
      normalizeUiDriverRoutingDocument({
        default_driver: 'claude',
        roles: { alpha: 'claude' },
      }),
    );
    expect(withRedundant).toBe(
      computeUiRoutingRevision(
        normalizeUiDriverRoutingDocument({ default_driver: 'claude', roles: {} }),
      ),
    );
  });

  it('derives the revision from the effective routing, not the file bytes', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({ projectRoot });

    const snapshot = await service.getSnapshot();

    expect(snapshot.revision).toBe(
      computeUiRoutingRevision(
        effectiveUiRoutingDocument({
          default_driver: 'claude',
          drivers: { claude: { agent: 'claude' }, codex: { agent: 'codex' } },
          roles: { reviewer: 'codex' },
        }),
      ),
    );
  });
});

describe('updateRouting', () => {
  it('changes the default driver and persists a normalized file', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({ projectRoot });
    const before = await service.getSnapshot();

    const updated = await service.updateRouting({
      expected_revision: before.revision,
      default_driver: 'codex',
      roles: { reviewer: 'codex', proposer: 'claude' },
    });

    expect(updated.default_driver).toBe('codex');
    expect(updated.revision).not.toBe(before.revision);
    // reviewer 的值等于新的 default → 规范化为冗余并删除
    expect(updated.roles).toContainEqual({
      role_id: 'reviewer',
      driver_id: 'codex',
      effective_driver_id: 'codex',
      source: 'default',
      known_role: true,
    });
    const file = readFileSync(uiDriverRoutingPath(projectRoot), 'utf-8');
    expect(file).toContain('default_driver: codex');
    expect(file).not.toContain('reviewer');
    expect(file).toContain('proposer: claude');
  });

  it('deletes a lower-layer role mapping so it falls back to the default', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({ projectRoot });
    const before = await service.getSnapshot();
    expect(before.roles.find((role) => role.role_id === 'reviewer')?.driver_id).toBe('codex');

    // 完整 mapping 里不带 reviewer → UI 层拥有整张 role 表 → reviewer 回到 default
    await service.updateRouting({
      expected_revision: before.revision,
      default_driver: 'claude',
      roles: {},
    });
    const after = await service.getSnapshot();

    const reviewer = after.roles.find((role) => role.role_id === 'reviewer');
    expect(reviewer?.source).toBe('default');
    expect(reviewer?.driver_id).toBe('claude');
  });

  it('returns DRIVER_NOT_FOUND with the offending field and driver id', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({ projectRoot });
    const before = await service.getSnapshot();

    const defaultError = await captureError(() =>
      service.updateRouting({
        expected_revision: before.revision,
        default_driver: 'ghost',
        roles: {},
      }),
    );
    expect(defaultError.code).toBe('driver_not_found');
    expect(defaultError.data).toMatchObject({ reason: 'driver_not_found', field: 'default_driver', driver_id: 'ghost' });

    const roleError = await captureError(() =>
      service.updateRouting({
        expected_revision: before.revision,
        default_driver: 'claude',
        roles: { reviewer: 'ghost' },
      }),
    );
    expect(roleError.code).toBe('driver_not_found');
    expect(roleError.data).toMatchObject({ field: 'roles.reviewer', driver_id: 'ghost' });
  });

  it('returns DRIVER_NOT_SELECTABLE with reason code and limitations', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({
      projectRoot,
      availabilityOf: (driverId) =>
        driverId === 'codex'
          ? {
              selectable: false,
              status: 'unavailable',
              reason_code: 'AGENT_CLI_READINESS_NOT_VERIFIABLE',
              limitations: ['codex CLI is not installed'],
            }
          : { selectable: true, status: 'degraded', reason_code: 'AGENT_CLI_READINESS_NOT_VERIFIABLE' },
    });
    const before = await service.getSnapshot();

    const error = await captureError(() =>
      service.updateRouting({
        expected_revision: before.revision,
        default_driver: 'claude',
        roles: { reviewer: 'codex' },
      }),
    );

    expect(error.code).toBe('driver_not_selectable');
    expect(error.data).toMatchObject({
      reason: 'driver_not_selectable',
      field: 'roles.reviewer',
      driver_id: 'codex',
      reason_code: 'AGENT_CLI_READINESS_NOT_VERIFIABLE',
      limitations: ['codex CLI is not installed'],
    });
  });

  it('marks a configured driver without a runtime handle as not selectable', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    // 档案在配置里，但进程内没有它的 runtime 句柄
    const service = createService({ projectRoot, registryDriverIds: ['acp-external', 'claude'] });

    const snapshot = await service.getSnapshot();
    expect(snapshot.drivers.find((driver) => driver.driver_id === 'codex')).toMatchObject({
      selectable: false,
      status: 'unavailable',
      reason_code: 'DRIVER_RUNTIME_NOT_CONFIGURED',
    });

    const error = await captureError(() =>
      service.updateRouting({
        expected_revision: snapshot.revision,
        default_driver: 'codex',
        roles: {},
      }),
    );
    expect(error.code).toBe('driver_not_selectable');
    expect(error.data).toMatchObject({
      field: 'default_driver',
      driver_id: 'codex',
      reason_code: 'DRIVER_RUNTIME_NOT_CONFIGURED',
    });
  });

  it('rejects a stale revision, reports the current one and leaves the file untouched', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({ projectRoot });
    const before = await service.getSnapshot();
    await service.updateRouting({
      expected_revision: before.revision,
      default_driver: 'codex',
      roles: {},
    });
    const fileAfterFirstUpdate = readFileSync(uiDriverRoutingPath(projectRoot), 'utf-8');
    const currentRevision = service.currentRevision();

    const error = await captureError(() =>
      service.updateRouting({
        expected_revision: before.revision,
        default_driver: 'claude',
        roles: {},
      }),
    );

    expect(error.code).toBe('revision_mismatch');
    expect(error.data).toMatchObject({
      reason: 'revision_mismatch',
      current_revision: currentRevision,
    });
    expect(readFileSync(uiDriverRoutingPath(projectRoot), 'utf-8')).toBe(fileAfterFirstUpdate);
    await expect(service.getSnapshot()).resolves.toMatchObject({ default_driver: 'codex' });
  });

  it('reports a write failure without changing the in-memory routing', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({ projectRoot });
    const before = await service.getSnapshot();
    // 目标路径被一个目录占住 → rename 必然失败（Windows EPERM/ENOTEMPTY，POSIX EISDIR）
    mkdirSync(uiDriverRoutingPath(projectRoot), { recursive: true });

    const error = await captureError(() =>
      service.updateRouting({
        expected_revision: before.revision,
        default_driver: 'codex',
        roles: {},
      }),
    );

    expect(error.code).toBe('write_failed');
    expect(error.data).toMatchObject({ reason: 'write_failed', path_category: 'project_agent_dir' });
    const after = await service.getSnapshot();
    expect(after.default_driver).toBe('claude');
    expect(after.revision).toBe(before.revision);
  });
});

describe('resetRouting', () => {
  it('removes the UI file and returns to the lower-layer configuration', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({ projectRoot });
    const original = await service.getSnapshot();
    const updated = await service.updateRouting({
      expected_revision: original.revision,
      default_driver: 'codex',
      roles: { proposer: 'claude' },
    });
    expect(updated.default_driver).toBe('codex');

    const reset = await service.resetRouting(updated.revision);

    expect(reset.default_driver).toBe('claude');
    expect(reset.revision).toBe(original.revision);
    expect(reset.roles.find((role) => role.role_id === 'reviewer')?.driver_id).toBe('codex');
    expect(() => readFileSync(uiDriverRoutingPath(projectRoot), 'utf-8')).toThrow();
  });

  it('still enforces the revision guard', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({ projectRoot });
    const before = await service.getSnapshot();
    await service.updateRouting({
      expected_revision: before.revision,
      default_driver: 'codex',
      roles: {},
    });

    const error = await captureError(() => service.resetRouting(before.revision));

    expect(error.code).toBe('revision_mismatch');
    expect(readFileSync(uiDriverRoutingPath(projectRoot), 'utf-8')).toContain('codex');
  });
});

describe('run isolation', () => {
  it('keeps a frozen run on the mapping it was created with', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({ projectRoot });

    const runA = service.freezeForRun('run_a');
    expect(service.resolveForRunRole('run_a', 'reviewer').driver_id).toBe('codex');
    expect(service.resolveForRunRole('run_a', 'proposer').driver_id).toBe('claude');

    // 保存后：default 仍是 claude，但 reviewer 不再显式映射，proposer 改指向 codex
    await service.updateRouting({
      expected_revision: service.currentRevision(),
      default_driver: 'claude',
      roles: { proposer: 'codex' },
    });

    const runB = service.freezeForRun('run_b');

    // 旧 Run 的投影逐字段不变，解析结果也不变
    expect(service.snapshotOfRun('run_a')).toEqual(runA);
    expect(service.resolveForRunRole('run_a', 'reviewer').driver_id).toBe('codex');
    expect(service.resolveForRunRole('run_a', 'proposer').driver_id).toBe('claude');
    // 新 Run 用新映射
    expect(service.resolveForRunRole('run_b', 'reviewer').driver_id).toBe('claude');
    expect(service.resolveForRunRole('run_b', 'proposer').driver_id).toBe('codex');
    expect(runB).toMatchObject({ default_driver: 'claude', roles: { proposer: 'codex' } });
  });

  it('does not re-freeze a run id that is already frozen', () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({ projectRoot });

    const first = service.freezeForRun('run_same');
    const second = service.freezeForRun('run_same');

    expect(second).toBe(first);
  });

  it('resolves without a snapshot for runs created before the freeze existed', () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({ projectRoot });

    expect(service.snapshotOfRun('run_legacy')).toBeUndefined();
    expect(service.resolveForRunRole('run_legacy', 'reviewer').driver_id).toBe('codex');
  });

  it('rebuilds the same routing and revision after a process restart', async () => {
    const projectRoot = makeTempDir();
    writeProject(projectRoot);
    const service = createService({ projectRoot });
    const updated = await service.updateRouting({
      expected_revision: service.currentRevision(),
      default_driver: 'codex',
      roles: { proposer: 'claude' },
    });

    const restarted = createService({ projectRoot });
    const snapshot = await restarted.getSnapshot();

    expect(snapshot.revision).toBe(updated.revision);
    expect(snapshot.default_driver).toBe('codex');
    expect(snapshot.roles.find((role) => role.role_id === 'proposer')?.driver_id).toBe('claude');
    expect(await restarted.getSnapshot()).toEqual(updated);
  });
});

async function captureError(operation: () => Promise<unknown>): Promise<DriverRoutingError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof DriverRoutingError) return error;
    throw error;
  }
  throw new Error('expected the operation to throw');
}
