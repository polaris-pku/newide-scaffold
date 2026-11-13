/**
 * ADP receipt ↔ Run Dispatch Journal 的**真实持久化集成**测试（阶段 1）。
 *
 * 目的：证明阶段 1 的两块新底层能力真的接在一起，而不是各自 mock：
 * - 真实 `RunDispatchJournal`（临时目录、append-only 行、折叠、受控 evidence ref）；
 * - 真实 `AdpDriverEndpoint` + 真实 SQLite P1 投递底座；
 * - `AdpReceiptReconciler` 用 journal 的 `findDispatchIdByExchange` / `getDispatchRecord`
 *   做 correlation，把 receipt 写成 reconciled 行。
 *
 * 断言可观察行为：
 * - receipt 收束 → journal 记录从 dispatched(unknown) 变成 reconciled 可信状态；
 * - 进程重启后再次 invoke 同一 exchange → 只重放 receipt（executor 不再执行），
 *   重复 receipt 是幂等 duplicate；
 * - 先 unknown、后迟到结果 → 只把 reconciled 升级，不触发新执行。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createId, SCHEMA_VERSION } from '../../src/core';
import type { CoordinationStateCommit, ProtocolDeliveryStore } from '../../src/persistence';
import { RunDispatchJournal, SqliteCoordinationStore } from '../../src/persistence';
import type { DriverRunResult } from '../../src/driver/contract';
import {
  AdpDriverEndpoint,
  type AdpDriverExecutionInput,
  type AdpInvokeRequest,
  type AdpReceiptDelivery,
} from '../../src/driver/adp-driver-endpoint';
import {
  AdpReceiptReconciler,
  type ReconcileResult,
} from '../../src/driver/adp-receipt-reconciler';
import { DriverTransportError } from '../../src/driver/driver-transport-error';
import {
  buildExecutionBrief,
  buildExecutionEvidence,
  hashExecutionEvidence,
  type BudgetSnapshot,
} from '../../src/driver/execution-contract';

const TASK_ID = 'task-adp-journal';
const RUN_ID = 'run-adp-journal';
const ROLE_ID = 'role-adp-journal';
const NOW = '2026-11-13T10:00:00.000Z';
const DISPATCH_ID = 'dsp_adp_1';
const LATE_DISPATCH_ID = 'dsp_adp_2';

const BUDGET: BudgetSnapshot = {
  dispatches_left: 10,
  role_tokens_left: 100_000,
  deadline_at: '2026-11-13T10:45:00.000Z',
};

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  // LIFO：先关 store/journal，再删临时目录（Windows 上句柄未关时 rm 会 EPERM）。
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function createStore(directory: string): SqliteCoordinationStore {
  const store = new SqliteCoordinationStore(path.join(directory, 'coordination.sqlite'));
  const commit: CoordinationStateCommit = {
    task: {
      task_id: TASK_ID,
      status: 'created',
      risk_level: 'medium',
      spec: 'ADP receipt ↔ dispatch journal integration',
      completion_criteria: ['done'],
      affected_paths: [],
      workspace_path: '/workspace',
      warnings: [],
      revision: 1,
      created_at: NOW,
      updated_at: NOW,
      schema_version: 'v0',
    },
    run: {
      run_id: RUN_ID,
      task_id: TASK_ID,
      status: 'created',
      mode: 'single_agent',
      workspace_path: '/workspace',
      revision: 1,
      created_at: NOW,
      updated_at: NOW,
      schema_version: 'v0',
    },
    runtime_state: {
      task_id: TASK_ID,
      current_run_id: RUN_ID,
      resume_cursor: 'execute_agent',
      waiting_on: [],
      artifact_refs: [],
      diagnostics: {},
      updated_at: NOW,
      schema_version: 'v0',
    },
    events: [
      {
        event_id: `event-${RUN_ID}`,
        event_type: 'task.created',
        subject_id: TASK_ID,
        task_id: TASK_ID,
        run_id: RUN_ID,
        payload: {},
        created_at: NOW,
        schema_version: 'v0',
      },
    ],
  };
  store.commitState(commit);
  cleanups.push(() => store.close());
  return store;
}

function driverRunResult(
  status: DriverRunResult['status'],
  overrides: Partial<DriverRunResult> = {},
): DriverRunResult {
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
      task_id: TASK_ID,
      metadata: {},
      created_at: NOW,
      schema_version: SCHEMA_VERSION,
    },
    tool_events: [],
    diagnostics: { driver_id: 'driver-adp', duration_ms: 3, notes: [] },
    usage: { total_tokens: 7, input_tokens: 5, output_tokens: 2 },
    created_at: NOW,
    schema_version: SCHEMA_VERSION,
    ...overrides,
  };
}

/** 模拟旧持久化数据：隐藏 driver.invocation_evidence 调用行（真实 store/journal 其余不变）。 */
function hideInvocationEvidence(store: ProtocolDeliveryStore): ProtocolDeliveryStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'listJournal') {
        return (taskId: string, runId: string, afterSeq?: number) =>
          target
            .listJournal(taskId, runId, afterSeq)
            .filter((row) => row.event !== 'driver.invocation_evidence');
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ProtocolDeliveryStore;
}

function invokeRequest(
  overrides: Partial<AdpInvokeRequest> & Pick<AdpInvokeRequest, 'execute'>,
): AdpInvokeRequest {
  return {
    task_id: TASK_ID,
    run_id: RUN_ID,
    workspace_path: '/workspace/task-adp',
    instruction: '实现并验证一个改动',
    ...overrides,
  };
}

function succeed(input: AdpDriverExecutionInput) {
  input.control.markDispatched();
  return Promise.resolve({ execution: driverRunResult('succeeded') });
}

async function openJournal(directory: string): Promise<RunDispatchJournal> {
  const journal = await RunDispatchJournal.open({
    runDir: path.join(directory, 'run'),
    identity: { run_id: RUN_ID, task_id: TASK_ID, role_id: ROLE_ID },
  });
  cleanups.push(() => journal.close());
  return journal;
}

function buildBrief(dispatchId: string, sequence: number) {
  return buildExecutionBrief({
    identity: {
      dispatch_id: dispatchId,
      task_id: TASK_ID,
      run_id: RUN_ID,
      role_id: ROLE_ID,
      sequence,
      accepted_at: NOW,
    },
    request: { kind: 'execute', instruction: '实现并验证一个改动' },
  });
}

describe('ADP receipt ↔ 真实 dispatch journal 对账', () => {
  it('receipt 收束后 journal 由 dispatched(unknown) 变为 reconciled 可信状态；重复 receipt 幂等', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-adp-journal-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = createStore(directory);
    const journal = await openJournal(directory);
    const exchange = 'ex_adp_journal_ok';

    // 先按写屏障写入 accepted + dispatched（含 ADP exchange correlation）。
    const built = buildBrief(DISPATCH_ID, 1);
    await journal.appendAccepted({
      brief: built.brief,
      brief_sha256: built.brief_sha256,
      budget_before: BUDGET,
    });
    await journal.appendDispatched({ dispatch_id: DISPATCH_ID, adp_exchange_id: exchange });
    expect((await journal.getDispatchRecord(DISPATCH_ID))?.status).toBe('unknown');

    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: {
        findDispatchIdByExchange: (id) => journal.findDispatchIdByExchange(id),
        getDispatchRecord: (id) => journal.getDispatchRecord(id),
      },
      now: () => NOW,
    });

    let calls = 0;
    const notifications: AdpReceiptDelivery[] = [];
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    let reconcileResult: Promise<ReconcileResult> | undefined;
    await endpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          calls += 1;
          return succeed(input);
        },
        onReceipt: (delivery) => notifications.push(delivery),
        // 写屏障型对账：invoke 必须等它完成，失败要传播。
        onReceiptReconciled: (delivery) => {
          reconcileResult = reconciler.consumeReceipt(delivery);
          return reconcileResult;
        },
      }),
    );
    expect(calls).toBe(1);
    expect(notifications).toHaveLength(1);

    // invoke resolve 时对账已经完成（不是先收集 delivery 再手动 consume）。
    const reconciled = await reconcileResult!;
    expect(reconciled).toMatchObject({
      state: 'reconciled',
      dispatch_id: DISPATCH_ID,
      status: 'succeeded',
    });

    const record = await journal.getDispatchRecord(DISPATCH_ID);
    expect(record?.phase).toBe('dispatched');
    expect(record?.status).toBe('succeeded');
    expect(record?.reconciled?.status).toBe('succeeded');
    expect(record?.evidence).toBeUndefined();

    // 进程重启（新 endpoint，同一 P1 store）重复 invoke 同一 exchange：
    // 只重放既有 receipt，不重新执行 driver；重放路径同样等待对账完成。
    const restarted = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const replayed: AdpReceiptDelivery[] = [];
    let replayReconcile: Promise<ReconcileResult> | undefined;
    await restarted.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: () => {
          calls += 1;
          throw new Error('restart replay must not execute the driver');
        },
        onReceipt: (delivery) => replayed.push(delivery),
        onReceiptReconciled: (delivery) => {
          replayReconcile = reconciler.consumeReceipt(delivery);
          return replayReconcile;
        },
      }),
    );
    expect(calls).toBe(1);
    expect(replayed).toHaveLength(1);
    const duplicate: ReconcileResult = await replayReconcile!;
    expect(duplicate.state).toBe('duplicate');

    // receipt 到达 ≠ 收到执行结果：成功 receipt 的 reconciled evidence 仍是
    // result_received=true + execution_unconfirmed（两个正交字段）。
    const lines = (await journal.read()).entries;
    const reconciledLine = lines.find((entry) => entry.event === 'reconciled');
    expect(reconciledLine?.event).toBe('reconciled');
    if (reconciledLine?.event === 'reconciled') {
      expect(reconciledLine.evidence?.transport).toMatchObject({
        evidence: 'execution_unconfirmed',
        result_received: true,
      });
    }

    const fold = await journal.fold();
    expect(fold.records).toHaveLength(1);
    expect(fold.records[0]?.reconciled?.status).toBe('succeeded');
  });

  it('先 unknown、后迟到结果：只把 reconciled 升级，不产生任何新执行', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-adp-journal-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = createStore(directory);
    const journal = await openJournal(directory);
    const exchange = 'ex_adp_journal_late';

    const built = buildBrief(LATE_DISPATCH_ID, 1);
    await journal.appendAccepted({
      brief: built.brief,
      brief_sha256: built.brief_sha256,
      budget_before: BUDGET,
    });
    await journal.appendDispatched({ dispatch_id: LATE_DISPATCH_ID, adp_exchange_id: exchange });

    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: {
        findDispatchIdByExchange: (id) => journal.findDispatchIdByExchange(id),
        getDispatchRecord: (id) => journal.getDispatchRecord(id),
      },
      now: () => NOW,
    });
    let calls = 0;
    const notifications: AdpReceiptDelivery[] = [];
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      // 观察器允许异步；invoke 不等待，但 flushLateResultObservers 会等待并传播失败。
      lateResultObserver: (late) => reconciler.reconcileLateResult(late),
    });

    // 传输断连（执行状态不明）→ ADP unknown 收束，仍交付 receipt 供对账。
    await endpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: async (input) => {
          calls += 1;
          input.control.markDispatched();
          throw new Error('stream closed after dispatch');
        },
        onReceipt: (delivery) => notifications.push(delivery),
        onReceiptReconciled: (delivery) => reconciler.consumeReceipt(delivery),
      }),
    );
    expect(calls).toBe(1);
    expect(notifications).toHaveLength(1);
    expect((await journal.getDispatchRecord(LATE_DISPATCH_ID))?.status).toBe('unknown');

    // 迟到真实结果只做对账：不重执行、不改已发 receipt。
    endpoint.reconcileLateResult(exchange, driverRunResult('succeeded'));
    await endpoint.flushLateResultObservers();

    const record = await journal.getDispatchRecord(LATE_DISPATCH_ID);
    expect(record?.status).toBe('succeeded');
    expect(record?.reconciled?.status).toBe('succeeded');
    expect(calls).toBe(1);
  });

  it('真实 endpoint 启动失败经 reconciler：evidence=failed / result_received=false / not_executed', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-adp-journal-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = createStore(directory);
    const journal = await openJournal(directory);
    const exchange = 'ex_adp_journal_start_failure';
    const dispatchId = 'dsp_adp_4';

    const built = buildBrief(dispatchId, 1);
    await journal.appendAccepted({
      brief: built.brief,
      brief_sha256: built.brief_sha256,
      budget_before: BUDGET,
    });
    await journal.appendDispatched({ dispatch_id: dispatchId, adp_exchange_id: exchange });

    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: {
        findDispatchIdByExchange: (id) => journal.findDispatchIdByExchange(id),
        getDispatchRecord: (id) => journal.getDispatchRecord(id),
      },
      now: () => NOW,
    });

    let notifications = 0;
    let calls = 0;
    await new AdpDriverEndpoint({ store, side_effect: 'workspace_write' }).invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: () => {
          calls += 1;
          throw new DriverTransportError('spawn failed: binary missing', 'not_executed');
        },
        onReceipt: () => {
          notifications += 1;
        },
        onReceiptReconciled: (delivery) => reconciler.consumeReceipt(delivery),
      }),
    );
    expect(notifications).toBe(1);

    // 启动失败是「明确未执行」：failed + result_received=false + not_executed，
    // 不能被 receipt.status 推导成 result_received=true / execution_unconfirmed。
    const reconciledLine = (await journal.read()).entries.find(
      (entry) => entry.event === 'reconciled',
    );
    expect(reconciledLine?.event).toBe('reconciled');
    if (reconciledLine?.event === 'reconciled') {
      expect(reconciledLine.status).toBe('failed');
      expect(reconciledLine.evidence?.status).toBe('failed');
      expect(reconciledLine.evidence?.transport).toMatchObject({
        evidence: 'not_executed',
        result_received: false,
      });
    }

    const record = await journal.getDispatchRecord(dispatchId);
    expect(record?.status).toBe('failed');
    expect(record?.reconciled?.status).toBe('failed');

    // 重启回放：持久化的启动失败事实保持一致（failed/false/not_executed），不重执行。
    expect(calls).toBe(1);
    const restarted = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const replay = await restarted.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: () => {
          calls += 1;
          throw new Error('restart replay must not execute the driver');
        },
        onReceiptReconciled: (delivery) => reconciler.consumeReceipt(delivery),
      }),
    );
    expect(calls).toBe(1);
    expect(replay.state).toBe('settled');
    if (replay.state === 'settled') {
      expect(replay.replayed).toBe(true);
      expect(replay.evidence).toMatchObject({
        dispatched: false,
        result_received: false,
        transport_evidence: 'not_executed',
      });
    }
  });

  it('accepted 后无 dispatched、但可信 ADP receipt 已对账 → 回执优先，不判 not_executed', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-adp-journal-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const journal = await openJournal(directory);
    const dispatchId = 'dsp_adp_3';

    const built = buildBrief(dispatchId, 1);
    await journal.appendAccepted({
      brief: built.brief,
      brief_sha256: built.brief_sha256,
      budget_before: BUDGET,
    });
    // 只有 accepted 行：本地猜测是 not_executed。
    expect((await journal.getDispatchRecord(dispatchId))?.status).toBe('not_executed');

    // 但 ADP receipt 已证明交付并给出可信结果 → 回执优先于本地猜测。
    const evidence = buildExecutionEvidence({
      dispatch_id: dispatchId,
      evidence_id: 'evd_rec_3',
      observation: {
        transport: { evidence: 'execution_unconfirmed', result_received: true },
        result: { status: 'succeeded' },
      },
    });
    await journal.appendReconciled({
      dispatch_id: dispatchId,
      status: 'succeeded',
      reason: 'adp receipt reconciled',
      evidence,
      evidence_sha256: hashExecutionEvidence(evidence),
    });

    const record = await journal.getDispatchRecord(dispatchId);
    expect(record?.phase).toBe('accepted');
    expect(record?.status).toBe('succeeded');
    expect(record?.reconciled?.status).toBe('succeeded');
  });
});

// ─────────────────────────────────────────────────────────────
// 复审修复：unknown 与 result_received 正交（真实 endpoint + 真实 journal）
// ─────────────────────────────────────────────────────────────

async function seedDispatched(
  journal: RunDispatchJournal,
  dispatchId: string,
  sequence: number,
  exchange: string,
): Promise<void> {
  const built = buildBrief(dispatchId, sequence);
  await journal.appendAccepted({
    brief: built.brief,
    brief_sha256: built.brief_sha256,
    budget_before: BUDGET,
  });
  await journal.appendDispatched({ dispatch_id: dispatchId, adp_exchange_id: exchange });
}

function makeJournalReconciler(journal: RunDispatchJournal): AdpReceiptReconciler {
  return new AdpReceiptReconciler({
    journal,
    lookup: {
      findDispatchIdByExchange: (id) => journal.findDispatchIdByExchange(id),
      getDispatchRecord: (id) => journal.getDispatchRecord(id),
    },
    now: () => NOW,
  });
}

function reconciledEntry(journal: RunDispatchJournal) {
  return journal
    .read()
    .then((snapshot) => snapshot.entries.find((entry) => entry.event === 'reconciled'));
}

describe('复审修复：unknown + result_received=true 合法（真实链路）', () => {
  it('driver failed + EXTERNAL_DRIVER_TRANSPORT_ERROR → ADP unknown、result_received=true、可对账且不重跑', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-adp-journal-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = createStore(directory);
    const journal = await openJournal(directory);
    const dispatchId = 'dsp_transport_error_result';
    const exchange = 'ex_adp_transport_error_result';
    await seedDispatched(journal, dispatchId, 1, exchange);
    const reconciler = makeJournalReconciler(journal);

    let calls = 0;
    let reconcile: Promise<ReconcileResult> | undefined;
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const outcome = await endpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          calls += 1;
          input.control.markDispatched();
          // driver 明确返回了一个 DriverRunResult（failed），但错误码表示结局无法确认。
          return Promise.resolve({
            execution: driverRunResult('failed', {
              error: {
                code: 'EXTERNAL_DRIVER_TRANSPORT_ERROR',
                message: 'stream ended after dispatch',
                retryable: false,
              },
            }),
          });
        },
        onReceiptReconciled: (delivery) => {
          reconcile = reconciler.consumeReceipt(delivery);
          return reconcile;
        },
      }),
    );

    expect(calls).toBe(1);
    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    // 结局不明 ≠ 没收到结果：unknown 与 result_received=true 同时成立。
    expect(outcome.status).toBe('unknown');
    expect(outcome.evidence).toMatchObject({
      dispatched: true,
      result_received: true,
      effects_observed: false,
    });
    expect(outcome.evidence.transport_evidence).toBeUndefined();

    expect(await reconcile).toMatchObject({ state: 'reconciled', status: 'unknown' });
    const line = await reconciledEntry(journal);
    expect(line?.event).toBe('reconciled');
    if (line?.event === 'reconciled') {
      expect(line.status).toBe('unknown');
      expect(line.evidence?.status).toBe('unknown');
      expect(line.evidence?.transport).toMatchObject({
        evidence: 'execution_unconfirmed',
        result_received: true,
      });
      // unknown 的副作用不确定语义不变：不得被改写成 failed。
      expect(line.evidence?.status).not.toBe('failed');
    }
    expect((await journal.getDispatchRecord(dispatchId))?.status).toBe('unknown');

    // 该事实已持久化（供重启回放，而不是从 receipt.status 反推）。
    const evidenceRows = store
      .listJournal(TASK_ID, RUN_ID)
      .filter((row) => row.id === `${exchange}:evidence`);
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0]?.event).toBe('driver.invocation_evidence');

    // 重启（新 endpoint、同一 store）回放：事实一致、不重执行、对账幂等。
    const restarted = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    let replayReconcile: Promise<ReconcileResult> | undefined;
    const notifications: AdpReceiptDelivery[] = [];
    const replay = await restarted.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: () => {
          calls += 1;
          throw new Error('restart replay must not execute the driver');
        },
        onReceipt: (delivery) => notifications.push(delivery),
        onReceiptReconciled: (delivery) => {
          replayReconcile = reconciler.consumeReceipt(delivery);
          return replayReconcile;
        },
      }),
    );
    expect(calls).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(replay.state).toBe('settled');
    if (replay.state !== 'settled') return;
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe('unknown');
    expect(replay.evidence).toMatchObject({
      dispatched: true,
      result_received: true,
      effects_observed: false,
    });
    expect(replay.evidence.transport_evidence).toBeUndefined();
    expect(await replayReconcile).toMatchObject({ state: 'duplicate' });

    const reconciledLines = (await journal.read()).entries.filter(
      (entry) => entry.event === 'reconciled',
    );
    expect(reconciledLines).toHaveLength(1);
  });

  it('interrupted 且观察到副作用 → ADP unknown，仍保留 result_received=true', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-adp-journal-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = createStore(directory);
    const journal = await openJournal(directory);
    const dispatchId = 'dsp_interrupted_effects';
    const exchange = 'ex_adp_interrupted_effects';
    await seedDispatched(journal, dispatchId, 1, exchange);
    const reconciler = makeJournalReconciler(journal);

    let calls = 0;
    let reconcile: Promise<ReconcileResult> | undefined;
    await new AdpDriverEndpoint({ store, side_effect: 'workspace_write' }).invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          calls += 1;
          input.control.markDispatched();
          return Promise.resolve({
            execution: driverRunResult('interrupted', {
              error: { code: 'DRIVER_INTERRUPTED', message: 'aborted', retryable: false },
              tool_events: [
                {
                  tool_event_id: createId('tool'),
                  tool_name: 'write_file',
                  status: 'completed',
                  summary: 'wrote src/fix.ts',
                  created_at: NOW,
                  schema_version: SCHEMA_VERSION,
                },
              ],
            }),
          });
        },
        onReceiptReconciled: (delivery) => {
          reconcile = reconciler.consumeReceipt(delivery);
          return reconcile;
        },
      }),
    );
    expect(calls).toBe(1);
    expect(await reconcile).toMatchObject({ state: 'reconciled', status: 'unknown' });
    const line = await reconciledEntry(journal);
    if (line?.event === 'reconciled') {
      expect(line.status).toBe('unknown');
      expect(line.evidence?.transport).toMatchObject({
        evidence: 'execution_unconfirmed',
        result_received: true,
      });
    }
    expect((await journal.getDispatchRecord(dispatchId))?.status).toBe('unknown');
  });

  it('抛出传输异常且没有 DriverRunResult → unknown + result_received=false（不伪造 received）', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-adp-journal-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = createStore(directory);
    const journal = await openJournal(directory);
    const dispatchId = 'dsp_thrown_no_result';
    const exchange = 'ex_adp_thrown_no_result';
    await seedDispatched(journal, dispatchId, 1, exchange);
    const reconciler = makeJournalReconciler(journal);

    let calls = 0;
    let reconcile: Promise<ReconcileResult> | undefined;
    const outcome = await new AdpDriverEndpoint({ store, side_effect: 'workspace_write' }).invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: async (input) => {
          calls += 1;
          input.control.markDispatched();
          throw new DriverTransportError('stream closed after dispatch', 'execution_unconfirmed');
        },
        onReceiptReconciled: (delivery) => {
          reconcile = reconciler.consumeReceipt(delivery);
          return reconcile;
        },
      }),
    );
    expect(calls).toBe(1);
    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('unknown');
    expect(outcome.evidence.result_received).toBe(false);

    await reconcile;
    const line = await reconciledEntry(journal);
    if (line?.event === 'reconciled') {
      expect(line.evidence?.transport).toMatchObject({
        evidence: 'execution_unconfirmed',
        result_received: false,
      });
      expect(line.evidence?.transport.result_received_missing).toBeUndefined();
    }
    expect((await journal.getDispatchRecord(dispatchId))?.status).toBe('unknown');
  });

  it('旧持久化数据缺少 evidence 行：回放显式 missing，不凭空断言，也不重跑', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-adp-journal-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const realStore = createStore(directory);
    const legacyStore = hideInvocationEvidence(realStore);
    const journal = await openJournal(directory);
    const dispatchId = 'dsp_legacy_evidence_missing';
    const exchange = 'ex_adp_legacy_evidence_missing';
    await seedDispatched(journal, dispatchId, 1, exchange);
    const reconciler = makeJournalReconciler(journal);

    let calls = 0;
    let reconcile: Promise<ReconcileResult> | undefined;
    await new AdpDriverEndpoint({ store: legacyStore, side_effect: 'workspace_write' }).invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          calls += 1;
          input.control.markDispatched();
          return Promise.resolve({
            execution: driverRunResult('failed', {
              error: {
                code: 'EXTERNAL_DRIVER_TRANSPORT_ERROR',
                message: 'stream ended',
                retryable: false,
              },
            }),
          });
        },
        onReceiptReconciled: (delivery) => {
          reconcile = reconciler.consumeReceipt(delivery);
          return reconcile;
        },
      }),
    );
    expect(calls).toBe(1);
    // 实时链路知道「已收到结果」；持久化行确实存在，只是被 legacy 视图隐藏。
    expect(await reconcile).toMatchObject({ state: 'reconciled', status: 'unknown' });
    expect(
      realStore
        .listJournal(TASK_ID, RUN_ID)
        .some((row) => row.event === 'driver.invocation_evidence'),
    ).toBe(true);

    const restarted = new AdpDriverEndpoint({ store: legacyStore, side_effect: 'workspace_write' });
    let replayReconcile: Promise<ReconcileResult> | undefined;
    const replay = await restarted.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: () => {
          calls += 1;
          throw new Error('restart replay must not execute the driver');
        },
        onReceiptReconciled: (delivery) => {
          replayReconcile = reconciler.consumeReceipt(delivery);
          return replayReconcile;
        },
      }),
    );
    expect(calls).toBe(1);
    expect(replay.state).toBe('settled');
    if (replay.state !== 'settled') return;
    expect(replay.replayed).toBe(true);
    expect(replay.evidence).toMatchObject({
      dispatched: true,
      result_received: false,
      result_received_missing: true,
    });
    // 旧数据不能凭空升级成 received=true；对账仍然是幂等 duplicate。
    expect(await replayReconcile).toMatchObject({ state: 'duplicate' });

    const reconciledLines = (await journal.read()).entries.filter(
      (entry) => entry.event === 'reconciled',
    );
    expect(reconciledLines).toHaveLength(1);
    if (reconciledLines[0]?.event === 'reconciled') {
      expect(reconciledLines[0].evidence?.transport).toMatchObject({
        evidence: 'execution_unconfirmed',
        result_received: true,
      });
    }
  });
});
