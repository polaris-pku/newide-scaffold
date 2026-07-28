import { describe, expect, it, vi } from 'vitest';
import { RunNotFoundError, type AppRunEvent } from '../../src/app/run-registry';
import { JsonRpcDispatcher, JsonRpcLineSession } from '../../src/rpc/json-rpc-dispatcher';
import { RunRpcMethods, type RunMethodsService } from '../../src/rpc/run-methods';

describe('RunRpcMethods', () => {
  it('validates create params and maps run not found errors', async () => {
    const output: string[] = [];
    const service = fakeService();
    const dispatcher = new JsonRpcDispatcher();
    const session = new JsonRpcLineSession(dispatcher, (line) => output.push(line));
    new RunRpcMethods(service, (method, params) =>
      session.sendNotification(method, params),
    ).register(dispatcher);

    await session.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"run.create","params":{"prompt":"  "}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":2,"method":"run.getSnapshot","params":{"run_id":"missing"}}',
    );

    expect(output.map((line) => JSON.parse(line))).toMatchObject([
      { id: 1, error: { code: -32602, message: 'Invalid params' } },
      {
        id: 2,
        error: { code: -32004, message: 'Run not found', data: { run_id: 'missing' } },
      },
    ]);
  });

  it('creates runs and forwards subscribed events as notifications', async () => {
    const output: string[] = [];
    let listener: ((event: AppRunEvent) => void) | undefined;
    const createRun = vi.fn(async () => ({
      run_id: 'run_1',
      task_id: 'task_1',
      status: 'running' as const,
    }));
    const service = fakeService({
      createRun,
      subscribe: (_runId, next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    const dispatcher = new JsonRpcDispatcher();
    const session = new JsonRpcLineSession(dispatcher, (line) => output.push(line));
    const methods = new RunRpcMethods(service, (method, params) =>
      session.sendNotification(method, params),
    );
    methods.register(dispatcher);

    await session.handleLine(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'run.create',
        params: {
          prompt: 'Build RPC',
          workspace_path: process.cwd(),
          session_id: 'session_existing',
        },
      })}`,
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":2,"method":"run.subscribe","params":{"run_id":"run_1"}}',
    );
    listener?.({
      event_id: 'run_event_3',
      sequence: 3,
      run_id: 'run_1',
      task_id: 'task_1',
      type: 'run.failed',
      source: 'coordinator',
      created_at: '2026-07-11T08:00:00.000Z',
      payload: {
        code: 'GATE_DENIED',
        message: 'Gate policy-gate denied the run',
        details: { phase: 'gate' },
      },
      schema_version: 'v0',
    });
    await session.handleLine(
      '{"jsonrpc":"2.0","id":3,"method":"run.unsubscribe","params":{"run_id":"run_1"}}',
    );

    expect(output.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', id: 1, result: { run_id: 'run_1', task_id: 'task_1', status: 'running' } },
      { jsonrpc: '2.0', id: 2, result: { subscribed: true } },
      {
        jsonrpc: '2.0',
        method: 'run.event',
        params: {
          run_id: 'run_1',
          event: {
            event_id: 'run_event_3',
            sequence: 3,
            run_id: 'run_1',
            task_id: 'task_1',
            type: 'run.failed',
            source: 'coordinator',
            created_at: '2026-07-11T08:00:00.000Z',
            payload: {
              code: 'GATE_DENIED',
              message: 'Gate policy-gate denied the run',
              details: { phase: 'gate' },
            },
            schema_version: 'v0',
          },
        },
      },
      { jsonrpc: '2.0', id: 3, result: { unsubscribed: true } },
    ]);
    expect(listener).toBeUndefined();
    expect(createRun).toHaveBeenCalledWith({
      prompt: 'Build RPC',
      workspace_path: process.cwd(),
      session_id: 'session_existing',
    });
  });

  it('forwards run.cancel to the application service', async () => {
    const output: string[] = [];
    const service = fakeService({ cancelRun: async () => ({ cancelled: true }) });
    const dispatcher = new JsonRpcDispatcher();
    const session = new JsonRpcLineSession(dispatcher, (line) => output.push(line));
    new RunRpcMethods(service, () => undefined).register(dispatcher);

    await session.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"run.cancel","params":{"run_id":"run_1"}}',
    );

    expect(JSON.parse(output[0]!)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { cancelled: true },
    });
  });

  it('returns the external RunSnapshot view from run.getSnapshot', async () => {
    const output: string[] = [];
    const service = fakeService({
      getRunSnapshot: () => ({
        schema_version: 'v0',
        run_id: 'run_1',
        task_id: 'task_1',
        mode: 'single_agent',
        status: 'running',
        current: { stage: 'executing', active_node_code: 'N3' },
        timeline: [],
        agent_runs: [],
        artifacts: [],
        gates: [],
        errors: [],
      }),
    });
    const dispatcher = new JsonRpcDispatcher();
    const session = new JsonRpcLineSession(dispatcher, (line) => output.push(line));
    new RunRpcMethods(service, () => undefined).register(dispatcher);

    await session.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"run.getSnapshot","params":{"run_id":"run_1"}}',
    );

    expect(JSON.parse(output[0]!)).toMatchObject({
      id: 1,
      result: { run_id: 'run_1', status: 'running', timeline: [], errors: [] },
    });
  });
});

function fakeService(overrides?: Partial<RunMethodsService>): RunMethodsService {
  return {
    createRun: async () => ({ run_id: 'run_1', task_id: 'task_1', status: 'running' }),
    getRunSnapshot: (runId) => {
      throw new RunNotFoundError(runId);
    },
    subscribe: () => () => undefined,
    cancelRun: async () => ({ cancelled: true }),
    ...overrides,
  };
}
