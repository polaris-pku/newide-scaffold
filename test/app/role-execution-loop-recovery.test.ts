/**
 * 阶段 4 恢复行为测试：用**真实 RunDispatchJournal + 真实预算/协调组件**证明「恢复不重复工作」，
 * 并暴露缺口。对应测试矩阵：
 *
 * - JRN-03 / JRN-04 / JRN-06：同一 Run 进程重启、写屏障崩溃窗口、折叠（not_executed/unknown/settled）；
 * - JRN-07：迟到回执只对账、unknown 不自动重派；
 * - JRN-08：子 Journal 不伪造父链派工事实；
 * - TRM-04 / TRM-05：中断可 resume、unknown 不被改写 failed；
 * - RD-SEL-05/06/07：resume_cursor 权威、冻结策略/deadline/预算不因 restart 重置、显式重试需取证。
 *
 * 断言对象是**副作用次数**（driver 调用次数、Journal 行数、同 dispatch 是否重复 settled），
 * 不是只断言返回状态。故障注入与真实进程崩溃区分：
 * - 「受控故障注入」= 包装 `DispatchJournalIo` / `writeFileExclusive` 在指定边界抛错；
 * - 「真实进程崩溃」= 写 durably 前缀后不 close/不写后续（同进程 close 或用
 *   `test/fixtures/role-recovery-child-worker.ts` 起真实子进程后强杀）。
 *
 * 注意：本文件不依赖阶段 4 新增的快照字段/生命周期事件（它们可能尚未落地），只以
 * Journal、task 状态、task.error.code、driver 调用次数与 run 目录产物为断言对象。
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core';
import type { TaskCreateRequest } from '../../src/core';
import {
  buildExecutionBrief,
  buildExecutionEvidence,
  hashExecutionBrief,
} from '../../src/driver';
import type {
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
  ExecutionEvidence,
} from '../../src/driver';
import {
  createNodeDispatchJournalIo,
  RunDispatchJournal,
  SqliteCoordinationStore,
} from '../../src/persistence';
import type {
  DispatchJournalIo,
  RunEvidenceStore,
  RunStageEvidence,
  RunStageEvidenceInput,
  RunStageEvidenceReference,
  TaskCursorInput,
} from '../../src/persistence';
import {
  StageTerminationError,
  TaskExecutionLoop,
  TaskInterruptedError,
  TaskProcessor,
} from '../../src/coordination';
import type {
  StageTermination,
  TaskExecutionLoopExecutors,
  TaskStageExecutionContext,
} from '../../src/coordination';
import type { AgentExecutionResult } from '../../src/protocol/agent-execution';
import type { BufferRepository, MemoryRepository } from '../../src/memory';
import {
  buildRoleFreezeInitInput,
  RoleTerminationError,
} from '../../src/app/role-autonomy-contract';
import type {
  RoleAutonomyEngineRequest,
  RoleBudgetConsumption,
  RoleBudgetLimits,
  RoleDispatchObservation,
  RoleFinishDecision,
  RoleFinishValidatorPort,
  RoleFrozenBudget,
  RoleFrozenRouting,
  RoleLoopOptions,
  RoleLoopOutcome,
  RoleTerminationCode,
} from '../../src/app/role-autonomy-contract';
import {
  reconcileLateDriverResult,
  RoleAutonomyEngine,
} from '../../src/app/role-autonomy-engine';
import { RoleBudget } from '../../src/app/role-autonomy-budget';
import { selectRoleExecutionEngine } from '../../src/app/role-autonomy-selection';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const IDENTITY = { task_id: 'task_1', role_id: 'role_1' } as const;
const RUN = 'run_1';
const FROZEN_AT = '2026-11-13T10:00:00.000Z';
/** 冻结时钟固定，deadline 用远期时间：恢复测试不断言墙钟耗尽，只断言 deadline 不被重置。 */
const FROZEN_CLOCK = (): Date => new Date(FROZEN_AT);
const DEADLINE_AT = '2027-11-13T00:45:00.000Z';
const LIMITS: RoleBudgetLimits = {
  max_dispatches: 12,
  max_role_rounds: 40,
  role_token_budget: 120_000,
  wall_clock_seconds: 2_700,
  dispatch_timeout_ms: 600_000,
};

async function makeRunsRoot(prefix = 'newide-role-recovery-'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

function runDirOf(runsRoot: string, runId: string): string {
  return path.join(runsRoot, runId);
}

async function ensureRunDir(runsRoot: string, runId: string): Promise<string> {
  const runDir = runDirOf(runsRoot, runId);
  await fs.mkdir(runDir, { recursive: true });
  return runDir;
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
      created_at: FROZEN_AT,
      schema_version: SCHEMA_VERSION,
    },
    tool_events: [],
    diagnostics: { driver_id: 'driver_test', duration_ms: 5, notes: [] },
    created_at: FROZEN_AT,
    schema_version: SCHEMA_VERSION,
  };
}

interface FakeDriver {
  handle: DriverRuntimeHandle;
  prompts: DriverPrompt[];
  calls: () => number;
}

function makeFakeDriver(
  sendPrompt?: (input: DriverPrompt) => Promise<DriverRunResult>,
): FakeDriver {
  const prompts: DriverPrompt[] = [];
  let calls = 0;
  const handle = {
    driver_id: 'driver_test',
    session_id: 'session_1',
    capabilities: { supports_session_load: false },
    interrupt: async () => undefined,
    sendPrompt: async (input: DriverPrompt) => {
      calls += 1;
      prompts.push(input);
      return (sendPrompt ?? (async () => driverResult('succeeded')))(input);
    },
  } as unknown as DriverRuntimeHandle;
  return { handle, prompts, calls: () => calls };
}

function completedOutcome(
  dispatches: RoleDispatchObservation[] = [],
  overrides: Partial<RoleLoopOutcome> = {},
): RoleLoopOutcome {
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
      accepted_at: FROZEN_AT,
    },
    response: 'done',
    dispatches,
    usage: { input_tokens: 1, output_tokens: 1, usage_missing: false, role_rounds: 1 },
    zero_dispatch: dispatches.length === 0,
    plan: undefined,
    unresolved_dispatches: [],
    ...overrides,
  };
}

/** role 真正结束时的唯一 durable 写入点（engine 自己不写 finish）。 */
async function appendFinishCompleted(
  options: RoleLoopOptions,
  summary = 'done',
): Promise<void> {
  await options.journal.appendFinish({
    actor: 'role',
    status: 'completed',
    reason: summary,
    evidence_refs: [],
    summary,
  });
}

/** 让 role 显式派一次工（带预算检查/计数，模拟真实 role loop 的 dispatch 工具）。 */
async function dispatchOnce(
  options: RoleLoopOptions,
  input: {
    dispatchId?: string;
    sequence?: number;
    request?: {
      kind: 'investigate' | 'execute' | 'verify';
      instruction: string;
      retry_of?: string;
      reconciliation_ref?: { path: string; sha256: string };
      session?: { mode: 'fresh' | 'reuse'; session_id?: string };
    };
    confirmedSession?: { session_id: string; run_id: string; role_id: string };
  } = {},
): Promise<RoleDispatchObservation> {
  const sequence = input.sequence ?? 1;
  const built = buildExecutionBrief({
    identity: {
      dispatch_id: input.dispatchId ?? 'dsp_1',
      run_id: options.context.run_id,
      task_id: options.context.task_id,
      role_id: options.context.role_id,
      sequence,
      accepted_at: FROZEN_AT,
    },
    request: input.request ?? { kind: 'execute', instruction: 'do the work' },
    ...(input.confirmedSession ? { confirmed_sessions: [input.confirmedSession] } : {}),
  });
  options.budget.assertDispatchAllowed();
  const snapshot = options.budget.snapshot();
  const observation = await options.dispatch.run({
    brief: built.brief,
    brief_sha256: built.brief_sha256,
    budget_before: {
      dispatches_left: Math.max(
        0,
        options.budget.frozen.limits.max_dispatches - snapshot.consumed.dispatches,
      ),
      role_tokens_left: options.budget.frozen.limits.role_token_budget,
      deadline_at: options.budget.frozen.deadline_at,
    },
  });
  options.budget.recordDispatch();
  return observation;
}

function fakeFinishValidator(): RoleFinishValidatorPort {
  return {
    validate: async (): Promise<RoleFinishDecision> => ({ accepted: false, gaps: [] }),
  };
}

interface HarnessOptions {
  runsRoot: string;
  loop: (options: RoleLoopOptions) => Promise<RoleLoopOutcome>;
  driver?: FakeDriver;
  clock?: () => Date;
  journalIo?: DispatchJournalIo;
}

interface Harness {
  engine: RoleAutonomyEngine;
  driver: FakeDriver;
  loopCalls: RoleLoopOptions[];
  budgetInputs: Array<{
    frozen: RoleFrozenBudget;
    consumed: RoleBudgetConsumption;
    port: RoleBudget;
  }>;
}

function makeHarness(options: HarnessOptions): Harness {
  const driver = options.driver ?? makeFakeDriver();
  const loopCalls: RoleLoopOptions[] = [];
  const budgetInputs: Harness['budgetInputs'] = [];
  const engine = new RoleAutonomyEngine({
    runs_root: options.runsRoot,
    llm: { completeWithTools: async () => ({ content: null, tool_calls: undefined }) },
    repository: {} as MemoryRepository,
    buffer_repository: {} as BufferRepository,
    driver_for: () => driver.handle,
    create_budget: (input) => {
      const port = new RoleBudget(input);
      budgetInputs.push({
        frozen: input.frozen,
        consumed: { ...input.consumed },
        port,
      });
      return port;
    },
    create_finish_validator: () => fakeFinishValidator(),
    run_loop: async (loopOptions) => {
      loopCalls.push(loopOptions);
      return options.loop(loopOptions);
    },
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.journalIo ? { journal_io: options.journalIo } : {}),
  });
  return { engine, driver, loopCalls, budgetInputs };
}

function engineRequest(
  overrides: Partial<RoleAutonomyEngineRequest> = {},
): RoleAutonomyEngineRequest {
  return {
    task_id: IDENTITY.task_id,
    run_id: RUN,
    role_id: IDENTITY.role_id,
    instruction: 'do the work',
    ...overrides,
  };
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function readSnapshot(runsRoot: string, runId = RUN) {
  await ensureRunDir(runsRoot, runId);
  const journal = await RunDispatchJournal.peek({
    runDir: runDirOf(runsRoot, runId),
    identity: { run_id: runId, ...IDENTITY },
  });
  return journal.read();
}

async function readFold(runsRoot: string, runId = RUN) {
  await ensureRunDir(runsRoot, runId);
  const journal = await RunDispatchJournal.peek({
    runDir: runDirOf(runsRoot, runId),
    identity: { run_id: runId, ...IDENTITY },
  });
  return journal.fold();
}

function countEvents(snapshot: Awaited<ReturnType<typeof readSnapshot>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of snapshot.lines) {
    counts[line.event] = (counts[line.event] ?? 0) + 1;
  }
  return counts;
}

interface PrefixOptions {
  runId?: string;
  accept?: boolean;
  dispatch?: boolean;
  evidence?: boolean;
  settle?: boolean;
  settleStatus?: 'succeeded' | 'unknown' | 'failed';
  finish?: { status: 'completed' | 'blocked' | 'failed'; summary?: string };
  roleRounds?: Array<{ round: number; input_tokens?: number; output_tokens?: number; tool_calls?: number }>;
  frozen?: {
    limits?: Partial<RoleBudgetLimits>;
    deadline_at?: string;
    evidence_only?: boolean;
    buffer_v2?: boolean;
    routing?: RoleFrozenRouting;
    max_tool_calls?: number;
  };
  dispatchId?: string;
  sequence?: number;
}

interface PrefixResult {
  runDir: string;
  runId: string;
  dispatchId: string;
  brief: ReturnType<typeof buildExecutionBrief>['brief'];
  evidence?: ExecutionEvidence;
  evidenceRef?: { path: string; sha256: string };
}

/**
 * 用真实 Journal 写一个 durable 前缀后 close（=「受控的同进程崩溃边界」）：
 * 进程已死/已退出，但 durable 行仍在，后续恢复必须只依据这些事实折叠。
 */
async function writeJournalPrefix(
  runsRoot: string,
  options: PrefixOptions = {},
): Promise<PrefixResult> {
  const runId = options.runId ?? RUN;
  const runDir = await ensureRunDir(runsRoot, runId);
  const frozenLimits: RoleBudgetLimits = { ...LIMITS, ...(options.frozen?.limits ?? {}) };
  const deadlineAt = options.frozen?.deadline_at ?? DEADLINE_AT;
  const dispatchId = options.dispatchId ?? `dsp_${runId}`;
  const sequence = options.sequence ?? 1;
  const journal = await RunDispatchJournal.open({
    runDir,
    identity: { run_id: runId, ...IDENTITY },
  });
  try {
    await journal.appendInit({
      ...buildRoleFreezeInitInput({
        limits: frozenLimits,
        deadline_at: deadlineAt,
        ...(options.frozen?.routing ? { routing: options.frozen.routing } : {}),
        evidence_only: options.frozen?.evidence_only ?? false,
        buffer_v2: options.frozen?.buffer_v2 ?? false,
        ...(options.frozen?.max_tool_calls !== undefined
          ? { max_tool_calls: options.frozen.max_tool_calls }
          : {}),
      }),
      at: FROZEN_AT,
    });

    const brief = buildExecutionBrief({
      identity: {
        dispatch_id: dispatchId,
        run_id: runId,
        task_id: IDENTITY.task_id,
        role_id: IDENTITY.role_id,
        sequence,
        accepted_at: FROZEN_AT,
      },
      request: { kind: 'execute', instruction: 'durable prefix work' },
    }).brief;

    if (options.accept) {
      await journal.appendAccepted({
        brief,
        brief_sha256: hashExecutionBrief(brief),
        budget_before: {
          dispatches_left: frozenLimits.max_dispatches,
          role_tokens_left: frozenLimits.role_token_budget,
          deadline_at: deadlineAt,
        },
      });
    }
    if (options.dispatch) {
      await journal.appendDispatched({ dispatch_id: dispatchId, at: FROZEN_AT });
    }

    let evidence: ExecutionEvidence | undefined;
    let evidenceRef: { path: string; sha256: string } | undefined;
    if (options.evidence) {
      const settleStatus = options.settleStatus ?? 'succeeded';
      evidence = buildExecutionEvidence({
        dispatch_id: dispatchId,
        observation:
          settleStatus === 'succeeded'
            ? {
                transport: { evidence: 'execution_unconfirmed' },
                result: { status: 'succeeded', response: 'prefix done' },
              }
            : settleStatus === 'failed'
              ? {
                  transport: { evidence: 'execution_unconfirmed' },
                  result: { status: 'failed' },
                  error: { code: 'E_FAIL', message: 'prefix failed', retryable: false },
                }
              : { transport: { evidence: 'execution_unconfirmed' } },
      });
      const artifact = await journal.appendEvidence({ dispatch_id: dispatchId, evidence });
      evidenceRef = artifact.ref;
    }
    if (options.settle) {
      const settledEvidence = evidence;
      const settledRef = evidenceRef;
      if (settledEvidence === undefined || settledRef === undefined) {
        throw new Error('prefix settle requires evidence');
      }
      await journal.appendSettled({
        dispatch_id: dispatchId,
        status: settledEvidence.status,
        evidence: settledEvidence,
        evidence_sha256: settledRef.sha256,
        violations: [],
        at: FROZEN_AT,
      });
    }
    for (const round of options.roleRounds ?? []) {
      await journal.appendRoleRound({
        round: round.round,
        usage_missing: false,
        ...(round.input_tokens !== undefined ? { input_tokens: round.input_tokens } : {}),
        ...(round.output_tokens !== undefined ? { output_tokens: round.output_tokens } : {}),
        ...(round.tool_calls !== undefined ? { tool_calls: round.tool_calls } : {}),
        at: FROZEN_AT,
      });
    }
    if (options.finish) {
      await journal.appendFinish({
        actor: 'role',
        status: options.finish.status,
        reason: options.finish.summary ?? 'prefix finish',
        evidence_refs: [],
        summary: options.finish.summary ?? 'prefix finish',
      });
    }
    return {
      runDir,
      runId,
      dispatchId,
      brief,
      ...(evidence !== undefined ? { evidence } : {}),
      ...(evidenceRef !== undefined ? { evidenceRef } : {}),
    };
  } finally {
    await journal.close();
  }
}

function journalLineCount(snapshot: Awaited<ReturnType<typeof readSnapshot>>): number {
  return snapshot.lines.length;
}

async function expectTerminationCode(
  promise: Promise<unknown>,
  code: RoleTerminationCode,
): Promise<RoleTerminationError> {
  const error = await catchError(promise);
  expect(error).toBeInstanceOf(RoleTerminationError);
  const termination = error as RoleTerminationError;
  expect(termination.termination.code).toBe(code);
  return termination;
}

// ─────────────────────────────────────────────────────────────
// 1. 同一 Run 进程重启（JRN-03 / JRN-04 / TRM-05）
// ─────────────────────────────────────────────────────────────

describe('同一 Run 进程重启：只按 Journal 折叠恢复，不重复跑 driver', () => {
  it('JRN-03：已 settled 且已有 finish 的 Run 恢复时直接复现终态（loop/driver 均 0 次，Journal 不新增行）', async () => {
    const runsRoot = await makeRunsRoot();
    await writeJournalPrefix(runsRoot, {
      accept: true,
      dispatch: true,
      evidence: true,
      settle: true,
      finish: { status: 'completed', summary: 'already done before restart' },
    });
    const before = await readSnapshot(runsRoot);
    const harness = makeHarness({
      runsRoot,
      loop: async () => {
        throw new Error('loop must not run for a finished Run');
      },
    });

    const result = await harness.engine.run(engineRequest());

    expect(result.status).toBe('completed');
    expect(result.response).toBe('already done before restart');
    expect(harness.loopCalls).toHaveLength(0);
    expect(harness.driver.calls()).toBe(0);
    const after = await readSnapshot(runsRoot);
    // 恢复路径只复现终态（transcript 是 run 目录产物），Journal 不应被追加任何事件。
    expect(journalLineCount(after)).toBe(journalLineCount(before));
    expect(countEvents(after)).toMatchObject({ accepted: 1, dispatched: 1, settled: 1 });
  });

  it('JRN-03：accepted-only 折叠为 not_executed；恢复不会自动重派 driver', async () => {
    const runsRoot = await makeRunsRoot();
    const prefix = await writeJournalPrefix(runsRoot, { accept: true });
    const harness = makeHarness({
      runsRoot,
      loop: async (options) => {
        // accepted-only 没有证据，不进入 recovered_dispatches，但必须计入 recovered_dispatch_count。
        expect(options.context.recovered_dispatches ?? []).toHaveLength(0);
        expect(options.context.recovered_dispatch_count).toBe(1);
        await appendFinishCompleted(options, 'accepted but never dispatched');
        return completedOutcome();
      },
    });

    const result = await harness.engine.run(engineRequest());

    expect(result.status).toBe('completed');
    expect(harness.driver.calls()).toBe(0);
    const fold = await readFold(runsRoot);
    expect(fold.records).toHaveLength(1);
    expect(fold.records[0]).toMatchObject({
      dispatch_id: prefix.dispatchId,
      phase: 'accepted',
      status: 'not_executed',
    });
    expect(countEvents(await readSnapshot(runsRoot)).settled ?? 0).toBe(0);
  });

  it('RD-SEL-07/JRN-04：accepted-only 只有在 role 显式 retry_of 时才重派一次（新 dispatch_id）', async () => {
    const runsRoot = await makeRunsRoot();
    const prefix = await writeJournalPrefix(runsRoot, { accept: true });
    const harness = makeHarness({
      runsRoot,
      loop: async (options) => {
        const observation = await dispatchOnce(options, {
          dispatchId: 'dsp_retry',
          sequence: 2,
          request: {
            kind: 'execute',
            instruction: 'explicit retry of the never-dispatched work',
            retry_of: prefix.dispatchId,
          },
        });
        await appendFinishCompleted(options, 'retried explicitly');
        return completedOutcome([observation]);
      },
    });

    const result = await harness.engine.run(engineRequest());

    expect(result.status).toBe('completed');
    expect(harness.driver.calls()).toBe(1);
    const fold = await readFold(runsRoot);
    expect(fold.records).toHaveLength(2);
    // 原 dispatch 事实不被改写，仍是 not_executed；重试是独立的新 dispatch。
    expect(fold.records[0]).toMatchObject({
      dispatch_id: prefix.dispatchId,
      status: 'not_executed',
      phase: 'accepted',
    });
    expect(fold.records[1]).toMatchObject({
      dispatch_id: 'dsp_retry',
      status: 'succeeded',
    });
    expect(fold.records[1]?.brief.retry_of).toBe(prefix.dispatchId);
  });

  it.each([
    {
      name: 'dispatched-only',
      prefix: { accept: true, dispatch: true },
    },
    {
      name: 'dispatched + evidence（settled 前崩溃）',
      prefix: { accept: true, dispatch: true, evidence: true },
    },
  ])(
    'JRN-04/TRM-05：$name 折叠为 unknown，恢复既不改写 failed 也不自动重派',
    async ({ prefix: prefixOptions }) => {
      const runsRoot = await makeRunsRoot();
      const prefix = await writeJournalPrefix(runsRoot, prefixOptions);
      let recoveredCount = 0;
      let recoveredUnresolved: string[] = [];
      const harness = makeHarness({
        runsRoot,
        loop: async (options) => {
          recoveredCount = options.context.recovered_dispatch_count ?? 0;
          recoveredUnresolved = [...(options.context.recovered_unresolved_dispatches ?? [])];
          // 故意让 role 声称 completed：引擎最终闸门必须拒绝未收束 unknown。
          return completedOutcome([], {
            unresolved_dispatches: recoveredUnresolved,
          });
        },
      });

      const error = await expectTerminationCode(
        harness.engine.run(engineRequest()),
        'dispatch_unknown_unresolved',
      );
      expect(recoveredCount).toBe(1);
      expect(recoveredUnresolved).toEqual([prefix.dispatchId]);
      expect(harness.driver.calls()).toBe(0);
      expect((error.termination.details?.unresolved_dispatches as string[]) ?? []).toEqual([
        prefix.dispatchId,
      ]);
      const fold = await readFold(runsRoot);
      expect(fold.records).toHaveLength(1);
      // unknown 是事实：不能被恢复流程改写成 failed / succeeded。
      expect(fold.records[0]).toMatchObject({
        dispatch_id: prefix.dispatchId,
        status: 'unknown',
        phase: 'dispatched',
      });
      const counts = countEvents(await readSnapshot(runsRoot));
      expect(counts.accepted).toBe(1);
      expect(counts.dispatched).toBe(1);
      expect(counts.settled ?? 0).toBe(0);
    },
  );

  it('RD-SEL-07：unknown 的原 brief 重派必须带可验证 reconciliation_ref；不带证据被拒且 driver 0 次', async () => {
    const runsRoot = await makeRunsRoot();
    const prefix = await writeJournalPrefix(runsRoot, { accept: true, dispatch: true });
    const harness = makeHarness({
      runsRoot,
      loop: async (options) => {
        await dispatchOnce(options, {
          dispatchId: 'dsp_retry_without_evidence',
          sequence: 2,
          request: {
            kind: 'execute',
            instruction: 'retry the unknown dispatch',
            retry_of: prefix.dispatchId,
          },
        });
        await appendFinishCompleted(options);
        return completedOutcome();
      },
    });

    const error = await expectTerminationCode(
      harness.engine.run(engineRequest()),
      'journal_write_failed',
    );
    expect(error.termination.details).toMatchObject({
      stage: 'accepted',
      barrier_code: 'accepted_write_failed',
      driver_invoked: false,
    });
    expect(harness.driver.calls()).toBe(0);
    const fold = await readFold(runsRoot);
    expect(fold.records).toHaveLength(1);
    expect(fold.records[0]?.status).toBe('unknown');
  });

  it('RD-SEL-07：带已登记 reconciliation_ref 的显式 retry 才被接受（driver 恰好一次，unknown 记录保留）', async () => {
    const runsRoot = await makeRunsRoot();
    const prefix = await writeJournalPrefix(runsRoot, { accept: true, dispatch: true });

    // 先为 unknown dispatch 落一份受控 evidence 并取得它的 ref（恢复时 role 用它做取证）。
    const runDir = runDirOf(runsRoot, RUN);
    const evidenceJournal = await RunDispatchJournal.open({
      runDir,
      identity: { run_id: RUN, ...IDENTITY },
    });
    const reconciliationEvidence = buildExecutionEvidence({
      dispatch_id: prefix.dispatchId,
      observation: {
        transport: { evidence: 'execution_unconfirmed' },
        result: { status: 'succeeded', response: 'reconciled inspection evidence' },
      },
    });
    const reconciliationRef = (
      await evidenceJournal.appendEvidence({
        dispatch_id: prefix.dispatchId,
        evidence: reconciliationEvidence,
      })
    ).ref;
    await evidenceJournal.close();

    const harness = makeHarness({
      runsRoot,
      loop: async (options) => {
        // 恢复链的 evidence 注册是受控 ref 的唯一入口；role 显式引用它作为 reconciliation_ref。
        await options.journal.registerEvidenceRef(reconciliationRef);
        const observation = await dispatchOnce(options, {
          dispatchId: 'dsp_retry_with_evidence',
          sequence: 2,
          request: {
            kind: 'execute',
            instruction: 'retry the unknown dispatch with evidence',
            retry_of: prefix.dispatchId,
            reconciliation_ref: reconciliationRef,
          },
        });
        await appendFinishCompleted(options, 'unknown resolved by explicit retry');
        return completedOutcome([observation]);
      },
    });

    const result = await harness.engine.run(engineRequest());

    expect(result.status).toBe('completed');
    expect(harness.driver.calls()).toBe(1);
    const fold = await readFold(runsRoot);
    expect(fold.records).toHaveLength(2);
    expect(fold.records[0]).toMatchObject({
      dispatch_id: prefix.dispatchId,
      status: 'unknown',
    });
    expect(fold.records[1]?.brief).toMatchObject({
      retry_of: prefix.dispatchId,
      reconciliation_ref: reconciliationRef,
    });
    expect(fold.records[1]?.status).toBe('succeeded');
  });
});

// ─────────────────────────────────────────────────────────────
// 2. 崩溃窗口：写屏障每一步之前/之后（JRN-06）
// ─────────────────────────────────────────────────────────────

interface InjectionWindow {
  /** 崩溃/故障发生的边界。 */
  at: 'accepted' | 'dispatched' | 'evidence' | 'settled';
  /** `before` = 该边界 durable 写入被注入失败（受控故障注入）；`after` = 该边界已 durable 后崩溃。 */
  side: 'before' | 'after';
}

interface CrashWindowCase {
  name: string;
  window: InjectionWindow;
  /** `after` 窗口在崩溃前已 durable 的前缀。 */
  prefix?: PrefixOptions;
  /** driver 在崩溃/故障前是否已被调用。 */
  driverCallsBeforeCrash: number;
  /** 受控故障注入时的期望 typed termination（`after` 窗口不需要）。 */
  expectedError?: {
    code: RoleTerminationCode;
    stage: 'accepted' | 'dispatched' | 'evidence' | 'settled';
  };
  /** 恢复后折叠出的状态（按 Journal 事实）。 */
  recoveredStatus: 'not_executed' | 'unknown' | 'succeeded';
  /** 恢复后的 role 声称 completed 时引擎的最终结果。 */
  recoveryOutcome: 'completed' | 'dispatch_unknown_unresolved';
  /** 崩溃/故障后 Journal 里是否已有该 dispatch 的 accepted 记录（accepted 前失败没有）。 */
  hasDispatchRecord?: boolean;
}

const CRASH_WINDOWS: CrashWindowCase[] = [
  {
    name: 'accepted 前（accepted durable 写失败，driver 从未调用）',
    window: { at: 'accepted', side: 'before' },
    driverCallsBeforeCrash: 0,
    expectedError: { code: 'journal_write_failed', stage: 'accepted' },
    recoveredStatus: 'not_executed',
    recoveryOutcome: 'completed',
    hasDispatchRecord: false,
  },
  {
    name: 'accepted 后（accepted durable 后崩溃，dispatched 前）',
    window: { at: 'accepted', side: 'after' },
    prefix: { accept: true },
    driverCallsBeforeCrash: 0,
    recoveredStatus: 'not_executed',
    recoveryOutcome: 'completed',
  },
  {
    name: 'dispatched 前（dispatched durable 写失败，driver 从未调用）',
    window: { at: 'dispatched', side: 'before' },
    driverCallsBeforeCrash: 0,
    expectedError: { code: 'journal_write_failed', stage: 'dispatched' },
    recoveredStatus: 'not_executed',
    recoveryOutcome: 'completed',
  },
  {
    name: 'dispatched 后（driver 调用前崩溃）',
    window: { at: 'dispatched', side: 'after' },
    prefix: { accept: true, dispatch: true },
    driverCallsBeforeCrash: 0,
    recoveredStatus: 'unknown',
    recoveryOutcome: 'dispatch_unknown_unresolved',
  },
  {
    name: 'evidence 前（evidence 写失败，driver 已调用一次）',
    window: { at: 'evidence', side: 'before' },
    driverCallsBeforeCrash: 1,
    expectedError: { code: 'evidence_write_failed', stage: 'evidence' },
    recoveredStatus: 'unknown',
    recoveryOutcome: 'dispatch_unknown_unresolved',
  },
  {
    name: 'evidence 后（evidence durable 后崩溃，settled 前）',
    window: { at: 'evidence', side: 'after' },
    prefix: { accept: true, dispatch: true, evidence: true },
    driverCallsBeforeCrash: 0,
    recoveredStatus: 'unknown',
    recoveryOutcome: 'dispatch_unknown_unresolved',
  },
  {
    name: 'settled 前（settled durable 写失败，evidence 已落盘）',
    window: { at: 'settled', side: 'before' },
    driverCallsBeforeCrash: 1,
    expectedError: { code: 'journal_write_failed', stage: 'settled' },
    recoveredStatus: 'unknown',
    recoveryOutcome: 'dispatch_unknown_unresolved',
  },
  {
    name: 'settled 后（settled durable 后崩溃，finish 前）',
    window: { at: 'settled', side: 'after' },
    prefix: { accept: true, dispatch: true, evidence: true, settle: true },
    driverCallsBeforeCrash: 0,
    recoveredStatus: 'succeeded',
    recoveryOutcome: 'completed',
  },
];

/** 包装真实 IO：在指定 Journal 事件或 evidence 写时一次性抛错（受控故障注入）。 */
function createFaultyJournalIo(window: InjectionWindow): {
  io: DispatchJournalIo;
  writes: string[];
} {
  const base = createNodeDispatchJournalIo();
  const writes: string[] = [];
  let injected = false;
  const io: DispatchJournalIo = {
    ...base,
    async appendLineWithFsync(filePath: string, line: string) {
      let event: string | undefined;
      try {
        const parsed = JSON.parse(line) as { event?: unknown };
        event = typeof parsed.event === 'string' ? parsed.event : undefined;
      } catch {
        event = undefined;
      }
      if (event !== undefined) writes.push(event);
      if (!injected && window.side === 'before' && event === window.at) {
        injected = true;
        const error = new Error(`injected ${window.at} journal write failure`) as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return base.appendLineWithFsync(filePath, line);
    },
    async writeFileExclusive(filePath: string, data: Uint8Array) {
      if (
        !injected &&
        window.side === 'before' &&
        window.at === 'evidence' &&
        filePath.includes(`${path.sep}evidence${path.sep}`)
      ) {
        injected = true;
        const error = new Error('injected evidence write failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return base.writeFileExclusive(filePath, data);
    },
  };
  return { io, writes };
}

describe('崩溃窗口：accepted/dispatched/evidence/settled 前后恢复都不重复 driver 调用', () => {
  for (const windowCase of CRASH_WINDOWS) {
    it(`${windowCase.window.at}-${windowCase.window.side}：${windowCase.name}`, async () => {
      const runsRoot = await makeRunsRoot();
      const prefix =
        windowCase.window.side === 'after'
          ? await writeJournalPrefix(runsRoot, windowCase.prefix)
          : undefined;
      const dispatchId = prefix?.dispatchId ?? 'dsp_1';

      // 阶段 A：受控故障注入（before 窗口）或 durable 前缀后崩溃（after 窗口，已由 writeJournalPrefix 完成）。
      if (windowCase.window.side === 'before') {
        const faulty = createFaultyJournalIo(windowCase.window);
        const faultHarness = makeHarness({
          runsRoot,
          clock: FROZEN_CLOCK,
          journalIo: faulty.io,
          loop: async (options) => {
            await dispatchOnce(options, { dispatchId: 'dsp_1', sequence: 1 });
            await appendFinishCompleted(options);
            return completedOutcome();
          },
        });
        const error = await expectTerminationCode(
          faultHarness.engine.run(engineRequest()),
          windowCase.expectedError!.code,
        );
        expect(error.termination.details).toMatchObject({
          stage: windowCase.expectedError!.stage,
        });
        expect(faultHarness.driver.calls()).toBe(windowCase.driverCallsBeforeCrash);
        // driver 之前失败的屏障必须明确声明「未执行」（side_effect_state 是给恢复方的实情）。
        if (windowCase.driverCallsBeforeCrash === 0) {
          expect(error.termination.details).toMatchObject({
            driver_invoked: false,
            side_effect_state: 'not_executed',
          });
        } else {
          expect(error.termination.details).toMatchObject({
            driver_invoked: true,
            side_effect_state: 'unknown',
          });
        }
      }

      // 阶段 B：用真实 IO 重新打开同一 run_dir 恢复。
      let recoveredUnresolved: string[] = [];
      let recoveredCount = 0;
      const recoveryHarness = makeHarness({
        runsRoot,
        clock: FROZEN_CLOCK,
        loop: async (options) => {
          recoveredCount = options.context.recovered_dispatch_count ?? 0;
          recoveredUnresolved = [...(options.context.recovered_unresolved_dispatches ?? [])];
          if (windowCase.recoveryOutcome === 'dispatch_unknown_unresolved') {
            return completedOutcome([], { unresolved_dispatches: recoveredUnresolved });
          }
          await appendFinishCompleted(options, 'recovered without replay');
          return completedOutcome();
        },
      });

      const hasRecord = windowCase.hasDispatchRecord ?? true;
      if (windowCase.recoveryOutcome === 'dispatch_unknown_unresolved') {
        await expectTerminationCode(
          recoveryHarness.engine.run(engineRequest()),
          'dispatch_unknown_unresolved',
        );
        expect(recoveredUnresolved).toEqual([dispatchId]);
      } else {
        const result = await recoveryHarness.engine.run(engineRequest());
        expect(result.status).toBe('completed');
        expect(recoveredCount).toBe(hasRecord ? 1 : 0);
      }

      // 副作用次数：恢复永远不会再调用 driver。
      expect(recoveryHarness.driver.calls()).toBe(0);
      expect(recoveredUnresolved).toEqual(
        windowCase.recoveryOutcome === 'dispatch_unknown_unresolved' ? [dispatchId] : [],
      );

      const fold = await readFold(runsRoot);
      expect(fold.records).toHaveLength(hasRecord ? 1 : 0);
      if (hasRecord) {
        expect(fold.records[0]).toMatchObject({
          dispatch_id: dispatchId,
          status: windowCase.recoveredStatus,
        });
      }
      const counts = countEvents(await readSnapshot(runsRoot));
      // 同一 dispatch 不重复：每次 attempt 只有一组 accepted/dispatched/settled。
      // accepted/dispatched 行数取决于崩溃边界：accepted 边界崩溃时没有 dispatched 行。
      const expectedDispatchedLines =
        windowCase.window.at === 'accepted' ||
        (windowCase.window.at === 'dispatched' && windowCase.window.side === 'before')
          ? 0
          : 1;
      expect(counts.accepted ?? 0).toBe(hasRecord ? 1 : 0);
      expect(counts.dispatched ?? 0).toBe(expectedDispatchedLines);
      expect(counts.settled ?? 0).toBe(windowCase.recoveredStatus === 'succeeded' ? 1 : 0);
    });
  }

  it('JRN-05/06：末尾半写尾可修复（原字节/hash 侧车 + repair 行），且不触发重派', async () => {
    const runsRoot = await makeRunsRoot();
    const prefix = await writeJournalPrefix(runsRoot, { accept: true });
    const journalPath = path.join(runDirOf(runsRoot, RUN), 'journal', 'dispatches.jsonl');
    // 真实进程在写 dispatched 行中途被强杀：只留下没有换行符的残缺字节。
    await fs.appendFile(journalPath, '{"event":"dispatched","dispatch_id":"dsp_', 'utf8');

    const harness = makeHarness({
      runsRoot,
      clock: FROZEN_CLOCK,
      loop: async (options) => {
        expect(options.context.recovered_dispatch_count).toBe(1);
        await appendFinishCompleted(options, 'repaired half-written tail');
        return completedOutcome();
      },
    });
    const result = await harness.engine.run(engineRequest());

    expect(result.status).toBe('completed');
    expect(harness.driver.calls()).toBe(0);
    const snapshot = await readSnapshot(runsRoot);
    expect(snapshot.status).toBe('ok');
    expect(snapshot.repairs).toHaveLength(1);
    const repair = snapshot.repairs[0];
    expect(repair?.discarded_tail_ref.path).toMatch(/^journal\/repair\/.*\.tail$/);
    // 原始残缺字节被原样保存到侧车，且 hash 与 repair 行一致。
    const sidecar = await fs.readFile(
      path.join(runDirOf(runsRoot, RUN), repair!.discarded_tail_ref.path),
      'utf8',
    );
    expect(sidecar).toBe('{"event":"dispatched","dispatch_id":"dsp_');
    const fold = await readFold(runsRoot);
    expect(fold.records).toHaveLength(1);
    expect(fold.records[0]).toMatchObject({
      dispatch_id: prefix.dispatchId,
      status: 'not_executed',
    });
  });

  it('JRN-05：中间坏行（无 repair 可覆盖）fail closed：journal_corrupt 且 driver 0 次', async () => {
    const runsRoot = await makeRunsRoot();
    await writeJournalPrefix(runsRoot, { accept: true });
    const journalPath = path.join(runDirOf(runsRoot, RUN), 'journal', 'dispatches.jsonl');
    const before = await fs.readFile(journalPath, 'utf8');
    // 把坏行插到**中间**（不是最后一行）：末尾半写是可修复的，中间坏行必须 fail closed。
    const lineBreak = before.indexOf('\n');
    if (lineBreak < 0) throw new Error('prefix journal does not contain a terminated line');
    const corrupted = `${before.slice(0, lineBreak + 1)}{}\n${before.slice(lineBreak + 1)}`;
    await fs.writeFile(journalPath, corrupted, 'utf8');
    const corruptedBytes = await fs.readFile(journalPath);

    const harness = makeHarness({
      runsRoot,
      clock: FROZEN_CLOCK,
      loop: async () => {
        throw new Error('corrupt journal must never reach the role loop');
      },
    });
    const error = await expectTerminationCode(
      harness.engine.run(engineRequest()),
      'journal_corrupt',
    );
    // 引擎把 fold 失败包装成 journal_corrupt，并把底层 corrupt_line 诊断放进 details.cause。
    expect(error.termination.details).toMatchObject({ cause: expect.any(String) });
    expect(harness.loopCalls).toHaveLength(0);
    expect(harness.driver.calls()).toBe(0);
    // fail closed：损坏文件不被静默重写，原始 accepted 行原样保留。
    const after = await fs.readFile(journalPath);
    expect(after.equals(corruptedBytes)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. checkpoint / task resume（TRM-04 / TRM-05）
// ─────────────────────────────────────────────────────────────

class MemoryEvidenceStore implements RunEvidenceStore {
  private readonly values = new Map<string, RunStageEvidence>();

  async writeStage(input: RunStageEvidenceInput): Promise<RunStageEvidenceReference> {
    const reference = {
      uri: `memory://${input.run_id}/${input.stage}`,
      sha256: String(input.stage.length).padStart(64, '0'),
    };
    this.values.set(`${input.run_id}:${input.stage}`, { ...reference, evidence: input.evidence });
    return reference;
  }

  async writeFailure(input: RunStageEvidenceInput): Promise<RunStageEvidenceReference> {
    const reference = {
      uri: `memory://${input.run_id}/${input.stage}.failure`,
      sha256: String(`${input.stage}.failure`.length).padStart(64, '0'),
    };
    this.values.set(`${input.run_id}:${input.stage}:failure`, {
      ...reference,
      evidence: input.evidence,
    });
    return reference;
  }

  async readStage(
    input: Pick<RunStageEvidenceInput, 'run_id' | 'stage'>,
  ): Promise<RunStageEvidence | undefined> {
    return this.values.get(`${input.run_id}:${input.stage}`);
  }

  async readFailure(
    input: Pick<RunStageEvidenceInput, 'run_id' | 'stage'>,
  ): Promise<RunStageEvidence | undefined> {
    return this.values.get(`${input.run_id}:${input.stage}:failure`);
  }
}

const TASK_REQUEST: TaskCreateRequest = {
  spec: 'execute the durable role task',
  completion_criteria: ['work is durable'],
};
const SELECT_INPUT: TaskCursorInput = {
  cursor: 'select_agent',
  seed: 'seed_recovery',
  candidate_ids: ['role_1'],
};
const CHANGESET_REF = 'artifact_changeset_recovery';
const CHANGESET_SHA = 'd'.repeat(64);

interface TaskLoopHarness {
  store: SqliteCoordinationStore;
  processor: TaskProcessor;
  loop: TaskExecutionLoop;
  calls: string[];
}

/**
 * 真实 TaskProcessor/TaskExecutionLoop 接线：execute_agent 直接调用真实 role 引擎，
 * 并把 role 层 typed termination 在 stage 边界包装成 `StageTerminationError`
 * （与生产 stage executor 相同，原因码才能落到 task.error.code）。
 */
function makeTaskLoopHarness(input: {
  runsRoot: string;
  workspace: string;
  engine: RoleAutonomyEngine;
  onExecuteAgent?: (
    context: TaskStageExecutionContext<'execute_agent'>,
    result: AgentExecutionResult,
  ) => void;
}): TaskLoopHarness {
  const store = new SqliteCoordinationStore(':memory:');
  let sequence = 0;
  const processor = new TaskProcessor(store, {
    now: () => `2026-07-19T04:00:${String(sequence).padStart(2, '0')}.000Z`,
    createEventId: () => `recovery_event_${String(++sequence)}`,
  });
  const calls: string[] = [];
  const executors: TaskExecutionLoopExecutors = {
    select_agent: {
      execute: async () => {
        calls.push('select_agent');
        return { winner_agent_id: IDENTITY.role_id, evidence: { winner_agent_id: IDENTITY.role_id } };
      },
    },
    execute_agent: {
      execute: async (context) => {
        calls.push('execute_agent');
        let result: AgentExecutionResult;
        try {
          result = await input.engine.run({
            task_id: context.task_id,
            run_id: context.run_id,
            role_id: IDENTITY.role_id,
            instruction: context.task_request.spec,
            workspace_path: context.workspace_path,
            ...(context.restarted_from_run_id !== undefined
              ? { restarted_from_run_id: context.restarted_from_run_id }
              : {}),
            ...(context.signal !== undefined ? { signal: context.signal } : {}),
          });
        } catch (error) {
          if (error instanceof RoleTerminationError) {
            throw new StageTerminationError(error.termination as StageTermination);
          }
          throw error;
        }
        input.onExecuteAgent?.(context, result);
        return {
          changeset_ref: CHANGESET_REF,
          expected_sha256: CHANGESET_SHA,
          agent_id: IDENTITY.role_id,
          session_id: 'session_1',
          evidence: {
            status: 'completed',
            execution_engine: result.diagnostics.execution_engine,
          },
        };
      },
    },
    council: {
      execute: async () => {
        throw new Error('Council must not run in a solo role recovery test');
      },
    },
    gate: {
      execute: async () => {
        calls.push('gate');
        return { evidence: { status: 'skipped' } };
      },
    },
    deliver: {
      execute: async (context) => {
        calls.push('deliver');
        return {
          final_output: {
            artifact_ref: context.cursor_input.changeset_ref,
            sha256: context.cursor_input.expected_sha256,
            workspace_path: path.join(input.workspace, 'result.ts'),
          },
          evidence: { files_written: ['result.ts'] },
        };
      },
    },
  };
  const loop = new TaskExecutionLoop({
    processor,
    evidence_store: new MemoryEvidenceStore(),
    executors,
    create_invocation_id: (cursor) => `invocation_${cursor}_${String(++sequence)}`,
  });
  return { store, processor, loop, calls };
}

async function beginFirstRun(
  processor: TaskProcessor,
  workspace: string,
): Promise<void> {
  processor.beginRun({
    task_id: IDENTITY.task_id,
    run_id: 'run_task_1',
    task_request: TASK_REQUEST,
    workspace_path: workspace,
    mode: 'single_agent',
    cursor_input: SELECT_INPUT,
  });
}

function beginCheckpointResume(
  processor: TaskProcessor,
  store: SqliteCoordinationStore,
  workspace: string,
  nextRunId: string,
): string {
  const checkpoint = store.getLatestCheckpoint(IDENTITY.task_id);
  if (!checkpoint || !checkpoint.cursor_input) {
    throw new Error('interrupted Run did not persist a resumable checkpoint');
  }
  processor.beginRun({
    task_id: IDENTITY.task_id,
    run_id: nextRunId,
    task_request: TASK_REQUEST,
    workspace_path: workspace,
    mode: 'single_agent',
    run_intent: { type: 'checkpoint_resume', strategy: 'from_checkpoint' },
    restarted_from_run_id: checkpoint.run_id,
    resume_checkpoint_id: checkpoint.checkpoint_id,
    requested_resume_cursor: checkpoint.resume_cursor,
    cursor_input: checkpoint.cursor_input,
  });
  return checkpoint.run_id;
}

function findControl(
  snapshot: Awaited<ReturnType<typeof readSnapshot>>,
  event: 'init' | 'finish' | 'role_round' | 'repair',
) {
  return snapshot.controls.find((entry) => entry.event === event);
}

describe('checkpoint / task resume：resume_cursor 权威、冻结预算不重置、driver 不重跑', () => {
  it('TRM-04/JRN-06：派工 settled 后中断 → checkpoint resume 复用 Journal 事实（driver 0 次新增、deadline/预算不重置）', async () => {
    const runsRoot = await makeRunsRoot('newide-role-resume-');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-role-resume-ws-'));
    temporaryDirectories.push(workspace);
    const driver = makeFakeDriver();
    const interruptController = new AbortController();
    let resumeConsumed: RoleBudgetConsumption | undefined;
    const harness = makeHarness({
      runsRoot,
      clock: FROZEN_CLOCK,
      driver,
      loop: async (options) => {
        if (options.context.run_id === 'run_task_1') {
          const observation = await dispatchOnce(options, {
            dispatchId: 'dsp_task_1',
            sequence: 1,
          });
          await options.budget.recordRound(
            1,
            { input_tokens: 10, output_tokens: 5 },
            FROZEN_AT,
            1,
          );
          await appendFinishCompleted(options, 'role finished before interrupt');
          return completedOutcome([observation]);
        }
        // resume run：恢复上下文里必须能看到前一个 Run 的真实派工事实，且不重复执行。
        resumeConsumed = { ...options.consumed };
        expect(options.context.recovered_dispatch_count).toBe(1);
        expect(
          (options.context.recovered_dispatches ?? []).map((item) => item.dispatch_id),
        ).toEqual(['dsp_task_1']);
        expect(options.context.recovered_unresolved_dispatches ?? []).toHaveLength(0);
        await appendFinishCompleted(options, 'resumed and reused settled work');
        return completedOutcome();
      },
    });
    const task = makeTaskLoopHarness({
      runsRoot,
      workspace,
      engine: harness.engine,
      onExecuteAgent: (context) => {
        if (context.run_id !== 'run_task_1') return;
        // 引擎已经完成一次 settled 派工；在 stage advance 之前发生用户中断。
        interruptController.abort(new TaskInterruptedError('user', 'pause before stage advance'));
        throw new TaskInterruptedError('user', 'pause before stage advance');
      },
    });

    await beginFirstRun(task.processor, workspace);
    const firstSnapshot = await task.loop.run({
      task_id: IDENTITY.task_id,
      run_id: 'run_task_1',
      signal: interruptController.signal,
    });
    expect(firstSnapshot.task.status).toBe('blocked');
    expect(firstSnapshot.run_history[0]).toMatchObject({ status: 'interrupted' });
    const runtimeAfterInterrupt = task.store.getTaskAggregate(IDENTITY.task_id)?.runtime_state;
    // resume_cursor 是权威：中断点仍在 execute_agent，没有推进到 gate。
    expect(runtimeAfterInterrupt?.resume_cursor).toBe('execute_agent');
    expect(task.calls).toEqual(['select_agent', 'execute_agent']);
    expect(driver.calls()).toBe(1);
    const run1Fold = await readFold(runsRoot, 'run_task_1');
    expect(run1Fold.records).toHaveLength(1);
    expect(run1Fold.records[0]?.status).toBe('succeeded');
    expect(run1Fold.finish).toMatchObject({ status: 'completed' });
    const run1Init = findControl(await readSnapshot(runsRoot, 'run_task_1'), 'init');
    if (run1Init?.event !== 'init') throw new Error('run_task_1 has no frozen init row');

    const resumedFrom = beginCheckpointResume(
      task.processor,
      task.store,
      workspace,
      'run_task_2',
    );
    expect(resumedFrom).toBe('run_task_1');
    const runtimeResumed = task.store.getTaskAggregate(IDENTITY.task_id)?.runtime_state;
    expect(runtimeResumed?.resume_cursor).toBe('execute_agent');
    expect(runtimeResumed?.cursor_input).toMatchObject({ cursor: 'execute_agent' });

    const secondSnapshot = await task.loop.run({
      task_id: IDENTITY.task_id,
      run_id: 'run_task_2',
    });
    expect(secondSnapshot.task.status).toBe('completed');
    // resume 从 execute_agent 继续：select_agent 不再重跑；恢复 Run 没有新派工。
    expect(task.calls).toEqual([
      'select_agent',
      'execute_agent',
      'execute_agent',
      'gate',
      'deliver',
    ]);
    expect(driver.calls()).toBe(1);
    // 恢复 Run 不伪造父链的 dispatch 记录。
    const run2Fold = await readFold(runsRoot, 'run_task_2');
    expect(run2Fold.records).toHaveLength(0);
    expect(run2Fold.finish).toMatchObject({ status: 'completed' });
    const run2Init = findControl(await readSnapshot(runsRoot, 'run_task_2'), 'init');
    if (run2Init?.event !== 'init') throw new Error('run_task_2 has no frozen init row');
    // 冻结策略与 deadline 不因 restart 重置。
    expect(run2Init).toMatchObject({
      deadline_at: run1Init.deadline_at,
      max_dispatches: run1Init.max_dispatches,
      max_role_rounds: run1Init.max_role_rounds,
      role_token_budget: run1Init.role_token_budget,
    });
    // 引擎恢复时读回的已消费量包含前一个 Run 的真实消费。
    expect(resumeConsumed).toMatchObject({
      dispatches: 1,
      role_rounds: 1,
      tokens: 15,
      tool_calls: 1,
    });
    expect(harness.budgetInputs).toHaveLength(2);
    expect(harness.budgetInputs[0]?.consumed.dispatches).toBe(0);
    expect(harness.budgetInputs[1]?.consumed).toMatchObject({
      dispatches: 1,
      role_rounds: 1,
      tokens: 15,
    });
    expect(harness.budgetInputs[1]?.frozen.deadline_at).toBe(run1Init.deadline_at);
  }, 30_000);

  it('TRM-05/JRN-07：中断时在途 dispatch 折叠 unknown；resume 不自动续做，task.error.code 保留 unknown 事实', async () => {
    const runsRoot = await makeRunsRoot('newide-role-resume-unknown-');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-role-resume-ws-'));
    temporaryDirectories.push(workspace);
    const inFlightController = new AbortController();
    const driver = makeFakeDriver(async () => {
      // driver 在途且不合作：只有宿主的 abort 竞速能收束；结果按 unknown 记账。
      setTimeout(
        () => inFlightController.abort(new TaskInterruptedError('user', 'interrupt in flight')),
        20,
      );
      return new Promise<DriverRunResult>(() => undefined);
    });
    const harness = makeHarness({
      runsRoot,
      clock: FROZEN_CLOCK,
      driver,
      loop: async (options) => {
        if (options.context.run_id === 'run_task_1') {
          await dispatchOnce(options, { dispatchId: 'dsp_task_unknown', sequence: 1 });
          throw new Error('dispatch should not succeed after interrupt');
        }
        return completedOutcome([], {
          unresolved_dispatches: [...(options.context.recovered_unresolved_dispatches ?? [])],
        });
      },
    });
    const task = makeTaskLoopHarness({ runsRoot, workspace, engine: harness.engine });
    await beginFirstRun(task.processor, workspace);
    const firstSnapshot = await task.loop.run({
      task_id: IDENTITY.task_id,
      run_id: 'run_task_1',
      signal: inFlightController.signal,
    });
    expect(firstSnapshot.task.status).toBe('blocked');
    expect(firstSnapshot.run_history[0]).toMatchObject({ status: 'interrupted' });
    expect(task.store.getTaskAggregate(IDENTITY.task_id)?.runtime_state.resume_cursor).toBe(
      'execute_agent',
    );
    const run1Fold = await readFold(runsRoot, 'run_task_1');
    expect(run1Fold.records).toHaveLength(1);
    expect(run1Fold.records[0]).toMatchObject({
      dispatch_id: 'dsp_task_unknown',
      status: 'unknown',
    });
    expect(countEvents(await readSnapshot(runsRoot, 'run_task_1')).settled).toBe(1);

    beginCheckpointResume(task.processor, task.store, workspace, 'run_task_2');
    const secondSnapshot = await task.loop.run({
      task_id: IDENTITY.task_id,
      run_id: 'run_task_2',
    });
    expect(secondSnapshot.task.status).toBe('failed');
    const taskError = task.store.getTaskAggregate(IDENTITY.task_id)?.task.error;
    // unknown 不是确定失败：原因码为 dispatch_unknown_unresolved，而不是 role_failed/failed。
    expect(taskError?.code).toBe('dispatch_unknown_unresolved');
    // resume 不自动续做 unknown 派工：driver 总调用次数仍为 1，且恢复 Run 无新 dispatch 记录。
    expect(driver.calls()).toBe(1);
    expect((await readFold(runsRoot, 'run_task_2')).records).toHaveLength(0);
    const run1FoldAfterResume = await readFold(runsRoot, 'run_task_1');
    expect(run1FoldAfterResume.records[0]?.status).toBe('unknown');
    expect(countEvents(await readSnapshot(runsRoot, 'run_task_1')).settled).toBe(1);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────
// 4. 新 Run 继承父链（JRN-08 / RD-SEL-05/06）
// ─────────────────────────────────────────────────────────────

describe('新 Run 继承父链：父链只读、预算/冻结/deadline 继承、子 Journal 不伪造祖先 dispatch', () => {
  it('JRN-08：A→B→C 多级恢复不重放父链 settled work，预算与 deadline 沿链继承且可区分已消费', async () => {
    const runsRoot = await makeRunsRoot('newide-role-lineage-');
    const runA = 'run_a';
    const runB = 'run_b';
    const runC = 'run_c';
    const lineageLimits: Partial<RoleBudgetLimits> = {
      max_dispatches: 7,
      max_role_rounds: 9,
      role_token_budget: 900,
      wall_clock_seconds: 600,
      dispatch_timeout_ms: 2_000,
    };
    const lineageDeadline = '2027-11-13T00:45:00.000Z';
    // A：父链根，已完成一次 settled 与一回合 role LLM 消费。
    await writeJournalPrefix(runsRoot, {
      runId: runA,
      dispatchId: 'dsp_a',
      accept: true,
      dispatch: true,
      evidence: true,
      settle: true,
      roleRounds: [{ round: 1, input_tokens: 30, output_tokens: 20, tool_calls: 2 }],
      frozen: { limits: lineageLimits, deadline_at: lineageDeadline },
    });
    await ensureRunDir(runsRoot, runB);
    await fs.writeFile(
      path.join(runDirOf(runsRoot, runB), 'request.json'),
      JSON.stringify({ recovery_parent_run_id: runA }),
      'utf8',
    );
    await ensureRunDir(runsRoot, runC);
    await fs.writeFile(
      path.join(runDirOf(runsRoot, runC), 'request.json'),
      JSON.stringify({ recovery_parent_run_id: runB }),
      'utf8',
    );

    const driver = makeFakeDriver();
    let bConsumedAtStart: RoleBudgetConsumption | undefined;
    let bBudgetAtEnd: RoleBudgetConsumption | undefined;
    const harnessB = makeHarness({
      runsRoot,
      clock: FROZEN_CLOCK,
      driver,
      loop: async (options) => {
        bConsumedAtStart = { ...options.consumed };
        const observation = await dispatchOnce(options, {
          dispatchId: 'dsp_b',
          // sequence 只在本 Run 的 Journal 内连续：B 自己的首条 dispatch 必须是 1。
          sequence: 1,
        });
        await options.budget.recordRound(
          2,
          { input_tokens: 7, output_tokens: 3 },
          FROZEN_AT,
          0,
        );
        bBudgetAtEnd = options.budget.snapshot().consumed;
        await appendFinishCompleted(options, 'B inherited A and did one more dispatch');
        return completedOutcome([observation]);
      },
    });
    const resultB = await harnessB.engine.run(
      engineRequest({
        run_id: runB,
        instruction: 'continue from A',
        restarted_from_run_id: runA,
      }),
    );
    expect(resultB.status).toBe('completed');
    expect(driver.calls()).toBe(1);
    const initB = findControl(await readSnapshot(runsRoot, runB), 'init');
    if (initB?.event !== 'init') throw new Error('B has no inherited frozen init row');
    expect(initB).toMatchObject({
      deadline_at: lineageDeadline,
      max_dispatches: 7,
      max_role_rounds: 9,
      role_token_budget: 900,
    });
    // 已消费量：父链 1 dispatch / 1 round / 50 tokens / 2 tool calls 被继承，不清零。
    expect(bConsumedAtStart).toMatchObject({
      dispatches: 1,
      role_rounds: 1,
      tokens: 50,
      tool_calls: 2,
    });
    // 当前 Run 的新消费与继承消费可区分：B 的 role_round 只记 B 自己的回合。
    expect(bBudgetAtEnd).toMatchObject({ dispatches: 2, role_rounds: 2, tokens: 60 });
    const countsB = countEvents(await readSnapshot(runsRoot, runB));
    expect(countsB).toMatchObject({
      init: 1,
      accepted: 1,
      dispatched: 1,
      settled: 1,
      role_round: 1,
      finish: 1,
    });

    const bytesABefore = await fs.readFile(
      path.join(runDirOf(runsRoot, runA), 'journal', 'dispatches.jsonl'),
    );
    const bytesBBefore = await fs.readFile(
      path.join(runDirOf(runsRoot, runB), 'journal', 'dispatches.jsonl'),
    );

    let cConsumedAtStart: RoleBudgetConsumption | undefined;
    let cRecoveredIds: string[] = [];
    const harnessC = makeHarness({
      runsRoot,
      clock: FROZEN_CLOCK,
      driver,
      loop: async (options) => {
        cConsumedAtStart = { ...options.consumed };
        cRecoveredIds = (options.context.recovered_dispatches ?? [])
          .map((item) => item.dispatch_id)
          .sort();
        expect(options.context.recovered_dispatch_count).toBe(2);
        await appendFinishCompleted(options, 'C reused A and B facts');
        return completedOutcome();
      },
    });
    const resultC = await harnessC.engine.run(
      engineRequest({
        run_id: runC,
        instruction: 'continue from B',
        restarted_from_run_id: runB,
      }),
    );
    expect(resultC.status).toBe('completed');
    // 父链 settled 的 dispatch 不重放：整条 A→B→C 只发生 1 次 driver 调用（B 的新派工）。
    expect(driver.calls()).toBe(1);
    expect(cRecoveredIds).toEqual(['dsp_a', 'dsp_b']);
    expect(cConsumedAtStart).toMatchObject({
      dispatches: 2,
      role_rounds: 2,
      tokens: 60,
      tool_calls: 2,
    });
    const initC = findControl(await readSnapshot(runsRoot, runC), 'init');
    if (initC?.event !== 'init') throw new Error('C has no inherited frozen init row');
    expect(initC).toMatchObject({
      deadline_at: lineageDeadline,
      max_dispatches: 7,
      max_role_rounds: 9,
    });
    // 子 Journal 只含自己的 init/finish：不伪造祖先 dispatch 记录。
    const foldC = await readFold(runsRoot, runC);
    expect(foldC.records).toHaveLength(0);
    const countsC = countEvents(await readSnapshot(runsRoot, runC));
    expect(countsC.init).toBe(1);
    expect(countsC.accepted ?? 0).toBe(0);
    expect(countsC.dispatched ?? 0).toBe(0);
    expect(countsC.settled ?? 0).toBe(0);
    // 父链只读：A/B 的 Journal 字节在 C 恢复前后完全一致。
    expect(
      (
        await fs.readFile(path.join(runDirOf(runsRoot, runA), 'journal', 'dispatches.jsonl'))
      ).equals(bytesABefore),
    ).toBe(true);
    expect(
      (
        await fs.readFile(path.join(runDirOf(runsRoot, runB), 'journal', 'dispatches.jsonl'))
      ).equals(bytesBBefore),
    ).toBe(true);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────
// 5. Session fresh/reuse、取消/迟到回执、unknown 后调查
// ─────────────────────────────────────────────────────────────

describe('Session、取消/迟到回执与 unknown 后调查（RD-DIS-03/RD-SEL-07/TRM-05/JRN-07）', () => {
  it('RD-DIS-03：默认 fresh；未确认 reuse 被拒且不调用 driver；确认后的 reuse 才带 session_id', async () => {
    // 默认 fresh：role 不带 session，宿主也不向 driver 传 session_id。
    const freshRoot = await makeRunsRoot('newide-role-session-fresh-');
    const freshDriver = makeFakeDriver();
    const freshHarness = makeHarness({
      runsRoot: freshRoot,
      clock: FROZEN_CLOCK,
      driver: freshDriver,
      loop: async (options) => {
        const observation = await dispatchOnce(options, { dispatchId: 'dsp_fresh', sequence: 1 });
        await appendFinishCompleted(options);
        return completedOutcome([observation]);
      },
    });
    await freshHarness.engine.run(engineRequest());
    expect(freshDriver.prompts[0]?.session_id).toBeUndefined();
    const freshFold = await readFold(freshRoot);
    expect(freshFold.records[0]?.brief.session).toEqual({ mode: 'fresh' });

    // 未确认 reuse：引擎在派工前拒绝，driver 从未被调用。
    const unconfirmedRoot = await makeRunsRoot('newide-role-session-unconfirmed-');
    const unconfirmedDriver = makeFakeDriver();
    const unconfirmedHarness = makeHarness({
      runsRoot: unconfirmedRoot,
      clock: FROZEN_CLOCK,
      driver: unconfirmedDriver,
      loop: async (options) => {
        await dispatchOnce(options, {
          dispatchId: 'dsp_reuse_unconfirmed',
          sequence: 1,
          request: {
            kind: 'execute',
            instruction: 'reuse an unconfirmed session',
            session: { mode: 'reuse', session_id: 'session_other' },
          },
          confirmedSession: {
            session_id: 'session_other',
            run_id: options.context.run_id,
            role_id: IDENTITY.role_id,
          },
        });
        await appendFinishCompleted(options);
        return completedOutcome();
      },
    });
    const unconfirmedError = await expectTerminationCode(
      unconfirmedHarness.engine.run(engineRequest()),
      'host_failed',
    );
    expect(unconfirmedError.termination.details).toMatchObject({
      reason: 'session_reuse_unconfirmed',
    });
    expect(unconfirmedDriver.calls()).toBe(0);
    expect((await readFold(unconfirmedRoot)).records).toHaveLength(0);

    // 确认后 reuse：引擎把 session_id 交给 driver，并在 dispatched 行记录同一 session。
    const reuseRoot = await makeRunsRoot('newide-role-session-reuse-');
    const reuseDriver = makeFakeDriver();
    const reuseHarness = makeHarness({
      runsRoot: reuseRoot,
      clock: FROZEN_CLOCK,
      driver: reuseDriver,
      loop: async (options) => {
        const observation = await dispatchOnce(options, {
          dispatchId: 'dsp_reuse_confirmed',
          sequence: 1,
          request: {
            kind: 'execute',
            instruction: 'reuse the confirmed session',
            session: { mode: 'reuse', session_id: 'session_confirmed' },
          },
          confirmedSession: {
            session_id: 'session_confirmed',
            run_id: options.context.run_id,
            role_id: IDENTITY.role_id,
          },
        });
        await appendFinishCompleted(options);
        return completedOutcome([observation]);
      },
    });
    const reuseResult = await reuseHarness.engine.run(
      engineRequest({ session_id: 'session_confirmed' }),
    );
    expect(reuseResult.status).toBe('completed');
    expect(reuseDriver.prompts[0]?.session_id).toBe('session_confirmed');
    const reuseFold = await readFold(reuseRoot);
    expect(reuseFold.records[0]?.brief.session).toEqual({
      mode: 'reuse',
      session_id: 'session_confirmed',
    });
  }, 60_000);

  it('JRN-07/TRM-05：取消在途 dispatch → unknown；迟到回执只追加 reconciled、不改终态、不重跑；恢复不自动续做', async () => {
    const runsRoot = await makeRunsRoot('newide-role-late-');
    const controller = new AbortController();
    const driver = makeFakeDriver(async () => {
      setTimeout(() => controller.abort(new Error('user cancelled')), 20);
      return new Promise<DriverRunResult>(() => undefined);
    });
    const harness = makeHarness({
      runsRoot,
      clock: FROZEN_CLOCK,
      driver,
      loop: async (options) => {
        await dispatchOnce(options, { dispatchId: 'dsp_late', sequence: 1 });
        await appendFinishCompleted(options);
        return completedOutcome();
      },
    });
    await expectTerminationCode(harness.engine.run(engineRequest({ signal: controller.signal })), 'host_cancelled');
    expect(harness.driver.calls()).toBe(1);
    const pendingFold = await readFold(runsRoot);
    expect(pendingFold.records).toHaveLength(1);
    expect(pendingFold.records[0]).toMatchObject({ dispatch_id: 'dsp_late', status: 'unknown' });
    expect(countEvents(await readSnapshot(runsRoot)).settled).toBe(1);

    // 迟到回执：仅仅追加一条 reconciled，原 settled(unknown) 终态不被改写。
    const runDir = runDirOf(runsRoot, RUN);
    const journal = await RunDispatchJournal.open({
      runDir,
      identity: { run_id: RUN, ...IDENTITY },
    });
    const linesBefore = (await journal.read()).lines.length;
    await reconcileLateDriverResult(journal, 'dsp_late', driverResult('succeeded', 'late result'));
    const linesAfter = (await journal.read()).lines.length;
    await journal.close();
    expect(linesAfter).toBe(linesBefore + 1);
    const reconciledFold = await readFold(runsRoot);
    expect(reconciledFold.records[0]).toMatchObject({ status: 'unknown' });
    expect(reconciledFold.records[0]?.reconciled).toMatchObject({ status: 'succeeded' });
    expect(harness.driver.calls()).toBe(1);

    // 恢复：可信 reconciled 收束 unknown（可 completed），但仍不重跑 driver。
    const recovery = makeHarness({
      runsRoot,
      clock: FROZEN_CLOCK,
      driver,
      loop: async (options) => {
        expect(options.context.recovered_unresolved_dispatches ?? []).toHaveLength(0);
        await appendFinishCompleted(options, 'reconciled without replay');
        return completedOutcome();
      },
    });
    const result = await recovery.engine.run(engineRequest());
    expect(result.status).toBe('completed');
    expect(harness.driver.calls()).toBe(1);
    expect((await readFold(runsRoot)).records[0]?.status).toBe('unknown');
  }, 30_000);

  it('RD-SEL-07/JRN-07/TRM-05：unknown 后只派新的只读调查，不以原 brief 自动重发；unknown 不被改写 failed', async () => {
    const runsRoot = await makeRunsRoot('newide-role-unknown-investigate-');
    const prefix = await writeJournalPrefix(runsRoot, { accept: true, dispatch: true });
    const harness = makeHarness({
      runsRoot,
      clock: FROZEN_CLOCK,
      loop: async (options) => {
        expect(options.context.recovered_unresolved_dispatches).toEqual([prefix.dispatchId]);
        expect(options.context.recovered_dispatch_count).toBe(1);
        // role 只能派**新的**只读调查（没有 retry_of == 原 dispatch）。
        const investigation = await dispatchOnce(options, {
          dispatchId: 'dsp_investigate',
          sequence: 2,
          request: { kind: 'investigate', instruction: 'inspect the unknown dispatch outcome' },
        });
        return completedOutcome([investigation], {
          unresolved_dispatches: [prefix.dispatchId],
        });
      },
    });

    await expectTerminationCode(
      harness.engine.run(engineRequest()),
      'dispatch_unknown_unresolved',
    );
    expect(harness.driver.calls()).toBe(1);
    const fold = await readFold(runsRoot);
    expect(fold.records).toHaveLength(2);
    // 原 unknown 事实保留：既没有被自动重发，也没有被改写成 failed。
    expect(fold.records[0]).toMatchObject({
      dispatch_id: prefix.dispatchId,
      status: 'unknown',
      phase: 'dispatched',
    });
    expect(fold.records[0]?.brief.retry_of).toBeUndefined();
    expect(fold.records[1]).toMatchObject({
      dispatch_id: 'dsp_investigate',
      status: 'succeeded',
    });
    expect(fold.records[1]?.brief.retry_of).toBeUndefined();
    const counts = countEvents(await readSnapshot(runsRoot));
    expect(counts.accepted).toBe(2);
    expect(counts.settled).toBe(1);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────
// 6. 代表性跨进程重启：真实子进程写 durable journal 后强杀
// ─────────────────────────────────────────────────────────────

const WORKER_PATH = path.join(process.cwd(), 'test', 'fixtures', 'role-recovery-child-worker.ts');
const BOOTSTRAP_PATH = path.join(
  process.cwd(),
  'test',
  'fixtures',
  'role-recovery-child-bootstrap.mjs',
);

interface WorkerRunResult {
  code: number | null;
  /** 子进程 stderr/stdout 日志（失败时用于给出精确证据）。 */
  log?: string;
  workerError?: string;
  /** 子进程加载器/派生被环境阻断（不是生产代码缺陷），值为可诊断说明。 */
  environmentLimitation?: string;
}

function describeSpawnBlocked(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EPERM' && error.message.includes('spawn')) {
    return `spawn EPERM: ${error.message}`;
  }
  if (error.message.includes('spawn EPERM')) return error.message;
  return undefined;
}

/**
 * 真实子进程 worker（`node --import tsx test/fixtures/role-recovery-child-worker.ts`）。
 *
 * 输出重定向到**文件 fd**而不是管道：受限沙箱里 child_process 管道 stdio 会 `spawn EPERM`，
 * 文件 fd 不受影响，同时还能保留 stderr 用于判断「加载器被环境阻断」。
 */
interface WorkerLaunchResult {
  code: number | null;
  log: string;
  workerError?: string;
  environmentLimitation?: string;
}

async function attemptWorkerLaunch(
  input: { runsRoot: string; runId: string; mode: 'dispatched' | 'settled' },
  launch: { args: string[]; extraEnv: Record<string, string>; logName: string },
): Promise<WorkerLaunchResult> {
  const logPath = path.join(input.runsRoot, `${input.runId}.${launch.logName}.log`);
  const logHandle = await fs.open(logPath, 'w');
  try {
    let child;
    try {
      child = spawn(process.execPath, launch.args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ROLE_RECOVERY_RUNS_ROOT: input.runsRoot,
          ROLE_RECOVERY_RUN_ID: input.runId,
          ROLE_RECOVERY_MODE: input.mode,
          ...launch.extraEnv,
        },
        stdio: ['ignore', logHandle.fd, logHandle.fd],
      });
    } catch (error) {
      return {
        code: null,
        log: '',
        environmentLimitation:
          'DSH sandbox 禁止子进程派生（' +
          `${describeSpawnBlocked(error) ?? String(error)}）；跨进程恢复用例需在无沙箱 shell 运行。`,
      };
    }
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`child recovery worker timed out for ${input.runId}`));
        }, 90_000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });
    } catch (error) {
      const blocked = describeSpawnBlocked(error);
      return {
        code: null,
        log: '',
        ...(blocked !== undefined
          ? {
              environmentLimitation: `DSH sandbox 禁止子进程派生（${blocked}）。`,
            }
          : {}),
      };
    }
    const log = await fs.readFile(logPath, 'utf8').catch(() => '');
    const workerError = await fs
      .readFile(path.join(input.runsRoot, input.runId, 'worker-error.txt'), 'utf8')
      .catch(() => undefined);
    // 子进程没跑到业务代码（没有 worker-error.txt），stderr 里是 tsx/esbuild 服务被 sandbox
    // 阻断的栈：这是环境限制，不是生产代码缺陷。
    const loaderBlocked =
      workerError === undefined &&
      code !== 0 &&
      /spawn EPERM|TransformError|esbuild/i.test(log);
    return {
      code,
      log,
      ...(workerError !== undefined ? { workerError } : {}),
      ...(loaderBlocked
        ? {
            environmentLimitation:
              'DSH sandbox 阻止 tsx/esbuild 子进程服务（spawn EPERM）。',
          }
        : {}),
    };
  } finally {
    await logHandle.close();
  }
}

async function runRecoveryWorker(input: {
  runsRoot: string;
  runId: string;
  mode: 'dispatched' | 'settled';
}): Promise<WorkerRunResult> {
  // 首选契约建议的 `node --import tsx worker.ts`。
  const primary = await attemptWorkerLaunch(input, {
    args: ['--import', 'tsx', WORKER_PATH],
    extraEnv: {},
    logName: 'child',
  });
  if (primary.environmentLimitation === undefined) {
    return {
      code: primary.code,
      ...(primary.workerError !== undefined ? { workerError: primary.workerError } : {}),
    };
  }
  // 受限 sandbox 会阻断 tsx 的 esbuild 服务派生。退回 Node 原生 TypeScript 变换 +
  // 扩展名补全 loader：仍然启动**真实子进程**运行同一份 worker（无任何子进程派生）。
  const fallback = await attemptWorkerLaunch(input, {
    args: ['--experimental-transform-types', BOOTSTRAP_PATH],
    extraEnv: { ROLE_RECOVERY_WORKER_PATH: WORKER_PATH },
    logName: 'child-native-ts',
  });
  if (fallback.environmentLimitation === undefined) {
    console.warn(
      `[recovery-test] tsx launch blocked (${primary.environmentLimitation}); ` +
        'used the native-TypeScript bootstrap for the real child process instead.',
    );
    return {
      code: fallback.code,
      ...(fallback.workerError !== undefined ? { workerError: fallback.workerError } : {}),
    };
  }
  return {
    code: fallback.code,
    log: `${primary.log}\n${fallback.log}`,
    environmentLimitation:
      'tsx 与原生 TypeScript 启动均被沙箱阻断：' +
      `${primary.environmentLimitation} / ${fallback.environmentLimitation}；` +
      `可复现命令：${process.execPath} --import tsx ${WORKER_PATH} ` +
      `(mode=${input.mode}, run=${input.runId})`,
  };
}

describe('跨进程重启：真实子进程写 durable journal 后强杀，父进程恢复不重放', () => {
  it('JRN-06/JRN-08：dispatched 后强杀 → 恢复折叠 unknown、driver 0 次、stale writer lock 被回收', async (ctx) => {
    const runsRoot = await makeRunsRoot('newide-role-child-');
    const childRun = 'run_child_dispatched';
    const worker = await runRecoveryWorker({
      runsRoot,
      runId: childRun,
      mode: 'dispatched',
    });
    if (worker.environmentLimitation !== undefined) {
      // 环境限制（不是生产缺陷）：记录精确原因并跳过真实子进程断言；tsx worker 本身见 fixture。
      console.warn(worker.environmentLimitation);
      ctx.skip();
      return;
    }
    expect(worker.workerError, worker.log).toBeUndefined();
    expect(worker.code, worker.log).toBe(0);
    const lockDir = path.join(runDirOf(runsRoot, childRun), 'journal', '.writer.lock');
    // 子进程不 close = 进程崩溃现场：写者锁目录仍在，只能靠 stale-lock 回收继续。
    expect(await fileExists(lockDir)).toBe(true);
    const childFold = await readFold(runsRoot, childRun);
    expect(childFold.records).toHaveLength(1);
    expect(childFold.records[0]).toMatchObject({
      dispatch_id: `dsp_child_${childRun}`,
      status: 'unknown',
    });

    const driver = makeFakeDriver();
    const harness = makeHarness({
      runsRoot,
      clock: FROZEN_CLOCK,
      driver,
      loop: async (options) => {
        return completedOutcome([], {
          unresolved_dispatches: [...(options.context.recovered_unresolved_dispatches ?? [])],
        });
      },
    });
    await expectTerminationCode(
      harness.engine.run(engineRequest({ run_id: childRun })),
      'dispatch_unknown_unresolved',
    );
    expect(driver.calls()).toBe(0);
    expect((await readFold(runsRoot, childRun)).records[0]?.status).toBe('unknown');
    // 恢复用的 writer 已正常释放：锁目录不在（残留锁已被安全回收）。
    expect(await fileExists(lockDir)).toBe(false);
  }, 180_000);

  it('JRN-06：settled 后强杀 → 恢复复现成功终态、driver 0 次、同一 dispatch 不重复 settled', async (ctx) => {
    const runsRoot = await makeRunsRoot('newide-role-child-');
    const childRun = 'run_child_settled';
    const worker = await runRecoveryWorker({
      runsRoot,
      runId: childRun,
      mode: 'settled',
    });
    if (worker.environmentLimitation !== undefined) {
      console.warn(worker.environmentLimitation);
      ctx.skip();
      return;
    }
    expect(worker.workerError, worker.log).toBeUndefined();
    expect(worker.code, worker.log).toBe(0);
    const childFold = await readFold(runsRoot, childRun);
    expect(childFold.records).toHaveLength(1);
    expect(childFold.records[0]).toMatchObject({
      dispatch_id: `dsp_child_${childRun}`,
      status: 'succeeded',
    });
    const childCounts = countEvents(await readSnapshot(runsRoot, childRun));

    const driver = makeFakeDriver();
    const harness = makeHarness({
      runsRoot,
      clock: FROZEN_CLOCK,
      driver,
      loop: async (options) => {
        expect(options.context.recovered_dispatch_count).toBe(1);
        expect(options.context.recovered_unresolved_dispatches ?? []).toHaveLength(0);
        await appendFinishCompleted(options, 'recovered settled child work');
        return completedOutcome();
      },
    });
    const result = await harness.engine.run(engineRequest({ run_id: childRun }));
    expect(result.status).toBe('completed');
    expect(driver.calls()).toBe(0);
    const recoveredFold = await readFold(runsRoot, childRun);
    expect(recoveredFold.records).toHaveLength(1);
    expect(recoveredFold.records[0]?.status).toBe('succeeded');
    const recoveredCounts = countEvents(await readSnapshot(runsRoot, childRun));
    // 同 dispatch 不重复 settled / accepted：恢复只追加 init 之外的 finish。
    expect(recoveredCounts.accepted).toBe(childCounts.accepted);
    expect(recoveredCounts.dispatched).toBe(childCounts.dispatched);
    expect(recoveredCounts.settled).toBe(childCounts.settled);
    expect(recoveredCounts.finish).toBe(1);
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────
// 7. 部署默认开关/预算变化后的恢复（RD-SEL-05/06/07 / JRN-08）
// ─────────────────────────────────────────────────────────────

describe('部署默认开关/预算变化后的恢复', () => {
  it('RD-SEL-05：已冻结 Run 沿用 Journal init（不切换引擎/预算/开关），即使部署配置与 freeze_plan 已变', async () => {
    const runsRoot = await makeRunsRoot('newide-role-deploy-freeze-');
    await writeJournalPrefix(runsRoot, {
      frozen: {
        limits: {
          max_dispatches: 3,
          max_role_rounds: 5,
          role_token_budget: 500,
          wall_clock_seconds: 120,
          dispatch_timeout_ms: 30_000,
        },
        evidence_only: true,
        routing: { driver_id: 'driver_frozen' },
      },
    });
    // 部署配置后来变了：开关关闭、预算放宽、引擎仍已装配。
    const selection = await selectRoleExecutionEngine({
      runs_root: runsRoot,
      run_id: RUN,
      task_id: IDENTITY.task_id,
      role_id: IDENTITY.role_id,
      mode: 'single_agent',
      task_request: { spec: 'do the task', completion_criteria: [] },
      cursor_input: { cursor: 'execute_agent', winner_agent_id: IDENTITY.role_id },
      config: {
        enabled: false,
        wired: true,
        switches: { evidence_only: false, buffer_v2: false },
        budget_overrides: { max_dispatches: 12 },
      },
      now: FROZEN_CLOCK(),
    });
    expect(selection).toMatchObject({
      engine: 'role_autonomy',
      reason: 'frozen_role_autonomy',
    });
    if (selection.engine !== 'role_autonomy') throw new Error('frozen Run must keep role engine');
    expect(selection.frozen).toMatchObject({
      evidence_only: true,
      routing: { driver_id: 'driver_frozen' },
      budget: { limits: { max_dispatches: 3, max_role_rounds: 5 } },
    });

    const driver = makeFakeDriver();
    const harness = makeHarness({
      runsRoot,
      clock: FROZEN_CLOCK,
      driver,
      loop: async (options) => {
        const observation = await dispatchOnce(options, { dispatchId: 'dsp_frozen', sequence: 1 });
        await appendFinishCompleted(options);
        return completedOutcome([observation]);
      },
    });
    const result = await harness.engine.run(
      engineRequest({
        // 变化后的部署计划：引擎必须忽略它，以已 durable 的 init 为准。
        freeze_plan: {
          limits: LIMITS,
          deadline_at: DEADLINE_AT,
          frozen_at: FROZEN_AT,
          max_tool_calls: 64,
          routing: { driver_id: 'driver_new_deployment' },
          evidence_only: false,
          buffer_v2: false,
        },
      }),
    );
    expect(result.status).toBe('completed');
    const init = findControl(await readSnapshot(runsRoot), 'init');
    if (init?.event !== 'init') throw new Error('frozen Run lost its init row');
    expect(init).toMatchObject({
      engine: 'role_autonomy',
      evidence_only: true,
      max_dispatches: 3,
      max_role_rounds: 5,
      deadline_at: DEADLINE_AT,
    });
    expect(countEvents(await readSnapshot(runsRoot)).init).toBe(1);
    expect(harness.loopCalls[0]?.policy.evidence_only).toBe(true);
    expect(harness.loopCalls[0]?.policy.budget.limits.max_dispatches).toBe(3);
    expect(harness.loopCalls[0]?.policy.routing.driver_id).toBe('driver_frozen');
    expect(harness.budgetInputs[0]?.frozen).toMatchObject({
      limits: { max_dispatches: 3, max_role_rounds: 5 },
      deadline_at: DEADLINE_AT,
    });
  }, 30_000);

  it('JRN-08/RD-SEL-05：旧 legacy Run（无 Journal）按旧路径解释，不合成 dispatch 记录', async () => {
    const runsRoot = await makeRunsRoot('newide-role-deploy-legacy-');
    const legacyRun = 'run_legacy_started';
    const legacyDir = await ensureRunDir(runsRoot, legacyRun);
    await fs.mkdir(path.join(legacyDir, 'stages'), { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, 'stages', 'execute_agent.json'),
      '{"status":"started"}',
      'utf8',
    );
    const baseSelection = {
      runs_root: runsRoot,
      task_id: IDENTITY.task_id,
      role_id: IDENTITY.role_id,
      mode: 'single_agent' as const,
      task_request: { spec: 'legacy task', completion_criteria: [] },
      cursor_input: { cursor: 'execute_agent' as const, winner_agent_id: IDENTITY.role_id },
      config: { enabled: true, wired: true },
      now: FROZEN_CLOCK(),
    };
    const started = await selectRoleExecutionEngine({ ...baseSelection, run_id: legacyRun });
    expect(started).toMatchObject({
      engine: 'legacy',
      reason: 'started_run_without_frozen_engine',
    });
    // 不伪造 dispatch：选路是只读的，不创建 Journal/派工记录。
    expect(await fileExists(path.join(legacyDir, 'journal', 'dispatches.jsonl'))).toBe(false);
    expect(await fileExists(path.join(legacyDir, 'journal'))).toBe(false);

    // 从没有冻结记录的父 Run 继承：整条链按 legacy 解释（部署开关打开也不接管）。
    const legacyParent = 'run_legacy_parent';
    await ensureRunDir(runsRoot, legacyParent);
    const legacyChild = 'run_legacy_child';
    await ensureRunDir(runsRoot, legacyChild);
    await fs.writeFile(
      path.join(runDirOf(runsRoot, legacyChild), 'request.json'),
      JSON.stringify({ recovery_parent_run_id: legacyParent }),
      'utf8',
    );
    const resumed = await selectRoleExecutionEngine({
      ...baseSelection,
      run_id: legacyChild,
      restarted_from_run_id: legacyParent,
    });
    expect(resumed).toMatchObject({
      engine: 'legacy',
      reason: 'resumed_without_frozen_engine',
    });
    expect(await fileExists(path.join(runDirOf(runsRoot, legacyChild), 'journal'))).toBe(false);
  }, 30_000);
});
