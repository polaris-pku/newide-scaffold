/**
 * Best-effort Claude Code session token scrape for ACP/driver runs.
 * Used when the driver does not go through LiteLLM proxy.
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  emptyTokenUsageSummary,
  type LlmUsageEntry,
  type RunTokenUsageSummary,
  toRunTokenUsageSummary,
} from './llm-usage-ledger';

function encodeClaudeProjectDirCandidates(worktreePath: string): string[] {
  const resolved = path.resolve(worktreePath);
  const claudeStyle = resolved.replace(/[^a-zA-Z0-9]/g, '-');
  const legacy = resolved.replaceAll(':', '').replaceAll('\\', '-').replaceAll('/', '-');
  return [...new Set([claudeStyle, legacy])];
}

/**
 * 把会话 jsonl 的**文本**解析成计费条目。纯函数——不碰文件系统，因此可以离线重算、
 * 可以用真实样本单测过滤规则。历史上这段逻辑埋在 `await fs.readFile` 之后，导致
 * 「79 条真实计费 vs 159 条流式分片」这个判据无法脱离磁盘验证。
 *
 * Rows are returned in file order, which is chronological: Claude Code appends one
 * record per inference.
 *
 * **Streaming fragments are dropped.** Claude Code writes one `assistant` row per
 * content block (a `thinking` block, a `tool_use` block, ...), and those carry an
 * all-zero `usage` with a **null `stop_reason`**; only the row that closes the turn
 * (`end_turn` / `tool_use` / ...) carries the real numbers. Measured on a real run:
 * 238 usage-bearing rows, of which 79 were billed and 159 were zero fragments.
 * Counting fragments would inflate the call count ~3x and shrink the cache-hit
 * denominator, i.e. it would make the experiment look cheaper than it was.
 */
export function parseClaudeSessionUsageText(input: {
  text: string;
  sessionId?: string;
  since?: string;
  until?: string;
}): { entries: LlmUsageEntry[]; skipped_fragment_rows: number; session_id?: string } {
  const entries: LlmUsageEntry[] = [];
  let skippedFragmentRows = 0;
  let matchedSessionId = input.sessionId;
  const sinceMs = input.since ? Date.parse(input.since) : undefined;
  const untilMs = input.until ? Date.parse(input.until) : undefined;

  for (const line of input.text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: {
      type?: string;
      sessionId?: string;
      timestamp?: string;
      message?: {
        usage?: Record<string, unknown>;
        model?: string;
        stop_reason?: string | null;
      };
      usage?: Record<string, unknown>;
    };
    try {
      obj = JSON.parse(line) as typeof obj;
    } catch {
      continue;
    }
    if (input.sessionId && obj.sessionId && obj.sessionId !== input.sessionId) continue;
    if (obj.sessionId) matchedSessionId = obj.sessionId;

    // Run-window filter. A reused `driver-repos`/workspace keeps appending to the same
    // logical session file, so without this a later run inherits the earlier run's
    // tokens as if it had spent them.
    const rowMs = obj.timestamp ? Date.parse(obj.timestamp) : undefined;
    if (sinceMs !== undefined && rowMs !== undefined && rowMs < sinceMs) continue;
    if (untilMs !== undefined && rowMs !== undefined && rowMs > untilMs) continue;

    const usage = obj.message?.usage ?? obj.usage;
    if (!usage || typeof usage !== 'object') continue;
    if (obj.type !== 'assistant' && !obj.message?.usage) continue;

    const nextInput = Number(usage.input_tokens ?? 0);
    const nextOutput = Number(usage.output_tokens ?? 0);
    const nextCacheCreation = Number(usage.cache_creation_input_tokens ?? 0);
    const nextCacheRead = Number(usage.cache_read_input_tokens ?? 0);
    if (![nextInput, nextOutput, nextCacheCreation, nextCacheRead].every(Number.isFinite)) {
      continue;
    }

    // `stop_reason` 是「这条是不是一次真正的推理」的判据。null = 流式分片，丢弃。
    // 没有这个字段的旧记录退回「至少有一个非零计数」的判断。
    const stopReason = obj.message?.stop_reason;
    const hasCounts =
      nextInput > 0 || nextOutput > 0 || nextCacheCreation > 0 || nextCacheRead > 0;
    if (stopReason === null || stopReason === undefined ? !hasCounts : false) {
      skippedFragmentRows++;
      continue;
    }

    entries.push({
      input_tokens: nextInput,
      output_tokens: nextOutput,
      cache_creation_input_tokens: nextCacheCreation,
      cache_read_input_tokens: nextCacheRead,
      // 真实模型名在这里（driver 走的是桥接网关，不是 Anthropic 官方），
      // 读不到才退回 'claude-code'。
      ...(obj.message?.model ? { model: obj.message.model } : { model: 'claude-code' }),
      source: 'claude_session_jsonl',
      recorded_at: obj.timestamp ?? new Date().toISOString(),
    });
  }

  return {
    entries,
    skipped_fragment_rows: skippedFragmentRows,
    ...(matchedSessionId ? { session_id: matchedSessionId } : {}),
  };
}

/** 读文件并解析；解析规则见 `parseClaudeSessionUsageText`。 */
export async function readClaudeSessionUsageEntries(input: {
  filePath: string;
  sessionId?: string;
  since?: string;
  until?: string;
}): Promise<{ entries: LlmUsageEntry[]; skipped_fragment_rows: number; session_id?: string }> {
  const text = await fs.readFile(input.filePath, 'utf-8');
  return parseClaudeSessionUsageText({
    text,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.since ? { since: input.since } : {}),
    ...(input.until ? { until: input.until } : {}),
  });
}

function resolveClaudeRoot(home: string): string {
  if (path.basename(home) === '.claude') return home;
  return path.join(home, '.claude');
}

function claudeHomeCandidates(): string[] {
  const homes = [
    process.env.ACP_PROCESS_SANDBOX_HOME,
    process.env.CLAUDE_HOME,
    process.env.USERPROFILE,
    process.env.HOME,
  ].filter((home): home is string => typeof home === 'string' && home.length > 0);
  return [...new Set(homes.map((home) => path.resolve(home)))];
}

async function findSessionJsonl(claudeRoot: string, sessionId: string): Promise<string[]> {
  const projectsRoot = path.join(claudeRoot, 'projects');
  if (!existsSync(projectsRoot)) return [];
  try {
    const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectsRoot, entry.name, `${sessionId}.jsonl`))
      .filter((filePath) => existsSync(filePath));
  } catch {
    return [];
  }
}

/** All candidate session files for one worktree, most-likely first. */
export async function resolveClaudeSessionJsonlPaths(input: {
  sessionId?: string;
  worktreePath: string;
}): Promise<string[]> {
  const homes = claudeHomeCandidates();
  const claudeRoots = homes
    .map((home) => resolveClaudeRoot(home))
    .filter((claudeRoot, index, all) => existsSync(claudeRoot) && all.indexOf(claudeRoot) === index);
  if (claudeRoots.length === 0) return [];

  const projectDirs = claudeRoots.flatMap((claudeRoot) =>
    encodeClaudeProjectDirCandidates(input.worktreePath).map((encoded) =>
      path.join(claudeRoot, 'projects', encoded),
    ),
  );
  const candidates: string[] = [];
  if (input.sessionId) {
    for (const claudeRoot of claudeRoots) {
      candidates.push(...(await findSessionJsonl(claudeRoot, input.sessionId)));
      candidates.push(path.join(claudeRoot, 'sessions', `${input.sessionId}.json`));
    }
    for (const projectDir of projectDirs) {
      candidates.push(path.join(projectDir, `${input.sessionId}.jsonl`));
    }
  }

  for (const projectDir of projectDirs) {
    if (!existsSync(projectDir)) continue;
    try {
      const files = (await fs.readdir(projectDir))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => path.join(projectDir, name));
      const ranked = await Promise.all(
        files.map(async (filePath) => ({
          filePath,
          mtimeMs: (await fs.stat(filePath)).mtimeMs,
        })),
      );
      ranked.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const entry of ranked.slice(0, 3)) {
        if (!candidates.includes(entry.filePath)) candidates.push(entry.filePath);
      }
    } catch {
      // ignore listing failures
    }
  }

  // 去重：`findSessionJsonl` 与 project 目录两条路会算出同一个文件，重复项只会让
  // 调用方把一个文件读两遍。同一个会话文件被读两次会把同一批 token 记两次。
  return [...new Set(candidates.filter((candidate) => candidate.endsWith('.jsonl')))];
}

export async function collectClaudeSessionUsage(input: {
  sessionId?: string;
  worktreePath: string;
}): Promise<RunTokenUsageSummary> {
  const candidates = await resolveClaudeSessionJsonlPaths(input);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const usage = await readClaudeSessionUsageEntries({
        filePath: candidate,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
      if (usage.entries.length > 0) {
        return toRunTokenUsageSummary(usage.entries, {
          session_path: candidate,
          ...(usage.session_id ? { session_id: usage.session_id } : {}),
        });
      }
    } catch {
      // try next candidate
    }
  }

  return emptyTokenUsageSummary({
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
  });
}

export function mergeTokenUsageSummaries(
  parts: readonly RunTokenUsageSummary[],
): RunTokenUsageSummary {
  const usable = parts.filter((part) => part.call_count > 0 || part.total_tokens > 0);
  if (usable.length === 0) {
    const sessionId = parts[0]?.session_id;
    return emptyTokenUsageSummary(sessionId ? { session_id: sessionId } : {});
  }

  const by_source: RunTokenUsageSummary['by_source'] = {};
  for (const part of usable) {
    for (const source of part.sources.length > 0 ? part.sources : [part.source]) {
      if (source !== 'proxy' && source !== 'claude_session_jsonl') continue;
      const slice = part.by_source[source] ?? {
        input_tokens: part.input_tokens,
        output_tokens: part.output_tokens,
        cache_creation_input_tokens: part.cache_creation_input_tokens,
        cache_read_input_tokens: part.cache_read_input_tokens,
        total_input_tokens: part.total_input_tokens,
        total_tokens: part.total_tokens,
        call_count: part.call_count,
      };
      const prev = by_source[source];
      by_source[source] = prev
        ? {
            input_tokens: prev.input_tokens + slice.input_tokens,
            output_tokens: prev.output_tokens + slice.output_tokens,
            cache_creation_input_tokens:
              prev.cache_creation_input_tokens + slice.cache_creation_input_tokens,
            cache_read_input_tokens: prev.cache_read_input_tokens + slice.cache_read_input_tokens,
            total_input_tokens: prev.total_input_tokens + slice.total_input_tokens,
            total_tokens: prev.total_tokens + slice.total_tokens,
            call_count: prev.call_count + slice.call_count,
          }
        : { ...slice };
    }
  }

  const sources = (Object.keys(by_source) as Array<keyof typeof by_source>).filter(
    (key): key is 'proxy' | 'claude_session_jsonl' => by_source[key] !== undefined,
  );
  sources.sort();
  const input_tokens = sources.reduce((sum, key) => sum + (by_source[key]?.input_tokens ?? 0), 0);
  const output_tokens = sources.reduce((sum, key) => sum + (by_source[key]?.output_tokens ?? 0), 0);
  const cache_creation_input_tokens = sources.reduce(
    (sum, key) => sum + (by_source[key]?.cache_creation_input_tokens ?? 0),
    0,
  );
  const cache_read_input_tokens = sources.reduce(
    (sum, key) => sum + (by_source[key]?.cache_read_input_tokens ?? 0),
    0,
  );
  const total_input_tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens;
  const session = usable.find((part) => part.session_id);
  const sessionPath = usable.find((part) => part.session_path);

  return {
    schema_version: 'newide.token_usage.v1',
    source: sources.length === 1 ? (sources[0] ?? 'unavailable') : 'mixed',
    input_tokens,
    output_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens,
    total_input_tokens,
    total_tokens: total_input_tokens + output_tokens,
    call_count: usable.reduce((sum, part) => sum + part.call_count, 0),
    sources,
    by_source,
    ...(session?.session_id ? { session_id: session.session_id } : {}),
    ...(sessionPath?.session_path ? { session_path: sessionPath.session_path } : {}),
  };
}
