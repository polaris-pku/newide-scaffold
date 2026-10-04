import { describe, expect, it, vi } from 'vitest';
import { RunNotFoundError, type AppRunEvent } from '../../src/app/run-registry';
import { JsonRpcDispatcher, JsonRpcLineSession } from '../../src/rpc/json-rpc-dispatcher';
import { JSON_RPC_ERROR_CODES } from '../../src/rpc/json-rpc-line-protocol';
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

  it('accepts the accumulation-frozen memory ablation and rejects unknown levels', async () => {
    const output: string[] = [];
    const createRun = vi.fn(async () => ({
      run_id: 'run_1',
      task_id: 'task_1',
      status: 'running' as const,
    }));
    const service = fakeService({ createRun });
    const dispatcher = new JsonRpcDispatcher();
    const session = new JsonRpcLineSession(dispatcher, (line) => output.push(line));
    new RunRpcMethods(service, (method, params) =>
      session.sendNotification(method, params),
    ).register(dispatcher);

    await session.handleLine(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'run.create',
        params: {
          prompt: 'Build RPC',
          workspace_path: process.cwd(),
          memory_ablation: 'B4',
        },
      })}`,
    );
    await session.handleLine(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'run.create',
        params: {
          prompt: 'Build RPC',
          workspace_path: process.cwd(),
          memory_ablation: 'B5',
        },
      })}`,
    );

    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({ memory_ablation: 'B4' }),
    );
    expect(output.map((line) => JSON.parse(line))[1]).toMatchObject({
      id: 2,
      error: { code: -32602, message: 'Invalid params' },
    });
  });

  it('passes a reconnect watermark through to the subscription', async () => {
    // 断线重连的水位必须原样传到注册表：`run.subscribe` 过去没有这个参数，
    // 重连只能全量重放 + 靠 event_id 去重。
    const output: string[] = [];
    const calls: Array<[string, number | undefined]> = [];
    const service = fakeService({
      subscribe: (runId, _next, afterSequence) => {
        calls.push([runId, afterSequence]);
        return () => undefined;
      },
    });
    const dispatcher = new JsonRpcDispatcher();
    const session = new JsonRpcLineSession(dispatcher, (line) => output.push(line));
    new RunRpcMethods(service, (method, params) => session.sendNotification(method, params)).register(
      dispatcher,
    );

    await session.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"run.subscribe","params":{"run_id":"run_1","after_sequence":7}}',
    );

    expect(calls).toEqual([['run_1', 7]]);
    expect(JSON.parse(output[0]!)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { subscribed: true },
    });
  });

  it('resolves an externalized payload ref and reports an unresolvable one as unavailable', async () => {
    // 超限字段只留引用不内联；取回口此前完全缺失，前端能看见引用却永远拿不到内容。
    const output: string[] = [];
    const service = fakeService({
      getRunPayload: async (_runId, payloadRef) =>
        payloadRef.endsWith('=42')
          ? { payload_ref: payloadRef, event: { event_type: 'tool_call' } as never }
          : undefined,
    });
    const dispatcher = new JsonRpcDispatcher();
    const session = new JsonRpcLineSession(dispatcher, (line) => output.push(line));
    new RunRpcMethods(service, (method, params) => session.sendNotification(method, params)).register(
      dispatcher,
    );

    await session.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"run.getPayload","params":{"run_id":"run_1","payload_ref":"driver-stream.jsonl#stream_sequence=42"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":2,"method":"run.getPayload","params":{"run_id":"run_1","payload_ref":"driver-stream.jsonl#stream_sequence=99"}}',
    );
    // 引用形状不对：参数校验就该拦下，而不是去读文件。
    await session.handleLine(
      '{"jsonrpc":"2.0","id":3,"method":"run.getPayload","params":{"run_id":"run_1","payload_ref":"nonsense"}}',
    );

    const responses = output.map((line) => JSON.parse(line));
    expect(responses[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        payload_ref: 'driver-stream.jsonl#stream_sequence=42',
        event: { event_type: 'tool_call' },
      },
    });
    // 取不到时报错而不是返回空——前端才能区分它和「本来就没有引用」。
    expect(responses[1]).toMatchObject({
      id: 2,
      error: { code: JSON_RPC_ERROR_CODES.PAYLOAD_REF_UNAVAILABLE },
    });
    expect(responses[2]).toMatchObject({
      id: 3,
      error: { code: JSON_RPC_ERROR_CODES.INVALID_PARAMS },
    });
  });

  it('requires a subject for task and role scopes and forwards the usage query', async () => {
    const output: string[] = [];
    const calls: Array<{ scope: string; scope_id?: string; run_id?: string }> = [];
    const service = fakeService({
      getRunUsage: async (input) => {
        calls.push(input);
        return { history: { scope: input.scope, runs_counted: 0, complete: false } } as never;
      },
    });
    const dispatcher = new JsonRpcDispatcher();
    const session = new JsonRpcLineSession(dispatcher, (line) => output.push(line));
    new RunRpcMethods(service, (method, params) => session.sendNotification(method, params)).register(
      dispatcher,
    );

    // task 作用域没有 scope_id：「这个任务的累计」无从谈起，参数校验就该拦下。
    await session.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"run.getUsage","params":{"scope":"task"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":2,"method":"run.getUsage","params":{"scope":"task","scope_id":"task_1","run_id":"run_1"}}',
    );
    // role 现在**支持**了：账本在写入时就把 role_id 记在每一行上，不再受 summary 形状限制。
    await session.handleLine(
      '{"jsonrpc":"2.0","id":3,"method":"run.getUsage","params":{"scope":"role","scope_id":"role_x"}}',
    );
    // 但它同样需要主语：没有 scope_id 的 role 查询照样是 INVALID_PARAMS。
    await session.handleLine(
      '{"jsonrpc":"2.0","id":4,"method":"run.getUsage","params":{"scope":"role"}}',
    );
    // run 作用域是单个 run 的**持久**用量（进程重启后仍然读得到），同样要主语。
    await session.handleLine(
      '{"jsonrpc":"2.0","id":5,"method":"run.getUsage","params":{"scope":"run","scope_id":"run_1"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":6,"method":"run.getUsage","params":{"scope":"run"}}',
    );

    const responses = output.map((line) => JSON.parse(line));
    expect(calls).toEqual([
      { scope: 'task', scope_id: 'task_1', run_id: 'run_1' },
      { scope: 'role', scope_id: 'role_x' },
      { scope: 'run', scope_id: 'run_1' },
    ]);
    expect(responses[0]).toMatchObject({
      id: 1,
      error: { code: JSON_RPC_ERROR_CODES.INVALID_PARAMS },
    });
    expect(responses[1]).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { history: { scope: 'task', runs_counted: 0, complete: false } },
    });
    expect(responses[2]).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { history: { scope: 'role', runs_counted: 0, complete: false } },
    });
    expect(responses[3]).toMatchObject({
      id: 4,
      error: { code: JSON_RPC_ERROR_CODES.INVALID_PARAMS },
    });
    expect(responses[4]).toEqual({
      jsonrpc: '2.0',
      id: 5,
      result: { history: { scope: 'run', runs_counted: 0, complete: false } },
    });
    expect(responses[5]).toMatchObject({
      id: 6,
      error: { code: JSON_RPC_ERROR_CODES.INVALID_PARAMS },
    });
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
    // 这两个与新增的 getRunPayload / getRunUsage 一样，只有被点到的用例才需要真实现；
    // 摆出让这个 helper 与接口保持可赋值（此前缺 listRuns/restartRun，只是没人做类型检查）。
    listRuns: async () => ({ runs: [] }),
    restartRun: async (runId) => ({
      run_id: `${runId}_restart`,
      task_id: 'task_1',
      restarted_from_run_id: runId,
      status: 'running',
    }),
    // 这两个没有「合理的假值」——编一个假的用量历史比明确报错更容易误导用例作者，
    // 所以默认抛错，要用它们的用例显式给 override。
    getRunPayload: async () => {
      throw new Error('getRunPayload fixture is not configured');
    },
    getRunUsage: async () => {
      throw new Error('getRunUsage fixture is not configured');
    },
    ...overrides,
  };
}
