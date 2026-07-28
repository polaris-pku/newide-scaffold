import { describe, expect, it, vi } from 'vitest';
import {
  TaskAlreadyRunningError,
  TaskNotBlockedError,
  TaskNotFoundError,
  TaskNotRunningError,
} from '../../src/app/newide-backend-service';
import { JsonRpcDispatcher, JsonRpcLineSession } from '../../src/rpc/json-rpc-dispatcher';
import { TaskRpcMethods, type TaskMethodsService } from '../../src/rpc/task-methods';
import type { TaskSnapshot } from '../../src/protocol/task-snapshot';
import type { AppRunEvent } from '../../src/app/run-registry';
import { TaskEventCursorNotFoundError } from '../../src/app/task-processor';

describe('TaskRpcMethods', () => {
  it('validates task.create and exposes create/get/list', async () => {
    const output: string[] = [];
    const createTask = vi.fn(async () => snapshot('task_1'));
    const service = fakeService({ createTask });
    const session = sessionWith(service, output);

    await session.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'task.create',
        params: {
          spec: 'Build Task RPC',
          role_id: 'role_backend_engineer',
          risk_level: 'medium',
          affected_paths: ['src/rpc/**'],
          completion_criteria: ['JSON-RPC acceptance passes'],
          budget: { max_tool_calls: 20 },
          workspace_path: process.cwd(),
        },
      }),
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":2,"method":"task.get","params":{"task_id":"task_1"}}',
    );
    await session.handleLine('{"jsonrpc":"2.0","id":3,"method":"task.list","params":{}}');
    await session.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'task.create',
        params: {
          spec: 'Invalid',
          completion_criteria: [],
          workspace_path: 'relative/path',
        },
      }),
    );

    expect(output.map((line) => JSON.parse(line))).toMatchObject([
      { id: 1, result: { task: { task_id: 'task_1' } } },
      { id: 2, result: { task: { task_id: 'task_1' } } },
      { id: 3, result: { tasks: [{ task: { task_id: 'task_1' } }] } },
      { id: 4, error: { code: -32602, message: 'Invalid params' } },
    ]);
    expect(createTask).toHaveBeenCalledWith({
      spec: 'Build Task RPC',
      role_id: 'role_backend_engineer',
      risk_level: 'medium',
      affected_paths: ['src/rpc/**'],
      completion_criteria: ['JSON-RPC acceptance passes'],
      budget: { max_tool_calls: 20 },
      workspace_path: process.cwd(),
    });
  });

  it('forwards cancel/startCouncil and maps Task errors', async () => {
    const output: string[] = [];
    const cancelTask = vi.fn(async () => snapshot('task_cancelled', 'cancelled'));
    const startCouncil = vi.fn(async () => snapshot('task_council'));
    const service = fakeService({
      cancelTask,
      startCouncil,
      getTask: async (taskId) => {
        throw new TaskNotFoundError(taskId);
      },
    });
    const session = sessionWith(service, output);

    await session.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"task.cancel","params":{"task_id":"task_cancelled"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":2,"method":"task.startCouncil","params":{"task_id":"task_council"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":3,"method":"task.get","params":{"task_id":"missing"}}',
    );

    const runningService = fakeService({
      startCouncil: async (taskId) => {
        throw new TaskAlreadyRunningError(taskId);
      },
      cancelTask: async (taskId) => {
        throw new TaskNotRunningError(taskId);
      },
    });
    const runningSession = sessionWith(runningService, output);
    await runningSession.handleLine(
      '{"jsonrpc":"2.0","id":4,"method":"task.startCouncil","params":{"task_id":"task_busy"}}',
    );
    await runningSession.handleLine(
      '{"jsonrpc":"2.0","id":5,"method":"task.cancel","params":{"task_id":"task_done"}}',
    );
    const cursorSession = sessionWith(
      fakeService({
        subscribeTask: async (taskId, _listener, eventId) => {
          throw new TaskEventCursorNotFoundError(taskId, eventId ?? 'missing');
        },
      }),
      output,
    );
    await cursorSession.handleLine(
      '{"jsonrpc":"2.0","id":6,"method":"task.subscribe","params":{"task_id":"task_done","after_event_id":"event_missing"}}',
    );

    expect(output.map((line) => JSON.parse(line))).toMatchObject([
      { id: 1, result: { task: { task_id: 'task_cancelled', status: 'cancelled' } } },
      { id: 2, result: { task: { task_id: 'task_council' } } },
      { id: 3, error: { code: -32006, message: 'Task not found' } },
      { id: 4, error: { code: -32007, message: 'Task already running' } },
      { id: 5, error: { code: -32008, message: 'Task not running' } },
      { id: 6, error: { code: -32009, message: 'Task event cursor not found' } },
    ]);
    expect(cancelTask).toHaveBeenCalledWith('task_cancelled');
    expect(startCouncil).toHaveBeenCalledWith('task_council');
  });

  it('resumes a blocked Task and rejects a Task that is not blocked', async () => {
    const output: string[] = [];
    const resumeTask = vi.fn(async () => snapshot('task_resumed'));
    const resumableService = { ...fakeService(), resumeTask };
    const resumableSession = sessionWith(resumableService, output);
    await resumableSession.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"task.resume","params":{"task_id":"task_resumed"}}',
    );

    const rejectedService = {
      ...fakeService(),
      resumeTask: async (taskId: string) => {
        throw new TaskNotBlockedError(taskId);
      },
    };
    const rejectedSession = sessionWith(rejectedService, output);
    await rejectedSession.handleLine(
      '{"jsonrpc":"2.0","id":2,"method":"task.resume","params":{"task_id":"task_done"}}',
    );

    expect(output.map((line) => JSON.parse(line))).toMatchObject([
      { id: 1, result: { task: { task_id: 'task_resumed' } } },
      { id: 2, error: { code: -32010, message: 'Task not blocked' } },
    ]);
    expect(resumeTask).toHaveBeenCalledWith('task_resumed');
  });

  it('subscribes to Task events and returns the current snapshot', async () => {
    const output: string[] = [];
    let listener: ((event: AppRunEvent) => void) | undefined;
    const subscribeTask = vi.fn(async (_taskId: string, next: (event: AppRunEvent) => void) => {
      listener = next;
      return {
        snapshot: snapshot('task_1'),
        replay_events: [
          {
            event_id: 'event_replayed',
            sequence: 4,
            run_id: 'run_1',
            task_id: 'task_1',
            type: 'gate.result',
            source: 'gate' as const,
            created_at: '2026-07-19T00:00:01.000Z',
            payload: {},
            schema_version: 'v0',
          },
        ],
        unsubscribe: () => {
          listener = undefined;
        },
      };
    });
    const service = fakeService({
      subscribeTask,
    });
    const session = sessionWith(service, output);

    await session.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"task.subscribe","params":{"task_id":"task_1","after_event_id":"event_previous"}}',
    );
    listener?.({
      event_id: 'event_1',
      sequence: 1,
      run_id: 'run_1',
      task_id: 'task_1',
      type: 'council.started',
      source: 'council',
      created_at: '2026-07-19T00:00:02.000Z',
      payload: {},
      schema_version: 'v0',
    });
    await session.handleLine(
      '{"jsonrpc":"2.0","id":2,"method":"task.unsubscribe","params":{"task_id":"task_1"}}',
    );

    expect(output.map((line) => JSON.parse(line))).toMatchObject([
      {
        id: 1,
        result: {
          subscribed: true,
          snapshot: { task: { task_id: 'task_1' } },
          replay_events: [{ event_id: 'event_replayed', type: 'gate.result' }],
        },
      },
      {
        method: 'task.event',
        params: {
          task_id: 'task_1',
          event: { event_id: 'event_1', run_id: 'run_1', type: 'council.started' },
        },
      },
      { id: 2, result: { unsubscribed: true } },
    ]);
    expect(listener).toBeUndefined();
    expect(subscribeTask).toHaveBeenCalledWith('task_1', expect.any(Function), 'event_previous');
  });
});

function sessionWith(service: TaskMethodsService, output: string[]): JsonRpcLineSession {
  const dispatcher = new JsonRpcDispatcher();
  const session = new JsonRpcLineSession(dispatcher, (line) => output.push(line));
  new TaskRpcMethods(service, (method, params) =>
    session.sendNotification(method, params),
  ).register(dispatcher);
  return session;
}

function fakeService(overrides: Partial<TaskMethodsService> = {}): TaskMethodsService {
  return {
    createTask: async () => snapshot('task_1'),
    getTask: async () => snapshot('task_1'),
    listTasks: async () => ({ tasks: [snapshot('task_1')] }),
    cancelTask: async () => snapshot('task_1', 'cancelled'),
    resumeTask: async () => snapshot('task_1'),
    startCouncil: async () => snapshot('task_1'),
    subscribeTask: async (_taskId, _listener) => ({
      snapshot: snapshot('task_1'),
      replay_events: [],
      unsubscribe: () => undefined,
    }),
    ...overrides,
  };
}

function snapshot(
  taskId: string,
  status: TaskSnapshot['task']['status'] = 'running',
): TaskSnapshot {
  return {
    contract_version: 'task-snapshot.v0',
    schema_version: 'v0',
    revision: 1,
    task: {
      task_id: taskId,
      status,
      risk_level: 'low',
      spec: 'Task',
      completion_criteria: ['Done'],
      affected_paths: [],
      created_at: '2026-07-19T00:00:00.000Z',
      updated_at: '2026-07-19T00:00:01.000Z',
      schema_version: 'v0',
    },
    run_history: [],
    warnings: [],
  };
}
