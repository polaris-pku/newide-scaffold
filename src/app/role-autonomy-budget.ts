/**
 * 阶段 2 四类预算控制器（RD-DIS-05 / RD-TRM-01，计划 §6.5）。
 *
 * 职责与核心逻辑：
 * - 实现 {@link RoleBudgetPort}：dispatch 数、role LLM 回合数、role token、墙钟四个维度。
 *   单 dispatch 超时不属于四类预算（由派工层用 `timeout_ms` 处理），这里不掺和。
 * - 预算是**宿主**能力：触限必须抛 {@link RoleTerminationError}（actor='host'），由 loop 交给
 *   stage executor → `task-execution-loop.stageFailure` → `task.error.code`，不能只返回布尔值。
 * - 墙钟按冻结的绝对 deadline（`frozen.budget.deadline_at`）用注入 clock 现算，不从持久化值
 *   推导；恢复期不重新计时（RD-SEL-05）。回合/派工数在**开始下一轮/下一次之前**检查，
 *   因此「恰好用完上限后提交 finish」不会被预算拒绝。
 * - `recordRound` 是 durable 写入点：先 `journal.appendRoleRound`（usage_missing 对应），
 *   成功后才把消费量记进内存；写失败转 `journal_write_failed`，loop 必须终止。
 * - **缺失 usage 不填 0**：`tokens_missing=true`，token 只做软限制（RD-EVD-07：外部 driver
 *   token 只做观察/软阈值，不承诺物理硬上限）。
 * - 恢复折叠 `foldRoleBudgetFacts` 是生产/测试共用的唯一算法：从当前 Run 与祖先链的
 *   Journal 事实（折叠记录数 + `role_round` 控制行）还原已消费量，restart 不得清零；
 *   缺失 usage 只标 `tokens_missing`，绝不补 0 冒充已知用量。
 *
 * 边界：本模块不调用 LLM/driver、不检查 AbortSignal（取消由 loop 检查，本模块不吞），
 * 也不修改 Journal 的其它控制行。
 */
import type { DispatchJournalLine, JournalRoleRoundEntry } from '../driver';
import type {
  RoleBudgetConsumption,
  RoleBudgetPort,
  RoleBudgetSnapshot,
  RoleFrozenBudget,
  RoleJournalPort,
  RoleLlmUsage,
} from './role-autonomy-contract';
import { RoleTerminationError } from './role-autonomy-contract';

// ─────────────────────────────────────────────────────────────
// 初值与构造
// ─────────────────────────────────────────────────────────────

/** 新 Run 的已消费量（每次返回新对象，避免调用方共享可变状态）。 */
export function emptyRoleBudgetConsumption(): RoleBudgetConsumption {
  return { dispatches: 0, role_rounds: 0, tokens: 0, tool_calls: 0, tokens_missing: false };
}

export interface RoleBudgetInit {
  /** 冻结预算（Journal `init` 行读回；restart 不改）。 */
  frozen: RoleFrozenBudget;
  /** 已消费量（新 Run 用 {@link emptyRoleBudgetConsumption}，恢复用 restore 工厂）。 */
  consumed: RoleBudgetConsumption;
  journal: RoleJournalPort;
  /** 可注入时钟（测试确定性；生产用系统时钟）。 */
  clock?: () => Date;
}

interface NormalizedRoleLlmUsage {
  missing: boolean;
  tokens: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * 四类预算的检查/消费/恢复实现。所有触限分支抛 typed termination，
 * 调用方（loop）不得吞掉后继续调用 LLM/driver。
 */
export class RoleBudget implements RoleBudgetPort {
  readonly frozen: RoleFrozenBudget;
  private readonly journal: RoleJournalPort;
  private readonly clock: () => Date;
  private consumed: RoleBudgetConsumption;

  constructor(input: RoleBudgetInit) {
    assertConsumption(input.consumed);
    this.frozen = input.frozen;
    this.journal = input.journal;
    this.clock = input.clock ?? (() => new Date());
    this.consumed = { ...input.consumed };
  }

  /** 只读快照：墙钟剩余由 clock 现算（可能为负），已消费量返回副本。 */
  snapshot(now?: Date): RoleBudgetSnapshot {
    return {
      frozen: this.frozen,
      consumed: { ...this.consumed },
      wall_clock_remaining_ms: this.wallClockRemainingMs(now),
    };
  }

  /**
   * 调用 LLM 之前调用：墙钟先于回合数检查（时间是不可协商的硬停止），
   * 回合数达到上限时抛 `budget_rounds`。
   */
  assertRoundAllowed(now?: Date): void {
    this.assertWallClock(now);
    const max = this.frozen.limits.max_role_rounds;
    if (this.consumed.role_rounds >= max) {
      throw new RoleTerminationError({
        code: 'budget_rounds',
        actor: 'host',
        message: `role LLM round budget exhausted (${this.consumed.role_rounds}/${max})`,
        details: { role_rounds: this.consumed.role_rounds, max_role_rounds: max },
      });
    }
  }

  /**
   * LLM 返回后调用：累计回合与 token，并 durable 写 `role_round`。
   * usage 缺失时 `usage_missing=true` 且不带 token 数字（绝不填 0）。
   */
  async recordRound(
    round: number,
    usage: RoleLlmUsage | undefined,
    at: string,
    toolCalls?: number,
  ): Promise<void> {
    if (!Number.isInteger(round) || round <= 0) {
      throw new RoleTerminationError({
        code: 'host_failed',
        actor: 'host',
        message: `role round number must be a positive integer, got ${String(round)}`,
        details: { round },
      });
    }
    const normalizedToolCalls = toolCalls ?? 0;
    if (!Number.isInteger(normalizedToolCalls) || normalizedToolCalls < 0) {
      throw new RoleTerminationError({
        code: 'host_failed',
        actor: 'host',
        message: `role tool_calls must be a non-negative integer, got ${String(toolCalls)}`,
        details: { tool_calls: toolCalls },
      });
    }
    const normalized = normalizeRoleLlmUsage(usage);
    const next: RoleBudgetConsumption = {
      dispatches: this.consumed.dispatches,
      role_rounds: this.consumed.role_rounds + 1,
      tokens: this.consumed.tokens + normalized.tokens,
      tool_calls: this.consumed.tool_calls + normalizedToolCalls,
      tokens_missing: this.consumed.tokens_missing || normalized.missing,
    };
    try {
      await this.journal.appendRoleRound({
        round,
        at,
        usage_missing: normalized.missing,
        ...(normalized.missing
          ? {}
          : { input_tokens: normalized.input_tokens, output_tokens: normalized.output_tokens }),
        ...(normalizedToolCalls > 0 ? { tool_calls: normalizedToolCalls } : {}),
      });
    } catch (error) {
      throw new RoleTerminationError(
        {
          code: 'journal_write_failed',
          actor: 'host',
          message: `failed to persist role_round ${round} to the dispatch journal`,
          details: { round, at, cause: describeError(error) },
        },
        error,
      );
    }
    // 只有 durable 写成功后才把消费量记进内存：写失败必须终止，不能留下「已消费但没账」。
    this.consumed = next;
    // 任务级 tool-call 上限（来自 TaskBudget.max_tool_calls）：超限时在**执行本回复的工具之前**
    // 终止，避免产生半个回复的副作用；消费事实已 durable 落盘，恢复后不会重新获得额度。
    const maxToolCalls = this.frozen.max_tool_calls;
    if (maxToolCalls !== undefined && this.consumed.tool_calls > maxToolCalls) {
      throw new RoleTerminationError({
        code: 'budget_tool_calls',
        actor: 'host',
        message: `role tool-call budget exhausted (${this.consumed.tool_calls}/${maxToolCalls})`,
        details: {
          tool_calls: this.consumed.tool_calls,
          max_tool_calls: maxToolCalls,
          round,
        },
      });
    }
  }

  /** 派工之前调用：墙钟先于 dispatch 数检查，达到上限时抛 `budget_dispatches`。 */
  assertDispatchAllowed(now?: Date): void {
    this.assertWallClock(now);
    const max = this.frozen.limits.max_dispatches;
    if (this.consumed.dispatches >= max) {
      throw new RoleTerminationError({
        code: 'budget_dispatches',
        actor: 'host',
        message: `dispatch budget exhausted (${this.consumed.dispatches}/${max})`,
        details: { dispatches: this.consumed.dispatches, max_dispatches: max },
      });
    }
  }

  /** 派工 settled 后计数（不再检查；下一次派工前由 assertDispatchAllowed 检查）。 */
  recordDispatch(): void {
    this.consumed = { ...this.consumed, dispatches: this.consumed.dispatches + 1 };
  }

  /**
   * token 软阈值检查：**已知** token 已超上限时抛 `budget_tokens`。
   * `tokens_missing=true` 时无法声称物理硬上限（外部 driver 可能没回 usage），
   * 因此只在已观测到的 token 数字上判定，不因「缺失」推断超限（RD-EVD-07）。
   */
  assertTokenBudget(): void {
    const limit = this.frozen.limits.role_token_budget;
    if (this.consumed.tokens >= limit) {
      throw new RoleTerminationError({
        code: 'budget_tokens',
        actor: 'host',
        message: `role token budget exhausted (${this.consumed.tokens}/${limit})`,
        details: {
          tokens: this.consumed.tokens,
          role_token_budget: limit,
          tokens_missing: this.consumed.tokens_missing,
        },
      });
    }
  }

  private now(now?: Date): Date {
    return now ?? this.clock();
  }

  private wallClockRemainingMs(now?: Date): number {
    return Date.parse(this.frozen.deadline_at) - this.now(now).getTime();
  }

  private assertWallClock(now?: Date): void {
    const at = this.now(now);
    const remaining = Date.parse(this.frozen.deadline_at) - at.getTime();
    if (!Number.isFinite(remaining)) {
      throw new RoleTerminationError({
        code: 'host_failed',
        actor: 'host',
        message: `frozen role budget has an invalid deadline_at: ${this.frozen.deadline_at}`,
        details: { deadline_at: this.frozen.deadline_at },
      });
    }
    if (remaining <= 0) {
      throw new RoleTerminationError({
        code: 'budget_wall_clock',
        actor: 'host',
        message: `role wall clock exhausted (deadline ${this.frozen.deadline_at})`,
        details: {
          deadline_at: this.frozen.deadline_at,
          now: at.toISOString(),
          remaining_ms: remaining,
        },
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 预算恢复：唯一的事实折叠算法（生产 engine 与测试共用）
// ─────────────────────────────────────────────────────────────

/** 一个 Run 的预算相关 Journal 事实（当前 Run 或祖先链上一级）。 */
export interface RoleBudgetFacts {
  /** 该 Run 的派工记录数（Journal 折叠结果，accepted-only/dispatched-only 都计入）。 */
  dispatches: number;
  /** 该 Run 的 `role_round` 控制行。 */
  role_rounds: readonly JournalRoleRoundEntry[];
}

/**
 * 把 Journal 事实折叠成已消费预算——**生产与测试共用的唯一算法**：
 * - dispatches 由调用方按折叠记录数给出并逐级累加（restart 不清零、恢复不重置额度）；
 * - 回合数取最大 `round`（不是行数；半写/重复不会重复计数）；
 * - token 只累加 usage 已知的回合；任一回合缺失 usage → `tokens_missing=true`，
 *   缺失值绝不补 0 冒充已知用量；
 * - tool_calls 累加每回合声明的环境工具调用数（`usage_missing` 的回合同样计数）。
 * 祖先事实与当前 Run 事实按同一算法折叠，调用方只需把多级 Facts 放进数组。
 */
export function foldRoleBudgetFacts(
  facts: readonly RoleBudgetFacts[],
): RoleBudgetConsumption {
  const consumed = emptyRoleBudgetConsumption();
  for (const fact of facts) {
    consumed.dispatches += fact.dispatches;
    for (const entry of fact.role_rounds) {
      consumed.role_rounds = Math.max(consumed.role_rounds, entry.round);
      consumed.tool_calls += entry.tool_calls ?? 0;
      if (entry.usage_missing) {
        consumed.tokens_missing = true;
        continue;
      }
      consumed.tokens += (entry.input_tokens ?? 0) + (entry.output_tokens ?? 0);
    }
  }
  return consumed;
}

/** 从 Journal 读取结果收集一个 Run 的预算事实（控制行筛选只在这里维护一份）。 */
export function roleBudgetFactsFromLines(
  dispatches: number,
  lines: readonly DispatchJournalLine[],
): RoleBudgetFacts {
  return {
    dispatches,
    role_rounds: lines.filter(
      (line): line is JournalRoleRoundEntry => line.event === 'role_round',
    ),
  };
}

// ─────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────

function normalizeRoleLlmUsage(usage: RoleLlmUsage | undefined): NormalizedRoleLlmUsage {
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  if (!isTokenCount(input) || !isTokenCount(output)) {
    return { missing: true, tokens: 0, input_tokens: 0, output_tokens: 0 };
  }
  return { missing: false, tokens: input + output, input_tokens: input, output_tokens: output };
}

function isTokenCount(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function assertConsumption(consumed: RoleBudgetConsumption): void {
  for (const key of ['dispatches', 'role_rounds', 'tokens', 'tool_calls'] as const) {
    const value = consumed[key];
    if (!Number.isInteger(value) || value < 0) {
      throw new RoleTerminationError({
        code: 'host_failed',
        actor: 'host',
        message: `role budget consumption.${key} must be a non-negative integer, got ${String(value)}`,
        details: { field: key, value },
      });
    }
  }
  if (typeof consumed.tokens_missing !== 'boolean') {
    throw new RoleTerminationError({
      code: 'host_failed',
      actor: 'host',
      message: 'role budget consumption.tokens_missing must be a boolean',
      details: { field: 'tokens_missing' },
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
