import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION } from '../core';
import { CommandDriverTransport } from './command-driver-transport';
import type { DriverPrompt } from './contract';

const DRIVER_EVENT_PREFIX = 'NEWIDE_DRIVER_EVENT ';

const PROMPT: DriverPrompt = {
  task_id: 'task_command_stream',
  run_id: 'run_command_stream',
  prompt: 'Run the stream-capable external driver.',
  created_at: '2026-07-20T00:00:00.000Z',
  schema_version: SCHEMA_VERSION,
};

describe('CommandDriverTransport ACP event bridge', () => {
  it('parses a fragmented event side-channel and keeps event lines out of lastStderr', async () => {
    const events: unknown[] = [];
    const event = {
      schema_version: 'driver-event.v1',
      event_type: 'agent_message_chunk',
      task_id: PROMPT.task_id,
      run_id: PROMPT.run_id,
      sequence: 1,
      created_at: '2026-07-20T00:00:00.100Z',
      payload: {
        update: {
          content: { type: 'text', text: 'streamed before the final result' },
        },
      },
    };
    const eventLine = `${DRIVER_EVENT_PREFIX}${JSON.stringify(event)}\n`;
    const transport = new CommandDriverTransport({
      ...nodeCommand(`
        readInput((raw) => {
          const line = ${JSON.stringify(eventLine)};
          process.stderr.write(line.slice(0, 11));
          setTimeout(() => {
            process.stderr.write(line.slice(11));
            process.stdout.write(JSON.stringify(driverRunResult(JSON.parse(raw).task_id)));
          }, 10);
        });
      `),
      onEvent: (value: unknown) => events.push(value),
    });

    const result = await transport.run(PROMPT);

    expect(result.status).toBe('succeeded');
    expect(events).toEqual([event]);
    expect(transport.lastStderr).toBe('');
  });

  it('does not classify an explicit interrupt as a timeout while the child drains', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'newide-driver-interrupt-'));
    const readyPath = path.join(root, 'ready');
    const transport = new CommandDriverTransport({
      ...nodeCommand(`
        const { writeFileSync } = require('node:fs');
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(143), 1_000);
        });
        readInput(() => {
          writeFileSync(process.env.NEWIDE_TEST_READY, 'ready');
          setInterval(() => {}, 60000);
        });
      `),
      env: { NEWIDE_TEST_READY: readyPath },
      timeoutMs: 300,
    });
    const running = transport.run(PROMPT);
    const activeChildren = () =>
      (transport as unknown as { activeChildren: Map<string, unknown> }).activeChildren;

    try {
      await vi.waitFor(() => expect(existsSync(readyPath)).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await transport.interrupt('user cancelled the ACP turn', PROMPT.run_id);

      await expect(running).rejects.not.toThrow(/timed out/i);
      expect(activeChildren().has(PROMPT.run_id)).toBe(false);
    } finally {
      await transport.shutdown();
      rmSync(root, { recursive: true, force: true });
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
          const createdAt = '2026-07-20T00:00:01.000Z';
          return {
            driver_run_result_id: 'driver_result_' + taskId,
            session_id: 'external-session',
            status: 'succeeded',
            artifacts: [],
            transcript_ref: {
              artifact_id: 'artifact_transcript',
              type: 'transcript',
              uri: 'artifact://transcript/' + taskId,
              producer_id: 'external-acp-driver',
              task_id: taskId,
              created_at: createdAt,
              schema_version: '${SCHEMA_VERSION}',
            },
            tool_events: [],
            diagnostics: {
              driver_id: 'external-acp-driver',
              duration_ms: 12,
              notes: [],
            },
            created_at: createdAt,
            schema_version: '${SCHEMA_VERSION}',
          };
        }

        ${body}
      `,
    ],
  };
}
