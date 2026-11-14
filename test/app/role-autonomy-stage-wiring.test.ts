/**
 * 阶段 2 stage-executor 选路与 typed termination 边界的集成测试（SEL-01/02/03/04/08 的接线部分）。
 *
 * 用真实 createProductionStageExecutors + fake AgentExecutionFacade：断言
 * - 引擎标记由 stage executor 显式传给 facade（不靠 context_policy 猜测）；
 * - 排除项（council/主动 Council/Mailbox/默认关闭）一律 legacy；
 * - 开关 on 但未装配 → StageTerminationError(host_failed) 且不调用 facade；
 * - app 层 RoleTerminationError 在 stage 边界包装成 coordination 的 StageTerminationError。
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { SCHEMA_VERSION } from '../../src/core';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentExecutionOptions,
  AgentExecutionRequest,
  AgentExecutionResult,
} from '../../src/protocol/agent-execution';
import { createProductionStageExecutors } from '../../src/app/production-stage-executors';
import { RoleAutonomyEngine } from '../../src/app/role-autonomy-engine';
import { RoleBudget } from '../../src/app/role-autonomy-budget';
import { createRoleFinishValidator } from '../../src/app/role-autonomy-finish';
import { RoleTerminationError } from '../../src/app/role-autonomy-contract';
import type { RoleLoopOutcome } from '../../src/app/role-autonomy-contract';
import type {
  BufferRepository,
  MemoryRepository,
} from '../../src/memory';
import { RunDispatchJournal } from '../../src/persistence';
import { StageTerminationError } from '../../src/coordination';
import type { TaskStageExecutionContext } from '../../src/coordination';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function makeRunsRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-stage-wiring-'));
  temporaryDirectories.push(root);
  return root;
}

function completedAgentResult(input: AgentExecutionRequest): AgentExecutionResult {
  return {
    agent_run_id: 'agent_run_1',
    agent_id: input.role_id,
    role_id: input.role_id,
    context_pack_ref: 'context_pack_1',
    driver_run_result_id: 'driver_run_result_1',
    artifact_refs: [],
    transcript_ref: {
      artifact_id: 'artifact_transcript_1',
      type: 'transcript',
      uri: 'file:///tmp/transcript.json',
      producer_id: input.role_id,
      created_at: '2026-11-13T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    },
    session_id: 'session_1',
    response: 'completed',
    tool_events: [],
    diagnostics: { execution_engine: 'role_autonomy' },
    status: 'completed',
    created_at: '2026-11-13T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

interface Harness {
  run(context: TaskStageExecutionContext<'execute_agent'>): Promise<unknown>;
  requests: AgentExecutionRequest[];
  agentOptions: AgentExecutionOptions[];
}

function makeHarness(options: {
  runsRoot: string;
  roleAutonomy?: {
    enabled: boolean;
    wired: boolean;
    budget_overrides?: Record<string, number>;
  };
  runAgent?: (
    input: AgentExecutionRequest,
    options?: AgentExecutionOptions,
  ) => Promise<AgentExecutionResult>;
}): Harness {
  const requests: AgentExecutionRequest[] = [];
  const agentOptions: AgentExecutionOptions[] = [];
  const runAgent =
    options.runAgent ??
    (async (input: AgentExecutionRequest, executionOptions?: AgentExecutionOptions) => {
      requests.push(input);
      agentOptions.push(executionOptions ?? {});
      return completedAgentResult(input);
    });
  const executors = createProductionStageExecutors({
    selectAgentHandler: { execute: async () => ({}) } as never,
    agentExecutionFacade: { runAgent },
    councilProvider: {} as never,
    gateExecutor: {} as never,
    bootstrapAgentIds: [],
    runsRoot: options.runsRoot,
    councilRoot: path.join(options.runsRoot, 'council'),
    worktreesRoot: path.join(options.runsRoot, 'worktrees'),
    ...(options.roleAutonomy ? { roleAutonomy: options.roleAutonomy } : {}),
  });
  return {
    run: (context) => executors.execute_agent.execute(context),
    requests,
    agentOptions,
  };
}

function context(
  runsRoot: string,
  overrides: Partial<TaskStageExecutionContext<'execute_agent'>> & {
    task_request?: {
      spec: string;
      completion_criteria: string[];
      budget?: {
        max_tokens?: number;
        max_wall_clock_seconds?: number;
        max_tool_calls?: number;
      };
    };
    allow_agent_council?: boolean;
    mailbox_delivery_id?: string;
  } = {},
): TaskStageExecutionContext<'execute_agent'> {
  const taskRequest = {
    spec: 'implement the feature',
    completion_criteria: ['tests pass'],
    ...(overrides.task_request ?? {}),
    ...(overrides.allow_agent_council ? { allow_agent_council: true } : {}),
  };
  return {
    task_id: 'task_1',
    run_id: 'run_1',
    mode: 'single_agent',
    task_request: taskRequest,
    workspace_path: path.join(runsRoot, 'workspace-run_1'),
    cursor_input: {
      cursor: 'execute_agent',
      winner_agent_id: 'role_1',
      ...(overrides.mailbox_delivery_id
        ? { mailbox_delivery_id: overrides.mailbox_delivery_id }
        : {}),
    },
    ...overrides,
  };
}

describe('stage executor 引擎选路与 typed termination 边界', () => {
  it('未配置 roleAutonomy：显式 legacy 标记，旧路径行为不变', async () => {
    const runsRoot = await makeRunsRoot();
    const harness = makeHarness({ runsRoot });
    await harness.run(context(runsRoot));
    expect(harness.requests[0]?.execution_engine).toBe('legacy');
  });

  it('显式开关 on + 已装配：全新 single_agent 传 role_autonomy 标记与 completion_criteria', async () => {
    const runsRoot = await makeRunsRoot();
    const harness = makeHarness({
      runsRoot,
      roleAutonomy: { enabled: true, wired: true },
    });
    await harness.run(context(runsRoot));
    expect(harness.requests[0]).toMatchObject({
      execution_engine: 'role_autonomy',
      completion_criteria: ['tests pass'],
    });
  });

  it('completion_criteria 原样传给 engine：宿主不从文本注入检查项/命令/子句义务', async () => {
    const runsRoot = await makeRunsRoot();
    await fs.mkdir(path.join(runsRoot, 'workspace-run_1'), { recursive: true });
    const harness = makeHarness({
      runsRoot,
      roleAutonomy: { enabled: true, wired: true },
    });
    const completionCriteria = [
      'run `pnpm test` and ensure exit code 0',
      'src/fix.ts must contain the fix',
    ];
    await harness.run(
      context(runsRoot, {
        task_request: { spec: 'implement the feature', completion_criteria: completionCriteria },
      }),
    );
    const request = harness.requests[0];
    // 原始文本原样透传，交由 role 做语义判断（finish 的 verification 是唯一完成陈述）。
    expect(request?.completion_criteria).toEqual(completionCriteria);
    // 宿主不把 completion_criteria 解释成检查义务，也不解析命令/子句/目标路径。
    for (const injected of [
      'requires_host_observed_checks',
      'checks',
      'criterion',
      'command',
      'clause',
      'target_paths',
    ]) {
      expect(request).not.toHaveProperty(injected);
    }
  });

  it('排除项：council / 主动 Council / Mailbox 投递回合仍传 legacy', async () => {
    const cases: Array<{
      name: string;
      overrides: Parameters<typeof context>[1];
    }> = [
      { name: 'council', overrides: { mode: 'council' } },
      { name: 'active-council', overrides: { allow_agent_council: true } },
      { name: 'mailbox', overrides: { mailbox_delivery_id: 'delivery_1' } },
    ];
    for (const testCase of cases) {
      const runsRoot = await makeRunsRoot();
      const harness = makeHarness({
        runsRoot,
        roleAutonomy: { enabled: true, wired: true },
      });
      await fs.mkdir(path.join(runsRoot, 'workspace-run_1'), { recursive: true });
      const base = context(runsRoot, testCase.overrides);
      const ctx: TaskStageExecutionContext<'execute_agent'> = {
        ...base,
        run_id: `run_${testCase.name.replace(/[^A-Za-z0-9]/g, '_')}`,
      };
      await harness.run(ctx);
      expect(harness.requests[0]?.execution_engine, testCase.name).toBe('legacy');
    }
  });

  it('开关 on 但未装配：StageTerminationError(host_failed)，不调用 facade', async () => {
    const runsRoot = await makeRunsRoot();
    const harness = makeHarness({
      runsRoot,
      roleAutonomy: { enabled: true, wired: false },
    });
    const error = await harness.run(context(runsRoot)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(StageTerminationError);
    expect((error as StageTerminationError).termination).toMatchObject({
      code: 'host_failed',
      actor: 'host',
    });
    expect(harness.requests).toHaveLength(0);
  });

  it('role 引擎返回的真实产物进入 stage 的 artifact_refs / evidence（selection → manifest 的输入）', async () => {
    const runsRoot = await makeRunsRoot();
    await fs.mkdir(path.join(runsRoot, 'workspace-run_1'), { recursive: true });
    const artifactRef = {
      artifact_id: 'artifact_deliverable_1',
      type: 'patch',
      uri: 'artifact://workspace-file/task_1/src%2Ffix.ts',
      sha256: 'a'.repeat(64),
      producer_id: 'role_1',
      task_id: 'task_1',
      content: {
        kind: 'file' as const,
        content_ref:
          'data:text/plain;charset=utf-8,' + encodeURIComponent('export const fixed = true;'),
        target_path: 'src/fix.ts',
        media_type: 'text/typescript',
      },
      created_at: '2026-11-13T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    };
    const harness = makeHarness({
      runsRoot,
      roleAutonomy: { enabled: true, wired: true },
      runAgent: async (input) => ({
        ...completedAgentResult(input),
        artifact_refs: [artifactRef],
      }),
    });
    const result = (await harness.run(context(runsRoot))) as {
      artifact_refs: string[];
      evidence: { artifact_refs: string[]; changeset_ref: string };
    };
    expect(result.artifact_refs).toContain('artifact_deliverable_1');
    expect(result.evidence.artifact_refs).toContain('artifact_deliverable_1');
    // changeset manifest 的 ref 已生成（后续 gate 阶段据此 buildChangesetManifest）。
    expect(result.evidence.changeset_ref).toContain('changeset-manifest.json');
  });

  it('role 层 RoleTerminationError 在 stage 边界包装为 StageTerminationError（原因码不丢）', async () => {
    const runsRoot = await makeRunsRoot();
    const harness = makeHarness({
      runsRoot,
      roleAutonomy: { enabled: true, wired: true },
      runAgent: async () => {
        throw new RoleTerminationError({
          code: 'budget_rounds',
          actor: 'host',
          message: 'role LLM round budget exhausted',
          details: { round: 40 },
        });
      },
    });
    const error = await harness.run(context(runsRoot)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(StageTerminationError);
    expect((error as StageTerminationError).termination).toMatchObject({
      code: 'budget_rounds',
      actor: 'host',
    });
    expect((error as StageTerminationError).termination.details).toMatchObject({
      round: 40,
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 复审 P1-5：部署预算覆盖从组合根配置进入唯一冻结策略 → Journal init
// ─────────────────────────────────────────────────────────────

describe('组合根预算覆盖 → stage 选路 → engine → Journal', () => {
  function completedRoleOutcome(): RoleLoopOutcome {
    return {
      status: 'completed',
      finish: {
        status: 'completed',
        summary: 'done',
        evidence_refs: [],
        unresolved: [],
        role_reflection: '',
        response_only: false,
        verification: [],
        accepted_at: '2026-11-13T00:00:00.000Z',
      },
      response: 'done',
      dispatches: [],
      usage: { input_tokens: 1, output_tokens: 1, usage_missing: false, role_rounds: 1 },
      zero_dispatch: true,
      plan: undefined,
      unresolved_dispatches: [],
    };
  }

  function makeRoleEngine(
    runsRoot: string,
    budgetInputs: Array<{ max_dispatches: number }> = [],
  ): RoleAutonomyEngine {
    return new RoleAutonomyEngine({
      runs_root: runsRoot,
      llm: { completeWithTools: async () => ({ content: null, tool_calls: undefined }) },
      repository: {} as MemoryRepository,
      buffer_repository: {} as BufferRepository,
      driver_for: () => ({
        driver_id: 'driver_test',
        session_id: 'session_1',
        sendPrompt: async () => {
          throw new Error('no driver call expected');
        },
        interrupt: async () => undefined,
      }) as never,
      create_budget: ({ frozen, consumed, journal }) => {
        budgetInputs.push({ max_dispatches: frozen.limits.max_dispatches });
        return new RoleBudget({ frozen, consumed, journal });
      },
      create_finish_validator: () => createRoleFinishValidator(),
      run_loop: async () => completedRoleOutcome(),
    });
  }

  it('部署覆盖与 TaskBudget 同时存在：取更紧限制并进入 stage 传给 engine 的 freeze_plan', async () => {
    const runsRoot = await makeRunsRoot();
    await fs.mkdir(path.join(runsRoot, 'workspace-run_1'), { recursive: true });
    const harness = makeHarness({
      runsRoot,
      roleAutonomy: {
        enabled: true,
        wired: true,
        budget_overrides: {
          max_dispatches: 1,
          max_role_rounds: 9,
          role_token_budget: 5_000,
          wall_clock_seconds: 60,
          dispatch_timeout_ms: 50,
        },
      },
    });
    await harness.run(
      context(runsRoot, {
        task_request: {
          spec: 'implement the feature',
          completion_criteria: ['pnpm test passes'],
          budget: { max_tokens: 500, max_wall_clock_seconds: 40, max_tool_calls: 5 },
        },
      }),
    );
    expect(harness.agentOptions[0]?.role_autonomy?.freeze_plan).toMatchObject({
      limits: {
        max_dispatches: 1,
        max_role_rounds: 9,
        role_token_budget: 500,
        wall_clock_seconds: 40,
        dispatch_timeout_ms: 50,
      },
      max_tool_calls: 5,
    });
  });

  it('真实 engine 恢复产物进入 stage artifact_refs 与 changeset manifest 输入（交付链路）', async () => {
    const runsRoot = await makeRunsRoot();
    const workspace = path.join(runsRoot, 'workspace-run_1');
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, 'file.txt'), 'after-parent-work', 'utf8');
    // 父 Run 的基线（同一次逻辑执行的初始内容），子 Run 只做恢复、不再派工。
    const parentDir = path.join(runsRoot, 'run_parent');
    await fs.mkdir(path.join(parentDir, 'role-autonomy'), { recursive: true });
    await fs.writeFile(
      path.join(parentDir, 'role-autonomy', 'workspace-before.json'),
      JSON.stringify({
        version: 2,
        workspace_path: workspace,
        entries: [
          [
            'file.txt',
            createHash('sha256').update('before-parent-work').digest('hex'),
          ],
        ],
      }),
      'utf8',
    );
    await fs.mkdir(path.join(runsRoot, 'run_1'), { recursive: true });
    await fs.writeFile(
      path.join(runsRoot, 'run_1', 'request.json'),
      JSON.stringify({ recovery_parent_run_id: 'run_parent' }),
      'utf8',
    );
    // 父 Run 的 Driver 产物索引：恢复后必须原样进入交付输入（损坏会被 fail closed）。
    await fs.writeFile(
      path.join(parentDir, 'role-autonomy', 'artifacts.json'),
      JSON.stringify([
        {
          artifact_id: 'artifact_parent_report',
          type: 'review',
          uri: 'artifact://review/run_parent/report.md',
          sha256: 'b'.repeat(64),
          producer_id: 'driver_parent',
          task_id: 'task_1',
          content: {
            kind: 'file',
            content_ref: 'file:///tmp/report.md',
            target_path: 'report.md',
          },
          created_at: '2026-11-13T00:00:00.000Z',
          schema_version: SCHEMA_VERSION,
        },
      ]),
      'utf8',
    );
    const engine = makeRoleEngine(runsRoot);
    const harness = makeHarness({
      runsRoot,
      roleAutonomy: { enabled: true, wired: true },
      runAgent: async (input, options) =>
        engine.run({
          task_id: input.task_id,
          run_id: input.run_id,
          role_id: input.role_id,
          instruction: input.instruction,
          workspace_path: input.workspace_path,
          ...(options?.role_autonomy?.freeze_plan !== undefined
            ? { freeze_plan: options.role_autonomy.freeze_plan }
            : {}),
        }),
    });
    const result = (await harness.run(context(runsRoot))) as {
      artifact_refs: string[];
      evidence: { artifact_refs: string[]; changeset_ref: string };
    };
    expect(result.artifact_refs.length).toBeGreaterThanOrEqual(2);
    // 恢复前父 Run 的 Driver 报告（被继承的 artifacts.json）仍进入交付链路。
    expect(result.artifact_refs).toContain('artifact_parent_report');
    expect(result.evidence.artifact_refs).toContain('artifact_parent_report');
    // result 额外带 transcript；evidence/manifest 输入是引擎交付产物，二者必有交集。
    expect(
      result.artifact_refs.some((artifactId) => result.evidence.artifact_refs.includes(artifactId)),
    ).toBe(true);
    expect(result.evidence.changeset_ref).toContain('changeset-manifest.json');
  });

  it('真实 engine：部署覆盖 max_dispatches=1 写入 Journal init（不再被默认 12 覆盖）', async () => {
    const runsRoot = await makeRunsRoot();
    await fs.mkdir(path.join(runsRoot, 'workspace-run_1'), { recursive: true });
    const engine = makeRoleEngine(runsRoot);
    const harness = makeHarness({
      runsRoot,
      roleAutonomy: {
        enabled: true,
        wired: true,
        budget_overrides: { max_dispatches: 1 },
      },
      runAgent: async (input, options) =>
        engine.run({
          task_id: input.task_id,
          run_id: input.run_id,
          role_id: input.role_id,
          instruction: input.instruction,
          workspace_path: input.workspace_path,
          ...(options?.role_autonomy?.freeze_plan !== undefined
            ? { freeze_plan: options.role_autonomy.freeze_plan }
            : {}),
        }),
    });
    await harness.run(context(runsRoot));
    const journal = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, 'run_1'),
      identity: { run_id: 'run_1', task_id: 'task_1', role_id: 'role_1' },
    });
    const fold = await journal.fold();
    expect(fold.init).toMatchObject({ max_dispatches: 1, engine: 'role_autonomy' });
  });

  it('已冻结 Run 恢复时不因部署配置变化重置预算', async () => {
    const runsRoot = await makeRunsRoot();
    await fs.mkdir(path.join(runsRoot, 'workspace-run_1'), { recursive: true });
    const firstBudgets: Array<{ max_dispatches: number }> = [];
    const firstEngine = makeRoleEngine(runsRoot, firstBudgets);
    const firstHarness = makeHarness({
      runsRoot,
      roleAutonomy: {
        enabled: true,
        wired: true,
        budget_overrides: { max_dispatches: 1 },
      },
      runAgent: async (input, options) =>
        firstEngine.run({
          task_id: input.task_id,
          run_id: input.run_id,
          role_id: input.role_id,
          instruction: input.instruction,
          workspace_path: input.workspace_path,
          ...(options?.role_autonomy?.freeze_plan !== undefined
            ? { freeze_plan: options.role_autonomy.freeze_plan }
            : {}),
        }),
    });
    await firstHarness.run(context(runsRoot));
    expect(firstBudgets[0]?.max_dispatches).toBe(1);

    // 部署配置后来变宽（5）：已冻结 Run 必须沿用原 Journal 策略（1），不得重置/放宽。
    const secondBudgets: Array<{ max_dispatches: number }> = [];
    const secondEngine = makeRoleEngine(runsRoot, secondBudgets);
    const secondHarness = makeHarness({
      runsRoot,
      roleAutonomy: {
        enabled: true,
        wired: true,
        budget_overrides: { max_dispatches: 5 },
      },
      runAgent: async (input, options) =>
        secondEngine.run({
          task_id: input.task_id,
          run_id: input.run_id,
          role_id: input.role_id,
          instruction: input.instruction,
          workspace_path: input.workspace_path,
          ...(options?.role_autonomy?.freeze_plan !== undefined
            ? { freeze_plan: options.role_autonomy.freeze_plan }
            : {}),
        }),
    });
    await secondHarness.run(context(runsRoot));
    expect(secondBudgets[0]?.max_dispatches).toBe(1);
  });
});
