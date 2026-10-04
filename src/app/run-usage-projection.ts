/**
 * 运行快照 `usage` 块的投影：把**已经采到的用量事实**收敛成对外契约。
 *
 * 为什么单独成文件而不是塞进快照投影器：用量数据的可见性与快照投影器不同——
 * `proxy.llm_usage_recorded` 只写进程内 registry（`NewideBackendService.appendTelemetry`
 * 不落 SQLite），driver 上下文占用只在进程内累加器里。所以这两条腿只有「本进程确实
 * 持有该 run」时才拿得到，而快照投影器是纯函数。组装点因此放在
 * `NewideBackendService.getRunSnapshot`，折叠逻辑放这里。
 *
 * 三条口径**互不相加**，一律不从时间线之外的来源编数字：
 * - `billed.by_source.*` —— 计费流量。存活期的 run 只填得上 `proxy` 腿；driver 侧计费
 *   （`driver_billed_usage`）要等 run 收尾并入 `summary.json` 才存在。**收尾后的 run 从
 *   账本取（`durable`）**，那一份带两条腿，而且进程重启后仍然在。
 * - `by_stage.*` —— 按 stage 分桶，**只覆盖 proxy 腿**，故 metric 名自带 `proxy`。
 * - `context` —— driver 上下文占用快照，`metric` 自描述，与 billed 不是同一个量。
 *
 * 一条都没有时整个 `usage` 缺席——不编一个 0 出来。
 */
import type { RunUsage, RunUsageTokens } from '../protocol/run-snapshot';
import type { TaskDriverUsage } from './driver-usage-projector';
import { resolveTokenUsageFromTimeline, summarizeRunConsumption } from './run-terminal-output-writer';
import type { DurableRunUsage } from './run-usage-history';

export interface RunUsageProjectionInput {
  /**
   * 存活期的 run 事件流（registry）。**缺席表示本进程不持有该 run**，与「有一条空时间线」
   * 是两件事：前者没有 proxy 腿可读，后者读出来是 0 条用量事件。缺省而不是空数组，就是为了
   * 让这个区别在类型上就看得见。
   */
  timeline?: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>;
  /** 进程内 driver 上下文占用累加器；进程重启后为空。 */
  driverUsage?: TaskDriverUsage | undefined;
  /**
   * 已收尾 run 的持久计费用量（账本）。给了它就**压过**时间线那一条腿。
   *
   * 为什么持久的那份优先：它是 run 收尾时写死的权威件——proxy 腿与 driver 计费腿都在里面，
   * 而存活期时间线永远只有 proxy 腿（driver 腿从不进事件流）。同一个 run 在「进程还持有它」
   * 与「进程重启后读」两种情况下必须报同一个 `billed`，否则面板上这个 run 的数字会随后端
   * 重启而变。**只有已收尾的 run 才该传它**：在跑的 run 账本里还没有行，而时间线是活的。
   */
  durable?: DurableRunUsage | undefined;
}

export function projectRunUsage(input: RunUsageProjectionInput): RunUsage | undefined {
  const billed = billedFromDurable(input.durable) ?? projectBilled(input.timeline);
  const byStage = projectByStage(input.timeline);
  const context = projectContext(input.driverUsage);

  if (!billed && !byStage && !context) return undefined;
  return {
    ...(billed ? { billed } : {}),
    ...(context ? { context } : {}),
    ...(byStage ? { by_stage: byStage } : {}),
  };
}

/**
 * 账本的按腿合计 → 快照的 `billed` 块。
 *
 * 一条腿都没有时返回 `undefined`（而不是一个 `by_source: {}` 的块）：那会让前端把「没有
 * 数据」读成「有数据且为零」。调用方要的就是这个区别。
 */
export function billedFromDurable(durable: DurableRunUsage | undefined): RunUsage['billed'] | undefined {
  if (!durable) return undefined;
  const bySource: Record<string, RunUsageTokens> = {};
  for (const [source, totals] of Object.entries(durable.by_source)) {
    // 拷贝而不是透传引用：账本聚合出来的对象会随下一次查询重建，但契约对象一旦发出去
    // 就不该再被任何人从背后改。
    bySource[source] = { ...totals };
  }
  if (Object.keys(bySource).length === 0) return undefined;
  return { metric: 'billed_tokens', by_source: bySource };
}

function projectBilled(
  timeline: RunUsageProjectionInput['timeline'],
): RunUsage['billed'] | undefined {
  if (!timeline) return undefined;
  const summary = resolveTokenUsageFromTimeline(timeline);
  if (!summary) return undefined;
  const bySource: Record<string, RunUsageTokens> = {};
  for (const [source, totals] of Object.entries(summary.by_source)) {
    bySource[source] = toTokens(totals);
  }
  return { metric: 'billed_tokens', by_source: bySource };
}

function projectByStage(
  timeline: RunUsageProjectionInput['timeline'],
): RunUsage['by_stage'] | undefined {
  if (!timeline) return undefined;
  // 复用终态 summary 的同一个折叠函数：实时快照与 `summary.consumption` 必须同口径。
  const consumption = summarizeRunConsumption(timeline, undefined);
  const stages: NonNullable<RunUsage['by_stage']> = {};
  for (const [stage, metrics] of Object.entries(consumption.by_stage)) {
    // 只留**真的有用量**的桶。`summarizeRunConsumption` 为了统计消耗会把所有事件都归桶，
    // 于是一个完全没有 LLM 用量的 run 也会得到一堆 `total_tokens: 0` 的桶——那既让
    // 「缺席」语义失效，又会让前端把「账本为空」读成「这个 stage 花了 0 token」。
    if (metrics.llm_calls === 0 && metrics.total_tokens === 0) continue;
    stages[stage] = {
      metric: 'proxy_billed_tokens',
      events: metrics.events,
      llm_calls: metrics.llm_calls,
      total_tokens: metrics.total_tokens,
    };
  }
  return Object.keys(stages).length > 0 ? stages : undefined;
}

function projectContext(driverUsage: TaskDriverUsage | undefined): RunUsage['context'] | undefined {
  if (!driverUsage?.available) return undefined;
  return {
    metric: 'context_tokens_used',
    context_tokens_used: driverUsage.context_tokens_used,
    // 完整旗标如实透传：被截断文件喂出的观测是 false，不能冒充完整数据。
    complete: driverUsage.complete,
    sessions: driverUsage.sessions.map((session) => ({
      session_id: session.session_id,
      ...(session.role_id ? { role_id: session.role_id } : {}),
      context_tokens_used: session.context_tokens_used,
      ...(session.context_window_size !== undefined
        ? { context_window_size: session.context_window_size }
        : {}),
      ...(session.reported_cost ? { reported_cost: { ...session.reported_cost } } : {}),
    })),
  };
}

function toTokens(totals: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_input_tokens: number;
  total_tokens: number;
  call_count: number;
}): RunUsageTokens {
  return {
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cache_creation_input_tokens: totals.cache_creation_input_tokens,
    cache_read_input_tokens: totals.cache_read_input_tokens,
    total_input_tokens: totals.total_input_tokens,
    total_tokens: totals.total_tokens,
    call_count: totals.call_count,
  };
}
