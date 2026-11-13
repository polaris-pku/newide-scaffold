/**
 * 阶段 1 写屏障 + 崩溃注入测试（JRN-01 / JRN-06 的阶段 1 部分）。
 *
 * 用 fake driver + 可注入故障的 `DispatchJournalPort` 在 **每一个持久化边界** 注入失败，
 * 断言：
 * - 屏障前失败绝不调用 driver（副作用 0 次）；
 * - 屏障后失败绝不返回成功结果；
 * - 恢复折叠区分 not_executed / unknown / settled，已完成或状态不明的 dispatch
 *   不会被自动重放（同一 dispatch_id 再次派工被拒，driver 调用次数不增加）。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildExecutionBrief,
  hashExecutionEvidence,
  sha256Hex,
  type BudgetSnapshot,
  type DispatchAttemptObservation,
  type DispatchJournalPort,
  type EvidenceArtifactRef,
  type ExecutionEvidence,
  type ExecutionStatus,
  type JournalViolation,
  type AcceptedAppendInput,
  type DispatchedAppendInput,
  type EvidenceAppendInput,
  type ReconciledAppendInput,
  type SettledAppendInput,
} from '../../src/driver/execution-contract';
import {
  DispatchJournalBarrierError,
  runJournaledDispatch,
} from '../../src/driver/dispatch-attempt';
import { DriverTransportError } from '../../src/driver/driver-transport-error';
import {
  createNodeDispatchJournalIo,
  JournalCorruptionError,
  RunDispatchJournal,
  type DispatchJournalIo,
} from '../../src/persistence';

const BUDGET: BudgetSnapshot = {
  dispatches_left: 11,
  role_tokens_left: 100_000,
  deadline_at: '2026-11-13T05:45:00.000Z',
};

const IDENTITY = {
  dispatch_id: 'dsp_0001',
  task_id: 'task_0001',
  run_id: 'run_0001',
  role_id: 'role_impl',
  sequence: 1,
  accepted_at: '2026-11-13T05:00:00.000Z',
};

type JournalMethod =
  | 'appendAccepted'
  | 'appendDispatched'
  | 'appendEvidence'
  | 'appendSettled'
  | 'appendReconciled';

interface FakeRecord {
  accepted: boolean;
  dispatched: boolean;
  evidence?: ExecutionEvidence;
  evidence_sha256?: string;
  settled_status?: ExecutionStatus;
  violations?: JournalViolation[];
}

/** 内存版 journal 端口：记录调用顺序、模拟单写者/重复派工拒绝、支持故障注入。 */
class FakeJournal implements DispatchJournalPort {
  readonly order: string[] = [];
  readonly records = new Map<string, FakeRecord>();
  calls = 0;

  private failure?: {
    method: JournalMethod;
    /** before = 写之前失败（无行落盘）；after = 写成功但持久化确认失败。 */
    mode: 'before' | 'after';
  };

  constructor(failure?: {
    method: JournalMethod;
    /** before = 写之前失败（无行落盘）；after = 写成功但持久化确认失败。 */
    mode: 'before' | 'after';
  }) {
    this.failure = failure;
  }

  clearInjectedFailure(): void {
    this.failure = undefined;
  }

  recoveryStatus(dispatchId: string): 'absent' | 'not_executed' | 'unknown' | ExecutionStatus {
    const record = this.records.get(dispatchId);
    if (!record) return 'absent';
    if (record.settled_status) return record.settled_status;
    if (record.dispatched) return 'unknown';
    if (record.accepted) return 'not_executed';
    return 'absent';
  }

  async appendAccepted(input: AcceptedAppendInput): Promise<void> {
    await this.step('appendAccepted', () => {
      const dispatchId = input.brief.dispatch_id;
      const existing = this.records.get(dispatchId);
      if (existing?.accepted) {
        throw Object.assign(new Error('journal_duplicate_dispatch'), {
          code: 'journal_duplicate_dispatch',
        });
      }
      this.records.set(dispatchId, { accepted: true, dispatched: false });
      this.order.push(`accepted:${dispatchId}`);
    });
  }

  async appendDispatched(input: DispatchedAppendInput): Promise<void> {
    await this.step('appendDispatched', () => {
      const record = this.records.get(input.dispatch_id);
      if (!record?.accepted) throw new Error('journal_unknown_dispatch');
      if (record.settled_status !== undefined) throw new Error('journal_dispatch_after_settle');
      record.dispatched = true;
      this.order.push(`dispatched:${input.dispatch_id}`);
    });
  }

  async appendEvidence(input: EvidenceAppendInput): Promise<EvidenceArtifactRef> {
    let result: EvidenceArtifactRef | undefined;
    await this.step('appendEvidence', () => {
      const record = this.records.get(input.dispatch_id);
      if (!record?.dispatched) throw new Error('journal_evidence_without_dispatch');
      const sha256 = hashExecutionEvidence(input.evidence);
      record.evidence = input.evidence;
      record.evidence_sha256 = sha256;
      result = {
        ref: { path: `journal/evidence/${input.dispatch_id}.json`, sha256 },
        sha256,
      };
      this.order.push(`evidence:${input.dispatch_id}`);
    });
    return result as EvidenceArtifactRef;
  }

  async appendSettled(input: SettledAppendInput): Promise<void> {
    await this.step('appendSettled', () => {
      const record = this.records.get(input.dispatch_id);
      if (!record?.evidence || !record.dispatched) throw new Error('journal_settled_before_evidence');
      if (
        input.evidence_sha256 !== hashExecutionEvidence(input.evidence) ||
        input.status !== input.evidence.status
      ) {
        throw new Error('journal_conflict');
      }
      record.settled_status = input.status;
      record.violations = [...input.violations];
      this.order.push(`settled:${input.dispatch_id}`);
    });
  }

  async appendReconciled(_input: ReconciledAppendInput): Promise<void> {
    await this.step('appendReconciled', () => undefined);
  }

  private async step(method: JournalMethod, operation: () => void): Promise<void> {
    this.calls += 1;
    const failBefore = this.failure?.method === method && this.failure.mode === 'before';
    if (failBefore) throw new Error(`injected ${method} failure`);
    operation();
    const failAfter = this.failure?.method === method && this.failure.mode === 'after';
    if (failAfter) throw new Error(`injected ${method} durability failure`);
  }
}

interface FakeDriver {
  calls: () => number;
  execute: () => Promise<DispatchAttemptObservation>;
}

function fakeDriver(
  behavior: () => Promise<DispatchAttemptObservation> | DispatchAttemptObservation,
): FakeDriver {
  let calls = 0;
  return {
    calls: () => calls,
    execute: async () => {
      calls += 1;
      return behavior();
    },
  };
}

function succeeded(extra: Partial<DispatchAttemptObservation> = {}): DispatchAttemptObservation {
  return {
    transport: { evidence: 'execution_unconfirmed', result_received: true },
    result: { status: 'succeeded', driver_id: 'drv_1', session_id: 'sess_1', response: 'ok' },
    duration_ms: 5,
    ...extra,
  };
}

function briefFor(
  kind: 'investigate' | 'execute' | 'verify' = 'execute',
  overrides: Partial<typeof IDENTITY> = {},
) {
  return buildExecutionBrief({
    identity: { ...IDENTITY, ...overrides },
    request: { kind, instruction: `do ${kind} work` },
  });
}

async function attempt(
  journal: DispatchJournalPort,
  driver: FakeDriver,
  built = briefFor(),
) {
  return runJournaledDispatch({
    journal,
    brief: built.brief,
    brief_sha256: built.brief_sha256,
    budget_before: BUDGET,
    execute: driver.execute,
    evidence_id: 'evd_0001',
  });
}

describe('写屏障顺序与成功路径', () => {
  it('accepted → dispatched → driver → evidence → settled，且只调用一次 driver', async () => {
    const journal = new FakeJournal();
    const driver = fakeDriver(() => succeeded());
    const built = briefFor();

    const result = await attempt(journal, driver, built);

    expect(driver.calls()).toBe(1);
    expect(journal.order).toEqual([
      'accepted:dsp_0001',
      'dispatched:dsp_0001',
      'evidence:dsp_0001',
      'settled:dsp_0001',
    ]);
    expect(result.status).toBe('succeeded');
    expect(result.attempts).toBe(1);
    expect(result.evidence_sha256).toBe(hashExecutionEvidence(result.evidence));
    expect(journal.recoveryStatus('dsp_0001')).toBe('succeeded');
  });

  it('settled 只在 evidence 之后写；evidence 的 sha256 被带到 settled', async () => {
    const journal = new FakeJournal();
    const built = briefFor();
    await attempt(journal, fakeDriver(() => succeeded()), built);
    const record = journal.records.get('dsp_0001');
    expect(record?.evidence_sha256).toBe(hashExecutionEvidence(record?.evidence as ExecutionEvidence));
  });
});

describe('屏障失败：绝不调用 driver / 绝不成功返回', () => {
  it('accepted 写失败 → 不调用 driver，副作用确定未执行', async () => {
    const journal = new FakeJournal({ method: 'appendAccepted', mode: 'before' });
    const driver = fakeDriver(() => succeeded());

    await expect(attempt(journal, driver)).rejects.toMatchObject({
      name: 'DispatchJournalBarrierError',
      stage: 'accepted',
      code: 'accepted_write_failed',
      driver_invoked: false,
      side_effect_state: 'not_executed',
    });
    expect(driver.calls()).toBe(0);
    expect(journal.recoveryStatus('dsp_0001')).toBe('absent');
  });

  it('dispatched 写失败 → 不调用 driver，恢复折叠为 not_executed', async () => {
    const journal = new FakeJournal({ method: 'appendDispatched', mode: 'before' });
    const driver = fakeDriver(() => succeeded());

    const error = await attempt(journal, driver).catch((caught) => caught);
    expect(error).toBeInstanceOf(DispatchJournalBarrierError);
    expect(error).toMatchObject({
      stage: 'dispatched',
      driver_invoked: false,
      side_effect_state: 'not_executed',
    });
    expect(driver.calls()).toBe(0);
    expect(journal.recoveryStatus('dsp_0001')).toBe('not_executed');
  });

  it('evidence 写失败 → driver 已调用，恢复折叠为 unknown，绝不成功返回', async () => {
    const journal = new FakeJournal({ method: 'appendEvidence', mode: 'before' });
    const driver = fakeDriver(() => succeeded());

    await expect(attempt(journal, driver)).rejects.toMatchObject({
      stage: 'evidence',
      code: 'evidence_write_failed',
      driver_invoked: true,
      side_effect_state: 'unknown',
    });
    expect(driver.calls()).toBe(1);
    expect(journal.recoveryStatus('dsp_0001')).toBe('unknown');
    expect(journal.records.get('dsp_0001')?.settled_status).toBeUndefined();
  });

  it('evidence 已落盘但持久化确认失败 → 仍不得写 settled / 返回成功', async () => {
    const journal = new FakeJournal({ method: 'appendEvidence', mode: 'after' });
    const driver = fakeDriver(() => succeeded());

    await expect(attempt(journal, driver)).rejects.toMatchObject({
      stage: 'evidence',
      driver_invoked: true,
      side_effect_state: 'unknown',
    });
    expect(driver.calls()).toBe(1);
    expect(journal.records.get('dsp_0001')?.settled_status).toBeUndefined();
    expect(journal.recoveryStatus('dsp_0001')).toBe('unknown');
  });

  it('settled 写失败 → evidence 已持久化但恢复仍保守为 unknown', async () => {
    const journal = new FakeJournal({ method: 'appendSettled', mode: 'before' });
    const driver = fakeDriver(() => succeeded());

    await expect(attempt(journal, driver)).rejects.toMatchObject({
      stage: 'settled',
      code: 'settled_write_failed',
      driver_invoked: true,
      side_effect_state: 'unknown',
    });
    expect(journal.records.get('dsp_0001')?.evidence).toBeDefined();
    expect(journal.recoveryStatus('dsp_0001')).toBe('unknown');
  });

  it('settled 已落盘但持久化确认失败 → 调用方收到失败；恢复可见 settled 事实', async () => {
    const journal = new FakeJournal({ method: 'appendSettled', mode: 'after' });
    const driver = fakeDriver(() => succeeded());

    await expect(attempt(journal, driver)).rejects.toMatchObject({
      stage: 'settled',
      driver_invoked: true,
      side_effect_state: 'unknown',
    });
    // 行可能已在磁盘上：恢复折叠允许看到 settled，但本次调用绝不能返回成功。
    expect(journal.recoveryStatus('dsp_0001')).toBe('succeeded');
  });
});

describe('恢复：已完成 / 状态不明的副作用不会被自动重放', () => {
  it.each([
    ['dispatched before', { method: 'appendDispatched', mode: 'before' } as const],
    ['evidence before', { method: 'appendEvidence', mode: 'before' } as const],
    ['settled before', { method: 'appendSettled', mode: 'before' } as const],
    ['settled after', { method: 'appendSettled', mode: 'after' } as const],
  ])('%s 崩溃后，同 dispatch_id 再次派工被拒绝且 driver 不再被调用', async (_label, failure) => {
    const journal = new FakeJournal(failure);
    const driver = fakeDriver(() => succeeded());
    await attempt(journal, driver).catch(() => undefined);
    const callsAfterCrash = driver.calls();

    await expect(attempt(journal, driver)).rejects.toMatchObject({
      stage: 'accepted',
      driver_invoked: false,
    });
    expect(driver.calls()).toBe(callsAfterCrash);
  });

  it('accepted 写失败（没有 accepted 行）时允许同 id 重新开始，且只真正执行一次', async () => {
    const journal = new FakeJournal({ method: 'appendAccepted', mode: 'before' });
    const driver = fakeDriver(() => succeeded());
    await attempt(journal, driver).catch(() => undefined);
    expect(driver.calls()).toBe(0);

    // 第一次 accepted 根本没落盘 → 重试同 id 是安全的新尝试。
    journal.clearInjectedFailure();
    const result = await attempt(journal, driver);
    expect(result.status).toBe('succeeded');
    expect(driver.calls()).toBe(1);
  });

  it('driver 抛错按 transport 证据归类：execution_unconfirmed → unknown（禁止自动重放）', async () => {
    const journal = new FakeJournal();
    const driver = fakeDriver(() => {
      throw new DriverTransportError('stream closed after dispatch', 'execution_unconfirmed');
    });

    const result = await attempt(journal, driver);
    expect(result.status).toBe('unknown');
    expect(result.evidence.transport).toMatchObject({
      evidence: 'execution_unconfirmed',
      result_received: false,
    });
    expect(journal.recoveryStatus('dsp_0001')).toBe('unknown');
  });

  it('driver 明确未执行 → failed + not_executed（与 unknown 分开）', async () => {
    const journal = new FakeJournal();
    const driver = fakeDriver(() => {
      throw new DriverTransportError('spawn failed', 'not_executed');
    });

    const result = await attempt(journal, driver);
    expect(result.status).toBe('failed');
    expect(result.evidence.transport.evidence).toBe('not_executed');
    expect(result.evidence.error?.code).toBe('DRIVER_START_FAILED');
    expect(journal.recoveryStatus('dsp_0001')).toBe('failed');
  });
});

describe('ADP receipt 优先于本地猜测', () => {
  it('receipt=failed 覆盖 transport 的不确定证据', async () => {
    const journal = new FakeJournal();
    const driver = fakeDriver(() => ({
      transport: { evidence: 'execution_unconfirmed' },
      adp_receipt: { status: 'failed', result_received: true },
      error: { code: 'ADP_FAILED', message: 'driver reported failure', retryable: false },
    }));

    const result = await attempt(journal, driver);
    expect(result.status).toBe('failed');
    expect(result.evidence.error?.code).toBe('ADP_FAILED');
  });

  it('receipt=unknown 且无可信结果 → unknown / result_received=false（不升格 succeeded）', async () => {
    const journal = new FakeJournal();
    const driver = fakeDriver(() => ({
      transport: { evidence: 'execution_unconfirmed' },
      adp_receipt: { status: 'unknown', result_received: false },
    }));

    const result = await attempt(journal, driver);
    expect(result.status).toBe('unknown');
    expect(result.evidence.transport).toMatchObject({
      evidence: 'execution_unconfirmed',
      result_received: false,
    });
  });

  it('本地 result 与 receipt result_received=false 矛盾 → fail closed，不产生成功 settled', async () => {
    const journal = new FakeJournal();
    const driver = fakeDriver(() => ({
      ...succeeded(),
      adp_receipt: { status: 'unknown', result_received: false },
    }));

    await expect(attempt(journal, driver)).rejects.toThrow(/contradicts ADP receipt/);
    expect(driver.calls()).toBe(1);
    // accepted+dispatched 已落盘、没有 settled → 恢复只能保守为 unknown。
    expect(journal.recoveryStatus('dsp_0001')).toBe('unknown');
  });
});

describe('只读违规与证据诚实性', () => {
  it('investigate 产生工作区差异 → violation + 成功降级为 failed，且不回滚', async () => {
    const journal = new FakeJournal();
    const driver = fakeDriver(() =>
      succeeded({
        workspace_delta: { changed_paths: ['src/secret.ts'], coverage: 'partial' },
      }),
    );

    const result = await attempt(journal, driver, briefFor('investigate'));
    expect(result.status).toBe('failed');
    expect(result.violations).toContain('read_only_changed');
    expect(result.evidence.error?.code).toBe('READ_ONLY_VIOLATION');
    expect(journal.records.get('dsp_0001')?.settled_status).toBe('failed');
    expect(journal.recoveryStatus('dsp_0001')).toBe('failed');
  });

  it('verify 声明只读但产生写缓存：result 与 ADP receipt 都成功，最终仍必须 failed', async () => {
    const journal = new FakeJournal();
    const receiptObservation = {
      transport: { evidence: 'execution_unconfirmed' as const, result_received: true },
      result: { status: 'succeeded' as const, response: 'ok' },
      adp_receipt: { status: 'succeeded' as const, result_received: true },
      workspace_delta: { changed_paths: ['.vitest/cache'], coverage: 'partial' as const },
    };
    const snapshot = structuredClone(receiptObservation);
    const driver = fakeDriver(() => receiptObservation);

    const result = await attempt(journal, driver, briefFor('verify'));

    expect(result.status).toBe('failed');
    expect(result.evidence.status).toBe('failed');
    expect(result.evidence.error?.code).toBe('READ_ONLY_VIOLATION');
    expect(result.violations).toContain('read_only_changed');
    // 返回、evidence、settled 的状态一致；原始 ADP receipt 事实未被篡改。
    expect(journal.records.get('dsp_0001')?.settled_status).toBe('failed');
    expect(journal.recoveryStatus('dsp_0001')).toBe('failed');
    expect(receiptObservation.adp_receipt).toEqual(snapshot.adp_receipt);
    expect(receiptObservation.result).toEqual(snapshot.result);
  });

  it('只有成功 receipt、没有 result 对象时也不能绕过只读违规检查', async () => {
    const journal = new FakeJournal();
    const driver = fakeDriver(() => ({
      transport: { evidence: 'execution_unconfirmed' as const, result_received: true },
      adp_receipt: { status: 'succeeded' as const, result_received: true },
      workspace_delta: { changed_paths: ['src/generated.ts'], coverage: 'partial' as const },
    }));

    const result = await attempt(journal, driver, briefFor('investigate'));
    expect(result.status).toBe('failed');
    expect(result.evidence.error?.code).toBe('READ_ONLY_VIOLATION');
    expect(journal.records.get('dsp_0001')?.settled_status).toBe('failed');
  });

  it('非只读 execute 产生工作区改动属于正常行为，不降级', async () => {
    const journal = new FakeJournal();
    const driver = fakeDriver(() =>
      succeeded({ workspace_delta: { changed_paths: ['src/fix.ts'], coverage: 'partial' } }),
    );

    const result = await attempt(journal, driver, briefFor('execute'));
    expect(result.status).toBe('succeeded');
    expect(result.violations).toEqual([]);
    expect(journal.recoveryStatus('dsp_0001')).toBe('succeeded');
  });

  it('只读派工未产生工作区改动时保持成功', async () => {
    const journal = new FakeJournal();
    const driver = fakeDriver(() =>
      succeeded({ workspace_delta: { changed_paths: [], coverage: 'complete' } }),
    );

    const result = await attempt(journal, driver, briefFor('investigate'));
    expect(result.status).toBe('succeeded');
    expect(result.violations).toEqual([]);
  });

  it('runner exit 0 + 无命令结果：checks 为空、usage 缺失记 missing，不冒充检查通过', async () => {
    const journal = new FakeJournal();
    const driver = fakeDriver(() => ({
      transport: { evidence: 'execution_unconfirmed', runner_exit_code: 0 },
      result: { status: 'succeeded', response: 'tests passed (claimed)' },
    }));

    const result = await attempt(journal, driver);
    expect(result.evidence.checks).toEqual([]);
    expect(result.evidence.transport.runner_exit_code).toBe(0);
    expect(result.evidence.usage).toEqual({ missing: true, source: 'none' });
  });

  it('workspace coverage=unavailable 记 scope_unconfirmed 但不伪造差异', async () => {
    const journal = new FakeJournal();
    const driver = fakeDriver(() =>
      succeeded({ workspace_delta: { changed_paths: [], coverage: 'unavailable' } }),
    );

    const result = await attempt(journal, driver, briefFor('investigate'));
    expect(result.status).toBe('succeeded');
    expect(result.violations).toContain('scope_unconfirmed');
  });
});

// ─────────────────────────────────────────────────────────────
// 真实 RunDispatchJournal 集成：写屏障 + 崩溃恢复折叠 + 受控 evidence
// ─────────────────────────────────────────────────────────────

interface FaultPlan {
  method: 'appendLineWithFsync' | 'writeFileExclusive';
  call: number;
  mode: 'before' | 'after';
}

/** 包装真实 Node IO：只在“武装”后按方法/调用序号注入一次失败。 */
function createFaultIo(): {
  io: DispatchJournalIo;
  arm(plan: FaultPlan): void;
  disarm(): void;
} {
  const base = createNodeDispatchJournalIo();
  let plan: FaultPlan | undefined;
  let appendCalls = 0;
  let exclusiveCalls = 0;
  const io: DispatchJournalIo = {
    ...base,
    async appendLineWithFsync(filePath: string, line: string): Promise<void> {
      appendCalls += 1;
      const hit = plan?.method === 'appendLineWithFsync' && plan.call === appendCalls;
      if (hit && plan.mode === 'before') throw new Error('injected append failure');
      await base.appendLineWithFsync(filePath, line);
      if (hit) throw new Error('injected append durability failure');
    },
    async writeFileExclusive(filePath: string, data: Uint8Array): Promise<void> {
      exclusiveCalls += 1;
      const hit = plan?.method === 'writeFileExclusive' && plan.call === exclusiveCalls;
      if (hit && plan.mode === 'before') throw new Error('injected exclusive write failure');
      await base.writeFileExclusive(filePath, data);
      if (hit) throw new Error('injected exclusive write durability failure');
    },
  };
  return {
    io,
    arm(next) {
      plan = next;
      appendCalls = 0;
      exclusiveCalls = 0;
    },
    disarm() {
      plan = undefined;
    },
  };
}

const RUN_IDENTITY = {
  run_id: IDENTITY.run_id,
  task_id: IDENTITY.task_id,
  role_id: IDENTITY.role_id,
};

describe('真实 RunDispatchJournal 集成', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function createRunDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-journal-'));
    tempDirs.push(dir);
    return dir;
  }

  async function openJournal(dir: string, io?: DispatchJournalIo) {
    return RunDispatchJournal.open({
      runDir: dir,
      identity: RUN_IDENTITY,
      ...(io ? { io } : {}),
    });
  }

  function journalFilePath(dir: string): string {
    return path.join(dir, 'journal', 'dispatches.jsonl');
  }

  it('成功路径：journal 顺序、evidence 受控读取、重开 fold 确定、重复派工被拒', async () => {
    const dir = await createRunDir();
    const io = createNodeDispatchJournalIo();
    let journal = await openJournal(dir, io);
    const driver = fakeDriver(() => succeeded());
    const built = briefFor();

    const result = await attempt(journal, driver, built);
    expect(driver.calls()).toBe(1);
    expect(journal.currentDurability.mode).toMatch(/^(fsync|best_effort)$/);

    const fold = await journal.fold();
    expect(fold.records).toHaveLength(1);
    const record = fold.records[0]!;
    expect(record).toMatchObject({
      dispatch_id: 'dsp_0001',
      phase: 'settled',
      status: 'succeeded',
    });
    expect(record.evidence_sha256).toBe(result.evidence_sha256);

    const page = await journal.readEvidence(result.evidence_ref, {
      offset: 0,
      limit: 1_000_000,
    });
    expect(page.sha256).toBe(result.evidence_sha256);
    expect(JSON.parse(page.text)).toMatchObject({
      dispatch_id: 'dsp_0001',
      status: 'succeeded',
    });

    // 未登记 ref 一律拒绝（任意路径无法借 readEvidence 读出）。
    await expect(
      journal.readEvidence({
        path: 'journal/evidence/dsp_9999.json',
        sha256: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'evidence_ref_not_registered' });

    // 重开后 fold 结果可重复读取。
    await journal.close();
    journal = await openJournal(dir, io);
    const again = await journal.fold();
    expect(again.records[0]?.evidence_sha256).toBe(result.evidence_sha256);

    // 已 settled 的 dispatch 再次派工被拒，driver 调用次数不增加。
    await expect(attempt(journal, driver, built)).rejects.toMatchObject({
      stage: 'accepted',
      driver_invoked: false,
    });
    expect(driver.calls()).toBe(1);

    // 篡改 evidence 侧车 → hash 失配 fail closed。
    await fs.writeFile(path.join(dir, result.evidence_ref.path), '{"tampered":true}', 'utf8');
    await expect(journal.readEvidence(result.evidence_ref)).rejects.toMatchObject({
      code: 'evidence_hash_mismatch',
    });
    await journal.close();
  });

  const crashWindows: Array<{
    label: string;
    plan: FaultPlan;
    stage: 'accepted' | 'dispatched' | 'evidence' | 'settled';
    driverInvoked: boolean;
    expected: 'not_executed_or_absent' | 'unknown' | 'succeeded';
  }> = [
    {
      label: 'accepted 写之前',
      plan: { method: 'appendLineWithFsync', call: 1, mode: 'before' },
      stage: 'accepted',
      driverInvoked: false,
      expected: 'not_executed_or_absent',
    },
    {
      label: 'dispatched 写之前',
      plan: { method: 'appendLineWithFsync', call: 2, mode: 'before' },
      stage: 'dispatched',
      driverInvoked: false,
      expected: 'not_executed',
    },
    {
      label: 'evidence 写之前',
      plan: { method: 'writeFileExclusive', call: 1, mode: 'before' },
      stage: 'evidence',
      driverInvoked: true,
      expected: 'unknown',
    },
    {
      label: 'settled 写之前',
      plan: { method: 'appendLineWithFsync', call: 3, mode: 'before' },
      stage: 'settled',
      driverInvoked: true,
      expected: 'unknown',
    },
    {
      label: 'settled 写之后（持久化确认失败）',
      plan: { method: 'appendLineWithFsync', call: 3, mode: 'after' },
      stage: 'settled',
      driverInvoked: true,
      expected: 'succeeded',
    },
  ];

  it.each(crashWindows)(
    '崩溃窗口「$label」：恢复折叠不自动重放，副作用次数不再增加',
    async ({ plan, stage, driverInvoked, expected }) => {
      const dir = await createRunDir();
      const fault = createFaultIo();
      let journal = await openJournal(dir, fault.io);
      const driver = fakeDriver(() => succeeded());
      const built = briefFor();

      fault.arm(plan);
      await expect(attempt(journal, driver, built)).rejects.toMatchObject({
        name: 'DispatchJournalBarrierError',
        stage,
        driver_invoked: driverInvoked,
      });
      expect(driver.calls()).toBe(driverInvoked ? 1 : 0);

      fault.disarm();
      await journal.close();
      journal = await openJournal(dir, fault.io);
      const fold = await journal.fold();
      if (expected === 'not_executed_or_absent') {
        const recovered =
          fold.records.length === 0 ? 'absent' : fold.records[0]!.status;
        expect(['absent', 'not_executed']).toContain(recovered);
      } else {
        expect(fold.records[0]!.status).toBe(expected);
      }

      // 恢复后再次派工：状态不明的 dispatch 一律被拒（不重放）；
      // accepted 从未落盘时，同 id 重来是安全的新尝试（driver 只真正执行一次）。
      if (expected === 'not_executed_or_absent') {
        const retried = await attempt(journal, driver, built);
        expect(retried.status).toBe('succeeded');
        expect(driver.calls()).toBe(1);
      } else {
        await expect(attempt(journal, driver, built)).rejects.toMatchObject({
          stage: 'accepted',
          driver_invoked: false,
        });
        expect(driver.calls()).toBe(driverInvoked ? 1 : 0);
      }
      await journal.close();
    },
  );

  it('尾部半写：repair 保留原字节/hash，修后 fold 可重复读取且不重放', async () => {
    const dir = await createRunDir();
    const fault = createFaultIo();
    let journal = await openJournal(dir, fault.io);
    const driver = fakeDriver(() => succeeded());
    const built = briefFor();

    // 在 settled 前崩溃：accepted+dispatched 已持久化，driver 已执行一次。
    fault.arm({ method: 'appendLineWithFsync', call: 3, mode: 'before' });
    await expect(attempt(journal, driver, built)).rejects.toMatchObject({ stage: 'settled' });
    fault.disarm();
    await journal.close();

    // 模拟进程在写 settled 行时被 kill：文件尾部留下半截 JSON。
    const halfLine = '{"event":"settled","dispatch_id":"dsp_0001","sequence":1';
    await fs.appendFile(journalFilePath(dir), halfLine, 'utf8');

    journal = await openJournal(dir, fault.io);
    const beforeRepair = await journal.read();
    expect(beforeRepair.status).toBe('repairable_tail');
    expect(beforeRepair.discarded_tail?.sha256).toBe(sha256Hex(Buffer.from(halfLine, 'utf8')));
    await expect(journal.fold()).rejects.toBeInstanceOf(JournalCorruptionError);

    const repair = await journal.repairTail({ reason: 'test tail half write' });
    expect(repair).toBeDefined();
    expect(repair?.discarded_tail_sha256).toBe(sha256Hex(Buffer.from(halfLine, 'utf8')));

    // 原始字节被原样保留在侧车里。
    const preserved = await fs.readFile(path.join(dir, repair!.discarded_tail_ref.path));
    expect(preserved.toString('utf8')).toBe(halfLine);
    expect(sha256Hex(preserved)).toBe(repair!.discarded_tail_sha256);

    // 修复后可重复 fold，且恢复状态是 unknown（不能当成功处理）。
    const afterRepair = await journal.read();
    expect(afterRepair.status).toBe('ok');
    expect(afterRepair.repairs).toHaveLength(1);
    const firstFold = await journal.fold();
    const secondFold = await journal.fold();
    expect(firstFold.records).toHaveLength(1);
    expect(firstFold.records[0]!.status).toBe('unknown');
    expect(secondFold.records[0]!.status).toBe('unknown');
    expect(secondFold.entry_count).toBe(firstFold.entry_count);

    // 半写修复不触发任何重放。
    await expect(attempt(journal, driver, built)).rejects.toMatchObject({
      stage: 'accepted',
      driver_invoked: false,
    });
    expect(driver.calls()).toBe(1);
    await journal.close();
  });
});
