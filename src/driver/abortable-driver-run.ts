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
    await driver.interrupt(reason.message, input.run_id);
    throw reason;
  }

  const unsubscribe = onDriverEvent
    ? driver.subscribeToEvents?.((event) => {
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
      void driver.interrupt(reason.message, input.run_id).then(
        () => reject(reason),
        (error: unknown) => reject(error),
      );
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
