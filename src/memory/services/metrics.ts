/**
 * Metrics 事件采集与退休信号评估
 *
 * 对应 week3 RFC 深度设计「第一部分 Metrics」。本服务是 Metrics 的"写侧"：
 * 将 Agent 生命周期里的事件（竞标 / 中标 / 任务结果）落成 AgentMetrics 的增量更新，
 * 以及"读侧"的退休信号评估（evaluateRetirementSignals），供退休检测消费。
 *
 * ## 事件 → 字段映射
 *
 * | 事件                | 触发的指标更新                                      |
 * | ------------------- | --------------------------------------------------- |
 * | task.bid            | tasks_bid++                                         |
 * | task.won            | tasks_won++, total_tasks++, last_won_at             |
 * | task.completed      | tasks_completed++, tasks_succeeded++（或 partial/failed）|
 * | task.started        | last_task_at, first_task_at（首次）                 |
 *
 * 说明：total_tasks 按"实际派发执行的任务数"统计（即中标并执行），
 * 与 RFC 中"参与的任务总数（含竞标失败和中标）"略有出入——因为当前
 * 协调层不会把竞标失败结果回传给 Memory，Memory 只能观察到中标者。
 */
import { nowTimestamp } from '../../core';
import type { MemoryRepository } from '../ports/memory-repository';
import type { AgentMetrics } from '../schemas';

/** 一次任务执行的结果（用于 success_rate 等派生指标） */
export type TaskOutcome = 'succeeded' | 'partial' | 'failed';

/**
 * 记录一次竞标（Agent 参与声明且决定 participate）。
 * 仅递增 tasks_bid，不触碰其他字段。
 */
export async function recordBid(repository: MemoryRepository, role_id: string): Promise<void> {
  await repository.updateMetrics(role_id, (m) => ({ ...m, tasks_bid: m.tasks_bid + 1 }));
}

/**
 * 记录一次任务派发结果（Agent 已中标并执行完成）。
 *
 * 无论成功/部分/失败，都算"中标 + 已执行"：
 * - tasks_won++, total_tasks++, tasks_completed++
 * - last_task_at / last_won_at 更新为当前时间，first_task_at 首次写入
 * - 按 outcome 递增 tasks_succeeded / tasks_partial / tasks_failed
 */
export async function recordTaskOutcome(
  repository: MemoryRepository,
  role_id: string,
  outcome: TaskOutcome,
): Promise<void> {
  await repository.updateMetrics(role_id, (m) => {
    const now = nowTimestamp();
    const next: AgentMetrics = {
      ...m,
      total_tasks: m.total_tasks + 1,
      tasks_won: m.tasks_won + 1,
      tasks_completed: m.tasks_completed + 1,
      last_task_at: now,
      last_won_at: now,
      first_task_at: m.first_task_at ?? now,
    };
    if (outcome === 'succeeded') {
      next.tasks_succeeded += 1;
    } else if (outcome === 'partial') {
      next.tasks_partial += 1;
    } else {
      next.tasks_failed += 1;
    }
    return next;
  });
}

// ═══════════════════════════════════════════════════════════
//  退休信号评估（week3 RFC §10 / §11 的轻量统计层）
// ═══════════════════════════════════════════════════════════

export const RETIREMENT_THRESHOLDS = {
  /** 距上次中标超过该天数 → 警告 */
  stale_warn_days: 30,
  /** 距上次中标超过该天数 → 严重，建议退休 */
  stale_critical_days: 90,
  /** 成功率低于该阈值 → 低质量信号（新手阶段折半） */
  success_rate_floor: 0.3,
  /** 至少完成这么多任务才评估成功率（避免小样本误判） */
  min_completed_for_success_rate: 10,
  /** total_tasks 低于该值视为"新手容错期"，成功率阈值折半 */
  novice_task_threshold: 20,
  /** 执行任务数低于该值时不建议退休（白板/新 Agent 保护） */
  min_tasks_to_judge: 3,
} as const;

export interface RetirementSignals {
  /** 距上次中标的天数（从未中标为 Infinity） */
  days_since_last_won: number;
  /** 超过 stale_warn_days 未中标 */
  stale_bids: boolean;
  /** 超过 stale_critical_days 未中标 */
  critical_staleness: boolean;
  /** 最近 N 次已完成任务的成功率低于阈值 */
  low_success_rate: boolean;
  /** 超过 stale_warn_days 未参与任何任务 */
  inactive: boolean;
  /**
   * 决策矩阵（简化自 week3 RFC §11.4）：
   * - retire: 严重滞留，或 滞留 + 低成功率
   * - warn:   滞留 / 低成功率 / 不活跃 任一
   * - keep:   一切正常或样本不足
   */
  recommended_action: 'retire' | 'warn' | 'keep';
}

/**
 * 从 AgentMetrics 计算退休信号（轻量统计层，O(1)，不调用 LLM）。
 *
 * @param now 当前时间戳（ms），测试时可注入固定时间
 */
export function evaluateRetirementSignals(
  metrics: AgentMetrics,
  now: number = Date.now(),
): RetirementSignals {
  const dayMs = 24 * 60 * 60 * 1000;
  const daysSince = (iso: string | undefined): number =>
    iso ? Math.max(0, (now - Date.parse(iso)) / dayMs) : Number.POSITIVE_INFINITY;

  const daysSinceLastWon = daysSince(metrics.last_won_at);
  const daysSinceLastTask = daysSince(metrics.last_task_at);

  const staleBids = daysSinceLastWon > RETIREMENT_THRESHOLDS.stale_warn_days;
  const criticalStaleness = daysSinceLastWon > RETIREMENT_THRESHOLDS.stale_critical_days;

  const completed = metrics.tasks_completed;
  const successRate = completed > 0 ? metrics.tasks_succeeded / completed : 0;
  const floor =
    metrics.total_tasks < RETIREMENT_THRESHOLDS.novice_task_threshold
      ? RETIREMENT_THRESHOLDS.success_rate_floor / 2
      : RETIREMENT_THRESHOLDS.success_rate_floor;
  const lowSuccessRate =
    completed >= RETIREMENT_THRESHOLDS.min_completed_for_success_rate && successRate < floor;

  const inactive = daysSinceLastTask > RETIREMENT_THRESHOLDS.stale_warn_days;

  let recommendedAction: RetirementSignals['recommended_action'];
  if (metrics.total_tasks < RETIREMENT_THRESHOLDS.min_tasks_to_judge) {
    recommendedAction = 'keep';
  } else if (criticalStaleness || (staleBids && lowSuccessRate)) {
    recommendedAction = 'retire';
  } else if (staleBids || lowSuccessRate || inactive) {
    recommendedAction = 'warn';
  } else {
    recommendedAction = 'keep';
  }

  return {
    days_since_last_won: daysSinceLastWon,
    stale_bids: staleBids,
    critical_staleness: criticalStaleness,
    low_success_rate: lowSuccessRate,
    inactive,
    recommended_action: recommendedAction,
  };
}
