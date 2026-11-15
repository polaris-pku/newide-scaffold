/**
 * 阶段 2 role 引擎的派工链路集成测试：真实 RunDispatchJournal + 真实 runJournaledDispatch +
 * fake driver。断言一次 dispatch 恰好一次 attempt、写屏障顺序、unknown 不自动重试、
 * evidence 写失败以 typed termination 停止。
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core';
import {
  buildExecutionBrief,
  buildExecutionEvidence,
  DriverTransportError,
  hashExecutionBrief,
  hostObservedCheck,
} from '../../src/driver';
import type {
  DriverRunResult,
  DriverRuntimeHandle,
  DriverStreamEvent,
} from '../../src/driver/contract';
import { CommandDriverTransport } from '../../src/driver/command-driver-transport';
import type { AgentExecutionResult } from '../../src/protocol/agent-execution';
import { createNodeDispatchJournalIo, RunDispatchJournal } from '../../src/persistence';
import {
  hashWorkspaceContent,
  snapshotWorkspaceContent,
  snapshotWorkspaceContentSync,
} from '../../src/coordinator/workspace-change-detector';
import type { BufferRepository, MemoryRepository, ToolCallMessage } from '../../src/memory';
import {
  ROLE_BUDGET_DEFAULTS,
  RoleTerminationError,
  type RoleBudgetConsumption,
  type RoleBudgetPort,
  type RoleDispatchObservation,
  type RoleFinishDecision,
  type RoleFinishGap,
  type RoleFinishValidatorPort,
  type RoleFrozenPolicyPlan,
  type RoleLlmCompletion,
  type RoleLoopOptions,
  type RoleLoopOutcome,
} from '../../src/app/role-autonomy-contract';
import { reconcileLateDriverResult, RoleAutonomyEngine } from '../../src/app/role-autonomy-engine';
import { runRoleExecutionLoop } from '../../src/app/role-execution-loop';
import { createRoleFinishValidator } from '../../src/app/role-autonomy-finish';
import {
  ROLE_DISPATCH_EVENT,
  type RoleLifecycleEvent,
} from '../../src/app/run-dispatch-events';
import { projectDispatchFacts } from '../../src/app/run-dispatch-projection';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const IDENTITY = { task_id: 'task_1', role_id: 'role_1' };

async function makeFixture(): Promise<{ runsRoot: string; runId: string; workspace: string }> {
  const runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-role-dispatch-'));
  temporaryDirectories.push(runsRoot);
  const runId = 'run_1';
  await fs.mkdir(path.join(runsRoot, runId), { recursive: true });
  const workspace = path.join(runsRoot, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'file.txt'), 'before', 'utf8');
  return { runsRoot, runId, workspace };
}

function driverResult(status: DriverRunResult['status'], response = 'done'): DriverRunResult {
  return {
    driver_run_result_id: `drr_${status}`,
    session_id: 'session_1',
    status,
    response,
    artifacts: [],
    transcript_ref: {
      artifact_id: 'artifact_transcript',
      type: 'transcript',
      uri: 'file:///tmp/transcript.json',
      producer_id: 'driver_test',
      created_at: '2026-11-13T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    },
    tool_events: [],
    diagnostics: { driver_id: 'driver_test', duration_ms: 5, notes: [] },
    created_at: '2026-11-13T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
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
      wall_clock_remaining_ms: 1_000,
    }),
    // 与生产 RoleBudget 的同名规则一致：恢复入口只依赖端口，engine 不再重复比较同条件。
    assertRoundAllowed: () => {
      if (consumed.role_rounds >= frozen.limits.max_role_rounds) {
        throw new RoleTerminationError({
          code: 'budget_rounds',
          actor: 'host',
          message: `role LLM round budget exhausted (${consumed.role_rounds}/${frozen.limits.max_role_rounds})`,
        });
      }
    },
    recordRound: async () => undefined,
    assertDispatchAllowed: () => undefined,
    recordDispatch: () => undefined,
    assertTokenBudget: () => undefined,
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
      role_reflection: '',
      response_only: false,
      verification: [],
      accepted_at: '2026-11-13T00:00:00.000Z',
    },
    response: 'done',
    dispatches,
    usage: { input_tokens: 1, output_tokens: 1, usage_missing: false, role_rounds: 1 },
    zero_dispatch: dispatches.length === 0,
    plan: undefined,
    unresolved_dispatches: [],
  };
}

/**
 * driver 命令级观察事件（受支持 Driver 的 `NEWIDE_DRIVER_EVENT` 行）。
 *
 * 受支持 Driver 在**命令结束、交还 agent 之前**对工作区计算 canonical 内容指纹并随事件上报；
 * 宿主会独立重算同一指纹比对（缺失/不一致 → 证据不完整）。helper 在调用时同步取当前内容，
 * 与「命令刚结束」的语义一致。
 */
function commandObservedEvent(
  runId: string,
  command: string,
  workspace: string,
  exitCode = 0,
): DriverStreamEvent {
  return {
    schema_version: 'driver-event.v1',
    event_type: 'driver.command_observed',
    run_id: runId,
    task_id: IDENTITY.task_id,
    payload: {
      command,
      exit_code: exitCode,
      stdout: `${command} output`,
      checked_workspace_sha256: workspaceContentShaSync(workspace),
    },
  };
}

async function workspaceContentSha(workspace: string): Promise<string> {
  return hashWorkspaceContent(await snapshotWorkspaceContent(workspace));
}

function workspaceContentShaSync(workspace: string): string {
  return hashWorkspaceContent(snapshotWorkspaceContentSync(workspace));
}

/** finish 的 verification 陈述夹具：宿主只核验事实，这里指定要引用的真实派工 id。 */
interface VerificationFixture {
  requirement: string;
  outcome?: 'passed' | 'failed' | 'not_run';
  dispatch_ids?: string[];
}

/**
 * 通过**真实 finish validator** 的派工循环：每次派工后调用 `options.finish.validate`，
 * 记录接受/拒绝；拒绝时返回 blocked outcome（引擎据此抛 role_blocked，finish 未落盘）。
 *
 * `verification` 不给 dispatch_ids 时默认引用本轮真实产生的全部派工——`passed` 能否被接受
 * 完全取决于宿主对证据事实的核验，而不是夹具伪造的通过。
 */
function finishProbeLoop(input: {
  dispatchCount?: number;
  verification?: VerificationFixture[];
  afterDispatch?: (options: RoleLoopOptions, observation: RoleDispatchObservation) => Promise<void>;
}): {
  loop: (options: RoleLoopOptions) => Promise<RoleLoopOutcome>;
  decisions: RoleFinishDecision[];
} {
  const decisions: RoleFinishDecision[] = [];
  let sequence = 0;
  const loop = async (options: RoleLoopOptions): Promise<RoleLoopOutcome> => {
    const observations: RoleDispatchObservation[] = [];
    for (let index = 0; index < (input.dispatchCount ?? 1); index += 1) {
      sequence += 1;
      const brief = buildExecutionBrief({
        identity: {
          dispatch_id: `dsp_${sequence}`,
          run_id: options.context.run_id,
          task_id: options.context.task_id,
          role_id: options.context.role_id,
          sequence,
          accepted_at: '2026-11-13T00:00:00.000Z',
        },
        request: { kind: 'execute', instruction: `do work ${sequence}` },
      }).brief;
      const observation = await options.dispatch.run({
        brief,
        brief_sha256: hashExecutionBrief(brief),
        budget_before: {
          dispatches_left: 12 - sequence,
          role_tokens_left: 120_000,
          deadline_at: '2027-11-13T00:45:00.000Z',
        },
      });
      observations.push(observation);
      if (input.afterDispatch !== undefined) await input.afterDispatch(options, observation);
    }
    const claims = (input.verification ?? []).map((claim) => ({
      requirement: claim.requirement,
      outcome: claim.outcome ?? ('passed' as const),
      dispatch_ids:
        claim.dispatch_ids ?? observations.map((observation) => observation.dispatch_id),
      evidence_refs: [],
    }));
    const state = options.context.workspace_fingerprint
      ? await options.context.workspace_fingerprint()
      : undefined;
    const decision = await options.finish.validate({
      request: {
        status: 'completed',
        summary: 'done',
        evidence_refs: [],
        unresolved: [],
        role_reflection: '',
        verification: claims,
      },
      journal: options.journal,
      context: options.context,
      budget: options.budget,
      dispatches: observations,
      cancelled: false,
      ...(state?.sha256 !== undefined ? { current_workspace_sha256: state.sha256 } : {}),
      now: new Date('2026-11-13T12:10:00.000Z'),
    });
    decisions.push(decision);
    if (!decision.accepted) {
      return {
        status: 'blocked',
        finish: {
          status: 'blocked',
          summary: 'finish rejected by host',
          evidence_refs: [],
          unresolved: [],
          role_reflection: '',
          response_only: false,
          verification: [],
          accepted_at: '2026-11-13T00:00:00.000Z',
        },
        response: 'finish rejected by host',
        dispatches: observations,
        usage: { input_tokens: 1, output_tokens: 1, usage_missing: false, role_rounds: 1 },
        zero_dispatch: observations.length === 0,
        plan: undefined,
        unresolved_dispatches: [],
      };
    }
    return completedOutcome(observations);
  };
  return { loop, decisions };
}

// ─────────────────────────────────────────────────────────────
// 真实 loop 的脚本化 LLM 与「对话历史里的事实」提取（新增接线测试共用）
// ─────────────────────────────────────────────────────────────

/**
 * 用真实 `runRoleExecutionLoop` + 脚本化 LLM：每轮拿到真实对话历史（含前一条工具结果），
 * 因此夹具可以引用**宿主真实生成**的 dispatch id，而不是伪造一个 id 让 finish 通过。
 */
function scriptedRoleLoop(
  complete: (input: { round: number; messages: ToolCallMessage[] }) => RoleLlmCompletion,
): (options: RoleLoopOptions) => Promise<RoleLoopOutcome> {
  let round = 0;
  return (options) =>
    runRoleExecutionLoop({
      ...options,
      llm: {
        completeWithTools: async ({ messages }) => {
          round += 1;
          return complete({ round, messages: [...messages] });
        },
      },
    });
}

function toolCallCompletion(
  id: string,
  name: string,
  args: Record<string, unknown>,
): RoleLlmCompletion {
  return {
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

function dispatchCompletion(id: string): RoleLlmCompletion {
  return toolCallCompletion(id, 'dispatch_execution', {
    instruction: 'do the work and run the required check',
    kind: 'execute',
  });
}

function finishCompletion(
  id: string,
  args: {
    status: 'completed' | 'blocked' | 'failed';
    summary: string;
    verification?: VerificationFixture[];
  },
): RoleLlmCompletion {
  const verification = (args.verification ?? []).map((claim) => ({
    requirement: claim.requirement,
    outcome: claim.outcome ?? 'passed',
    dispatch_ids: claim.dispatch_ids ?? [],
  }));
  return toolCallCompletion(id, 'finish_task', {
    status: args.status,
    summary: args.summary,
    verification,
  });
}

/** 从对话历史里取最近一次 dispatch 工具结果中的 dispatch_id（宿主真实产生）。 */
function lastDispatchId(messages: readonly ToolCallMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
    try {
      const parsed = JSON.parse(message.content) as {
        ok?: boolean;
        data?: { dispatch_id?: unknown };
      };
      if (parsed.ok === true && typeof parsed.data?.dispatch_id === 'string') {
        return parsed.data.dispatch_id;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/** 取最近一次被拒 finish 的 gaps（证明拒绝原因是证据事实，不是命令文本比对）。 */
function lastFinishRejection(messages: readonly ToolCallMessage[]): RoleFinishGap[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
    try {
      const parsed = JSON.parse(message.content) as {
        ok?: boolean;
        error?: { code?: string; detail?: { gaps?: unknown } };
      };
      if (parsed.ok !== false || parsed.error?.code !== 'ROLE_FINISH_REJECTED') continue;
      const gaps = parsed.error.detail?.gaps;
      return Array.isArray(gaps) ? (gaps as RoleFinishGap[]) : [];
    } catch {
      continue;
    }
  }
  return [];
}

interface DispatchHarnessInput {
  runsRoot: string;
  runId: string;
  workspace: string;
  /** `emit` 让自定义 sendPrompt 能在执行中途注入 driver 事件（命令观察→修改代码的时序）。 */
  sendPrompt?: (emit: (event: DriverStreamEvent) => void) => Promise<DriverRunResult>;
  /** 每次 sendPrompt 前向订阅者回放的事件（模拟受支持 Driver 的命令级观察）。 */
  events?: DriverStreamEvent[];
  /** 用真实 DriverRuntimeHandle（如包裹真实 CommandDriverTransport）替换 fake driver。 */
  driver?: () => DriverRuntimeHandle;
  journalIo?: ReturnType<typeof createNodeDispatchJournalIo>;
  loop?: (options: RoleLoopOptions) => Promise<RoleLoopOutcome>;
  finishValidator?: () => RoleFinishValidatorPort;
}

interface DispatchHarness {
  engine: RoleAutonomyEngine;
  driverCalls: () => number;
  interruptCalls: () => number;
  budgetInputs: Array<{ frozen: RoleLoopOptions['policy']['budget'] }>;
}

function makeHarness(input: DispatchHarnessInput): DispatchHarness {
  let calls = 0;
  let interrupts = 0;
  const listeners = new Set<(event: DriverStreamEvent) => void>();
  const driver = {
    driver_id: 'driver_test',
    session_id: 'session_1',
    capabilities: { supports_session_load: false },
    interrupt: () => {
      interrupts += 1;
      // 复审复现：真实场景里 interrupt 可能永远不返回；宿主不能等它。
      return new Promise<void>(() => undefined);
    },
    subscribeToEvents: (listener: (event: DriverStreamEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendPrompt: async () => {
      calls += 1;
      const emit = (event: DriverStreamEvent) => {
        for (const listener of [...listeners]) listener(event);
      };
      for (const event of input.events ?? []) emit(event);
      return input.sendPrompt!(emit);
    },
  } as unknown as DriverRuntimeHandle;

  const briefFor = (dispatchId: string, sequence = 1) =>
    buildExecutionBrief({
      identity: {
        dispatch_id: dispatchId,
        run_id: input.runId,
        task_id: IDENTITY.task_id,
        role_id: IDENTITY.role_id,
        sequence,
        accepted_at: '2026-11-13T00:00:00.000Z',
      },
      request: { kind: 'execute', instruction: 'do the work' },
    }).brief;

  const budgetInputs: DispatchHarness['budgetInputs'] = [];
  const engine = new RoleAutonomyEngine({
    runs_root: input.runsRoot,
    llm: { completeWithTools: async () => ({ content: null, tool_calls: undefined }) },
    repository: {} as MemoryRepository,
    buffer_repository: {} as BufferRepository,
    driver_for: () => input.driver?.() ?? driver,
    create_budget: ({ frozen, consumed }) => {
      budgetInputs.push({ frozen });
      return fakeBudgetPort(frozen, consumed);
    },
    create_finish_validator:
      input.finishValidator ?? (() => ({ validate: async () => ({ accepted: false, gaps: [] }) })),
    run_loop:
      input.loop ??
      (async (options: RoleLoopOptions) => {
        const brief = briefFor('dsp_1');
        const observation = await options.dispatch.run({
          brief,
          brief_sha256: hashExecutionBrief(brief),
          budget_before: {
            dispatches_left: 11,
            role_tokens_left: 120_000,
            deadline_at: '2027-11-13T00:45:00.000Z',
          },
        });
        return completedOutcome([observation]);
      }),
    ...(input.journalIo ? { journal_io: input.journalIo } : {}),
  });
  return { engine, driverCalls: () => calls, interruptCalls: () => interrupts, budgetInputs };
}

async function readFold(runsRoot: string, runId: string) {
  const journal = await RunDispatchJournal.peek({
    runDir: path.join(runsRoot, runId),
    identity: { run_id: runId, ...IDENTITY },
  });
  return journal.fold();
}

/** role 真正结束时的唯一 durable 写入点（engine 自己不写 finish，恢复测试按真实路径补写）。 */
async function appendCompletedFinish(runsRoot: string, runId: string): Promise<void> {
  const journal = await RunDispatchJournal.open({
    runDir: path.join(runsRoot, runId),
    identity: { run_id: runId, ...IDENTITY },
  });
  await journal.appendFinish({
    actor: 'role',
    status: 'completed',
    reason: 'done',
    evidence_refs: [],
    summary: 'done',
  });
  await journal.close();
}

/** 轮询等待测试内部条件成立（用于等异步派工真正进入 sendPrompt）。 */
async function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met before timeout');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('role 引擎派工链路（真实 journal + fake driver）', () => {
  it('成功派工：一次 attempt、accepted→dispatched→settled 完整，fold 为 succeeded', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'do the work',
      workspace_path: workspace,
    });
    expect(result.status).toBe('completed');
    expect(harness.driverCalls()).toBe(1);
    const fold = await readFold(runsRoot, runId);
    expect(fold.records).toHaveLength(1);
    expect(fold.records[0]).toMatchObject({ dispatch_id: 'dsp_1', status: 'succeeded' });
    expect(fold.records[0]?.evidence?.status).toBe('succeeded');
  });

  it('driver 抛错（dispatch 后结局不明）：恰好一次 attempt，fold 保留 unknown 事实，不自动重试、不 completed', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => {
        throw new Error('driver disconnected');
      },
    });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'do the work',
        workspace_path: workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(harness.driverCalls()).toBe(1);
    const fold = await readFold(runsRoot, runId);
    // 断连/传输异常不是确定业务失败：ADP 证据化映射为 unknown（保留「收到结果」事实为 false）。
    expect(fold.records[0]).toMatchObject({ dispatch_id: 'dsp_1', status: 'unknown' });
    expect(fold.records[0]?.evidence?.transport.result_received).toBe(false);
    // unknown 未收束时 loop 返回 completed 也被引擎最终闸门拒绝，且不重放。
    expect(error).toBeInstanceOf(RoleTerminationError);
    expect((error as RoleTerminationError).termination.code).toBe('dispatch_unknown_unresolved');
    expect(harness.driverCalls()).toBe(1);
  });

  it.each(['blocked', 'failed'] as const)(
    'unknown 后 Role 可显式 %s 收束，持久化 finish 且不重发 Driver',
    async (status) => {
      const { runsRoot, runId, workspace } = await makeFixture();
      let rounds = 0;
      const harness = makeHarness({
        runsRoot,
        runId,
        workspace,
        sendPrompt: async () => {
          throw new Error('driver disconnected');
        },
        finishValidator: createRoleFinishValidator,
        loop: scriptedRoleLoop(({ round }) => {
          rounds = round;
          if (round === 1) return dispatchCompletion('dispatch');
          if (round === 2)
            return finishCompletion('finish', { status, summary: 'cannot safely continue' });
          throw new Error('explicit non-success finish must stop the loop');
        }),
      });
      await expect(
        harness.engine.run({
          task_id: IDENTITY.task_id,
          run_id: runId,
          role_id: IDENTITY.role_id,
          instruction: 'do the work',
          workspace_path: workspace,
        }),
      ).rejects.toMatchObject({ termination: { code: 'dispatch_unknown_unresolved' } });
      const fold = await readFold(runsRoot, runId);
      expect(rounds).toBe(2);
      expect(harness.driverCalls()).toBe(1);
      expect(fold.records).toHaveLength(1);
      expect(fold.records[0]?.status).toBe('unknown');
      expect(fold.finish).toMatchObject({
        actor: 'role',
        status,
        summary: 'cannot safely continue',
      });
    },
  );

  it('driver 返回确定业务失败（failed 结果）：fold 保留 failed，不重试', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('failed', 'compilation failed'),
    });
    // 业务失败同样交还 role 决策；这里用 blocked 收束验证引擎不把 failed 伪装成成功。
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'do the work',
        workspace_path: workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(harness.driverCalls()).toBe(1);
    const fold = await readFold(runsRoot, runId);
    expect(fold.records[0]).toMatchObject({ dispatch_id: 'dsp_1', status: 'failed' });
    expect(fold.records[0]?.evidence?.error?.code).toBe('DRIVER_FAILED');
    expect(error).toBeUndefined();
  });

  it('driver failed + EXTERNAL_DRIVER_TRANSPORT_ERROR：ADP 映射为 unknown 且保留 result_received=true', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => ({
        ...driverResult('failed', 'transport lost'),
        error: {
          code: 'EXTERNAL_DRIVER_TRANSPORT_ERROR',
          message: 'stream ended after dispatch',
          retryable: false,
        },
      }),
    });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'do the work',
        workspace_path: workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(harness.driverCalls()).toBe(1);
    const fold = await readFold(runsRoot, runId);
    expect(fold.records[0]).toMatchObject({ dispatch_id: 'dsp_1', status: 'unknown' });
    expect(fold.records[0]?.evidence?.transport).toMatchObject({
      evidence: 'execution_unconfirmed',
      result_received: true,
    });
    expect((error as RoleTerminationError).termination.code).toBe('dispatch_unknown_unresolved');
  });

  it('interrupted 且观察到副作用：映射为 unknown，不写成确定取消/成功', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => ({
        ...driverResult('interrupted', 'interrupted mid-flight'),
        tool_events: [
          {
            tool_event_id: 'tool_1',
            tool_name: 'write_file',
            status: 'completed',
            summary: 'wrote src/fix.ts',
            created_at: '2026-11-13T00:00:00.000Z',
            schema_version: SCHEMA_VERSION,
          },
        ],
      }),
    });
    await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'do the work',
        workspace_path: workspace,
      })
      .catch(() => undefined);
    const fold = await readFold(runsRoot, runId);
    expect(fold.records[0]?.status).toBe('unknown');
    expect(fold.records[0]?.evidence?.transport.result_received).toBe(true);
  });

  it('启动失败（明确未执行）：failed + result_received=false + not_executed', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => {
        throw new DriverTransportError('spawn failed', 'not_executed');
      },
    });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'do the work',
        workspace_path: workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(harness.driverCalls()).toBe(1);
    const fold = await readFold(runsRoot, runId);
    expect(fold.records[0]?.status).toBe('failed');
    expect(fold.records[0]?.evidence?.transport).toMatchObject({
      evidence: 'not_executed',
      result_received: false,
    });
    // 明确未执行是 failed 收束（不是 unknown），引擎最终闸门不拦；但 fake loop 直接 completed。
    expect(error).toBeUndefined();
  });

  it('受支持 Driver 的命令级观察 → evidence.checks 为 host_observed（含可信退出码/原始输出/被检查内容指纹）', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      events: [
        {
          schema_version: 'driver-event.v1',
          event_type: 'driver.command_observed',
          run_id: runId,
          task_id: IDENTITY.task_id,
          payload: {
            command: 'pnpm test',
            exit_code: 0,
            stdout: 'all tests passed',
            checked_workspace_sha256: workspaceContentShaSync(workspace),
          },
        },
      ],
      sendPrompt: async () => driverResult('succeeded'),
    });
    await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'do the work',
      workspace_path: workspace,
    });
    const fold = await readFold(runsRoot, runId);
    const checks = fold.records[0]?.evidence?.checks ?? [];
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      command: 'pnpm test',
      exit_code: 0,
      provenance: 'host_observed',
      observation: 'complete',
    });
    expect(checks[0]?.workspace_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(checks[0]?.stdout_ref?.path).toContain('role-autonomy/observations');
    // 原始输出可经受控 evidence 读取面验证 hash 后读回。
    const journal = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    const page = await journal.readEvidence(checks[0]!.stdout_ref!);
    expect(page.text).toContain('all tests passed');
  });

  it('多次修改同一文件：交付最终内容（工作区产物优先于 Driver diff）', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
      loop: async (options) => {
        for (const [sequence, content] of [
          [1, 'version-1'],
          [2, 'version-2'],
        ] as const) {
          const brief = buildExecutionBrief({
            identity: {
              dispatch_id: `dsp_${sequence}`,
              run_id: runId,
              task_id: IDENTITY.task_id,
              role_id: IDENTITY.role_id,
              sequence,
              accepted_at: '2026-11-13T00:00:00.000Z',
            },
            request: { kind: 'execute', instruction: `write ${content}` },
          }).brief;
          await fs.writeFile(path.join(workspace, 'file.txt'), content, 'utf8');
          await options.dispatch.run({
            brief,
            brief_sha256: hashExecutionBrief(brief),
            budget_before: {
              dispatches_left: 10 - sequence,
              role_tokens_left: 100_000,
              deadline_at: '2027-11-13T00:45:00.000Z',
            },
          });
        }
        return completedOutcome();
      },
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'do the work',
      workspace_path: workspace,
    });
    expect(result.artifact_refs).toHaveLength(1);
    const artifact = result.artifact_refs[0]!;
    expect(artifact.content?.target_path).toBe('file.txt');
    const target = artifact.content?.content_ref;
    expect(target).toBeDefined();
    const finalBytes = await fs.readFile(new URL(target!), 'utf8');
    expect(finalBytes).toBe('version-2');
  });

  it('迟到结果对账：只追加 reconciled，不覆盖已 settle 的 unknown，不重跑 driver', async () => {
    const { runsRoot, runId } = await makeFixture();
    const journal = await RunDispatchJournal.open({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    const brief = buildExecutionBrief({
      identity: {
        dispatch_id: 'dsp_late',
        run_id: runId,
        task_id: IDENTITY.task_id,
        role_id: IDENTITY.role_id,
        sequence: 1,
        accepted_at: '2026-11-13T00:00:00.000Z',
      },
      request: { kind: 'execute', instruction: 'do the work' },
    }).brief;
    await journal.appendAccepted({
      brief,
      brief_sha256: hashExecutionBrief(brief),
      budget_before: {
        dispatches_left: 11,
        role_tokens_left: 120_000,
        deadline_at: '2027-11-13T00:45:00.000Z',
      },
    });
    await journal.appendDispatched({ dispatch_id: 'dsp_late' });
    const unknownEvidence = buildExecutionEvidence({
      dispatch_id: 'dsp_late',
      observation: {
        transport: { evidence: 'execution_unconfirmed' },
      },
    });
    await journal.appendSettled({
      dispatch_id: 'dsp_late',
      status: unknownEvidence.status,
      evidence: unknownEvidence,
      evidence_sha256: (
        await journal.appendEvidence({
          dispatch_id: 'dsp_late',
          evidence: unknownEvidence,
        })
      ).sha256,
      violations: [],
    });

    await reconcileLateDriverResult(journal, 'dsp_late', driverResult('succeeded', 'late ok'));
    const record = await journal.getDispatchRecord('dsp_late');
    expect(record?.status).toBe('unknown');
    expect(record?.reconciled).toMatchObject({ status: 'succeeded' });
    // 第二次不同可信状态是冲突 → 不覆盖（appendReconciled 抛错，helper 不吞阶段 1 校验）。
    await expect(
      journal.appendReconciled({
        dispatch_id: 'dsp_late',
        status: 'failed',
        reason: 'conflicting trusted result',
      }),
    ).rejects.toBeTruthy();
    await journal.close();
  });

  it('损坏 Journal：fail closed，不退回 legacy、不调用 loop', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    await fs.mkdir(path.join(runsRoot, runId, 'journal'), { recursive: true });
    await fs.writeFile(
      path.join(runsRoot, runId, 'journal', 'dispatches.jsonl'),
      '{}\n{}\n',
      'utf8',
    );
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
    });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'do the work',
        workspace_path: workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(RoleTerminationError);
    expect((error as RoleTerminationError).termination.code).toBe('journal_corrupt');
  });

  it('恢复摘要：当前/祖先 Run 的既有派工事实可见且带受控 evidence ref，不重复执行', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const ancestorId = 'run_ancestor';
    const ancestorDir = path.join(runsRoot, ancestorId);
    await fs.mkdir(ancestorDir, { recursive: true });
    const ancestor = await RunDispatchJournal.open({
      runDir: ancestorDir,
      identity: { run_id: ancestorId, ...IDENTITY },
    });
    await ancestor.appendInit({
      autonomy: true,
      evidence_only: false,
      buffer_v2: false,
      max_dispatches: 12,
      max_role_rounds: 40,
      role_token_budget: 120_000,
      deadline_at: '2027-11-13T00:45:00.000Z',
      engine: 'role_autonomy',
      engine_version: 'role-autonomy-v1',
      tool_allowlist: ['dispatch_execution', 'finish_task'],
      dispatch_timeout_ms: 600_000,
    });
    const brief = buildExecutionBrief({
      identity: {
        dispatch_id: 'dsp_ancestor',
        run_id: ancestorId,
        task_id: IDENTITY.task_id,
        role_id: IDENTITY.role_id,
        sequence: 1,
        accepted_at: '2026-11-13T00:00:00.000Z',
      },
      request: { kind: 'execute', instruction: 'ancestor work' },
    }).brief;
    await ancestor.appendAccepted({
      brief,
      brief_sha256: hashExecutionBrief(brief),
      budget_before: {
        dispatches_left: 12,
        role_tokens_left: 120_000,
        deadline_at: '2027-11-13T00:45:00.000Z',
      },
    });
    await ancestor.appendDispatched({ dispatch_id: 'dsp_ancestor' });
    const evidence = buildExecutionEvidence({
      dispatch_id: 'dsp_ancestor',
      observation: {
        transport: { evidence: 'execution_unconfirmed' },
        result: { status: 'succeeded', response: 'ancestor done' },
      },
    });
    const artifact = await ancestor.appendEvidence({
      dispatch_id: 'dsp_ancestor',
      evidence,
    });
    await ancestor.appendSettled({
      dispatch_id: 'dsp_ancestor',
      status: 'succeeded',
      evidence,
      evidence_sha256: artifact.sha256,
      violations: [],
    });
    await ancestor.close();
    await fs.writeFile(
      path.join(runsRoot, runId, 'request.json'),
      JSON.stringify({ recovery_parent_run_id: ancestorId }),
      'utf8',
    );

    let summary = '';
    let recoveredCount = 0;
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
      loop: async (options) => {
        summary = options.context.recovery_summary ?? '';
        recoveredCount = options.context.recovered_dispatch_count ?? 0;
        return completedOutcome();
      },
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'continue the task',
      restarted_from_run_id: ancestorId,
    });
    expect(result.status).toBe('completed');
    expect(summary).toContain('ancestor run run_ancestor');
    expect(summary).toContain('dsp_ancestor');
    expect(summary).toContain('journal/evidence/dsp_ancestor.json');
    expect(summary).toContain('"sha256"');
    expect(recoveredCount).toBe(1);
    expect(harness.driverCalls()).toBe(0);
  });

  it('TaskBudget 进入唯一冻结策略：max_tokens/max_wall_clock_seconds/max_tool_calls 只能收紧', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
    });
    await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'do the work',
      workspace_path: workspace,
      task_budget: { max_tokens: 1, max_wall_clock_seconds: 2, max_tool_calls: 1 },
    });
    const journal = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    const init = (await journal.read()).controls.find((entry) => entry.event === 'init');
    expect(init).toMatchObject({
      event: 'init',
      role_token_budget: 1,
      max_tool_calls: 1,
    });
    if (init?.event === 'init') {
      const frozenSeconds = (Date.parse(init.deadline_at) - Date.parse(init.at)) / 1_000;
      expect(frozenSeconds).toBe(2);
    }
    expect(harness.budgetInputs[0]?.frozen.limits).toMatchObject({
      role_token_budget: 1,
      wall_clock_seconds: 2,
    });
    expect(harness.budgetInputs[0]?.frozen.max_tool_calls).toBe(1);
  });

  it('恢复时额度已耗尽：不调用 loop/LLM（不先跑一轮才发现）', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const journal = await RunDispatchJournal.open({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    await journal.appendInit({
      autonomy: true,
      evidence_only: false,
      buffer_v2: false,
      max_dispatches: 12,
      max_role_rounds: 1,
      role_token_budget: 120_000,
      deadline_at: '2027-11-13T00:45:00.000Z',
      engine: 'role_autonomy',
      engine_version: 'role-autonomy-v1',
      tool_allowlist: ['dispatch_execution', 'finish_task'],
      dispatch_timeout_ms: 600_000,
    });
    await journal.appendRoleRound({
      round: 1,
      usage_missing: true,
      at: '2026-11-13T00:00:00.000Z',
    });
    await journal.close();

    let loopCalls = 0;
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
      loop: async () => {
        loopCalls += 1;
        return completedOutcome();
      },
    });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'do the work',
        workspace_path: workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(RoleTerminationError);
    expect((error as RoleTerminationError).termination.code).toBe('budget_rounds');
    expect(loopCalls).toBe(0);
  });

  it('真实 engine + 真实 loop/finish：verification passed 引用真实派工与可信检查后 completed（host_observed 生效）', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      events: [
        {
          schema_version: 'driver-event.v1',
          event_type: 'driver.command_observed',
          run_id: runId,
          task_id: IDENTITY.task_id,
          payload: {
            command: 'pnpm test',
            exit_code: 0,
            stdout: 'ok',
            checked_workspace_sha256: workspaceContentShaSync(workspace),
          },
        },
      ],
      sendPrompt: async () => driverResult('succeeded'),
      finishValidator: () => createRoleFinishValidator(),
      loop: scriptedRoleLoop(({ round, messages }) => {
        if (round === 1) return dispatchCompletion('call_dispatch_1');
        const dispatchId = lastDispatchId(messages);
        expect(dispatchId).toBeDefined();
        return finishCompletion('call_finish_1', {
          status: 'completed',
          summary: 'fixed and verified',
          verification: [{ requirement: 'pnpm test passes', dispatch_ids: [dispatchId!] }],
        });
      }),
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'fix the failing test and run it',
      workspace_path: workspace,
    });
    expect(result.status).toBe('completed');
    expect(result.response).toBe('fixed and verified');
    const fold = await readFold(runsRoot, runId);
    const dispatchId = fold.records[0]!.dispatch_id;
    expect(fold.finish?.status).toBe('completed');
    expect(fold.finish?.verification).toEqual([
      {
        requirement: 'pnpm test passes',
        outcome: 'passed',
        dispatch_ids: [dispatchId],
        evidence_refs: [],
      },
    ]);
    expect(fold.records[0]?.evidence?.checks?.[0]).toMatchObject({
      provenance: 'host_observed',
      observation: 'complete',
      exit_code: 0,
    });
  });

  it('跨 Run 显式重试：reconciliation_ref 必须通过祖先 Journal 受控读取校验，可信重试可收束祖先 unknown', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const ancestorId = 'run_retry_ancestor';
    const ancestorDir = path.join(runsRoot, ancestorId);
    await fs.mkdir(ancestorDir, { recursive: true });
    const ancestor = await RunDispatchJournal.open({
      runDir: ancestorDir,
      identity: { run_id: ancestorId, ...IDENTITY },
    });
    await ancestor.appendInit({
      autonomy: true,
      evidence_only: false,
      buffer_v2: false,
      max_dispatches: 12,
      max_role_rounds: 40,
      role_token_budget: 120_000,
      deadline_at: '2027-11-13T00:45:00.000Z',
      engine: 'role_autonomy',
      engine_version: 'role-autonomy-v1',
      tool_allowlist: ['dispatch_execution', 'finish_task'],
      dispatch_timeout_ms: 600_000,
    });
    const ancestorBrief = buildExecutionBrief({
      identity: {
        dispatch_id: 'dsp_unknown_ancestor',
        run_id: ancestorId,
        task_id: IDENTITY.task_id,
        role_id: IDENTITY.role_id,
        sequence: 1,
        accepted_at: '2026-11-13T00:00:00.000Z',
      },
      request: { kind: 'execute', instruction: 'ancestor attempt' },
    }).brief;
    await ancestor.appendAccepted({
      brief: ancestorBrief,
      brief_sha256: hashExecutionBrief(ancestorBrief),
      budget_before: {
        dispatches_left: 12,
        role_tokens_left: 120_000,
        deadline_at: '2027-11-13T00:45:00.000Z',
      },
    });
    await ancestor.appendDispatched({ dispatch_id: 'dsp_unknown_ancestor' });
    const observationFile = path.join(ancestorDir, 'journal', 'observations', 'ancestor.txt');
    await fs.mkdir(path.dirname(observationFile), { recursive: true });
    await fs.writeFile(observationFile, 'ancestor investigation output', 'utf8');
    const bytes = await fs.readFile(observationFile);
    const investigationRef = {
      path: 'journal/observations/ancestor.txt',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const unknownEvidence = buildExecutionEvidence({
      dispatch_id: 'dsp_unknown_ancestor',
      observation: {
        transport: { evidence: 'execution_unconfirmed' },
        checks: [
          hostObservedCheck({
            command: 'git status',
            exit_code: 0,
            stdout_ref: investigationRef,
          }),
        ],
      },
    });
    const unknownSidecar = await ancestor.appendEvidence({
      dispatch_id: 'dsp_unknown_ancestor',
      evidence: unknownEvidence,
    });
    await ancestor.appendSettled({
      dispatch_id: 'dsp_unknown_ancestor',
      status: 'unknown',
      evidence: unknownEvidence,
      evidence_sha256: unknownSidecar.sha256,
      violations: [],
    });
    // 同一次逻辑执行的基线与产物索引属于祖先 Run：恢复链必须能继承/核验它们
    // （缺失时新引擎会显式 fail closed，不允许静默把已修改状态当初始基线）。
    await fs.mkdir(path.join(ancestorDir, 'role-autonomy'), { recursive: true });
    await fs.writeFile(
      path.join(ancestorDir, 'role-autonomy', 'workspace-before.json'),
      JSON.stringify({
        version: 2,
        workspace_path: path.resolve(workspace),
        entries: [
          [
            'file.txt',
            createHash('sha256')
              .update(await fs.readFile(path.join(workspace, 'file.txt')))
              .digest('hex'),
          ],
        ],
      }),
      'utf8',
    );
    await ancestor.close();
    await fs.writeFile(
      path.join(runsRoot, runId, 'request.json'),
      JSON.stringify({ recovery_parent_run_id: ancestorId }),
      'utf8',
    );

    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
      loop: async (options) => {
        const brief = buildExecutionBrief({
          identity: {
            dispatch_id: 'dsp_retry_1',
            run_id: runId,
            task_id: IDENTITY.task_id,
            role_id: IDENTITY.role_id,
            sequence: 1,
            accepted_at: '2026-11-13T00:00:00.000Z',
          },
          request: {
            kind: 'execute',
            instruction: 'retry the ancestor attempt',
            retry_of: 'dsp_unknown_ancestor',
            reconciliation_ref: investigationRef,
          },
        }).brief;
        await options.dispatch.run({
          brief,
          brief_sha256: hashExecutionBrief(brief),
          budget_before: {
            dispatches_left: 11,
            role_tokens_left: 120_000,
            deadline_at: '2027-11-13T00:45:00.000Z',
          },
        });
        return completedOutcome();
      },
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'continue and retry',
      workspace_path: workspace,
      restarted_from_run_id: ancestorId,
    });
    expect(result.status).toBe('completed');
    const fold = await readFold(runsRoot, runId);
    expect(fold.records[0]?.brief.retry_of).toBe('dsp_unknown_ancestor');
  });

  it('evidence 写失败：typed termination(evidence_write_failed)，不继续成功返回', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const base = createNodeDispatchJournalIo();
    const failing = {
      ...base,
      async writeFileExclusive(filePath: string, data: Uint8Array) {
        if (filePath.includes(`${path.sep}evidence${path.sep}`)) {
          const error = new Error('injected evidence write failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return base.writeFileExclusive(filePath, data);
      },
    };
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
      journalIo: failing,
    });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'do the work',
        workspace_path: workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(RoleTerminationError);
    expect((error as RoleTerminationError).termination.code).toBe('evidence_write_failed');
    expect(harness.driverCalls()).toBe(1);
  });

  it('settled 写失败：typed termination(journal_write_failed) 并保留屏障诊断', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const base = createNodeDispatchJournalIo();
    let settledAttempts = 0;
    const failing = {
      ...base,
      async appendLineWithFsync(filePath: string, line: string) {
        let event: unknown;
        try {
          event = line.length > 0 ? (JSON.parse(line) as { event?: unknown }).event : undefined;
        } catch {
          event = undefined;
        }
        if (event === 'settled') {
          settledAttempts += 1;
          const error = new Error('injected settled write failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return base.appendLineWithFsync(filePath, line);
      },
    };
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
      journalIo: failing,
    });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'do the work',
        workspace_path: workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(RoleTerminationError);
    expect((error as RoleTerminationError).termination).toMatchObject({
      code: 'journal_write_failed',
      actor: 'host',
      details: {
        stage: 'settled',
        driver_invoked: true,
        side_effect_state: 'unknown',
        barrier_code: 'settled_write_failed',
      },
    });
    expect(settledAttempts).toBe(1);
    expect(harness.driverCalls()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 复审 P1-1：检查证据必须绑定到实际被检查的交付版本
// ─────────────────────────────────────────────────────────────

describe('检查证据与交付版本绑定（真实 engine + 真实 loop/finish + 真实 journal）', () => {
  const VERIFICATION: VerificationFixture[] = [{ requirement: 'pnpm test passes' }];

  it('检查成功 → 修改代码 → finish 被拒绝（旧证据不能证明最终版本）', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const { loop, decisions } = finishProbeLoop({ verification: VERIFICATION });
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      finishValidator: () => createRoleFinishValidator(),
      loop,
      sendPrompt: async (emit) => {
        emit(commandObservedEvent(runId, 'pnpm test', workspace));
        // 事件之后又修改代码：检查指纹是修改前的版本。
        await fs.writeFile(path.join(workspace, 'file.txt'), 'after-check', 'utf8');
        return driverResult('succeeded');
      },
    });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'do the work',
        workspace_path: workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.accepted).toBe(false);
    expect((decisions[0]?.gaps ?? []).map((gap) => gap.code)).toContain('evidence_stale');
    expect((error as RoleTerminationError).termination.code).toBe('role_blocked');
    const fold = await readFold(runsRoot, runId);
    expect(fold.finish).toBeUndefined();
  });

  it('修改代码 → 检查成功 → 无后续修改 → finish 可接受', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const { loop, decisions } = finishProbeLoop({ verification: VERIFICATION });
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      finishValidator: () => createRoleFinishValidator(),
      loop,
      sendPrompt: async (emit) => {
        await fs.writeFile(path.join(workspace, 'file.txt'), 'final-version', 'utf8');
        emit(commandObservedEvent(runId, 'pnpm test', workspace));
        return driverResult('succeeded');
      },
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'do the work',
      workspace_path: workspace,
    });
    expect(decisions[0]?.accepted).toBe(true);
    expect(result.status).toBe('completed');
  });

  it('跨 dispatch：验证成功 → 再修改 → 拒绝旧证据', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const { loop, decisions } = finishProbeLoop({
      dispatchCount: 2,
      verification: VERIFICATION,
    });
    let calls = 0;
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      finishValidator: () => createRoleFinishValidator(),
      loop,
      sendPrompt: async (emit) => {
        calls += 1;
        if (calls === 1) {
          await fs.writeFile(path.join(workspace, 'file.txt'), 'v1', 'utf8');
          emit(commandObservedEvent(runId, 'pnpm test', workspace));
        } else {
          await fs.writeFile(path.join(workspace, 'file.txt'), 'v2', 'utf8');
        }
        return driverResult('succeeded');
      },
    });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'do the work',
        workspace_path: workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(decisions[0]?.accepted).toBe(false);
    expect((decisions[0]?.gaps ?? []).map((gap) => gap.code)).toContain('evidence_stale');
    expect((error as RoleTerminationError).termination.code).toBe('role_blocked');
  });

  it('修改后重新验证成功 → 允许完成', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const { loop, decisions } = finishProbeLoop({
      dispatchCount: 2,
      verification: VERIFICATION,
    });
    let calls = 0;
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      finishValidator: () => createRoleFinishValidator(),
      loop,
      sendPrompt: async (emit) => {
        calls += 1;
        if (calls === 1) {
          await fs.writeFile(path.join(workspace, 'file.txt'), 'v1', 'utf8');
          emit(commandObservedEvent(runId, 'pnpm test', workspace));
        } else {
          await fs.writeFile(path.join(workspace, 'file.txt'), 'v2', 'utf8');
          emit(commandObservedEvent(runId, 'pnpm test', workspace));
        }
        return driverResult('succeeded');
      },
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'do the work',
      workspace_path: workspace,
    });
    expect(decisions[0]?.accepted).toBe(true);
    expect(result.status).toBe('completed');
  });
});

// ─────────────────────────────────────────────────────────────
// 复审 P1-3/P1-4：恢复链的祖先违规与交付产物
// ─────────────────────────────────────────────────────────────

describe('恢复链：祖先违规与交付产物继承（真实 journal + 基线）', () => {
  async function writeBaseline(runDir: string, workspace: string): Promise<void> {
    const content = await snapshotWorkspaceContent(workspace);
    await fs.mkdir(path.join(runDir, 'role-autonomy'), { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'role-autonomy', 'workspace-before.json'),
      JSON.stringify({
        version: 2,
        workspace_path: path.resolve(workspace),
        entries: [...content.entries()],
      }),
      'utf8',
    );
  }

  async function seedAncestor(input: {
    runsRoot: string;
    ancestorId: string;
    workspace: string;
    violations?: Array<'read_only_changed'>;
    checks?: Array<{
      command: string;
      exit_code: number;
      workspace_sha256?: string;
    }>;
  }): Promise<void> {
    const ancestorDir = path.join(input.runsRoot, input.ancestorId);
    await fs.mkdir(ancestorDir, { recursive: true });
    const journal = await RunDispatchJournal.open({
      runDir: ancestorDir,
      identity: { run_id: input.ancestorId, ...IDENTITY },
    });
    try {
      const brief = buildExecutionBrief({
        identity: {
          dispatch_id: 'dsp_ancestor',
          run_id: input.ancestorId,
          task_id: IDENTITY.task_id,
          role_id: IDENTITY.role_id,
          sequence: 1,
          accepted_at: '2026-11-13T00:00:00.000Z',
        },
        request: { kind: 'investigate', instruction: 'ancestor work' },
      }).brief;
      await journal.appendAccepted({
        brief,
        brief_sha256: hashExecutionBrief(brief),
        budget_before: {
          dispatches_left: 12,
          role_tokens_left: 120_000,
          deadline_at: '2027-11-13T00:45:00.000Z',
        },
      });
      await journal.appendDispatched({ dispatch_id: 'dsp_ancestor' });
      const evidence = buildExecutionEvidence({
        dispatch_id: 'dsp_ancestor',
        observation: {
          transport: { evidence: 'execution_unconfirmed' },
          result: { status: 'succeeded' as const, response: 'ok' },
          ...(input.checks !== undefined
            ? {
                checks: input.checks.map((check) =>
                  hostObservedCheck({
                    command: check.command,
                    exit_code: check.exit_code,
                    ...(check.workspace_sha256 !== undefined
                      ? { workspace_sha256: check.workspace_sha256 }
                      : {}),
                  }),
                ),
              }
            : {}),
        },
      });
      const sidecar = await journal.appendEvidence({
        dispatch_id: 'dsp_ancestor',
        evidence,
      });
      await journal.appendSettled({
        dispatch_id: 'dsp_ancestor',
        status: 'succeeded',
        evidence,
        evidence_sha256: sidecar.sha256,
        violations: input.violations ?? [],
      });
    } finally {
      await journal.close();
    }
    await writeBaseline(ancestorDir, input.workspace);
  }

  async function linkParent(runId: string, runsRoot: string, parentId: string): Promise<void> {
    await fs.mkdir(path.join(runsRoot, runId), { recursive: true });
    await fs.writeFile(
      path.join(runsRoot, runId, 'request.json'),
      JSON.stringify({ recovery_parent_run_id: parentId }),
      'utf8',
    );
  }

  function zeroDispatchLoop(): (options: RoleLoopOptions) => Promise<RoleLoopOutcome> {
    return finishProbeLoop({ dispatchCount: 0, verification: [] }).loop;
  }

  it('父 Run 已记录只读违规 → 子 Run completed 被拒绝', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    await seedAncestor({
      runsRoot,
      ancestorId: 'run_parent',
      workspace,
      violations: ['read_only_changed'],
    });
    await linkParent(runId, runsRoot, 'run_parent');
    const probe = finishProbeLoop({ dispatchCount: 0 });
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      loop: probe.loop,
      finishValidator: () => createRoleFinishValidator(),
      sendPrompt: async () => driverResult('succeeded'),
    });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'recover and finish',
        workspace_path: workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(probe.decisions[0]?.accepted).toBe(false);
    expect((probe.decisions[0]?.gaps ?? []).map((gap) => gap.code)).toContain(
      'read_only_violation',
    );
    expect((error as RoleTerminationError).termination.code).toBe('role_blocked');
  });

  it('多级恢复链上的祖先只读违规同样不能绕过', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    await seedAncestor({
      runsRoot,
      ancestorId: 'run_grandparent',
      workspace,
      violations: ['read_only_changed'],
    });
    await seedAncestor({ runsRoot, ancestorId: 'run_parent', workspace });
    await linkParent('run_parent', runsRoot, 'run_grandparent');
    await linkParent(runId, runsRoot, 'run_parent');
    const probe = finishProbeLoop({ dispatchCount: 0 });
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      loop: probe.loop,
      finishValidator: () => createRoleFinishValidator(),
      sendPrompt: async () => driverResult('succeeded'),
    });
    await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'recover and finish',
        workspace_path: workspace,
      })
      .catch(() => undefined);
    expect(probe.decisions[0]?.accepted).toBe(false);
    expect((probe.decisions[0]?.gaps ?? []).map((gap) => gap.code)).toContain(
      'read_only_violation',
    );
  });

  it('无违规的合法恢复仍可完成；祖先有效检查可按适用性规则使用', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const sha = await workspaceContentSha(workspace);
    await seedAncestor({
      runsRoot,
      ancestorId: 'run_parent',
      workspace,
      checks: [
        {
          command: 'pnpm test',
          exit_code: 0,
          workspace_sha256: sha,
        },
      ],
    });
    await linkParent(runId, runsRoot, 'run_parent');
    const probe = finishProbeLoop({
      dispatchCount: 0,
      verification: [{ requirement: 'pnpm test passes', dispatch_ids: ['dsp_ancestor'] }],
    });
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      loop: probe.loop,
      finishValidator: () => createRoleFinishValidator(),
      sendPrompt: async () => driverResult('succeeded'),
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'recover and finish',
      workspace_path: workspace,
    });
    expect(probe.decisions[0]?.accepted).toBe(true);
    expect(result.status).toBe('completed');
  });

  it('settled 后中断 → 新 Run 恢复且不再派工 → 原修改进入交付产物（内容为最终版本）', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const parentId = 'run_parent';
    // 父 Run：真实 engine 派工把 file.txt 改成 v1，然后以 blocked 收束（模拟中断，无 finish）。
    const parentHarness = makeHarness({
      runsRoot,
      runId: parentId,
      workspace,
      sendPrompt: async () => {
        await fs.writeFile(path.join(workspace, 'file.txt'), 'v1', 'utf8');
        return driverResult('succeeded');
      },
      loop: async (options) => {
        const brief = buildExecutionBrief({
          identity: {
            dispatch_id: 'dsp_parent',
            run_id: parentId,
            task_id: IDENTITY.task_id,
            role_id: IDENTITY.role_id,
            sequence: 1,
            accepted_at: '2026-11-13T00:00:00.000Z',
          },
          request: { kind: 'execute', instruction: 'write v1' },
        }).brief;
        await options.dispatch.run({
          brief,
          brief_sha256: hashExecutionBrief(brief),
          budget_before: {
            dispatches_left: 11,
            role_tokens_left: 120_000,
            deadline_at: '2027-11-13T00:45:00.000Z',
          },
        });
        return {
          ...completedOutcome([]),
          status: 'blocked',
          finish: {
            ...completedOutcome([]).finish,
            status: 'blocked',
            summary: 'interrupted after settled',
          },
        };
      },
    });
    await parentHarness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: parentId,
        role_id: IDENTITY.role_id,
        instruction: 'write v1',
        workspace_path: workspace,
      })
      .catch(() => undefined);
    await linkParent(runId, runsRoot, parentId);

    const childHarness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
      loop: zeroDispatchLoop(),
      finishValidator: () => createRoleFinishValidator(),
    });
    const result = await childHarness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'recover and finish without dispatch',
      workspace_path: workspace,
    });
    expect(result.status).toBe('completed');
    expect(result.artifact_refs).toHaveLength(1);
    const artifact = result.artifact_refs[0]!;
    expect(artifact.content?.target_path).toBe('file.txt');
    const finalText = await fs.readFile(new URL(artifact.content!.content_ref), 'utf8');
    expect(finalText).toBe('v1');
    expect(result.response).toBe('done');
  });

  it('恢复后继续修改：交付最终版本（同一文件多级修改）', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const sha = await workspaceContentSha(workspace);
    await seedAncestor({
      runsRoot,
      ancestorId: 'run_parent',
      workspace,
      checks: [{ command: 'pnpm test', exit_code: 0, workspace_sha256: sha }],
    });
    await linkParent(runId, runsRoot, 'run_parent');
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => {
        await fs.writeFile(path.join(workspace, 'file.txt'), 'v2', 'utf8');
        return driverResult('succeeded');
      },
      loop: async (options) => {
        const brief = buildExecutionBrief({
          identity: {
            dispatch_id: 'dsp_child',
            run_id: runId,
            task_id: IDENTITY.task_id,
            role_id: IDENTITY.role_id,
            sequence: 1,
            accepted_at: '2026-11-13T00:00:00.000Z',
          },
          request: { kind: 'execute', instruction: 'write v2' },
        }).brief;
        const observation = await options.dispatch.run({
          brief,
          brief_sha256: hashExecutionBrief(brief),
          budget_before: {
            dispatches_left: 11,
            role_tokens_left: 120_000,
            deadline_at: '2027-11-13T00:45:00.000Z',
          },
        });
        return completedOutcome([observation]);
      },
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'recover and update',
      workspace_path: workspace,
    });
    const artifact = result.artifact_refs.find((ref) => ref.content?.target_path === 'file.txt');
    expect(artifact).toBeDefined();
    const content = await fs.readFile(new URL(artifact!.content!.content_ref), 'utf8');
    expect(content).toBe('v2');
  });

  it('恢复链基线缺失/损坏或产物索引损坏时显式失败，不静默漏交付', async () => {
    const missing = await makeFixture();
    await fs.mkdir(path.join(missing.runsRoot, 'run_parent'), { recursive: true });
    await fs.writeFile(
      path.join(missing.runsRoot, missing.runId, 'request.json'),
      JSON.stringify({ recovery_parent_run_id: 'run_parent' }),
      'utf8',
    );
    const missingHarness = makeHarness({
      runsRoot: missing.runsRoot,
      runId: missing.runId,
      workspace: missing.workspace,
      sendPrompt: async () => driverResult('succeeded'),
      loop: zeroDispatchLoop(),
    });
    const missingError = await missingHarness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: missing.runId,
        role_id: IDENTITY.role_id,
        instruction: 'recover',
        workspace_path: missing.workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(missingError).toBeInstanceOf(RoleTerminationError);
    expect((missingError as RoleTerminationError).termination.details).toMatchObject({
      reason: 'workspace_baseline_unavailable',
    });

    const corrupt = await makeFixture();
    const sha = await workspaceContentSha(corrupt.workspace);
    await seedAncestor({
      runsRoot: corrupt.runsRoot,
      ancestorId: 'run_parent',
      workspace: corrupt.workspace,
      checks: [{ command: 'pnpm test', exit_code: 0, workspace_sha256: sha }],
    });
    await linkParent(corrupt.runId, corrupt.runsRoot, 'run_parent');
    await fs.mkdir(path.join(corrupt.runsRoot, corrupt.runId, 'role-autonomy'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(corrupt.runsRoot, corrupt.runId, 'role-autonomy', 'artifacts.json'),
      '{not json',
      'utf8',
    );
    const corruptHarness = makeHarness({
      runsRoot: corrupt.runsRoot,
      runId: corrupt.runId,
      workspace: corrupt.workspace,
      sendPrompt: async () => driverResult('succeeded'),
      loop: zeroDispatchLoop(),
    });
    const corruptError = await corruptHarness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: corrupt.runId,
        role_id: IDENTITY.role_id,
        instruction: 'recover',
        workspace_path: corrupt.workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(corruptError).toBeInstanceOf(RoleTerminationError);
    expect((corruptError as RoleTerminationError).termination.details).toMatchObject({
      reason: 'artifact_index_corrupt',
    });
  });

  it('基线/产物索引写入失败时显式终止，不静默成功漏交付', async () => {
    const baselineFixture = await makeFixture();
    // 目标路径是目录 → 原子 rename 写失败（模拟持久化边界故障）。
    await fs.mkdir(
      path.join(
        baselineFixture.runsRoot,
        baselineFixture.runId,
        'role-autonomy',
        'workspace-before.json',
      ),
      { recursive: true },
    );
    const baselineHarness = makeHarness({
      runsRoot: baselineFixture.runsRoot,
      runId: baselineFixture.runId,
      workspace: baselineFixture.workspace,
      sendPrompt: async () => driverResult('succeeded'),
      loop: zeroDispatchLoop(),
    });
    const baselineError = await baselineHarness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: baselineFixture.runId,
        role_id: IDENTITY.role_id,
        instruction: 'work',
        workspace_path: baselineFixture.workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(baselineError).toBeInstanceOf(RoleTerminationError);
    expect((baselineError as RoleTerminationError).termination.details?.reason).toMatch(
      /workspace_baseline_(write_failed|corrupt)/,
    );

    const indexFixture = await makeFixture();
    await fs.mkdir(
      path.join(indexFixture.runsRoot, indexFixture.runId, 'role-autonomy', 'artifacts.json'),
      { recursive: true },
    );
    const indexHarness = makeHarness({
      runsRoot: indexFixture.runsRoot,
      runId: indexFixture.runId,
      workspace: indexFixture.workspace,
      sendPrompt: async () => driverResult('succeeded'),
      loop: zeroDispatchLoop(),
    });
    const indexError = await indexHarness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: indexFixture.runId,
        role_id: IDENTITY.role_id,
        instruction: 'work',
        workspace_path: indexFixture.workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(indexError).toBeInstanceOf(RoleTerminationError);
    expect((indexError as RoleTerminationError).termination.details?.reason).toMatch(
      /artifact_index_(write_failed|corrupt)/,
    );
  });
});

// ─────────────────────────────────────────────────────────────
// 复审 P1-6/P2-7：单派工超时独立收束 + 结束后迟到结果持久对账
// ─────────────────────────────────────────────────────────────

describe('单派工超时与迟到结果（真实 engine/journal + 可控 Promise）', () => {
  const NOW = '2026-11-13T12:00:00.000Z';

  function frozenPlan(options: {
    dispatch_timeout_ms?: number;
    wall_clock_ms?: number;
  }): RoleFrozenPolicyPlan {
    const wallClockMs = options.wall_clock_ms ?? 10 * 60 * 1000;
    const frozenAt = new Date().toISOString();
    return {
      limits: {
        ...ROLE_BUDGET_DEFAULTS,
        dispatch_timeout_ms: options.dispatch_timeout_ms ?? 60_000,
      },
      deadline_at: new Date(Date.now() + wallClockMs).toISOString(),
      frozen_at: frozenAt,
      max_tool_calls: 64,
      routing: {},
    };
  }

  function oneDispatchBlockedLoop(): (options: RoleLoopOptions) => Promise<RoleLoopOutcome> {
    let sequence = 0;
    return async (options) => {
      sequence += 1;
      const brief = buildExecutionBrief({
        identity: {
          dispatch_id: `dsp_timeout_${sequence}`,
          run_id: options.context.run_id,
          task_id: options.context.task_id,
          role_id: options.context.role_id,
          sequence,
          accepted_at: NOW,
        },
        request: { kind: 'execute', instruction: 'hang' },
      }).brief;
      const observation = await options.dispatch.run({
        brief,
        brief_sha256: hashExecutionBrief(brief),
        budget_before: {
          dispatches_left: 11,
          role_tokens_left: 120_000,
          deadline_at: '2027-11-13T00:45:00.000Z',
        },
      });
      expect(observation.status).toBe('unknown');
      return {
        ...completedOutcome([observation]),
        status: 'blocked',
        finish: {
          ...completedOutcome([]).finish,
          status: 'blocked',
          summary: 'dispatch timed out; not confirmed',
        },
        unresolved_dispatches: [],
      };
    };
  }

  it('sendPrompt 与 interrupt 都不合作时，单派工仍及时返回 unknown（不降成 failed、不自动重试）', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const never = new Promise<DriverRunResult>(() => undefined);
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: () => never,
      loop: oneDispatchBlockedLoop(),
    });
    const started = Date.now();
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'hang',
        workspace_path: workspace,
        freeze_plan: frozenPlan({ dispatch_timeout_ms: 40 }),
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_500);
    expect((error as RoleTerminationError).termination.code).toBe('role_blocked');
    expect(harness.driverCalls()).toBe(1);
    expect(harness.interruptCalls()).toBe(1);
    const fold = await readFold(runsRoot, runId);
    expect(fold.records[0]).toMatchObject({ status: 'unknown' });
    expect(fold.records[0]?.evidence?.transport).toMatchObject({
      evidence: 'execution_unconfirmed',
      signal: 'dispatch_timeout',
    });
  });

  it('用户取消与总墙钟分别保留正确原因码', async () => {
    // 用户取消：在途等待被取消。
    const cancelFixture = await makeFixture();
    const cancelController = new AbortController();
    const cancelHarness = makeHarness({
      runsRoot: cancelFixture.runsRoot,
      runId: cancelFixture.runId,
      workspace: cancelFixture.workspace,
      sendPrompt: () => new Promise<DriverRunResult>(() => undefined),
      loop: oneDispatchBlockedLoop(),
    });
    const cancelTimer = setTimeout(() => cancelController.abort(), 15);
    const cancelError = await cancelHarness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: cancelFixture.runId,
        role_id: IDENTITY.role_id,
        instruction: 'hang',
        workspace_path: cancelFixture.workspace,
        signal: cancelController.signal,
        freeze_plan: frozenPlan({ dispatch_timeout_ms: 60_000 }),
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )
      .finally(() => clearTimeout(cancelTimer));
    expect((cancelError as RoleTerminationError).termination.code).toBe('host_cancelled');

    // 总墙钟：deadline 到期，在途等待被墙钟中断。
    const wallFixture = await makeFixture();
    const wallHarness = makeHarness({
      runsRoot: wallFixture.runsRoot,
      runId: wallFixture.runId,
      workspace: wallFixture.workspace,
      sendPrompt: () => new Promise<DriverRunResult>(() => undefined),
      loop: oneDispatchBlockedLoop(),
    });
    const wallError = await wallHarness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: wallFixture.runId,
        role_id: IDENTITY.role_id,
        instruction: 'hang',
        workspace_path: wallFixture.workspace,
        freeze_plan: frozenPlan({ dispatch_timeout_ms: 60_000, wall_clock_ms: 40 }),
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect((wallError as RoleTerminationError).termination.code).toBe('budget_wall_clock');
    const wallFold = await readFold(wallFixture.runsRoot, wallFixture.runId);
    expect(wallFold.records[0]?.evidence?.transport).toMatchObject({ signal: 'wall_clock' });
  });

  it('超时 → engine 结束 → 迟到成功：真实 onLateResult 持久 reconciled（不改写原 settled）', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    let resolvePrompt: ((result: DriverRunResult) => void) | undefined;
    const pending = new Promise<DriverRunResult>((resolve) => {
      resolvePrompt = resolve;
    });
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: () => pending,
      loop: oneDispatchBlockedLoop(),
    });
    await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'hang',
        workspace_path: workspace,
        freeze_plan: frozenPlan({ dispatch_timeout_ms: 40 }),
      })
      .catch(() => undefined);
    // engine 已结束并关闭 journal，之后 driver 才返回真实结果。
    resolvePrompt?.(driverResult('succeeded', 'late success'));
    await harness.engine.waitForLateResultReconciliation();
    const journal = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    const record = await journal.getDispatchRecord('dsp_timeout_1');
    expect(record?.status).toBe('unknown');
    expect(record?.reconciled).toMatchObject({ status: 'succeeded' });
    // 只追加，不改写原 settled 行。
    const raw = await fs.readFile(
      path.join(runsRoot, runId, 'journal', 'dispatches.jsonl'),
      'utf8',
    );
    expect(raw).toContain('"event":"settled"');
    expect(raw).toContain('"event":"reconciled"');
    const receiptDir = path.join(runsRoot, runId, 'role-autonomy', 'late-results');
    expect(await fs.readdir(receiptDir).catch(() => [])).toHaveLength(0);
  });

  it('迟到失败同样只记 reconciled(unknown 保持)，冲突/重复回执留下可诊断事实', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    let resolvePrompt: ((result: DriverRunResult) => void) | undefined;
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: () =>
        new Promise<DriverRunResult>((resolve) => {
          resolvePrompt = resolve;
        }),
      loop: oneDispatchBlockedLoop(),
    });
    await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'hang',
        workspace_path: workspace,
        freeze_plan: frozenPlan({ dispatch_timeout_ms: 40 }),
      })
      .catch(() => undefined);
    resolvePrompt?.(driverResult('failed', 'late failure'));
    await harness.engine.waitForLateResultReconciliation();
    let journal = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    let record = await journal.getDispatchRecord('dsp_timeout_1');
    expect(record?.status).toBe('unknown');
    expect(record?.reconciled).toMatchObject({ status: 'failed' });
    // 重复/冲突回执：手工投递第二个不同可信结果，真实 drain 必须保留回执并记录错误。
    const receiptDir = path.join(runsRoot, runId, 'role-autonomy', 'late-results');
    await fs.mkdir(receiptDir, { recursive: true });
    await fs.writeFile(
      path.join(receiptDir, 'dsp_timeout_1.json'),
      JSON.stringify({
        version: 1,
        dispatch_id: 'dsp_timeout_1',
        execution: driverResult('succeeded', 'conflicting success'),
        received_at: '2026-11-13T12:00:01.000Z',
        status: 'pending',
        attempts: 0,
      }),
      'utf8',
    );
    await harness.engine.drainLateResultReceipts();
    const remaining = JSON.parse(
      await fs.readFile(path.join(receiptDir, 'dsp_timeout_1.json'), 'utf8'),
    ) as { status: string; error?: string };
    expect(remaining.status).toBe('pending');
    expect(remaining.error).toContain('conflicting');
    journal = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    record = await journal.getDispatchRecord('dsp_timeout_1');
    expect(record?.reconciled).toMatchObject({ status: 'failed' });
  });

  it('对账写入失败不静默：durable 回执保留 pending + error，原终态不变', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const base = createNodeDispatchJournalIo();
    let failAppend = false;
    const io = {
      ...base,
      async appendLineWithFsync(filePath: string, line: string) {
        if (failAppend) {
          const error = new Error(
            'injected late reconciliation write failure',
          ) as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return base.appendLineWithFsync(filePath, line);
      },
    };
    let resolvePrompt: ((result: DriverRunResult) => void) | undefined;
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      journalIo: io,
      sendPrompt: () =>
        new Promise<DriverRunResult>((resolve) => {
          resolvePrompt = resolve;
        }),
      loop: oneDispatchBlockedLoop(),
    });
    await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'hang',
        workspace_path: workspace,
        freeze_plan: frozenPlan({ dispatch_timeout_ms: 40 }),
      })
      .catch(() => undefined);
    failAppend = true;
    resolvePrompt?.(driverResult('succeeded', 'late but journal write fails'));
    await harness.engine.waitForLateResultReconciliation();
    const receiptFile = path.join(
      runsRoot,
      runId,
      'role-autonomy',
      'late-results',
      'dsp_timeout_1.json',
    );
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as {
      status: string;
      error?: string;
    };
    expect(receipt.status).toBe('pending');
    expect(receipt.error).toContain('injected late reconciliation write failure');
    const journal = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    const record = await journal.getDispatchRecord('dsp_timeout_1');
    expect(record?.status).toBe('unknown');
    expect(record?.reconciled).toBeUndefined();
  });

  it('下次 run 启动时排空 durable 回执（崩溃/关闭竞争后的补偿对账）', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: () => new Promise<DriverRunResult>(() => undefined),
      loop: oneDispatchBlockedLoop(),
    });
    await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'hang',
        workspace_path: workspace,
        freeze_plan: frozenPlan({ dispatch_timeout_ms: 40 }),
      })
      .catch(() => undefined);
    const receiptDir = path.join(runsRoot, runId, 'role-autonomy', 'late-results');
    await fs.mkdir(receiptDir, { recursive: true });
    await fs.writeFile(
      path.join(receiptDir, 'dsp_timeout_1.json'),
      JSON.stringify({
        version: 1,
        dispatch_id: 'dsp_timeout_1',
        execution: driverResult('succeeded', 'late recovered on restart'),
        received_at: '2026-11-13T12:00:01.000Z',
        status: 'pending',
        attempts: 0,
      }),
      'utf8',
    );
    // 第二次 run：启动即 drain 回执；loop 不再派工，直接 blocked 收束。
    const secondHarness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
      loop: async () =>
        ({
          ...completedOutcome([]),
          status: 'blocked',
          finish: { ...completedOutcome([]).finish, status: 'blocked', summary: 'stop' },
        }) as RoleLoopOutcome,
    });
    await secondHarness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'recover',
        workspace_path: workspace,
      })
      .catch(() => undefined);
    expect(await fs.readdir(receiptDir).catch(() => [])).toHaveLength(0);
    const journal = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    const record = await journal.getDispatchRecord('dsp_timeout_1');
    expect(record?.reconciled).toMatchObject({ status: 'succeeded' });
  });

  it('其他 writer 持有写锁时保留 durable 回执；释放后可补偿对账', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    let resolvePrompt: ((result: DriverRunResult) => void) | undefined;
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: () =>
        new Promise<DriverRunResult>((resolve) => {
          resolvePrompt = resolve;
        }),
      loop: oneDispatchBlockedLoop(),
    });
    await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'hang',
        workspace_path: workspace,
        freeze_plan: frozenPlan({ dispatch_timeout_ms: 40 }),
      })
      .catch(() => undefined);
    const otherWriter = await RunDispatchJournal.open({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    try {
      resolvePrompt?.(driverResult('succeeded', 'late while locked'));
      await harness.engine.waitForLateResultReconciliation();
      const receiptFile = path.join(
        runsRoot,
        runId,
        'role-autonomy',
        'late-results',
        'dsp_timeout_1.json',
      );
      const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as {
        status: string;
        error?: string;
      };
      expect(receipt.status).toBe('pending');
      expect(receipt.error).toMatch(/already open|journal_locked|writer lock/);
    } finally {
      await otherWriter.close();
    }
    await harness.engine.drainLateResultReceipts();
    const journal = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    const record = await journal.getDispatchRecord('dsp_timeout_1');
    expect(record?.reconciled).toMatchObject({ status: 'succeeded' });
  });
});

// ─────────────────────────────────────────────────────────────
// 最新复审 P1-1：检查必须绑定「命令结束时被检查的内容身份」，而不是事件到达时的快照
// ─────────────────────────────────────────────────────────────

interface RealObservationFixture {
  workspace: string;
  runId: string;
  /** fixture 进程里执行的 JS；可用 emit / workspaceSha / sleepSync / WORKSPACE / MARKER。 */
  body: string;
  /** 宿主侧事件处理延迟（毫秒）：模拟事件在管道/队列里排队，晚于 fixture 的后续写文件。 */
  hostDelayMs: number;
  markerFile?: string;
}

/**
 * 真实 CommandDriverTransport + 真实 Node 子进程的「受支持 Driver」：
 * 子进程在命令结束点自行计算工作区 canonical 内容指纹并写 `driver.command_observed`；
 * 宿主监听器再人为延迟处理，复现「事件已发出 → 文件又被修改 → 宿主才处理事件」。
 */
function realObservationDriver(input: RealObservationFixture): DriverRuntimeHandle {
  const marker =
    input.markerFile !== undefined
      ? JSON.stringify(input.markerFile)
      : "path.join(WORKSPACE, '.fixture-marker')";
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const WORKSPACE = ${JSON.stringify(input.workspace)};
    const RUN_ID = ${JSON.stringify(input.runId)};
    const TASK_ID = ${JSON.stringify(IDENTITY.task_id)};
    const SCHEMA_VERSION = ${JSON.stringify(SCHEMA_VERSION)};
    const MARKER = ${marker};
    const IGNORED = new Set(['.git', '.newide', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
    function workspaceSha() {
      const files = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (IGNORED.has(entry.name)) continue;
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(absolute); continue; }
          if (!entry.isFile()) continue;
          files.push([
            path.relative(WORKSPACE, absolute).split(path.sep).join('/'),
            crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
          ]);
        }
      };
      walk(WORKSPACE);
      files.sort((a, b) => a[0].localeCompare(b[0]));
      return crypto.createHash('sha256').update(JSON.stringify(files), 'utf8').digest('hex');
    }
    function emit(payload) {
      process.stderr.write('NEWIDE_DRIVER_EVENT ' + JSON.stringify({
        schema_version: 'driver-event.v1',
        event_type: 'driver.command_observed',
        payload,
        task_id: TASK_ID,
        run_id: RUN_ID,
        sequence: 1,
        created_at: new Date().toISOString(),
      }) + '\\n');
    }
    function sleepSync(ms) { const end = Date.now() + ms; while (Date.now() < end) {} }
    function driverRunResult() {
      return {
        driver_run_result_id: 'drr_real',
        session_id: 'session_real',
        status: 'succeeded',
        response: 'done',
        artifacts: [],
        transcript_ref: {
          artifact_id: 'artifact_transcript',
          type: 'transcript',
          uri: 'file:///tmp/transcript.json',
          producer_id: 'driver_real',
          created_at: '2026-11-13T00:00:00.000Z',
          schema_version: SCHEMA_VERSION,
        },
        tool_events: [],
        diagnostics: { driver_id: 'driver_real', duration_ms: 5, notes: [] },
        created_at: '2026-11-13T00:00:00.000Z',
        schema_version: SCHEMA_VERSION,
      };
    }
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => {
      ${input.body}
      process.stdout.write(JSON.stringify(driverRunResult()));
    });
  `;
  const transport = new CommandDriverTransport({
    command: process.execPath,
    args: ['-e', script],
  });
  return {
    driver_id: 'driver_real',
    session_id: 'session_real',
    capabilities: { supports_session_load: false },
    interrupt: () => Promise.resolve(),
    subscribeToEvents: (listener) =>
      transport.subscribeToEvents((event) => {
        // 宿主处理延迟：事件字节已经在管道里，engine 的回调晚于子进程继续写文件。
        setTimeout(() => listener(event), input.hostDelayMs);
      }),
    sendPrompt: (prompt) => transport.invoke(prompt),
  } as unknown as DriverRuntimeHandle;
}

describe('命令检查绑定被检查内容身份（真实 CommandDriverTransport + 真实子进程）', () => {
  const VERIFICATION: VerificationFixture[] = [{ requirement: 'pnpm test passes' }];

  it('子进程先发事件再修改、宿主延迟处理：事件时刻快照不能冒充被检查版本，partial 证据不能通过', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const { loop, decisions } = finishProbeLoop({ verification: VERIFICATION });
    const driver = realObservationDriver({
      workspace,
      runId,
      hostDelayMs: 40,
      body: `
        emit({ command: 'pnpm test', exit_code: 0, stdout: 'ok', checked_workspace_sha256: workspaceSha() });
        fs.writeFileSync(path.join(WORKSPACE, 'file.txt'), 'after-check');
        sleepSync(150);
      `,
    });
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      driver: () => driver,
      loop,
      finishValidator: () => createRoleFinishValidator(),
    });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'verify the change',
        workspace_path: workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.accepted).toBe(false);
    expect((decisions[0]?.gaps ?? []).map((gap) => gap.code)).toContain(
      'evidence_source_insufficient',
    );
    expect((error as RoleTerminationError).termination.code).toBe('role_blocked');
    // 事件时刻的宿主快照（修改后内容）不能冒充被检查版本：证据只能是 partial。
    const fold = await readFold(runsRoot, runId);
    expect(fold.records[0]?.evidence?.checks?.[0]).toMatchObject({
      command: 'pnpm test',
      provenance: 'host_observed',
      observation: 'partial',
    });
  });

  it('检查在最终内容上完成（命令结束→宿主→交付内容一致）：可以完成', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const { loop, decisions } = finishProbeLoop({ verification: VERIFICATION });
    const driver = realObservationDriver({
      workspace,
      runId,
      hostDelayMs: 20,
      body: `
        fs.writeFileSync(path.join(WORKSPACE, 'file.txt'), 'final-version');
        emit({ command: 'pnpm test', exit_code: 0, stdout: 'ok', checked_workspace_sha256: workspaceSha() });
        sleepSync(80);
      `,
    });
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      driver: () => driver,
      loop,
      finishValidator: () => createRoleFinishValidator(),
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'verify the change',
      workspace_path: workspace,
    });
    expect(decisions[0]?.accepted).toBe(true);
    expect(result.status).toBe('completed');
    const fold = await readFold(runsRoot, runId);
    expect(fold.records[0]?.evidence?.checks?.[0]).toMatchObject({
      command: 'pnpm test',
      observation: 'complete',
      exit_code: 0,
    });
  });

  it('检查后修改 → 过期；重新检查最终内容 → 可以完成', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const decisions: RoleFinishDecision[] = [];
    const observations: RoleDispatchObservation[] = [];
    const marker = path.join(runsRoot, 'fixture-marker.txt');
    const driver = realObservationDriver({
      workspace,
      runId,
      hostDelayMs: 20,
      markerFile: marker,
      body: `
        const first = !fs.existsSync(MARKER);
        if (first) {
          fs.writeFileSync(MARKER, '1');
          fs.writeFileSync(path.join(WORKSPACE, 'file.txt'), 'v1');
          emit({ command: 'pnpm test', exit_code: 0, stdout: 'ok', checked_workspace_sha256: workspaceSha() });
          // 宿主在 hostDelayMs 后独立重算指纹（此时仍是 v1，检查可绑定 v1）；
          // 之后子进程才把内容改成 v2，于是这份「v1 上通过」的检查对最终 v2 即过期。
          sleepSync(200);
          fs.writeFileSync(path.join(WORKSPACE, 'file.txt'), 'v2');
          sleepSync(50);
        } else {
          emit({ command: 'pnpm test', exit_code: 0, stdout: 'ok', checked_workspace_sha256: workspaceSha() });
          sleepSync(120);
        }
      `,
    });
    const loop = async (options: RoleLoopOptions): Promise<RoleLoopOutcome> => {
      for (let sequence = 1; sequence <= 2; sequence += 1) {
        const brief = buildExecutionBrief({
          identity: {
            dispatch_id: `dsp_recheck_${sequence}`,
            run_id: options.context.run_id,
            task_id: options.context.task_id,
            role_id: options.context.role_id,
            sequence,
            accepted_at: '2026-11-13T00:00:00.000Z',
          },
          request: { kind: 'execute', instruction: 'verify' },
        }).brief;
        observations.push(
          await options.dispatch.run({
            brief,
            brief_sha256: hashExecutionBrief(brief),
            budget_before: {
              dispatches_left: 12 - sequence,
              role_tokens_left: 100_000,
              deadline_at: '2027-11-13T00:45:00.000Z',
            },
          }),
        );
        const state = await options.context.workspace_fingerprint?.();
        // 每次 finish 的 passed 只引用本轮新产生的派工：第一次检查作用于 v1，完成后
        // 内容已是 v2 → 过期；第二次检查作用于最终 v2 → 适用。
        const latest = observations[observations.length - 1]!;
        decisions.push(
          await options.finish.validate({
            request: {
              status: 'completed',
              summary: 'done',
              evidence_refs: [],
              unresolved: [],
              role_reflection: '',
              verification: [
                {
                  requirement: 'pnpm test passes',
                  outcome: 'passed',
                  dispatch_ids: [latest.dispatch_id],
                  evidence_refs: [],
                },
              ],
            },
            journal: options.journal,
            context: options.context,
            budget: options.budget,
            dispatches: [...observations],
            cancelled: false,
            ...(state?.sha256 !== undefined ? { current_workspace_sha256: state.sha256 } : {}),
            now: new Date('2026-11-13T12:10:00.000Z'),
          }),
        );
      }
      return completedOutcome(observations);
    };
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      driver: () => driver,
      loop,
      finishValidator: () => createRoleFinishValidator(),
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'verify and re-verify',
      workspace_path: workspace,
    });
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.accepted).toBe(false);
    expect((decisions[0]?.gaps ?? []).map((gap) => gap.code)).toContain('evidence_stale');
    expect(decisions[1]?.accepted).toBe(true);
    expect(result.status).toBe('completed');
  });

  it('截断的观察不能当可靠指纹（observation=partial，finish 拒绝）', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const { loop, decisions } = finishProbeLoop({ verification: VERIFICATION });
    const driver = realObservationDriver({
      workspace,
      runId,
      hostDelayMs: 20,
      body: `
        fs.writeFileSync(path.join(WORKSPACE, 'file.txt'), 'final-version');
        emit({ command: 'pnpm test', exit_code: 0, stdout: 'ok', truncated: true, checked_workspace_sha256: workspaceSha() });
        sleepSync(80);
      `,
    });
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      driver: () => driver,
      loop,
      finishValidator: () => createRoleFinishValidator(),
    });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'verify',
        workspace_path: workspace,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(decisions[0]?.accepted).toBe(false);
    expect((decisions[0]?.gaps ?? []).map((gap) => gap.code)).toContain(
      'evidence_source_insufficient',
    );
    expect((error as RoleTerminationError).termination.code).toBe('role_blocked');
    const fold = await readFold(runsRoot, runId);
    expect(fold.records[0]?.evidence?.checks?.[0]?.observation).toBe('partial');
  });

  it('缺少内容身份 / 非法指纹的观察不能绑定（不把事件到达快照当被检查版本）', async () => {
    for (const observationField of ['', ", checked_workspace_sha256: 'not-a-content-hash'"]) {
      const { runsRoot, runId, workspace } = await makeFixture();
      const { loop, decisions } = finishProbeLoop({ verification: VERIFICATION });
      const driver = realObservationDriver({
        workspace,
        runId,
        hostDelayMs: 20,
        body: `
          fs.writeFileSync(path.join(WORKSPACE, 'file.txt'), 'final-version');
          emit({ command: 'pnpm test', exit_code: 0, stdout: 'ok'${observationField} });
          sleepSync(80);
        `,
      });
      const harness = makeHarness({
        runsRoot,
        runId,
        workspace,
        driver: () => driver,
        loop,
        finishValidator: () => createRoleFinishValidator(),
      });
      const error = await harness.engine
        .run({
          task_id: IDENTITY.task_id,
          run_id: runId,
          role_id: IDENTITY.role_id,
          instruction: 'verify',
          workspace_path: workspace,
        })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(decisions[0]?.accepted).toBe(false);
      expect((decisions[0]?.gaps ?? []).length).toBeGreaterThan(0);
      expect((error as RoleTerminationError).termination.code).toBe('role_blocked');
      const fold = await readFold(runsRoot, runId);
      const checks = fold.records[0]?.evidence?.checks ?? [];
      // 缺失指纹：事件仍被记录为 partial；非法指纹：strict 解析拒绝该事件（不产生证据）。
      if (checks.length > 0) expect(checks[0]?.observation).not.toBe('complete');
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 最新复审 P1-3：迟到回执必须绑定派工所属 Run（同一 engine 顺序/并发多 Run）
// ─────────────────────────────────────────────────────────────

describe('迟到回执归属（同一 engine 多 Run，真实 journal）', () => {
  interface RunControl {
    calls: number;
    interrupts: number;
    listeners: Set<(event: DriverStreamEvent) => void>;
    send: () => Promise<DriverRunResult>;
  }

  function makeMultiRunHarness(runsRoot: string): {
    engine: RoleAutonomyEngine;
    control: (runId: string) => RunControl;
    loops: Map<string, (options: RoleLoopOptions) => Promise<RoleLoopOutcome>>;
  } {
    const controls = new Map<string, RunControl>();
    const handles = new Map<string, DriverRuntimeHandle>();
    const loops = new Map<string, (options: RoleLoopOptions) => Promise<RoleLoopOutcome>>();
    const control = (runId: string): RunControl => {
      const existing = controls.get(runId);
      if (existing !== undefined) return existing;
      const created: RunControl = {
        calls: 0,
        interrupts: 0,
        listeners: new Set(),
        send: async () => driverResult('succeeded'),
      };
      controls.set(runId, created);
      return created;
    };
    const handle = (runId: string): DriverRuntimeHandle => {
      const existing = handles.get(runId);
      if (existing !== undefined) return existing;
      const state = control(runId);
      const created = {
        driver_id: 'driver_test',
        session_id: 'session_1',
        capabilities: { supports_session_load: false },
        interrupt: () => {
          state.interrupts += 1;
          return Promise.resolve();
        },
        subscribeToEvents: (listener: (event: DriverStreamEvent) => void) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        sendPrompt: async () => {
          state.calls += 1;
          return state.send();
        },
      } as unknown as DriverRuntimeHandle;
      handles.set(runId, created);
      return created;
    };
    const engine = new RoleAutonomyEngine({
      runs_root: runsRoot,
      llm: { completeWithTools: async () => ({ content: null, tool_calls: undefined }) },
      repository: {} as MemoryRepository,
      buffer_repository: {} as BufferRepository,
      driver_for: (_roleId, runId) => handle(runId ?? 'run_unknown'),
      create_budget: ({ frozen, consumed }) => fakeBudgetPort(frozen, consumed),
      create_finish_validator: () => ({ validate: async () => ({ accepted: false, gaps: [] }) }),
      run_loop: async (options: RoleLoopOptions) => {
        const loop = loops.get(options.context.run_id);
        return loop !== undefined ? loop(options) : completedOutcome();
      },
    });
    return { engine, control, loops };
  }

  function frozenPlanFor(options: { dispatch_timeout_ms?: number }): RoleFrozenPolicyPlan {
    return {
      limits: {
        ...ROLE_BUDGET_DEFAULTS,
        dispatch_timeout_ms: options.dispatch_timeout_ms ?? 60_000,
      },
      deadline_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      frozen_at: new Date().toISOString(),
      max_tool_calls: 64,
      routing: {},
    };
  }

  function blockedDispatchLoop(
    dispatchId: string,
  ): (options: RoleLoopOptions) => Promise<RoleLoopOutcome> {
    return async (options) => {
      const brief = buildExecutionBrief({
        identity: {
          dispatch_id: dispatchId,
          run_id: options.context.run_id,
          task_id: options.context.task_id,
          role_id: options.context.role_id,
          sequence: 1,
          accepted_at: '2026-11-13T00:00:00.000Z',
        },
        request: { kind: 'execute', instruction: 'hang' },
      }).brief;
      const observation = await options.dispatch.run({
        brief,
        brief_sha256: hashExecutionBrief(brief),
        budget_before: {
          dispatches_left: 11,
          role_tokens_left: 120_000,
          deadline_at: '2027-11-13T00:45:00.000Z',
        },
      });
      return {
        ...completedOutcome([observation]),
        status: 'blocked',
        finish: {
          ...completedOutcome([]).finish,
          status: 'blocked',
          summary: 'dispatch ended without confirmation',
        },
        unresolved_dispatches: [],
      };
    };
  }

  async function makeRunDirectories(runsRoot: string, runIds: readonly string[]): Promise<void> {
    for (const runId of runIds) {
      await fs.mkdir(path.join(runsRoot, runId), { recursive: true });
    }
  }

  it('同一 engine 顺序运行 A、B：A 的迟到结果仍对账到 A，不写进 B', async () => {
    const { runsRoot, workspace } = await makeFixture();
    const runA = 'run_seq_a';
    const runB = 'run_seq_b';
    await makeRunDirectories(runsRoot, [runA, runB]);
    const harness = makeMultiRunHarness(runsRoot);
    let resolveA: ((result: DriverRunResult) => void) | undefined;
    harness.control(runA).send = () =>
      new Promise<DriverRunResult>((resolve) => {
        resolveA = resolve;
      });
    harness.control(runB).send = async () => driverResult('succeeded', 'B done');
    harness.loops.set(runA, blockedDispatchLoop('dsp_late_a'));
    harness.loops.set(runB, async () => completedOutcome());

    await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runA,
        role_id: IDENTITY.role_id,
        instruction: 'hang',
        workspace_path: workspace,
        freeze_plan: frozenPlanFor({ dispatch_timeout_ms: 40 }),
      })
      .catch(() => undefined);
    const bResult = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runB,
      role_id: IDENTITY.role_id,
      instruction: 'after A',
      workspace_path: workspace,
    });
    expect(bResult.status).toBe('completed');

    // A 的迟到结果在 B 已经结束之后才返回：必须仍对账到 A 自己的 Journal。
    resolveA?.(driverResult('succeeded', 'late A'));
    await harness.engine.waitForLateResultReconciliation();

    const journalA = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runA),
      identity: { run_id: runA, ...IDENTITY },
    });
    const recordA = await journalA.getDispatchRecord('dsp_late_a');
    expect(recordA?.status).toBe('unknown');
    expect(recordA?.reconciled).toMatchObject({ status: 'succeeded' });
    const journalB = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runB),
      identity: { run_id: runB, ...IDENTITY },
    });
    expect((await journalB.fold()).records).toHaveLength(0);
    expect(
      await fs.readdir(path.join(runsRoot, runB, 'role-autonomy', 'late-results')).catch(() => []),
    ).toHaveLength(0);
    const transcriptB = JSON.parse(
      await fs.readFile(path.join(runsRoot, runB, 'role-autonomy', 'transcript.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(transcriptB.late_result_receipt_errors).toBeUndefined();
  });

  it('同一 engine 并发运行不同 Run：回执归属正确，互不串上下文', async () => {
    const { runsRoot, workspace } = await makeFixture();
    const runA = 'run_conc_a';
    const runB = 'run_conc_b';
    await makeRunDirectories(runsRoot, [runA, runB]);
    const harness = makeMultiRunHarness(runsRoot);
    let resolveA: ((result: DriverRunResult) => void) | undefined;
    harness.control(runA).send = () =>
      new Promise<DriverRunResult>((resolve) => {
        resolveA = resolve;
      });
    harness.control(runB).send = async () => driverResult('succeeded', 'B done');
    harness.loops.set(runA, blockedDispatchLoop('dsp_conc_a'));
    harness.loops.set(runB, async () => completedOutcome());

    const runAPromise = harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runA,
        role_id: IDENTITY.role_id,
        instruction: 'hang A',
        workspace_path: workspace,
        freeze_plan: frozenPlanFor({ dispatch_timeout_ms: 40 }),
      })
      .catch(() => undefined);
    const runBPromise = harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runB,
      role_id: IDENTITY.role_id,
      instruction: 'B work',
      workspace_path: workspace,
    });
    const [, bResult] = await Promise.all([runAPromise, runBPromise]);
    expect(bResult.status).toBe('completed');

    resolveA?.(driverResult('succeeded', 'late concurrent A'));
    await harness.engine.waitForLateResultReconciliation();

    const journalA = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runA),
      identity: { run_id: runA, ...IDENTITY },
    });
    expect((await journalA.getDispatchRecord('dsp_conc_a'))?.reconciled).toMatchObject({
      status: 'succeeded',
    });
    const journalB = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runB),
      identity: { run_id: runB, ...IDENTITY },
    });
    expect((await journalB.fold()).records).toHaveLength(0);
  });

  it('一个 Run 结束不改变另一个 Run 的活动状态（B 结束后 A 仍可继续）', async () => {
    const { runsRoot, workspace } = await makeFixture();
    const runA = 'run_alive_a';
    const runB = 'run_alive_b';
    await makeRunDirectories(runsRoot, [runA, runB]);
    const harness = makeMultiRunHarness(runsRoot);
    let resolveA: ((result: DriverRunResult) => void) | undefined;
    harness.control(runA).send = () =>
      new Promise<DriverRunResult>((resolve) => {
        resolveA = resolve;
      });
    harness.loops.set(runA, async (options) => {
      const brief = buildExecutionBrief({
        identity: {
          dispatch_id: 'dsp_alive_a',
          run_id: options.context.run_id,
          task_id: options.context.task_id,
          role_id: options.context.role_id,
          sequence: 1,
          accepted_at: '2026-11-13T00:00:00.000Z',
        },
        request: { kind: 'execute', instruction: 'long work' },
      }).brief;
      const observation = await options.dispatch.run({
        brief,
        brief_sha256: hashExecutionBrief(brief),
        budget_before: {
          dispatches_left: 11,
          role_tokens_left: 120_000,
          deadline_at: '2027-11-13T00:45:00.000Z',
        },
      });
      return completedOutcome([observation]);
    });
    let aSettled = false;
    const runAPromise = harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runA,
        role_id: IDENTITY.role_id,
        instruction: 'slow A',
        workspace_path: workspace,
        freeze_plan: frozenPlanFor({ dispatch_timeout_ms: 60_000 }),
      })
      .finally(() => {
        aSettled = true;
      });
    const runBPromise = harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runB,
      role_id: IDENTITY.role_id,
      instruction: 'B work',
      workspace_path: workspace,
    });
    const bResult = await runBPromise;
    expect(bResult.status).toBe('completed');
    // 派工是异步启动的：等 A 真正进入 sendPrompt 再断言「B 结束没有结束 A」。
    await waitForCondition(() => resolveA !== undefined, 2_000);
    expect(aSettled).toBe(false);
    resolveA?.(driverResult('succeeded', 'A finished later'));
    const aResult = await runAPromise;
    expect(aResult.status).toBe('completed');
  });

  it('writer 占用/失败重试与显式 drain 不串 Run：A 的回执只在 A 补偿', async () => {
    const { runsRoot, workspace } = await makeFixture();
    const runA = 'run_drain_a';
    const runB = 'run_drain_b';
    await makeRunDirectories(runsRoot, [runA, runB]);
    const harness = makeMultiRunHarness(runsRoot);
    let resolveA: ((result: DriverRunResult) => void) | undefined;
    harness.control(runA).send = () =>
      new Promise<DriverRunResult>((resolve) => {
        resolveA = resolve;
      });
    harness.loops.set(runA, blockedDispatchLoop('dsp_drain_a'));
    harness.loops.set(runB, async () => completedOutcome());
    await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runA,
        role_id: IDENTITY.role_id,
        instruction: 'hang A',
        workspace_path: workspace,
        freeze_plan: frozenPlanFor({ dispatch_timeout_ms: 40 }),
      })
      .catch(() => undefined);
    await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runB,
      role_id: IDENTITY.role_id,
      instruction: 'B work',
      workspace_path: workspace,
    });

    const otherWriter = await RunDispatchJournal.open({
      runDir: path.join(runsRoot, runA),
      identity: { run_id: runA, ...IDENTITY },
    });
    try {
      resolveA?.(driverResult('succeeded', 'late while A locked'));
      await harness.engine.waitForLateResultReconciliation();
      const receipt = JSON.parse(
        await fs.readFile(
          path.join(runsRoot, runA, 'role-autonomy', 'late-results', 'dsp_drain_a.json'),
          'utf8',
        ),
      ) as { status: string; error?: string };
      expect(receipt.status).toBe('pending');
      expect(receipt.error).toMatch(/already open|journal_locked|writer lock/);
    } finally {
      await otherWriter.close();
    }
    // 显式 drain 会遍历所有 Run 上下文，但只有 A 有回执；B 不受影响。
    await harness.engine.drainLateResultReceipts();
    const journalA = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runA),
      identity: { run_id: runA, ...IDENTITY },
    });
    expect((await journalA.getDispatchRecord('dsp_drain_a'))?.reconciled).toMatchObject({
      status: 'succeeded',
    });
    const journalB = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runB),
      identity: { run_id: runB, ...IDENTITY },
    });
    expect((await journalB.fold()).records).toHaveLength(0);
    expect(
      await fs.readdir(path.join(runsRoot, runB, 'role-autonomy', 'late-results')).catch(() => []),
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 最新复审 P2-6：损坏的产物索引 / 基线成员必须显式失败关闭（不得静默过滤）
// ─────────────────────────────────────────────────────────────

describe('恢复数据完整性：产物索引与工作区基线逐成员校验', () => {
  function parentReportArtifact(artifactId = 'artifact_parent_report'): Record<string, unknown> {
    return {
      artifact_id: artifactId,
      type: 'review',
      uri: 'artifact://review/run_parent/report.md',
      sha256: 'b'.repeat(64),
      producer_id: 'driver_parent',
      task_id: IDENTITY.task_id,
      metadata: { source: 'driver-report' },
      content: {
        kind: 'file',
        content_ref: 'file:///tmp/report.md',
        target_path: 'report.md',
        media_type: 'text/markdown',
      },
      created_at: '2026-11-13T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    };
  }

  async function seedParent(input: {
    runsRoot: string;
    workspace: string;
    parentId: string;
    artifacts?: unknown;
    baseline?: unknown;
  }): Promise<void> {
    const parentDir = path.join(input.runsRoot, input.parentId);
    await fs.mkdir(path.join(parentDir, 'role-autonomy'), { recursive: true });
    const content = await snapshotWorkspaceContent(input.workspace);
    await fs.writeFile(
      path.join(parentDir, 'role-autonomy', 'workspace-before.json'),
      JSON.stringify(
        input.baseline ?? {
          version: 2,
          workspace_path: path.resolve(input.workspace),
          entries: [...content.entries()],
        },
      ),
      'utf8',
    );
    if (input.artifacts !== undefined) {
      await fs.writeFile(
        path.join(parentDir, 'role-autonomy', 'artifacts.json'),
        JSON.stringify(input.artifacts),
        'utf8',
      );
    }
  }

  async function linkChild(runsRoot: string, runId: string, parentId: string): Promise<void> {
    await fs.mkdir(path.join(runsRoot, runId), { recursive: true });
    await fs.writeFile(
      path.join(runsRoot, runId, 'request.json'),
      JSON.stringify({ recovery_parent_run_id: parentId }),
      'utf8',
    );
  }

  function zeroDispatchLoop(): (options: RoleLoopOptions) => Promise<RoleLoopOutcome> {
    return async () => completedOutcome();
  }

  async function runRecovered(
    runsRoot: string,
    runId: string,
    workspace: string,
  ): Promise<{ result?: AgentExecutionResult; error?: unknown }> {
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
      loop: zeroDispatchLoop(),
    });
    try {
      const result = await harness.engine.run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'recover parent work',
        workspace_path: workspace,
        freeze_plan: {
          limits: { ...ROLE_BUDGET_DEFAULTS },
          deadline_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          frozen_at: new Date().toISOString(),
          max_tool_calls: 64,
          routing: {},
        },
      });
      return { result };
    } catch (error) {
      return { error };
    }
  }

  it('损坏索引成员（空对象/混合/缺内容引用）显式 artifact_index_corrupt，不静默过滤', async () => {
    const invalidIndexes: unknown[] = [
      [{}],
      [parentReportArtifact(), { artifact_id: 'artifact_broken' }],
      [
        {
          ...parentReportArtifact(),
          content: { kind: 'file' },
        },
      ],
      [
        {
          ...parentReportArtifact(),
          content: { kind: 'file', content_ref: '' },
        },
      ],
    ];
    for (const artifacts of invalidIndexes) {
      const { runsRoot, workspace } = await makeFixture();
      await seedParent({ runsRoot, workspace, parentId: 'run_parent', artifacts });
      await linkChild(runsRoot, 'run_1', 'run_parent');
      const { result, error } = await runRecovered(runsRoot, 'run_1', workspace);
      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(RoleTerminationError);
      expect((error as RoleTerminationError).termination.code).toBe('host_failed');
      expect((error as RoleTerminationError).termination.details).toMatchObject({
        reason: 'artifact_index_corrupt',
      });
    }
  });

  it('合法空索引与合法非空索引都能恢复；父 Run 报告进入最终 artifact_refs', async () => {
    const empty = await makeFixture();
    await seedParent({
      runsRoot: empty.runsRoot,
      workspace: empty.workspace,
      parentId: 'run_parent',
      artifacts: [],
    });
    await linkChild(empty.runsRoot, 'run_1', 'run_parent');
    const emptyRun = await runRecovered(empty.runsRoot, 'run_1', empty.workspace);
    expect(emptyRun.error).toBeUndefined();
    expect(emptyRun.result?.status).toBe('completed');
    expect(emptyRun.result?.artifact_refs).toHaveLength(0);

    const nonEmpty = await makeFixture();
    await seedParent({
      runsRoot: nonEmpty.runsRoot,
      workspace: nonEmpty.workspace,
      parentId: 'run_parent',
      artifacts: [parentReportArtifact()],
    });
    await linkChild(nonEmpty.runsRoot, 'run_1', 'run_parent');
    const recovered = await runRecovered(nonEmpty.runsRoot, 'run_1', nonEmpty.workspace);
    expect(recovered.error).toBeUndefined();
    expect(recovered.result?.status).toBe('completed');
    const report = recovered.result?.artifact_refs.find(
      (artifact) => artifact.artifact_id === 'artifact_parent_report',
    );
    expect(report).toBeDefined();
    expect(report?.content?.target_path).toBe('report.md');
    // 继承的索引写回当前 Run，后续恢复/下游不再丢失。
    const childIndex = JSON.parse(
      await fs.readFile(
        path.join(nonEmpty.runsRoot, 'run_1', 'role-autonomy', 'artifacts.json'),
        'utf8',
      ),
    ) as Array<{ artifact_id: string }>;
    expect(childIndex.map((artifact) => artifact.artifact_id)).toContain('artifact_parent_report');
  });

  it('不支持的基线版本（早期数组格式/version 1）与损坏成员都显式 workspace_baseline_corrupt', async () => {
    const invalidBaselines: Array<{
      baseline: (workspace: string) => unknown;
      /** 没有 v2 version 身份：按 unsupported version fail closed，而不是猜成空基线。 */
      unsupportedVersion?: boolean;
    }> = [
      {
        // 阶段 2 早期的 `[path, content_sha]` 数组格式已退役：内容指纹本身合法，但缺少
        // `{version: 2, workspace_path, entries}` 身份 → 按不支持的版本拒绝（R10：无数据依赖）。
        baseline: () => [['file.txt', 'a'.repeat(64)]],
        unsupportedVersion: true,
      },
      {
        baseline: (workspace) => ({ version: 1, workspace_path: workspace, entries: [] }),
        unsupportedVersion: true,
      },
      {
        baseline: (workspace) => ({
          version: 2,
          workspace_path: workspace,
          entries: [['file.txt', 'x']],
        }),
      },
      {
        baseline: (workspace) => ({
          version: 2,
          workspace_path: workspace,
          entries: [
            ['file.txt', 'c'.repeat(64)],
            ['../escape.txt', 'd'.repeat(64)],
          ],
        }),
      },
      {
        baseline: (workspace) => ({
          version: 2,
          workspace_path: workspace,
          entries: [{}],
        }),
      },
    ];
    for (const invalid of invalidBaselines) {
      const { runsRoot, runId, workspace } = await makeFixture();
      await fs.writeFile(path.join(workspace, 'unrelated.txt'), 'pre-existing', 'utf8');
      const baseline = invalid.baseline(path.resolve(workspace));
      await seedParent({ runsRoot, workspace, parentId: 'run_parent', baseline });
      await linkChild(runsRoot, runId, 'run_parent');
      const { result, error } = await runRecovered(runsRoot, runId, workspace);
      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(RoleTerminationError);
      expect((error as RoleTerminationError).termination.code).toBe('host_failed');
      expect((error as RoleTerminationError).termination.details).toMatchObject({
        reason: 'workspace_baseline_corrupt',
      });
      if (invalid.unsupportedVersion === true) {
        expect((error as RoleTerminationError).message).toMatch(/unsupported (version|shape)/);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 阶段 2 精简后的验证接线：真实 engine + 真实 loop/finish + 真实 RunDispatchJournal +
// 真实 CommandDriverTransport 子进程。宿主只核验 verification 引用的派工是否有
// host_observed + complete + exit 0 且内容指纹与最终交付一致的检查证据。
// ─────────────────────────────────────────────────────────────

describe('verification 接线（真实 engine + 真实 loop/finish + 真实子进程）', () => {
  it('真实 CommandDriverTransport 事件产生 host_observed 通过检查：verification passed 引用该派工 → completed，finish 行含 verification', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const driver = realObservationDriver({
      workspace,
      runId,
      hostDelayMs: 20,
      body: `
        fs.writeFileSync(path.join(WORKSPACE, 'file.txt'), 'final-version');
        emit({ command: 'pnpm test', exit_code: 0, stdout: 'all tests passed', checked_workspace_sha256: workspaceSha() });
        sleepSync(80);
      `,
    });
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      driver: () => driver,
      finishValidator: () => createRoleFinishValidator(),
      loop: scriptedRoleLoop(({ round, messages }) => {
        if (round === 1) return dispatchCompletion('call_dispatch_1');
        const dispatchId = lastDispatchId(messages);
        expect(dispatchId).toBeDefined();
        return finishCompletion('call_finish_1', {
          status: 'completed',
          summary: 'verified with a host-observed check',
          verification: [{ requirement: 'pnpm test passes', dispatch_ids: [dispatchId!] }],
        });
      }),
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'fix the failing test and verify it',
      workspace_path: workspace,
      completion_criteria: ['pnpm test 通过'],
    });
    expect(result.status).toBe('completed');
    expect(result.response).toBe('verified with a host-observed check');
    const fold = await readFold(runsRoot, runId);
    expect(fold.records).toHaveLength(1);
    const dispatchId = fold.records[0]!.dispatch_id;
    // 检查证据事实：host_observed + complete + exit 0，且绑定了被检查内容身份。
    expect(fold.records[0]?.evidence?.checks?.[0]).toMatchObject({
      command: 'pnpm test',
      provenance: 'host_observed',
      observation: 'complete',
      exit_code: 0,
    });
    expect(fold.records[0]?.evidence?.checks?.[0]?.workspace_sha256).toMatch(/^[a-f0-9]{64}$/);
    // finish 行必须保留 role 的显式验证陈述，并指向真实产生的派工 id。
    expect(fold.finish?.status).toBe('completed');
    expect(fold.finish?.verification).toEqual([
      {
        requirement: 'pnpm test passes',
        outcome: 'passed',
        dispatch_ids: [dispatchId],
        evidence_refs: [],
      },
    ]);
  });

  it('只有 echo ok / 无法绑定被检查内容身份的证据：passed 被拒（证据事实缺口，不是命令不匹配），role 只能 blocked', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const driver = realObservationDriver({
      workspace,
      runId,
      hostDelayMs: 20,
      body: `
        fs.writeFileSync(path.join(WORKSPACE, 'file.txt'), 'final-version');
        // 无关命令 + 缺少 checked_workspace_sha256：宿主无法证明检查作用于哪一版内容，
        // 该观察只能是 partial —— 不是「命令名不对」，而是没有合格的检查证据。
        emit({ command: 'echo ok', exit_code: 0, stdout: 'ok' });
        sleepSync(80);
      `,
    });
    let rejectedGaps: RoleFinishGap[] = [];
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      driver: () => driver,
      finishValidator: () => createRoleFinishValidator(),
      loop: scriptedRoleLoop(({ round, messages }) => {
        if (round === 1) return dispatchCompletion('call_dispatch_1');
        if (round === 2) {
          const dispatchId = lastDispatchId(messages);
          expect(dispatchId).toBeDefined();
          // role 声称 pnpm test 通过，但引用的派工只有 echo ok 的 partial 观察。
          return finishCompletion('call_finish_1', {
            status: 'completed',
            summary: 'echo ok claimed as verification',
            verification: [{ requirement: 'pnpm test passes', dispatch_ids: [dispatchId!] }],
          });
        }
        rejectedGaps = lastFinishRejection(messages);
        return finishCompletion('call_finish_2', {
          status: 'blocked',
          summary: 'cannot prove pnpm test passed with a host-observed check',
        });
      }),
    });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'run the required test check',
        workspace_path: workspace,
        // 宿主不再从 completion_criteria 推导命令义务/比较命令文本；这里保留原文只为证明
        // 拒绝原因与这段文本无关。
        completion_criteria: ['pnpm test passes'],
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    // 拒绝原因落在证据事实上：引用的派工没有可支撑 passed 的 host-observed 检查。
    const insufficient = rejectedGaps.find((gap) => gap.code === 'evidence_source_insufficient');
    expect(insufficient).toBeDefined();
    expect(insufficient?.detail).toMatchObject({
      requirement: 'pnpm test passes',
      reason: 'no_passing_host_observed_check',
    });
    expect((error as RoleTerminationError).termination.code).toBe('role_blocked');
    const fold = await readFold(runsRoot, runId);
    // 错误 completed 从未落盘；落盘的是 role 如实提交的 blocked 收束。
    expect(fold.finish?.status).toBe('blocked');
    expect(fold.finish?.summary).toBe('cannot prove pnpm test passed with a host-observed check');
    expect(fold.records[0]?.evidence?.checks?.[0]).toMatchObject({
      command: 'echo ok',
      provenance: 'host_observed',
      observation: 'partial',
    });
  });

  it('检查后修改工作区 → passed 因 evidence_stale 被拒；重新检查最终内容后 completed', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const marker = path.join(runsRoot, 'fixture-marker.txt');
    const driver = realObservationDriver({
      workspace,
      runId,
      hostDelayMs: 20,
      markerFile: marker,
      body: `
        const first = !fs.existsSync(MARKER);
        if (first) {
          fs.writeFileSync(MARKER, '1');
          fs.writeFileSync(path.join(WORKSPACE, 'file.txt'), 'v1');
          emit({ command: 'pnpm test', exit_code: 0, stdout: 'ok', checked_workspace_sha256: workspaceSha() });
          // 宿主在 hostDelayMs 后独立重算（此时 v1，检查可绑定 v1）；随后内容才变成 v2，
          // 因此「v1 上通过」的检查对最终 v2 是过期证据。
          sleepSync(200);
          fs.writeFileSync(path.join(WORKSPACE, 'file.txt'), 'v2');
          sleepSync(50);
        } else {
          emit({ command: 'pnpm test', exit_code: 0, stdout: 'ok', checked_workspace_sha256: workspaceSha() });
          sleepSync(120);
        }
      `,
    });
    let staleGaps: RoleFinishGap[] = [];
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      driver: () => driver,
      finishValidator: () => createRoleFinishValidator(),
      loop: scriptedRoleLoop(({ round, messages }) => {
        if (round === 1 || round === 3) return dispatchCompletion(`call_dispatch_${round}`);
        const dispatchId = lastDispatchId(messages);
        expect(dispatchId).toBeDefined();
        if (round === 2) {
          // 第一次 finish：引用检查过 v1 的派工，而最终交付已是 v2。
          return finishCompletion('call_finish_1', {
            status: 'completed',
            summary: 'stale check claimed',
            verification: [{ requirement: 'pnpm test passes', dispatch_ids: [dispatchId!] }],
          });
        }
        staleGaps = lastFinishRejection(messages);
        // 重新检查最终内容后，引用新派工（检查作用于 v2）才允许完成。
        return finishCompletion('call_finish_2', {
          status: 'completed',
          summary: 're-verified final content',
          verification: [{ requirement: 'pnpm test passes', dispatch_ids: [dispatchId!] }],
        });
      }),
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'verify the change and re-verify after edits',
      workspace_path: workspace,
      completion_criteria: ['pnpm test 通过'],
    });
    expect(result.status).toBe('completed');
    expect(result.response).toBe('re-verified final content');
    const stale = staleGaps.find((gap) => gap.code === 'evidence_stale');
    expect(stale).toBeDefined();
    expect(stale?.detail).toMatchObject({ reason: 'check_evidence_stale' });
    const fold = await readFold(runsRoot, runId);
    expect(fold.records).toHaveLength(2);
    expect(fold.finish?.status).toBe('completed');
    // finish 行只引用重新检查最终内容的那次派工。
    expect(fold.finish?.verification).toEqual([
      {
        requirement: 'pnpm test passes',
        outcome: 'passed',
        dispatch_ids: [fold.records[1]!.dispatch_id],
        evidence_refs: [],
      },
    ]);
    expect(fold.records[1]?.evidence?.checks?.[0]).toMatchObject({
      command: 'pnpm test',
      observation: 'complete',
      exit_code: 0,
    });
  });
});

describe('阶段 4：派工生命周期投影事件（真实 journal + fake driver）', () => {
  it('accepted/started/settled 同身份各一条，载荷只含低频元数据', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
    });
    const events: RoleLifecycleEvent[] = [];
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'do the work',
      workspace_path: workspace,
      emit_event: (event) => events.push(event),
    });
    expect(result.status).toBe('completed');

    const accepted = events.filter((event) => event.type === ROLE_DISPATCH_EVENT.accepted);
    const started = events.filter((event) => event.type === ROLE_DISPATCH_EVENT.started);
    const settled = events.filter((event) => event.type === ROLE_DISPATCH_EVENT.settled);
    expect(accepted).toHaveLength(1);
    expect(started).toHaveLength(1);
    expect(settled).toHaveLength(1);
    const dispatchId = accepted[0]!.payload.dispatch_id;
    expect(typeof dispatchId).toBe('string');
    expect(started[0]!.payload.dispatch_id).toBe(dispatchId);
    expect(settled[0]!.payload).toMatchObject({ dispatch_id: dispatchId, status: 'succeeded' });
    expect(settled[0]!.payload.evidence_ref).toMatchObject({
      path: `journal/evidence/${String(dispatchId)}.json`,
    });
    // 低频元数据：完整指令/transcript 不得进投影载荷。
    expect(JSON.stringify(events)).not.toContain('do the work');
  });

  it('typed termination 投影 role_terminated，且不伪造 settled', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      loop: async () => {
        throw new RoleTerminationError({
          code: 'budget_dispatches',
          actor: 'host',
          message: 'dispatch budget exhausted',
        });
      },
    });
    const events: RoleLifecycleEvent[] = [];
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'do the work',
        workspace_path: workspace,
        emit_event: (event) => events.push(event),
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(RoleTerminationError);
    const terminated = events.filter((event) => event.type === ROLE_DISPATCH_EVENT.role_terminated);
    expect(terminated).toHaveLength(1);
    expect(terminated[0]!.payload).toMatchObject({
      code: 'budget_dispatches',
      actor: 'host',
    });
    expect(events.some((event) => event.type === ROLE_DISPATCH_EVENT.settled)).toBe(false);
  });

  it('plan_updated / finish_requested 通过 loop 的观察口接线', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      loop: async (options) => {
        options.on_plan_updated?.('plan: inspect then fix');
        options.on_finish_requested?.({
          status: 'completed',
          verification_count: 2,
          unresolved_count: 1,
        });
        return completedOutcome();
      },
    });
    const events: RoleLifecycleEvent[] = [];
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'do the work',
      workspace_path: workspace,
      emit_event: (event) => events.push(event),
    });
    expect(result.status).toBe('completed');
    const plan = events.filter((event) => event.type === ROLE_DISPATCH_EVENT.plan_updated);
    const finish = events.filter((event) => event.type === ROLE_DISPATCH_EVENT.finish_requested);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.payload).toMatchObject({ plan: 'plan: inspect then fix' });
    expect(finish).toHaveLength(1);
    expect(finish[0]!.payload).toMatchObject({ status: 'completed', verification_count: 2 });
  });

  it('父链既有派工只作 inherited 投影，不伪造当前 Run 的 dispatch', async () => {
    const parentId = 'run_parent_lifecycle';
    const { runsRoot, runId, workspace } = await makeFixture();
    const parentDir = path.join(runsRoot, parentId);
    await fs.mkdir(parentDir, { recursive: true });
    // 恢复链要求工作区基线可证明交付边界；父 Run 的基线属于同一次逻辑执行，必须存在。
    const baseline = await snapshotWorkspaceContent(workspace);
    await fs.mkdir(path.join(parentDir, 'role-autonomy'), { recursive: true });
    await fs.writeFile(
      path.join(parentDir, 'role-autonomy', 'workspace-before.json'),
      JSON.stringify({
        version: 2,
        workspace_path: path.resolve(workspace),
        entries: [...baseline.entries()],
      }),
      'utf8',
    );
    const parent = await RunDispatchJournal.open({
      runDir: parentDir,
      identity: { run_id: parentId, ...IDENTITY },
    });
    const brief = buildExecutionBrief({
      identity: {
        dispatch_id: 'dsp_parent_lifecycle',
        run_id: parentId,
        task_id: IDENTITY.task_id,
        role_id: IDENTITY.role_id,
        sequence: 1,
        accepted_at: '2026-11-13T00:00:00.000Z',
      },
      request: { kind: 'execute', instruction: 'parent dispatch' },
    }).brief;
    await parent.appendAccepted({
      brief,
      brief_sha256: hashExecutionBrief(brief),
      budget_before: {
        dispatches_left: 12,
        role_tokens_left: 120_000,
        deadline_at: '2026-11-13T00:45:00.000Z',
      },
    });
    await parent.appendDispatched({ dispatch_id: 'dsp_parent_lifecycle' });
    const evidence = buildExecutionEvidence({
      dispatch_id: 'dsp_parent_lifecycle',
      observation: {
        transport: { evidence: 'execution_unconfirmed' },
        result: { status: 'succeeded', response: 'parent done' },
      },
    });
    const artifact = await parent.appendEvidence({
      dispatch_id: 'dsp_parent_lifecycle',
      evidence,
    });
    await parent.appendSettled({
      dispatch_id: 'dsp_parent_lifecycle',
      status: 'succeeded',
      evidence,
      evidence_sha256: artifact.sha256,
      violations: [],
    });
    await parent.close();

    // 本 Run 不派工（只读恢复）：投影里只应有 inherited，不应出现当前 Run 的 dispatch 事件。
    const harness = makeHarness({
      runsRoot,
      runId,
      workspace,
      loop: async () => completedOutcome(),
    });
    const events: RoleLifecycleEvent[] = [];
    await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'continue the task',
      workspace_path: workspace,
      restarted_from_run_id: parentId,
      emit_event: (event) => events.push(event),
    });

    const inherited = events.filter((event) => event.type === ROLE_DISPATCH_EVENT.inherited);
    expect(inherited).toHaveLength(1);
    expect(inherited[0]!.payload).toMatchObject({
      source_run_id: parentId,
      dispatch_count: 1,
      by_status: { succeeded: 1 },
      unresolved_dispatch_ids: [],
    });
    // 父链记录只读：当前 Run 的事件流里没有它的 accepted/settled 伪造副本。
    expect(events.filter((event) => event.type === ROLE_DISPATCH_EVENT.accepted)).toHaveLength(0);
    expect(events.filter((event) => event.type === ROLE_DISPATCH_EVENT.settled)).toHaveLength(0);
  });

  it('R4-01：settled 已落盘但事件出口失败，恢复时从 Journal 补发事实（driver 仍只 1 次）', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const first = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
    });
    const firstResult = await first.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'do the work',
      workspace_path: workspace,
      // 事件出口在 settled 落盘之后失败：事实已在 Journal，时间线缺这一条。
      emit_event: (event) => {
        if (event.type === ROLE_DISPATCH_EVENT.settled) {
          throw new Error('event sink unavailable');
        }
      },
    });
    expect(firstResult.status).toBe('completed');
    expect(first.driverCalls()).toBe(1);
    const foldAfterFirst = await readFold(runsRoot, runId);
    expect(foldAfterFirst.records).toHaveLength(1);
    expect(foldAfterFirst.records[0]).toMatchObject({ dispatch_id: 'dsp_1', status: 'succeeded' });
    // 审核复现：settled 已 durable 后事件出口失败；随后 role 写入 completed finish。
    await appendCompletedFinish(runsRoot, runId);

    // 恢复：同一 Run 已有 completed finish → 直接复现终态（不再派工/不再调 LLM），
    // 但必须把 Journal 里已 durable 的派工事实补进投影。
    const recoveredEvents: RoleLifecycleEvent[] = [];
    const second = makeHarness({
      runsRoot,
      runId,
      workspace,
      loop: async () => {
        throw new Error('loop must not run on a recovered finish');
      },
    });
    const recovered = await second.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'do the work',
      workspace_path: workspace,
      emit_event: (event) => recoveredEvents.push(event),
    });
    expect(recovered.status).toBe('completed');
    expect(second.driverCalls()).toBe(0);

    const projection = projectDispatchFacts(
      recoveredEvents.map((event) => ({
        type: event.type,
        payload: event.payload,
        created_at: '2026-11-15T00:00:00.000Z',
      })),
    );
    expect(projection.summary).toMatchObject({
      total: 1,
      by_status: { succeeded: 1 },
      unknown: { count: 0 },
    });
    expect(projection.summary?.last_dispatch).toMatchObject({
      dispatch_id: 'dsp_1',
      status: 'succeeded',
    });

    // 再恢复一次：Journal 不新增行，补投影按 dispatch_id 幂等（重复读取不放大计数）。
    const foldAfterRecovery = await readFold(runsRoot, runId);
    expect(foldAfterRecovery.records).toEqual(foldAfterFirst.records);
    const replay = projectDispatchFacts(
      [...recoveredEvents, ...recoveredEvents].map((event) => ({
        type: event.type,
        payload: event.payload,
        created_at: '2026-11-15T00:00:00.000Z',
      })),
    );
    expect(replay.summary?.total).toBe(1);
    expect(replay.summary?.by_status).toEqual({ succeeded: 1 });
  });

  it('R4-01：全部派工事件缺失时，恢复后仍得到正确派工摘要且不补执行', async () => {
    const { runsRoot, runId, workspace } = await makeFixture();
    const first = makeHarness({
      runsRoot,
      runId,
      workspace,
      sendPrompt: async () => driverResult('succeeded'),
    });
    const firstResult = await first.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'do the work',
      workspace_path: workspace,
      emit_event: () => {
        throw new Error('every lifecycle event write fails');
      },
    });
    expect(firstResult.status).toBe('completed');
    expect(first.driverCalls()).toBe(1);
    expect((await readFold(runsRoot, runId)).records[0]).toMatchObject({ status: 'succeeded' });
    // 审核复现：全部派工事件丢失，但 Journal 的 settled 与 completed finish 都已 durable。
    await appendCompletedFinish(runsRoot, runId);

    const recoveredEvents: RoleLifecycleEvent[] = [];
    const second = makeHarness({
      runsRoot,
      runId,
      workspace,
      loop: async () => {
        throw new Error('loop must not run on a recovered finish');
      },
    });
    const recovered = await second.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'do the work',
      workspace_path: workspace,
      emit_event: (event) => recoveredEvents.push(event),
    });
    expect(recovered.status).toBe('completed');
    expect(second.driverCalls()).toBe(0);

    const projection = projectDispatchFacts(
      recoveredEvents.map((event) => ({
        type: event.type,
        payload: event.payload,
        created_at: '2026-11-15T00:00:00.000Z',
      })),
    );
    expect(projection.summary).toMatchObject({
      total: 1,
      by_status: { succeeded: 1 },
      unknown: { count: 0, dispatch_ids: [] },
    });
    // 补投影只发低频事实，不发指令/摘要正文。
    const serialized = JSON.stringify(recoveredEvents);
    expect(serialized).not.toContain('do the work');
  });
});
