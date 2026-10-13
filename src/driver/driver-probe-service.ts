import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The serializable result returned by ACP's driver probe.
 *
 * The shape deliberately follows `acp-client-prototype`'s probe contract so the
 * frontend can use the ACP evidence without maintaining a second adapter model.
 */
export interface DriverProbe {
  agentId: string;
  displayName: string;
  launch: { command: string; args: string[] };
  provenance: 'env-override' | 'local-entry' | 'path' | 'npx-on-demand';
  connectionType: 'acp' | 'pty';
  initialize?: {
    protocolVersion: number;
    authMethods: number;
    agentCapabilities?: string[];
    agentVersion?: string;
  };
  probedAt: string;
}

export interface DriverProbeResult {
  schema_version: 'driver-probe.v1';
  generated_at: string;
  drivers: DriverProbe[];
}

export interface DriverProbeOptions {
  agentIds?: readonly string[];
  timeoutMs?: number;
  concurrency?: number;
  force?: boolean;
}

export class DriverProbeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverProbeUnavailableError';
  }
}

export class DriverProbeFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverProbeFailedError';
  }
}

export interface DriverProbeService {
  probe(options?: DriverProbeOptions): Promise<DriverProbeResult>;
}

export interface AcpDriverProbeServiceOptions {
  runnerDir: string;
  /** Test seam; production uses the ACP runner's Node entrypoint. */
  spawn?: typeof spawn;
  processTimeoutMs?: number;
}

/**
 * Bridges NewIDE's JSON-RPC process to the probe module shipped by ACP.
 *
 * ACP intentionally owns adapter metadata, launch resolution and initialize
 * probing. NewIDE only starts a short-lived module process and validates the
 * serialized result; it does not duplicate that knowledge or probe commands on
 * its own.
 */
export class AcpDriverProbeService implements DriverProbeService {
  private readonly runnerDir: string;
  private readonly probeModule: string;
  private readonly spawnProcess: typeof spawn;
  private readonly processTimeoutMs: number;

  constructor(options: AcpDriverProbeServiceOptions) {
    this.runnerDir = path.resolve(options.runnerDir);
    this.probeModule = path.join(
      this.runnerDir,
      'dist',
      'src',
      'driver-adapter',
      'probe.js',
    );
    this.spawnProcess = options.spawn ?? spawn;
    this.processTimeoutMs = options.processTimeoutMs ?? 120_000;
  }

  async probe(options: DriverProbeOptions = {}): Promise<DriverProbeResult> {
    if (!existsSync(this.probeModule)) {
      throw new DriverProbeUnavailableError(
        'ACP driver probe is unavailable; rebuild acp-client-prototype with the probe module',
      );
    }

    const request = {
      ...(options.agentIds ? { agentIds: [...options.agentIds] } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.force === undefined ? {} : { force: options.force }),
    };
    const moduleUrl = pathToFileURL(this.probeModule).href;
    const script = [
      // Adapter setup code may print diagnostics (for example Goose's first-run
      // hint). Keep stdout a machine-readable channel for the RPC bridge.
      'for (const key of ["log", "info", "warn", "error"]) console[key] = (...args) => process.stderr.write(args.map(String).join(" ") + "\\n");',
      `const probe = await import(${JSON.stringify(moduleUrl)});`,
      'const input = JSON.parse(process.argv[1] || "{}");',
      'const opts = { timeoutMs: input.timeoutMs, concurrency: input.concurrency, force: input.force };',
      'let result;',
      'if (input.agentIds) {',
      '  const values = new Array(input.agentIds.length); let next = 0;',
      '  const limit = Math.max(1, Math.min(input.concurrency || input.agentIds.length, input.agentIds.length));',
      '  await Promise.all(Array.from({ length: limit }, async () => {',
      '    while (next < input.agentIds.length) { const index = next++; values[index] = await probe.probeAgent(input.agentIds[index], opts); }',
      '  }));',
      '  result = values.filter(Boolean);',
      '} else { result = await probe.probeAgents(opts); }',
      'process.stdout.write(JSON.stringify(result));',
    ].join('\n');

    let raw: string;
    try {
      raw = await this.runNode(script, JSON.stringify(request));
    } catch (error) {
      if (error instanceof DriverProbeUnavailableError) throw error;
      throw new DriverProbeFailedError(error instanceof Error ? error.message : String(error));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DriverProbeFailedError('ACP driver probe returned invalid JSON');
    }
    if (!Array.isArray(parsed)) {
      throw new DriverProbeFailedError('ACP driver probe returned an invalid result');
    }

    return {
      schema_version: 'driver-probe.v1',
      generated_at: new Date().toISOString(),
      drivers: parsed.map((value) => {
        try {
          return validateProbe(value);
        } catch (error) {
          throw new DriverProbeFailedError(
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    };
  }

  private runNode(script: string, request: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(
        process.execPath,
        ['--input-type=module', '--eval', script, request],
        { cwd: this.runnerDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        terminateProcessTree(child.pid);
        reject(new Error('ACP driver probe timed out'));
      }, this.processTimeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Failed to start ACP driver probe: ${error.message}`));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 500);
          reject(new Error(`ACP driver probe failed${detail ? `: ${detail}` : ''}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString('utf8'));
      });
    });
  }
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
      return;
    } catch {
      // Fall through to the portable single-process path.
    }
  }
  try {
    process.kill(pid);
  } catch {
    // The process may have exited between the timeout and cleanup.
  }
}

function validateProbe(value: unknown): DriverProbe {
  if (!value || typeof value !== 'object') throw new Error('ACP driver probe returned invalid driver');
  const row = value as Record<string, unknown>;
  if (
    typeof row.agentId !== 'string' ||
    typeof row.displayName !== 'string' ||
    typeof row.provenance !== 'string' ||
    typeof row.connectionType !== 'string' ||
    typeof row.probedAt !== 'string'
  ) {
    throw new Error('ACP driver probe returned an incomplete driver');
  }
  if (!['env-override', 'local-entry', 'path', 'npx-on-demand'].includes(row.provenance)) {
    throw new Error('ACP driver probe returned an unknown launch provenance');
  }
  if (row.connectionType !== 'acp' && row.connectionType !== 'pty') {
    throw new Error('ACP driver probe returned an unknown connection type');
  }
  const launch = row.launch;
  const launchRecord = launch && typeof launch === 'object' ? (launch as Record<string, unknown>) : undefined;
  if (
    !launchRecord ||
    typeof launchRecord.command !== 'string' ||
    !Array.isArray(launchRecord.args) ||
    !launchRecord.args.every((arg: unknown) => typeof arg === 'string')
  ) {
    throw new Error('ACP driver probe returned an invalid launch command');
  }
  return row as unknown as DriverProbe;
}
