/**
 * 阶段 5 开关/回滚**确定性演练**脚本（不依赖真实外部 Driver / provider / PostgreSQL）。
 *
 * 职责与核心逻辑：
 * - 用真实组合根配置构造（`buildRoleAutonomySelectionConfig`）+ 真实选路
 *   （`selectRoleExecutionEngine`）+ 真实 Journal/文件 Buffer 适配器，把阶段 5 要证明的
 *   回滚语义跑成可重复执行的事实，并把证据写到 `.newide/phase5/switch-rollback/`：
 *   1. 部署开关关闭时，全新的普通 solo 新 Run 回到旧路径（legacy）；
 *   2. 候选默认组合（ROLE_AUTONOMY + EVIDENCE_ONLY + BUFFER_V2）下，全新 solo Run 走新路径；
 *   3. 已经开始的新 Run 在部署开关回滚后继续按**冻结策略**执行（开关/预算/deadline 不被替换）；
 *   4. 若目标二进制没有装配 role-loop，已冻结 Run 显式拒绝（`role_loop_not_wired`），
 *      绝不偷偷换回 legacy 执行器；
 *   5. 旧 Run / 旧 Buffer v1 / 旧快照仍可读；v2 Buffer 由 v2 reader 可读；
 *   6. 非法开关组合启动期即拒绝。
 * - 只读/临时目录演练：所有临时状态放在证据目录的 `scratch/` 下，每次运行先清空；
 *   不触碰 `.newide/coordination.sqlite`、`.newide/runs/`、`.env.local`。
 *
 * 运行：`node --import tsx scripts/phase5/switch-rollback-drill.ts`
 * 同一套场景也由 `test/app/role-autonomy-switch-rollback.test.ts` 在临时目录重跑（回归门禁）。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCHEMA_VERSION } from '../../src/core';
import { buildRoleAutonomySelectionConfig } from '../../src/app/backend-rpc-stdio';
import type { RoleLoopOutcome } from '../../src/app/role-autonomy-contract';
import { selectRoleExecutionEngine } from '../../src/app/role-autonomy-selection';
import { buildRoleLearningInput } from '../../src/app/role-learning-input';
import { projectPersistedRunSnapshot } from '../../src/app/task-run-snapshot-projector';
import { FileBufferRepository, isBufferSnapshotV2, parseBufferSnapshot } from '../../src/memory';
import { RunDispatchJournal, type PersistedTaskAggregate } from '../../src/persistence';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 默认切换候选部署组合（阶段 5 评审输入；本脚本不修改任何真实默认值）。 */
export const DEFAULT_SWITCH_ENV = {
  NEWIDE_ROLE_AUTONOMY: '1',
  NEWIDE_DRIVER_EVIDENCE_ONLY: '1',
  NEWIDE_BUFFER_V2: '1',
} as const;

const IDENTITY = { task_id: 'task_drill', role_id: 'role_drill' };
const NOW = new Date('2026-11-15T00:00:00.000Z');
const RUN_ID = 'run_drill';

export interface ScenarioResult {
  id: string;
  title: string;
  expectation: string;
  observed: Record<string, unknown>;
  failures: string[];
  ok: boolean;
}

export interface SwitchRollbackDrillResult {
  ok: boolean;
  generated_at: string;
  evidence_dir: string;
  environment: Record<string, unknown>;
  scenarios: ScenarioResult[];
  summary: { total: number; passed: number; failed: number };
  /** 部署约束：回滚/前置条件（写进报告与运维清单）。 */
  constraints: string[];
  /** 生产默认值建议 + 灰度/回滚步骤草案（只作说明，不改仓库默认值）。 */
  rollback_runbook: string[];
}

class Checks {
  readonly observed: Record<string, unknown> = {};
  readonly failures: string[] = [];

  eq(label: string, actual: unknown, expected: unknown): void {
    this.observed[label] = actual;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      this.failures.push(
        `${label}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`,
      );
    }
  }

  is(label: string, actual: unknown, expected: unknown): void {
    this.observed[label] = actual;
    if (actual !== expected) {
      this.failures.push(`${label}: expected ${String(expected)}, observed ${String(actual)}`);
    }
  }

  truthy(label: string, value: unknown): void {
    this.observed[label] = value;
    if (value !== true) this.failures.push(`${label}: expected true, observed ${String(value)}`);
  }

  notPresent(label: string, value: unknown): void {
    this.observed[label] = value === undefined ? '<absent>' : value;
    if (value !== undefined) this.failures.push(`${label}: expected absent, observed present`);
  }
}

function scenario(
  id: string,
  title: string,
  expectation: string,
  run: (checks: Checks, scratch: DrillScratch) => Promise<void>,
  scratch: DrillScratch,
): Promise<ScenarioResult> {
  const checks = new Checks();
  const execute = async (): Promise<ScenarioResult> => {
    await run(checks, scratch);
    return {
      id,
      title,
      expectation,
      observed: checks.observed,
      failures: checks.failures,
      ok: checks.failures.length === 0,
    };
  };
  return execute().catch((error: unknown) => ({
    id,
    title,
    expectation,
    observed: checks.observed,
    failures: [
      ...checks.failures,
      `threw: ${error instanceof Error ? error.message : String(error)}`,
    ],
    ok: false,
  }));
}

interface DrillScratch {
  root: string;
  runsRoot: string;
  agentStateRoot: string;
}

async function prepareScratch(evidenceDir: string): Promise<DrillScratch> {
  const root = path.join(evidenceDir, 'scratch');
  await fs.rm(root, { recursive: true, force: true });
  const runsRoot = path.join(root, 'runs');
  const agentStateRoot = path.join(root, 'agent-state');
  await fs.mkdir(runsRoot, { recursive: true });
  await fs.mkdir(agentStateRoot, { recursive: true });
  return { root, runsRoot, agentStateRoot };
}

async function makeRun(scratch: DrillScratch, runId: string): Promise<string> {
  const runDir = path.join(scratch.runsRoot, runId);
  await fs.mkdir(runDir, { recursive: true });
  return runDir;
}

function selectionInput(
  runsRoot: string,
  config: ReturnType<typeof buildRoleAutonomySelectionConfig>,
  overrides: Record<string, unknown> = {},
) {
  return {
    runs_root: runsRoot,
    run_id: RUN_ID,
    task_id: IDENTITY.task_id,
    role_id: IDENTITY.role_id,
    mode: 'single_agent' as const,
    task_request: { spec: 'drill task', completion_criteria: [] },
    cursor_input: { cursor: 'execute_agent' as const, winner_agent_id: IDENTITY.role_id },
    config,
    now: NOW,
    ...overrides,
  };
}

async function writeLegacyInit(
  runDir: string,
  runId: string,
  deadlineAt: string,
  at: string,
): Promise<void> {
  const journal = await RunDispatchJournal.open({
    runDir,
    identity: { run_id: runId, ...IDENTITY },
  });
  await journal.appendInit({
    autonomy: false,
    evidence_only: false,
    buffer_v2: false,
    engine: 'legacy',
    max_dispatches: 12,
    max_role_rounds: 40,
    role_token_budget: 120_000,
    deadline_at: deadlineAt,
    at,
  });
  await journal.close();
}

function v1SnapshotJson() {
  return {
    task_id: 'task_old',
    task_description: 'legacy task executed by the six-field path',
    driver_return: {
      summary: 'legacy driver report',
      artifacts: [],
      decisions: [],
      blockers: [],
      referenced_experiences: [],
      assumptions: [],
    },
    source_task_id: 'task_old',
    source_driver: 'legacy-driver',
    received_at: '2026-11-14T00:00:00.000Z',
    retry_count: 0,
    extraction_status: 'pending',
  };
}

function oldSnapshotAggregate(): PersistedTaskAggregate {
  return {
    task: {
      task_id: 'task_old',
      status: 'completed',
      risk_level: 'low',
      spec: 'legacy task with an old snapshot',
      completion_criteria: [],
      affected_paths: [],
      workspace_path: path.join(os.tmpdir(), 'legacy-workspace'),
      warnings: [],
      revision: 1,
      created_at: '2026-11-13T00:00:00.000Z',
      updated_at: '2026-11-13T00:01:00.000Z',
      schema_version: SCHEMA_VERSION,
    },
    runs: [
      {
        run_id: 'run_old',
        task_id: 'task_old',
        status: 'completed',
        mode: 'single_agent',
        workspace_path: path.join(os.tmpdir(), 'legacy-workspace'),
        revision: 1,
        created_at: '2026-11-13T00:00:00.000Z',
        updated_at: '2026-11-13T00:01:00.000Z',
        schema_version: SCHEMA_VERSION,
      },
    ],
    runtime_state: {
      task_id: 'task_old',
      resume_cursor: 'done',
      waiting_on: [],
      artifact_refs: [],
      diagnostics: {},
      updated_at: '2026-11-13T00:01:00.000Z',
      schema_version: SCHEMA_VERSION,
    },
    events: [],
  };
}

function completedRoleOutcome(): RoleLoopOutcome {
  return {
    status: 'completed',
    finish: {
      status: 'completed',
      summary: 'answered without dispatching a driver',
      evidence_refs: [],
      unresolved: [],
      role_reflection: 'zero dispatch; learning input still real',
      response_only: true,
      verification: [],
      accepted_at: '2026-11-15T00:00:00.000Z',
    },
    response: 'answered',
    dispatches: [],
    usage: { input_tokens: 0, output_tokens: 0, usage_missing: false, role_rounds: 0 },
    zero_dispatch: true,
    plan: undefined,
    unresolved_dispatches: [],
  };
}

export async function runSwitchRollbackDrill(options: {
  evidence_dir: string;
  now?: Date;
}): Promise<SwitchRollbackDrillResult> {
  const evidenceDir = path.resolve(options.evidence_dir);
  await fs.mkdir(evidenceDir, { recursive: true });
  const scratch = await prepareScratch(evidenceDir);
  const scenarios: ScenarioResult[] = [];

  const offConfig = buildRoleAutonomySelectionConfig(
    { NEWIDE_ROLE_AUTONOMY: '0', NEWIDE_DRIVER_EVIDENCE_ONLY: '0', NEWIDE_BUFFER_V2: '0' },
    { wired: true },
  );
  const defaultConfig = buildRoleAutonomySelectionConfig({}, { wired: true });
  const candidateConfig = buildRoleAutonomySelectionConfig(DEFAULT_SWITCH_ENV, { wired: true });

  // 1) 新 Run 关开关 → 回旧路径。
  scenarios.push(
    await scenario(
      'fresh_run_switches_off_legacy',
      '部署开关关闭：全新普通 solo Run 回到 legacy 旧路径',
      'selection = legacy / role_autonomy_disabled',
      async (checks, state) => {
        await makeRun(state, 'run_off');
        const selection = await selectRoleExecutionEngine(
          selectionInput(state.runsRoot, offConfig),
        );
        checks.is('engine', selection.engine, 'legacy');
        checks.is('reason', Reflect.get(selection, 'reason'), 'role_autonomy_disabled');
      },
      scratch,
    ),
  );

  // 2) 候选默认组合 → 全新普通 solo Run 走新路径（含证据/学习开关一起冻结）。
  let frozenInput: { deadline_at: string; frozen_at: string } | undefined;
  scenarios.push(
    await scenario(
      'fresh_run_candidate_switches_new_path',
      '候选默认组合 1/1/1：全新普通 solo Run 走 role_autonomy 新路径',
      'selection = role_autonomy/fresh_role_autonomy，冻结 evidence_only+buffer_v2',
      async (checks, state) => {
        const runDir = await makeRun(state, RUN_ID);
        const selection = await selectRoleExecutionEngine(
          selectionInput(state.runsRoot, candidateConfig),
        );
        checks.is('engine', selection.engine, 'role_autonomy');
        if (selection.engine !== 'role_autonomy' || selection.reason !== 'fresh_role_autonomy') {
          checks.failures.push('expected a fresh_role_autonomy selection');
          return;
        }
        checks.truthy('frozen.evidence_only', selection.frozen.evidence_only);
        checks.truthy('frozen.buffer_v2', selection.frozen.buffer_v2);
        checks.is('frozen.max_dispatches', selection.frozen.budget.limits.max_dispatches, 12);
        // 走真实写入路径：engine 在调 LLM 前把选路计划写进 Journal init。
        const journal = await RunDispatchJournal.open({
          runDir,
          identity: { run_id: RUN_ID, ...IDENTITY },
        });
        await journal.appendInit({ ...selection.freeze_input, at: selection.frozen_at });
        await journal.close();
        frozenInput = {
          deadline_at: selection.freeze_input.deadline_at,
          frozen_at: selection.frozen_at,
        };
      },
      scratch,
    ),
  );

  // 3) 已开始的新 Run：部署默认值回滚后继续按冻结策略执行。
  scenarios.push(
    await scenario(
      'frozen_run_survives_deployment_rollback',
      '已开始的新 Run：部署开关全关后继续使用冻结策略（不偷换执行器）',
      'selection = role_autonomy/frozen_role_autonomy，开关/预算/deadline 与 init 行一致',
      async (checks, state) => {
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
        const selection = await selectRoleExecutionEngine(
          selectionInput(state.runsRoot, rollbackConfig),
        );
        checks.is('engine', selection.engine, 'role_autonomy');
        if (selection.engine !== 'role_autonomy' || selection.reason !== 'frozen_role_autonomy') {
          checks.failures.push('expected a frozen_role_autonomy selection');
          return;
        }
        checks.is('frozen_from_run_id', selection.frozen_from_run_id, RUN_ID);
        checks.truthy('frozen.evidence_only', selection.frozen.evidence_only);
        checks.truthy('frozen.buffer_v2', selection.frozen.buffer_v2);
        checks.is(
          'frozen.max_dispatches (rollback override must not apply)',
          selection.frozen.budget.limits.max_dispatches,
          12,
        );
        checks.is(
          'frozen.deadline_at',
          selection.frozen.budget.deadline_at,
          frozenInput?.deadline_at,
        );
        checks.is(
          'frozen.wall_clock_seconds',
          selection.frozen.budget.limits.wall_clock_seconds,
          2700,
        );
      },
      scratch,
    ),
  );

  // 4) 目标二进制没有 role-loop：显式拒绝结束，不偷换成 legacy。
  scenarios.push(
    await scenario(
      'frozen_run_target_binary_without_engine_explicit_end',
      '回滚目标二进制未装配 role-loop：已冻结 Run 显式拒绝（明确原因），不得偷偷换执行器',
      'selection = rejected / role_loop_not_wired',
      async (checks, state) => {
        const selection = await selectRoleExecutionEngine(
          selectionInput(state.runsRoot, { enabled: false, wired: false }),
        );
        checks.is('engine', selection.engine, 'rejected');
        checks.is('code', Reflect.get(selection, 'code'), 'role_loop_not_wired');
        checks.is('reason', Reflect.get(selection, 'reason'), 'frozen_role_autonomy_not_wired');
      },
      scratch,
    ),
  );

  // 5) 已开始但无冻结记录的旧 Run：打开候选默认组合后仍按 legacy 解释。
  scenarios.push(
    await scenario(
      'started_legacy_run_not_taken_over',
      '已开始但无冻结记录的旧 Run：打开新默认值后仍按 legacy 解释',
      'selection = legacy / started_run_without_frozen_engine',
      async (checks, state) => {
        const runId = 'run_started_legacy';
        const runDir = await makeRun(state, runId);
        await fs.mkdir(path.join(runDir, 'stages'), { recursive: true });
        await fs.writeFile(
          path.join(runDir, 'stages', 'execute_agent.json'),
          JSON.stringify({ status: 'completed' }),
          'utf8',
        );
        const selection = await selectRoleExecutionEngine(
          selectionInput(state.runsRoot, candidateConfig, { run_id: runId }),
        );
        checks.is('engine', selection.engine, 'legacy');
        checks.is('reason', Reflect.get(selection, 'reason'), 'started_run_without_frozen_engine');
      },
      scratch,
    ),
  );

  // 6) 冻结为 legacy 的 Run：打开新默认值后仍 legacy（历史解释器不变）。
  scenarios.push(
    await scenario(
      'legacy_frozen_run_stays_legacy',
      '冻结为 legacy 的 Run：部署打开新开关后仍保持 legacy',
      'selection = legacy / frozen_legacy',
      async (checks, state) => {
        const runId = 'run_frozen_legacy';
        const runDir = await makeRun(state, runId);
        await writeLegacyInit(
          runDir,
          runId,
          new Date(NOW.getTime() + 60_000).toISOString(),
          NOW.toISOString(),
        );
        const selection = await selectRoleExecutionEngine(
          selectionInput(state.runsRoot, candidateConfig, { run_id: runId }),
        );
        checks.is('engine', selection.engine, 'legacy');
        checks.is('reason', Reflect.get(selection, 'reason'), 'frozen_legacy');
      },
      scratch,
    ),
  );

  // 7) 旧 Buffer v1 可读：版本判别读取仍按 v1 解释（不原地重写）。
  scenarios.push(
    await scenario(
      'old_buffer_v1_readable',
      '旧 Buffer v1 仍可读：版本判别读取按 v1 解释，不套用 v2 语义',
      'parseBufferSnapshot(v1) 成功、isBufferSnapshotV2=false、driver_return 保留',
      async (checks) => {
        const parsed = parseBufferSnapshot(v1SnapshotJson());
        checks.is('isBufferSnapshotV2', isBufferSnapshotV2(parsed), false);
        checks.is(
          'driver_return.summary',
          Reflect.get(parsed, 'driver_return') &&
            Reflect.get(Reflect.get(parsed, 'driver_return') as object, 'summary'),
          'legacy driver report',
        );
        checks.is('source_driver', Reflect.get(parsed, 'source_driver'), 'legacy-driver');
      },
      scratch,
    ),
  );

  // 8) v2 Buffer 在回滚后仍由 v2 reader 可读（回滚目标二进制必须 ≥ 阶段 3）。
  scenarios.push(
    await scenario(
      'v2_buffer_readable_by_v2_reader_after_rollback',
      'v2 Buffer 由 v2 reader 可读：回滚目标二进制必须具备 v2 读取能力（≥ 阶段 3）',
      'FileBufferRepository 回读的 snapshot 是 buffer_version=2，journal_ref/结束状态保留',
      async (checks, state) => {
        const runId = 'run_v2_buffer';
        const runDir = await makeRun(state, runId);
        const journal = await RunDispatchJournal.open({
          runDir,
          identity: { run_id: runId, ...IDENTITY },
        });
        await journal.appendInit({
          autonomy: true,
          evidence_only: true,
          buffer_v2: true,
          max_dispatches: 12,
          max_role_rounds: 40,
          role_token_budget: 120_000,
          deadline_at: new Date(NOW.getTime() + 2_700_000).toISOString(),
          at: NOW.toISOString(),
          engine: 'role_autonomy',
          engine_version: 'role-autonomy-v1',
          tool_allowlist: [
            'dispatch_execution',
            'query_memory',
            'read_evidence',
            'update_plan',
            'finish_task',
          ],
          routing: {},
          dispatch_timeout_ms: 600_000,
        });
        await journal.appendFinish({
          actor: 'role',
          status: 'completed',
          reason: 'done',
          evidence_refs: [],
          summary: 'answered without dispatch',
        });
        const read = await journal.read();
        await journal.close();

        const v2Snapshot = buildRoleLearningInput({
          task: {
            task_id: 'task_v2',
            run_id: runId,
            role_id: IDENTITY.role_id,
            task_description: 'zero-dispatch answer task',
          },
          outcome: completedRoleOutcome(),
          records: [],
          journal_read: read,
          memory_used: [],
        });
        const repository = new FileBufferRepository({
          agentStateRoot: state.agentStateRoot,
        });
        await repository.ensureAgent(IDENTITY.role_id);
        const saved = await repository.saveBufferSnapshot(IDENTITY.role_id, v2Snapshot);
        const stored = await repository.getStoredBuffer(IDENTITY.role_id, saved.seq);
        checks.truthy('stored_found', stored !== undefined);
        if (stored === undefined) return;
        const parsed = parseBufferSnapshot(stored.snapshot);
        checks.truthy('isBufferSnapshotV2', isBufferSnapshotV2(parsed));
        checks.is('buffer_version', Reflect.get(parsed, 'buffer_version'), 2);
        checks.is(
          'journal_ref.run_id',
          Reflect.get(Reflect.get(parsed, 'journal_ref') as object, 'run_id'),
          runId,
        );
        checks.is(
          'role_reflection.status',
          Reflect.get(Reflect.get(parsed, 'role_reflection') as object, 'status'),
          'completed',
        );
        checks.eq('source_drivers', Reflect.get(parsed, 'source_drivers'), []);
        checks.is('location', Reflect.get(stored, 'location'), 'pending');
      },
      scratch,
    ),
  );

  // 9) 旧快照可读：缺少阶段 4 派工字段的旧快照投影不报错、不虚构派工。
  scenarios.push(
    await scenario(
      'old_snapshot_readable_without_dispatch_fields',
      '旧快照仍可读：没有 dispatch_* 字段的旧 Run 投影成功，不虚构派工事实',
      'projectPersistedRunSnapshot 成功、status=completed、dispatch_summary/progress 缺席',
      async (checks) => {
        const snapshot = projectPersistedRunSnapshot(
          oldSnapshotAggregate(),
          'run_old',
          path.join(scratch.root, 'runs'),
        );
        checks.is('status', snapshot.status, 'completed');
        checks.is('run_id', snapshot.run_id, 'run_old');
        checks.notPresent('dispatch_summary', snapshot.dispatch_summary);
        checks.notPresent('dispatch_progress', snapshot.dispatch_progress);
        checks.is('timeline length', snapshot.timeline.length, 0);
      },
      scratch,
    ),
  );

  // 10) 非法组合启动期拒绝（回滚时也不允许半配置启动）。
  scenarios.push(
    await scenario(
      'illegal_switch_combination_rejected_at_startup',
      '非法开关组合启动期即拒绝（不允许半配置启动、不在 Run 内静默降级）',
      'stage3 开关缺 ROLE_AUTONOMY / BUFFER_V2 缺 EVIDENCE_ONLY 均抛错',
      async (checks) => {
        const stage3WithoutAutonomy = captureThrow(() =>
          buildRoleAutonomySelectionConfig({ NEWIDE_DRIVER_EVIDENCE_ONLY: '1' }, { wired: true }),
        );
        checks.truthy(
          'stage3_without_autonomy_rejected',
          stage3WithoutAutonomy.includes('require NEWIDE_ROLE_AUTONOMY=1'),
        );
        const bufferV2WithoutEvidenceOnly = captureThrow(() =>
          buildRoleAutonomySelectionConfig(
            { NEWIDE_ROLE_AUTONOMY: '1', NEWIDE_BUFFER_V2: '1' },
            { wired: true },
          ),
        );
        checks.truthy(
          'buffer_v2_without_evidence_only_rejected',
          bufferV2WithoutEvidenceOnly.includes(
            'NEWIDE_BUFFER_V2 requires NEWIDE_DRIVER_EVIDENCE_ONLY=1',
          ),
        );
        checks.is('default_config_enabled', defaultConfig.enabled, false);
      },
      scratch,
    ),
  );

  const failed = scenarios.filter((entry) => !entry.ok);
  const result: SwitchRollbackDrillResult = {
    ok: failed.length === 0,
    generated_at: (options.now ?? new Date()).toISOString(),
    evidence_dir: evidenceDir,
    environment: {
      node_version: process.version,
      platform: process.platform,
      repo_pinned_node: '22.22.1 (.nvmrc)',
      note: process.version.startsWith('v22.')
        ? 'runtime matches the repo pin'
        : 'local runtime differs from the repo pin (environment fact, recorded on purpose)',
      deterministic: true,
      external_driver_used: false,
      postgres_used: false,
    },
    scenarios,
    summary: {
      total: scenarios.length,
      passed: scenarios.length - failed.length,
      failed: failed.length,
    },
    constraints: [
      '回滚目标二进制必须 ≥ 阶段 3：v2 Buffer 由 v2 reader（parseBufferSnapshot 先判 buffer_version）读取；旧二进制不得强读 v2 数据。',
      '已冻结 role_autonomy 的 Run 需要目标二进制装配 role-loop：未装配时选路显式拒绝（role_loop_not_wired），不能以回滚为理由改用 legacy 执行器。',
      '部署开关/预算变化只影响全新 Run；已开始的 Run 继续使用 Journal init 行里的冻结开关、预算与 deadline。',
      '非法组合（stage3 开关无 ROLE_AUTONOMY、BUFFER_V2 无 EVIDENCE_ONLY）启动期即拒绝，不允许半配置启动。',
      '回滚只关部署开关，不删除/重写历史 Journal、Buffer v1/v2 与旧快照；历史读取一律只读兼容。',
    ],
    rollback_runbook: [
      '1. 生产默认值建议（评审通过后才改部署 env，不改代码默认值）：NEWIDE_ROLE_AUTONOMY=1、NEWIDE_DRIVER_EVIDENCE_ONLY=1、NEWIDE_BUFFER_V2=1；预算保持设计初值（12/40/120000/2700s/600000ms），需要收紧时只调小。',
      '2. 灰度顺序：内部显式开启（单实例/单 workspace）→ 观察真实任务终态/成本/unknown 与证据缺失 → 扩大普通 solo 新 Run 默认范围 → 最后才考虑清理旧依赖。Council/主动 Council/Mailbox 不在灰度范围内。',
      '3. 回滚开关：同时把 NEWIDE_ROLE_AUTONOMY、NEWIDE_DRIVER_EVIDENCE_ONLY、NEWIDE_BUFFER_V2 都置 0 并重启后端；只关闭主开关会因非法组合拒绝启动。新 Run 回 legacy。',
      '4. 回滚进行中的 Run：先停止接收新任务，尽量排空运行中任务再重启；恢复读取 Journal init 冻结记录，继续原策略。目标二进制须支持 v2 Buffer（≥ 阶段 3）及已写入的 Brief 字段；有 verification_command 的 Run 须保留阶段 5 命令验证读取能力，优先只回滚配置。缺少 role-loop 时显式拒绝 role_loop_not_wired。',
      '5. 回滚后检查：system.readiness、run.getSnapshot（dispatch_summary/终止原因）、.newide/runs/<id>/summary.json；确认没有旧二进制读取 v2 Buffer，历史 Run/Buffer v1/旧快照可正常打开。',
    ],
  };

  await fs.writeFile(
    path.join(evidenceDir, 'drill-evidence.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(evidenceDir, 'drill-summary.md'),
    renderSummaryMarkdown(result),
    'utf8',
  );
  await fs.writeFile(
    path.join(evidenceDir, 'rollback-runbook.md'),
    renderRunbookMarkdown(result),
    'utf8',
  );
  return result;
}

function captureThrow(run: () => unknown): string {
  try {
    run();
    return '<no error>';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function renderSummaryMarkdown(result: SwitchRollbackDrillResult): string {
  const lines: string[] = [
    '# 阶段 5 开关/回滚演练证据',
    '',
    `- 生成时间：${result.generated_at}`,
    `- 结果：${result.summary.passed}/${result.summary.total} 通过（失败 ${result.summary.failed}）`,
    `- 运行环境：Node ${String(result.environment['node_version'])} / ${String(result.environment['platform'])}（仓库钉版 22.22.1；${String(result.environment['note'])}）`,
    '- 确定性：不依赖真实外部 Driver / provider / PostgreSQL。',
    '',
    '| # | 场景 | 结论 | 关键观测 |',
    '| --- | --- | --- | --- |',
  ];
  result.scenarios.forEach((entry, index) => {
    lines.push(
      `| ${index + 1} | ${entry.title} | ${entry.ok ? 'PASS' : 'FAIL'} | ${entry.observed['engine'] !== undefined ? `engine=${String(entry.observed['engine'])}` : entry.expectation} |`,
    );
  });
  lines.push('', '## 失败详情', '');
  const failed = result.scenarios.filter((entry) => !entry.ok);
  if (failed.length === 0) {
    lines.push('无。');
  } else {
    for (const entry of failed) {
      lines.push(`- ${entry.id}: ${entry.failures.join('; ')}`);
    }
  }
  lines.push('', '## 部署约束', '');
  for (const constraint of result.constraints) lines.push(`- ${constraint}`);
  lines.push('');
  return lines.join('\n');
}

function renderRunbookMarkdown(result: SwitchRollbackDrillResult): string {
  const lines: string[] = [
    '# 阶段 5 普通 solo 默认切换 / 回滚 runbook（草案）',
    '',
    '> 本文件由 `scripts/phase5/switch-rollback-drill.ts` 生成；只说明建议，不代表已上线，',
    '> 也不修改 `.env.local` 或代码中的任何默认值。',
    '',
    '## 生产默认值候选组合',
    '',
    '```dotenv',
    'NEWIDE_ROLE_AUTONOMY=1',
    'NEWIDE_DRIVER_EVIDENCE_ONLY=1',
    'NEWIDE_BUFFER_V2=1',
    '```',
    '',
    '预算保持冻结初值（`NEWIDE_ROLE_MAX_DISPATCHES=12` / `NEWIDE_ROLE_MAX_ROUNDS=40` /',
    '`NEWIDE_ROLE_TOKEN_BUDGET=120000` / `NEWIDE_ROLE_WALL_CLOCK_SECONDS=2700` /',
    '`NEWIDE_ROLE_DISPATCH_TIMEOUT_MS=600000`）；只能收紧，不能放大。',
    '',
    '## 灰度 / 回滚步骤',
    '',
  ];
  for (const step of result.rollback_runbook) lines.push(`- ${step}`);
  lines.push('', '## 约束', '');
  for (const constraint of result.constraints) lines.push(`- ${constraint}`);
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const evidenceDir = path.join(REPO_ROOT, '.newide', 'phase5', 'switch-rollback');
  const result = await runSwitchRollbackDrill({ evidence_dir: evidenceDir });
  process.stdout.write(
    `switch-rollback drill: ${result.summary.passed}/${result.summary.total} scenarios passed\n` +
      `evidence: ${path.join(evidenceDir, 'drill-evidence.json')}\n`,
  );
  if (!result.ok) {
    for (const entry of result.scenarios.filter((scenarioResult) => !scenarioResult.ok)) {
      process.stderr.write(`FAILED ${entry.id}: ${entry.failures.join('; ')}\n`);
    }
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) void main();
