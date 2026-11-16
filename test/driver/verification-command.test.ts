/** Real process checks for argv fidelity, bounded output, startup failure and cancellation. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runVerificationCommand } from '../../src/driver';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) =>
      fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    ),
  );
});
async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-verify-command-'));
  directories.push(dir);
  return dir;
}

it('preserves literal argv and observes the actual exit code without a shell', async () => {
  const result = await runVerificationCommand({
    workspace: await workspace(),
    signal: new AbortController().signal,
    command: {
      executable: 'node',
      args: ['-e', 'console.log(process.argv[1]); process.exit(3)', 'spaces & $(literal)'],
    },
  });
  expect(result).toMatchObject({ exit_code: 3, stdout: 'spaces & $(literal)\n', truncated: false });
});

it('bounds large output and marks it truncated', async () => {
  const result = await runVerificationCommand({
    workspace: await workspace(),
    signal: new AbortController().signal,
    command: { executable: 'node', args: ['-e', 'console.log("x".repeat(200000))'] },
  });
  expect(result.truncated).toBe(true);
  expect(result.stdout.length).toBeLessThanOrEqual(64_000);
});

it('distinguishes a missing executable from a failed check', async () => {
  await expect(
    runVerificationCommand({
      workspace: await workspace(),
      signal: new AbortController().signal,
      command: { executable: 'newide-nonexistent-verifier', args: [] },
    }),
  ).rejects.toMatchObject({ evidence: 'not_executed' });
});

it('aborts a running check instead of waiting for its result', async () => {
  const dir = await workspace();
  const controller = new AbortController();
  const pending = runVerificationCommand({
    workspace: dir,
    signal: controller.signal,
    command: {
      executable: 'node',
      args: ['-e', 'require("node:fs").writeFileSync("started", "1"); setInterval(() => {}, 1000)'],
    },
  });
  const rejected = expect(pending).rejects.toThrow('cancel test');
  for (let n = 0; n < 100; n += 1) {
    if (await fs.stat(path.join(dir, 'started')).catch(() => undefined)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await fs.readFile(path.join(dir, 'started'), 'utf8')).toBe('1');
  controller.abort(new Error('cancel test'));
  await rejected;
});
