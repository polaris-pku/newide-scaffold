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
  | 'skipped_no_session_usage';

export interface BilledTokenUsageMergeResult {
  status: BilledTokenUsageMergeStatus;
  total_tokens_before: number;
  total_tokens_after: number;
}

/**
 * 读回 `summary.json`，把 Claude Code session JSONL 里的计费 token 并进 `token_usage`。
 *
 * 幂等：合并结果不比现有大就不写文件。`ENOENT`（summary 还没落盘）直接算 unchanged，
 * 由调用方决定要不要重试——但不要像旧实现那样静默 `return`，那会让「没跑到」和
 * 「跑了但没数据」在产物里长得一样。
 */
export async function mergeBilledTokenUsage(
  summaryPath: string,
  collect: CollectClaudeSessionUsage = collectClaudeSessionUsage,
): Promise<BilledTokenUsageMergeResult> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await fs.readFile(summaryPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return { status: 'unchanged', total_tokens_before: 0, total_tokens_after: 0 };
  }

  const existing = isPopulatedRunTokenUsage(raw.token_usage) ? raw.token_usage : undefined;
  const before = existing?.total_tokens ?? 0;
  // 幂等：driver 那一腿并过就不再并。`mergeTokenUsageSummaries` 是求和，收尾路径若被
  // 重入，同一批 token 会被数两遍。
  if (existing?.sources.includes('claude_session_jsonl')) {
    return { status: 'already_merged', total_tokens_before: before, total_tokens_after: before };
  }
  const worktreePath = nonEmptyString(raw.worktree_path);
  if (!worktreePath) {
    return { status: 'skipped_no_worktree', total_tokens_before: before, total_tokens_after: before };
  }

  const sessionId = nonEmptyString(raw.session_id);
  const scraped = await collect({
    worktreePath,
    ...(sessionId ? { sessionId } : {}),
  });
  const usable = scraped.call_count > 0 || scraped.total_tokens > 0;
  if (!usable) {
    return {
      status: 'skipped_no_session_usage',
      total_tokens_before: before,
      total_tokens_after: before,
    };
  }

  const merged = mergeTokenUsageSummaries(existing ? [existing, scraped] : [scraped]);
  if (merged.total_tokens <= before) {
    return { status: 'unchanged', total_tokens_before: before, total_tokens_after: before };
  }

  raw.token_usage = merged;
  await fs.writeFile(summaryPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return { status: 'merged', total_tokens_before: before, total_tokens_after: merged.total_tokens };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
