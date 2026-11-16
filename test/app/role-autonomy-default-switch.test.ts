/**
 * 阶段 5：普通 solo 新 Run 默认切换前的配置准备回归（不改代码默认值）。
 *
 * 覆盖三件事，全部走**真实组合根配置构造 + 真实选路**（`buildRoleAutonomySelectionConfig`
 * → `selectRoleExecutionEngine`），而不是只测纯函数：
 * 1. 生产默认值仍是「三开关全关」；把部署环境设成
 *    `NEWIDE_ROLE_AUTONOMY=1` + `NEWIDE_DRIVER_EVIDENCE_ONLY=1` + `NEWIDE_BUFFER_V2=1`
 *    后，普通 solo 全新 Run 选 role_autonomy（冻结证据/学习开关），Council / 主动 Council /
 *    Mailbox 投递回合仍走 legacy。
 * 2. 冻结语义：Run 首次进入 execute_agent 前把开关 + 预算写进 Journal `init` 后，部署默认值
 *    回滚（开关关掉、预算覆盖改小）不会改变该 Run 的解释器/额度；已开始但无冻结记录的旧
 *    Run 也不会被新默认值接管。
 * 3. 非法组合（stage 3 开关无 ROLE_AUTONOMY、BUFFER_V2 无 EVIDENCE_ONLY、预算覆盖非法）在
 *    启动构造/选路都显式拒绝，不静默降级 legacy；已冻结 role_autonomy 的 Run 在目标二进制
 *    未装配 role-loop 时显式拒绝（不偷换执行器）。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunDispatchJournal } from '../../src/persistence';
import { buildRoleAutonomySelectionConfig } from '../../src/app/backend-rpc-stdio';
import type { RoleAutonomySelectionConfig } from '../../src/app/role-autonomy-selection';
import { selectRoleExecutionEngine } from '../../src/app/role-autonomy-selection';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const IDENTITY = { task_id: 'task_default_switch', role_id: 'role_default_switch' };
const NOW = new Date('2026-11-15T00:00:00.000Z');

/** 默认切换要评审的生产候选组合（只作为测试输入，不改代码/仓库默认值）。 */
const DEFAULT_SWITCH_ENV = {
  NEWIDE_ROLE_AUTONOMY: '1',
  NEWIDE_DRIVER_EVIDENCE_ONLY: '1',
  NEWIDE_BUFFER_V2: '1',
} as const;

async function makeRunsRoot(): Promise<string> {
  const runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-default-switch-'));
  temporaryDirectories.push(runsRoot);
  return runsRoot;
}

async function makeRun(runsRoot: string, runId = 'run_1'): Promise<string> {
  const runDir = path.join(runsRoot, runId);
  await fs.mkdir(runDir, { recursive: true });
  return runDir;
}

interface SelectionOverrides {
  runId?: string;
  mode?: 'single_agent' | 'council';
  task_request?: Record<string, unknown>;
  cursor_input?: Record<string, unknown>;
  restarted_from_run_id?: string;
}

function selectionInput(
  runsRoot: string,
  config: RoleAutonomySelectionConfig,
  overrides: SelectionOverrides = {},
) {
  const runId = overrides.runId ?? 'run_1';
  return {
    runs_root: runsRoot,
    run_id: runId,
    task_id: IDENTITY.task_id,
    role_id: IDENTITY.role_id,
    mode: (overrides.mode ?? 'single_agent') as 'single_agent' | 'council',
    task_request: overrides.task_request ?? { spec: 'do the task', completion_criteria: [] },
    cursor_input: overrides.cursor_input ?? {
      cursor: 'execute_agent' as const,
      winner_agent_id: IDENTITY.role_id,
    },
    config,
    now: NOW,
    ...(overrides.restarted_from_run_id !== undefined
      ? { restarted_from_run_id: overrides.restarted_from_run_id }
      : {}),
  };
}

describe('阶段 5 默认切换配置准备（env → 组合根配置 → 选路）', () => {
  it('生产默认值仍是三开关全关：普通 solo 新 Run 走 legacy（不改代码默认值）', async () => {
    const runsRoot = await makeRunsRoot();
    await makeRun(runsRoot);
    const config = buildRoleAutonomySelectionConfig({}, { wired: true });
    expect(config).toMatchObject({
      enabled: false,
      wired: true,
      switches: { evidence_only: false, buffer_v2: false },
    });

    const selection = await selectRoleExecutionEngine(selectionInput(runsRoot, config));
    expect(selection).toMatchObject({ engine: 'legacy', reason: 'role_autonomy_disabled' });
  });

  it('候选默认组合 1/1/1：普通 solo 新 Run 选 role_autonomy 并冻结证据/学习开关与预算', async () => {
    const runsRoot = await makeRunsRoot();
    await makeRun(runsRoot);
    const config = buildRoleAutonomySelectionConfig(DEFAULT_SWITCH_ENV, { wired: true });

    const selection = await selectRoleExecutionEngine(selectionInput(runsRoot, config));
    expect(selection.engine).toBe('role_autonomy');
    if (selection.engine !== 'role_autonomy' || selection.reason !== 'fresh_role_autonomy') return;

    // 三个开关（自主 + evidence-only + buffer v2）一起进入冻结策略，不靠 Run 内再读部署值。
    expect(selection.frozen.evidence_only).toBe(true);
    expect(selection.frozen.buffer_v2).toBe(true);
    expect(selection.freeze_plan.evidence_only).toBe(true);
    expect(selection.freeze_plan.buffer_v2).toBe(true);
    expect(selection.freeze_input).toMatchObject({
      autonomy: true,
      evidence_only: true,
      buffer_v2: true,
      engine: 'role_autonomy',
      // 设计初值（默认预算未收紧时）。
      max_dispatches: 12,
      max_role_rounds: 40,
      role_token_budget: 120_000,
      dispatch_timeout_ms: 600_000,
    });
    // deadline 与冻结时刻同一次时钟读数：墙钟上限恰好 45 分钟。
    expect(selection.frozen_at).toBe(NOW.toISOString());
    expect(selection.freeze_input.deadline_at).toBe('2026-11-15T00:45:00.000Z');
    expect(selection.frozen.budget.limits.wall_clock_seconds).toBe(45 * 60);
  });

  it('候选默认组合下 Council / 主动 Council / Mailbox 投递回合仍走 legacy', async () => {
    const runsRoot = await makeRunsRoot();
    const config = buildRoleAutonomySelectionConfig(DEFAULT_SWITCH_ENV, { wired: true });
    const cases: Array<{ name: string; overrides: SelectionOverrides; reason: string }> = [
      { name: 'council', overrides: { mode: 'council' }, reason: 'mode_council' },
      {
        name: 'active-council',
        overrides: {
          task_request: { spec: 'task', completion_criteria: [], allow_agent_council: true },
        },
        reason: 'active_council',
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
        reason: 'mailbox_delivery',
      },
    ];
    for (const testCase of cases) {
      const runId = `run_${testCase.name.replace(/[^A-Za-z0-9]/g, '_')}`;
      await makeRun(runsRoot, runId);
      const selection = await selectRoleExecutionEngine(
        selectionInput(runsRoot, config, { ...testCase.overrides, runId }),
      );
      expect(selection, testCase.name).toMatchObject({
        engine: 'legacy',
        reason: testCase.reason,
      });
    }
  });

  it('新 Run 冻结后部署默认值回滚：继续冻结策略（开关/预算/deadline 均不被替换）', async () => {
    const runsRoot = await makeRunsRoot();
    const runDir = await makeRun(runsRoot);
    const forwardConfig = buildRoleAutonomySelectionConfig(DEFAULT_SWITCH_ENV, { wired: true });

    // 真实顺序：第一次进入 execute_agent 选路 → engine 在调 LLM 前把 init 行写进 Journal。
    const fresh = await selectRoleExecutionEngine(selectionInput(runsRoot, forwardConfig));
    expect(fresh.engine).toBe('role_autonomy');
    if (fresh.engine !== 'role_autonomy' || fresh.reason !== 'fresh_role_autonomy') return;
    const journal = await RunDispatchJournal.open({
      runDir,
      identity: { run_id: 'run_1', ...IDENTITY },
    });
    await journal.appendInit({ ...fresh.freeze_input, at: fresh.frozen_at });
    await journal.close();

    // 部署默认值回滚：三个开关全关，并把部署预算覆盖改小。已开始的 Run 不得换解释器/额度。
    const rollbackConfig = buildRoleAutonomySelectionConfig(
      {
        ...DEFAULT_SWITCH_ENV,
        NEWIDE_ROLE_AUTONOMY: '0',
        NEWIDE_DRIVER_EVIDENCE_ONLY: '0',
        NEWIDE_BUFFER_V2: '0',
        NEWIDE_ROLE_MAX_DISPATCHES: '1',
      },
      { wired: true },
    );
    const resumed = await selectRoleExecutionEngine(selectionInput(runsRoot, rollbackConfig));
    expect(resumed.engine).toBe('role_autonomy');
    if (resumed.engine !== 'role_autonomy' || resumed.reason !== 'frozen_role_autonomy') return;
    expect(resumed.frozen_from_run_id).toBe('run_1');
    // 冻结的 stage 3 开关原样读回（不因部署回滚变成 false）。
    expect(resumed.frozen.evidence_only).toBe(true);
    expect(resumed.frozen.buffer_v2).toBe(true);
    // 冻结预算与 deadline 原样保留，部署覆盖（max_dispatches=1）不得改写已冻结额度。
    expect(resumed.frozen.budget.limits.max_dispatches).toBe(12);
    expect(resumed.frozen.budget.limits.wall_clock_seconds).toBe(45 * 60);
    expect(resumed.frozen.budget.deadline_at).toBe(fresh.freeze_input.deadline_at);
  });

  it('已开始但无冻结记录的旧 Run：打开候选默认组合后仍按 legacy 解释', async () => {
    const runsRoot = await makeRunsRoot();
    const runDir = await makeRun(runsRoot);
    await fs.mkdir(path.join(runDir, 'stages'), { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'stages', 'execute_agent.json'),
      JSON.stringify({ status: 'completed' }),
      'utf8',
    );
    const config = buildRoleAutonomySelectionConfig(DEFAULT_SWITCH_ENV, { wired: true });
    const selection = await selectRoleExecutionEngine(selectionInput(runsRoot, config));
    expect(selection).toMatchObject({
      engine: 'legacy',
      reason: 'started_run_without_frozen_engine',
    });
  });

  it('非法组合启动期显式拒绝（不启动、不静默降级）', () => {
    // Actual rollback edits the deployed 1/1/1 environment; it does not start from an empty object.
    expect(() =>
      buildRoleAutonomySelectionConfig(
        {
          ...DEFAULT_SWITCH_ENV,
          NEWIDE_ROLE_AUTONOMY: '0',
        },
        { wired: true },
      ),
    ).toThrow('require NEWIDE_ROLE_AUTONOMY=1');
    expect(
      buildRoleAutonomySelectionConfig(
        {
          ...DEFAULT_SWITCH_ENV,
          NEWIDE_ROLE_AUTONOMY: '0',
          NEWIDE_DRIVER_EVIDENCE_ONLY: '0',
          NEWIDE_BUFFER_V2: '0',
        },
        { wired: true },
      ),
    ).toMatchObject({ enabled: false, switches: { evidence_only: false, buffer_v2: false } });
    // stage 3 开关依赖 ROLE_AUTONOMY。
    expect(() =>
      buildRoleAutonomySelectionConfig({ NEWIDE_DRIVER_EVIDENCE_ONLY: '1' }, { wired: true }),
    ).toThrow('require NEWIDE_ROLE_AUTONOMY=1');
    expect(() =>
      buildRoleAutonomySelectionConfig({ NEWIDE_BUFFER_V2: '1' }, { wired: true }),
    ).toThrow('require NEWIDE_ROLE_AUTONOMY=1');
    // BUFFER_V2 依赖 EVIDENCE_ONLY。
    expect(() =>
      buildRoleAutonomySelectionConfig(
        { NEWIDE_ROLE_AUTONOMY: '1', NEWIDE_BUFFER_V2: '1' },
        { wired: true },
      ),
    ).toThrow('NEWIDE_BUFFER_V2 requires NEWIDE_DRIVER_EVIDENCE_ONLY=1');
    // 布尔值不合法同样是启动失败。
    expect(() =>
      buildRoleAutonomySelectionConfig(
        { NEWIDE_ROLE_AUTONOMY: '1', NEWIDE_DRIVER_EVIDENCE_ONLY: 'maybe' },
        { wired: true },
      ),
    ).toThrow('NEWIDE_DRIVER_EVIDENCE_ONLY');
  });

  it('选路层对非法组合/非法预算再显式拒绝，不静默降级为 legacy', async () => {
    const runsRoot = await makeRunsRoot();
    await makeRun(runsRoot);

    const stage3WithoutAutonomy = await selectRoleExecutionEngine(
      selectionInput(runsRoot, {
        enabled: false,
        wired: true,
        switches: { evidence_only: true, buffer_v2: false },
      }),
    );
    expect(stage3WithoutAutonomy).toMatchObject({
      engine: 'rejected',
      code: 'role_switch_invalid',
      reason: 'stage3_switch_without_role_autonomy',
    });

    const bufferV2WithoutEvidenceOnly = await selectRoleExecutionEngine(
      selectionInput(runsRoot, {
        enabled: true,
        wired: true,
        switches: { evidence_only: false, buffer_v2: true },
      }),
    );
    expect(bufferV2WithoutEvidenceOnly).toMatchObject({
      engine: 'rejected',
      code: 'role_switch_invalid',
      reason: 'invalid_switch_combination',
    });

    const invalidBudget = await selectRoleExecutionEngine(
      selectionInput(runsRoot, {
        enabled: true,
        wired: true,
        budget_overrides: { max_dispatches: 0 },
      }),
    );
    expect(invalidBudget).toMatchObject({
      engine: 'rejected',
      code: 'role_budget_override_invalid',
    });
  });

  it('已冻结 role_autonomy 的 Run 在目标二进制未装配 role-loop 时显式拒绝（不偷换执行器）', async () => {
    const runsRoot = await makeRunsRoot();
    const runDir = await makeRun(runsRoot);
    const forwardConfig = buildRoleAutonomySelectionConfig(DEFAULT_SWITCH_ENV, { wired: true });
    const fresh = await selectRoleExecutionEngine(selectionInput(runsRoot, forwardConfig));
    if (fresh.engine !== 'role_autonomy' || fresh.reason !== 'fresh_role_autonomy') {
      throw new Error('expected a fresh role_autonomy selection');
    }
    const journal = await RunDispatchJournal.open({
      runDir,
      identity: { run_id: 'run_1', ...IDENTITY },
    });
    await journal.appendInit({ ...fresh.freeze_input, at: fresh.frozen_at });
    await journal.close();

    // 模拟回滚到没有 role-loop 装配的旧二进制：不得把已冻结 Run 悄悄交给 legacy。
    const selection = await selectRoleExecutionEngine(
      selectionInput(runsRoot, { enabled: false, wired: false }),
    );
    expect(selection).toMatchObject({
      engine: 'rejected',
      code: 'role_loop_not_wired',
      reason: 'frozen_role_autonomy_not_wired',
    });
  });
});
