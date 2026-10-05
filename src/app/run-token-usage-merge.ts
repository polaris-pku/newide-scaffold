/**
 * 把 driver 侧（真实 coding agent）的计费 token 并进 `summary.token_usage`。
 *
 * 为什么必须在 run 收尾之后再并一次：`summary.json` 首写时 `token_usage` 只含时间线里
 * 能看到的 proxy 部分——`run-terminal-output-writer` 的 `resolveTokenUsageFromTimeline`
 * 只数 `proxy.llm_usage_recorded` 事件。而 driver 侧真实 coding agent 的计费 token 从不
 * 进入 run 事件流，只能事后从 Claude Code 的 session JSONL 刮取。
 *
 * 为什么不能挂在 B maintenance：maintenance 由 buffer 触发，跑在 run 收尾**之前**。
 * 实测（2026-09-19 一次真实 council run）maintenance 12:20:53–12:21:02 结束，而
 * `summary.json` 12:22:23 才落盘，早 82 秒——读不到文件，52 万 token 就这么丢了。
 *
 * 刻意不读 run 级账本（`snapshotRunLedgerUsage`）：账本可能已被释放，拿到的是偏小的
 * 部分值，写上去反而把已有的 proxy 数字做小。proxy 那一腿一律用 summary 里现成的那份，
 * 合并**只增不减**。
 */
import { promises as fs } from 'node:fs';
import {
  collectClaudeSessionUsage,
  isPopulatedRunTokenUsage,
  mergeTokenUsageSummaries,
  type RunTokenUsageSummary,
} from '../telemetry';

export type CollectClaudeSessionUsage = typeof collectClaudeSessionUsage;

export type BilledTokenUsageMergeStatus =
  /** 合并后的数字更大，已写回。 */
  | 'merged'
  /** 没有新东西可加，文件未改动。 */
  | 'unchanged'
  /** driver 那一腿之前已经并过，跳过以免重复计数。 */
  | 'already_merged'
  /** summary 里缺 worktree_path，无从定位 session JSONL。 */
  | 'skipped_no_worktree'
  /** 刮取没刮到任何东西。 */
  | 'skipped_no_session_usage'
  /** 刮取本身抛了（session 目录不在、jsonl 正在被写、文件被占用）。 */
  | 'scrape_failed';

export interface BilledTokenUsageMergeResult {
  status: BilledTokenUsageMergeStatus;
  total_tokens_before: number;
  total_tokens_after: number;
}

/**
 * 读回 `summary.json`，把 Claude Code session JSONL 里的计费 token 并进 `token_usage`，
 * **并把这次的结果写回 `summary.json` 的 `driver_billed_merge` 块**。
 *
 * 为什么结果必须落盘：driver 侧计费是几条口径里最大的一条，而它能不能进账取决于
 * worktree 路径、`~/.claude` 下的 session 目录、jsonl 有没有写全——全是外部条件。在这之前
 * 「这次 run 没有 driver 腿」与「刮取被跳过/失败」在产物上**长得一模一样**：返回值被调用方
 * 丢掉（`run-terminal-output-writer.ts` 的 `finalize`），`summary.json` 里也没有任何痕迹。
 * 于是账面上少掉的那部分 token 无从审计，只剩一个「这个 run 没用量」的结论。现在每种结局
 * 都留一行状态。
 *
 * 幂等：driver 那一腿已经并过就直接跳过。`mergeTokenUsageSummaries` 是求和，收尾路径
 * 若被重入会把同一批 token 数两遍，所以不能只靠「结果不比现有大就不写」。
 *
 * `ENOENT`（summary 还没落盘）算 unchanged 而不是抛错，但结果里带状态，调用方能看出
 * 「没跑到」和「跑了但没数据」的区别。
 */
export async function mergeBilledTokenUsage(
  summaryPath: string,
  collect: CollectClaudeSessionUsage = collectClaudeSessionUsage,
): Promise<BilledTokenUsageMergeResult> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await fs.readFile(summaryPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // 连 summary 都读不到：这次的结果**没有地方可记**，所以这里不写盘。
    // 返回 unchanged 而不是抛——「没跑到」与「跑了没数据」的区别由这个返回值承载。
    return { status: 'unchanged', total_tokens_before: 0, total_tokens_after: 0 };
  }

  const existing = isPopulatedRunTokenUsage(raw.token_usage) ? raw.token_usage : undefined;
  const before = existing?.total_tokens ?? 0;
  const outcome = await resolveBilledMerge({ raw, existing, before, collect });
  // 状态与 token 数字**同一次写入**：分两次写会出现「数字更新了但状态还是旧的」那种半更新。
  raw.driver_billed_merge = outcome.result;
  if (outcome.merged) {
    raw.token_usage = outcome.merged;
    const driverBilled = buildDriverBilledUsage(outcome.merged, raw);
    if (driverBilled) raw.driver_billed_usage = driverBilled;
  }
  await fs.writeFile(summaryPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return outcome.result;
}

/**
 * 决定这次合并的结局；写盘交给调用方。
 *
 * 刮取的异常在这里被吞成 `scrape_failed` 状态而**不外抛**：这条路径跑在终态写盘上，而
 * 「Claude 的 session 目录读不到」是常态不是异常。观测失败只该少一块。
 */
async function resolveBilledMerge(input: {
  raw: Record<string, unknown>;
  existing: RunTokenUsageSummary | undefined;
  before: number;
  collect: CollectClaudeSessionUsage;
}): Promise<{ result: BilledTokenUsageMergeResult; merged?: RunTokenUsageSummary }> {
  const { raw, existing, before, collect } = input;
  const noChange = (status: BilledTokenUsageMergeStatus): BilledTokenUsageMergeResult => ({
    status,
    total_tokens_before: before,
    total_tokens_after: before,
  });

  // 幂等：driver 那一腿并过就不再并。`mergeTokenUsageSummaries` 是求和，收尾路径若重入，
  // 同一批 token 会被数两遍。
  if (existing?.sources.includes('claude_session_jsonl')) {
    return { result: noChange('already_merged') };
  }
  const worktreePath = nonEmptyString(raw.worktree_path);
  if (!worktreePath) return { result: noChange('skipped_no_worktree') };

  const sessionId = nonEmptyString(raw.session_id);
  const sessionIds = collectDriverSessionIds(raw, sessionId);
  let scraped: RunTokenUsageSummary;
  try {
    scraped = await collect({
      worktreePath,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionIds.length > 0 ? { sessionIds } : {}),
    });
  } catch {
    return { result: noChange('scrape_failed') };
  }
  const usable = scraped.call_count > 0 || scraped.total_tokens > 0;
  if (!usable) return { result: noChange('skipped_no_session_usage') };

  const merged = mergeTokenUsageSummaries(existing ? [existing, scraped] : [scraped]);
  if (merged.total_tokens <= before) return { result: noChange('unchanged') };
  return {
    result: {
      status: 'merged',
      total_tokens_before: before,
      total_tokens_after: merged.total_tokens,
    },
    merged,
  };
}

/**
 * summary 的 `driver_billed_usage` 块：driver 侧（真实 coding agent）的**实际计费消耗**。
 *
 * 与 `driver_context_usage` 是两种口径，刻意分开命名：那个是上下文占用快照
 * （`metric: context_tokens_used`，会话结束时上下文有多大），这个是真正烧掉的计费
 * 流量（input / output / cache_creation / cache_read 细分 + 调用数）。逐会话细分
 * 并上 `role_id` 与自报成本，让「每个角色 context 占多少、实际烧多少」并排可读。
 */
function buildDriverBilledUsage(
  merged: RunTokenUsageSummary,
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const sessions = Object.values(merged.by_session ?? {}).sort((left, right) =>
    left.session_id.localeCompare(right.session_id),
  );
  if (sessions.length === 0) return undefined;
  const contextBySession = readContextSessionsBySessionId(raw);
  const leg = merged.by_source.claude_session_jsonl;
  const totals = leg ??
    sessions.reduce(
      (sum, session) => ({
        input_tokens: sum.input_tokens + session.input_tokens,
        output_tokens: sum.output_tokens + session.output_tokens,
        cache_creation_input_tokens:
          sum.cache_creation_input_tokens + session.cache_creation_input_tokens,
        cache_read_input_tokens: sum.cache_read_input_tokens + session.cache_read_input_tokens,
        total_input_tokens: sum.total_input_tokens + session.total_input_tokens,
        total_tokens: sum.total_tokens + session.total_tokens,
        call_count: sum.call_count + session.call_count,
      }),
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        total_input_tokens: 0,
        total_tokens: 0,
        call_count: 0,
      },
    );
  return {
    source: 'claude_session_jsonl',
    metric: 'billed_tokens',
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cache_creation_input_tokens: totals.cache_creation_input_tokens,
    cache_read_input_tokens: totals.cache_read_input_tokens,
    total_input_tokens: totals.total_input_tokens,
    total_tokens: totals.total_tokens,
    call_count: totals.call_count,
    reported_costs: readContextReportedCosts(raw),
    sessions: sessions.map((session) => {
      const context = contextBySession.get(session.session_id);
      return {
        ...session,
        ...(context?.role_id ? { role_id: context.role_id } : {}),
        ...(context?.reported_cost ? { reported_cost: context.reported_cost } : {}),
      };
    }),
  };
}

function readContextSessionsBySessionId(
  raw: Record<string, unknown>,
): Map<string, { role_id?: string; reported_cost?: unknown }> {
  const result = new Map<string, { role_id?: string; reported_cost?: unknown }>();
  for (const session of readContextSessions(raw)) {
    const sessionId = nonEmptyString(session.session_id);
    if (!sessionId) continue;
    result.set(sessionId, {
      ...(nonEmptyString(session.role_id) ? { role_id: nonEmptyString(session.role_id)! } : {}),
      ...(session.reported_cost ? { reported_cost: session.reported_cost } : {}),
    });
  }
  return result;
}

function readContextReportedCosts(raw: Record<string, unknown>): unknown[] {
  const costs: unknown[] = [];
  for (const session of readContextSessions(raw)) {
    if (session.reported_cost) costs.push(session.reported_cost);
  }
  return costs;
}

function readContextSessions(raw: Record<string, unknown>): Array<{
  session_id?: unknown;
  role_id?: unknown;
  reported_cost?: unknown;
}> {
  const block = raw.driver_context_usage ?? raw.driver_usage;
  if (block && typeof block === 'object' && !Array.isArray(block)) {
    const sessions = (block as { sessions?: unknown }).sessions;
    if (Array.isArray(sessions)) return sessions as Array<{ session_id?: unknown }>;
  }
  return [];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * 这个 run 跑过的全部 driver 会话 id，主会话在前。
 *
 * `mergeSummaryExtras` 已经把 `driver_context_usage` 写进 summary 了，council 的每个角色各占
 * 一条 session——只刮 `session_id` 那一个会漏掉其余角色的全部用量。实测一次四角色
 * council run：summary 只留得下 primary 一个 id，另外三个会话的 token 全在漏。
 */
function collectDriverSessionIds(raw: Record<string, unknown>, primary?: string): string[] {
  const ids: string[] = [];
  const push = (candidate: unknown): void => {
    const id = nonEmptyString(candidate);
    if (id && !ids.includes(id)) ids.push(id);
  };
  push(primary);
  const driverUsage = raw.driver_context_usage ?? raw.driver_usage;
  if (driverUsage && typeof driverUsage === 'object' && !Array.isArray(driverUsage)) {
    const sessions = (driverUsage as { sessions?: unknown }).sessions;
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        push(
          session && typeof session === 'object'
            ? (session as { session_id?: unknown }).session_id
            : undefined,
        );
      }
    }
  }
  return ids;
}
