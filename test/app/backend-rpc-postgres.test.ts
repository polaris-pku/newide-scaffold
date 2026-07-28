import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';

const postgresUrl = process.env.MEMORY_PG_TEST_URL?.trim();
const describePostgres = postgresUrl ? describe : describe.skip;

describePostgres('backend RPC PostgreSQL acceptance', () => {
  it('starts the production stdio entrypoint, answers ping, and closes cleanly', async () => {
    if (!postgresUrl) throw new Error('MEMORY_PG_TEST_URL is required');

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'newide-backend-pg-'));
    const runnerDir = path.join(tempRoot, 'fake-acp-runner');
    let child: ChildProcessWithoutNullStreams | undefined;
    let stderr = '';

    try {
      await mkdir(runnerDir);
      await writeFile(
        path.join(runnerDir, 'package.json'),
        JSON.stringify({
          private: true,
          scripts: { 'driver:run': 'node --eval "process.exit(0)"' },
        }),
      );

      child = spawn(
        process.execPath,
        ['--import', 'tsx', path.join(process.cwd(), 'src/app/backend-rpc-stdio.ts')],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ACP_DRIVER_ENV_FILE: path.join(runnerDir, '.env'),
            ACP_DRIVER_RUNNER_DIR: runnerDir,
            NEWIDE_B_DATABASE_URL: postgresUrl,
            NEWIDE_COORDINATION_DB: path.join(tempRoot, 'coordination.sqlite'),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      const responsePromise = readFirstResponse(child, 20_000);
      child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"system.ping"}\n');

      await expect(responsePromise).resolves.toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { status: 'ok', protocol_version: '0.1.0' },
      });

      const closed = waitForClose(child, 10_000);
      child.stdin.end();
      const result = await closed;
      const secrets = connectionSecrets(postgresUrl);

      expect(secrets.some((secret) => stderr.includes(secret))).toBe(false);
      expect(result.code, redact(stderr, secrets)).toBe(0);
      expect(result.signal, redact(stderr, secrets)).toBeNull();
    } finally {
      await stopChild(child);
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 35_000);
});

async function readFirstResponse(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<unknown> {
  const lines = createInterface({ input: child.stdout });
  try {
    const line = await withTimeout(
      Promise.race([
        once(lines, 'line').then(([value]) => String(value)),
        once(child, 'close').then(([code, signal]) => {
          throw new Error(
            `Backend closed before replying to system.ping (code=${String(code)}, signal=${String(signal)})`,
          );
        }),
      ]),
      timeoutMs,
      'Timed out waiting for system.ping response',
    );
    return JSON.parse(line) as unknown;
  } finally {
    lines.close();
  }
}

async function waitForClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const [code, signal] = await withTimeout(
    once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>,
    timeoutMs,
    'Timed out waiting for backend process to close',
  );
  return { code, signal };
}

async function stopChild(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const closed = waitForClose(child, 2_000);
  child.stdin.destroy();
  child.kill('SIGTERM');
  try {
    await closed;
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      const killed = waitForClose(child, 2_000);
      child.kill('SIGKILL');
      await killed.catch(() => undefined);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function connectionSecrets(databaseUrl: string): string[] {
  const secrets = new Set([databaseUrl]);
  try {
    const password = new URL(databaseUrl).password;
    if (password) {
      secrets.add(password);
      secrets.add(decodeURIComponent(password));
    }
  } catch {
    // The backend owns validation of the connection string.
  }
  return [...secrets].filter(Boolean);
}

function redact(value: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), value);
}
