/**
 * role-deadline — role 自主循环与 driver 派工共用的**绝对 deadline 定时器原语**。
 *
 * 职责与核心逻辑：
 * - Node 的 `setTimeout` 超过 2^31-1 ms 会被截成 1ms；冻结的 wall-clock deadline 可以很长
 *   （默认 45 分钟，恢复 Run 继承的剩余时间也可能超过上限），因此必须按上限分段续挂，
 *   保证不提前触发、也不永不触发。
 * - 只负责「到点 abort 一个 AbortController」，不解释超时原因：loop 用它守卫 LLM/工具等待，
 *   engine 用它区分单 dispatch 超时与总墙钟（通过 `reason` 注入不同错误），Driver 迟到结果的
 *   竞速与归属仍由 `abortable-driver-run` / engine 的迟到回执逻辑单独处理。
 * - 返回 disarm 函数；调用方在 `finally` 中释放，避免野定时器拖住进程（定时器已 unref）。
 */

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 在 `remainingMs` 后 abort `controller`；超过 Node 定时器上限时分段续挂。
 * `reason` 缺省时 abort 不携带 reason（loop 用信号来源判断取消/墙钟）。
 */
export function armAbortDeadline(
  controller: AbortController,
  remainingMs: number,
  reason?: () => unknown,
): () => void {
  let remaining = Math.max(1, Math.floor(remainingMs));
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    const wait = Math.min(remaining, MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      remaining -= wait;
      if (remaining > 0) {
        arm();
        return;
      }
      if (reason === undefined) {
        controller.abort();
        return;
      }
      controller.abort(reason());
    }, wait);
    timer.unref?.();
  };
  arm();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
  };
}
