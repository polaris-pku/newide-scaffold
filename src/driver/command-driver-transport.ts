import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { nowTimestamp } from '../core';
import {
  driverPhaseSpan,
  latencySpan,
  recordRunLatencySpan,
  withRunLatencySpan,
  type RunLatencySpanRef,
} from '../telemetry';
import type {
  DriverPrompt,
  DriverRunResult,
  DriverStreamEvent,
  DriverStreamEventListener,
} from './contract';
import { assertDriverRunResult, type ExternalDriverTransport } from './external-driver-runtime';

export const DRIVER_EVENT_PREFIX = 'NEWIDE_DRIVER_EVENT ';

export interface CommandDriverTransportOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  unsetEnv?: readonly string[];
  timeoutMs?: number;
  /** Terminate only when the child produces no stdout/stderr activity. */
  inactivityTimeoutMs?: number;
  onEvent?: DriverStreamEventListener;
}

export class CommandDriverTransport implements ExternalDriverTransport {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly unsetEnv: readonly string[];
  private readonly timeoutMs: number | undefined;
  private readonly inactivityTimeoutMs: number | undefined;
  private readonly activeChildren = new Map<string, ChildProcess>();
  private readonly eventListeners = new Set<DriverStreamEventListener>();
  private readonly requestedInterrupts = new Set<string>();
  private stderr = '';

  constructor(options: CommandDriverTransportOptions) {
    if (!options.command.trim()) {
      throw new Error('Command driver command is required');
    }
    if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
      throw new Error('Command driver timeoutMs must be greater than 0');
    }
    if (options.inactivityTimeoutMs !== undefined && options.inactivityTimeoutMs <= 0) {
      throw new Error('Command driver inactivityTimeoutMs must be greater than 0');
    }

    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.unsetEnv = options.unsetEnv ?? [];
    this.timeoutMs = options.timeoutMs;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs;
    if (options.onEvent) this.eventListeners.add(options.onEvent);
  }

  get lastStderr(): string {
    return this.stderr;
  }

  async invoke(input: DriverPrompt): Promise<DriverRunResult> {
    return this.run(input);
  }

  async run(input: DriverPrompt): Promise<DriverRunResult> {
    const stdout = await withRunLatencySpan('driver.invoke', {}, () => this.execute(input));
    return parseDriverRunResult(stdout);
  }

  async interrupt(reason: string, runId?: string): Promise<void> {
    const children = runId
      ? [...(this.activeChildren.get(runId) ? [this.activeChildren.get(runId)!] : [])]
      : [...this.activeChildren.values()];
    const ids = runId ? [runId] : [...this.activeChildren.keys()];
    for (const id of ids) this.requestedInterrupts.add(id);
    for (const id of ids) {
      this.emitEvent({
        schema_version: 'driver-event.v1',
        event_type: 'driver.interrupt_requested',
        payload: { reason },
        run_id: id,
        sequence: 0,
        created_at: nowTimestamp(),
      });
    }
    try {
      await Promise.all(children.map((child) => terminateAndWait(child)));
    } finally {
      for (const id of ids) this.requestedInterrupts.delete(id);
    }
  }

  async shutdown(): Promise<void> {
    await this.interrupt('Command driver transport shutdown');
  }

  subscribeToEvents(listener: DriverStreamEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private execute(input: DriverPrompt): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.activeChildren.has(input.run_id)) {
        reject(new Error(`Command driver run ${input.run_id} is already active`));
        return;
      }
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stderrPending = '';
      let eventSequence = 0;
      let stdinError: Error | undefined;
      let timedOut = false;
      let inactive = false;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let inactivityTimeout: NodeJS.Timeout | undefined;
      let forceKillTimeout: NodeJS.Timeout | undefined;

      // ── 耗时埋点 ──
      //
      // 这些记录是从流回调里发出的，而 `recordRunLatencySpan` 查的是
      // AsyncLocalStorage 的「当前」上下文。实测确认：流回调继承的是创建该子进程
      // 时的上下文，也就是发起这次调用的那个 run，并发跑多个 run 也各归各的。
      // 「attributes concurrent driver spans to the run that invoked them」那条
      // 用例钉住了这个假设——万一将来传播行为变了，它会先红，而不是让埋点悄悄消失。
      //
      // （如果确实要脱离上下文，可以在 execute 开头同步抓 getRunLatencyRecorder()
      // 并在闭包里用它；实测并非必要，故不预先付出这份复杂度。）
      const openPhases = new Map<
        string,
        { ref: RunLatencySpanRef; mono: number; wall: string; meta?: Record<string, unknown> }
      >();

      const openPhase = (ref: RunLatencySpanRef, meta?: Record<string, unknown>): void => {
        openPhases.set(ref.name, {
          ref,
          mono: performance.now(),
          wall: nowTimestamp(),
          ...(meta ? { meta } : {}),
        });
      };

      const closePhase = (ref: RunLatencySpanRef, phaseOk = true): void => {
        const opened = openPhases.get(ref.name);
        if (!opened) return;
        openPhases.delete(ref.name);
        recordRunLatencySpan(ref, {
          started_at: opened.wall,
          completed_at: nowTimestamp(),
          // 同一个进程内的单调钟差值，不受系统时间调整影响。
          duration_ms: Math.max(0, performance.now() - opened.mono),
          ok: phaseOk,
          ...(opened.meta ? { meta: opened.meta } : {}),
        });
      };

      /**
       * 收尾时把还开着的段按给定结果关掉。
       *
       * 不这样做的话，凡是没走到正常终点的段都会从流水里凭空消失——而失败恰恰是
       * 最需要归因的场景。参数用进程的退出方式，正常退出时那一段就是成功的。
       */
      const closeAllOpenPhases = (phaseOk: boolean): void => {
        for (const opened of [...openPhases.values()]) closePhase(opened.ref, phaseOk);
      };

      /** 把 ACP 侧上报的进度映射成本次调用的段。 */
      const trackDriverEvent = (event: DriverStreamEvent): void => {
        if (event.event_type === 'driver.turn_started') {
          closePhase(latencySpan('driver.handshake'));
          openPhase(latencySpan('driver.turn'));
          return;
        }
        if (event.event_type === 'driver.turn_completed') {
          closePhase(latencySpan('driver.turn'));
          openPhase(latencySpan('driver.shutdown'));
          return;
        }
        if (event.event_type !== 'driver.phase') return;

        const payload =
          event.payload && typeof event.payload === 'object'
            ? (event.payload as Record<string, unknown>)
            : undefined;
        const phase = typeof payload?.phase === 'string' ? payload.phase : undefined;
        if (!phase) return;

        const ref = driverPhaseSpan(phase);
        if (payload?.boundary === 'started') {
          // session 段的 mode 区分 create / load，两者成本形态不同。
          openPhase(ref, payload.mode === undefined ? undefined : { mode: payload.mode });
          return;
        }
        closePhase(ref, payload?.ok !== false);
      };

      const child = spawn(this.command, this.args, this.spawnOptions());
      this.activeChildren.set(input.run_id, child);

      const releaseChild = (): void => {
        if (this.activeChildren.get(input.run_id) === child) {
          this.activeChildren.delete(input.run_id);
        }
      };

      const clearTimers = (): void => {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (inactivityTimeout) {
          clearTimeout(inactivityTimeout);
        }
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
        }
      };

      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        releaseChild();
        reject(error);
      };

      if (this.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          timedOut = true;
          terminateChild(child.pid, 'SIGTERM');
          forceKillTimeout = setTimeout(() => {
            terminateChild(child.pid, 'SIGKILL');
          }, 1_000);
        }, this.timeoutMs);
      }

      const armInactivityTimeout = (): void => {
        if (this.inactivityTimeoutMs === undefined) return;
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        inactivityTimeout = setTimeout(() => {
          inactive = true;
          terminateChild(child.pid, 'SIGTERM');
          forceKillTimeout = setTimeout(() => {
            terminateChild(child.pid, 'SIGKILL');
          }, 1_000);
        }, this.inactivityTimeoutMs);
        inactivityTimeout.unref?.();
      };
      armInactivityTimeout();

      child.stdout.on('data', (chunk: Buffer) => {
        armInactivityTimeout();
        stdoutChunks.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        armInactivityTimeout();
        stderrPending += chunk.toString('utf8');
        for (;;) {
          const newline = stderrPending.indexOf('\n');
          if (newline < 0) break;
          const line = stderrPending.slice(0, newline);
          stderrPending = stderrPending.slice(newline + 1);
          this.consumeStderrLine(line, true, input, () => ++eventSequence, stderrChunks, trackDriverEvent);
        }
      });

      child.stdin.on('error', (error: Error) => {
        stdinError = error;
      });

      child.once('error', (error: Error) => {
        rejectOnce(
          new Error(`Command driver failed to start ${this.commandLabel()}: ${error.message}`),
        );
      });

      child.once('close', (code, signal) => {
        releaseChild();
        if (settled) {
          return;
        }

        settled = true;
        clearTimers();
        if (stderrPending) {
          this.consumeStderrLine(
            stderrPending,
            false,
            input,
            () => ++eventSequence,
            stderrChunks,
            trackDriverEvent,
          );
        }
        // 收尾：没走到正常终点的段在这里关掉，按进程自己的退出方式定成败。不补这
        // 一下，半路失败的调用在流水里就只剩一个孤零零的开始，而失败最需要归因。
        closeAllOpenPhases(code === 0 && signal === null);
        this.stderr = Buffer.concat(stderrChunks).toString('utf8');
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderrSummary = summarizeText(this.stderr);

        if (timedOut && !this.requestedInterrupts.has(input.run_id)) {
          reject(
            new Error(
              `Command driver timed out after ${String(this.timeoutMs)}ms: ${this.commandLabel()}. stderr: ${stderrSummary}`,
            ),
          );
          return;
        }

        if (inactive && !this.requestedInterrupts.has(input.run_id)) {
          reject(
            new Error(
              `Command driver produced no output for ${String(this.inactivityTimeoutMs)}ms: ${this.commandLabel()}. stderr: ${stderrSummary}`,
            ),
          );
          return;
        }

        if ((code !== 0 || signal) && stdoutIsDriverRunResult(stdout)) {
          resolve(stdout);
          return;
        }

        if (signal) {
          reject(
            new Error(
              `Command driver failed: ${this.commandLabel()} exited with signal ${signal}. stderr: ${stderrSummary}`,
            ),
          );
          return;
        }

        if (code !== 0) {
          reject(
            new Error(
              `Command driver failed: ${this.commandLabel()} exited with code ${String(code)}. stderr: ${stderrSummary}`,
            ),
          );
          return;
        }

        if (stdinError) {
          reject(
            new Error(
              `Command driver failed to write DriverPrompt to stdin: ${stdinError.message}. stderr: ${stderrSummary}`,
            ),
          );
          return;
        }

        resolve(stdout);
      });

      // 握手段从写 stdin 起算：进程启动加上 ACP initialize / authenticate / session
      // 都在这一段里，直到 ACP 侧报出 turn_started。spawn() 本身不阻塞，所以它前面
      // 没有可观测的等待，不另设一段。
      openPhase(latencySpan('driver.handshake'));
      child.stdin.end(JSON.stringify(input));
    });
  }

  private consumeStderrLine(
    line: string,
    terminatedByNewline: boolean,
    input: DriverPrompt,
    nextSequence: () => number,
    diagnostics: Buffer[],
    onEvent?: (event: DriverStreamEvent) => void,
  ): void {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!normalized.startsWith(DRIVER_EVENT_PREFIX)) {
      diagnostics.push(Buffer.from(terminatedByNewline ? `${line}\n` : line, 'utf8'));
      return;
    }

    let event: DriverStreamEvent;
    try {
      const parsed = JSON.parse(normalized.slice(DRIVER_EVENT_PREFIX.length)) as Record<
        string,
        unknown
      >;
      if (!parsed || typeof parsed.event_type !== 'string') {
        throw new Error('event_type is required');
      }
      event = {
        schema_version:
          typeof parsed.schema_version === 'string' ? parsed.schema_version : 'driver-event.v1',
        event_type: parsed.event_type,
        ...(parsed.payload !== undefined ? { payload: parsed.payload } : {}),
        task_id: typeof parsed.task_id === 'string' ? parsed.task_id : input.task_id,
        run_id: typeof parsed.run_id === 'string' ? parsed.run_id : input.run_id,
        ...(typeof parsed.role_id === 'string' ? { role_id: parsed.role_id } : {}),
        ...(typeof parsed.session_id === 'string' ? { session_id: parsed.session_id } : {}),
        sequence: typeof parsed.sequence === 'number' ? parsed.sequence : nextSequence(),
        created_at: typeof parsed.created_at === 'string' ? parsed.created_at : nowTimestamp(),
      };
    } catch {
      // A malformed reserved line stays diagnostic output and cannot break the run.
      diagnostics.push(Buffer.from(terminatedByNewline ? `${line}\n` : line, 'utf8'));
      return;
    }

    this.emitEvent(event);
    // 埋点在解析成功之后单独调用：把它放进上面的 try 里的话，埋点自己抛错会被
    // 误判成「这行是畸形的」，于是合法事件被降级成诊断输出。
    onEvent?.(event);
  }

  private emitEvent(event: DriverStreamEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Observability must never fail the driver invocation.
      }
    }
  }

  private spawnOptions(): SpawnOptionsWithoutStdio {
    const options: SpawnOptionsWithoutStdio = {
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    // 让子进程自成进程组，terminateChild 的 process.kill(-pid) 才有组可杀。
    // 条件只依赖平台：此前它还要求 timeoutMs 存在，而生产构建并不传 timeoutMs
    // （只传 inactivityTimeoutMs），于是进程组永远不建，kill(-pid) 必抛 ESRCH，
    // 每次都退回单进程 kill，ACP agent 孙进程被 init 收养。
    //
    // Windows 不走这条：libuv 会把非 detached 的子进程放进 Job Object
    // （KILL_ON_JOB_CLOSE），父进程一死整棵树随之回收。反过来，在 Windows 上设
    // detached 会把它移出 job，那才会真的制造孤儿进程。
    if (process.platform !== 'win32') {
      options.detached = true;
    }

    if (this.cwd !== undefined) {
      options.cwd = this.cwd;
    }

    if (this.env !== undefined || this.unsetEnv.length > 0) {
      const env = {
        ...process.env,
        ...(this.env ?? {}),
      };
      for (const key of this.unsetEnv) {
        delete env[key];
      }
      options.env = env;
    }

    return options;
  }

  private commandLabel(): string {
    return [
      this.command,
      ...this.args.map((arg) => summarizeText(arg.replace(/\s+/g, ' '), 80)),
    ].join(' ');
  }
}

function terminateAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const forceKill = setTimeout(() => terminateChild(child.pid, 'SIGKILL'), 1_000);
    const giveUp = setTimeout(finish, 2_000);
    forceKill.unref();
    giveUp.unref();

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      clearTimeout(giveUp);
      child.removeListener('close', finish);
      resolve();
    }

    child.once('close', finish);
    terminateChild(child.pid, 'SIGTERM');
  });
}

function summarizeText(input: string, maxLength = 500): string {
  const text = input.trim();
  if (!text) {
    return '<empty>';
  }
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function stdoutIsDriverRunResult(stdout: string): boolean {
  if (!stdout.trim()) {
    return false;
  }

  try {
    parseDriverRunResult(stdout);
    return true;
  } catch {
    return false;
  }
}

function parseDriverRunResult(stdout: string): DriverRunResult {
  const json = stdout.trim().split(/\r?\n/).at(-1) ?? '';
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Command driver stdout was not valid JSON: ${reason}. stdout: ${summarizeText(stdout)}`,
    );
  }

  assertDriverRunResult(parsed, 'Command driver');
  return parsed;
}

/**
 * 终止直接子进程及其子孙。
 *
 * POSIX：对负 pid 发信号即杀整个进程组，所以 spawnOptions 必须设 detached，
 * 否则没有组可杀、这里会静默退化成只杀直接子进程。
 *
 * Windows：杀直接子进程就够了，不需要 taskkill。libuv 会把非 detached 的子进程
 * 放进 Job Object（KILL_ON_JOB_CLOSE），父进程一死，job 内包括孙进程在内的所有
 * 进程都被回收——这一点已实测确认（孙进程自行 detached 则会活下来）。
 * 所以这里不要"顺手"补一个 taskkill：多余，而且会掩盖真正的机制；更不要给
 * Windows 设 detached，那会把子进程移出 job，结果正好相反。
 */
function terminateChild(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }

  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, signal);
      return;
    }
  } catch {
    // Fall back to killing the direct child below.
  }

  try {
    process.kill(pid, signal);
  } catch {
    // The process may have already exited.
  }
}
