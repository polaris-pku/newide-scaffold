/**
 * adp-status-mapping — 驱动结局 → ADP status 的证据化映射(A1 / issue #149)。
 *
 * 职责与核心逻辑(纯函数,便于逐条单测):
 * - 把「启动失败 / 确定失败 / 成功 / 取消 / 结果未知」五类结局映射为 P0 冻结的
 *   ADP status(succeeded | failed | cancelled | unknown);
 * - 判定原则:只有明确证据(见 adp-invocation-state)才能判「未执行」→ failed;
 *   无法确认执行或副作用状态 → unknown;
 * - unknown 永不自动重跑;failed 是否重跑由部署级 auto_retry[side_effect] 决定;
 *   error.retryable 仅作提示,不参与任何判定。
 *
 * 映射表(与 docs/issue149-实施计划.docx §2 同版):
 * | 结局                              | 证据条件                     | status    |
 * |-----------------------------------|------------------------------|-----------|
 * | 启动失败(spawn 失败、dispatch 前) | 明确证据:从未执行           | failed    |
 * | DriverRunResult succeeded         | 确定                         | succeeded |
 * | DriverRunResult failed(业务)     | 确定失败                     | failed    |
 * | DriverRunResult cancelled         | 驱动确认取消生效             | cancelled |
 * | DriverRunResult interrupted       | 无副作用证据/有副作用证据    | cancelled/unknown |
 * | 断连/超时/传输错误(dispatch 后)  | 无法确认执行或副作用状态     | unknown   |
 * | 取消生效(未执行)/ 副作用不明     | 明确未执行 / 证据不足        | cancelled/unknown |
 */
import type { AdpStatus, ProtocolError } from '../core';
import type { DriverRunResult } from './contract';
import type { AdpInvocationEvidence } from './adp-invocation-state';

/** 这些错误码表示「执行结果无法确认」,不得当成确定失败。 */
export const ADP_UNCONFIRMED_ERROR_CODES: ReadonlySet<string> = new Set([
  'DRIVER_OUTCOME_UNKNOWN',
  'EXTERNAL_DRIVER_TRANSPORT_ERROR',
  'DRIVER_RUNTIME_INVOKER_ERROR',
]);

export type AdpOutcomeKind = 'result' | 'thrown';

export interface AdpMappingInput {
  /** 有 DriverRunResult 用 result;执行体抛错用 thrown */
  kind: AdpOutcomeKind;
  evidence: Readonly<AdpInvocationEvidence>;
  execution?: DriverRunResult;
  error?: unknown;
}

export interface AdpMappedOutcome {
  status: AdpStatus;
  /** succeeded 恒 null;failed 必填;cancelled 为 null;unknown 携带原始错误信息 */
  error: ProtocolError | null;
  summary: string;
  /** 证据/判定依据,写入诊断与 journal 摘要,便于对账 */
  notes: string[];
}

export function mapAdpOutcome(input: AdpMappingInput): AdpMappedOutcome {
  const notExecuted = hasNotExecutedEvidence(input.evidence);
  const notes = evidenceNotes(input.evidence);

  if (input.kind === 'result' && input.execution) {
    return mapResult(input.execution, input.evidence, notExecuted, notes);
  }
  return mapThrown(input.error, input.evidence, notExecuted, notes);
}

function hasNotExecutedEvidence(evidence: Readonly<AdpInvocationEvidence>): boolean {
  return !evidence.dispatched || evidence.transport_evidence === 'not_executed';
}

function mapResult(
  execution: DriverRunResult,
  evidence: Readonly<AdpInvocationEvidence>,
  notExecuted: boolean,
  notes: string[],
): AdpMappedOutcome {
  switch (execution.status) {
    case 'succeeded':
      return {
        status: 'succeeded',
        error: null,
        summary: execution.response ? firstLine(execution.response) : 'driver invocation succeeded',
        notes,
      };
    case 'cancelled':
      // 驱动给出的取消确认 = 「取消生效」的确定结局,不再查副作用证据。
      return {
        status: 'cancelled',
        error: null,
        summary: execution.error?.message ?? 'driver invocation cancelled',
        notes: [...notes, 'driver confirmed cancellation'],
      };
    case 'interrupted': {
      // 既有 interrupted 状态:能证明未完成且无副作用活动 → cancelled;
      // 已观察到副作用活动则副作用状态不明 → unknown(决策 #1)。
      if (evidence.effects_observed) {
        return {
          status: 'unknown',
          error: unknownError(
            'driver run interrupted with side effects observed; outcome cannot be confirmed',
          ),
          summary: 'outcome unknown: interrupted mid-flight with observed side effects',
          notes: [...notes, 'interrupted with observed side effects → unknown'],
        };
      }
      return {
        status: 'cancelled',
        error: null,
        summary: execution.error?.message ?? 'driver run interrupted before any side effect',
        notes: [...notes, 'interrupted without observed side effects → cancelled'],
      };
    }
    case 'failed': {
      const code = execution.error?.code ?? 'DRIVER_FAILED';
      if (code === 'DRIVER_START_FAILED') {
        return startFailure(execution.error?.message ?? 'driver failed to start', notes);
      }
      if (ADP_UNCONFIRMED_ERROR_CODES.has(code) && !notExecuted) {
        return {
          status: 'unknown',
          error: unknownError(execution.error?.message ?? `driver outcome unconfirmed (${code})`),
          summary: `outcome unknown: ${execution.error?.message ?? code}`,
          notes: [...notes, `unconfirmed transport outcome (${code}) → unknown`],
        };
      }
      return {
        status: 'failed',
        error: {
          code,
          message: execution.error?.message ?? 'driver invocation failed',
          // retryable 仅提示;真重试看部署级 auto_retry[side_effect]。
          retryable: execution.error?.retryable ?? false,
        },
        summary: execution.error?.message ?? 'driver invocation failed',
        notes,
      };
    }
    default: {
      const exhaustive: never = execution.status;
      throw new Error(`unreachable driver status: ${String(exhaustive)}`);
    }
  }
}

function mapThrown(
  error: unknown,
  evidence: Readonly<AdpInvocationEvidence>,
  notExecuted: boolean,
  notes: string[],
): AdpMappedOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (notExecuted) {
    if (evidence.cancel_requested) {
      // 取消在执行前生效:明确未执行 → cancelled。
      return {
        status: 'cancelled',
        error: null,
        summary: 'cancelled before dispatch; driver never executed',
        notes: [...notes, 'cancelled before dispatch → cancelled'],
      };
    }
    return startFailure(message, notes);
  }
  if (evidence.cancel_requested) {
    if (evidence.effects_observed) {
      // 取消时点在 dispatch 后且副作用状态不明 → unknown(计划 §4)。
      return {
        status: 'unknown',
        error: unknownError(`cancelled mid-flight with unclear side effects: ${message}`),
        summary: 'outcome unknown: cancelled after side effects were observed',
        notes: [...notes, 'cancel after dispatch with observed effects → unknown'],
      };
    }
    return {
      status: 'cancelled',
      error: null,
      summary: 'cancelled after dispatch without observed side effects',
      notes: [...notes, 'cancel after dispatch without observed effects → cancelled'],
    };
  }
  // dispatch 之后的断连/超时/异常:无法确认执行或副作用状态 → unknown。
  return {
    status: 'unknown',
    error: unknownError(message || 'driver outcome could not be confirmed'),
    summary: `outcome unknown: ${message || 'driver outcome could not be confirmed'}`,
    notes: [...notes, 'post-dispatch failure without confirmation → unknown'],
  };
}

function startFailure(message: string, notes: string[]): AdpMappedOutcome {
  return {
    status: 'failed',
    error: {
      code: 'DRIVER_START_FAILED',
      message: message || 'driver failed to start',
      // 提示:启动失败确定未执行,可安全重跑;真重跑仍看 auto_retry[side_effect]。
      retryable: true,
    },
    summary: `driver failed to start: ${message || 'no detail'}`,
    notes: [...notes, 'clear evidence of non-execution → failed (start failure)'],
  };
}

function unknownError(message: string): ProtocolError {
  return { code: 'DRIVER_OUTCOME_UNKNOWN', message, retryable: false };
}

function evidenceNotes(evidence: Readonly<AdpInvocationEvidence>): string[] {
  const notes = [`dispatched=${String(evidence.dispatched)}`];
  if (evidence.transport_evidence) notes.push(`transport_evidence=${evidence.transport_evidence}`);
  if (evidence.effects_observed) notes.push('effects_observed=true');
  if (evidence.cancel_requested) notes.push('cancel_requested=true');
  return notes;
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
