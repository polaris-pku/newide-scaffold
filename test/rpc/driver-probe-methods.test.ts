import { describe, expect, it } from 'vitest';
import {
  DriverProbeFailedError,
  DriverProbeUnavailableError,
} from '../../src/driver/driver-probe-service';
import { DriverRpcMethods, type DriverMethodsService } from '../../src/rpc/driver-methods';
import { JsonRpcDispatcher } from '../../src/rpc/json-rpc-dispatcher';
import { JSON_RPC_ERROR_CODES } from '../../src/rpc/json-rpc-line-protocol';

const routing: DriverMethodsService = {
  getDriverConfig: async () => ({
    schema_version: 'driver-routing.v1',
    revision: 'sha256:test',
    scope: 'project',
    default_driver: 'claude',
    drivers: [],
    roles: [],
    orphan_roles: [],
  }),
  updateDriverRouting: async () => routing.getDriverConfig(),
  resetDriverRouting: async () => routing.getDriverConfig(),
};

function call(dispatcher: JsonRpcDispatcher, method: string, params?: unknown) {
  return dispatcher.dispatch({
    jsonrpc: '2.0',
    id: 1,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

describe('driver.list / driver.probe', () => {
  it('validates options and forwards them to ACP', async () => {
    const calls: unknown[] = [];
    const dispatcher = new JsonRpcDispatcher();
    new DriverRpcMethods(routing, {
      probe: async (options) => {
        calls.push(options);
        return { schema_version: 'driver-probe.v1', generated_at: '2026-10-13T00:00:00.000Z', drivers: [] };
      },
    }).register(dispatcher);

    await expect(
      call(dispatcher, 'driver.list', {
        agent_ids: ['claude'],
        timeout_ms: 2500,
        concurrency: 2,
        force: true,
      }),
    ).resolves.toMatchObject({ result: { schema_version: 'driver-probe.v1' } });
    expect(calls).toEqual([
      { agentIds: ['claude'], timeoutMs: 2500, concurrency: 2, force: true },
    ]);
    await expect(call(dispatcher, 'driver.probe', { timeout_ms: 0 })).resolves.toMatchObject({
      error: { code: JSON_RPC_ERROR_CODES.INVALID_PARAMS },
    });
  });

  it('maps an unavailable ACP probe to a stable RPC error', async () => {
    const dispatcher = new JsonRpcDispatcher();
    new DriverRpcMethods(routing, {
      probe: async () => {
        throw new DriverProbeUnavailableError('probe module missing');
      },
    }).register(dispatcher);

    await expect(call(dispatcher, 'driver.list', {})).resolves.toMatchObject({
      error: {
        code: JSON_RPC_ERROR_CODES.DRIVER_PROBE_UNAVAILABLE,
        data: { reason: 'DRIVER_PROBE_UNAVAILABLE' },
      },
    });
  });

  it('does not expose probe process diagnostics through JSON-RPC', async () => {
    const dispatcher = new JsonRpcDispatcher();
    new DriverRpcMethods(routing, {
      probe: async () => {
        throw new DriverProbeFailedError('private stderr details');
      },
    }).register(dispatcher);

    await expect(call(dispatcher, 'driver.list', {})).resolves.toMatchObject({
      error: {
        code: JSON_RPC_ERROR_CODES.DRIVER_PROBE_FAILED,
        message: 'ACP driver probe failed',
        data: { reason: 'DRIVER_PROBE_FAILED' },
      },
    });
  });
});
