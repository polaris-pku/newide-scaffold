import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_DISPATCH_EVENT } from '../../src/app/run-dispatch-events';
import { buildRoleAutonomySelectionConfig } from '../../src/app/backend-rpc-stdio';
import type { ToolCallingClient } from '../../src/memory';
import {
  assertRoleSmokeDispatchTermination,
  assertRoleSmokeSummaryFile,
  buildRoleSmokeEnv,
  buildRoleSmokeSample,
  createRoleSmokeLlm,
  ROLE_SMOKE_DISPATCH_BUDGET,
  ROLE_SMOKE_SAMPLE_KEY,
  type RoleSmokeEventView,
  type RoleSmokeSnapshotView,
} from '../fixtures/role-autonomy-smoke';

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
      // driver.* 三个方法都注册到了生产 dispatcher 上
      driver_config: { schema_version: 'driver-routing.v1' },
      driver_update_invalid_params: -32602,
      driver_reset_invalid_params: -32602,
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

/**
 * 阶段 4 场景的**纯夹具**测试：不启动后端、不 spawn 任何子进程。
 *
 * 真实 smoke 脚本在 Windows/CI 由 `pnpm rpc:smoke` 跑；这里覆盖它的确定性输入
 * （role LLM、env）与断言辅助函数，保证场景的契约判断本身可回归。
 */
describe('rpc smoke role autonomy dispatch scenario fixtures', () => {
  it('drives dispatch_execution for role tool tables and falls back to the legacy fake otherwise', async () => {
    const fallback: ToolCallingClient = {
      async completeWithTools() {
        return { content: 'legacy fallback', tool_calls: undefined };
      },
    };
    const llm = createRoleSmokeLlm(fallback);
    const roleTools = [toolDefinition('dispatch_execution'), toolDefinition('finish_task')];

    const first = await llm.completeWithTools({ messages: roleMessages(), tools: roleTools });
    expect(first.tool_calls?.[0]?.function.name).toBe('dispatch_execution');
    const parsedFirst = JSON.parse(first.tool_calls?.[0]?.function.arguments ?? '{}') as Record<
      string,
      unknown
    >;
    expect(parsedFirst).toMatchObject({
      kind: 'execute',
      acceptance: [],
      constraints: [],
      expected_artifacts: [],
      session: { mode: 'fresh' },
    });
    expect(String(parsedFirst['instruction'] ?? '')).not.toBe('');

    const second = await llm.completeWithTools({ messages: roleMessages(), tools: roleTools });
    expect(second.tool_calls?.[0]?.function.arguments).toContain('RPC smoke role dispatch 2');

    // 预算耗尽那一轮仍返回派工：宿主 assertDispatchAllowed 会在真正调用 driver 之前
    // 抛出 budget_dispatches（纯文本不会结束 role loop，RD-FIN）。
    const third = await llm.completeWithTools({ messages: roleMessages(), tools: roleTools });
    expect(third.tool_calls).toHaveLength(1);

    const legacy = await llm.completeWithTools({
      messages: roleMessages(),
      tools: [toolDefinition('invoke_driver')],
    });
    expect(legacy.content).toBe('legacy fallback');
    expect(legacy.tool_calls).toBeUndefined();
  });

  it('is accepted by the production role selection config with a 2-dispatch budget', () => {
    const config = buildRoleAutonomySelectionConfig(
      buildRoleSmokeEnv({ base: {}, state_root: 'state', runner_dir: 'runner' }),
      { wired: true },
    );
    expect(config).toMatchObject({
      enabled: true,
      wired: true,
      switches: { evidence_only: false, buffer_v2: false },
      budget_overrides: { max_dispatches: ROLE_SMOKE_DISPATCH_BUDGET },
    });
  });

  it('builds an env that pins role autonomy, stage-3 switches and the dispatch budget', () => {
    const env = buildRoleSmokeEnv({
      base: {
        NEWIDE_STATE_ROOT: 'old-state',
        NEWIDE_ROLE_AUTONOMY: '0',
        NEWIDE_DRIVER_EVIDENCE_ONLY: '1',
        NEWIDE_BUFFER_V2: '1',
        PATH: 'kept',
      },
      state_root: 'new-state',
      runner_dir: 'runner-dir',
    });
    expect(env).toMatchObject({
      ACP_DRIVER_RUNNER_DIR: 'runner-dir',
      NEWIDE_STATE_ROOT: 'new-state',
      NEWIDE_ROLE_AUTONOMY: '1',
      NEWIDE_DRIVER_EVIDENCE_ONLY: '0',
      NEWIDE_BUFFER_V2: '0',
      NEWIDE_ROLE_MAX_DISPATCHES: String(ROLE_SMOKE_DISPATCH_BUDGET),
      NEWIDE_COORDINATION_DB: expect.stringMatching(/coordination\.sqlite$/),
      PATH: 'kept',
    });
  });

  it('accepts the conforming snapshot/events and reports the projected facts', () => {
    const facts = assertRoleSmokeDispatchTermination({
      snapshot: roleSmokeSnapshot(),
      events: roleSmokeEvents(),
    });
    expect(facts).toEqual({
      termination_code: 'budget_dispatches',
      termination_actor: 'host',
      dispatch_ids: ['dsp_1', 'dsp_2'],
      event_counts: { accepted: 2, started: 2, settled: 2, role_terminated: 1 },
      summary: {
        total: 2,
        by_status: { succeeded: 2 },
        last_dispatch_id: 'dsp_2',
      },
    });
  });

  it.each<{
    overrides: { snapshot?: RoleSmokeSnapshotView; events?: RoleSmokeEventView[] };
    expected: RegExp;
    label: string;
  }>([
    {
      label: 'dispatch count drift',
      overrides: {
        snapshot: roleSmokeSnapshot({ dispatch_summary: { ...baseSummary(), total: 1 } }),
      },
      expected: /dispatch_summary\.total mismatch: expected 2, received 1/,
    },
    {
      label: 'fabricated finish_requested',
      overrides: {
        snapshot: roleSmokeSnapshot({
          dispatch_progress: {
            terminated: { code: 'budget_dispatches', actor: 'host' },
            finish_requested: { status: 'completed', requested_at: '2026-11-15T00:00:00.000Z' },
          },
        }),
      },
      expected: /finish_requested must be absent/,
    },
    {
      label: 'termination actor drift',
      overrides: {
        snapshot: roleSmokeSnapshot({
          dispatch_progress: { terminated: { code: 'budget_dispatches', actor: 'role' } },
        }),
      },
      expected: /terminated\.actor mismatch: expected "host", received "role"/,
    },
    {
      label: 'missing termination event',
      overrides: {
        events: roleSmokeEvents().filter(
          (event) => event.type !== ROLE_DISPATCH_EVENT.role_terminated,
        ),
      },
      expected: /agent\.role_terminated event count mismatch: expected 1, received 0/,
    },
  ])('rejects $label with a pointed message', ({ overrides, expected }) => {
    expect(() =>
      assertRoleSmokeDispatchTermination({
        snapshot: roleSmokeSnapshot(),
        events: roleSmokeEvents(),
        ...overrides,
      }),
    ).toThrow(expected);
  });

  it('requires the terminal summary.json to agree on the dispatch total', () => {
    expect(() => assertRoleSmokeSummaryFile({ dispatch_summary: { total: 2 } })).not.toThrow();
    expect(() => assertRoleSmokeSummaryFile({ dispatch_summary: { total: 1 } })).toThrow(
      /summary\.json dispatch_summary\.total is 1, expected 2/,
    );
    expect(() => assertRoleSmokeSummaryFile({})).toThrow(/has no dispatch_summary/);
  });

  it('builds a compact frontend sample from the same snapshot/events', () => {
    const facts = assertRoleSmokeDispatchTermination({
      snapshot: roleSmokeSnapshot(),
      events: roleSmokeEvents(),
    });
    const sample = buildRoleSmokeSample({
      run_id: 'run_role',
      prompt: 'role prompt',
      snapshot: roleSmokeSnapshot(),
      events: roleSmokeEvents(),
      facts,
    });
    expect(sample).toMatchObject({
      scenario: 'role_autonomy_dispatch_budget_termination',
      request: { method: 'run.create', params: { prompt: 'role prompt', mode: 'single_agent' } },
      result: {
        run_id: 'run_role',
        status: 'failed',
        dispatch_ids: ['dsp_1', 'dsp_2'],
        event_counts: { accepted: 2, started: 2, settled: 2, role_terminated: 1 },
      },
    });
    expect(Object.keys(sample)).not.toContain('instruction');
    // 样例键名与脚本写入 samples 的键名同源（函数返回的是内容，键由调用方加）。
    expect(ROLE_SMOKE_SAMPLE_KEY).toBe('role_autonomy_dispatch_termination');
  });
});

function toolDefinition(name: string) {
  return {
    type: 'function' as const,
    function: { name, description: name, parameters: {} },
  };
}

function roleMessages() {
  return [
    { role: 'system' as const, content: 'role system prompt' },
    { role: 'user' as const, content: 'role task' },
  ];
}

function baseSummary(): NonNullable<RoleSmokeSnapshotView['dispatch_summary']> {
  return {
    total: 2,
    by_status: { succeeded: 2 },
    last_dispatch: { dispatch_id: 'dsp_2', status: 'succeeded' },
    unknown: { count: 0 },
    violations: { count: 0 },
  };
}

function roleSmokeSnapshot(overrides: Partial<RoleSmokeSnapshotView> = {}): RoleSmokeSnapshotView {
  return {
    status: 'failed',
    errors: [{ code: 'budget_dispatches', message: 'dispatch budget exhausted (2/2)' }],
    dispatch_summary: baseSummary(),
    dispatch_progress: { terminated: { code: 'budget_dispatches', actor: 'host' } },
    ...overrides,
  };
}

function roleSmokeEvents(): RoleSmokeEventView[] {
  const events: RoleSmokeEventView[] = [];
  for (const dispatchId of ['dsp_1', 'dsp_2']) {
    events.push({
      type: ROLE_DISPATCH_EVENT.accepted,
      payload: { dispatch_id: dispatchId, kind: 'execute', session_mode: 'fresh', sequence: 1 },
    });
    events.push({
      type: ROLE_DISPATCH_EVENT.started,
      payload: { dispatch_id: dispatchId, kind: 'execute' },
    });
    events.push({
      type: ROLE_DISPATCH_EVENT.settled,
      payload: { dispatch_id: dispatchId, kind: 'execute', status: 'succeeded', violations: [] },
    });
  }
  events.push({
    type: ROLE_DISPATCH_EVENT.role_terminated,
    payload: {
      code: 'budget_dispatches',
      actor: 'host',
      message: 'dispatch budget exhausted (2/2)',
    },
  });
  return events;
}

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
