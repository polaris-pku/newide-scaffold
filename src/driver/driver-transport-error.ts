/**
 * DriverTransportError — 传输层失败的阶段证据载体(A1 / issue #149)。
 *
 * 职责与核心逻辑:把 CommandDriverTransport(及其他 ExternalDriverTransport)
 * 的失败按「是否有明确证据证明驱动未执行」分成两类,供 ADP 状态映射
 * (adp-status-mapping)把结局判成 failed / unknown:
 *
 * - not_executed        进程从未启动或从未接触 prompt(spawn 失败、同一 run
 *                       已在执行被拒),副作用确定未发生 → 映射 failed(启动失败)。
 * - execution_unconfirmed  prompt 已交付后断连 / 超时 / 异常退出 / stdin 写失败,
 *                       无法确认执行或副作用状态 → 映射 unknown,永不自动重跑。
 *
 * 判定原则(issue #149 DoD):只有明确证据才能判断未执行,无法确认执行或
 * 副作用状态时一律用 unknown。未类型化的传输错误一律按 execution_unconfirmed
 * 保守处理,不得当作可直接重跑的普通失败。
 */

export type DriverExecutionEvidence = 'not_executed' | 'execution_unconfirmed';

export class DriverTransportError extends Error {
  readonly evidence: DriverExecutionEvidence;

  constructor(message: string, evidence: DriverExecutionEvidence) {
    super(message);
    this.name = 'DriverTransportError';
    this.evidence = evidence;
  }
}

export function isDriverTransportError(error: unknown): error is DriverTransportError {
  return error instanceof DriverTransportError;
}

/** 未类型化错误的保守归类:无法确认执行状态。 */
export function evidenceOf(error: unknown): DriverExecutionEvidence {
  return isDriverTransportError(error) ? error.evidence : 'execution_unconfirmed';
}
