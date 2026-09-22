import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../core';
import {
  RunLatencyRecorder,
  runWithRunLatencyRecorder,
  type RunLatencySpan,
  type RunLatencyTraceSink,
} from '../telemetry';
import { CommandDriverTransport, DRIVER_EVENT_PREFIX } from './command-driver-transport';
import type { DriverPrompt } from './contract';

const PROMPT: DriverPrompt = {
  task_id: 'task_command',
  run_id: 'run_command',
  prompt: 'Run the command-backed external driver.',
  created_at: '2026-07-03T00:00:00.000Z',
  schema_version: SCHEMA_VERSION,
};

/**
 * 被终止的直接子进程如何收场，两个平台不同：POSIX 下它死于信号，Windows 下 Node
 * 的 kill 走 TerminateProcess，子进程以退出码结束、signal 为空。断言写死其中一个
 * 就等于让这个测试只在一个平台上可能通过。
 */
const TERMINATED = process.platform === 'win32' ? /exited with code 1/ : /exited with signal/;

class CollectingLatencySink implements RunLatencyTraceSink {
  readonly spans: RunLatencySpan[] = [];

  append(span: RunLatencySpan): void {
    this.spans.push(span);
  }
}

function createLatencyRecorder(
  sink: RunLatencyTraceSink,
  runId = 'run_driver_spans'
): RunLatencyRecorder {
  return new RunLatencyRecorder({ run_id: runId, task_id: 'task_driver_spans', sink });
}

/** 一段子进程脚本：按给定顺序把 driver 事件写到 stderr 的保留审计通道上。 */
function driverEventsBody(events: string): string {
  return `
    readInput((raw) => {
      const PREFIX = ${JSON.stringify(DRIVER_EVENT_PREFIX)};
      let sequence = 0;
      const emit = (eventType, payload) => {
        process.stderr.write(PREFIX + JSON.stringify({
          schema_version: 'driver-event.v1',
          event_type: eventType,
          payload,
          task_id: 'task_command',
          run_id: 'run_command',
          sequence: ++sequence,
          created_at: new Date().toISOString(),
        }) + '\\n');
      };
      ${events}
      process.stdout.write(JSON.stringify(driverRunResult(JSON.parse(raw).task_id)));
    });
  `;
}

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

  it('kills a Driver only after it stops producing output', async () => {
    const transport = new CommandDriverTransport({
      ...nodeCommand(`
        readInput(() => {
          setTimeout(() => {}, 60000);
        });
      `),
      inactivityTimeoutMs: 50,
    });

    await expect(transport.run(PROMPT)).rejects.toThrow(/produced no output for 50ms/);
  });

  // 这条验证的是 POSIX 的进程组回收。Windows 上机制不同——libuv 用 Job Object 回收
  // 非 detached 的子进程，有修复和没修复孙进程都会死，在这里断言不出任何东西；反而
  // 因为多起两个进程，把同文件里几条时序敏感的用例推过了阈值。所以只在 POSIX 跑。
  it.skipIf(process.platform === 'win32')(
    'reclaims the grandchild process when a run is interrupted',
    async () => {
      // 进程链与真实情况一致：newide → runner（直接子进程）→ ACP agent（孙进程）。
      // 孙进程刻意不读 stdin，因此永远不会靠 EOF 自行退出——存活与否只取决于
      // 我们有没有真正杀掉整棵进程树，而不是取决于对端是否自觉。
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'driver-tree-'));
      const pidFile = path.join(dir, 'grandchild.pid');

      try {
        const transport = new CommandDriverTransport({
          ...nodeCommand(`
            const { spawn } = require('node:child_process');
            const { writeFileSync } = require('node:fs');
            readInput(() => {
              const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
                stdio: 'ignore',
              });
              writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
              setInterval(() => {}, 1000);
            });
          `),
          // 足够长，确保是 interrupt 而不是超时路径终止的它。
          inactivityTimeoutMs: 30_000,
        });

        const pending = transport.run(PROMPT).catch(() => undefined);
        const grandchildPid = await readPid(pidFile);
        expect(isAlive(grandchildPid)).toBe(true);

        await transport.interrupt('test teardown');
        await pending;

        await waitFor(() => !isAlive(grandchildPid));
        expect(isAlive(grandchildPid)).toBe(false);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  );

  it('records the driver phase spans of a run inside a latency recorder', async () => {
    const sink = new CollectingLatencySink();
    const transport = new CommandDriverTransport(
      nodeCommand(
        driverEventsBody(`
          emit('driver.phase', { phase: 'initialize', boundary: 'started' });
          emit('driver.phase', { phase: 'initialize', boundary: 'completed', ok: true });
          emit('driver.phase', { phase: 'session', boundary: 'started', mode: 'create' });
          emit('driver.phase', { phase: 'session', boundary: 'completed', ok: true });
          emit('driver.turn_started', { prompt_length: 1 });
          emit('driver.turn_completed', { stop_reason: 'done' });
        `)
      ),
    );

    await runWithRunLatencyRecorder(createLatencyRecorder(sink), () => transport.run(PROMPT));

    const names = sink.spans.map((span) => span.name);
    // 这一组同时是 ALS 上下文的证据：recordRunLatencySpan 取不到 store 时是静默
    // no-op，而流回调未必继承 run 的上下文——真取不到的话这里一条都不会出现。
    for (const expected of [
      'driver.invoke',
      'driver.handshake',
      'driver.turn',
      'driver.shutdown',
      'driver.phase.initialize',
      'driver.phase.session',
    ]) {
      expect(names).toContain(expected);
    }

    expect(sink.spans.find((span) => span.name === 'driver.phase.session')?.meta).toMatchObject({
      mode: 'create',
    });
    expect(sink.spans.every((span) => span.run_id === 'run_driver_spans')).toBe(true);
    expect(sink.spans.every((span) => span.layer === 'driver')).toBe(true);
    expect(sink.spans.every((span) => span.ok)).toBe(true);
  });

  it('attributes concurrent driver spans to the run that invoked them', async () => {
    // 并发是真实存在的：Council 的两个 proposer 就是 Promise.all 一起跑的。
    // 每条流回调如果各自去查当前上下文，就可能把 span 记到「这条流所属」的那个 run
    // 上，而不是「发起这次调用」的那个 run。
    const events = `
      emit('driver.turn_started', { prompt_length: 1 });
      emit('driver.turn_completed', { stop_reason: 'done' });
    `;
    const sinkA = new CollectingLatencySink();
    const sinkB = new CollectingLatencySink();

    await Promise.all([
      runWithRunLatencyRecorder(createLatencyRecorder(sinkA, 'run_a'), () =>
        new CommandDriverTransport(nodeCommand(driverEventsBody(events))).run(PROMPT)
      ),
      runWithRunLatencyRecorder(createLatencyRecorder(sinkB, 'run_b'), () =>
        new CommandDriverTransport(nodeCommand(driverEventsBody(events))).run(PROMPT)
      ),
    ]);

    expect(sinkA.spans.length).toBeGreaterThan(0);
    expect(sinkB.spans.length).toBeGreaterThan(0);
    expect(sinkA.spans.every((span) => span.run_id === 'run_a')).toBe(true);
    expect(sinkB.spans.every((span) => span.run_id === 'run_b')).toBe(true);
  });

  it('closes an unfinished driver phase as failed when the runner dies', async () => {
    const sink = new CollectingLatencySink();
    const transport = new CommandDriverTransport(
      nodeCommand(`
        readInput(() => {
          process.exit(3);
        });
      `),
    );

    await expect(
      runWithRunLatencyRecorder(createLatencyRecorder(sink), () => transport.run(PROMPT)),
    ).rejects.toThrow(/exited with code 3/);

    // 半路夭折的段要按失败收尾，否则它在流水里只剩一个开始，而失败最需要归因。
    expect(sink.spans.find((span) => span.name === 'driver.handshake')?.ok).toBe(false);
    // 没走到 turn 就不该凭空多出 turn 段——否则耗时会被算到没发生过的事情上。
    expect(sink.spans.some((span) => span.name === 'driver.turn')).toBe(false);
  });

  it('does not cap total turn duration while the Driver remains active', async () => {
    const transport = new CommandDriverTransport({
      ...nodeCommand(`
        readInput((raw) => {
          const heartbeat = setInterval(() => process.stderr.write('active\\n'), 20);
          setTimeout(() => {
            clearInterval(heartbeat);
            process.stdout.write(JSON.stringify(driverRunResult(JSON.parse(raw).task_id)));
          }, 250);
        });
      `),
      inactivityTimeoutMs: 100,
    });

    await expect(transport.run(PROMPT)).resolves.toMatchObject({ status: 'succeeded' });
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

    await expect(first).rejects.toThrow(TERMINATED);
    expect(activeChildren().has('run_cancel_first')).toBe(false);
    expect(activeChildren().has('run_cancel_second')).toBe(true);

    await transport.interrupt('test cleanup', 'run_cancel_second');
    await expect(second).rejects.toThrow(TERMINATED);
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 子进程把孙进程 pid 落盘后才算起来了，轮询等它出现。 */
async function readPid(pidFile: string): Promise<number> {
  let pid: number | undefined;
  await waitFor(async () => {
    try {
      pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      return Number.isInteger(pid) && pid > 0;
    } catch {
      return false;
    }
  }, '孙进程 pid 未在预期时间内落盘');
  return pid as number;
}

/**
 * 轮询直到条件成立。
 *
 * 终止是异步的：直接子进程 close 不等于孙进程已经消失，所以这里必须给一点余量，
 * 否则测试会在正确的实现上偶发失败。
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message = '条件未在预期时间内成立',
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
