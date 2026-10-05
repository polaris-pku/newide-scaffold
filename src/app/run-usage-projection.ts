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
import type { RunSnapshot, RunUsage, RunUsageTokens } from '../protocol/run-snapshot';
import { DEFAULT_DRIVER_BILLED_SOURCE, type TokenUsageSource } from '../persistence';
import type { TaskDriverUsage } from './driver-usage-projector';
import { resolveTokenUsageFromTimeline, summarizeRunConsumption } from './run-terminal-output-writer';
import type { DurableRunUsage } from './run-usage-history';

/**
 * driver 计费腿的**缺省**来源名。
 *
 * 零配置（单个 `acp-external` + claude）时就是它——账本、事件流、`summary.json` 里
 * 已经全是这个名字，换一个会让新旧 run 对不上账。真正生效的名字由组装点从 driver
 * 档案（`DriverProfile.billing.source`）解析后传进 `pendingBilledSources`。
 */
export const DRIVER_BILLED_SOURCE = DEFAULT_DRIVER_BILLED_SOURCE satisfies TokenUsageSource;

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
  /**
   * 这个 run 此刻**注定还没到**的计费腿，由组装点按 run 状态算（见 `pendingBilledSources`）
   * ——投影本身不认识「状态」这个概念。缺席与空数组同义：都不加 `pending_sources`。
   */
  pendingSources?: readonly string[] | undefined;
}

/**
 * 某个状态的 run 里「注定还没到」的计费腿。
 *
 * driver 计费腿**只在收尾时出生**：`finalize` 从 Claude 的 session JSONL 刮出来、写进
 * `summary.json`，再进账本。所以运行中的 run 无论跑了多久，`billed` 里都只可能有 proxy 腿。
 * 实测一次真实 run：proxy 3,308、driver 计费 80,933——缺的那条是总量的 **96%**。面板要把
 * 「还没到」与「没花」分开，靠的就是这个名单。
 *
 * 返回空数组表示「该到的都到了」（已收尾的 run）。收尾之后某条腿仍然缺席时，成因在
 * `summary.json` 的 `driver_billed_merge` 里（§7.9），**不**在这里报——那是「为什么没有」，
 * 这是「还没到时候」。
 *
 * @param driverBilledSource 本部署实际使用的 driver 计费腿名。由组装点从 driver 档案
 *   解析后传入；缺省是历史名 `claude_session_jsonl`，也就是零配置时的取值。
 */
export function pendingBilledSources(
  status: RunSnapshot['status'],
  driverBilledSource: string = DRIVER_BILLED_SOURCE,
): string[] {
  return status === 'running' ? [driverBilledSource] : [];
}

export function projectRunUsage(input: RunUsageProjectionInput): RunUsage | undefined {
  const billed = billedFromDurable(input.durable) ?? projectBilled(input.timeline);
  const byStage = projectByStage(input.timeline);
  const context = projectContext(input.driverUsage);
  const billedWithPending =
    billed === undefined ? undefined : withPendingSources(billed, input.pendingSources);

  if (!billedWithPending && !byStage && !context) return undefined;
  return {
    ...(billedWithPending ? { billed: billedWithPending } : {}),
    ...(context ? { context } : {}),
    ...(byStage ? { by_stage: byStage } : {}),
  };
}

/**
 * 把「还没到」的腿挂上去。
 *
 * **只报真的缺席的那些**：腿要是已经在了（账本两条腿齐了、而调用方仍然传了名单），说它
 * pending 就是在撒谎。这条判据不是防御性空转——同一个组装点既服务在跑的 run 也服务已收尾
 * 的 run，名单与账本各自由不同的事实算出来。
 */
function withPendingSources(
  billed: NonNullable<RunUsage['billed']>,
  pending: readonly string[] | undefined,
): RunUsage['billed'] {
  const missing = (pending ?? []).filter((source) => billed.by_source[source] === undefined);
  return missing.length > 0 ? { ...billed, pending_sources: missing } : billed;
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
  return { metric: 'billed_tokens', by_source: canonicalBySource(bySource) };
}

/**
 * `by_source` 的键序规范化：字典序。
 *
 * 为什么这不是「好看」而是契约的一部分：同一个 run 的 `billed` 有**两条取数路径**——账本
 * （`GROUP BY` 出来的顺序，实测恰好是字典序，但那是索引的巧合）与 run 目录自己的
 * `summary.json`（写入时的顺序）。实测同一个真实 run（662,716 token、两条腿）：回填前后
 * **数值逐字段相同、键序相反**（`proxy,claude_session_jsonl` ↔ `claude_session_jsonl,proxy`）。
 *
 * 对象键序在 JSON 语义上无关，但后果是两个：① 一个按键序渲染腿列表的前端会看到同一个 run
 * 的腿在回填前后换位；② 「两条路径同值」这件事只能靠 `toEqual` 断言，`JSON.stringify` 一比
 * 就**假红**——本轮的端到端探针就是这么红的。
 *
 * 选字典序而不是某个「语义顺序」：任何语义顺序都是要额外维护的策略，而字典序两类来源都
 * 算得出来。
 *
 * 只有一个调用点**不需要**它：`projectBilled`（存活期时间线那条路）。`resolveTokenUsageFromTimeline`
 * 的返回类型写着 `sources: ['proxy']`——那里的 `by_source` 按构造只有一条腿，排序是恒等。
 * 所以别把那一处当成漏了；真的出现第二条腿时（类型会先变）再补。
 *
 * `by_stage` 也不做这件事——它只有一条来源（run 自己的 timeline），顺序本来就是确定的。
 */
export function canonicalBySource<T>(bySource: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(bySource).sort(([left], [right]) => left.localeCompare(right)),
  );
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
  // 这里不做键序规范化：`resolveTokenUsageFromTimeline` 的返回类型是 `sources: ['proxy']`，
  // 按构造只有一条腿（见 `canonicalBySource` 的注释）。
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
