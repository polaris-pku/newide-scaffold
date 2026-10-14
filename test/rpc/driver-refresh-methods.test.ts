/**
 * `driver.refresh` 的 RPC 契约。
 *
 * 与 `driver.list` 的关键区别：那一个回原始探测结果（`DriverProbeResult`），这一个回**有效
 * driver 列表**（`DriverRoutingSnapshot`）。错误码则刻意复用同一套 `DRIVER_PROBE_*`——前端
 * 已经按它们做过「重建 runner / 重试」的分支，刷新没有理由换一套词表。
 */

import { describe, expect, it } from 'vitest';

import {
  DriverProbeFailedError,
  DriverProbeUnavailableError,
} from '../../src/driver/driver-probe-service';
import { DriverDiscoveryFileError } from '../../src/driver/driver-discovery-file-store';
import { DriverRpcMethods, type DriverMethodsService } from '../../src/rpc/driver-methods';
import { JsonRpcDispatcher } from '../../src/rpc/json-rpc-dispatcher';
import { JSON_RPC_ERROR_CODES } from '../../src/rpc/json-rpc-line-protocol';

const snapshot = {
  schema_version: 'driver-routing.v1' as const,
  revision: 'sha256:test',
  scope: 'project' as const,
  default_driver: 'claude',
  drivers: [],
  roles: [],
  orphan_roles: [],
};

const routing: DriverMethodsService = {
  getDriverConfig: async () => snapshot,
  updateDriverRouting: async () => snapshot,
  resetDriverRouting: async () => snapshot,
};

function call(dispatcher: JsonRpcDispatcher, method: string, params?: unknown) {
  return dispatcher.dispatch({
    jsonrpc: '2.0',
    id: 1,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

function refreshDispatcher(refresh: (options?: unknown) => Promise<typeof snapshot>) {
  const dispatcher = new JsonRpcDispatcher();
  new DriverRpcMethods(routing, undefined, { refresh: refresh as never }).register(dispatcher);
  return dispatcher;
}

describe('driver.refresh', () => {
  it('forwards the probe options and returns the routing snapshot', async () => {
    const calls: unknown[] = [];
    const dispatcher = refreshDispatcher(async (options) => {
      calls.push(options);
      return snapshot;
    });

    await expect(
      call(dispatcher, 'driver.refresh', { agent_ids: ['claude'], timeout_ms: 2500, force: true }),
    ).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: snapshot });
    expect(calls).toEqual([{ agentIds: ['claude'], timeoutMs: 2500, force: true }]);
  });

  it('accepts an empty params object', async () => {
    const dispatcher = refreshDispatcher(async () => snapshot);

    await expect(call(dispatcher, 'driver.refresh', {})).resolves.toMatchObject({
      result: { schema_version: 'driver-routing.v1' },
    });
  });

  it('rejects unknown or out-of-range parameters', async () => {
    const dispatcher = refreshDispatcher(async () => snapshot);

    for (const params of [{ unknown: 1 }, { timeout_ms: 0 }, { concurrency: 33 }, { agent_ids: [] }]) {
      await expect(call(dispatcher, 'driver.refresh', params)).resolves.toMatchObject({
        error: { code: JSON_RPC_ERROR_CODES.INVALID_PARAMS },
      });
    }
  });

  it.each([
    [new DriverProbeUnavailableError('probe module missing'), 'DRIVER_PROBE_UNAVAILABLE', JSON_RPC_ERROR_CODES.DRIVER_PROBE_UNAVAILABLE],
    [new DriverProbeFailedError('stderr details'), 'DRIVER_PROBE_FAILED', JSON_RPC_ERROR_CODES.DRIVER_PROBE_FAILED],
  ])('maps probe failures to the same codes as driver.list', async (error, reason, code) => {
    const dispatcher = refreshDispatcher(async () => {
      throw error;
    });

    const response = await call(dispatcher, 'driver.refresh', {});

    expect(response).toMatchObject({ error: { code, data: { reason } } });
    // 探测进程的 stderr 细节不穿过 RPC 边界
    expect(JSON.stringify(response)).not.toContain('stderr details');
  });

  it('reports persistence failures with stable, path-free reasons', async () => {
    const persistFailed = refreshDispatcher(async () => {
      throw new DriverDiscoveryFileError(
        'write_failed',
        'DRIVER_DISCOVERY_PERSIST_FAILED',
        'Failed to stage drivers.detected.local.yaml (EACCES)',
      );
    });
    const lockBusy = refreshDispatcher(async () => {
      throw new DriverDiscoveryFileError(
        'lock_busy',
        'DRIVER_DISCOVERY_LOCK_BUSY',
        'Driver discovery file is being written by another writer (timed out)',
      );
    });

    await expect(call(persistFailed, 'driver.refresh', {})).resolves.toMatchObject({
      error: {
        code: JSON_RPC_ERROR_CODES.DRIVER_DISCOVERY_PERSIST_FAILED,
        data: { reason: 'DRIVER_DISCOVERY_PERSIST_FAILED' },
      },
    });
    await expect(call(lockBusy, 'driver.refresh', {})).resolves.toMatchObject({
      error: {
        code: JSON_RPC_ERROR_CODES.DRIVER_DISCOVERY_LOCK_BUSY,
        data: { reason: 'DRIVER_DISCOVERY_LOCK_BUSY' },
      },
    });
  });

  it('is not registered when the assembly has no discovery service', async () => {
    const dispatcher = new JsonRpcDispatcher();
    new DriverRpcMethods(routing).register(dispatcher);

    const response = await call(dispatcher, 'driver.refresh', {});

    expect(response).toMatchObject({
      error: { code: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND },
    });
  });
});
