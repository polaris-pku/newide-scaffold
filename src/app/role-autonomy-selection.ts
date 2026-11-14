/**
 * 阶段 2 执行引擎选路与冻结判定（RD-SEL-01/02/03/04/05/06）。
 *
 * 职责与核心逻辑：
 * - 只在**首次进入 `execute_agent`、调用 LLM 之前**判定一次；判定输入来自 stage executor
 *   的 mode / cursor / task_request（`AgentExecutionRequest` 没有 mode，禁止用 context_policy
 *   反推，solo 类模式共用 `production_task_loop`）。
 * - 先沿持久化恢复链查已冻结引擎：有 `role_autonomy` 冻结记录就沿用（即使部署开关后来关掉）；
 *   有 legacy 冻结记录就 legacy；祖先链无记录 → legacy（旧 Run 不被新默认值接管）。
 * - 全新 Run 且三个排除条件都不命中、显式开关 on、组合根已装配 role-loop 时，返回
 *   `fresh` + `freeze_input`；冻结记录由 engine 在调用 LLM 前写入 Journal `init` 行
 *   （SEL-03：未持久化即调 LLM 视为实现缺陷）。
 * - 非法组合（council/主动 Council/Mailbox 投递回合/开关 on 但未装配/预算覆盖非法）
 *   返回 `rejected`，由 stage executor 转成 typed termination（host_failed），不得静默降级。
 * - 本模块只读 Journal（`RunDispatchJournal.peek`，不取写锁、不创建文件），不执行 LLM。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TaskBudget, TaskCreateRequest } from '../core';
import type { JournalInitEntry } from '../driver';
import { RunDispatchJournal, type DispatchJournalReadResult } from '../persistence';
import type { PersistedRunMode, TaskCursorInput } from '../persistence';
import {
  buildRoleFreezeInitInput,
  DEFAULT_ROLE_AUTONOMY_SWITCHES,
  isRoleAutonomySwitchCombinationValid,
  ROLE_AUTONOMY_ENGINE,
  resolveRolePolicyBudget,
  roleFrozenPolicyFromJournalInit,
  type ExecutionEngine,
  type RoleAutonomySwitches,
  type RoleBudgetLimits,
  type RoleBudgetOverrides,
  type RoleFreezeInitInput,
  type RoleFrozenPolicy,
  type RoleFrozenPolicyPlan,
  type RoleFrozenRouting,
} from './role-autonomy-contract';

export type ExecuteAgentCursorInput = Extract<TaskCursorInput, { cursor: 'execute_agent' }>;

export interface RoleAutonomySelectionConfig {
  /** 部署级显式开关（`NEWIDE_ROLE_AUTONOMY`），默认 false。 */
  enabled: boolean;
  /** 组合根是否装配了 role-loop 引擎。 */
  wired: boolean;
  /** 阶段 3 开关（`NEWIDE_DRIVER_EVIDENCE_ONLY` / `NEWIDE_BUFFER_V2`），默认都关。 */
  switches?: RoleAutonomySwitches;
  /** 部署级预算覆盖（只能收紧宿主上限）。 */
  budget_overrides?: RoleBudgetOverrides;
  /** 任务请求预算（TaskBudget.max_tokens / max_wall_clock_seconds / max_tool_calls）。 */
  task_budget?: TaskBudget;
  /** 冻结的 routing 引用（只记录，不迁移 Session/记忆）。 */
  routing?: RoleFrozenRouting;
}

export interface RoleEngineSelectionInput {
  runs_root: string;
  run_id: string;
  task_id: string;
  role_id: string;
  mode: PersistedRunMode;
  task_request: TaskCreateRequest;
  cursor_input: ExecuteAgentCursorInput;
  restarted_from_run_id?: string;
  config: RoleAutonomySelectionConfig;
  now?: Date;
}

export type RoleEngineSelection =
  | {
      engine: typeof ROLE_AUTONOMY_ENGINE;
      reason: 'frozen_role_autonomy';
      frozen: RoleFrozenPolicy;
      frozen_from_run_id: string;
    }
  | {
      engine: typeof ROLE_AUTONOMY_ENGINE;
      reason: 'fresh_role_autonomy';
      frozen: RoleFrozenPolicy;
      /**
       * 选路一次算好的冻结计划：stage 原样交给 engine，避免再按 frozen 字段重新拼装一份
       * （同一份策略只在一处构造；engine 后备构造仍保留给直接调用者）。
       */
      freeze_plan: RoleFrozenPolicyPlan;
      freeze_input: RoleFreezeInitInput;
      /** 冻结决策时刻（engine 写 Journal init 的 at 必须用它，保证同一份策略）。 */
      frozen_at: string;
    }
  | { engine: 'legacy'; reason: string; frozen_from_run_id?: string }
  | { engine: 'rejected'; reason: string; code: string; message: string };

const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/;

/**
 * 判定执行引擎。纯读：不写 Journal、不建锁；冻结记录的写入由 engine 负责。
 * 抛错只发生在 run_id 非法（路径安全问题）等调用方错误上；业务性拒绝走 `rejected`。
 */
export async function selectRoleExecutionEngine(
  input: RoleEngineSelectionInput,
): Promise<RoleEngineSelection> {
  const { config } = input;
  assertSafeRunId(input.run_id);
  if (input.restarted_from_run_id !== undefined) assertSafeRunId(input.restarted_from_run_id);

  let frozen: Awaited<ReturnType<typeof findFrozenEngineInLineage>>;
  try {
    frozen = await findFrozenEngineInLineage({
      runs_root: input.runs_root,
      run_id: input.run_id,
      ...(input.restarted_from_run_id !== undefined
        ? { restarted_from_run_id: input.restarted_from_run_id }
        : {}),
      identity: { run_id: input.run_id, task_id: input.task_id, role_id: input.role_id },
    });
  } catch (error) {
    // 损坏/不可读的 Journal 不能当作「没有冻结记录」降级为 legacy（RD-SEL-05 修复）。
    if (error instanceof RoleSelectionJournalError) {
      return {
        engine: 'rejected',
        reason: error.reason,
        code: error.code,
        message: error.message,
      };
    }
    // 恢复链读取失败同样不能静默当成「没有父链」：显式拒绝，交给上层 fail closed。
    if (error instanceof RoleLineageReadError) {
      return {
        engine: 'rejected',
        reason: 'lineage_unreadable',
        code: 'journal_unreadable',
        message: error.message,
      };
    }
    throw error;
  }
  if (frozen !== undefined) {
    if (frozen.init.autonomy) {
      // 阶段 2 的冻结记录必须带 engine/版本/工具授权/预算；autonomy=true 却没有这些字段
      // 说明冻结由旧实现/半写产生——显式拒绝，不能补默认值或静默降级。
      if (frozen.init.engine !== ROLE_AUTONOMY_ENGINE) {
        return {
          engine: 'rejected',
          reason: 'frozen_autonomy_without_engine',
          code: 'role_freeze_invalid',
          message:
            'frozen init row has autonomy=true but no role_autonomy engine marker; refusing to guess',
        };
      }
      const policy = roleFrozenPolicyFromJournalInit(frozen.init);
      if (policy === undefined) {
        return {
          engine: 'rejected',
          reason: 'frozen_role_autonomy_invalid',
          code: 'role_freeze_invalid',
          message:
            'frozen role_autonomy init row is missing engine version/tool authorization/budgets ' +
            'or carries an unsupported switch combination',
        };
      }
      if (!config.wired) {
        return {
          engine: 'rejected',
          reason: 'frozen_role_autonomy_not_wired',
          code: 'role_loop_not_wired',
          message:
            'this Run is frozen to role_autonomy but the composition root has no role-loop engine wired',
        };
      }
      return {
        engine: ROLE_AUTONOMY_ENGINE,
        reason: 'frozen_role_autonomy',
        frozen: policy,
        frozen_from_run_id: frozen.run_id,
      };
    }
    if (frozen.init.engine === ROLE_AUTONOMY_ENGINE) {
      return {
        engine: 'rejected',
        reason: 'frozen_engine_without_autonomy',
        code: 'role_freeze_invalid',
        message: 'frozen init row freezes role_autonomy engine but autonomy=false',
      };
    }
    // 明确冻结为 legacy（或旧数据没有引擎字段）：旧 Run 保持原解释器。
    return {
      engine: 'legacy',
      reason:
        frozen.init.engine === 'legacy' ? 'frozen_legacy' : 'frozen_without_engine_field',
      frozen_from_run_id: frozen.run_id,
    };
  }

  // 从旧 Run 继承、但整条祖先链都没有冻结记录 → 按 legacy 解释（RD-SEL-05）。
  if (input.restarted_from_run_id !== undefined) {
    return { engine: 'legacy', reason: 'resumed_without_frozen_engine' };
  }
  // 显式排除项：任何一项命中都不得被新路径接管。
  if (input.mode !== 'single_agent') {
    return { engine: 'legacy', reason: `mode_${input.mode}` };
  }
  if (input.task_request.allow_agent_council === true) {
    return { engine: 'legacy', reason: 'active_council' };
  }
  if (input.cursor_input.mailbox_delivery_id !== undefined) {
    return { engine: 'legacy', reason: 'mailbox_delivery' };
  }
  // 已经开始执行（有阶段证据/执行状态）但整条链没有冻结记录：说明是旧 Run 的续跑/恢复，
  // 部署开关后来打开也不能把它当全新 Run 接管（RD-SEL-05）。
  if (await runAlreadyStarted(input.runs_root, input.run_id)) {
    return { engine: 'legacy', reason: 'started_run_without_frozen_engine' };
  }
  if (!config.enabled) {
    // 阶段 3 开关依赖 role 自主循环：只开 EVIDENCE_ONLY/BUFFER_V2 而不开 ROLE_AUTONOMY
    // 是非法组合（启动配置构造处已拒绝，这里再做一次防御性拒绝，不静默降级到 legacy）。
    const switches = config.switches ?? DEFAULT_ROLE_AUTONOMY_SWITCHES;
    if (switches.evidence_only || switches.buffer_v2) {
      return {
        engine: 'rejected',
        reason: 'stage3_switch_without_role_autonomy',
        code: 'role_switch_invalid',
        message:
          'NEWIDE_DRIVER_EVIDENCE_ONLY / NEWIDE_BUFFER_V2 require NEWIDE_ROLE_AUTONOMY=1',
      };
    }
    return { engine: 'legacy', reason: 'role_autonomy_disabled' };
  }
  if (!config.wired) {
    return {
      engine: 'rejected',
      reason: 'role_autonomy_enabled_but_not_wired',
      code: 'role_loop_not_wired',
      message:
        'NEWIDE_ROLE_AUTONOMY is enabled but the composition root has no role-loop engine wired',
    };
  }
  const switches = config.switches ?? DEFAULT_ROLE_AUTONOMY_SWITCHES;
  if (!isRoleAutonomySwitchCombinationValid(switches)) {
    return {
      engine: 'rejected',
      reason: 'invalid_switch_combination',
      code: 'role_switch_invalid',
      message: 'NEWIDE_BUFFER_V2 requires NEWIDE_DRIVER_EVIDENCE_ONLY=1',
    };
  }
  // 部署覆盖 + TaskBudget 的唯一合并入口：选路与 engine 使用同一份冻结策略。
  const resolved = resolveRolePolicyBudget({
    overrides: config.budget_overrides ?? {},
    ...(config.task_budget !== undefined ? { task_budget: config.task_budget } : {}),
  });
  if (resolved === undefined) {
    return {
      engine: 'rejected',
      reason: 'invalid_budget_overrides',
      code: 'role_budget_override_invalid',
      message:
        'role autonomy budget overrides/task budget must be positive integers and may only tighten limits',
    };
  }
  const now = input.now ?? new Date();
  const frozenAt = now.toISOString();
  const deadlineAt = new Date(
    now.getTime() + resolved.limits.wall_clock_seconds * 1_000,
  ).toISOString();
  const routing = config.routing ?? {};
  const freezePlan: RoleFrozenPolicyPlan = {
    limits: resolved.limits,
    deadline_at: deadlineAt,
    frozen_at: frozenAt,
    max_tool_calls: resolved.max_tool_calls,
    routing,
    evidence_only: switches.evidence_only,
    buffer_v2: switches.buffer_v2,
  };
  const freezeInput = buildRoleFreezeInitInput({
    limits: freezePlan.limits,
    deadline_at: freezePlan.deadline_at,
    max_tool_calls: freezePlan.max_tool_calls,
    routing: freezePlan.routing,
    evidence_only: freezePlan.evidence_only,
    buffer_v2: freezePlan.buffer_v2,
  });
  return {
    engine: ROLE_AUTONOMY_ENGINE,
    reason: 'fresh_role_autonomy',
    frozen: {
      engine: ROLE_AUTONOMY_ENGINE,
      engine_version: freezeInput.engine_version,
      tool_allowlist: freezeInput.tool_allowlist,
      evidence_only: switches.evidence_only,
      buffer_v2: switches.buffer_v2,
      budget: {
        limits: freezePlan.limits,
        deadline_at: freezePlan.deadline_at,
        max_tool_calls: freezePlan.max_tool_calls,
      },
      routing: freezePlan.routing,
    },
    freeze_plan: freezePlan,
    freeze_input: freezeInput,
    frozen_at: frozenAt,
  };
}

/** 恢复链上最近的冻结引擎（当前 Run 优先，其次父链）。 */
export async function findFrozenEngineInLineage(input: {
  runs_root: string;
  run_id: string;
  restarted_from_run_id?: string;
  identity: { run_id: string; task_id: string; role_id: string };
}): Promise<{ run_id: string; init: JournalInitEntry } | undefined> {
  const lineage = await collectRunLineage(
    input.runs_root,
    input.run_id,
    input.restarted_from_run_id,
  );
  for (const id of lineage) {
    const init = await peekJournalInit(input.runs_root, id, input.identity);
    if (init !== undefined) return { run_id: id, init };
  }
  return undefined;
}

/** 恢复链上限：防止损坏数据造成无限/超长遍历（selection 与 engine 共用同一语义）。 */
const MAX_LINEAGE_DEPTH = 32;

/**
 * 当前 Run + 持久化恢复父链（`request.json` 的 `recovery_parent_run_id`/`restarted_from_run_id`，
 * 首级可用 `fallbackParent` 兜底）。**selection 与 engine 共用这一个实现**：
 * - 深度上限 {@link MAX_LINEAGE_DEPTH}，重复 id（环）与非法 id 直接停止遍历；
 * - 只有「该 Run 没有 request.json」（ENOENT）当作没有父链；读取/解析失败抛
 *   {@link RoleLineageReadError}，由调用方 fail closed（不能当成「没有父链」静默降级）。
 */
export async function collectRunLineage(
  runsRoot: string,
  runId: string,
  fallbackParent?: string,
): Promise<string[]> {
  const lineage = [runId];
  let parent = (await readRecoveryParent(runsRoot, runId)) ?? fallbackParent;
  while (parent !== undefined) {
    if (!SAFE_RUN_ID.test(parent) || lineage.includes(parent)) break;
    if (lineage.length >= MAX_LINEAGE_DEPTH) break;
    lineage.push(parent);
    parent = await readRecoveryParent(runsRoot, parent);
  }
  return lineage;
}

async function readRecoveryParent(
  runsRoot: string,
  runId: string,
): Promise<string | undefined> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(
      await fs.readFile(path.join(runsRoot, runId, 'request.json'), 'utf8'),
    ) as Record<string, unknown>;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw new RoleLineageReadError(runId, error);
  }
  const parent = raw.recovery_parent_run_id ?? raw.restarted_from_run_id;
  return typeof parent === 'string' && parent.length > 0 ? parent : undefined;
}

/**
 * 恢复链读取失败：selection 把它映射成 `rejected(journal_unreadable)`，engine 映射成
 * `host_failed`；两边都不能把它当成「没有父链」。
 */
export class RoleLineageReadError extends Error {
  constructor(
    readonly run_id: string,
    override readonly cause: unknown,
  ) {
    super(`cannot read recovery parent of run ${run_id}: ${describeError(cause)}`, { cause });
    this.name = 'RoleLineageReadError';
  }
}

/**
 * 选路期的 Journal 读取错误：必须可区分地 fail closed，不能一律当成「没有冻结记录」
 * 而降级 legacy（损坏/权限/IO 错误会漏掉 unknown 或误接管旧 Run）。
 */
export class RoleSelectionJournalError extends Error {
  constructor(
    readonly code: 'journal_corrupt' | 'journal_unreadable',
    readonly reason: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RoleSelectionJournalError';
  }
}

/**
 * 只读窥视某 Run 的 Journal `init` 控制行。
 * - 没有 run 目录/Journal 文件 → undefined（契约允许的「无记录」，可按 legacy 规则解释）；
 * - 半写尾部 → 安全忽略尾部（阶段 1 的 read 已隔离），用已提交行里的 init；
 * - 损坏/不可读 → 抛 {@link RoleSelectionJournalError}，绝不返回 undefined。
 */
async function peekJournalInit(
  runsRoot: string,
  runId: string,
  identity: { run_id: string; task_id: string; role_id: string },
): Promise<JournalInitEntry | undefined> {
  let journal: RunDispatchJournal;
  try {
    journal = await RunDispatchJournal.peek({
      runDir: path.join(runsRoot, runId),
      identity,
    });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw new RoleSelectionJournalError(
      'journal_unreadable',
      'journal_unreadable',
      `cannot open the dispatch journal for run ${runId}`,
      { run_id: runId, cause: describeError(error) },
    );
  }
  let snapshot: DispatchJournalReadResult;
  try {
    snapshot = await journal.read();
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw new RoleSelectionJournalError(
      'journal_unreadable',
      'journal_unreadable',
      `cannot read the dispatch journal for run ${runId}`,
      { run_id: runId, cause: describeError(error) },
    );
  }
  if (snapshot.status === 'corrupt') {
    throw new RoleSelectionJournalError(
      'journal_corrupt',
      'journal_corrupt',
      `dispatch journal for run ${runId} is corrupt; refusing to treat it as a fresh legacy Run`,
      { run_id: runId, problems: snapshot.problems },
    );
  }
  return snapshot.controls.find((entry) => entry.event === 'init');
}

/**
 * Run 是否已经执行过（有阶段证据或执行器状态），用于阻止「部署开关打开后接管已开始的
 * legacy Run」。只看已提交的落盘事实，不读内存状态。
 */
async function runAlreadyStarted(runsRoot: string, runId: string): Promise<boolean> {
  const runDir = path.join(runsRoot, runId);
  for (const relative of ['stages/execute_agent.json', 'production-stage-state.json']) {
    try {
      const stat = await fs.stat(path.join(runDir, relative));
      if (stat.isFile() && stat.size > 0) return true;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      throw error;
    }
  }
  return false;
}

function isErrno(error: unknown, code: string): boolean {
  if (error === null || typeof error !== 'object') return false;
  return Reflect.get(error, 'code') === code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`Invalid run_id: ${runId}`);
}

/** 供 engine 构造冻结记录时复用的类型别名。 */
export type { ExecutionEngine, RoleBudgetLimits };
