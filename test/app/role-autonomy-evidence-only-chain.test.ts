/**
 * 阶段 5 清理前置：evidence-only 新路径**真实调用链**回归（不依赖真实外部 Driver）。
 *
 * 断言「普通 solo 新路径不再依赖六字段 converter / 报告文件」不是靠 grep，而是让真实
 * `RoleAutonomyEngine` → 真实 `createDriverRuntimeInvoker` → fake `DriverRuntimeHandle`
 * 跑一次派工，并用模块级 spy 统计 `createDefaultDriverReturnConverter` 返回的 converter
 * **实际被调用次数**：
 * - 冻结策略 `evidence_only=true`：converter 调用 0 次；即使 `ACP_WRITE_REPORT_FILE=1`，
 *   driver prompt 也不含六字段/报告文件指令，工作区也没有报告文件；引擎照常完成，
 *   说明 engine/finish/学习输入不依赖 `result.report`。
 * - 冻结策略 `evidence_only=false`（legacy/Council 兼容路径）：prompt 含六字段指令，
 *   converter 恰好调用 1 次，行为不变。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core';
import { buildExecutionBrief, hashExecutionBrief } from '../../src/driver';
import type {
  DriverRunResult,
  DriverRuntimeHandle,
  DriverStreamEvent,
} from '../../src/driver/contract';
import { RunDispatchJournal } from '../../src/persistence';
import type { BufferRepository, MemoryRepository } from '../../src/memory';
import {
  type RoleBudgetConsumption,
  type RoleBudgetPort,
  type RoleFinishValidatorPort,
  type RoleLoopOptions,
  type RoleLoopOutcome,
} from '../../src/app/role-autonomy-contract';
import { RoleAutonomyEngine } from '../../src/app/role-autonomy-engine';

/** 六字段 converter 的真实调用/构造次数（由模块 mock 包装统计）。 */
const converterInvocations = vi.hoisted(() => ({ count: 0, created: 0 }));

vi.mock('../../src/driver/driver-return-converter', async (importOriginal) => {
  // vi.mock 工厂需要模块命名空间类型，ESLint 的类型 import 规则不适用于这里的 import() 类型。
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('../../src/driver/driver-return-converter')>();
  return {
    ...actual,
    createDefaultDriverReturnConverter: (
      llm?: Parameters<typeof actual.createDefaultDriverReturnConverter>[0],
    ) => {
      converterInvocations.created += 1;
      const base = actual.createDefaultDriverReturnConverter(llm);
      return async (...args: Parameters<typeof base>) => {
        converterInvocations.count += 1;
        return base(...args);
      };
    },
  };
});

const temporaryDirectories: string[] = [];
const previousReportFileEnv = process.env.ACP_WRITE_REPORT_FILE;

beforeEach(() => {
  converterInvocations.count = 0;
  converterInvocations.created = 0;
  // 报告文件开关打开也必须不影响 evidence-only：没有报告文件要求，也就不会去写。
  process.env.ACP_WRITE_REPORT_FILE = '1';
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousReportFileEnv === undefined) delete process.env.ACP_WRITE_REPORT_FILE;
  else process.env.ACP_WRITE_REPORT_FILE = previousReportFileEnv;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const IDENTITY = { task_id: 'task_evidence_chain', role_id: 'role_evidence_chain' };

async function makeFixture(): Promise<{ runsRoot: string; runId: string; workspace: string }> {
  const runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-evidence-chain-'));
  temporaryDirectories.push(runsRoot);
  const runId = 'run_evidence_chain';
  await fs.mkdir(path.join(runsRoot, runId), { recursive: true });
  const workspace = path.join(runsRoot, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'deliverable.txt'), 'work done', 'utf8');
  return { runsRoot, runId, workspace };
}

function driverResult(status: DriverRunResult['status'], response = 'done'): DriverRunResult {
  return {
    driver_run_result_id: `drr_${status}`,
    session_id: 'session_evidence_chain',
    status,
    response,
    artifacts: [],
    transcript_ref: {
      artifact_id: 'artifact_transcript',
      type: 'transcript',
      uri: 'artifact://transcript/task_evidence_chain/session_evidence_chain',
      producer_id: 'driver_evidence_chain',
      created_at: '2026-11-15T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    },
    tool_events: [],
    diagnostics: { driver_id: 'driver_evidence_chain', duration_ms: 5, notes: [] },
    created_at: '2026-11-15T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function completedOutcome(dispatches: RoleLoopOutcome['dispatches'] = []): RoleLoopOutcome {
  return {
    status: 'completed',
    finish: {
      status: 'completed',
      summary: 'done',
      evidence_refs: [],
      unresolved: [],
      role_reflection: 'evidence-only dispatch completed',
      response_only: false,
      verification: [],
      accepted_at: '2026-11-15T00:00:00.000Z',
    },
    response: 'done',
    dispatches,
    usage: { input_tokens: 1, output_tokens: 1, usage_missing: false, role_rounds: 1 },
    zero_dispatch: dispatches.length === 0,
    plan: undefined,
    unresolved_dispatches: [],
  };
}

function fakeBudgetPort(
  frozen: RoleBudgetPort['frozen'],
  consumed: RoleBudgetConsumption,
): RoleBudgetPort {
  return {
    frozen,
    snapshot: () => ({
      frozen,
      consumed: { ...consumed },
      wall_clock_remaining_ms: 2_700_000,
    }),
    assertRoundAllowed: () => undefined,
    recordRound: async () => undefined,
    assertDispatchAllowed: () => undefined,
    recordDispatch: () => undefined,
    assertTokenBudget: () => undefined,
  };
}

const finishValidator: RoleFinishValidatorPort = {
  validate: async () => ({ accepted: false, gaps: [] }),
};

interface Harness {
  engine: RoleAutonomyEngine;
  prompts: string[];
  driverCalls: () => number;
}

function makeHarness(input: {
  runsRoot: string;
  runId: string;
  evidenceOnly: boolean;
  workspace: string;
}): Harness {
  const prompts: string[] = [];
  let calls = 0;
  const listeners = new Set<(event: DriverStreamEvent) => void>();
  const driver = {
    driver_id: 'driver_evidence_chain',
    session_id: 'session_evidence_chain',
    capabilities: { supports_session_load: false },
    interrupt: async () => undefined,
    subscribeToEvents: (listener: (event: DriverStreamEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendPrompt: async (prompt: { prompt?: string }) => {
      calls += 1;
      prompts.push(prompt.prompt ?? '');
      return driverResult('succeeded');
    },
  } as unknown as DriverRuntimeHandle;

  const runOnce = async (options: RoleLoopOptions): Promise<RoleLoopOutcome> => {
    const brief = buildExecutionBrief({
      identity: {
        dispatch_id: 'dsp_evidence_chain',
        run_id: input.runId,
        task_id: IDENTITY.task_id,
        role_id: IDENTITY.role_id,
        sequence: 1,
        accepted_at: '2026-11-15T00:00:00.000Z',
      },
      request: { kind: 'execute', instruction: 'write the deliverable file' },
    }).brief;
    const observation = await options.dispatch.run({
      brief,
      brief_sha256: hashExecutionBrief(brief),
      budget_before: {
        dispatches_left: 11,
        role_tokens_left: 120_000,
        deadline_at: '2027-11-15T00:45:00.000Z',
      },
    });
    return completedOutcome([observation]);
  };

  const engine = new RoleAutonomyEngine({
    runs_root: input.runsRoot,
    llm: { completeWithTools: async () => ({ content: null, tool_calls: undefined }) },
    repository: {} as MemoryRepository,
    buffer_repository: {} as BufferRepository,
    driver_for: () => driver,
    create_budget: ({ frozen, consumed }) => fakeBudgetPort(frozen, consumed),
    create_finish_validator: () => finishValidator,
    run_loop: runOnce,
  });
  return { engine, prompts, driverCalls: () => calls };
}

function freezePlan(evidenceOnly: boolean) {
  return {
    limits: {
      max_dispatches: 12,
      max_role_rounds: 40,
      role_token_budget: 120_000,
      wall_clock_seconds: 45 * 60,
      dispatch_timeout_ms: 600_000,
    },
    deadline_at: '2027-11-15T00:45:00.000Z',
    frozen_at: '2026-11-15T00:00:00.000Z',
    max_tool_calls: 64,
    routing: {},
    evidence_only: evidenceOnly,
    buffer_v2: false,
  };
}

async function readFold(runsRoot: string, runId: string) {
  const journal = await RunDispatchJournal.peek({
    runDir: path.join(runsRoot, runId),
    identity: { run_id: runId, ...IDENTITY },
  });
  return journal.fold();
}

describe('evidence-only 真实调用链：不依赖六字段 converter / 报告文件', () => {
  it('冻结 evidence_only=true：converter 调用 0 次、无报告文件要求，引擎照常完成', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      evidenceOnly: true,
      workspace,
    });

    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'write the deliverable file',
      workspace_path: workspace,
      freeze_plan: freezePlan(true),
    });

    // 真实调用链：driver 被调用一次，converter 一次都没有被构造/调用（不是「报告为空」）。
    expect(harness.driverCalls()).toBe(1);
    expect(converterInvocations.created).toBe(0);
    expect(converterInvocations.count).toBe(0);
    expect(result.status).toBe('completed');
    expect(result.response).toBe('done');

    const prompt = harness.prompts[0] ?? '';
    expect(prompt).toContain('write the deliverable file');
    // 六字段报告/报告文件指令都不在 evidence-only prompt 里。
    expect(prompt).not.toContain('<<<DRIVER_RETURN>>>');
    expect(prompt).not.toContain('six fields');
    expect(prompt).not.toContain('_report.txt');
    expect(prompt).not.toContain('report file');
    // 工作区没有（也不需要）报告文件。
    await expect(
      fs.stat(path.join(workspace, `${IDENTITY.task_id}_report.txt`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // 派工事实仍完整落在 Journal（证据来自宿主观察，不来自六字段报告）。
    const fold = await readFold(runsRoot, runId);
    expect(fold.records).toHaveLength(1);
    expect(fold.records[0]).toMatchObject({
      dispatch_id: 'dsp_evidence_chain',
      status: 'succeeded',
    });
    expect(fold.init).toMatchObject({ evidence_only: true, buffer_v2: false });
  });

  it('冻结 evidence_only=false（legacy/Council 兼容）：prompt 含六字段指令、converter 调用 1 次', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      evidenceOnly: false,
      workspace,
    });

    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'write the deliverable file',
      workspace_path: workspace,
      freeze_plan: freezePlan(false),
    });

    expect(result.status).toBe('completed');
    expect(harness.driverCalls()).toBe(1);
    // 旧路径行为不变：六字段转换仍发生一次（converter 恰好构造一次并调用一次）。
    expect(converterInvocations.created).toBe(1);
    expect(converterInvocations.count).toBe(1);
    const prompt = harness.prompts[0] ?? '';
    expect(prompt).toContain('<<<DRIVER_RETURN>>>');
    expect(prompt).toContain('six fields');
  });

  it('evidence-only 派工遇到 driver 失败仍不进入 converter（报告缺失不是失败原因）', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const prompts: string[] = [];
    let calls = 0;
    const driver = {
      driver_id: 'driver_evidence_chain',
      session_id: 'session_evidence_chain',
      capabilities: { supports_session_load: false },
      interrupt: async () => undefined,
      subscribeToEvents: () => () => undefined,
      sendPrompt: async (prompt: { prompt?: string }) => {
        calls += 1;
        prompts.push(prompt.prompt ?? '');
        return driverResult('failed', 'could not write the file');
      },
    } as unknown as DriverRuntimeHandle;
    const engine = new RoleAutonomyEngine({
      runs_root: runsRoot,
      llm: { completeWithTools: async () => ({ content: null, tool_calls: undefined }) },
      repository: {} as MemoryRepository,
      buffer_repository: {} as BufferRepository,
      driver_for: () => driver,
      create_budget: ({ frozen, consumed }) => fakeBudgetPort(frozen, consumed),
      create_finish_validator: () => finishValidator,
      run_loop: async (options: RoleLoopOptions) => {
        const brief = buildExecutionBrief({
          identity: {
            dispatch_id: 'dsp_failed',
            run_id: runId,
            task_id: IDENTITY.task_id,
            role_id: IDENTITY.role_id,
            sequence: 1,
            accepted_at: '2026-11-15T00:00:00.000Z',
          },
          request: { kind: 'execute', instruction: 'write the deliverable file' },
        }).brief;
        const observation = await options.dispatch.run({
          brief,
          brief_sha256: hashExecutionBrief(brief),
          budget_before: {
            dispatches_left: 11,
            role_tokens_left: 120_000,
            deadline_at: '2027-11-15T00:45:00.000Z',
          },
        });
        return completedOutcome([observation]);
      },
    });
    const caught = await engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'write the deliverable file',
        workspace_path: workspace,
        freeze_plan: freezePlan(true),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    // 派工失败是宿主可核验的**证据事实**，不因为「没有六字段报告」而失败或走 converter；
    // 引擎结局由 finish 校验器负责（本夹具不判定），这里只断言调用链不碰六字段路径。
    expect(caught).toBeUndefined();
    expect(calls).toBe(1);
    expect(prompts[0] ?? '').not.toContain('<<<DRIVER_RETURN>>>');
    expect(converterInvocations.created).toBe(0);
    expect(converterInvocations.count).toBe(0);
    const fold = await readFold(runsRoot, runId);
    expect(fold.records[0]).toMatchObject({ dispatch_id: 'dsp_failed', status: 'failed' });
  });
});
