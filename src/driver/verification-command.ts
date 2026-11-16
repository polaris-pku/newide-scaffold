/**
 * Local command adapter for an explicit verify dispatch. Runs argv without an implicit shell,
 * bounds captured output, and kills the child on the dispatch abort signal. The app records the
 * observed exit/output in the existing Journal evidence; no LLM result is promoted to a check.
 */
import { spawn } from 'node:child_process';
import type { z } from 'zod';
import type { VerificationCommandSchema } from './execution-contract';
import { DriverTransportError } from './driver-transport-error';

const OUTPUT_LIMIT = 64_000;

export async function runVerificationCommand(input: {
  command: z.infer<typeof VerificationCommandSchema>;
  workspace: string;
  signal: AbortSignal;
}): Promise<{ exit_code: number; stdout: string; stderr: string; truncated: boolean }> {
  input.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      input.command.executable === 'node' ? process.execPath : input.command.executable,
      input.command.args,
      {
        cwd: input.workspace,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (previous: string, chunk: string): string => {
      if (previous.length + chunk.length > OUTPUT_LIMIT) truncated = true;
      return (previous + chunk).slice(0, OUTPUT_LIMIT);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    const abort = (): void => {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // The process may have already exited. Abort still wins over its late result.
      }
      reject(input.signal.reason);
    };
    input.signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      input.signal.removeEventListener('abort', abort);
      reject(
        new DriverTransportError(
          `verification command failed to start: ${error.message}`,
          'not_executed',
        ),
      );
    });
    child.once('close', (code) => {
      input.signal.removeEventListener('abort', abort);
      if (input.signal.aborted) return;
      if (code === null) {
        reject(
          new DriverTransportError(
            'verification command terminated without an exit code',
            'execution_unconfirmed',
          ),
        );
      } else {
        resolve({ exit_code: code, stdout, stderr, truncated });
      }
    });
    if (input.signal.aborted) abort();
  });
}
