/**
 * 阶段 2 引擎选路与冻结判定的行为测试（SEL-01/02/03/04/05/06/07/08 的选路部分）。
 *
 * 用真实临时 runs root + 真实 RunDispatchJournal 写入冻结 init 行；断言可观察的 engine 决定、
 * 冻结记录内容、祖先链继承与显式拒绝，而不是只测纯函数。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunDispatchJournal } from '../../src/persistence';
import {
  buildRoleFreezeInitInput,
  ROLE_AUTONOMY_ENGINE_VERSION,
  type RoleBudgetOverrides,
} from '../../src/app/role-autonomy-contract';
import { selectRoleExecutionEngine } from '../../src/app/role-autonomy-selection';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const IDENTITY = { task_id: 'task_1', role_id: 'role_1' };

interface Fixture {
  runsRoot: string;
  runId: string;
}

async function makeFixture(runId = 'run_1'): Promise<Fixture> {
  const runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-role-selection-'));
  temporaryDirectories.push(runsRoot);
  await fs.mkdir(path.join(runsRoot, runId), { recursive: true });
  return { runsRoot, runId };
}

function baseInput(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    runs_root: fixture.runsRoot,
    run_id: fixture.runId,
    task_id: IDENTITY.task_id,
    role_id: IDENTITY.role_id,
    mode: 'single_agent' as const,
    task_request: { spec: 'do the task', completion_criteria: [] },
    cursor_input: { cursor: 'execute_agent' as const, winner_agent_id: IDENTITY.role_id },
    config: { enabled: true, wired: true },
    now: new Date('2026-11-13T00:00:00.000Z'),
    ...overrides,
  };
}

async function writeFrozenInit(
  runsRoot: string,
  runId: string,
  engine: 'role_autonomy' | 'legacy',

): Promise<{ deadline_at: string; max_dispatches: number }> {
  const runDir = path.join(runsRoot, runId);
  await fs.mkdir(runDir, { recursive: true });
  const journal = await RunDispatchJournal.open({
    runDir,
    identity: { run_id: runId, ...IDENTITY },
  });
  const now = new Date('2026-11-13T00:00:00.000Z');
  const limits = {
    max_dispatches: 5,
    max_role_rounds: 7,
    role_token_budget: 1_000,
    wall_clock_seconds: 60,
    dispatch_timeout_ms: 2_000,
  };
  const deadlineAt = new Date(now.getTime() + 60_000).toISOString();
  if (engine === 'role_autonomy') {
    const freeze = buildRoleFreezeInitInput({ limits, deadline_at: deadlineAt });
    await journal.appendInit({ ...freeze, at: now.toISOString() });
  } else {
    await journal.appendInit({
      autonomy: false,
      evidence_only: false,
      buffer_v2: false,
      max_dispatches: limits.max_dispatches,
      max_role_rounds: limits.max_role_rounds,
      role_token_budget: limits.role_token_budget,
      deadline_at: deadlineAt,
      at: now.toISOString(),
    });
  }
  await journal.close();
  return { deadline_at: deadlineAt, max_dispatches: limits.max_dispatches };
}

async function writeRecoveryParent(
  runsRoot: string,
  runId: string,
  parentRunId: string,
): Promise<void> {
  await fs.mkdir(path.join(runsRoot, runId), { recursive: true });
  await fs.writeFile(
    path.join(runsRoot, runId, 'request.json'),
    JSON.stringify({ recovery_parent_run_id: parentRunId }),
    'utf8',
  );
}

describe('role-autonomy 引擎选路', () => {
  it('开关关闭：全新 single_agent Run 走 legacy（旧路径默认不变）', async () => {
    const fixture = await makeFixture();
    const selection = await selectRoleExecutionEngine({
      ...baseInput(fixture),
      config: { enabled: false, wired: false },
    });
    expect(selection).toMatchObject({ engine: 'legacy', reason: 'role_autonomy_disabled' });
  });

  it('显式开关 on + 已装配：全新 single_agent Run 选 role_autonomy 并生成冻结初值', async () => {
    const fixture = await makeFixture();
    const selection = await selectRoleExecutionEngine(baseInput(fixture));
    expect(selection.engine).toBe('role_autonomy');
    if (selection.engine !== 'role_autonomy' || selection.reason !== 'fresh_role_autonomy') return;
    expect(selection.frozen.engine_version).toBe(ROLE_AUTONOMY_ENGINE_VERSION);
    expect(selection.frozen.tool_allowlist).toEqual([
      'dispatch_execution',
      'query_memory',
      'read_evidence',
      'update_plan',
      'finish_task',
    ]);
    expect(selection.frozen.evidence_only).toBe(false);
    expect(selection.frozen.buffer_v2).toBe(false);
    expect(selection.freeze_input.max_dispatches).toBe(12);
    expect(selection.freeze_input.max_role_rounds).toBe(40);
    expect(selection.freeze_input.role_token_budget).toBe(120_000);
    expect(selection.freeze_input.deadline_at).toBe('2026-11-13T00:45:00.000Z');
    expect(selection.freeze_input.dispatch_timeout_ms).toBe(600_000);
  });

  it('请求覆盖只能收紧：调大被忽略，非法值被显式拒绝', async () => {
    const fixture = await makeFixture();
    const tightened = await selectRoleExecutionEngine({
      ...baseInput(fixture),
      config: {
        enabled: true,
        wired: true,
        budget_overrides: { max_dispatches: 3 } satisfies RoleBudgetOverrides,
      },
    });
    expect(tightened.engine).toBe('role_autonomy');
    if (tightened.engine === 'role_autonomy' && tightened.reason === 'fresh_role_autonomy') {
      expect(tightened.freeze_input.max_dispatches).toBe(3);
      expect(tightened.freeze_input.max_role_rounds).toBe(40);
    }
    const raised = await selectRoleExecutionEngine({
      ...baseInput(fixture),
      config: {
        enabled: true,
        wired: true,
        budget_overrides: { max_dispatches: 99 } satisfies RoleBudgetOverrides,
      },
    });
    if (raised.engine === 'role_autonomy' && raised.reason === 'fresh_role_autonomy') {
      expect(raised.freeze_input.max_dispatches).toBe(12);
    }
    const invalid = await selectRoleExecutionEngine({
      ...baseInput(fixture),
      config: {
        enabled: true,
        wired: true,
        budget_overrides: { max_dispatches: -1 } as RoleBudgetOverrides,
      },
    });
    expect(invalid).toMatchObject({ engine: 'rejected', code: 'role_budget_override_invalid' });
  });

  it('TaskBudget 进入冻结策略：max_tokens/max_wall_clock_seconds/max_tool_calls 只能收紧', async () => {
    const fixture = await makeFixture();
    const selection = await selectRoleExecutionEngine({
      ...baseInput(fixture),
      config: {
        enabled: true,
        wired: true,
        task_budget: { max_tokens: 10, max_wall_clock_seconds: 5, max_tool_calls: 2 },
      },
      now: new Date('2026-11-13T00:00:00.000Z'),
    });
    expect(selection.engine).toBe('role_autonomy');
    if (selection.engine !== 'role_autonomy' || selection.reason !== 'fresh_role_autonomy') return;
    expect(selection.freeze_input).toMatchObject({
      role_token_budget: 10,
      deadline_at: '2026-11-13T00:00:05.000Z',
      max_tool_calls: 2,
    });
    expect(selection.frozen.budget).toMatchObject({
      deadline_at: '2026-11-13T00:00:05.000Z',
      max_tool_calls: 2,
    });
    // 冻结计划与 frozen policy 来自同一份构造结果，stage 直接原样传递（不再按字段重拼）。
    expect(selection.freeze_plan).toMatchObject({
      limits: { role_token_budget: 10 },
      deadline_at: '2026-11-13T00:00:05.000Z',
      max_tool_calls: 2,
      frozen_at: '2026-11-13T00:00:00.000Z',
    });
    expect(selection.frozen_at).toBe('2026-11-13T00:00:00.000Z');
    // 放大请求仍被宿主上限压住。
    const raised = await selectRoleExecutionEngine({
      ...baseInput(fixture),
      config: {
        enabled: true,
        wired: true,
        task_budget: { max_tokens: 999_999, max_wall_clock_seconds: 99_999, max_tool_calls: 999 },
      },
    });
    if (raised.engine === 'role_autonomy' && raised.reason === 'fresh_role_autonomy') {
      expect(raised.freeze_input.role_token_budget).toBe(120_000);
      expect(raised.freeze_input.max_tool_calls).toBe(64);
    }
  });

  it('损坏 Journal：显式拒绝（journal_corrupt），不当作「无冻结记录」降级 legacy', async () => {
    const fixture = await makeFixture();
    const journalDir = path.join(fixture.runsRoot, fixture.runId, 'journal');
    await fs.mkdir(journalDir, { recursive: true });
    await fs.writeFile(path.join(journalDir, 'dispatches.jsonl'), '{}\n{}\n', 'utf8');
    const selection = await selectRoleExecutionEngine(baseInput(fixture));
    expect(selection).toMatchObject({ engine: 'rejected', code: 'journal_corrupt' });
  });

  it('不可读 Journal（IO 错误）：显式拒绝（journal_unreadable），不吞掉', async () => {
    const fixture = await makeFixture();
    const journalDir = path.join(fixture.runsRoot, fixture.runId, 'journal');
    // 用目录占住 journal 文件路径：readFile 抛 EISDIR，不是 ENOENT。
    await fs.mkdir(path.join(journalDir, 'dispatches.jsonl'), { recursive: true });
    const selection = await selectRoleExecutionEngine(baseInput(fixture));
    expect(selection).toMatchObject({ engine: 'rejected', code: 'journal_unreadable' });
  });

  it('损坏的 request.json：恢复链读取失败显式拒绝（journal_unreadable / lineage_unreadable），不当作无父链', async () => {
    const fixture = await makeFixture('run_corrupt_request');
    await fs.writeFile(
      path.join(fixture.runsRoot, fixture.runId, 'request.json'),
      '{not-json',
      'utf8',
    );
    const selection = await selectRoleExecutionEngine(baseInput(fixture));
    expect(selection).toMatchObject({
      engine: 'rejected',
      reason: 'lineage_unreadable',
      code: 'journal_unreadable',
    });
  });

  it('已开始的 legacy Run（有阶段证据、无冻结记录）不被新开关接管', async () => {
    const fixture = await makeFixture('run_started_legacy');
    await fs.mkdir(path.join(fixture.runsRoot, fixture.runId, 'stages'), { recursive: true });
    await fs.writeFile(
      path.join(fixture.runsRoot, fixture.runId, 'stages', 'execute_agent.json'),
      JSON.stringify({ status: 'completed' }),
      'utf8',
    );
    const selection = await selectRoleExecutionEngine(baseInput(fixture));
    expect(selection).toMatchObject({
      engine: 'legacy',
      reason: 'started_run_without_frozen_engine',
    });
  });

  it('排除项：council / 主动 Council / Mailbox 投递回合一律 legacy', async () => {
    const cases: Array<{ name: string; overrides: Record<string, unknown> }> = [
      { name: 'council', overrides: { mode: 'council' } },
      {
        name: 'active-council',
        overrides: {
          task_request: { spec: 'task', completion_criteria: [], allow_agent_council: true },
        },
      },
      {
        name: 'mailbox-delivery',
        overrides: {
          cursor_input: {
            cursor: 'execute_agent',
            winner_agent_id: IDENTITY.role_id,
            mailbox_delivery_id: 'delivery_1',
          },
        },
      },
    ];
    for (const testCase of cases) {
      const fixture = await makeFixture(`run_${testCase.name.replace(/[^A-Za-z0-9]/g, '_')}`);
      const selection = await selectRoleExecutionEngine(baseInput(fixture, testCase.overrides));
      expect(selection.engine, testCase.name).toBe('legacy');
    }
  });

  it('开关 on 但组合根未装配 role-loop：显式拒绝（host_failed），不静默降级', async () => {
    const fixture = await makeFixture();
    const selection = await selectRoleExecutionEngine({
      ...baseInput(fixture),
      config: { enabled: true, wired: false },
    });
    expect(selection).toMatchObject({
      engine: 'rejected',
      code: 'role_loop_not_wired',
    });
  });

  it('已冻结 role_autonomy 的 Run：部署开关关闭后仍沿用冻结引擎与预算/deadline', async () => {
    const fixture = await makeFixture();
    const frozen = await writeFrozenInit(fixture.runsRoot, fixture.runId, 'role_autonomy');
    const selection = await selectRoleExecutionEngine({
      ...baseInput(fixture),
      config: { enabled: false, wired: true },
    });
    expect(selection.engine).toBe('role_autonomy');
    if (selection.engine !== 'role_autonomy' || selection.reason !== 'frozen_role_autonomy') return;
    expect(selection.frozen_from_run_id).toBe(fixture.runId);
    expect(selection.frozen.budget.deadline_at).toBe(frozen.deadline_at);
    expect(selection.frozen.budget.limits.max_dispatches).toBe(frozen.max_dispatches);
    expect(selection.frozen.budget.limits.wall_clock_seconds).toBe(60);
  });

  it('冻结为 legacy 的 Run：即使部署开关后来打开也保持 legacy', async () => {
    const fixture = await makeFixture();
    await writeFrozenInit(fixture.runsRoot, fixture.runId, 'legacy');
    const selection = await selectRoleExecutionEngine(baseInput(fixture));
    expect(selection.engine).toBe('legacy');
  });

  it('旧 Run/祖先链无冻结记录：按 legacy 解释，不被新默认值接管', async () => {
    const fixture = await makeFixture('run_resumed');
    await writeRecoveryParent(fixture.runsRoot, fixture.runId, 'run_parent');
    // 父 Run 无 journal（旧 Run）。
    const selection = await selectRoleExecutionEngine({
      ...baseInput(fixture),
      restarted_from_run_id: 'run_parent',
    });
    expect(selection).toMatchObject({ engine: 'legacy', reason: 'resumed_without_frozen_engine' });
  });

  it('祖先链已有 role_autonomy 冻结：新 Run 沿用该冻结记录（只读继承）', async () => {
    const parentId = 'run_parent';
    const fixture = await makeFixture('run_child');
    const frozen = await writeFrozenInit(fixture.runsRoot, parentId, 'role_autonomy');
    await writeRecoveryParent(fixture.runsRoot, fixture.runId, parentId);
    const selection = await selectRoleExecutionEngine({
      ...baseInput(fixture),
      restarted_from_run_id: parentId,
      config: { enabled: false, wired: true },
    });
    expect(selection.engine).toBe('role_autonomy');
    if (selection.engine !== 'role_autonomy' || selection.reason !== 'frozen_role_autonomy') return;
    expect(selection.frozen_from_run_id).toBe(parentId);
    expect(selection.frozen.budget.deadline_at).toBe(frozen.deadline_at);
  });

  it('冻结记录不完整（缺引擎版本/工具授权）时显式拒绝，不补默认值', async () => {
    const fixture = await makeFixture();
    const runDir = path.join(fixture.runsRoot, fixture.runId);
    const journal = await RunDispatchJournal.open({
      runDir,
      identity: { run_id: fixture.runId, ...IDENTITY },
    });
    // 手工写一个「只有 autonomy 字段、没有阶段 2 引擎字段」的 init 行。
    await journal.appendInit({
      autonomy: true,
      evidence_only: false,
      buffer_v2: false,
      max_dispatches: 12,
      max_role_rounds: 40,
      role_token_budget: 120_000,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await journal.close();
    const selection = await selectRoleExecutionEngine(baseInput(fixture));
    expect(selection).toMatchObject({ engine: 'rejected', code: 'role_freeze_invalid' });
  });
});
