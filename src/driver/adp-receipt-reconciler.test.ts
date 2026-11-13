/**
 * adp-receipt-reconciler.test — 阶段 1 ADP receipt 对账接线的行为测试。
 *
 * 覆盖（RD-DIS-04 / RD-EVD-05 / RD-JRN-04，设计 §4 点 3/5、§12.2 第 10 条）：
 * - 正常 invoke：executor 只跑 1 次，receipt 权威地把 succeeded 追加成 1 条 reconciled；
 * - transport `execution_unconfirmed` + ADP unknown：evidence 保持 unknown（两个正交字段），
 *   不被本地猜测改写成 failed；只有 receipt 明确 failed（明确未执行）才判 failed；
 * - 同一 receipt 重复提交 → duplicate，不重复写盘、不重复执行；
 * - 进程重启后重复 invoke 同一 exchange：既有 receipt 交给 per-invoke 回调，只对账不重执行；
 * - 已 settled 的 succeeded 与 failed receipt → conflict，不追加 journal、不改写终态；
 * - 未提供新回调时 endpoint 行为与原来一致（options.onReceipt 照旧，per-invoke 不隐式触发）；
 * - 迟到结果观察钩子 + reconcileLateResult：只追加 reconciled，不重执行、不改发回执；
 * - journal 写失败向上抛（上层写屏障要求），不吞异常返回成功；
 * - legacy exchange / 缺折叠记录 → ignored，绝不写盘。
 * - 【审核 #6】onReceiptReconciled 是写屏障：invoke await 它、失败以
 *   AdpReceiptReconciliationError 抛出；首次 settle 与已 settled 重放/恢复同一完成条件；
 * - 【审核 #6】lateResultObserver 允许异步：不产生未处理 rejection，
 *   flushLateResultObservers 等待在飞观察器并重抛第一个错误。
 *
 * journal 用本地内存 fake 实现 `DispatchJournalPort`（记录 append 参数并折叠 reconciled），
 * P1 store 用真实 `SqliteCoordinationStore`（沿用 adp-driver-endpoint.test.ts 的写法）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createId, SCHEMA_VERSION } from '../core';
import type { CoordinationStateCommit } from '../persistence';
import { SqliteCoordinationStore } from '../persistence';
import type { DriverRunResult, DriverStreamEvent } from './contract';
import {
  AdpDriverEndpoint,
  AdpReceiptReconciliationError,
  type AdpDriverExecutionInput,
  type AdpInvokeRequest,
  type AdpLateResultDelivery,
  type AdpReceiptDelivery,
} from './adp-driver-endpoint';
import { createAdpRetryPolicy } from './adp-retry-policy';
import { DriverTransportError } from './driver-transport-error';
import {
  AdpReceiptReconciler,
  type AdpDispatchCorrelationLookup,
} from './adp-receipt-reconciler';
import {
  buildExecutionBrief,
  DISPATCH_RECORD_SCHEMA_VERSION,
  hashExecutionEvidence,
  type AcceptedAppendInput,
  type DispatchJournalPort,
  type DispatchRecord,
  type DispatchedAppendInput,
  type EvidenceAppendInput,
  type EvidenceArtifactRef,
  type ReconciledAppendInput,
  type SettledAppendInput,
} from './execution-contract';

const TASK_ID = 'task-adp';
const RUN_ID = 'run-adp';
const ROLE_ID = 'role-adp';
const NOW = '2026-11-13T10:00:00.000Z';

const directories: string[] = [];
const stores: SqliteCoordinationStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// P1 store（真实 SQLite 投递底座）：沿用 adp-driver-endpoint.test.ts 的构造
// ─────────────────────────────────────────────────────────────

function createStore(): SqliteCoordinationStore {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-adp-reconciler-'));
  directories.push(directory);
  const store = new SqliteCoordinationStore(path.join(directory, 'coordination.sqlite'));
  stores.push(store);
  const commit: CoordinationStateCommit = {
    task: {
      task_id: TASK_ID, status: 'created', risk_level: 'medium',
      spec: 'ADP receipt reconciler test', completion_criteria: ['done'], affected_paths: [],
      workspace_path: '/workspace', warnings: [], revision: 1,
      created_at: NOW, updated_at: NOW, schema_version: 'v0',
    },
    run: {
      run_id: RUN_ID, task_id: TASK_ID, status: 'created', mode: 'single_agent',
      workspace_path: '/workspace', revision: 1,
      created_at: NOW, updated_at: NOW, schema_version: 'v0',
    },
    runtime_state: {
      task_id: TASK_ID, current_run_id: RUN_ID, resume_cursor: 'execute_agent',
      waiting_on: [], artifact_refs: [], diagnostics: {}, updated_at: NOW, schema_version: 'v0',
    },
    events: [{
      event_id: `event-${RUN_ID}`, event_type: 'task.created', subject_id: TASK_ID,
      task_id: TASK_ID, run_id: RUN_ID, payload: {}, created_at: NOW, schema_version: 'v0',
    }],
  };
  store.commitState(commit);
  return store;
}

// ─────────────────────────────────────────────────────────────
// 内存 Dispatch Journal fake：记录 append 参数，并把 reconciled 折叠进记录
// ─────────────────────────────────────────────────────────────

class FakeDispatchJournal implements DispatchJournalPort {
  readonly accepted: AcceptedAppendInput[] = [];
  readonly dispatched: DispatchedAppendInput[] = [];
  readonly evidence: EvidenceAppendInput[] = [];
  readonly settled: SettledAppendInput[] = [];
  readonly reconciled: ReconciledAppendInput[] = [];
  readonly records = new Map<string, DispatchRecord>();
  /** 注入写失败：验证对账异常策略（必须向上抛，不吞）。 */
  rejectReconciled?: Error;

  seed(record: DispatchRecord): void {
    this.records.set(record.dispatch_id, record);
  }

  record(dispatch_id: string): DispatchRecord | undefined {
    return this.records.get(dispatch_id);
  }

  async appendAccepted(input: AcceptedAppendInput): Promise<void> {
    this.accepted.push(input);
  }

  async appendDispatched(input: DispatchedAppendInput): Promise<void> {
    this.dispatched.push(input);
  }

  async appendEvidence(input: EvidenceAppendInput): Promise<EvidenceArtifactRef> {
    this.evidence.push(input);
    const sha256 = hashExecutionEvidence(input.evidence);
    return { ref: { path: `evidence/${input.dispatch_id}.json`, sha256 }, sha256 };
  }

  async appendSettled(input: SettledAppendInput): Promise<void> {
    this.settled.push(input);
  }

  async appendReconciled(input: ReconciledAppendInput): Promise<void> {
    if (this.rejectReconciled) throw this.rejectReconciled;
    this.reconciled.push(input);
    // 折叠：reconciled 只记录在 `reconciled` 字段，不改 settled 的 status（RD-JRN-04）。
    const existing = this.records.get(input.dispatch_id);
    if (existing) {
      this.records.set(input.dispatch_id, {
        ...existing,
        reconciled: {
          status: input.status,
          reason: input.reason,
          at: input.at ?? NOW,
        },
      });
    }
  }
}

/** 构造一条合法的折叠记录（brief 走宿主构造入口，记录过 schema 校验）。 */
function makeRecord(input: {
  dispatch_id: string;
  phase: DispatchRecord['phase'];
  status?: DispatchRecord['status'];
  reconciled?: DispatchRecord['reconciled'];
}): DispatchRecord {
  const built = buildExecutionBrief({
    identity: {
      dispatch_id: input.dispatch_id,
      task_id: TASK_ID,
      run_id: RUN_ID,
      role_id: ROLE_ID,
      sequence: 1,
      accepted_at: NOW,
    },
    request: { kind: 'execute', instruction: 'do work' },
  });
  const settled = input.phase === 'settled';
  return {
    schema_version: DISPATCH_RECORD_SCHEMA_VERSION,
    dispatch_id: input.dispatch_id,
    run_id: RUN_ID,
    task_id: TASK_ID,
    role_id: ROLE_ID,
    sequence: 1,
    phase: input.phase,
    status: input.status ?? (input.phase === 'accepted' ? 'not_executed' : 'unknown'),
    brief: built.brief,
    brief_sha256: built.brief_sha256,
    violations: [],
    accepted_at: NOW,
    ...(input.phase !== 'accepted' ? { dispatched_at: NOW } : {}),
    ...(settled ? { settled_at: NOW } : {}),
    ...(input.reconciled !== undefined ? { reconciled: input.reconciled } : {}),
  };
}

function correlationLookup(
  journal: FakeDispatchJournal,
  exchangeToDispatch: Map<string, string>,
): AdpDispatchCorrelationLookup {
  return {
    findDispatchIdByExchange: (exchange_id) => exchangeToDispatch.get(exchange_id),
    getDispatchRecord: (dispatch_id) => journal.record(dispatch_id),
  };
}

// ─────────────────────────────────────────────────────────────
// driver / endpoint 辅助
// ─────────────────────────────────────────────────────────────

function driverRunResult(status: DriverRunResult['status']): DriverRunResult {
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
  };
}

function invokeRequest(
  overrides: Partial<AdpInvokeRequest> & Pick<AdpInvokeRequest, 'execute'>,
): AdpInvokeRequest {
  return {
    task_id: TASK_ID,
    run_id: RUN_ID,
    workspace_path: '/workspace/task-adp',
    instruction: '在 src/protocol/sap.ts 补上判重分支',
    causation_id: 'ex-sap-00041',
    ...overrides,
  };
}

function succeed(input: AdpDriverExecutionInput) {
  input.control.markDispatched();
  return Promise.resolve({ execution: driverRunResult('succeeded') });
}

function transportError(evidence: 'not_executed' | 'execution_unconfirmed', message: string) {
  return () => Promise.reject(new DriverTransportError(message, evidence));
}

// ─────────────────────────────────────────────────────────────
// 确定性异步栅栏（不用 sleep / 定时器）
// ─────────────────────────────────────────────────────────────

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 只推进微任务，直到 predicate 成立（有上限，避免死等）。 */
async function until(predicate: () => boolean, rounds = 256): Promise<void> {
  for (let i = 0; i < rounds && !predicate(); i += 1) await Promise.resolve();
  expect(predicate()).toBe(true);
}

/**
 * 只推进微任务，报告 promise 当前是否已 settle。用于断言「被 deferred 卡住时不会提前 resolve」：
 * 由微任务驱动的 await 链已在 rounds 轮内跑完，仍 pending 即证明它被真实卡住。
 */
async function settlementOf(promise: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> {
  let state: 'resolved' | 'rejected' | undefined;
  promise.then(
    () => {
      state = 'resolved';
    },
    () => {
      state = 'rejected';
    },
  );
  for (let i = 0; i < 256; i += 1) await Promise.resolve();
  return state ?? 'pending';
}

// ─────────────────────────────────────────────────────────────
// 1) 正常 invoke：receipt 权威 + 只跑一次 + 只写一条 reconciled
// ─────────────────────────────────────────────────────────────

describe('AdpReceiptReconciler · 正常 receipt 对账', () => {
  it('executor 成功 → 只执行 1 次，receipt 状态权威地追加 1 条 reconciled', async () => {
    const store = createStore();
    const journal = new FakeDispatchJournal();
    journal.seed(makeRecord({ dispatch_id: 'dispatch-ok', phase: 'dispatched' }));
    const exchange = 'ex-adp-reconcile-ok';
    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(journal, new Map([[exchange, 'dispatch-ok']])),
      now: () => NOW,
    });

    let calls = 0;
    const deliveries: AdpReceiptDelivery[] = [];
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const outcome = await endpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          calls += 1;
          return succeed(input);
        },
        onReceipt: (delivery) => deliveries.push(delivery),
      }),
    );

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('succeeded');
    expect(calls).toBe(1);
    expect(deliveries).toHaveLength(1);

    const result = await reconciler.consumeReceipt(deliveries[0]!);

    expect(result).toMatchObject({
      state: 'reconciled',
      dispatch_id: 'dispatch-ok',
      status: 'succeeded',
    });
    expect(journal.reconciled).toHaveLength(1);
    const appended = journal.reconciled[0]!;
    expect(appended.status).toBe('succeeded');
    expect(appended.reason).toBe('adp receipt reconciled');
    expect(appended.at).toBe(NOW);
    expect(appended.entry_id).toBe('rec_dispatch-ok_succeeded');
    // 确定性 evidence_id + 与 evidence 内容一致的 hash。
    expect(appended.evidence?.evidence_id).toBe('evd_rec_dispatch-ok_succeeded');
    expect(appended.evidence?.status).toBe('succeeded');
    expect(appended.evidence?.dispatch_id).toBe('dispatch-ok');
    expect(appended.evidence_sha256).toBe(hashExecutionEvidence(appended.evidence!));
    // RD-EVD-05：收到可信 receipt = result_received=true，transport 不是 not_executed。
    expect(appended.evidence?.transport).toMatchObject({
      evidence: 'execution_unconfirmed',
      result_received: true,
    });
    // receipt 带回的 driver 结果细节（可在 result 里带上）。
    expect(appended.evidence?.driver_run_result_id).toBeTruthy();
    expect(appended.evidence?.session_id).toBe('session-adp');
    expect(appended.evidence?.usage).toMatchObject({ total_tokens: 7, missing: false });
    // 执行次数仍为 1：对账不触发任何执行。
    expect(calls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 2) transport 证据与 receipt 优先级
// ─────────────────────────────────────────────────────────────

describe('AdpReceiptReconciler · receipt 优先于本地猜测', () => {
  it('transport execution_unconfirmed + ADP unknown → evidence 保持 unknown，不改写 failed', async () => {
    const store = createStore();
    const journal = new FakeDispatchJournal();
    journal.seed(makeRecord({ dispatch_id: 'dispatch-unknown', phase: 'dispatched' }));
    const exchange = 'ex-adp-reconcile-unknown';
    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(journal, new Map([[exchange, 'dispatch-unknown']])),
      now: () => NOW,
    });

    const deliveries: AdpReceiptDelivery[] = [];
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      retryPolicy: createAdpRetryPolicy(),
    });
    const outcome = await endpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          input.control.markDispatched();
          return transportError('execution_unconfirmed', 'transport disconnected mid-run')();
        },
        onReceipt: (delivery) => deliveries.push(delivery),
      }),
    );

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('unknown');
    expect(deliveries).toHaveLength(1);

    const result = await reconciler.consumeReceipt(deliveries[0]!);

    expect(result).toMatchObject({ state: 'reconciled', status: 'unknown' });
    const appended = journal.reconciled[0]!;
    expect(appended.status).toBe('unknown');
    expect(appended.evidence?.status).toBe('unknown');
    // 两个正交字段：transport 是 execution_unconfirmed，result_received=false。
    expect(appended.evidence?.transport).toMatchObject({
      evidence: 'execution_unconfirmed',
      result_received: false,
    });
    // unknown 不携带 error（evidence schema 语义）。
    expect(appended.evidence?.error).toBeUndefined();
    // 对账只写 reconciled，不改折叠记录的 phase/status。
    expect(journal.record('dispatch-unknown')?.phase).toBe('dispatched');
  });

  it('receipt 明确 failed（明确未执行）才判 failed', async () => {
    const store = createStore();
    const journal = new FakeDispatchJournal();
    journal.seed(makeRecord({ dispatch_id: 'dispatch-failed', phase: 'accepted' }));
    const exchange = 'ex-adp-reconcile-failed';
    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(journal, new Map([[exchange, 'dispatch-failed']])),
      now: () => NOW,
    });

    const deliveries: AdpReceiptDelivery[] = [];
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      retryPolicy: createAdpRetryPolicy(),
    });
    const outcome = await endpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: transportError('not_executed', 'spawn ENOENT: driver runner missing'),
        onReceipt: (delivery) => deliveries.push(delivery),
      }),
    );

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('failed');
    expect(deliveries[0]?.receipt.error?.code).toBe('DRIVER_START_FAILED');

    const result = await reconciler.consumeReceipt(deliveries[0]!);

    expect(result).toMatchObject({ state: 'reconciled', status: 'failed' });
    const appended = journal.reconciled[0]!;
    expect(appended.status).toBe('failed');
    expect(appended.evidence?.status).toBe('failed');
    expect(appended.evidence?.error?.code).toBe('DRIVER_START_FAILED');
    // 启动失败 receipt：明确未执行、且没有收到 driver 执行结果（两个正交字段，
    // 不能因为「收到回执」就把 not_executed 升级成 execution_unconfirmed）。
    expect(appended.evidence?.transport).toMatchObject({
      evidence: 'not_executed',
      result_received: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 3) 重复 receipt：幂等，不重复写、不重复执行
// ─────────────────────────────────────────────────────────────

describe('AdpReceiptReconciler · 幂等', () => {
  it('同一 receipt 重复提交 → duplicate，不重复写 journal、不重复执行', async () => {
    const store = createStore();
    const journal = new FakeDispatchJournal();
    journal.seed(makeRecord({ dispatch_id: 'dispatch-dup', phase: 'dispatched' }));
    const exchange = 'ex-adp-reconcile-dup';
    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(journal, new Map([[exchange, 'dispatch-dup']])),
      now: () => NOW,
    });

    let calls = 0;
    const deliveries: AdpReceiptDelivery[] = [];
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    await endpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          calls += 1;
          return succeed(input);
        },
        onReceipt: (delivery) => deliveries.push(delivery),
      }),
    );

    const first = await reconciler.consumeReceipt(deliveries[0]!);
    const second = await reconciler.consumeReceipt(deliveries[0]!);
    const third = await reconciler.consumeReceipt(deliveries[0]!);

    expect(first.state).toBe('reconciled');
    expect(second.state).toBe('duplicate');
    expect(third.state).toBe('duplicate');
    expect(journal.reconciled).toHaveLength(1);
    expect(calls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 4) 迟到 receipt：重启后重复 invoke 同一 exchange，只对账不重执行
// ─────────────────────────────────────────────────────────────

describe('AdpReceiptReconciler · 迟到 receipt 与重启恢复', () => {
  it('重启后 invoke 同一 exchange：既有 receipt 交给 per-invoke 回调，只对账不重执行', async () => {
    const store = createStore();
    const journal = new FakeDispatchJournal();
    // 上一进程死在写 settled 之前：journal 折叠为 dispatched → unknown（RD-JRN-04）。
    journal.seed(makeRecord({ dispatch_id: 'dispatch-late', phase: 'dispatched' }));
    const exchange = 'ex-adp-late-restart';
    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(journal, new Map([[exchange, 'dispatch-late']])),
      now: () => NOW,
    });

    let calls = 0;
    const firstEndpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const first = await firstEndpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          calls += 1;
          return succeed(input);
        },
      }),
    );
    expect(first.state).toBe('settled');
    expect(calls).toBe(1);

    // 进程重启：新 endpoint 实例、同一 P1 store；本次 invoke 显式提供 onReceipt。
    const replayDeliveries: AdpReceiptDelivery[] = [];
    let replayCalls = 0;
    const restartedEndpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const replay = await restartedEndpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          replayCalls += 1;
          return succeed(input);
        },
        onReceipt: (delivery) => replayDeliveries.push(delivery),
      }),
    );

    expect(replay.state).toBe('settled');
    if (replay.state !== 'settled') return;
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe('succeeded');
    expect(replayCalls).toBe(0);
    expect(replayDeliveries).toHaveLength(1);
    // 重启后仍从已落账 invoke 帧取回外层 causation。
    expect(replayDeliveries[0]?.causation_id).toBe('ex-sap-00041');

    const reconciled = await reconciler.consumeReceipt(replayDeliveries[0]!);

    expect(reconciled).toMatchObject({
      state: 'reconciled',
      dispatch_id: 'dispatch-late',
      status: 'succeeded',
    });
    expect(journal.reconciled).toHaveLength(1);
    expect(journal.reconciled[0]?.status).toBe('succeeded');
    // 全程只执行过 1 次（第二个 endpoint 0 次），没有新 attempt / 新副作用。
    expect(calls + replayCalls).toBe(1);
    // reconciled 不改写折叠终态，也不伪造 settled。
    expect(journal.settled).toHaveLength(0);
    expect(journal.record('dispatch-late')?.phase).toBe('dispatched');
  });
});

// ─────────────────────────────────────────────────────────────
// 5) settled 冲突：fail closed，不改写终态
// ─────────────────────────────────────────────────────────────

describe('AdpReceiptReconciler · 已 settled 的冲突', () => {
  it('record 已 settled succeeded、receipt 为 failed → conflict 且不追加 journal', async () => {
    const store = createStore();
    const journal = new FakeDispatchJournal();
    journal.seed(
      makeRecord({ dispatch_id: 'dispatch-conflict', phase: 'settled', status: 'succeeded' }),
    );
    const exchange = 'ex-adp-reconcile-conflict';
    const conflicts: string[] = [];
    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(journal, new Map([[exchange, 'dispatch-conflict']])),
      now: () => NOW,
      onConflict: (info) => conflicts.push(info.reason),
    });

    const deliveries: AdpReceiptDelivery[] = [];
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      retryPolicy: createAdpRetryPolicy(),
    });
    const outcome = await endpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: transportError('not_executed', 'spawn ENOENT: driver runner missing'),
        onReceipt: (delivery) => deliveries.push(delivery),
      }),
    );
    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('failed');

    const result = await reconciler.consumeReceipt(deliveries[0]!);

    expect(result.state).toBe('conflict');
    expect(result.status).toBe('failed');
    expect(journal.reconciled).toHaveLength(0);
    expect(conflicts).toHaveLength(1);
    // 终态没有被悄悄改写。
    expect(journal.record('dispatch-conflict')?.status).toBe('succeeded');
    expect(journal.record('dispatch-conflict')?.phase).toBe('settled');
  });
});

// ─────────────────────────────────────────────────────────────
// 6) 向后兼容：没有新回调时端点行为不变
// ─────────────────────────────────────────────────────────────

describe('AdpDriverEndpoint · 增量回调的向后兼容', () => {
  it('未提供新回调时 options.onReceipt 照旧，per-invoke 不隐式触发', async () => {
    const store = createStore();
    const optionReceipts: AdpReceiptDelivery[] = [];
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      onReceipt: (delivery) => optionReceipts.push(delivery),
    });

    // 只走既有 options.onReceipt：不传 request.onReceipt 时行为与原来一致。
    const first = await endpoint.invoke(invokeRequest({ execute: succeed }));
    expect(first.state).toBe('settled');
    expect(optionReceipts).toHaveLength(1);

    // 显式提供 per-invoke 回调：两者都调用、互不替代。
    const perInvokeReceipts: AdpReceiptDelivery[] = [];
    const second = await endpoint.invoke(
      invokeRequest({
        exchange_id: 'ex-adp-compat-b',
        execute: succeed,
        onReceipt: (delivery) => perInvokeReceipts.push(delivery),
      }),
    );
    expect(second.state).toBe('settled');
    expect(optionReceipts).toHaveLength(2);
    expect(perInvokeReceipts).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 7) 迟到结果观察钩子：只追加 reconciled，不重执行、不改发回执
// ─────────────────────────────────────────────────────────────

describe('AdpReceiptReconciler · 迟到结果', () => {
  it('lateResultObserver → reconcileLateResult 只追加 reconciled，不重执行', async () => {
    const store = createStore();
    const journal = new FakeDispatchJournal();
    journal.seed(makeRecord({ dispatch_id: 'dispatch-late-result', phase: 'dispatched' }));
    const exchange = 'ex-adp-late-result';
    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(journal, new Map([[exchange, 'dispatch-late-result']])),
      now: () => NOW,
    });

    const lateDeliveries: AdpLateResultDelivery[] = [];
    const receipts: AdpReceiptDelivery[] = [];
    let lateResult: ((execution: DriverRunResult) => void) | undefined;
    let calls = 0;
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      retryPolicy: createAdpRetryPolicy(),
      onReceipt: (delivery) => receipts.push(delivery),
      lateResultObserver: (delivery) => {
        lateDeliveries.push(delivery);
      },
    });

    const outcome = await endpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          calls += 1;
          input.control.markDispatched();
          lateResult = input.onLateResult;
          input.onEvent?.({
            schema_version: 'driver-event.v1',
            event_type: 'driver.tool.completed',
            payload: { tool_name: 'write_file' },
          } as DriverStreamEvent);
          return Promise.reject(new Error('transport disconnected mid-run'));
        },
      }),
    );

    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') return;
    expect(outcome.status).toBe('unknown');
    expect(receipts).toHaveLength(1);
    expect(lateResult).toBeDefined();

    // 迟到结果:endpoint 只记调用行,再经观察钩子交给对账器。
    lateResult!(driverRunResult('succeeded'));
    expect(lateDeliveries).toHaveLength(1);
    expect(lateDeliveries[0]?.exchange_id).toBe(exchange);

    const result = await reconciler.reconcileLateResult(lateDeliveries[0]!);

    expect(result).toMatchObject({
      state: 'reconciled',
      dispatch_id: 'dispatch-late-result',
      status: 'succeeded',
    });
    expect(journal.reconciled).toHaveLength(1);
    expect(journal.reconciled[0]?.reason).toBe('adp late result reconciled');
    expect(journal.reconciled[0]?.status).toBe('succeeded');
    // 不重执行、不补发回执、不改已收束的 status。
    expect(calls).toBe(1);
    expect(receipts).toHaveLength(1);
    expect(outcome.status).toBe('unknown');
    expect(journal.settled).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 8) 异常策略与 ignored
// ─────────────────────────────────────────────────────────────

describe('AdpReceiptReconciler · 异常策略与未关联 receipt', () => {
  it('journal 写失败向上抛，不吞异常返回成功', async () => {
    const store = createStore();
    const journal = new FakeDispatchJournal();
    journal.seed(makeRecord({ dispatch_id: 'dispatch-write-fail', phase: 'dispatched' }));
    const exchange = 'ex-adp-write-fail';
    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(journal, new Map([[exchange, 'dispatch-write-fail']])),
      now: () => NOW,
    });

    const deliveries: AdpReceiptDelivery[] = [];
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    await endpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: succeed,
        onReceipt: (delivery) => deliveries.push(delivery),
      }),
    );

    journal.rejectReconciled = new Error('dispatch journal write failed');

    await expect(reconciler.consumeReceipt(deliveries[0]!)).rejects.toThrow(
      'dispatch journal write failed',
    );
    expect(journal.reconciled).toHaveLength(0);
  });

  it('legacy exchange / 缺折叠记录 → ignored，绝不写 journal', async () => {
    const store = createStore();
    const journal = new FakeDispatchJournal();
    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(journal, new Map()),
      now: () => NOW,
    });

    const deliveries: AdpReceiptDelivery[] = [];
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const outcome = await endpoint.invoke(
      invokeRequest({
        exchange_id: 'ex-adp-legacy',
        execute: succeed,
        onReceipt: (delivery) => deliveries.push(delivery),
      }),
    );
    expect(outcome.state).toBe('settled');

    const legacy = await reconciler.consumeReceipt(deliveries[0]!);
    expect(legacy).toMatchObject({ state: 'ignored' });
    expect(journal.reconciled).toHaveLength(0);

    // exchange 能关联到 dispatch_id，但折叠记录不存在（例如 journal 被截断/尚未重建）。
    const missingRecord = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(journal, new Map([['ex-adp-legacy', 'dispatch-missing']])),
      now: () => NOW,
    });
    const missing = await missingRecord.consumeReceipt(deliveries[0]!);
    expect(missing).toMatchObject({ state: 'ignored', dispatch_id: 'dispatch-missing' });
    expect(journal.reconciled).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 9) 审核 #6：onReceiptReconciled 是写屏障（invoke await 对账、失败传播）
// ─────────────────────────────────────────────────────────────

describe('AdpDriverEndpoint · onReceiptReconciled 写屏障', () => {
  it('真实异步 reconciler 直连：通知先于对账，对账完成前 invoke 不 resolve', async () => {
    const store = createStore();
    const journal = new FakeDispatchJournal();
    journal.seed(makeRecord({ dispatch_id: 'dispatch-barrier', phase: 'dispatched' }));
    const exchange = 'ex-adp-barrier';
    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(journal, new Map([[exchange, 'dispatch-barrier']])),
      now: () => NOW,
    });

    const order: string[] = [];
    const gate = deferred();
    let calls = 0;
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const invokePromise = endpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          calls += 1;
          return succeed(input);
        },
        onReceipt: () => order.push('notify'),
        onReceiptReconciled: async (delivery) => {
          order.push('reconcile-start');
          await gate.promise;
          await reconciler.consumeReceipt(delivery);
          order.push('reconcile-done');
        },
      }),
    );

    await until(() => order.includes('reconcile-start'));
    // 通知型回调先触发；对账型回调被 deferred 卡住时 invoke 不会提前 resolve。
    expect(order).toEqual(['notify', 'reconcile-start']);
    expect(await settlementOf(invokePromise)).toBe('pending');
    expect(journal.reconciled).toHaveLength(0);

    gate.resolve();
    const outcome = await invokePromise;

    expect(outcome.state).toBe('settled');
    // invoke resolve 时对账已经完成（journal append 在 resolve 之前）。
    expect(order).toEqual(['notify', 'reconcile-start', 'reconcile-done']);
    expect(journal.reconciled).toHaveLength(1);
    expect(journal.reconciled[0]?.status).toBe('succeeded');
    expect(journal.reconciled[0]?.dispatch_id).toBe('dispatch-barrier');
    expect(calls).toBe(1);
  });

  it('已 settled 重放路径遵守同一完成条件，且绝不重新执行 executor', async () => {
    const store = createStore();
    const journal = new FakeDispatchJournal();
    journal.seed(makeRecord({ dispatch_id: 'dispatch-replay-barrier', phase: 'dispatched' }));
    const exchange = 'ex-adp-replay-barrier';
    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(journal, new Map([[exchange, 'dispatch-replay-barrier']])),
      now: () => NOW,
    });

    let calls = 0;
    const firstEndpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    await firstEndpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          calls += 1;
          return succeed(input);
        },
      }),
    );
    expect(calls).toBe(1);

    const order: string[] = [];
    const gate = deferred();
    let replayCalls = 0;
    const restartedEndpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const invokePromise = restartedEndpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          replayCalls += 1;
          return succeed(input);
        },
        onReceipt: () => order.push('notify'),
        onReceiptReconciled: async (delivery) => {
          order.push('reconcile-start');
          await gate.promise;
          await reconciler.consumeReceipt(delivery);
          order.push('reconcile-done');
        },
      }),
    );

    await until(() => order.includes('reconcile-start'));
    expect(await settlementOf(invokePromise)).toBe('pending');
    expect(journal.reconciled).toHaveLength(0);

    gate.resolve();
    const replayOutcome = await invokePromise;

    expect(replayOutcome.state).toBe('settled');
    if (replayOutcome.state !== 'settled') return;
    expect(replayOutcome.replayed).toBe(true);
    expect(replayCalls).toBe(0);
    expect(calls).toBe(1);
    expect(journal.reconciled).toHaveLength(1);
    expect(journal.reconciled[0]?.status).toBe('succeeded');
  });

  it('对账回调拒绝 → invoke 抛 AdpReceiptReconciliationError（exchange_id + cause）', async () => {
    const store = createStore();
    const cause = new Error('reconcile hook failed');
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const invokePromise = endpoint.invoke(
      invokeRequest({
        exchange_id: 'ex-adp-reconcile-reject',
        execute: succeed,
        onReceiptReconciled: () => Promise.reject(cause),
      }),
    );

    const error: unknown = await invokePromise.then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(AdpReceiptReconciliationError);
    const reconciliationError = error as AdpReceiptReconciliationError;
    expect(reconciliationError.name).toBe('AdpReceiptReconciliationError');
    expect(reconciliationError.exchange_id).toBe('ex-adp-reconcile-reject');
    expect(reconciliationError.cause).toBe(cause);
  });

  it('journal 写失败经真实 reconciler 传播为 AdpReceiptReconciliationError', async () => {
    const store = createStore();
    const journal = new FakeDispatchJournal();
    journal.seed(makeRecord({ dispatch_id: 'dispatch-barrier-write', phase: 'dispatched' }));
    const exchange = 'ex-adp-barrier-write';
    const journalError = new Error('dispatch journal write failed');
    journal.rejectReconciled = journalError;
    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(journal, new Map([[exchange, 'dispatch-barrier-write']])),
      now: () => NOW,
    });
    const endpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const invokePromise = endpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: succeed,
        onReceiptReconciled: async (delivery) => {
          await reconciler.consumeReceipt(delivery);
        },
      }),
    );

    const error: unknown = await invokePromise.then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(AdpReceiptReconciliationError);
    expect((error as AdpReceiptReconciliationError).exchange_id).toBe(exchange);
    expect((error as AdpReceiptReconciliationError).cause).toBe(journalError);
    expect(journal.reconciled).toHaveLength(0);
  });

  it('legacy（不提供 onReceiptReconciled）invoke 正常 resolve，通知回调照旧', async () => {
    const store = createStore();
    const optionReceipts: AdpReceiptDelivery[] = [];
    const perInvokeReceipts: AdpReceiptDelivery[] = [];
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      onReceipt: (delivery) => {
        optionReceipts.push(delivery);
      },
    });

    const outcome = await endpoint.invoke(
      invokeRequest({
        exchange_id: 'ex-adp-barrier-legacy',
        execute: succeed,
        onReceipt: (delivery) => {
          perInvokeReceipts.push(delivery);
        },
      }),
    );

    expect(outcome.state).toBe('settled');
    expect(optionReceipts).toHaveLength(1);
    expect(perInvokeReceipts).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 10) 审核 #6：异步 lateResultObserver（不产生未处理 rejection，flush 可观察）
// ─────────────────────────────────────────────────────────────

describe('AdpDriverEndpoint · 异步 lateResultObserver', () => {
  /** 跑一次 ADP unknown 收束，并交回触发迟到结果的入口。 */
  async function runUnknownExchange(
    lateResultObserver: (delivery: AdpLateResultDelivery) => void | Promise<void>,
  ): Promise<{
    store: SqliteCoordinationStore;
    endpoint: AdpDriverEndpoint;
    lateResult: (execution: DriverRunResult) => void;
  }> {
    const store = createStore();
    let lateResult: ((execution: DriverRunResult) => void) | undefined;
    const endpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      retryPolicy: createAdpRetryPolicy(),
      lateResultObserver,
    });
    const outcome = await endpoint.invoke(
      invokeRequest({
        exchange_id: createId('ex_adp_late_async'),
        execute: (input) => {
          input.control.markDispatched();
          lateResult = input.onLateResult;
          return Promise.reject(new Error('transport disconnected mid-run'));
        },
      }),
    );
    expect(outcome.state).toBe('settled');
    if (outcome.state !== 'settled') throw new Error('unreachable');
    expect(outcome.status).toBe('unknown');
    expect(lateResult).toBeDefined();
    return { store, endpoint, lateResult: lateResult! };
  }

  it('flushLateResultObservers 等待在飞观察器后才 resolve', async () => {
    const gate = deferred();
    const { endpoint, lateResult } = await runUnknownExchange(() => gate.promise);

    lateResult(driverRunResult('succeeded'));
    const flushing = endpoint.flushLateResultObservers();
    expect(await settlementOf(flushing)).toBe('pending');

    gate.resolve();
    await expect(flushing).resolves.toBeUndefined();
  });

  it('观察器异步失败：无未处理 rejection，flush 重抛第一个错误，调用行照常落账', async () => {
    const { store, endpoint, lateResult } = await runUnknownExchange(() =>
      Promise.reject(new Error('late reconcile failed')),
    );

    // 观察器返回的 rejected Promise 必须已被 endpoint 挂上处理器，不能变成未处理 rejection。
    lateResult(driverRunResult('succeeded'));

    // 协议调用行行为不变：迟到结果照旧留档，不改已发回执、不重执行。
    const lateRow = store
      .listJournal(TASK_ID, RUN_ID)
      .find((row) => row.event === 'driver.invocation_late_result');
    expect(lateRow).toMatchObject({ status: 'succeeded' });

    await expect(endpoint.flushLateResultObservers()).rejects.toThrow('late reconcile failed');
    // 错误已被 flush 观察并清空：再次 flush 不重复抛。
    await expect(endpoint.flushLateResultObservers()).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// 11) 已 settled 重放的阶段证据（审核 #5 语义：不能从 receipt.status 推导 result_received）
// ─────────────────────────────────────────────────────────────

describe('AdpDriverEndpoint · 重放 receipt 的阶段证据', () => {
  it('重放 unknown receipt：evidence 保持 unknown/false/execution_unconfirmed，不触发证据矛盾', async () => {
    const store = createStore();
    const journal = new FakeDispatchJournal();
    journal.seed(makeRecord({ dispatch_id: 'dispatch-replay-unknown', phase: 'dispatched' }));
    const exchange = 'ex-adp-replay-unknown';

    const firstEndpoint = new AdpDriverEndpoint({
      store,
      side_effect: 'workspace_write',
      retryPolicy: createAdpRetryPolicy(),
    });
    const firstOutcome = await firstEndpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: (input) => {
          input.control.markDispatched();
          return transportError('execution_unconfirmed', 'transport disconnected mid-run')();
        },
      }),
    );
    expect(firstOutcome.state).toBe('settled');
    if (firstOutcome.state !== 'settled') return;
    expect(firstOutcome.status).toBe('unknown');

    const reconciler = new AdpReceiptReconciler({
      journal,
      lookup: correlationLookup(
        journal,
        new Map([[exchange, 'dispatch-replay-unknown']]),
      ),
      now: () => NOW,
    });
    let replayCalls = 0;
    const restartedEndpoint = new AdpDriverEndpoint({ store, side_effect: 'workspace_write' });
    const replayOutcome = await restartedEndpoint.invoke(
      invokeRequest({
        exchange_id: exchange,
        execute: () => {
          replayCalls += 1;
          return Promise.resolve({ execution: driverRunResult('succeeded') });
        },
        onReceiptReconciled: async (delivery) => {
          await reconciler.consumeReceipt(delivery);
        },
      }),
    );

    expect(replayOutcome.state).toBe('settled');
    if (replayOutcome.state !== 'settled') return;
    expect(replayOutcome.replayed).toBe(true);
    expect(replayOutcome.status).toBe('unknown');
    expect(replayCalls).toBe(0);
    expect(journal.reconciled).toHaveLength(1);
    expect(journal.reconciled[0]?.status).toBe('unknown');
    expect(journal.reconciled[0]?.evidence?.transport).toMatchObject({
      evidence: 'execution_unconfirmed',
      result_received: false,
    });
  });
});
