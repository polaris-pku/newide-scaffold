import { describe, expect, it, vi } from 'vitest';
import { runDriverPromptWithSignal } from '../../src/driver/abortable-driver-run';
import { MockDriver } from '../../src/driver/mock-driver';
import { ExternalDriverRuntime } from '../../src/driver/external-driver-runtime';
import type { DriverPrompt, DriverRunResult } from '../../src/driver/contract';

const PROMPT: DriverPrompt = {
  task_id: 'task_cancel',
  run_id: 'run_cancel',
  prompt: 'Cancel this driver',
  created_at: '2026-07-11T08:00:00.000Z',
  schema_version: 'v0',
};

describe('runDriverPromptWithSignal', () => {
  it('interrupts an in-flight driver and rejects with the abort reason', async () => {
    const controller = new AbortController();
    const interrupt = vi.fn(async () => undefined);
    const driver = new ExternalDriverRuntime({
      driver_id: 'external-driver',
      transport: {
        invoke: () => new Promise<DriverRunResult>(() => undefined),
        interrupt,
      },
    });

    const running = runDriverPromptWithSignal(driver, PROMPT, controller.signal);
    controller.abort(new Error('User cancelled the run'));

    await expect(running).rejects.toThrow('User cancelled the run');
    expect(interrupt).toHaveBeenCalledWith('User cancelled the run', 'run_cancel');
  });

  it('does not interrupt a normally completed driver', async () => {
    const controller = new AbortController();
    const driver = new MockDriver();
    const interrupt = vi.spyOn(driver, 'interrupt');

    await expect(
      runDriverPromptWithSignal(driver, PROMPT, controller.signal),
    ).resolves.toMatchObject({ status: 'succeeded' });
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('preserves cancellation when the external runtime converts transport shutdown to failure', async () => {
    const controller = new AbortController();
    let rejectInvoke!: (error: Error) => void;
    const driver = new ExternalDriverRuntime({
      driver_id: 'external-driver',
      transport: {
        invoke: () =>
          new Promise<DriverRunResult>((_resolve, reject) => {
            rejectInvoke = reject;
          }),
        interrupt: async () => rejectInvoke(new Error('child exited with SIGTERM')),
      },
    });

    const running = runDriverPromptWithSignal(driver, PROMPT, controller.signal);
    controller.abort(new DOMException('cancelled by user', 'AbortError'));

    await expect(running).rejects.toMatchObject({
      name: 'AbortError',
      message: 'cancelled by user',
    });
  });
});
