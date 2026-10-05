import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('production RPC composition smoke script', () => {
  it('verifies the production A/B chain, Council, cancellation, and protocol errors', async () => {
    expect(await runSmoke()).toMatchObject({
      status: 'ok',
      runtime: 'production-composition-deterministic-b-llm-fake-acp',
      mode: 'all',
      single_agent: { artifacts: 1 },
      council: { artifacts: 1 },
      driver_invocations: 7,
      cancelled: { status: 'cancelled' },
      malformed_json_error: -32700,
      unknown_method_error: -32601,
    });
  }, 60_000);

  it.each([
    ['single_agent', 2],
    ['council', 5],
  ] as const)(
    'runs %s as an independent frontend mode',
    async (mode, invocations) => {
      const summary = await runSmoke(['--mode', mode]);
      expect(summary).toMatchObject({
        status: 'ok',
        mode,
        driver_invocations: invocations,
        [mode]: { artifacts: 1 },
      });
      expect(summary).not.toHaveProperty(mode === 'single_agent' ? 'council' : 'single_agent');
    },
    30_000,
  );
});

async function runSmoke(args: string[] = []): Promise<Record<string, unknown>> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-rpc-smoke-'));
  try {
    // 直接起 node，不走 `pnpm rpc:smoke`：Windows 上 `spawn('pnpm')` 是 **ENOENT**
    // （`pnpm` 是 .cmd 垫片，不经 shell 起不来），于是这三条用例在 Windows 上长期红着、
    // 被当成「既有环境性失败」记进基线——实际是**测试自己**起不来被测脚本。
    // 参数与 `package.json` 的 `rpc:smoke` 一致，只是把 `pnpm` 换成 `process.execPath`。
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/rpc-smoke.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, RPC_SMOKE_WORKSPACE: workspace },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));

    const [code] = await once(child, 'exit');
    expect(code, stderr).toBe(0);
    const summaryLine = stdout.split('\n').find((line) => line.startsWith('{"status"'));
    expect(summaryLine).toBeDefined();
    return JSON.parse(summaryLine!) as Record<string, unknown>;
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
