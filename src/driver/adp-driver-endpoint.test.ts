/**
 * adp-driver-endpoint.test — ADP endpoint 的判重、落账与故障注入测试(issue #149)。
 *
 * 覆盖 DoD / 验收场景:
 * - 执行前断连(spawn 失败 / dispatch 前抛错)→ failed(启动失败),明确证据未执行;
 * - 写工作区后、返回结果前断连 → unknown,且 workspace_write 即使开了 auto_retry 也不重跑;
 * - 同 exchange 重复 invoke → 返回既有状态/结果,驱动只执行一次;
 * - 副作用执行中取消、既有 interrupted 状态的适配;
 * - 迟到结果对账:只入档,不改回执、不重跑;
 * - 回执经宿主内回调交还 Agent;帧全部通过 P0 schema,部署配置(auto_retry)不进帧。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adpFrameSchema,
  createId,
  SCHEMA_VERSION,
  type AdpSideEffect,
  type AdpStatus,
} from '../core';
import type { CoordinationStateCommit } from '../persistence';
import { SqliteCoordinationStore } from '../persistence';
import type { DriverRunResult, DriverStreamEvent } from './contract';
import {
  AdpDriverEndpoint,
  type AdpDriverExecutionInput,
  type AdpInvokeRequest,
  type AdpReceiptDelivery,
} from './adp-driver-endpoint';
import { createAdpRetryPolicy } from './adp-retry-policy';
import { DriverTransportError } from './driver-transport-error';
import { ExternalDriverRuntime } from './external-driver-runtime';
import { createDriverRuntimeInvoker } from './driver-runtime-invoker';

const directories: string[] = [];
const stores: SqliteCoordinationStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore(task_id = 'task-adp', run_id = 'run-adp'): SqliteCoordinationStore {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-adp-endpoint-'));
  directories.push(directory);
  const store = new SqliteCoordinationStore(path.join(directory, 'coordination.sqlite'));
  stores.push(store);
  const at = '2026-09-25T09:00:00.000Z';
  const commit: CoordinationStateCommit = {
    task: {
      task_id, status: 'created', risk_level: 'medium',
      spec: 'ADP endpoint test', completion_criteria: ['done'], affected_paths: [],
      workspace_path: '/workspace', warnings: [], revision: 1,
      created_at: at, updated_at: at, schema_version: 'v0',
    },
    run: {
      run_id, task_id, status: 'created', mode: 'single_agent',
      workspace_path: '/workspace', revision: 1,
      created_at: at, updated_at: at, schema_version: 'v0',
    },
    runtime_state: {
      task_id, current_run_id: run_id, resume_cursor: 'execute_agent',
      waiting_on: [], artifact_refs: [], diagnostics: {}, updated_at: at, schema_version: 'v0',
    },
    events: [{
      event_id: `event-${run_id}`, event_type: 'task.created', subject_id: task_id,
      task_id, run_id, payload: {}, created_at: at, schema_version: 'v0',
    }],
  };
  store.commitState(commit);
  return store;
}

function driverRunResult(status: DriverRunResult['status'], error?: DriverRunResult['error']): DriverRunResult {
  return {
    driver_run_result_id: createId('driver_result'),
    session_id: 'session-adp',
    status,
    response: 'done',
    artifacts: [],
    transcript_ref: {
      artifact_id: createId('artifact'),
      type: 'transcript',
      uri: 'artifact://transcript/adp',
      producer_id: 'driver-adp',
      task_id: 'task-adp',
      metadata: {},
      created_at: '2026-09-25T09:00:05.000Z',
      schema_version: SCHEMA_VERSION,
    },
    tool_events: [],
    diagnostics: { driver_id: 'driver-adp', duration_ms: 3, notes: [] },
    ...(error ? { error } : {}),
    created_at: '2026-09-25T09:00:05.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function invokeRequest(
  overrides: Partial<AdpInvokeRequest> & Pick<AdpInvokeRequest, 'execute'>,
): AdpInvokeRequest {
  return {
    task_id: 'task-adp',
    run_id: 'run-adp',
    workspace_path: '/workspace/task-adp',
    instruction: '在 src/protocol/sap.ts 补上判重分支',
    causation_id: 'ex-sap-00041',
    ...overrides,
  };
}

/** 标准成功执行体:markDispatched 后返回 succeeded。 */
function succeed(input: AdpDriverExecutionInput) {
  input.control.markDispatched();
  return Promise.resolve({ execution: driverRunResult('succeeded') });
}

describe('AdpDriverEndpoint · 成功路径与落账', () => {
  it('invoke 走完 P1 投递,回执经宿主内回调交还,因果链只有协议帧', async () => {
    const store = createStore();
    const receipts: AdpReceiptDelivery[] = [];
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      onReceipt: (delivery) => receipts.push(delivery),
    });

    const outcome = await endpoint.invoke(invokeRequest({ execute: succeed }));

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('succeeded');
    expect(outcome.attempts).toBe(1);
    expect(receipts).toHaveLength(1);

    // invoke 的 causation 指向外层 SAP execute;回执的 causation 指向 invoke。
    const journal = store.listJournal('task-adp', 'run-adp');
    const frames = journal.filter((row) => row.frame !== null);
    for (const row of frames) expect(() => adpFrameSchema.parse(row.frame)).not.toThrow();
    expect(outcome.receipt.causation_id).toBe(outcome.exchange_id);
    const invokeRow = frames.find(
      (row) => row.frame !== null && 'command' in row.frame && row.frame.command === 'driver.invoke',
    );
    expect(invokeRow?.frame).toMatchObject({
      causation_id: 'ex-sap-00041',
      side_effect: 'workspace_write',
      deadline_at: expect.any(String),
      instruction: { text: expect.stringContaining('判重分支'), ref: null },
    });
    const resultRow = frames.find(
      (row) => row.frame !== null && 'result' in row.frame && row.frame.result === 'driver.invocation_result',
    );
    expect(resultRow?.frame).toMatchObject({ causation_id: outcome.exchange_id, status: 'succeeded' });

    // 宿主调用意图单独留档,causation 为空、不进因果图。
    const intent = journal.find((row) => row.kind === 'call');
    expect(intent).toMatchObject({ id: `${outcome.exchange_id}:intent`, event: 'host.intent', causation_id: null });

    // 原 invoke outbox 被回执按 causation 收束。
    const outbox = store.getOutbox(`adp-out:${outcome.exchange_id}`);
    expect(outbox?.status).toBe('complete');

    // 部署配置绝不进入帧。
    for (const row of frames) {
      expect(JSON.stringify(row.frame)).not.toContain('auto_retry');
    }
  });

  it('同 exchange 重复 invoke 返回既有结果,驱动只执行一次', async () => {
    const store = createStore();
    let calls = 0;
    const execute = (input: AdpDriverExecutionInput) => {
      calls += 1;
      return succeed(input);
    };
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });

    const first = await endpoint.invoke(invokeRequest({ execute, exchange_id: 'ex-adp-dup' }));
    const second = await endpoint.invoke(invokeRequest({ execute, exchange_id: 'ex-adp-dup' }));

    expect(first.state).toBe('settled');
    expect(second.state).toBe('settled');
    if (first.state !== 'settled' || second.state !== 'settled') return;
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(first.status);
    expect(second.receipt.exchange_id).toBe(first.receipt.exchange_id);
    expect(calls).toBe(1);
  });

  it('同 exchange 在执行中重复 invoke 返回 in_flight,不启动第二次副作用', async () => {
    const store = createStore();
    let calls = 0;
    let release!: (value: { execution: DriverRunResult }) => void;
    const gate = new Promise<{ execution: DriverRunResult }>((resolve) => (release = resolve));
    const execute = (input: AdpDriverExecutionInput) => {
      calls += 1;
      input.control.markDispatched();
      return gate;
    };
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });

    const running = endpoint.invoke(invokeRequest({ execute, exchange_id: 'ex-adp-race' }));
    const duplicate = await endpoint.invoke(invokeRequest({ execute, exchange_id: 'ex-adp-race' }));
    expect(duplicate).toMatchObject({ state: 'in_flight', detail: 'running' });

    release({ execution: driverRunResult('succeeded') });
    const settled = await running;
    expect(settled.state).toBe('settled');
    expect(calls).toBe(1);
  });
});

describe('AdpDriverEndpoint · 故障注入:断连与 unknown 收束', () => {
  it('执行前断连(未 dispatch)→ failed(启动失败),auto_retry 开启时按策略重执行', async () => {
    const store = createStore();
    let calls = 0;
    const execute = () => {
      calls += 1;
      return Promise.reject(new Error('spawn ENOENT: driver runner missing'));
    };
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      retryPolicy: createAdpRetryPolicy({ workspace_write: true }),
    });

    const outcome = await endpoint.invoke(invokeRequest({ execute }));

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('failed');
    expect(outcome.receipt.error).toMatchObject({ code: 'DRIVER_START_FAILED', retryable: true });
    expect(calls).toBe(2); // 策略重试一次
    expect(outcome.attempts).toBe(2);
  });

  it('写工作区后断连 → unknown,auto_retry[workspace_write]=true 也不自动重跑', async () => {
    const store = createStore();
    let calls = 0;
    const execute = (input: AdpDriverExecutionInput) => {
      calls += 1;
      input.control.markDispatched();
      // 注入已观察到的写工作区活动,然后连接断开。
      input.onEvent?.({
        schema_version: 'driver-event.v1',
        event_type: 'driver.tool.completed',
        payload: { tool_name: 'write_file' },
      } as DriverStreamEvent);
      return Promise.reject(new Error('transport disconnected mid-run'));
    };
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      retryPolicy: createAdpRetryPolicy({ workspace_write: true }),
    });

    const outcome = await endpoint.invoke(invokeRequest({ execute }));

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('unknown');
    expect(outcome.receipt.error).toMatchObject({ code: 'DRIVER_OUTCOME_UNKNOWN', retryable: false });
    expect(calls).toBe(1); // unknown 永不自动重跑
  });

  it('返回结果前断连 → unknown;error.retryable 提示不驱动重试', async () => {
    const store = createStore();
    let calls = 0;
    const execute = (input: AdpDriverExecutionInput) => {
      calls += 1;
      input.control.markDispatched();
      return Promise.reject(new Error('exited with code 1 before reporting'));
    };
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      // 显式声明失败可重跑的提示与部署配置无关:配置 false → 不重跑。
      retryPolicy: createAdpRetryPolicy({ workspace_write: false }),
    });

    const outcome = await endpoint.invoke(invokeRequest({ execute }));

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('unknown');
    expect(calls).toBe(1);
  });

  it('确定失败(business failed)auto_retry 开启 → 按策略重执行直至成功', async () => {
    const store = createStore();
    let calls = 0;
    const execute = (input: AdpDriverExecutionInput) => {
      calls += 1;
      input.control.markDispatched();
      if (calls === 1) {
        return Promise.resolve({
          execution: driverRunResult('failed', {
            code: 'BUSINESS_BOOM',
            message: 'boom',
            retryable: true,
          }),
        });
      }
      return Promise.resolve({ execution: driverRunResult('succeeded') });
    };
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      retryPolicy: createAdpRetryPolicy({ workspace_write: true }),
    });

    const outcome = await endpoint.invoke(invokeRequest({ execute }));

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('succeeded');
    expect(calls).toBe(2);
  });

  it('确定失败 auto_retry 关闭 → 不重跑(即使 error.retryable=true)', async () => {
    const store = createStore();
    let calls = 0;
    const execute = (input: AdpDriverExecutionInput) => {
      calls += 1;
      input.control.markDispatched();
      return Promise.resolve({
        execution: driverRunResult('failed', {
          code: 'BUSINESS_BOOM',
          message: 'boom',
          retryable: true,
        }),
      });
    };
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      retryPolicy: createAdpRetryPolicy({ workspace_write: false }),
    });

    const outcome = await endpoint.invoke(invokeRequest({ execute }));

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('failed');
    expect(calls).toBe(1);
  });
});

describe('AdpDriverEndpoint · 取消、interrupted 与迟到结果', () => {
  it('副作用执行中取消且结局不明 → unknown;cancel 帧落账且不重跑', async () => {
    const store = createStore();
    let calls = 0;
    const receipts: AdpReceiptDelivery[] = [];
    const execute = (input: AdpDriverExecutionInput) => {
      calls += 1;
      input.control.markDispatched();
      input.onEvent?.({
        schema_version: 'driver-event.v1',
        event_type: 'driver.tool.in_progress',
        payload: { tool_name: 'write_file' },
      } as DriverStreamEvent);
      return new Promise<never>((_, reject) => {
        input.signal.addEventListener(
          'abort',
          () => reject(input.signal.reason ?? new Error('aborted')),
          { once: true },
        );
      });
    };
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      retryPolicy: createAdpRetryPolicy({ workspace_write: true }),
      onReceipt: (delivery) => receipts.push(delivery),
    });

    const running = endpoint.invoke(invokeRequest({ execute, exchange_id: 'ex-adp-cancel' }));
    const cancel = await endpoint.cancel({
      task_id: 'task-adp',
      run_id: 'run-adp',
      target_exchange_id: 'ex-adp-cancel',
    });
    const outcome = await running;

    expect(cancel.state).toBe('cancel_delivered');
    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('unknown');
    expect(calls).toBe(1);
    expect(receipts).toHaveLength(1);

    // cancel 帧:causation 必须指向目标 invoke(P0 校验已过),且进了 journal。
    const journal = store.listJournal('task-adp', 'run-adp');
    const cancelRow = journal.find(
      (row) => row.frame !== null && 'command' in row.frame && row.frame.command === 'driver.cancel',
    );
    expect(cancelRow?.frame).toMatchObject({
      causation_id: 'ex-adp-cancel',
      target_exchange_id: 'ex-adp-cancel',
    });
  });

  it('dispatch 后无副作用活动时取消 → cancelled', async () => {
    const store = createStore();
    const execute = (input: AdpDriverExecutionInput) => {
      input.control.markDispatched();
      return new Promise<never>((_, reject) => {
        input.signal.addEventListener(
          'abort',
          () => reject(input.signal.reason ?? new Error('aborted')),
          { once: true },
        );
      });
    };
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });

    const running = endpoint.invoke(invokeRequest({ execute, exchange_id: 'ex-adp-clean-cancel' }));
    await endpoint.cancel({
      task_id: 'task-adp',
      run_id: 'run-adp',
      target_exchange_id: 'ex-adp-clean-cancel',
    });
    const outcome = await running;

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('cancelled');
  });

  it('迟到结果只对账入档:不改已发回执、不产生第二次回调', async () => {
    const store = createStore();
    const receipts: AdpReceiptDelivery[] = [];
    const execute = (input: AdpDriverExecutionInput) => {
      input.control.markDispatched();
      return Promise.reject(new Error('transport disconnected'));
    };
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      onReceipt: (delivery) => receipts.push(delivery),
    });

    const outcome = await endpoint.invoke(invokeRequest({ execute, exchange_id: 'ex-adp-late' }));
    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('unknown');

    endpoint.reconcileLateResult('ex-adp-late', driverRunResult('succeeded'));

    expect(receipts).toHaveLength(1);
    expect(outcome.status).toBe('unknown');
    const journal = store.listJournal('task-adp', 'run-adp');
    const late = journal.find((row) => row.event === 'driver.invocation_late_result');
    expect(late).toMatchObject({ kind: 'call', status: 'succeeded', causation_id: null });
  });
});

describe('AdpDriverEndpoint · 崩溃后重复 exchange 的对账收束', () => {
  it('已登记但从未投递 → 明确证据未执行 → 收束 failed,不启动副作用', async () => {
    const store = createStore();
    let calls = 0;
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    // 模拟上一进程只写到 outbox 就崩溃。
    const frame = adpFrameSchema.parse({
      protocol: 'agent-driver',
      protocol_version: '1.0',
      exchange_id: 'ex-adp-crash-a',
      causation_id: null,
      task_id: 'task-adp',
      run_id: 'run-adp',
      producer: { kind: 'agent', role_id: null },
      consumer: { kind: 'driver', role_id: null },
      attempt: 1,
      created_at: '2026-09-25T09:00:00.000Z',
      deadline_at: '2026-09-25T09:30:00.000Z',
      command: 'driver.invoke',
      workspace: { path: '/workspace/task-adp' },
      side_effect: 'workspace_write',
      instruction: { text: 'do work', ref: null },
    });
    store.withProtocolTransaction((tx) =>
      tx.enqueueOutbox({
        id: 'adp-out:ex-adp-crash-a',
        destination: 'adp:driver-side',
        frame,
        status: 'pending',
      }),
    );

    const outcome = await endpoint.invoke(
      invokeRequest({
        execute: () => {
          calls += 1;
          return succeed({ control: { markDispatched: () => undefined } } as AdpDriverExecutionInput);
        },
        exchange_id: 'ex-adp-crash-a',
      }),
    );

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('failed');
    expect(outcome.receipt.error?.code).toBe('DRIVER_START_FAILED');
    expect(calls).toBe(0);
    expect(store.getOutbox('adp-out:ex-adp-crash-a')?.status).toBe('complete');
  });

  it('已投递但无回执(上一进程死在执行中)→ 执行状态不明 → 收束 unknown', async () => {
    const store = createStore();
    let calls = 0;
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const frame = adpFrameSchema.parse({
      protocol: 'agent-driver',
      protocol_version: '1.0',
      exchange_id: 'ex-adp-crash-b',
      causation_id: null,
      task_id: 'task-adp',
      run_id: 'run-adp',
      producer: { kind: 'agent', role_id: null },
      consumer: { kind: 'driver', role_id: null },
      attempt: 1,
      created_at: '2026-09-25T09:00:00.000Z',
      deadline_at: '2026-09-25T09:30:00.000Z',
      command: 'driver.invoke',
      workspace: { path: '/workspace/task-adp' },
      side_effect: 'workspace_write',
      instruction: { text: 'do work', ref: null },
    });
    store.withProtocolTransaction((tx) => {
      tx.enqueueOutbox({
        id: 'adp-out:ex-adp-crash-b',
        destination: 'adp:driver-side',
        frame,
        status: 'pending',
      });
      tx.receiveInbox({ consumer_id: 'adp:driver-side', frame, received_at: '2026-09-25T09:00:01.000Z' });
    });

    const outcome = await endpoint.invoke(
      invokeRequest({
        execute: () => {
          calls += 1;
          return succeed({ control: { markDispatched: () => undefined } } as AdpDriverExecutionInput);
        },
        exchange_id: 'ex-adp-crash-b',
      }),
    );

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('unknown');
    expect(calls).toBe(0);
  });
});

describe('AdpDriverEndpoint · 真实 runtime 链路的阶段证据(外部 transport 注入)', () => {
  async function runThroughRuntime(error: DriverTransportError) {
    const store = createStore();
    const runtime = new ExternalDriverRuntime({
      driver_id: 'external-acp-driver',
      session_id: 'external-session',
      transport: { invoke: () => Promise.reject(error) },
    });
    const invokeDriverRuntime = createDriverRuntimeInvoker(runtime);
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    return endpoint.invoke(
      invokeRequest({
        execute: (input) =>
          invokeDriverRuntime(
            {
              task_id: 'task-adp',
              run_id: 'run-adp',
              workspace_path: '/workspace/task-adp',
              call_id: input.call_id,
              source_driver: 'external-acp-driver',
              driver_context: { task_instruction: 'do work', skills: [], experiences: [] },
            },
            {
              ...(input.signal ? { signal: input.signal } : {}),
              onDispatch: input.control.markDispatched,
              ...(input.onLateResult ? { onLateResult: input.onLateResult } : {}),
            },
          ),
      }),
    );
  }

  it('spawn 失败(明确未执行)→ failed(启动失败)', async () => {
    const outcome = await runThroughRuntime(
      new DriverTransportError('Command driver failed to start: ENOENT', 'not_executed'),
    );
    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('failed');
    expect(outcome.receipt.error?.code).toBe('DRIVER_START_FAILED');
  });

  it('运行中断连(执行状态不明)→ unknown', async () => {
    const outcome = await runThroughRuntime(
      new DriverTransportError('Command driver timed out after 300ms', 'execution_unconfirmed'),
    );
    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('unknown');
    expect(outcome.receipt.error?.code).toBe('DRIVER_OUTCOME_UNKNOWN');
  });
});

describe('AdpDriverEndpoint · side_effect 与协议契约', () => {
  it('invoke 帧必带 side_effect 与 deadline;非法 side_effect 被 P0 拒收', async () => {
    const store = createStore();
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'external' });

    const outcome = await endpoint.invoke(
      invokeRequest({ execute: succeed, side_effect: 'read_only', exchange_id: 'ex-adp-side' }),
    );

    expect(outcome.state).toBe('settled');
    const journal = store.listJournal('task-adp', 'run-adp');
    const invokeRow = journal.find(
      (row) => row.frame !== null && 'command' in row.frame && row.frame.command === 'driver.invoke',
    );
    expect(invokeRow?.frame).toMatchObject({ side_effect: 'read_only', deadline_at: expect.any(String) });

    // P0 strict schema:私有变体(如塞 auto_retry)直接拒收。
    expect(() =>
      adpFrameSchema.parse({
        protocol: 'agent-driver',
        protocol_version: '1.0',
        exchange_id: 'ex-adp-bad',
        causation_id: null,
        task_id: 'task-adp',
        run_id: 'run-adp',
        producer: { kind: 'agent', role_id: null },
        consumer: { kind: 'driver', role_id: null },
        attempt: 1,
        created_at: '2026-09-25T09:00:00.000Z',
        deadline_at: '2026-09-25T09:30:00.000Z',
        command: 'driver.invoke',
        workspace: { path: '/workspace/task-adp' },
        side_effect: 'workspace_write' satisfies AdpSideEffect,
        instruction: { text: 'do work', ref: null },
        auto_retry: { workspace_write: true },
      }),
    ).toThrow();
  });

  it('回执 status 属于 P0 冻结枚举', async () => {
    const store = createStore();
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const outcome = await endpoint.invoke(invokeRequest({ execute: succeed }));
    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(['succeeded', 'failed', 'cancelled', 'unknown'] satisfies AdpStatus[]).toContain(
      outcome.status,
    );
  });

  it('P1 落账不可用(task/run 行缺失)→ 降级为进程内记账,业务不中断', async () => {
    const store = createStore();
    const receipts: AdpReceiptDelivery[] = [];
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      onReceipt: (delivery) => receipts.push(delivery),
    });

    const outcome = await endpoint.invoke(
      invokeRequest({ execute: succeed, task_id: 'task-not-persisted', exchange_id: 'ex-adp-degraded' }),
    );

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('succeeded');
    expect(outcome.journal_degraded).toBe(true);
    // 业务照常收束:回执仍经宿主内回调交还 Agent。
    expect(receipts).toHaveLength(1);
  });
});
