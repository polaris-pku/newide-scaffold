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

async function sumUsageFromClaudeJsonl(
  filePath: string,
  expectedSessionId?: string,
): Promise<{ entries: LlmUsageEntry[]; session_id?: string }> {
  const text = await fs.readFile(filePath, 'utf-8');
  /**
   * 按 assistant 消息去重。
   *
   * Claude Code 会把同一条 assistant 消息写成多行（实测两行：同一个 `message.id`、
   * 不同 `uuid`、usage 数值完全相同），逐行累加会把这一轮 token 数两遍。实测一次
   * 真实 run 的 primary session：逐行求和 input=47152，按 messageId 去重后 23576，
   * 而 ACP 响应自己报的是 23576——正好两倍。
   *
   * 键用 `message.id`（同一条 API 消息的唯一标识，`uuid` 在两行里是不同的，去不了重）。
   * 同键后写覆盖先写，保留首次出现的位置，所以顺序仍按时间。
   */
  const byMessageId = new Map<string, LlmUsageEntry>();
  let matchedSessionId = expectedSessionId;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: {
      type?: string;
      uuid?: string;
      sessionId?: string;
      message?: { id?: string; usage?: Record<string, unknown> };
      usage?: Record<string, unknown>;
    };
    try {
      obj = JSON.parse(line) as typeof obj;
    } catch {
      continue;
    }
    if (expectedSessionId && obj.sessionId && obj.sessionId !== expectedSessionId) continue;
    if (obj.sessionId) matchedSessionId = obj.sessionId;
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

    const messageId = obj.message?.id;
    // 没有 message.id 的记录（顶层 usage 那种形状）用行 uuid 兜底；两样都没有就按
    // 行号各自成键，宁可不去重也不能把两轮不同的调用合成一轮。
    const key =
      typeof messageId === 'string' && messageId.length > 0
        ? `message:${messageId}`
        : `line:${obj.uuid ?? byMessageId.size}`;
    byMessageId.set(key, {
      input_tokens: nextInput,
      output_tokens: nextOutput,
      cache_creation_input_tokens: nextCacheCreation,
      cache_read_input_tokens: nextCacheRead,
      model: 'claude-code',
      source: 'claude_session_jsonl',
      recorded_at: new Date().toISOString(),
    });
  }

  return {
    entries: [...byMessageId.values()],
    ...(matchedSessionId ? { session_id: matchedSessionId } : {}),
  };
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

export async function collectClaudeSessionUsage(input: {
  sessionId?: string;
  /**
   * 一个 run 可能跑过多个 driver 会话——council 每个角色一个，summary 里只留得下
   * 一个 `session_id`。只刮那一个会漏掉其余角色的全部用量，所以调用方要把
   * `driver_usage.sessions` 里的 id 都传进来。
   */
  sessionIds?: readonly string[];
  worktreePath: string;
}): Promise<RunTokenUsageSummary> {
  const homes = claudeHomeCandidates();
  const claudeRoots = homes
    .map((home) => resolveClaudeRoot(home))
    .filter((claudeRoot, index, all) => existsSync(claudeRoot) && all.indexOf(claudeRoot) === index);
  if (claudeRoots.length === 0) {
    return emptyTokenUsageSummary(withKnownSessionId(input));
  }

  const sessionIds = distinctSessionIds([...(input.sessionIds ?? []), input.sessionId]);
  const projectDirs = claudeRoots.flatMap((claudeRoot) =>
    encodeClaudeProjectDirCandidates(input.worktreePath).map((encoded) =>
      path.join(claudeRoot, 'projects', encoded),
    ),
  );

  const candidates: string[] = [];
  if (sessionIds.length > 0) {
    for (const claudeRoot of claudeRoots) {
      for (const sessionId of sessionIds) {
        candidates.push(...(await findSessionJsonl(claudeRoot, sessionId)));
        candidates.push(path.join(claudeRoot, 'sessions', `${sessionId}.json`));
      }
    }
    for (const projectDir of projectDirs) {
      for (const sessionId of sessionIds) {
        candidates.push(path.join(projectDir, `${sessionId}.jsonl`));
      }
    }
  } else {
    // 没有明确的 session id 时，退回「工作目录对应的 project 目录里最近的三份」。
    // 只在没有 id 时用：有 id 还扫目录会把同目录下别的会话也算进来。
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
        for (const entry of ranked.slice(0, 3)) candidates.push(entry.filePath);
      } catch {
        // ignore listing failures
      }
    }
  }

  // 同一份文件可能被多条候选路径指到（按 id 全盘找一次、再按工作目录拼一次），
  // 必须按绝对路径去重，否则同一个会话会被数两遍。
  const seenPaths = new Set<string>();
  const entries: LlmUsageEntry[] = [];
  const contributingPaths: string[] = [];
  const contributingSessionIds = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seenPaths.has(resolved) || !candidate.endsWith('.jsonl')) continue;
    seenPaths.add(resolved);
    if (!existsSync(candidate)) continue;
    const baseName = path.basename(candidate, '.jsonl');
    try {
      const usage = await sumUsageFromClaudeJsonl(
        candidate,
        sessionIds.includes(baseName) ? baseName : undefined,
      );
      if (usage.entries.length === 0) continue;
      entries.push(...usage.entries);
      contributingPaths.push(candidate);
      contributingSessionIds.add(usage.session_id ?? baseName);
    } catch {
      // try next candidate
    }
  }

  if (entries.length === 0) return emptyTokenUsageSummary(withKnownSessionId(input));
  return toRunTokenUsageSummary(entries, {
    // 多会话时这两个字段没有单一取值，留空而不是随便挑一个，免得被当成「这个 run
    // 的 session」读。
    ...(contributingPaths.length === 1 ? { session_path: contributingPaths[0]! } : {}),
    ...(contributingSessionIds.size === 1
      ? { session_id: [...contributingSessionIds][0]! }
      : {}),
  });
}

function distinctSessionIds(candidates: readonly (string | undefined)[]): string[] {
  const ids: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    if (!ids.includes(candidate)) ids.push(candidate);
  }
  return ids;
}

function withKnownSessionId(input: { sessionId?: string }): { session_id?: string } {
  return input.sessionId ? { session_id: input.sessionId } : {};
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
