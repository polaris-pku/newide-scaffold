import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { nowTimestamp } from '../core';
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
  onEvent?: DriverStreamEventListener;
}

export class CommandDriverTransport implements ExternalDriverTransport {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly unsetEnv: readonly string[];
  private readonly timeoutMs: number | undefined;
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

    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.unsetEnv = options.unsetEnv ?? [];
    this.timeoutMs = options.timeoutMs;
    if (options.onEvent) this.eventListeners.add(options.onEvent);
  }

  get lastStderr(): string {
    return this.stderr;
  }

  async invoke(input: DriverPrompt): Promise<DriverRunResult> {
    return this.run(input);
  }

  async run(input: DriverPrompt): Promise<DriverRunResult> {
    const stdout = await this.execute(input);
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
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let forceKillTimeout: NodeJS.Timeout | undefined;

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

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrPending += chunk.toString('utf8');
        for (;;) {
          const newline = stderrPending.indexOf('\n');
          if (newline < 0) break;
          const line = stderrPending.slice(0, newline);
          stderrPending = stderrPending.slice(newline + 1);
          this.consumeStderrLine(line, true, input, () => ++eventSequence, stderrChunks);
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
          this.consumeStderrLine(stderrPending, false, input, () => ++eventSequence, stderrChunks);
        }
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

      child.stdin.end(JSON.stringify(input));
    });
  }

  private consumeStderrLine(
    line: string,
    terminatedByNewline: boolean,
    input: DriverPrompt,
    nextSequence: () => number,
    diagnostics: Buffer[],
  ): void {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!normalized.startsWith(DRIVER_EVENT_PREFIX)) {
      diagnostics.push(Buffer.from(terminatedByNewline ? `${line}\n` : line, 'utf8'));
      return;
    }

    try {
      const parsed = JSON.parse(normalized.slice(DRIVER_EVENT_PREFIX.length)) as Record<
        string,
        unknown
      >;
      if (!parsed || typeof parsed.event_type !== 'string') {
        throw new Error('event_type is required');
      }
      this.emitEvent({
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
      });
    } catch {
      // A malformed reserved line stays diagnostic output and cannot break the run.
      diagnostics.push(Buffer.from(terminatedByNewline ? `${line}\n` : line, 'utf8'));
    }
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

    // On Windows, bare command names that ship only as batch shims (pnpm.cmd,
    // npm.cmd, ...) cannot be launched by CreateProcess directly. Route them
    // through cmd.exe so PATHEXT resolution works; paths and command names
    // that already carry an extension or a directory are spawned directly.
    if (process.platform === 'win32' && needsCmdShell(this.command)) {
      options.shell = true;
    }

    if (this.timeoutMs !== undefined && process.platform !== 'win32') {
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

/** True when a bare command name needs cmd.exe resolution on Windows. */
function needsCmdShell(command: string): boolean {
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(command) || command.startsWith('/');
  if (isAbsolute || command.includes('\\') || command.includes('/')) return false;
  // Bare names with an explicit extension (node.exe, pnpm.cmd) are spawned
  // directly; bare names without one need PATHEXT lookup via the shell.
  return !command.includes('.');
}

function terminateAndWait(child: ChildProcess): Promise<void> {  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

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
