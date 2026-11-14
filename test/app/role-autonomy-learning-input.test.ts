/**
 * 阶段 3 role 学习输入接线的行为测试（真实临时 runs root + 真实 Journal + 真实
 * BufferRepository，loop/driver 用可控替身；断言落盘事实与在线登记，不复刻实现细节）。
 *
 * 覆盖：evidence-only + Buffer v2 的落盘内容（派工摘要 / Journal 前缀 / Role 反思 /
 * 记忆使用 / source_drivers）、零派工表示、恢复不重复写、开关关闭不写、非法冻结组合
 * 显式失败、Journal 后续追加不改变既有前缀 hash。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExecutionBrief, hashExecutionBrief } from '../../src/driver';
import type { DriverRunResult, DriverRuntimeHandle } from '../../src/driver/contract';
import { SCHEMA_VERSION } from '../../src/core';
import { RunDispatchJournal } from '../../src/persistence';
import {
  InMemoryBufferRepository,
  InMemoryMemoryDeliveryRepository,
  InMemoryRepository,
  isBufferSnapshotV2,
  type BufferSnapshotV2,
} from '../../src/memory';
import {
  BMemoryMaintenanceRunner,
  FileBMemoryMaintenanceEvidenceStore,
} from '../../src/app/b-memory-maintenance-runner';
import {
  RoleTerminationError,
  type RoleBudgetConsumption,
  type RoleBudgetPort,
  type RoleFinishValidatorPort,
  type RoleFrozenPolicyPlan,
  type RoleLoopOptions,
  type RoleLoopOutcome,
} from '../../src/app/role-autonomy-contract';
import { RoleAutonomyEngine } from '../../src/app/role-autonomy-engine';
import {
  buildJournalPrefixRef,
  buildRoleLearningInput,
} from '../../src/app/role-learning-input';
import type { DispatchJournalReadResult } from '../../src/persistence';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const IDENTITY = { task_id: 'task_1', role_id: 'role_1' };
const RUN_ID = 'run_1';

function driverResult(): DriverRunResult {
  return {
    driver_run_result_id: 'drr_1',
    session_id: 'session_1',
    status: 'succeeded',
    response: 'done',
    artifacts: [],
    transcript_ref: {
      artifact_id: 'artifact_transcript',
      type: 'transcript',
      uri: 'artifact://transcript/task_1/session_1',
      producer_id: 'driver_test',
      created_at: '2026-11-14T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    },
    tool_events: [],
    diagnostics: { driver_id: 'driver_test', duration_ms: 5, notes: [] },
    created_at: '2026-11-14T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function fakeDriver(prompts: string[]): DriverRuntimeHandle {
  return {
    driver_id: 'driver_test',
    session_id: 'session_1',
    capabilities: {
      supports_acp_extension: false,
      supports_structured_output: true,
      supports_session_load: false,
      supports_tool_events: false,
      supports_permission_events: false,
    },
    sendPrompt: async (prompt) => {
      prompts.push(prompt.prompt);
      return driverResult();
    },
    interrupt: async () => undefined,
    collectTranscript: async () => driverResult().transcript_ref,
  };
}

function fakeBudgetPort(): RoleBudgetPort {
  const consumed: RoleBudgetConsumption = {
    dispatches: 0,
    role_rounds: 0,
    tokens: 0,
    tool_calls: 0,
    tokens_missing: false,
  };
  return {
    frozen: {
      limits: {
        max_dispatches: 12,
        max_role_rounds: 40,
        role_token_budget: 120_000,
        wall_clock_seconds: 2_700,
        dispatch_timeout_ms: 600_000,
      },
      deadline_at: '2027-11-14T00:45:00.000Z',
    },
    snapshot: () => ({
      frozen: {
        limits: {
          max_dispatches: 12,
          max_role_rounds: 40,
          role_token_budget: 120_000,
          wall_clock_seconds: 2_700,
          dispatch_timeout_ms: 600_000,
        },
        deadline_at: '2027-11-14T00:45:00.000Z',
      },
      consumed,
      wall_clock_remaining_ms: 1_000_000,
    }),
    assertRoundAllowed: () => undefined,
    recordRound: async () => undefined,
    assertDispatchAllowed: () => undefined,
    recordDispatch: () => undefined,
    assertTokenBudget: () => undefined,
  };
}

function finishValidator(): RoleFinishValidatorPort {
  return {
    validate: async () => ({
      accepted: false,
      gaps: [{ code: 'journal_unavailable', message: 'not used by this fake loop' }],
    }),
  };
}

function frozenPlan(
  overrides: Partial<RoleFrozenPolicyPlan> = {},
): RoleFrozenPolicyPlan {
  return {
    limits: {
      max_dispatches: 12,
      max_role_rounds: 40,
      role_token_budget: 120_000,
      wall_clock_seconds: 2_700,
      dispatch_timeout_ms: 600_000,
    },
    deadline_at: '2027-11-14T00:45:00.000Z',
    frozen_at: '2026-11-14T00:00:00.000Z',
    max_tool_calls: 64,
    routing: {},
    evidence_only: true,
    buffer_v2: true,
    ...overrides,
  };
}

interface HarnessOptions {
  dispatchCount?: number;
  plan?: RoleFrozenPolicyPlan;
  useMemory?: boolean;
  finishStatus?: 'completed' | 'blocked' | 'failed';
}

interface Harness {
  engine: RoleAutonomyEngine;
  bufferRepository: InMemoryBufferRepository;
  register: ReturnType<typeof vi.fn>;
  loopCalls: RoleLoopOptions[];
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-role-learning-'));
  temporaryDirectories.push(runsRoot);
  await fs.mkdir(path.join(runsRoot, RUN_ID), { recursive: true });

  const repository = new InMemoryRepository();
  await repository.initializeAgent({ role_id: IDENTITY.role_id, name: IDENTITY.role_id });
  const bufferRepository = new InMemoryBufferRepository();
  await bufferRepository.ensureAgent(IDENTITY.role_id);

  const driverPrompts: string[] = [];
  const deliveryRepository = options.realMaintenance
    ? new InMemoryMemoryDeliveryRepository()
    : undefined;
  const maintenance = deliveryRepository
    ? new BMemoryMaintenanceRunner({
        repository,
        bufferRepository,
        deliveryRepository,
        evidenceStore: new FileBMemoryMaintenanceEvidenceStore(path.join(runsRoot, 'evidence')),
        llm: { complete: async () => '{}' } as never,
      })
    : undefined;
  const register = vi.fn(
    async (input: {
      role_id: string;
      task_id: string;
      run_id: string;
      buffer_seq: number;
      workspace_path?: string;
    }) => {
      await maintenance?.scheduleBuffer(input);
    },
  );
  const loopCalls: RoleLoopOptions[] = [];
  let sequence = 0;
  const loop = async (loopOptions: RoleLoopOptions): Promise<RoleLoopOutcome> => {
    loopCalls.push(loopOptions);
    const observations: RoleLoopOutcome['dispatches'] = [];
    if (options.useMemory === true) {
      await loopOptions.memory.recall(
        {
          task_id: IDENTITY.task_id,
          run_id: RUN_ID,
          role_id: IDENTITY.role_id,
          instruction: 'do the task',
        },
        undefined,
      );
      await loopOptions.memory.query({ query: 'previous attempts' });
    }
    for (let index = 0; index < (options.dispatchCount ?? 0); index += 1) {
      sequence += 1;
      const brief = buildExecutionBrief({
        identity: {
          dispatch_id: `dsp_${String(sequence)}`,
          run_id: RUN_ID,
          task_id: IDENTITY.task_id,
          role_id: IDENTITY.role_id,
          sequence,
          accepted_at: '2026-11-14T00:00:00.000Z',
        },
        request: { kind: 'execute', instruction: `do work ${String(sequence)}` },
      }).brief;
      observations.push(
        await loopOptions.dispatch.run({
          brief,
          brief_sha256: hashExecutionBrief(brief),
          budget_before: {
            dispatches_left: 11,
            role_tokens_left: 120_000,
            deadline_at: '2027-11-14T00:45:00.000Z',
          },
        }),
      );
    }
    const status = options.finishStatus ?? 'completed';
    const summary =
      status === 'blocked'
        ? 'blocked in this run'
        : status === 'failed'
          ? 'failed in this run'
          : 'finished the task';
    await loopOptions.journal.appendFinish({
      actor: 'role',
      status,
      reason: summary,
      evidence_refs: [],
      summary,
      unresolved: status === 'blocked' ? ['tests not run'] : [],
      role_reflection: 'chose the simple fix',
      response_only: observations.length === 0 && status === 'completed',
      zero_dispatch: observations.length === 0,
      verification:
        observations.length > 0
          ? [
              {
                requirement: 'implementation done',
                outcome: 'not_run',
                dispatch_ids: observations.map((observation) => observation.dispatch_id),
                evidence_refs: [],
              },
            ]
          : [],
      at: '2026-11-14T00:00:01.000Z',
      entry_id: 'fin_1',
    });
    return {
      status,
      finish: {
        status,
        summary,
        evidence_refs: [],
        unresolved: status === 'blocked' ? ['tests not run'] : [],
        role_reflection: 'chose the simple fix',
        response_only: observations.length === 0 && status === 'completed',
        verification: [],
        accepted_at: '2026-11-14T00:00:01.000Z',
      },
      response: summary,
      dispatches: observations,
      usage: { input_tokens: 10, output_tokens: 5, usage_missing: false, role_rounds: 1 },
      zero_dispatch: observations.length === 0,
      plan: 'plan text',
      unresolved_dispatches: [],
    };
  };

  const engine = new RoleAutonomyEngine({
    runs_root: runsRoot,
    llm: { completeWithTools: async () => ({ content: null, tool_calls: undefined }) },
    repository,
    buffer_repository: bufferRepository,
    driver_for: () => fakeDriver(driverPrompts),
    create_budget: () => fakeBudgetPort(),
    create_finish_validator: () => finishValidator(),
    run_loop: loop,
    learning_input: { register },
  });

  return { engine, runsRoot, driverPrompts, bufferRepository, deliveryRepository, register, loopCalls };
}

function request(plan: RoleFrozenPolicyPlan) {
  return {
    task_id: IDENTITY.task_id,
    run_id: RUN_ID,
    role_id: IDENTITY.role_id,
    instruction: 'implement the task',
    freeze_plan: plan,
  };
}

async function pendingV2(
  bufferRepository: InMemoryBufferRepository,
  roleId = IDENTITY.role_id,
): Promise<{ seq: number; snapshot: BufferSnapshotV2 } | undefined> {
  for (const seq of await bufferRepository.listPendingBufferSeqs(roleId)) {
    const pending = await bufferRepository.getPendingBuffer(roleId, seq);
    if (pending && isBufferSnapshotV2(pending.snapshot)) {
      return { seq, snapshot: pending.snapshot };
    }
  }
  return undefined;
}

describe('role 学习输入（Buffer v2）接线', () => {
  it('evidence-only + buffer_v2：零派工完成也写出真实 v2 学习输入并在线登记', async () => {
    const harness = await makeHarness();
    const result = await harness.engine.run(request(frozenPlan()));

    expect(result.status).toBe('completed');
    expect(harness.loopCalls).toHaveLength(1);
    const learning = result.diagnostics.learning_input as {
      buffer_seq: number;
      created: boolean;
      journal_ref: { lines: number; sha256: string };
    };
    expect(learning.created).toBe(true);
    expect(harness.register).toHaveBeenCalledTimes(1);
    expect(harness.register.mock.calls[0]?.[0]).toMatchObject({
      task_id: IDENTITY.task_id,
      run_id: RUN_ID,
      role_id: IDENTITY.role_id,
      buffer_seq: learning.buffer_seq,
    });

    const stored = await pendingV2(harness.bufferRepository);
    expect(stored).toBeDefined();
    const snapshot = stored!.snapshot;
    expect(snapshot.dispatches).toEqual([]);
    expect(snapshot.source_drivers).toEqual([]);
    expect(snapshot.source_driver).toBeUndefined();
    expect(snapshot.role_reflection.summary).toBe('finished the task');
    expect(snapshot.role_reflection.status).toBe('completed');
    expect(snapshot.role_reflection.reflection).toBe('chose the simple fix');
    expect(snapshot.plan).toBe('plan text');
    expect(snapshot.journal_ref.lines).toBeGreaterThanOrEqual(2);
    expect(snapshot.journal_ref.sha256).toMatch(/^[a-f0-9]{64}$/);
    // 学习输入写在 role 名下（更换 driver 不改变记忆归属）。
    await expect(harness.bufferRepository.listPendingBufferSeqs('role_1')).resolves.toBeDefined();
  });

  it('单次派工：摘要含 dispatch_id/status/kind/evidence ref，来源 driver 去重为集合', async () => {
    const harness = await makeHarness({ dispatchCount: 1 });
    const result = await harness.engine.run(request(frozenPlan()));
    const stored = await pendingV2(harness.bufferRepository);
    expect(result.status).toBe('completed');
    expect(stored?.snapshot.dispatches).toHaveLength(1);
    const dispatch = stored!.snapshot.dispatches[0]!;
    expect(dispatch).toMatchObject({
      dispatch_id: 'dsp_1',
      kind: 'execute',
      status: 'succeeded',
      driver_id: 'driver_test',
    });
    expect(dispatch.evidence_ref?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.snapshot.source_drivers).toEqual(['driver_test']);
    expect(stored?.snapshot.source_driver).toBe('driver_test');
    // 冻结的 evidence_only 传到了派工分支：prompt 不含六字段报告/报告文件指令。
    expect(harness.driverPrompts).toHaveLength(1);
    expect(harness.driverPrompts[0]).not.toContain('<<<DRIVER_RETURN>>>');
    expect(harness.driverPrompts[0]).not.toContain('_report.txt');
  });

  it('记忆使用取宿主实际交付的召回/查询结果（host-observed），不是 Role 自述', async () => {
    const harness = await makeHarness({ useMemory: true });
    await harness.engine.run(request(frozenPlan()));
    const stored = await pendingV2(harness.bufferRepository);
    // 记忆库为空时只记录 persona（构建时总会交付）；有经验时还会记录 experience/skill id。
    expect(stored?.snapshot.role_reflection.memory_used.length).toBeGreaterThan(0);
    expect(
      stored?.snapshot.role_reflection.memory_used.every((entry) => entry.via !== undefined),
    ).toBe(true);
  });

  it('恢复重跑（Journal 已有 finish）复用同一条 Buffer，不重复写/不双提取，状态保持一致', async () => {
    const harness = await makeHarness({ finishStatus: 'blocked' });    const firstError = await harness.engine.run(request(frozenPlan())).catch((error) => error);
    expect(firstError).toBeInstanceOf(RoleTerminationError);
    const stored = await pendingV2(harness.bufferRepository);
    expect(stored?.snapshot.role_reflection.status).toBe('blocked');
    const firstSeq = (firstError.termination.details as { learning_input: { buffer_seq: number } })
      .learning_input.buffer_seq;
    const secondError = await harness.engine.run(request(frozenPlan())).catch((error) => error);
    expect(secondError).toBeInstanceOf(RoleTerminationError);
    const secondLearning = (secondError.termination.details as {
      learning_input: { buffer_seq: number; created: boolean };
    }).learning_input;
    expect(secondLearning.buffer_seq).toBe(firstSeq);
    expect(secondLearning.created).toBe(false);
    expect(await harness.bufferRepository.listPendingBufferSeqs(IDENTITY.role_id)).toHaveLength(1);
    const afterResume = await pendingV2(harness.bufferRepository);
    expect(afterResume?.snapshot.role_reflection.status).toBe('blocked');
  });

  it('completed finish 恢复重跑同样保留 completed 状态', async () => {
    const harness = await makeHarness();
    const first = await harness.engine.run(request(frozenPlan()));
    const second = await harness.engine.run(request(frozenPlan()));
    const firstSeq = (first.diagnostics.learning_input as { buffer_seq: number }).buffer_seq;
    const secondLearning = second.diagnostics.learning_input as {
      buffer_seq: number;
      created: boolean;
    };
    expect(secondLearning.buffer_seq).toBe(firstSeq);
    expect(secondLearning.created).toBe(false);
    const stored = await pendingV2(harness.bufferRepository);
    expect(stored?.snapshot.role_reflection.status).toBe('completed');
  });

  it('buffer_v2 关闭时不写 v2 学习输入（开关默认关闭语义）', async () => {
    const harness = await makeHarness({
      plan: frozenPlan({ buffer_v2: false, evidence_only: true }),
    });
    const result = await harness.engine.run(request(frozenPlan({ buffer_v2: false })));
    expect(result.status).toBe('completed');
    expect(result.diagnostics.learning_input).toBeUndefined();
    expect(await pendingV2(harness.bufferRepository)).toBeUndefined();
    expect(harness.register).not.toHaveBeenCalled();
  });

  it('非法冻结组合（buffer_v2 打开但 evidence_only 关闭）显式失败', async () => {
    const harness = await makeHarness();
    await expect(
      harness.engine.run(
        request(frozenPlan({ evidence_only: false, buffer_v2: true })),
      ),
    ).rejects.toMatchObject({
      name: 'RoleTerminationError',
      termination: { code: 'host_failed', details: { reason: 'role_switch_invalid' } },
    } satisfies Partial<RoleTerminationError>);
  });

  it('blocked finish 也登记真实 v2 学习输入（失败事实不被丢弃）', async () => {
    const harness = await makeHarness({ finishStatus: 'blocked' });
    await expect(harness.engine.run(request(frozenPlan()))).rejects.toBeInstanceOf(
      RoleTerminationError,
    );
    const stored = await pendingV2(harness.bufferRepository);
    expect(stored).toBeDefined();
    expect(stored?.snapshot.role_reflection.status).toBe('blocked');
    expect(stored?.snapshot.role_reflection.unresolved).toEqual(['tests not run']);
    expect(harness.register).toHaveBeenCalledTimes(1);
  });

  it('failed finish 的结束状态完整进入 Buffer（不是缺省 completed）', async () => {
    const harness = await makeHarness({ finishStatus: 'failed' });
    await expect(harness.engine.run(request(frozenPlan()))).rejects.toBeInstanceOf(
      RoleTerminationError,
    );
    const stored = await pendingV2(harness.bufferRepository);
    expect(stored?.snapshot.role_reflection.status).toBe('failed');
    expect(stored?.snapshot.role_reflection.summary).toBe('failed in this run');
    expect(stored?.snapshot.dispatches).toEqual([]);
  });

  it('实际装配 maintenance.scheduleBuffer：登记一条 v2 Context Delivery，在线不提取', async () => {
    const harness = await makeHarness({ realMaintenance: true });
    const result = await harness.engine.run(request(frozenPlan()));
    expect(result.status).toBe('completed');
    const seq = (result.diagnostics.learning_input as { buffer_seq: number }).buffer_seq;
    const items = await harness.deliveryRepository?.listContextDeliveries({
      role_id: IDENTITY.role_id,
    });
    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({
      buffer_seq: seq,
      buffer_version: 2,
      source_drivers: [],
      status: 'pending',
    });
    expect(items?.[0]?.source_driver).toBeUndefined();
    // 在线只登记：Buffer 仍在 pending（经验提取/归档是离线 worker 的事）。
    const stored = await harness.bufferRepository.getStoredBuffer(IDENTITY.role_id, seq);
    expect(stored?.location).toBe('pending');
  });

  it('在线登记失败只降级为诊断事实，不把已完成任务报成失败', async () => {
    const harness = await makeHarness();
    harness.register.mockRejectedValueOnce(new Error('outbox unavailable'));
    const result = await harness.engine.run(request(frozenPlan()));
    expect(result.status).toBe('completed');
    expect(
      (result.diagnostics.learning_input as { registration_error?: string }).registration_error,
    ).toContain('outbox unavailable');
    // Buffer 仍然落盘：登记失败不等于输入丢失。
    expect(await pendingV2(harness.bufferRepository)).toBeDefined();
  });
});

describe('Journal 前缀引用', () => {
  it('后续追加行不改变到 finish 行为止的前缀 hash', () => {
    const read = (
      lines: DispatchJournalReadResult['lines'],
    ): DispatchJournalReadResult => ({
      kind: 'journal',
      status: 'ok',
      lines,
      entries: [],
      controls: [],
      repairs: [],
      problems: [],
      durability: { mode: 'fsync', directory_sync: true, notes: [] },
    });
    const base = {
      schema_version: 'newide.dispatch_journal.v1',
      entry_id: 'e',
      run_id: RUN_ID,
      task_id: IDENTITY.task_id,
      role_id: IDENTITY.role_id,
      at: '2026-11-14T00:00:00.000Z',
    } as const;
    const init = { ...base, event: 'init' as const, autonomy: true, evidence_only: true, buffer_v2: true, max_dispatches: 1, max_role_rounds: 1, role_token_budget: 1, deadline_at: '2027-11-14T00:00:00.000Z' };
    const finish = { ...base, event: 'finish' as const, actor: 'role' as const, status: 'completed' as const, reason: 'done', evidence_refs: [] };
    const round = { ...base, entry_id: 'r1', event: 'role_round' as const, round: 1, usage_missing: true };
    const prefix = buildJournalPrefixRef(read([init, finish]), RUN_ID);
    expect(prefix.lines).toBe(2);
    const afterAppend = buildJournalPrefixRef(read([init, finish, round]), RUN_ID);
    expect(afterAppend.lines).toBe(2);
    expect(afterAppend.sha256).toBe(prefix.sha256);
    expect(afterAppend.path).toBe('journal/dispatches.jsonl');
  });

  it('没有 finish 行时拒绝构造前缀（不猜一个边界）', () => {
    expect(() =>
      buildJournalPrefixRef(
        {
          kind: 'journal',
          status: 'ok',
          lines: [],
          entries: [],
          controls: [],
          repairs: [],
          problems: [],
          durability: { mode: 'fsync', directory_sync: true, notes: [] },
        },
        RUN_ID,
      ),
    ).toThrow(/no finish line/);
  });
});

describe('buildRoleLearningInput（纯函数）', () => {
  it('零派工不伪造 driver/执行事实，多来源按顺序去重', () => {
    const records: Parameters<typeof buildRoleLearningInput>[0]['records'] = [];
    const journalRead = {
      kind: 'journal' as const,
      status: 'ok' as const,
      lines: [
        {
          schema_version: 'newide.dispatch_journal.v1' as const,
          entry_id: 'e1',
          event: 'finish' as const,
          run_id: RUN_ID,
          task_id: IDENTITY.task_id,
          role_id: IDENTITY.role_id,
          at: '2026-11-14T00:00:00.000Z',
          actor: 'role' as const,
          status: 'completed' as const,
          reason: 'done',
          evidence_refs: [],
        },
      ],
      entries: [],
      controls: [],
      repairs: [],
      problems: [],
      durability: { mode: 'fsync' as const, directory_sync: true, notes: [] },
    };
    const snapshot = buildRoleLearningInput({
      task: {
        task_id: IDENTITY.task_id,
        run_id: RUN_ID,
        role_id: IDENTITY.role_id,
        task_description: 'answer without environment work',
      },
      outcome: {
        status: 'completed',
        finish: {
          status: 'completed',
          summary: 'answered',
          evidence_refs: [],
          unresolved: [],
          role_reflection: 'no dispatch needed',
          response_only: true,
          verification: [],
          accepted_at: '2026-11-14T00:00:00.000Z',
        },
        response: 'answered',
        dispatches: [],
        usage: { input_tokens: 1, output_tokens: 1, usage_missing: false, role_rounds: 1 },
        zero_dispatch: true,
        plan: undefined,
        unresolved_dispatches: [],
      },
      records,
      journal_read: journalRead,
      memory_used: [],
    });
    expect(snapshot.dispatches).toEqual([]);
    expect(snapshot.source_drivers).toEqual([]);
    expect(snapshot.source_driver).toBeUndefined();
  });
});

// 真实 Journal 恢复路径会重新读取 init 行：这里额外用真实 journal 读取一次冻结开关，
// 保证「恢复沿用冻结策略」不是只在 mock 上成立。
describe('冻结开关恢复', () => {
  it('第二次运行沿用 Journal 里冻结的 evidence_only/buffer_v2', async () => {
    const harness = await makeHarness();
    await harness.engine.run(request(frozenPlan()));
    const runDir = path.join(
      (harness.engine as unknown as { deps: { runs_root: string } }).deps.runs_root,
      RUN_ID,
    );
    const journal = await RunDispatchJournal.peek({
      runDir,
      identity: { run_id: RUN_ID, ...IDENTITY },
    });
    const init = (await journal.read()).controls.find((entry) => entry.event === 'init');
    expect(init).toMatchObject({ evidence_only: true, buffer_v2: true });
  });
});
