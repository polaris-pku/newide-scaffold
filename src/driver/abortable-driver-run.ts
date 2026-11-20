/**
 * abortable-driver-run — 可中止的驱动执行包装(A1 证据/对账扩展,issue #149)。
 *
 * 职责与核心逻辑:
 * - 在 AbortSignal 触发时经 driver.interrupt 中止执行,并把 AbortError 传给调用方;
 * - hooks.onDispatch:prompt 交给 transport 前回调(ADP 证据模型的 dispatched 时点);
 * - hooks.onLateResult:abort 竞速胜出后,底层 sendPrompt 若仍迟到返回真实结果,
 *   经该回调交还上层对账(不改变已抛出的中止结局)。
 */
import type {
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
  DriverStreamEventListener,
} from './contract';

export interface RunDriverPromptHooks {
  /** prompt 即将交给 transport(执行体真正开始调用驱动)时回调 */
  onDispatch?: () => void;
  /** abort 后迟到的真实结果:交还上层对账入档 */
  onLateResult?: (result: DriverRunResult) => void;
}

export async function runDriverPromptWithSignal(
  driver: DriverRuntimeHandle,
  input: DriverPrompt,
  signal?: AbortSignal,
  onDriverEvent?: DriverStreamEventListener,
  hooks?: RunDriverPromptHooks,
): Promise<DriverRunResult> {
  if (signal?.aborted) {
    const reason = abortReason(signal);
    // 宿主侧超时必须独立收束：interrupt 只是尽力通知，不能等待它返回（它可能永远挂起）。
    requestInterrupt(driver, reason.message, activeKeyOf(input));
    throw reason;
  }

  const unsubscribe = onDriverEvent
    ? driver.subscribeToEvents?.((event) => {
        // 阶段 1：同 Run 并发只读调查共享 driver/transport。事件带 dispatch_id 时按派工隔离；
        // 不带（legacy 订阅方/不标注的 transport）时保持按 run_id 过滤——此时并发隔离取决于
        // transport 是否标注，CommandDriverTransport 已标注。
        if (input.dispatch_id !== undefined && event.dispatch_id !== undefined) {
          if (event.dispatch_id !== input.dispatch_id) return;
        } else if (event.run_id && event.run_id !== input.run_id) {
          return;
        }
        if (event.run_id && event.run_id !== input.run_id) return;
        if (event.task_id && event.task_id !== input.task_id) return;
        onDriverEvent(event);
      })
    : undefined;
  if (!signal) {
    try {
      hooks?.onDispatch?.();
      return await driver.sendPrompt(input);
    } finally {
      unsubscribe?.();
    }
  }
  let onAbort: (() => void) | undefined;
  let pending: Promise<DriverRunResult> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      const reason = abortReason(signal);
      // 同步 reject：不能等 driver.interrupt 返回（复审复现：prompt/interrupt 都不合作时
      // 单派工超时必须仍及时收束）。interrupt 的失败/迟到结算只吞掉，不影响终止。
      requestInterrupt(driver, reason.message, activeKeyOf(input));
      reject(reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    hooks?.onDispatch?.();
    const run = driver.sendPrompt(input);
    pending = run;
    const outcome = await Promise.race([run, aborted]);
    if (signal.aborted) throw abortReason(signal);
    return outcome;
  } catch (error) {
    if (signal.aborted) {
      // abort 竞速胜出:底层 run 之后若返回真实结果,交还上层对账(§4 迟到结果)。
      observeLateResult(pending, hooks?.onLateResult);
    }
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    unsubscribe?.();
  }
}

/** fire-and-forget interrupt：迟到 resolve/reject 都消费掉，绝不阻塞宿主终止。 */
function requestInterrupt(
  driver: DriverRuntimeHandle,
  reason: string,
  runId: string | undefined,
): void {
  try {
    const pending = driver.interrupt(reason, runId);
    void Promise.resolve(pending).catch(() => undefined);
  } catch {
    // 同步抛错同样不影响 abort 收束。
  }
}

function observeLateResult(
  run: Promise<DriverRunResult> | undefined,
  onLateResult?: (result: DriverRunResult) => void,
): void {
  if (!onLateResult || !run) return;
  // 挂尾巴吃掉迟到结局:既交还上层对账,也避免 abort 后的未处理 rejection。
  run.then(
    (result) => onLateResult(result),
    () => undefined,
  );
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? 'Run cancelled'));
}

/** transport 的活动键：派工并发时用 dispatch_id，legacy 调用回退 run_id。 */
function activeKeyOf(input: DriverPrompt): string {
  return input.dispatch_id ?? input.run_id;
}
