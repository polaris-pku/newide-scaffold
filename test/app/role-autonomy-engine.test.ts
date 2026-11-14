/**
 * 阶段 2 role 引擎适配层的行为测试（不依赖真实 LLM/driver）：冻结写入顺序、恢复复现、
 * 祖先链预算继承、引擎版本/冻结记录不匹配的显式拒绝、写失败不调用 loop。
 *
 * 用真实临时 runs root + 真实 RunDispatchJournal；loop/预算/finish 以 fake 工厂注入，
 * 断言的是引擎可观察行为（Journal 行、调用次数、typed termination），不是实现细节。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildExecutionBrief, buildExecutionEvidence, hashExecutionBrief } from '../../src/driver';
import { RunDispatchJournal, createNodeDispatchJournalIo } from '../../src/persistence';
import type { DriverRuntimeHandle } from '../../src/driver/contract';
import type { MemoryRepository, BufferRepository } from '../../src/memory';
import {
  buildRoleFreezeInitInput,
  ROLE_AUTONOMY_ENGINE_VERSION,
  RoleTerminationError,
  type RoleBudgetConsumption,
  type RoleBudgetPort,
  type RoleFinishValidatorPort,
  type RoleLoopOptions,
  type RoleLoopOutcome,
  type RoleFrozenBudget,
} from '../../src/app/role-autonomy-contract';
import { RoleAutonomyEngine } from '../../src/app/role-autonomy-engine';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const IDENTITY = { task_id: 'task_1', role_id: 'role_1' };

async function makeRunsRoot(runId = 'run_1'): Promise<{ runsRoot: string; runId: string }> {
  const runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-role-engine-'));
  temporaryDirectories.push(runsRoot);
  await fs.mkdir(path.join(runsRoot, runId), { recursive: true });
  return { runsRoot, runId };
}

function fakeDriver(): DriverRuntimeHandle {
  return { driver_id: 'driver_test' } as unknown as DriverRuntimeHandle;
}

function completedOutcome(overrides: Partial<RoleLoopOutcome> = {}): RoleLoopOutcome {
  const finish = {
    status: 'completed' as const,
    summary: 'done by role',
    evidence_refs: [],
    unresolved: [],
    role_reflection: 'reflection',
    response_only: false,
    verification: [],
    accepted_at: '2026-11-13T00:00:00.000Z',
  };
  return {
    status: 'completed',
    finish,
    response: finish.summary,
    dispatches: [],
    usage: { input_tokens: 10, output_tokens: 5, usage_missing: false, role_rounds: 1 },
    zero_dispatch: true,
    plan: undefined,
    unresolved_dispatches: [],
    ...overrides,
  };
}

function fakeBudgetPort(frozen: RoleFrozenBudget): RoleBudgetPort {
  return {
    frozen,
    snapshot: () => ({
      frozen,
      consumed: {
        dispatches: 0,
        role_rounds: 0,
        tokens: 0,
        tool_calls: 0,
        tokens_missing: false,
      },
      wall_clock_remaining_ms: 1_000,
    }),
    assertRoundAllowed: () => undefined,
    recordRound: async () => undefined,
    assertDispatchAllowed: () => undefined,
    recordDispatch: () => undefined,
    assertTokenBudget: () => undefined,
  };
}

function fakeFinishValidator(): RoleFinishValidatorPort {
  return {
    validate: async () => ({ accepted: false, gaps: [{ code: 'journal_unavailable', message: 'fake' }] }),
  };
}

interface Harness {
  engine: RoleAutonomyEngine;
  loopCalls: RoleLoopOptions[];
  budgetInputs: Array<{ frozen: RoleFrozenBudget; consumed: RoleBudgetConsumption }>;
  loop: (options: RoleLoopOptions) => Promise<RoleLoopOutcome>;
}

function makeHarness(
  runsRoot: string,
  options: {
    outcome?: RoleLoopOutcome;
    journalIo?: ReturnType<typeof createNodeDispatchJournalIo>;
    loop?: (options: RoleLoopOptions) => Promise<RoleLoopOutcome>;
  } = {},
): Harness {
  const loopCalls: RoleLoopOptions[] = [];
  const budgetInputs: Array<{ frozen: RoleFrozenBudget; consumed: RoleBudgetConsumption }> = [];
  const loop =
    options.loop ??
    (async (loopOptions: RoleLoopOptions) => {
      loopCalls.push(loopOptions);
      return options.outcome ?? completedOutcome();
    });
  const engine = new RoleAutonomyEngine({
    runs_root: runsRoot,
    llm: { completeWithTools: async () => ({ content: null, tool_calls: undefined }) },
    repository: {} as MemoryRepository,
    buffer_repository: {} as BufferRepository,
    driver_for: () => fakeDriver(),
    create_budget: ({ frozen, consumed }) => {
      budgetInputs.push({ frozen, consumed });
      return fakeBudgetPort(frozen);
    },
    create_finish_validator: () => fakeFinishValidator(),
    run_loop: loop,
    ...(options.journalIo ? { journal_io: options.journalIo } : {}),
  });
  return { engine, loopCalls, budgetInputs, loop };
}

async function readJournalInit(runsRoot: string, runId: string) {
  const journal = await RunDispatchJournal.peek({
    runDir: path.join(runsRoot, runId),
    identity: { run_id: runId, ...IDENTITY },
  });
  const snapshot = await journal.read();
  return snapshot.controls.find((entry) => entry.event === 'init');
}

describe('role-autonomy 引擎适配层', () => {
  it('全新 Run：先持久化冻结 init（引擎/版本/工具/预算/deadline），再调用 loop', async () => {
    const { runsRoot, runId } = await makeRunsRoot();
    const harness = makeHarness(runsRoot);
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'implement the task',
      completion_criteria: ['tests pass'],
    });

    expect(result.status).toBe('completed');
    expect(result.diagnostics.execution_engine).toBe('role_autonomy');
    expect(harness.loopCalls).toHaveLength(1);
    const init = await readJournalInit(runsRoot, runId);
    expect(init).toMatchObject({
      event: 'init',
      engine: 'role_autonomy',
      engine_version: ROLE_AUTONOMY_ENGINE_VERSION,
      autonomy: true,
      evidence_only: false,
      buffer_v2: false,
      max_dispatches: 12,
      max_role_rounds: 40,
      role_token_budget: 120_000,
      dispatch_timeout_ms: 600_000,
    });
    if (init?.event === 'init') {
      expect(init.tool_allowlist).toEqual([
        'dispatch_execution',
        'query_memory',
        'read_evidence',
        'update_plan',
        'finish_task',
      ]);
    }
  });

  it('冻结写入失败：不调用 loop，抛 journal_write_failed（typed termination）', async () => {
    const { runsRoot, runId } = await makeRunsRoot();
    const base = createNodeDispatchJournalIo();
    let appended = 0;
    const failing = {
      ...base,
      async appendLineWithFsync(filePath: string, line: string) {
        appended += 1;
        if (appended === 1) {
          const error = new Error('injected journal write failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return base.appendLineWithFsync(filePath, line);
      },
    };
    const harness = makeHarness(runsRoot, { journalIo: failing });
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'implement the task',
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(RoleTerminationError);
    expect((error as RoleTerminationError).termination.code).toBe('journal_write_failed');
    expect(harness.loopCalls).toHaveLength(0);
  });

  it('恢复：Journal 已有 role finish(completed) 时直接复现终态，不调用 loop/driver', async () => {
    const { runsRoot, runId } = await makeRunsRoot();
    const runDir = path.join(runsRoot, runId);
    const journal = await RunDispatchJournal.open({
      runDir,
      identity: { run_id: runId, ...IDENTITY },
    });
    const freeze = buildRoleFreezeInitInput({
      limits: {
        max_dispatches: 12,
        max_role_rounds: 40,
        role_token_budget: 120_000,
        wall_clock_seconds: 2_700,
        dispatch_timeout_ms: 600_000,
      },
      deadline_at: '2026-11-13T00:45:00.000Z',
    });
    await journal.appendInit(freeze);
    await journal.appendFinish({
      actor: 'role',
      status: 'completed',
      reason: 'done',
      evidence_refs: [],
      summary: 'recovered summary',
      role_reflection: 'recovered reflection',
    });
    await journal.close();

    const harness = makeHarness(runsRoot);
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'implement the task',
    });
    expect(harness.loopCalls).toHaveLength(0);
    expect(result.status).toBe('completed');
    expect(result.response).toBe('recovered summary');
    expect(result.diagnostics.role_autonomy).toMatchObject({ finish_status: 'completed' });
  });

  it('恢复：Journal 已有 role finish(blocked) 时抛 role_blocked，不重新决策', async () => {
    const { runsRoot, runId } = await makeRunsRoot();
    const journal = await RunDispatchJournal.open({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    const freeze = buildRoleFreezeInitInput({
      limits: {
        max_dispatches: 12,
        max_role_rounds: 40,
        role_token_budget: 120_000,
        wall_clock_seconds: 2_700,
        dispatch_timeout_ms: 600_000,
      },
      deadline_at: '2026-11-13T00:45:00.000Z',
    });
    await journal.appendInit(freeze);
    await journal.appendFinish({
      actor: 'role',
      status: 'blocked',
      reason: 'need input',
      evidence_refs: [],
      summary: 'blocked summary',
    });
    await journal.close();

    const harness = makeHarness(runsRoot);
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'implement the task',
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(RoleTerminationError);
    expect((error as RoleTerminationError).termination.code).toBe('role_blocked');
    expect(harness.loopCalls).toHaveLength(0);
  });

  it('祖先链继承：冻结预算/deadline 与已消费 dispatches/rounds 不因 restart 清零', async () => {
    const parentId = 'run_parent';
    const { runsRoot, runId } = await makeRunsRoot('run_child');
    const parentDir = path.join(runsRoot, parentId);
    await fs.mkdir(parentDir, { recursive: true });
    const ancestor = await RunDispatchJournal.open({
      runDir: parentDir,
      identity: { run_id: parentId, ...IDENTITY },
    });
    const ancestorDeadline = '2026-11-13T00:10:00.000Z';
    await ancestor.appendInit(
      buildRoleFreezeInitInput({
        limits: {
          max_dispatches: 5,
          max_role_rounds: 9,
          role_token_budget: 900,
          wall_clock_seconds: 600,
          dispatch_timeout_ms: 1_000,
        },
        deadline_at: ancestorDeadline,
      }),
    );
    const brief = buildExecutionBrief({
      identity: {
        dispatch_id: 'dsp_parent_1',
        run_id: parentId,
        task_id: IDENTITY.task_id,
        role_id: IDENTITY.role_id,
        sequence: 1,
        accepted_at: '2026-11-13T00:00:00.000Z',
      },
      request: { kind: 'execute', instruction: 'parent dispatch' },
    }).brief;
    await ancestor.appendAccepted({
      brief,
      brief_sha256: hashExecutionBrief(brief),
      budget_before: {
        dispatches_left: 5,
        role_tokens_left: 900,
        deadline_at: ancestorDeadline,
      },
    });
    await ancestor.appendRoleRound({
      round: 1,
      input_tokens: 30,
      output_tokens: 20,
      tool_calls: 2,
      usage_missing: false,
    });
    await ancestor.close();
    await fs.writeFile(
      path.join(runsRoot, runId, 'request.json'),
      JSON.stringify({ recovery_parent_run_id: parentId }),
      'utf8',
    );

    const harness = makeHarness(runsRoot);
    await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'continue the task',
      restarted_from_run_id: parentId,
    });
    expect(harness.loopCalls).toHaveLength(1);
    expect(harness.budgetInputs).toHaveLength(1);
    const inherited = harness.budgetInputs[0]!;
    expect(inherited.frozen.deadline_at).toBe(ancestorDeadline);
    expect(inherited.frozen.limits.max_dispatches).toBe(5);
    expect(inherited.consumed.dispatches).toBe(1);
    expect(inherited.consumed.role_rounds).toBe(1);
    expect(inherited.consumed.tokens).toBe(50);
    expect(inherited.consumed.tool_calls).toBe(2);
    expect(inherited.consumed.tokens_missing).toBe(false);
  });

  it('read_evidence 允许读取祖先链已登记的受控 ref', async () => {
    const parentId = 'run_parent_evidence';
    const { runsRoot, runId } = await makeRunsRoot('run_child_evidence');
    const parentDir = path.join(runsRoot, parentId);
    await fs.mkdir(parentDir, { recursive: true });
    const parent = await RunDispatchJournal.open({
      runDir: parentDir,
      identity: { run_id: parentId, ...IDENTITY },
    });
    await parent.appendInit(
      buildRoleFreezeInitInput({
        limits: {
          max_dispatches: 12,
          max_role_rounds: 40,
          role_token_budget: 120_000,
          wall_clock_seconds: 2_700,
          dispatch_timeout_ms: 600_000,
        },
        deadline_at: '2026-11-13T00:45:00.000Z',
      }),
    );
    const brief = buildExecutionBrief({
      identity: {
        dispatch_id: 'dsp_parent_evidence',
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
    await parent.appendDispatched({ dispatch_id: 'dsp_parent_evidence' });
    const evidence = buildExecutionEvidence({
      dispatch_id: 'dsp_parent_evidence',
      observation: {
        transport: { evidence: 'execution_unconfirmed' },
        result: { status: 'succeeded', response: 'ancestor evidence text' },
      },
    });
    const artifact = await parent.appendEvidence({
      dispatch_id: 'dsp_parent_evidence',
      evidence,
    });
    await parent.appendSettled({
      dispatch_id: 'dsp_parent_evidence',
      status: 'succeeded',
      evidence,
      evidence_sha256: artifact.sha256,
      violations: [],
    });
    await parent.close();
    await fs.writeFile(
      path.join(runsRoot, runId, 'request.json'),
      JSON.stringify({ recovery_parent_run_id: parentId }),
      'utf8',
    );

    let readText = '';
    const harness = makeHarness(runsRoot, {
      loop: async (options) => {
        const page = await options.journal.readEvidence(artifact.ref);
        readText = page.text;
        return completedOutcome();
      },
    });
    const result = await harness.engine.run({
      task_id: IDENTITY.task_id,
      run_id: runId,
      role_id: IDENTITY.role_id,
      instruction: 'continue the task',
      restarted_from_run_id: parentId,
    });
    expect(result.status).toBe('completed');
    expect(readText).toContain('ancestor evidence text');
  });

  it('祖先链存在未收束 unknown：completed 被最终闸门拒绝（dispatch_unknown_unresolved）', async () => {
    const parentId = 'run_parent_unknown';
    const { runsRoot, runId } = await makeRunsRoot('run_child_unknown');
    const parentDir = path.join(runsRoot, parentId);
    await fs.mkdir(parentDir, { recursive: true });
    const parent = await RunDispatchJournal.open({
      runDir: parentDir,
      identity: { run_id: parentId, ...IDENTITY },
    });
    await parent.appendInit(
      buildRoleFreezeInitInput({
        limits: {
          max_dispatches: 12,
          max_role_rounds: 40,
          role_token_budget: 120_000,
          wall_clock_seconds: 2_700,
          dispatch_timeout_ms: 600_000,
        },
        deadline_at: '2026-11-13T00:45:00.000Z',
      }),
    );
    const brief = buildExecutionBrief({
      identity: {
        dispatch_id: 'dsp_parent_unknown',
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
    await parent.appendDispatched({ dispatch_id: 'dsp_parent_unknown' });
    await parent.close();
    await fs.writeFile(
      path.join(runsRoot, runId, 'request.json'),
      JSON.stringify({ recovery_parent_run_id: parentId }),
      'utf8',
    );

    const harness = makeHarness(runsRoot);
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'continue the task',
        restarted_from_run_id: parentId,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(RoleTerminationError);
    expect((error as RoleTerminationError).termination.code).toBe('dispatch_unknown_unresolved');
  });
  it('引擎版本不匹配：显式 host_failed，不调用 loop', async () => {
    const { runsRoot, runId } = await makeRunsRoot();
    const journal = await RunDispatchJournal.open({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    await journal.appendInit({
      ...buildRoleFreezeInitInput({
        limits: {
          max_dispatches: 12,
          max_role_rounds: 40,
          role_token_budget: 120_000,
          wall_clock_seconds: 2_700,
          dispatch_timeout_ms: 600_000,
        },
        deadline_at: '2026-11-13T00:45:00.000Z',
      }),
      engine_version: 'role-autonomy-v0',
    });
    await journal.close();

    const harness = makeHarness(runsRoot);
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'implement the task',
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(RoleTerminationError);
    expect((error as RoleTerminationError).termination.code).toBe('host_failed');
    expect(harness.loopCalls).toHaveLength(0);
  });

  it('冻结记录只有 autonomy 没有阶段 2 引擎字段：host_failed，不补默认值', async () => {
    const { runsRoot, runId } = await makeRunsRoot();
    const journal = await RunDispatchJournal.open({
      runDir: path.join(runsRoot, runId),
      identity: { run_id: runId, ...IDENTITY },
    });
    await journal.appendInit({
      autonomy: true,
      evidence_only: false,
      buffer_v2: false,
      max_dispatches: 12,
      max_role_rounds: 40,
      role_token_budget: 120_000,
      deadline_at: '2026-11-13T00:45:00.000Z',
    });
    await journal.close();

    const harness = makeHarness(runsRoot);
    const error = await harness.engine
      .run({
        task_id: IDENTITY.task_id,
        run_id: runId,
        role_id: IDENTITY.role_id,
        instruction: 'implement the task',
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(RoleTerminationError);
    expect((error as RoleTerminationError).termination.code).toBe('host_failed');
    expect((error as RoleTerminationError).termination.details).toMatchObject({
      reason: 'role_freeze_invalid',
    });
    expect(harness.loopCalls).toHaveLength(0);
  });
});
