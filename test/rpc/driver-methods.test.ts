/**
 * `driver.*` JSON-RPC 方法的测试。
 *
 * 钉住三件事：
 * - **参数面**：`driver.getConfig` 只接受 `{}`；update/reset 拒绝多余字段与错误类型，
 *   统一返回 `INVALID_PARAMS`；
 * - **错误映射**：领域错误码到稳定 JSON-RPC 业务码一一对应，data 原样透传（含 revision、
 *   field、driver_id、reason_code、limitations）；
 * - **注册面**：三个方法都能被 dispatcher 找到——用「参数非法返回 -32602 而不是 -32601」
 *   就能证明注册存在，而不需要真的写盘。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DriverRoutingService, uiDriverRoutingPath } from '../../src/driver';
import { DriverRoutingError } from '../../src/driver/driver-routing-service';
import {
  DRIVER_ROUTING_SCHEMA_VERSION,
  type DriverRoutingSnapshot,
} from '../../src/protocol/driver-routing';
import { JsonRpcDispatcher } from '../../src/rpc/json-rpc-dispatcher';
import { JSON_RPC_ERROR_CODES } from '../../src/rpc/json-rpc-line-protocol';
import {
  DriverRpcMethods,
  createDriverMethodsService,
  type DriverMethodsService,
} from '../../src/rpc/driver-methods';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'newide-driver-methods-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function snapshot(defaultDriver = 'claude'): DriverRoutingSnapshot {
  return {
    schema_version: DRIVER_ROUTING_SCHEMA_VERSION,
    revision: 'sha256:abc',
    scope: 'project',
    default_driver: defaultDriver,
    drivers: [
      {
        driver_id: 'claude',
        agent: 'claude',
        selectable: true,
        status: 'degraded',
        reason_code: 'AGENT_CLI_READINESS_NOT_VERIFIABLE',
      },
    ],
    roles: [],
    orphan_roles: [],
  };
}

function stubService(overrides: Partial<DriverMethodsService> = {}): {
  service: DriverMethodsService;
  calls: {
    updateRouting: unknown[];
    resetRouting: string[];
  };
} {
  const calls = { updateRouting: [] as unknown[], resetRouting: [] as string[] };
  const service: DriverMethodsService = {
    getDriverConfig: async () => snapshot(),
    updateDriverRouting: async (input) => {
      calls.updateRouting.push(input);
      return snapshot(input.default_driver);
    },
    resetDriverRouting: async (expectedRevision) => {
      calls.resetRouting.push(expectedRevision);
      return snapshot();
    },
    ...overrides,
  };
  return { service, calls };
}

function dispatcherFor(service: DriverMethodsService): JsonRpcDispatcher {
  const dispatcher = new JsonRpcDispatcher();
  new DriverRpcMethods(service).register(dispatcher);
  return dispatcher;
}

function call(dispatcher: JsonRpcDispatcher, method: string, params?: unknown) {
  return dispatcher.dispatch({
    jsonrpc: '2.0',
    id: 1,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

describe('driver.getConfig', () => {
  it('returns the snapshot for an empty params object', async () => {
    const dispatcher = dispatcherFor(stubService().service);

    const response = await call(dispatcher, 'driver.getConfig', {});

    expect(response).toMatchObject({ id: 1, result: { schema_version: DRIVER_ROUTING_SCHEMA_VERSION } });
  });

  it('treats absent params as empty and rejects any extra field', async () => {
    const dispatcher = dispatcherFor(stubService().service);

    await expect(call(dispatcher, 'driver.getConfig')).resolves.toMatchObject({
      result: { default_driver: 'claude' },
    });
    await expect(call(dispatcher, 'driver.getConfig', { run_id: 'run_1' })).resolves.toMatchObject({
      error: { code: JSON_RPC_ERROR_CODES.INVALID_PARAMS },
    });
  });
});

describe('driver.updateRouting', () => {
  it('forwards the complete mapping and returns the new snapshot', async () => {
    const { service, calls } = stubService();
    const dispatcher = dispatcherFor(service);

    const response = await call(dispatcher, 'driver.updateRouting', {
      expected_revision: 'sha256:abc',
      default_driver: 'codex',
      roles: { reviewer: 'codex' },
    });

    expect(calls.updateRouting).toEqual([
      { expected_revision: 'sha256:abc', default_driver: 'codex', roles: { reviewer: 'codex' } },
    ]);
    expect(response).toMatchObject({ result: { default_driver: 'codex' } });
  });

  it.each([
    ['missing default_driver', { expected_revision: 'sha256:abc', roles: {} }],
    ['missing expected_revision', { default_driver: 'claude', roles: {} }],
    ['extra field', { expected_revision: 'sha256:abc', default_driver: 'claude', roles: {}, force: true }],
    ['non-string role target', { expected_revision: 'sha256:abc', default_driver: 'claude', roles: { reviewer: 1 } }],
  ])('rejects %s with INVALID_PARAMS', async (_label, params) => {
    const dispatcher = dispatcherFor(stubService().service);

    await expect(call(dispatcher, 'driver.updateRouting', params)).resolves.toMatchObject({
      error: { code: JSON_RPC_ERROR_CODES.INVALID_PARAMS },
    });
  });
});

describe('driver.resetRouting', () => {
  it('forwards the expected revision', async () => {
    const { service, calls } = stubService();
    const dispatcher = dispatcherFor(service);

    await call(dispatcher, 'driver.resetRouting', { expected_revision: 'sha256:abc' });

    expect(calls.resetRouting).toEqual(['sha256:abc']);
  });

  it('rejects extra fields with INVALID_PARAMS', async () => {
    const dispatcher = dispatcherFor(stubService().service);

    await expect(
      call(dispatcher, 'driver.resetRouting', { expected_revision: 'sha256:abc', scope: 'project' }),
    ).resolves.toMatchObject({ error: { code: JSON_RPC_ERROR_CODES.INVALID_PARAMS } });
  });
});

describe('driver.* error mapping', () => {
  it.each([
    [
      'revision_mismatch',
      JSON_RPC_ERROR_CODES.DRIVER_CONFIG_CONFLICT,
      { reason: 'revision_mismatch', current_revision: 'sha256:new' },
    ],
    [
      'driver_not_found',
      JSON_RPC_ERROR_CODES.DRIVER_NOT_FOUND,
      { reason: 'driver_not_found', field: 'roles.reviewer', driver_id: 'ghost' },
    ],
    [
      'driver_not_selectable',
      JSON_RPC_ERROR_CODES.DRIVER_NOT_SELECTABLE,
      {
        reason: 'driver_not_selectable',
        driver_id: 'codex',
        reason_code: 'AGENT_CLI_READINESS_NOT_VERIFIABLE',
        limitations: ['not installed'],
      },
    ],
    [
      'default_driver_locked',
      JSON_RPC_ERROR_CODES.DRIVER_DEFAULT_LOCKED,
      {
        reason: 'default_driver_locked',
        field: 'default_driver',
        driver_id: 'codex',
        locked_driver_id: 'claude',
      },
    ],
    [
      'config_busy',
      JSON_RPC_ERROR_CODES.DRIVER_CONFIG_BUSY,
      { reason: 'config_busy', path_category: 'project_agent_dir' },
    ],
    [
      'write_failed',
      JSON_RPC_ERROR_CODES.DRIVER_CONFIG_WRITE_FAILED,
      { reason: 'write_failed', path_category: 'project_agent_dir' },
    ],
  ] as const)('maps %s to its stable code and passes data through', async (code, expectedCode, data) => {
    const dispatcher = dispatcherFor(
      stubService({
        updateDriverRouting: async () => {
          throw new DriverRoutingError(code, `failed: ${code}`, data);
        },
      }).service,
    );

    const response = await call(dispatcher, 'driver.updateRouting', {
      expected_revision: 'sha256:abc',
      default_driver: 'claude',
      roles: {},
    });

    expect(response).toMatchObject({ error: { code: expectedCode, data } });
  });

  it('keeps unknown errors as INTERNAL_ERROR without leaking them', async () => {
    const dispatcher = dispatcherFor(
      stubService({
        resetDriverRouting: async () => {
          throw new Error('secret path C:/private/drivers.yaml');
        },
      }).service,
    );

    const response = await call(dispatcher, 'driver.resetRouting', { expected_revision: 'sha256:abc' });

    expect(response).toMatchObject({
      error: { code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR, message: 'Internal error' },
    });
    expect(JSON.stringify(response)).not.toContain('secret path');
  });

  it('does not register non-driver methods', async () => {
    const dispatcher = dispatcherFor(stubService().service);

    await expect(call(dispatcher, 'driver.setProfile', {})).resolves.toMatchObject({
      error: { code: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND },
    });
  });
});

describe('driver.* against the real routing service', () => {
  it('round-trips getConfig, updateRouting and resetRouting', async () => {
    const projectRoot = makeTempDir();
    const homeDir = makeTempDir('newide-driver-methods-home-');
    mkdirSync(join(projectRoot, '.agent'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agent', 'drivers.yaml'),
      ['version: 1', 'default_driver: claude', 'drivers:', '  claude:', '    agent: claude', '  codex:', '    agent: codex', ''].join('\n'),
      'utf-8',
    );
    const routing = new DriverRoutingService({
      projectRoot,
      env: {},
      homeDir,
      registry: {
        listDriverIds: () => ['claude', 'codex'],
        get: () => {
          throw new Error('handles are not needed by the RPC layer');
        },
      },
      knownRoleIds: async () => ['reviewer'],
    });
    const dispatcher = dispatcherFor(createDriverMethodsService(routing));

    const initial = await call(dispatcher, 'driver.getConfig', {});
    const initialResult = initial as { result: DriverRoutingSnapshot };

    const updated = await call(dispatcher, 'driver.updateRouting', {
      expected_revision: initialResult.result.revision,
      default_driver: 'codex',
      roles: {},
    });
    expect(updated).toMatchObject({ result: { default_driver: 'codex' } });
    expect(readFileSync(uiDriverRoutingPath(projectRoot), 'utf-8')).toContain('default_driver: codex');

    const stale = await call(dispatcher, 'driver.updateRouting', {
      expected_revision: initialResult.result.revision,
      default_driver: 'claude',
      roles: {},
    });
    expect(stale).toMatchObject({ error: { code: JSON_RPC_ERROR_CODES.DRIVER_CONFIG_CONFLICT } });

    const currentRevision = (updated as { result: DriverRoutingSnapshot }).result.revision;
    const reset = await call(dispatcher, 'driver.resetRouting', {
      expected_revision: currentRevision,
    });

    expect(reset).toMatchObject({ result: { default_driver: 'claude' } });
    expect((reset as { result: DriverRoutingSnapshot }).result.revision).toBe(
      initialResult.result.revision,
    );
  });
});

/**
 * `NEWIDE_DRIVER` 锁定 default driver 的 RPC 面。
 *
 * 关键断言是「稳定错误码 + 结构化 data + 没有落文件 + getConfig 仍是有效值」：前端据此
 * 能提示「本部署锁定在 claude」，而不是显示一个保存成功却毫无效果的假象。
 */
describe('driver.* with NEWIDE_DRIVER locking the default driver', () => {
  function createLockedRouting(projectRoot: string, homeDir: string): DriverRoutingService {
    return new DriverRoutingService({
      projectRoot,
      env: { NEWIDE_DRIVER: 'claude' },
      homeDir,
      registry: {
        listDriverIds: () => ['claude', 'codex'],
        get: () => {
          throw new Error('handles are not needed by the RPC layer');
        },
      },
      knownRoleIds: async () => ['reviewer'],
    });
  }

  function writeBaseProject(projectRoot: string): void {
    mkdirSync(join(projectRoot, '.agent'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agent', 'drivers.yaml'),
      [
        'version: 1',
        'default_driver: claude',
        'drivers:',
        '  claude:',
        '    agent: claude',
        '  codex:',
        '    agent: codex',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  it('rejects default_driver changes with a stable code and no file write', async () => {
    const projectRoot = makeTempDir();
    const homeDir = makeTempDir('newide-driver-methods-home-');
    writeBaseProject(projectRoot);
    const dispatcher = dispatcherFor(
      createDriverMethodsService(createLockedRouting(projectRoot, homeDir)),
    );

    const initial = (await call(dispatcher, 'driver.getConfig', {})) as {
      result: DriverRoutingSnapshot;
    };
    expect(initial.result.default_driver).toBe('claude');

    const rejected = await call(dispatcher, 'driver.updateRouting', {
      expected_revision: initial.result.revision,
      default_driver: 'codex',
      roles: {},
    });

    expect(rejected).toMatchObject({
      error: {
        code: JSON_RPC_ERROR_CODES.DRIVER_DEFAULT_LOCKED,
        data: {
          reason: 'default_driver_locked',
          field: 'default_driver',
          driver_id: 'codex',
          locked_driver_id: 'claude',
        },
      },
    });
    // 没有落任何文件
    expect(existsSync(uiDriverRoutingPath(projectRoot))).toBe(false);
    // 有效配置仍是锁定值
    const after = (await call(dispatcher, 'driver.getConfig', {})) as {
      result: DriverRoutingSnapshot;
    };
    expect(after.result.default_driver).toBe('claude');
    expect(after.result.revision).toBe(initial.result.revision);
  });

  it('allows role mapping updates that keep the locked default', async () => {
    const projectRoot = makeTempDir();
    const homeDir = makeTempDir('newide-driver-methods-home-');
    writeBaseProject(projectRoot);
    const dispatcher = dispatcherFor(
      createDriverMethodsService(createLockedRouting(projectRoot, homeDir)),
    );

    const initial = (await call(dispatcher, 'driver.getConfig', {})) as {
      result: DriverRoutingSnapshot;
    };
    const updated = await call(dispatcher, 'driver.updateRouting', {
      expected_revision: initial.result.revision,
      default_driver: 'claude',
      roles: { reviewer: 'codex' },
    });

    expect(updated).toMatchObject({ result: { default_driver: 'claude' } });
    expect(readFileSync(uiDriverRoutingPath(projectRoot), 'utf-8')).toContain(
      'reviewer: codex',
    );

    // reset 之后有效值仍然是被锁定的 driver（reset 本身允许执行）
    const currentRevision = (updated as { result: DriverRoutingSnapshot }).result.revision;
    const reset = (await call(dispatcher, 'driver.resetRouting', {
      expected_revision: currentRevision,
    })) as { result: DriverRoutingSnapshot };
    expect(reset.result.default_driver).toBe('claude');
    expect(existsSync(uiDriverRoutingPath(projectRoot))).toBe(false);
  });

  it('reports the env-locked driver even when the UI file disagrees', async () => {
    const projectRoot = makeTempDir();
    const homeDir = makeTempDir('newide-driver-methods-home-');
    writeBaseProject(projectRoot);
    // 外部留下的 UI 覆盖说 codex；有效值必须由 env 决定
    writeFileSync(
      uiDriverRoutingPath(projectRoot),
      ['version: 1', 'default_driver: codex', 'roles: {}', ''].join('\n'),
      'utf-8',
    );
    const dispatcher = dispatcherFor(
      createDriverMethodsService(createLockedRouting(projectRoot, homeDir)),
    );

    const snapshot = (await call(dispatcher, 'driver.getConfig', {})) as {
      result: DriverRoutingSnapshot;
    };

    expect(snapshot.result.default_driver).toBe('claude');
  });
});
