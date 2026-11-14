/**
 * 阶段 2「角色自主循环与显式结束」的共享契约（app 组合根内部使用）。
 *
 * 职责与核心逻辑：
 * - 定义新路径的唯一执行引擎标记、工具表、预算初值、finish 输入/判定、typed termination
 *   与 loop 结果类型；role-execution-loop / 工具实现 / finish 校验 / 引擎适配层都只依赖本文件。
 * - **完成语义（阶段 2 精简后）**：Role 负责判断任务要求是否满足，并用 finish 的
 *   `verification[]` 逐条陈述 passed/failed/not_run；宿主**不再**从自由文本 completion_criteria
 *   推导检查义务，也不再解析命令/子句/检查范围。宿主只核验证据事实（受控 ref/hash/身份、
 *   host_observed 观察状态、unknown/取消/预算/只读违规等）。
 * - **冻结记录不另造平行账本**：引擎版本、工具授权、开关、预算初值与 deadline 由 Journal 的
 *   `init` 控制行承载（阶段 1 已有 schema，本阶段仅做加法扩展），恢复时从 `fold().init` 读回。
 * - 预算只有四个维度：dispatch / role LLM 回合 / role token / 墙钟；单 dispatch 超时是
 *   派工约束，不计入四类预算。初值来自设计 v3.0（12 / 40 / 120000 / 45min / 10min）。
 * - `RoleTerminationError` 只表达**宿主可识别的终止分支**；role 自己 finish(blocked/failed)
 *   也走同一通道，由 coordination 的 `stageFailure` 映射为 `task.error.code`。
 *
 * 边界：本文件不执行 LLM、不碰文件系统；阶段 3 的 `evidence_only` / `buffer_v2` 是**冻结开关**
 * （默认关闭，与预算一起写入 Journal init 行），其派工/学习输入实现在
 * `src/app/role-learning-input.ts` 与 `src/driver/driver-runtime-invoker.ts`。
 */
import { z } from 'zod';
import type { TaskBudget } from '../core';
import type {
  BudgetSnapshot,
  DispatchJournalBarrierError,
  DriverStreamEvent,
  DispatchRecord,
  EvidenceRef,
  ExecutionBrief,
  ExecutionEvidence,
  ExecutionStatus,
  JournalInitEntry,
  JournalViolation,
  ReconciledAppendInput,
} from '../driver';
import { EvidenceRefSchema, JournalVerificationClaimSchema } from '../driver';
import type {
  DispatchJournalEvidencePage,
  DispatchJournalFoldResult,
  DispatchJournalReadResult,
  JournalFinishAppendInput,
  JournalInitAppendInput,
  ReadDispatchEvidenceOptions,
  RoleRoundAppendInput,
} from '../persistence';
import type { ToolCallMessage, ToolCallResult, ToolDefinition } from '../memory';
import type { AgentExecutionResult, RoleFreezePlanInput } from '../protocol/agent-execution';

// ─────────────────────────────────────────────────────────────
// 引擎标记与版本
// ─────────────────────────────────────────────────────────────

export const LEGACY_EXECUTION_ENGINE = 'legacy' as const;
export const ROLE_AUTONOMY_ENGINE = 'role_autonomy' as const;
export type ExecutionEngine = typeof LEGACY_EXECUTION_ENGINE | typeof ROLE_AUTONOMY_ENGINE;

/** 冻结在 Journal `init` 行里的引擎版本；改变 loop 语义时必须升级。 */
export const ROLE_AUTONOMY_ENGINE_VERSION = 'role-autonomy-v1' as const;

/**
 * 阶段 3 的两个显式开关（都默认关闭，打开需要 NEWIDE_ROLE_AUTONOMY 同时打开）。
 *
 * 合法组合只有三种：都不开；只开 evidence_only；evidence_only + buffer_v2。
 * `buffer_v2` 依赖 `evidence_only`：v2 学习输入的定义就是「没有六字段报告」，
 * 要求六字段报告同时写 v2 只会把两份互不一致的事实拼在一起。非法组合由选路配置
 * 构造处显式拒绝，不在 Run 内静默降级。
 */
export interface RoleAutonomySwitches {
  evidence_only: boolean;
  buffer_v2: boolean;
}

export const DEFAULT_ROLE_AUTONOMY_SWITCHES: RoleAutonomySwitches = {
  evidence_only: false,
  buffer_v2: false,
};

/** 开关组合的合法性判定（选路配置与冻结记录读回共用同一规则）。 */
export function isRoleAutonomySwitchCombinationValid(switches: RoleAutonomySwitches): boolean {
  return switches.buffer_v2 ? switches.evidence_only : true;
}

// ─────────────────────────────────────────────────────────────
// 预算
// ─────────────────────────────────────────────────────────────

/** 设计 v3.0 §5/§9 的冻结初值。 */
export const ROLE_BUDGET_DEFAULTS = {
  max_dispatches: 12,
  max_role_rounds: 40,
  role_token_budget: 120_000,
  wall_clock_seconds: 45 * 60,
  dispatch_timeout_ms: 10 * 60 * 1000,
} as const;

/**
 * role 工具调用次数上限（TaskBudget.max_tool_calls 的宿主默认值）。
 *
 * 它不是「四类预算」之外的新宿主预算维度，而是任务级请求约束的默认上限：
 * 只在 TaskBudget.max_tool_calls 显式给出时收紧；旧冻结记录没有该字段时视为无此约束
 * （恢复不得凭空扩/缩冻结策略）。`finish_task` 是结束控制而不是环境动作，不计数。
 */
export const ROLE_DEFAULT_MAX_TOOL_CALLS = 64;

export type RoleBudgetLimits = {
  max_dispatches: number;
  max_role_rounds: number;
  role_token_budget: number;
  wall_clock_seconds: number;
  dispatch_timeout_ms: number;
};

/** 请求侧只能收紧宿主上限，不能放大。 */
export const RoleBudgetOverridesSchema = z
  .object({
    max_dispatches: z.number().int().positive().optional(),
    max_role_rounds: z.number().int().positive().optional(),
    role_token_budget: z.number().int().positive().optional(),
    wall_clock_seconds: z.number().int().positive().optional(),
    dispatch_timeout_ms: z.number().int().positive().optional(),
  })
  .strict();
export type RoleBudgetOverrides = z.infer<typeof RoleBudgetOverridesSchema>;

/** 冻结后的预算记录（写入 Journal init；恢复时原样读回，不能被 restart 清零）。 */
export interface RoleFrozenBudget {
  limits: RoleBudgetLimits;
  /** 首次进入 execute_agent 时按 wall_clock_seconds 算出的绝对 deadline。 */
  deadline_at: string;
  /**
   * 任务级工具调用上限（来自 TaskBudget.max_tool_calls，缺省取
   * {@link ROLE_DEFAULT_MAX_TOOL_CALLS}）。旧冻结记录没有该字段时为 undefined，
   * 恢复不得凭空补一个更紧或更松的上限。
   */
  max_tool_calls?: number;
}

/**
 * 合并宿主初值与请求覆盖：请求只能收紧（取 min），非法值直接拒绝。
 * 返回 `undefined` 表示请求覆盖非法，调用方必须拒绝选路而不是静默降级。
 */
export function resolveRoleBudgetLimits(
  overrides: RoleBudgetOverrides = {},
): RoleBudgetLimits | undefined {
  const limits: RoleBudgetLimits = { ...ROLE_BUDGET_DEFAULTS };
  for (const key of Object.keys(ROLE_BUDGET_DEFAULTS) as Array<keyof RoleBudgetLimits>) {
    const requested = overrides[key];
    if (requested === undefined) continue;
    if (!Number.isInteger(requested) || requested <= 0) return undefined;
    limits[key] = Math.min(limits[key], requested);
  }
  return limits;
}

/**
 * TaskBudget → role-loop 预算的唯一映射入口（选路与 engine 共用同一份，不得各自推导）。
 *
 * 适用语义（RD-DIS-05 / 计划 §6.5）：
 * - `max_tokens` → `role_token_budget`（role LLM token；driver token 是外部观测，不在此硬限）；
 * - `max_wall_clock_seconds` → `wall_clock_seconds`；
 * - `max_tool_calls` → 任务级工具调用上限（不含 finish_task），缺省取
 *   {@link ROLE_DEFAULT_MAX_TOOL_CALLS}，任务只能收紧；
 * - 三个字段都只能收紧宿主上限，非法值（非正整数）→ 拒绝选路，不静默降级。
 */
export function resolveRolePolicyBudget(input: {
  overrides?: RoleBudgetOverrides;
  task_budget?: TaskBudget;
}): { limits: RoleBudgetLimits; max_tool_calls: number } | undefined {
  const limits = resolveRoleBudgetLimits(input.overrides ?? {});
  if (limits === undefined) return undefined;
  const taskBudget = input.task_budget;
  if (taskBudget !== undefined) {
    const taskTokens = optionalPositiveInteger(taskBudget.max_tokens);
    if (taskTokens === 'invalid') return undefined;
    if (taskTokens !== undefined) {
      limits.role_token_budget = Math.min(limits.role_token_budget, taskTokens);
    }
    const taskWallClock = optionalPositiveInteger(taskBudget.max_wall_clock_seconds);
    if (taskWallClock === 'invalid') return undefined;
    if (taskWallClock !== undefined) {
      limits.wall_clock_seconds = Math.min(limits.wall_clock_seconds, taskWallClock);
    }
  }
  const taskToolCalls = optionalPositiveInteger(input.task_budget?.max_tool_calls);
  if (taskToolCalls === 'invalid') return undefined;
  return {
    limits,
    max_tool_calls:
      taskToolCalls === undefined
        ? ROLE_DEFAULT_MAX_TOOL_CALLS
        : Math.min(ROLE_DEFAULT_MAX_TOOL_CALLS, taskToolCalls),
  };
}

function optionalPositiveInteger(value: number | undefined): number | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) return 'invalid';
  return value;
}

/** 已消费量 + 缺失用量标记；禁止把缺失 token 用量填 0 冒充已知。 */
export interface RoleBudgetConsumption {
  dispatches: number;
  role_rounds: number;
  tokens: number;
  /** 已执行的 role 环境工具调用（不含 finish_task）；恢复时从 role_round 行累加。 */
  tool_calls: number;
  /** 任一回合的 usage 缺失即 true：token 预算只做软限制，不宣称物理硬上限。 */
  tokens_missing: boolean;
}

export interface RoleBudgetSnapshot {
  frozen: RoleFrozenBudget;
  consumed: RoleBudgetConsumption;
  /** 墙钟剩余毫秒（可能为负）；由 clock 现算，不从持久化值推导。 */
  wall_clock_remaining_ms: number;
}

/** 预算触限的稳定原因码；用作 typed termination code。 */
export const ROLE_BUDGET_EXHAUSTED_CODES = [
  'budget_dispatches',
  'budget_rounds',
  'budget_tokens',
  'budget_wall_clock',
  'budget_tool_calls',
] as const;
export type RoleBudgetExhaustedCode = (typeof ROLE_BUDGET_EXHAUSTED_CODES)[number];

// ─────────────────────────────────────────────────────────────
// typed termination
// ─────────────────────────────────────────────────────────────

export type RoleTerminationActor = 'role' | 'host' | 'user';

/** 阶段 2 必须能透传到 task.error.code / run.failed 的原因码（RD-TRM-01/02）。 */
export const ROLE_TERMINATION_CODES = [
  'role_blocked',
  'role_failed',
  'budget_dispatches',
  'budget_rounds',
  'budget_tokens',
  'budget_wall_clock',
  'budget_tool_calls',
  'host_failed',
  'host_cancelled',
  'dispatch_unknown_unresolved',
  'dispatch_timeout',
  'journal_write_failed',
  'journal_corrupt',
  'journal_unreadable',
  'evidence_write_failed',
] as const;
export type RoleTerminationCode = (typeof ROLE_TERMINATION_CODES)[number];

export interface RoleTermination {
  code: RoleTerminationCode;
  actor: RoleTerminationActor;
  message: string;
  details?: Record<string, unknown>;
}

/** 只由宿主抛出的 typed termination；不得用 message 字符串冒充原因码。 */
export class RoleTerminationError extends Error {
  readonly termination: RoleTermination;

  constructor(termination: RoleTermination, cause?: unknown) {
    super(termination.message, cause === undefined ? undefined : { cause });
    this.name = 'RoleTerminationError';
    this.termination = termination;
  }
}

/**
 * `DispatchJournalBarrierError` → typed termination 的**唯一映射**（engine 派工与工具表共用）：
 * `evidence` 侧车写失败 → `evidence_write_failed`；`accepted`/`dispatched`/`settled` 都是
 * Journal 行写 → `journal_write_failed`（`settled` 是 Journal 终态行，evidence 已 durable）。
 * stage/dispatch_id/driver_invoked/side_effect_state 与屏障原始 code 保留为诊断，两条路径不各写一份。
 */
export function roleTerminationFromDispatchBarrier(
  error: DispatchJournalBarrierError,
): RoleTerminationError {
  return new RoleTerminationError(
    {
      code: error.stage === 'evidence' ? 'evidence_write_failed' : 'journal_write_failed',
      actor: 'host',
      message: error.message,
      details: {
        stage: error.stage,
        dispatch_id: error.dispatch_id,
        driver_invoked: error.driver_invoked,
        side_effect_state: error.side_effect_state,
        barrier_code: error.code,
      },
    },
    error.original_error ?? error,
  );
}

// ─────────────────────────────────────────────────────────────
// 跨模块事实规约（finish 校验 / engine 最终闸门 / loop 诊断共用同一 reducer）
// ─────────────────────────────────────────────────────────────

/**
 * 可信收束：settled 为 succeeded/failed/cancelled/interrupted，或迟到/回执对账给出
 * 非 unknown 的 `reconciled`（unknown 本身仍保留在 journal，不被改写）。
 * `unknown` / `not_executed` 本身不是收束事实。
 */
export function isTrustedDispatchRecord(record: DispatchRecord): boolean {
  if (record.status !== 'unknown' && record.status !== 'not_executed') return true;
  return record.reconciled !== undefined && record.reconciled.status !== 'unknown';
}

/**
 * 未收束 unknown dispatch 的**唯一** reducer（finish 校验、engine 最终闸门、loop 诊断共用）：
 * - 只有 `status='unknown'` 的派工可能未收束；
 * - 后续派工通过 `brief.retry_of` 指向它、且该重试本身可信（settled 或可信 reconciled）时视为
 *   已收束；按 retry 链传递闭包（A unknown → B 重试 A → C 重试 B 且 C 可信，A/B 都收束）；
 * - unknown 记录本身永不被改写；返回顺序与输入记录顺序一致。
 */
export function resolveUnresolvedDispatchIds(records: readonly DispatchRecord[]): string[] {
  const trusted = new Set<string>();
  const retriesByTarget = new Map<string, string[]>();
  for (const record of records) {
    if (isTrustedDispatchRecord(record)) trusted.add(record.dispatch_id);
    const target = record.brief.retry_of;
    if (target === undefined) continue;
    const retries = retriesByTarget.get(target) ?? [];
    retries.push(record.dispatch_id);
    retriesByTarget.set(target, retries);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [target, retries] of retriesByTarget) {
      if (trusted.has(target)) continue;
      if (retries.some((retryId) => trusted.has(retryId))) {
        trusted.add(target);
        changed = true;
      }
    }
  }
  const unresolved: string[] = [];
  for (const record of records) {
    if (record.status === 'unknown' && !trusted.has(record.dispatch_id)) {
      unresolved.push(record.dispatch_id);
    }
  }
  return unresolved;
}

/** role 工具自身返回的错误码（不结束循环，作为工具结果交还 role 继续决策）。 */
export const ROLE_TOOL_ERROR_CODES = [
  'ROLE_ALREADY_FINISHED',
  'ROLE_FINISH_REJECTED',
  'ROLE_UNKNOWN_TOOL',
  'ROLE_INVALID_ARGUMENTS',
  'ROLE_DISPATCH_BUDGET_EXHAUSTED',
  'ROLE_DISPATCH_BARRIER_FAILED',
  'ROLE_EVIDENCE_UNAVAILABLE',
  'ROLE_MEMORY_UNAVAILABLE',
] as const;
export type RoleToolErrorCode = (typeof ROLE_TOOL_ERROR_CODES)[number];

// ─────────────────────────────────────────────────────────────
// 工具表与参数 schema（模型输入一律 strict 拒绝身份/宿主字段）
// ─────────────────────────────────────────────────────────────

export const ROLE_TOOL_NAMES = [
  'dispatch_execution',
  'query_memory',
  'read_evidence',
  'update_plan',
  'finish_task',
] as const;
export type RoleToolName = (typeof ROLE_TOOL_NAMES)[number];

export const RoleDispatchKindSchema = z.enum(['investigate', 'execute', 'verify']);
export type RoleDispatchKind = z.infer<typeof RoleDispatchKindSchema>;

export const RoleSessionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fresh') }).strict(),
  z.object({ mode: z.literal('reuse'), session_id: z.string().trim().min(1) }).strict(),
]);
export type RoleSession = z.infer<typeof RoleSessionSchema>;

/** 工具参数里的证据引用：由宿主校验登记、路径安全与 sha256。 */
const RoleEvidenceRefSchema = EvidenceRefSchema.describe(
  '受控 evidence 引用：path 为 run 目录内的安全相对路径，sha256 为 64 位小写 hex',
);

/** `dispatch_execution` 的模型侧参数：只有内容字段，身份/sequence/预算由宿主填写。 */
export const RoleDispatchExecutionArgsSchema = z
  .object({
    instruction: z
      .string()
      .trim()
      .min(1)
      .max(20_000)
      .describe('交给 driver 的本次派工指令（driver 只执行这条 Brief，不继承原始任务锁定）'),
    kind: RoleDispatchKindSchema.describe(
      'investigate=调查（只读）；execute=实现/修改；verify=验证（缺省只读）',
    ),
    /** investigate 恒只读；execute/verify 由 role 显式声明，缺省按 kind 推导。 */
    read_only: z
      .boolean()
      .optional()
      .describe('显式声明本次派工只读；investigate 恒只读，execute 必须写'),
    acceptance: z
      .array(z.string().trim().min(1).max(2_000))
      .max(20)
      .default([])
      .describe('本次派工的验收标准（交给 driver 的 Brief）'),
    constraints: z
      .array(z.string().trim().min(1).max(2_000))
      .max(20)
      .default([])
      .describe('本次派工的约束'),
    expected_artifacts: z
      .array(z.string().trim().min(1).max(500))
      .max(20)
      .default([])
      .describe('期望产物（工作区相对路径或说明）'),
    session: RoleSessionSchema.default({ mode: 'fresh' }).describe(
      'fresh=新 Session；reuse=复用本 Run 已确认的 Session（只能给 confirmed_session_id）',
    ),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(ROLE_BUDGET_DEFAULTS.dispatch_timeout_ms)
      .optional()
      .describe('单次派工超时（只能收紧宿主冻结上限）'),
    /** 显式重试：新 dispatch_id + retry_of 引用；unknown 目标还需 reconciliation_ref 取证。 */
    retry_of: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe('显式重试：被引用的既有 dispatch_id（unknown 目标必须同时给 reconciliation_ref）'),
    reconciliation_ref: RoleEvidenceRefSchema.optional(),
  })
  .strict();
export type RoleDispatchExecutionArgs = z.infer<typeof RoleDispatchExecutionArgsSchema>;

export const RoleQueryMemoryArgsSchema = z
  .object({
    query: z.string().trim().min(1).max(2_000).describe('记忆检索关键词'),
    limit: z.number().int().min(1).max(20).optional().describe('返回条数上限'),
  })
  .strict();
export type RoleQueryMemoryArgs = z.infer<typeof RoleQueryMemoryArgsSchema>;

export const RoleReadEvidenceArgsSchema = z
  .object({
    ref: RoleEvidenceRefSchema,
    offset: z.number().int().min(0).optional().describe('按字节偏移分页'),
    limit: z.number().int().min(1).optional().describe('本页字节上限'),
  })
  .strict();
export type RoleReadEvidenceArgs = z.infer<typeof RoleReadEvidenceArgsSchema>;

export const RoleUpdatePlanArgsSchema = z
  .object({
    plan: z
      .string()
      .trim()
      .min(1)
      .max(8_000)
      .describe('当前计划（只是计划，不构成执行或完成证据）'),
  })
  .strict();
export type RoleUpdatePlanArgs = z.infer<typeof RoleUpdatePlanArgsSchema>;

export const RoleFinishStatusSchema = z.enum(['completed', 'blocked', 'failed']);
export type RoleFinishStatus = z.infer<typeof RoleFinishStatusSchema>;

/**
 * Role 对「任务要求是否满足」的显式陈述（阶段 2 精简后的完成语义载体）。
 *
 * 语义收缩（RD-FIN-03 修订）：
 * - 宿主**不再**从自由文本 `completion_criteria` 推断检查义务，也不再解析命令、比较 argv、
 *   拆分子句或推断检查范围；判断要求是否满足是 role 的语义职责。
 * - role 用本结构明确说明每条要求的结论：`passed` / `failed` / `not_run`；未验证的要求必须
 *   用 `not_run`/`failed` 或 finish 的 `unresolved` 明说，不能声称通过。
 * - 宿主只核验**事实**：`passed` 必须指向本 Run/恢复链真实发生过的派工（`dispatch_ids`），
 *   且该派工已有 `host_observed`、`complete`、`exit_code=0`、内容指纹与最终交付一致的检查证据；
 *   引用的 evidence ref 仍走 journal 的登记/hash/路径校验。
 * - 宿主不比较 requirement 文本与 `completion_criteria`，不要求命令名出现在要求里，也不因为
 *   某个要求没被 claim 就拒绝完成——那属于 role 的判断与 `unresolved` 披露。
 */
export const RoleVerificationOutcomeSchema = JournalVerificationClaimSchema.shape.outcome;
export const ROLE_VERIFICATION_OUTCOMES = RoleVerificationOutcomeSchema.options;
export type RoleVerificationOutcome = z.infer<typeof RoleVerificationOutcomeSchema>;

export const RoleVerificationClaimSchema = JournalVerificationClaimSchema.extend({
  dispatch_ids: JournalVerificationClaimSchema.shape.dispatch_ids.default([]),
  evidence_refs: JournalVerificationClaimSchema.shape.evidence_refs.default([]),
});
export type RoleVerificationClaim = z.infer<typeof RoleVerificationClaimSchema>;

export const RoleFinishArgsSchema = z
  .object({
    status: RoleFinishStatusSchema.describe('completed=任务完成；blocked=被阻塞；failed=失败'),
    summary: z.string().trim().min(1).max(8_000).describe('给用户的最终答复（不是过程日志）'),
    evidence_refs: z.array(EvidenceRefSchema).max(64).default([]),
    unresolved: z
      .array(z.string().trim().min(1).max(2_000))
      .max(32)
      .default([])
      .describe('仍未解决/未验证的事项（如实列出，不要留空话）'),
    role_reflection: z.string().max(8_000).default(''),
    /** 无代码修改的答复类任务用它支撑完成；不能据此声称跑过命令/测试。 */
    response_only: z.boolean().optional(),
    verification: z
      .array(RoleVerificationClaimSchema)
      .max(32)
      .default([])
      .describe(
        '逐条说明任务要求的满足情况。宿主只核验事实：passed 必须引用真实派工及其 host_observed 通过检查；' +
          'failed/not_run 如实陈述即可。宿主不再从 completion_criteria 自动推导义务、不解析命令，' +
          '也不要为了凑格式把未验证项写成 passed。',
      ),
  })
  .strict();
export type RoleFinishArgs = z.infer<typeof RoleFinishArgsSchema>;

/** finish 被拒绝时要交还 role 的具体缺口（不是普通 message）。 */
export const ROLE_FINISH_GAP_CODES = [
  'finish_already_accepted',
  'unresolved_dispatch',
  'read_only_violation',
  'evidence_ref_not_registered',
  'evidence_hash_mismatch',
  'evidence_missing',
  'evidence_source_insufficient',
  'evidence_stale',
  'budget_exhausted',
  'cancelled',
  'response_only_conflict',
  'journal_unavailable',
] as const;
export type RoleFinishGapCode = (typeof ROLE_FINISH_GAP_CODES)[number];

export interface RoleFinishGap {
  code: RoleFinishGapCode;
  message: string;
  detail?: Record<string, unknown>;
}

export interface RoleFinishDecision {
  accepted: boolean;
  /** 接受时返回宿主要求的规范化 finish 记录；拒绝时为 undefined。 */
  record?: RoleFinishRecord;
  /** 拒绝时的具体缺口，role 可据此继续决策。 */
  gaps?: RoleFinishGap[];
}

export interface RoleFinishRecord {
  status: RoleFinishStatus;
  summary: string;
  evidence_refs: EvidenceRef[];
  unresolved: string[];
  role_reflection: string;
  response_only: boolean;
  /** Role 对任务要求满足情况的显式陈述；宿主只核验其中引用的证据事实。 */
  verification: RoleVerificationClaim[];
  accepted_at: string;
}

/** 工具执行结果统一形状：成功返回 data，失败返回稳定 code，由 loop 转成 tool 消息。 */
export interface RoleToolResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: RoleToolErrorCode | RoleFinishGapCode; message: string; detail?: unknown };
}

// ─────────────────────────────────────────────────────────────
// 角色 LLM 端口（只做通用 tool-calling，不深依赖 driver/persistence）
// ─────────────────────────────────────────────────────────────

export interface RoleLlmUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface RoleLlmCompletion {
  content: string | null;
  tool_calls: ToolCallResult['tool_calls'];
  /** 缺失即不填（不填 0）；loop 据此标记 tokens_missing。 */
  usage?: RoleLlmUsage;
}

export interface RoleLlmPort {
  completeWithTools(input: {
    messages: ToolCallMessage[];
    tools: ToolDefinition[];
    signal?: AbortSignal;
  }): Promise<RoleLlmCompletion>;
}

// ─────────────────────────────────────────────────────────────
// 记忆、证据与派工端口（真实实现由 app 适配层注入）
// ─────────────────────────────────────────────────────────────

export interface RoleMemoryRecallInput {
  task_id: string;
  run_id: string;
  role_id: string;
  instruction: string;
  workspace_path?: string;
}

export interface RoleMemoryRecall {
  /** 渲染好的召回文本（供首轮上下文注入）。 */
  text: string;
  context_pack_ref?: string;
  memory_buffer_ref?: string;
}

export interface RoleMemoryQueryInput {
  query: string;
  limit?: number;
}

export interface RoleMemoryQueryResult {
  text: string;
  count: number;
}

export interface RoleMemoryPort {
  recall(input: RoleMemoryRecallInput, signal?: AbortSignal): Promise<RoleMemoryRecall>;
  query(input: RoleMemoryQueryInput): Promise<RoleMemoryQueryResult>;
}

/** 派工写屏障端口：真实实现包装阶段 1 的 runJournaledDispatch。 */
export interface RoleDispatchInput {
  brief: ExecutionBrief;
  brief_sha256: string;
  budget_before: BudgetSnapshot;
}

export type RoleDispatchObservation = {
  dispatch_id: string;
  status: ExecutionStatus;
  evidence: ExecutionEvidence;
  evidence_ref: EvidenceRef;
  evidence_sha256: string;
  violations: JournalViolation[];
  attempts: 1;
  record?: DispatchRecord;
};

export interface RoleDispatchPort {
  run(input: RoleDispatchInput): Promise<RoleDispatchObservation>;
}

/**
 * loop 需要的 Journal 能力。阶段 1 的 RunDispatchJournal 已实现这些方法；
 * 这里只声明最小面，避免 loop 依赖 persistence 运行时。
 */
export interface RoleJournalPort {
  read(): Promise<DispatchJournalReadResult>;
  fold(): Promise<DispatchJournalFoldResult>;
  appendInit(input: JournalInitAppendInput): Promise<void>;
  appendFinish(input: JournalFinishAppendInput): Promise<void>;
  appendRoleRound(input: RoleRoundAppendInput): Promise<void>;
  /** 迟到结果对账：只追加 reconciled，不覆盖已 settle 的终态、不触发重跑。 */
  appendReconciled?(input: ReconciledAppendInput): Promise<void>;
  registerEvidenceRef(ref: EvidenceRef): Promise<void>;
  readEvidence(
    ref: EvidenceRef,
    options?: ReadDispatchEvidenceOptions,
  ): Promise<DispatchJournalEvidencePage>;
  getDispatchRecord(dispatchId: string): Promise<DispatchRecord | undefined>;
}

// ─────────────────────────────────────────────────────────────
// 预算控制器与 finish 校验端口（实现分别在同名模块，loop 只依赖端口）
// ─────────────────────────────────────────────────────────────

/**
 * loop 只依赖这个端口；四类预算的检查/消费/恢复都在实现里。
 * 触限必须抛 {@link RoleTerminationError}（budget_dispatches / budget_rounds /
 * budget_tokens / budget_wall_clock），不能只返回布尔值让 loop 忘记处理。
 */
export interface RoleBudgetPort {
  readonly frozen: RoleFrozenBudget;
  snapshot(now?: Date): RoleBudgetSnapshot;
  /** 调用 LLM 之前调用；回合/墙钟触限抛 typed termination。 */
  assertRoundAllowed(now?: Date): void;
  /**
   * LLM 返回后调用：累计 usage + 回合 + 本回复声明的工具调用数，并 durable 写 `role_round`
   * （写失败抛 journal_write_failed）。`tool_calls` 超任务级上限时**在执行工具之前**抛
   * `budget_tool_calls`（不产生半个回复的副作用）。
   */
  recordRound(
    round: number,
    usage: RoleLlmUsage | undefined,
    at: string,
    toolCalls?: number,
  ): Promise<void>;
  /** 派工之前调用；dispatch 数/墙钟触限抛 typed termination。 */
  assertDispatchAllowed(now?: Date): void;
  /** 派工 settled 成功后计数（不再检查）。 */
  recordDispatch(): void;
  /** token 软阈值检查（usage 缺失时标记 missing，不做物理硬断言）。 */
  assertTokenBudget(now?: Date): void;
}

export interface RoleFinishValidatorInput {
  request: RoleFinishArgs;
  journal: RoleJournalPort;
  context: RoleLoopContextInput;
  budget: RoleBudgetPort;
  dispatches: readonly RoleDispatchObservation[];
  cancelled: boolean;
  /**
   * 当前最终交付对象（工作区内容）指纹；由 engine 通过
   * {@link RoleLoopContextInput.workspace_fingerprint} 在 finish 校验时现算。
   * host_observed 检查证据只有在与该指纹一致时才算「适用于最终交付对象」。
   */
  current_workspace_sha256?: string;
  /**
   * 完整合法恢复链上的祖先派工记录（只读事实）：祖先只读违规、已结算检查证据、
   * response_only 冲突同样参与 completed 校验，不因新建恢复 Run 而消失。
   */
  inherited_records?: readonly DispatchRecord[];
  now?: Date;
}

export interface RoleFinishValidatorPort {
  /** 纯校验：接受返回跟 consensus 记录，拒绝返回具体缺口（role 可继续决策）。 */
  validate(input: RoleFinishValidatorInput): Promise<RoleFinishDecision>;
}

// ─────────────────────────────────────────────────────────────
// 冻结记录（Journal init 行的读写映射）
// ─────────────────────────────────────────────────────────────

export interface RoleFrozenRouting {
  /** 冻结的 driver 解析结果引用（不迁移 Session/记忆）。 */
  driver_id?: string;
  profile_id?: string;
}

export interface RoleFrozenPolicy {
  engine: typeof ROLE_AUTONOMY_ENGINE;
  engine_version: string;
  tool_allowlist: RoleToolName[];
  evidence_only: boolean;
  buffer_v2: boolean;
  budget: RoleFrozenBudget;
  routing: RoleFrozenRouting;
}

/**
 * 选路阶段算好、原样交给 engine 的冻结预算计划。
 * **唯一策略来源**：engine 不得再各自合并 TaskBudget/部署覆盖得出另一份；只有恢复时
 * 才以 Journal 里的已冻结记录为准（且不得扩大）。
 */
export interface RoleFrozenPolicyPlan {
  limits: RoleBudgetLimits;
  /** 与 `frozen_at` 同一次时钟读数算出的绝对 deadline（Journal init 也写这一份）。 */
  deadline_at: string;
  /** 冻结决策时刻（ISO）；Journal init 的 `at` 必须用它，保证 deadline- at 恰好等于墙钟上限。 */
  frozen_at: string;
  max_tool_calls: number;
  routing: RoleFrozenRouting;
  /** 首次进入 execute_agent 时冻结的 stage 3 开关（恢复时从 init 行读回，不随部署变化）。 */
  evidence_only: boolean;
  buffer_v2: boolean;
}

/** 由选路模块构造、交给 journal.appendInit 的完整冻结参数（身份字段由宿主填）。 */
export interface RoleFreezeInitInput {
  autonomy: true;
  evidence_only: boolean;
  buffer_v2: boolean;
  max_dispatches: number;
  max_role_rounds: number;
  role_token_budget: number;
  deadline_at: string;
  engine: typeof ROLE_AUTONOMY_ENGINE;
  engine_version: string;
  tool_allowlist: RoleToolName[];
  routing: RoleFrozenRouting;
  dispatch_timeout_ms: number;
  /** TaskBudget.max_tool_calls 映射后的任务级工具调用上限（旧冻结记录可缺省）。 */
  max_tool_calls?: number;
}

export function buildRoleFreezeInitInput(input: {
  limits: RoleBudgetLimits;
  deadline_at: string;
  max_tool_calls?: number;
  routing?: RoleFrozenRouting;
  evidence_only?: boolean;
  buffer_v2?: boolean;
  now?: string;
}): RoleFreezeInitInput {
  return {
    autonomy: true,
    evidence_only: input.evidence_only ?? false,
    buffer_v2: input.buffer_v2 ?? false,
    max_dispatches: input.limits.max_dispatches,
    max_role_rounds: input.limits.max_role_rounds,
    role_token_budget: input.limits.role_token_budget,
    deadline_at: input.deadline_at,
    engine: ROLE_AUTONOMY_ENGINE,
    engine_version: ROLE_AUTONOMY_ENGINE_VERSION,
    tool_allowlist: [...ROLE_TOOL_NAMES],
    routing: input.routing ?? {},
    dispatch_timeout_ms: input.limits.dispatch_timeout_ms,
    ...(input.max_tool_calls !== undefined ? { max_tool_calls: input.max_tool_calls } : {}),
  };
}

/**
 * 从 Journal init 行读回冻结策略。缺失引擎/版本/工具授权/上限的旧行按 legacy 解释，
 * 返回 undefined——不得用部署默认值补一份假的冻结记录。
 *
 * 阶段 3 起 `evidence_only` / `buffer_v2` 是**冻结值**而不是「未实现开关」：读回时原样
 * 继承（即使部署默认值后来变了）。只拒绝永远不合法的组合（buffer_v2 依赖 evidence_only）。
 */
export function roleFrozenPolicyFromJournalInit(
  init: JournalInitEntry | undefined,
): RoleFrozenPolicy | undefined {
  if (init === undefined) return undefined;
  if (init.engine !== ROLE_AUTONOMY_ENGINE) return undefined;
  if (init.autonomy !== true) return undefined;
  if (
    !isRoleAutonomySwitchCombinationValid({
      evidence_only: init.evidence_only,
      buffer_v2: init.buffer_v2,
    })
  ) {
    return undefined;
  }
  if (!Array.isArray(init.tool_allowlist) || init.tool_allowlist.length === 0) return undefined;
  if (init.dispatch_timeout_ms === undefined) return undefined;
  const limits: RoleBudgetLimits = {
    max_dispatches: init.max_dispatches,
    max_role_rounds: init.max_role_rounds,
    role_token_budget: init.role_token_budget,
    // wall_clock_seconds 由 deadline_at - init.at 还原；恢复期不再重新计时。
    wall_clock_seconds: Math.max(
      1,
      Math.round((Date.parse(init.deadline_at) - Date.parse(init.at)) / 1000),
    ),
    dispatch_timeout_ms: init.dispatch_timeout_ms,
  };
  return {
    engine: ROLE_AUTONOMY_ENGINE,
    engine_version: init.engine_version ?? 'unknown',
    tool_allowlist: init.tool_allowlist as RoleToolName[],
    // 阶段 3：开关从冻结记录读回，恢复不随部署默认值切换（同一 Run 内数据格式解释不变）。
    evidence_only: init.evidence_only,
    buffer_v2: init.buffer_v2,
    budget: {
      limits,
      deadline_at: init.deadline_at,
      ...(init.max_tool_calls !== undefined ? { max_tool_calls: init.max_tool_calls } : {}),
    },
    routing: (init.routing ?? {}) as RoleFrozenRouting,
  };
}

// ─────────────────────────────────────────────────────────────
// loop 输入/输出
// ─────────────────────────────────────────────────────────────

/** finish 时刻的工作区交付事实（只保留宿主可核验的内容指纹）。 */
export interface RoleWorkspaceState {
  /** 工作区文件内容快照的 canonical sha256；读取失败时缺省（finish 不会把证据当适用）。 */
  sha256?: string;
}

export interface RoleLoopContextInput {
  task_id: string;
  run_id: string;
  role_id: string;
  instruction: string;
  workspace_path?: string;
  /** 本 Run 已确认可复用的 Session（reuse 必须与它一致；默认 fresh）。 */
  confirmed_session_id?: string;
  /** 冻结的 driver id（reuse 必须与冻结 driver 一致；只作记录/校验）。 */
  frozen_driver_id?: string;
  /** 无代码修改的答复类任务（可由 response_only 支撑完成）。 */
  response_only_allowed: boolean;
  /**
   * 任务完成标准（原始文本）。只注入 role 上下文供其语义判断；宿主**不**从中推导检查义务、
   * 不解析命令，也不要求 finish 逐条覆盖（阶段 2 精简后的完成语义收缩）。
   */
  completion_criteria?: string[];
  /**
   * 恢复上下文摘要（当前 Run + 祖先 Run 的既有派工事实，大小上限由 engine 控制）。
   * 首轮注入 role 上下文；不给就没有既有工作可看。
   */
  recovery_summary?: string;
  /**
   * 恢复前已有的派工观察（当前 Run 与祖先链；含 accepted/dispatched-only 的 unknown 事实）。
   * loop 把它们计入 outcome.dispatches 与 zero_dispatch，不重复执行。
   */
  recovered_dispatches?: readonly RoleDispatchObservation[];
  /** 恢复前已有派工总数（含 accepted-only/dispatched-only，不能丢 zero_dispatch 判定）。 */
  recovered_dispatch_count?: number;
  /** 恢复前已存在、尚无可信收束的 unknown dispatch id。 */
  recovered_unresolved_dispatches?: readonly string[];
  /**
   * 最终交付对象（工作区）事实：finish 校验时现算，用于拒绝「旧版本成功后又修改」的过期
   * 检查证据（内容指纹）。engine 注入，loop 只在 validate 时调用。
   */
  workspace_fingerprint?: () => Promise<RoleWorkspaceState>;
}

export interface RoleLoopOptions {
  llm: RoleLlmPort;
  journal: RoleJournalPort;
  dispatch: RoleDispatchPort;
  memory: RoleMemoryPort;
  policy: RoleFrozenPolicy;
  context: RoleLoopContextInput;
  /** 四类预算控制器（检查/消费/恢复都在实现里）。 */
  budget: RoleBudgetPort;
  /** finish 证据校验端口（拒绝后把 gaps 交还 role 继续决策）。 */
  finish: RoleFinishValidatorPort;
  /** 已消费量（恢复时从 Journal/role_round 行读回；新 Run 为空）。 */
  consumed: RoleBudgetConsumption;
  clock?: () => Date;
  signal?: AbortSignal;
  /** 单回合普通文本上限/工具结果上限（防止上下文无限增长）。 */
  limits?: { history_messages?: number; tool_result_chars?: number; dispatch_history?: number };
}

export type RoleLoopStatus = 'completed' | 'blocked' | 'failed';

export interface RoleUsage {
  input_tokens: number;
  output_tokens: number;
  usage_missing: boolean;
  role_rounds: number;
}

export interface RoleLoopOutcome {
  status: RoleLoopStatus;
  finish: RoleFinishRecord;
  response: string;
  dispatches: RoleDispatchObservation[];
  usage: RoleUsage;
  zero_dispatch: boolean;
  plan: string | undefined;
  /** 恢复时发现的未收束 dispatch（unknown），供诊断/终态证据使用。 */
  unresolved_dispatches: string[];
}

// ─────────────────────────────────────────────────────────────
// 引擎端口（facade 只依赖这个端口；真实实现在 role-autonomy-engine.ts）
// ─────────────────────────────────────────────────────────────

export interface RoleAutonomyEngineRequest {
  task_id: string;
  run_id: string;
  role_id: string;
  instruction: string;
  driver_instruction?: string;
  workspace_path?: string;
  session_id?: string;
  resume_session?: boolean;
  restarted_from_run_id?: string;
  completion_criteria?: string[];
  activity_run_id?: string;
  /** 任务请求预算（TaskBudget）；与部署覆盖一起由选路冻结，engine 不再自行推导。 */
  task_budget?: TaskBudget;
  /** stage 选路算出的冻结计划；新 Run 首次执行时原样落 Journal，避免二次合并。 */
  freeze_plan?: RoleFreezePlanInput;
  signal?: AbortSignal;
  on_driver_event?: (event: DriverStreamEvent) => void;
}

/**
 * 引擎运行结果使用 protocol 的 `AgentExecutionResult`（facade 原样返回给
 * stage executor）；role 的 blocked/failed/预算/host 终止走 `RoleTerminationError`，
 * 由 stage executor 转成 coordination 的 typed termination。
 */
export interface RoleAutonomyEnginePort {
  run(input: RoleAutonomyEngineRequest): Promise<AgentExecutionResult>;
}
