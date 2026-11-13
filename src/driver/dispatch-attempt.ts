/**
 * dispatch-attempt — 阶段 1 的派工写屏障编排（**不接 role-loop、不改生产默认路径**）。
 *
 * 职责与核心逻辑：
 * - 把契约 RD-JRN-03 的硬顺序落成一个函数：
 *   `accepted durable → dispatched durable → 调用 driver → evidence durable → settled durable → 返回结果`。
 * - **accepted 写失败绝不调用 driver**；dispatched 写失败也不调用；
 *   evidence / settled 写失败时抛 {@link DispatchJournalBarrierError}，调用方不得继续派工或成功收尾。
 * - driver 回调抛出的错误按 transport 证据两值归类：`not_executed` → failed（确实没执行），
 *   其余一律 `unknown`（无法确认执行/副作用状态），**不自动重试**。
 * - ADP receipt 若由 execute 回调带回（`adp_receipt`），优先级高于本地对 status 的猜测
 *   （`buildExecutionEvidence` 落实）。
 * - 只读违规（investigate / verify 声明只读却观察到工作区差异）记 violation，
 *   成功状态降为 failed；不自动回滚已经产生的副作用。
 * - 本文件只依赖 {@link DispatchJournalPort} 抽象端口，不 import persistence 运行时实现，
 *   也不决定何时派工——何时派工属于阶段 2 的 role-loop。
 */
import {
  buildExecutionEvidence,
  ExecutionContractViolation,
  hashExecutionEvidence,
  verifyExecutionBrief,
  type BudgetSnapshot,
  type DriverAttemptObservation,
  type DispatchJournalPort,
  type DispatchRecord,
  type EvidenceRef,
  type ExecutionBrief,
  type ExecutionEvidence,
  type ExecutionStatus,
  type JournalViolation,
} from './execution-contract';
import { evidenceOf } from './driver-transport-error';

/** 写屏障失败的阶段；与契约的顺序一一对应。 */
export type DispatchBarrierStage = 'accepted' | 'dispatched' | 'evidence' | 'settled';

export type DispatchBarrierCode =
  | 'accepted_write_failed'
  | 'dispatched_write_failed'
  | 'evidence_write_failed'
  | 'settled_write_failed';

const BARRIER_CODES: Record<DispatchBarrierStage, DispatchBarrierCode> = {
  accepted: 'accepted_write_failed',
  dispatched: 'dispatched_write_failed',
  evidence: 'evidence_write_failed',
  settled: 'settled_write_failed',
};

/**
 * 写屏障失败。
 *
 * `driver_invoked` 与 `side_effect_state` 是给恢复/上报用的**事实声明**：
 * - 屏障在调用 driver 之前失败 → `not_executed`，可以显式重派（新 dispatch_id + retry_of）；
 * - 屏障在调用 driver 之后失败 → `unknown`，禁止自动重放，只能对账/取证。
 */
export class DispatchJournalBarrierError extends Error {
  readonly code: DispatchBarrierCode;

  constructor(
    readonly stage: DispatchBarrierStage,
    readonly dispatch_id: string,
    readonly driver_invoked: boolean,
    readonly side_effect_state: 'not_executed' | 'unknown',
    readonly original_error?: unknown,
  ) {
    super(
      `dispatch journal barrier failed at ${stage} for dispatch ${dispatch_id}; ` +
        `driver_invoked=${driver_invoked}, side_effect_state=${side_effect_state}`,
    );
    this.name = 'DispatchJournalBarrierError';
    this.code = BARRIER_CODES[stage];
  }
}

export interface RunJournaledDispatchInput {
  journal: DispatchJournalPort;
  /** 宿主构造并校验过的完整 brief（身份字段由宿主填写）。 */
  brief: ExecutionBrief;
  /** brief 的 canonical hash；必须与 brief 内容一致。 */
  brief_sha256: string;
  /** accepted 时冻结的预算快照。 */
  budget_before: BudgetSnapshot;
  /** 真正调用 driver 的回调（fake driver 在测试里注入；阶段 2 由 role-loop 提供）。 */
  execute: (context: { dispatch_id: string }) => Promise<DriverAttemptObservation>;
  /** 固定 evidence_id 便于重放/测试；缺省自动生成。 */
  evidence_id?: string;
  /** 时间注入（测试用）。 */
  now?: () => string;
}

export interface DispatchAttemptResult {
  dispatch_id: string;
  status: ExecutionStatus;
  evidence: ExecutionEvidence;
  evidence_ref: EvidenceRef;
  evidence_sha256: string;
  violations: JournalViolation[];
  /** 每次 dispatch 恰好一次明确 attempt（RD-DIS-04）。 */
  attempts: 1;
  /** 已 settled 的折叠记录（来自 journal 端口；供上层对账/投影）。 */
  record?: DispatchRecord;
}

/**
 * 执行一次带写屏障的派工。
 *
 * 成功返回时 `accepted`、`dispatched`、`evidence`、`settled` 均已持久化；
 * 任何阶段失败都抛 {@link DispatchJournalBarrierError}（或契约违例），绝不返回成功结果。
 */
export async function runJournaledDispatch(
  input: RunJournaledDispatchInput,
): Promise<DispatchAttemptResult> {
  const { journal, brief, budget_before } = input;
  const dispatchId = brief.dispatch_id;

  try {
    verifyExecutionBrief(brief, input.brief_sha256);
  } catch (error) {
    if (error instanceof ExecutionContractViolation) throw error;
    throw new ExecutionContractViolation('brief_hash_mismatch', 'brief hash verification failed', error);
  }

  const now = input.now;

  // 1) accepted durable —— 失败绝不调用 driver。
  await atBarrier('accepted', dispatchId, false, 'not_executed', () =>
    journal.appendAccepted({
      brief,
      brief_sha256: input.brief_sha256,
      budget_before,
      ...(now ? { at: now() } : {}),
    }),
  );

  // 2) dispatched durable —— 失败同样不调用 driver。
  await atBarrier('dispatched', dispatchId, false, 'not_executed', () =>
    journal.appendDispatched({
      dispatch_id: dispatchId,
      ...(brief.session.mode === 'reuse' && brief.session.session_id !== undefined
        ? { session_id: brief.session.session_id }
        : {}),
      ...(now ? { at: now() } : {}),
    }),
  );

  // 3) 调用 driver（一次明确 attempt）。回调抛错也转成 observation，按 transport 证据归类。
  let observation: DriverAttemptObservation;
  try {
    observation = await input.execute({ dispatch_id: dispatchId });
  } catch (error) {
    observation = observationFromThrown(error);
  }

  // 只读违规检测：host 只做有限差异观察，不宣称 OS 隔离。
  const { observation: effective, violations } = applyReadOnlyViolations(brief, observation);

  const evidence = buildExecutionEvidence({
    dispatch_id: dispatchId,
    observation: effective,
    ...(input.evidence_id !== undefined ? { evidence_id: input.evidence_id } : {}),
  });

  // 4) evidence durable —— 失败不得继续写 settled，更不得返回成功。
  const evidenceSha256 = hashExecutionEvidence(evidence);
  const artifact = await atBarrier('evidence', dispatchId, true, 'unknown', () =>
    journal.appendEvidence({ dispatch_id: dispatchId, evidence }),
  );
  if (artifact.sha256 !== evidenceSha256) {
    // 侧车字节 hash 与 evidence 内容 hash 必须同源，否则后续 settled/恢复无法对账。
    throw new ExecutionContractViolation(
      'evidence_inconsistent',
      `evidence sidecar hash ${artifact.sha256} does not match evidence content hash ${evidenceSha256}`,
    );
  }

  // 5) settled durable —— 失败同样不得返回成功；恢复折叠为 dispatched→unknown。
  await atBarrier('settled', dispatchId, true, 'unknown', () =>
    journal.appendSettled({
      dispatch_id: dispatchId,
      status: evidence.status,
      evidence,
      evidence_sha256: evidenceSha256,
      violations,
      ...(now ? { at: now() } : {}),
    }),
  );

  return {
    dispatch_id: dispatchId,
    status: evidence.status,
    evidence,
    evidence_ref: artifact.ref,
    evidence_sha256: evidenceSha256,
    violations,
    attempts: 1,
  };
}

async function atBarrier<T>(
  stage: DispatchBarrierStage,
  dispatchId: string,
  driverInvoked: boolean,
  sideEffectState: 'not_executed' | 'unknown',
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new DispatchJournalBarrierError(
      stage,
      dispatchId,
      driverInvoked,
      sideEffectState,
      cause,
    );
  }
}

function observationFromThrown(error: unknown): DriverAttemptObservation {
  const transportEvidence = evidenceOf(error);
  const message = error instanceof Error ? error.message : String(error);
  return {
    transport: { evidence: transportEvidence },
    error: {
      code:
        transportEvidence === 'not_executed'
          ? 'DRIVER_START_FAILED'
          : 'DRIVER_EXECUTION_UNCONFIRMED',
      message: message.slice(0, 4_000),
      retryable: false,
    },
  };
}

function applyReadOnlyViolations(
  brief: ExecutionBrief,
  observation: DriverAttemptObservation,
): { observation: DriverAttemptObservation; violations: JournalViolation[] } {
  if (!brief.read_only) return { observation, violations: [] };

  const violations: JournalViolation[] = [];
  const delta = observation.workspace_delta;
  const changed = delta?.changed_paths ?? [];

  // 覆盖范围不可用 = 无法确认没有副作用，如实记录证据缺口。
  if (delta?.coverage === 'unavailable') violations.push('scope_unconfirmed');
  if (changed.length === 0) return { observation, violations };

  violations.push('read_only_changed');

  // 宿主确认只读派工产生了工作区改动：最终派工状态不得成功。
  // 不改写 observation.result / adp_receipt 的原始事实（ADP 回执仍如实记录 driver 自报成功），
  // 而是通过 status_override 让 evidence/settled/返回状态统一降级；不自动回滚副作用。
  const reportedStatus = observation.result?.status ?? observation.adp_receipt?.status;
  if (reportedStatus !== 'succeeded') return { observation, violations };

  const reportedSource =
    observation.adp_receipt !== undefined
      ? `ADP receipt status=succeeded`
      : `driver result status=succeeded`;
  return {
    observation: {
      ...observation,
      status_override: {
        status: 'failed',
        reason: 'read_only_changed',
        error: {
          code: 'READ_ONLY_VIOLATION',
          message:
            `read-only ${brief.kind} dispatch changed ${changed.length} path(s); ` +
            `${reportedSource} overridden by host evidence (no rollback)`,
          retryable: false,
        },
      },
    },
    violations,
  };
}
