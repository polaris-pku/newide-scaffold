import type {
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
  DriverStreamEventListener,
} from './contract';

export async function runDriverPromptWithSignal(
  driver: DriverRuntimeHandle,
  input: DriverPrompt,
  signal?: AbortSignal,
  onDriverEvent?: DriverStreamEventListener,
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
      return await driver.sendPrompt(input);
    } finally {
      unsubscribe?.();
    }
  }
  let onAbort: (() => void) | undefined;
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
    const result = await Promise.race([driver.sendPrompt(input), aborted]);
    if (signal.aborted) throw abortReason(signal);
    return result;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    unsubscribe?.();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? 'Run cancelled'));
}
