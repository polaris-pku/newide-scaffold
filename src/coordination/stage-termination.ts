/**
 * stage-termination — 阶段 2 的 typed termination（RD-TRM-01/02）。
 *
 * 职责与核心逻辑：
 * - 定义「终止一个阶段执行」的**结构化原因**：稳定原因码 `code` + `actor`
 *   （role / host / user / driver / system）+ 可选 `message` / `details`。
 *   原因码必须能一路透传到 `task.error.code` 与 `run.failed` 事件载荷；不允许把原因
 *   只写进 message 或普通 Error——那正是阶段 1 之前 role_blocked 与 role_failed
 *   无法区分的原因（契约 RD-TRM-02）。
 * - `StageTerminationError` 是该原因的载体；`task-execution-loop.stageFailure` 只按
 *   **instance**（`isStageTerminationError`）识别它，不做 message 字符串解析，避免把
 *   普通错误的文案误判成原因码。
 * - 终态仍由既有 C 层提交路径写：`stageFailure` 只负责把原因码交给
 *   `TaskProcessor.failStage({ error })`，Task/Run 状态、取消/中断语义都不在本文件改变。
 * - 本文件**不得**依赖 app / driver / persistence：app 层的 role-loop 与 stage executor
 *   从这里导入并抛出（组合根注入），coordination 因此不需要反向 import app。
 */

/** 终止的决策方：role 自述、宿主预算/异常、用户取消/中断、driver 结果、系统兜底。 */
export type StageTerminationActor = 'role' | 'host' | 'user' | 'driver' | 'system';

export interface StageTermination {
  /** 稳定原因码，例如 `role_blocked` / `role_failed` / `budget_rounds` / `host_failed`。 */
  code: string;
  actor: StageTerminationActor;
  /** 人读说明；缺省时 `stageFailure` 回退到 error.message（再缺省即 code）。 */
  message?: string;
  /** 结构化补充（预算快照、round、dispatch_id 等），会并入 `task.error.details`。 */
  details?: Record<string, unknown>;
}

/**
 * 阶段执行器 / role-loop 抛出的 typed termination。
 *
 * `stageFailure` 用 `instanceof` 识别它并原样透传 reason code；`cause` 保留底层失败
 * （例如 Journal 写失败），供日志与上层排障使用。
 */
export class StageTerminationError extends Error {
  readonly termination: StageTermination;

  constructor(termination: StageTermination, cause?: unknown) {
    super(termination.message ?? termination.code, cause === undefined ? undefined : { cause });
    this.name = 'StageTerminationError';
    this.termination = termination;
  }
}

/** 只依赖 instance，不做字符串解析（见文件头 RD-TRM-02 的约束）。 */
export function isStageTerminationError(value: unknown): value is StageTerminationError {
  return value instanceof StageTerminationError;
}
