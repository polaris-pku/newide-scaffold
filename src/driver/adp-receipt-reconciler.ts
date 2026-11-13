/**
 * adp-receipt-reconciler — 阶段 1：把 ADP receipt / 迟到结果对账进 Dispatch Journal。
 *
 * 职责与核心逻辑：
 * - ADP endpoint 的 receipt（`AdpReceiptDelivery`）目前只是协议帧 + 进程内结局；
 *   本文件把它映射成严格 `ExecutionEvidence` 并**只**追加 `reconciled` journal 行，
 *   供 dispatch 折叠（RD-JRN-04）表达「先 unknown、后收到可信 receipt」的迟到对账。
 * - 证据映射遵守 RD-EVD-05：`transport.evidence`（两值）与 `transport.result_received`
 *   是两个正交字段；receipt 的 status 是权威（经 `adp_receipt` 传入
 *   `buildExecutionEvidence`），本地对 status 的猜测只用于填空，绝不覆盖 receipt。
 *   因此 ADP 收束为 unknown 时 evidence 保持 unknown，不会被 transport 的
 *   `execution_unconfirmed` 改写成 failed；只有 receipt 明确 failed（例如启动失败）
 *   才落到 failed。
 * - 幂等 / 冲突（fail closed，绝不改写已发出的终态）：
 *   - exchange_id 找不到 dispatch（legacy / 非本 journal 调用）或折叠记录不存在 → ignored；
 *   - 已 settled 且状态相同、或已 recorded 同一 reconciled 状态 → duplicate；
 *   - 已 settled 的可信终态与 receipt 不同 → conflict（不改写终态）；
 *   - 同一 dispatch 已 reconciled 为不同可信状态 → conflict；
 *   - 只允许 unknown → 可信状态的升级（例如先 unknown 后 succeeded）。
 * - **绝不调用任何 driver / executor**；`reconcileLateResult` 也只追加 reconciled，
 *   不触发新执行、不产生新 attempt。
 * - journal 写失败必须向上抛：上层写屏障要求 evidence / settled 写失败后不得继续成功
 *   流程，本文件不吞异常、不返回假成功。
 * - `evidence_id` 确定性（`evd_rec_<dispatch_id>_<status>`）：同一 receipt 重放得到同一
 *   evidence hash；追加时复用确定性 `entry_id`，写重试也不会重复落行。
 *
 * 本文件只依赖注入的 `DispatchJournalPort` 抽象端口与 correlation lookup，
 * 不 import persistence 运行时实现，也不改变任何生产默认路径（组合根尚未构造本类）。
 */
import type { AdpReceiptDelivery, AdpLateResultDelivery, AdpSettledOutcome } from './adp-driver-endpoint';
import type { DriverExecutionEvidence } from './driver-transport-error';
import type { DriverRunResult } from './contract';
import {
  buildExecutionEvidence,
  hashExecutionEvidence,
  type DispatchJournalPort,
  type DispatchRecord,
  type DriverAttemptObservation,
  type DriverAttemptResultLike,
  type ExecutionErrorInfo,
  type ExecutionStatus,
} from './execution-contract';

/** reconciled journal 行允许的 status（契约 `DispatchReconciledJournalEntrySchema`）。 */
export type ReconciledStatus = 'succeeded' | 'failed' | 'unknown';

/** 对账结局：写了盘为 reconciled，其余三种都没有写盘。 */
export type ReconcileState = 'reconciled' | 'duplicate' | 'ignored' | 'conflict';

export interface ReconcileResult {
  state: ReconcileState;
  dispatch_id?: string;
  /** 本条 receipt / 迟到结果表达的状态（未关联到 dispatch 时缺省）。 */
  status?: ExecutionStatus;
  reason?: string;
}

/** correlation 只读接口：本文件不拥有 dispatch journal 的读取实现。 */
export type MaybePromise<T> = T | Promise<T>;

export interface AdpDispatchCorrelationLookup {
  /** ADP exchange → 本 Run journal 的 dispatch_id；legacy / 非本 journal 调用返回 undefined。 */
  findDispatchIdByExchange(exchange_id: string): MaybePromise<string | undefined>;
  /** 读取折叠后的 dispatch 记录（phase / status / reconciled / settled 投影）。 */
  getDispatchRecord(dispatch_id: string): MaybePromise<DispatchRecord | undefined>;
}

export interface ReconciledInfo {
  dispatch_id: string;
  exchange_id: string;
  status: ReconciledStatus;
  reason: string;
}

export interface ConflictInfo {
  exchange_id: string;
  reason: string;
  dispatch_id?: string;
  record_status?: string;
  receipt_status?: string;
}

export interface AdpReceiptReconcilerOptions {
  journal: DispatchJournalPort;
  lookup: AdpDispatchCorrelationLookup;
  /** 注入时钟（测试用）；缺省 = 当前 UTC ISO 时间。 */
  now?: () => string;
  onReconciled?: (info: ReconciledInfo) => void;
  onConflict?: (info: ConflictInfo) => void;
}

interface ReconcileCandidate {
  exchange_id: string;
  /** ADP receipt status 或迟到 DriverRunResult status（receipt 优先，见各入口）。 */
  status: ExecutionStatus;
  reason: string;
  buildObservation: () => DriverAttemptObservation;
}

/**
 * ADP receipt / 迟到结果 → Dispatch Journal 的只读对账器。
 *
 * 所有方法都不调用 driver：它们只读 correlation 记录、构造 evidence、追加 reconciled 行。
 */
export class AdpReceiptReconciler {
  private readonly journal: DispatchJournalPort;
  private readonly lookup: AdpDispatchCorrelationLookup;
  private readonly now: () => string;

  constructor(private readonly options: AdpReceiptReconcilerOptions) {
    this.journal = options.journal;
    this.lookup = options.lookup;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * 消费一条 ADP receipt（正常收束、判重重放或重启后的崩溃恢复收束都会走这里）。
   *
   * receipt.status 是权威状态；`delivery.outcome` 只提供 transport 观察与可用结果细节。
   */
  async consumeReceipt(delivery: AdpReceiptDelivery): Promise<ReconcileResult> {
    const outcome = delivery.outcome;
    return this.reconcile({
      exchange_id: delivery.exchange_id,
      status: delivery.receipt.status,
      reason: 'adp receipt reconciled',
      buildObservation: () => receiptObservation(outcome),
    });
  }

  /**
   * 消费一条迟到结果（endpoint `lateResultObserver` 的载荷）。
   *
   * 只把迟到结果记录成 reconciled；不会重执行，也不会改写已发出的回执/终态。
   */
  async reconcileLateResult(delivery: AdpLateResultDelivery): Promise<ReconcileResult> {
    const execution = delivery.execution;
    return this.reconcile({
      exchange_id: delivery.exchange_id,
      status: execution.status,
      reason: 'adp late result reconciled',
      buildObservation: () => lateResultObservation(execution),
    });
  }

  // ── 内部：统一对账决策 + 唯一写盘点 ─────────────────────────

  private async reconcile(input: ReconcileCandidate): Promise<ReconcileResult> {
    const dispatch_id = await this.lookup.findDispatchIdByExchange(input.exchange_id);
    if (dispatch_id === undefined) {
      // legacy / 非本 journal 的调用：绝不写盘、绝不执行。
      return {
        state: 'ignored',
        reason: 'no dispatch journal record for exchange (legacy or foreign exchange)',
      };
    }
    const record = await this.lookup.getDispatchRecord(dispatch_id);
    if (record === undefined) {
      return {
        state: 'ignored',
        dispatch_id,
        reason: 'correlated dispatch record not found in journal',
      };
    }

    const settledResult = this.classify(record, input.exchange_id, input.status);
    if (settledResult !== undefined) return settledResult;

    const journal_status = toReconciledStatus(input.status);
    if (journal_status === undefined) {
      // reconciled 行只允许 succeeded | failed | unknown；cancelled/interrupted 不能伪造。
      return {
        state: 'ignored',
        dispatch_id,
        status: input.status,
        reason: `status ${input.status} is not representable in a reconciled journal entry`,
      };
    }

    const evidence = buildExecutionEvidence({
      dispatch_id,
      evidence_id: `evd_rec_${dispatch_id}_${journal_status}`,
      observation: input.buildObservation(),
    });
    const evidence_sha256 = hashExecutionEvidence(evidence);
    // 写失败向上抛：对账写屏障失败不得被吞掉后返回成功。
    await this.journal.appendReconciled({
      dispatch_id,
      status: journal_status,
      reason: input.reason,
      evidence,
      evidence_sha256,
      entry_id: reconciledEntryId(dispatch_id, journal_status),
      at: this.now(),
    });
    this.options.onReconciled?.({
      dispatch_id,
      exchange_id: input.exchange_id,
      status: journal_status,
      reason: input.reason,
    });
    return { state: 'reconciled', dispatch_id, status: journal_status };
  }

  /**
   * 决定是否写盘：返回 undefined 表示可以追加 reconciled。
   * 顺序很重要：先判幂等（duplicate），再判可信终态冲突（conflict），最后才允许升级。
   */
  private classify(
    record: DispatchRecord,
    exchange_id: string,
    status: ExecutionStatus,
  ): ReconcileResult | undefined {
    const settled = record.phase === 'settled';
    const reconciled = record.reconciled;

    // 1) 幂等：已 settled 为同一状态 / 已 recorded 同一 reconciled 状态 → 不写。
    if (settled && record.status === status) {
      return { state: 'duplicate', dispatch_id: record.dispatch_id, status };
    }
    if (reconciled !== undefined && reconciled.status === status) {
      return { state: 'duplicate', dispatch_id: record.dispatch_id, status };
    }

    // 2) fail closed：已 settled 的可信终态、或已可信的 reconciled 结论，永不改写。
    if (settled && isTrustedStatus(record.status)) {
      return this.conflict(
        record,
        exchange_id,
        status,
        `dispatch is already settled as ${record.status}; refusing to rewrite a trusted terminal status`,
      );
    }
    if (reconciled !== undefined && reconciled.status !== 'unknown') {
      return this.conflict(
        record,
        exchange_id,
        status,
        `dispatch is already reconciled as ${reconciled.status}; refusing to rewrite a trusted reconciliation`,
      );
    }

    // 3) settled 但仍为 unknown：同一 unknown 没有新信息；可信 receipt 允许升级为 reconciled。
    if (settled && status === 'unknown') {
      return { state: 'duplicate', dispatch_id: record.dispatch_id, status };
    }
    return undefined;
  }

  private conflict(
    record: DispatchRecord,
    exchange_id: string,
    status: ExecutionStatus,
    reason: string,
  ): ReconcileResult {
    const record_status = record.phase === 'settled' ? record.status : record.reconciled?.status;
    this.options.onConflict?.({
      exchange_id,
      dispatch_id: record.dispatch_id,
      ...(record_status !== undefined ? { record_status } : {}),
      receipt_status: status,
      reason,
    });
    return { state: 'conflict', dispatch_id: record.dispatch_id, status, reason };
  }
}

// ─────────────────────────────────────────────────────────────
// 证据构造：receipt 优先，本地观察只填空
// ─────────────────────────────────────────────────────────────

/** ADP receipt 收束 → 一次尝试观察（receipt status 权威）。 */
function receiptObservation(outcome: AdpSettledOutcome): DriverAttemptObservation {
  const execution = outcome.execution;
  return {
    transport: { evidence: transportEvidenceOf(outcome) },
    adp_receipt: {
      status: outcome.receipt.status,
      result_received: outcome.evidence.result_received,
      ...(outcome.evidence.result_received_missing === true
        ? { result_received_missing: true }
        : {}),
    },
    ...(execution !== undefined ? { result: attemptResultFrom(execution) } : {}),
    ...(outcome.mapped.error !== null ? { error: errorInfoFrom(outcome.mapped.error) } : {}),
    ...(execution !== undefined ? { duration_ms: execution.diagnostics.duration_ms } : {}),
  };
}

/** 迟到结果 → 一次尝试观察（迟到结果本身就证明交付过，只是传输层当时无法确认）。 */
function lateResultObservation(execution: DriverRunResult): DriverAttemptObservation {
  return {
    transport: { evidence: 'execution_unconfirmed' },
    result: attemptResultFrom(execution),
    ...(execution.error !== undefined ? { error: errorInfoFrom(execution.error) } : {}),
    duration_ms: execution.diagnostics.duration_ms,
  };
}

/**
 * transport 证据沿用 endpoint 的两值观察；缺省按是否已交付推断：
 * 已交付 → execution_unconfirmed，未交付 → not_executed（明确未执行）。
 */
function transportEvidenceOf(outcome: AdpSettledOutcome): DriverExecutionEvidence {
  const observed = outcome.evidence.transport_evidence;
  if (observed !== undefined) return observed;
  return outcome.evidence.dispatched ? 'execution_unconfirmed' : 'not_executed';
}

/** DriverRunResult → `buildExecutionEvidence` 的 result 形状（不臆造 command 级证据）。 */
function attemptResultFrom(execution: DriverRunResult): DriverAttemptResultLike {
  return {
    status: execution.status,
    driver_id: execution.diagnostics.driver_id,
    driver_run_result_id: execution.driver_run_result_id,
    session_id: execution.session_id,
    ...(execution.response !== undefined ? { response: execution.response } : {}),
    ...(execution.usage !== undefined ? { usage: execution.usage } : {}),
    ...(execution.error !== undefined ? { error: errorInfoFrom(execution.error) } : {}),
    duration_ms: execution.diagnostics.duration_ms,
  };
}

/** 外部 driver 的错误码/消息长度不受本仓控制，按 evidence schema 上限截断。 */
function errorInfoFrom(error: {
  code: string;
  message: string;
  retryable: boolean;
}): ExecutionErrorInfo {
  const code = error.code.trim().slice(0, 200);
  return {
    code: code.length > 0 ? code : 'DRIVER_ERROR',
    message: error.message.slice(0, 4_000) || 'driver reported an error without detail',
    retryable: error.retryable,
  };
}

function toReconciledStatus(status: ExecutionStatus): ReconciledStatus | undefined {
  if (status === 'succeeded' || status === 'failed' || status === 'unknown') return status;
  // cancelled / interrupted 不在 reconciled 行的 status 枚举里，不伪造映射。
  return undefined;
}

function isTrustedStatus(status: string): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

function reconciledEntryId(dispatch_id: string, status: ReconciledStatus): string {
  return `rec_${dispatch_id}_${status}`;
}
