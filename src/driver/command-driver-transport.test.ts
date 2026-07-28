import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../core';
import { CommandDriverTransport } from './command-driver-transport';
import type { DriverPrompt } from './contract';

const PROMPT: DriverPrompt = {
  task_id: 'task_command',
  run_id: 'run_command',
  prompt: 'Run the command-backed external driver.',
  created_at: '2026-07-03T00:00:00.000Z',
  schema_version: SCHEMA_VERSION,
};

describe('CommandDriverTransport', () => {
  it('sends DriverPrompt through stdin and returns DriverRunResult from stdout JSON', async () => {
    const transport = new CommandDriverTransport(
      nodeCommand(`
        readInput((raw) => {
          const prompt = JSON.parse(raw);
          process.stderr.write('runner diagnostic only');
          process.stdout.write('authentication completed\\n');
          process.stdout.write(JSON.stringify(driverRunResult(prompt.task_id)));
        });
      `),
    );

    const result = await transport.run(PROMPT);

    expect(result.driver_run_result_id).toBe('driver_result_task_command');
    expect(result.session_id).toBe('external-session');
    expect(result.diagnostics.driver_id).toBe('external-acp-driver');
    expect(transport.lastStderr).toBe('runner diagnostic only');
  });

  it('throws a clear error when stdout is not JSON', async () => {
    const transport = new CommandDriverTransport(
      nodeCommand(`
        readInput(() => {
          process.stdout.write('{not-json');
        });
      `),
    );

    await expect(transport.run(PROMPT)).rejects.toThrow('Command driver stdout was not valid JSON');
  });

  it('times out and kills child processes that keep stdio open', async () => {
    const transport = new CommandDriverTransport({
      ...nodeCommand(`
        const { spawn } = require('node:child_process');
        readInput(() => {
          spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
            stdio: ['ignore', process.stdout, process.stderr],
          });
          setTimeout(() => {}, 60000);
        });
      `),
      timeoutMs: 50,
    });

    await expect(transport.run(PROMPT)).rejects.toThrow(/Command driver timed out after 50ms/);
  });

  it('interrupts only the command child owned by the requested run', async () => {
    const transport = new CommandDriverTransport(
      nodeCommand(`
        readInput(() => {
          setInterval(() => {}, 60000);
        });
      `),
    );
    const first = transport.run({ ...PROMPT, run_id: 'run_cancel_first' });
    const second = transport.run({ ...PROMPT, run_id: 'run_cancel_second' });
    const activeChildren = () =>
      (transport as unknown as { activeChildren: Map<string, unknown> }).activeChildren;
    await vi.waitFor(() => expect(activeChildren().size).toBe(2));

    await transport.interrupt('cancel first', 'run_cancel_first');

    await expect(first).rejects.toThrow(/exited with signal/);
    expect(activeChildren().has('run_cancel_first')).toBe(false);
    expect(activeChildren().has('run_cancel_second')).toBe(true);

    await transport.interrupt('test cleanup', 'run_cancel_second');
    await expect(second).rejects.toThrow(/exited with signal/);
    expect(activeChildren().size).toBe(0);
  });

  it('throws a clear error with stderr context when the command exits non-zero', async () => {
    const transport = new CommandDriverTransport(
      nodeCommand(`
        readInput(() => {
          process.stderr.write('external runner exploded');
          process.exit(17);
        });
      `),
    );

    await expect(transport.run(PROMPT)).rejects.toThrow(
      /Command driver failed: .* exited with code 17\. stderr: external runner exploded/,
    );
  });

  it('returns structured DriverRunResult stdout when the command exits non-zero', async () => {
    const transport = new CommandDriverTransport(
      nodeCommand(`
        readInput((raw) => {
          const prompt = JSON.parse(raw);
          process.stderr.write('external runner returned structured failure');
          const result = driverRunResult(prompt.task_id);
          result.status = 'failed';
          result.error = {
            code: 'DRIVER_RUNNER_ERROR',
            message: 'ACP socket closed unexpectedly',
            retryable: true,
          };
          process.stdout.write('authentication completed\\n');
          process.stdout.write(JSON.stringify(result));
          process.exit(1);
        });
      `),
    );

    const result = await transport.run(PROMPT);

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('DRIVER_RUNNER_ERROR');
    expect(transport.lastStderr).toBe('external runner returned structured failure');
  });

  it('throws a clear error when stdout JSON is not a DriverRunResult', async () => {
    const transport = new CommandDriverTransport(
      nodeCommand(`
        readInput(() => {
          process.stdout.write(JSON.stringify({ status: 'succeeded' }));
        });
      `),
    );

    await expect(transport.run(PROMPT)).rejects.toThrow(
      'Command driver returned malformed DriverRunResult: session_id is required',
    );
  });

  it('can remove inherited environment variables from the child process', async () => {
    const key = 'BCD_COMMAND_DRIVER_REMOVE_ME';
    process.env[key] = 'poison';

    try {
      const transport = new CommandDriverTransport({
        ...nodeCommand(`
          readInput((raw) => {
            if (process.env.BCD_COMMAND_DRIVER_REMOVE_ME) {
              process.stderr.write('inherited env leaked');
              process.exit(13);
            }

            const prompt = JSON.parse(raw);
            process.stdout.write(JSON.stringify(driverRunResult(prompt.task_id)));
          });
        `),
        unsetEnv: [key],
      });

      const result = await transport.run(PROMPT);

      expect(result.status).toBe('succeeded');
    } finally {
      delete process.env[key];
    }
  });
});

function nodeCommand(body: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      '-e',
      `
        function readInput(callback) {
          let input = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (chunk) => {
            input += chunk;
          });
          process.stdin.on('end', () => callback(input));
        }

        function driverRunResult(taskId) {
          const createdAt = '2026-07-03T00:00:01.000Z';
          return {
            driver_run_result_id: 'driver_result_' + taskId,
            session_id: 'external-session',
            status: 'succeeded',
            artifacts: [
              artifactRef({
                artifact_id: 'artifact_driver_result',
                type: 'driver_result',
                uri: 'artifact://driver_result/' + taskId + '/driver_result.json',
                task_id: taskId,
                created_at: createdAt,
              }),
            ],
            transcript_ref: artifactRef({
              artifact_id: 'artifact_transcript',
              type: 'transcript',
              uri: 'artifact://transcript/' + taskId + '/external-session',
              task_id: taskId,
              created_at: createdAt,
            }),
            tool_events: [],
            diagnostics: {
              driver_id: 'external-acp-driver',
              duration_ms: 12,
              notes: ['Command driver contract returned a structured result.'],
            },
            created_at: createdAt,
            schema_version: '${SCHEMA_VERSION}',
          };
        }

        function artifactRef(input) {
          return {
            artifact_id: input.artifact_id,
            type: input.type,
            uri: input.uri,
            producer_id: 'external-acp-driver',
            task_id: input.task_id,
            created_at: input.created_at,
            schema_version: '${SCHEMA_VERSION}',
          };
        }

        ${body}
      `,
    ],
  };
}
