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
  const entries: LlmUsageEntry[] = [];
  let matchedSessionId = expectedSessionId;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: {
      type?: string;
      sessionId?: string;
      message?: { usage?: Record<string, unknown> };
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
    entries.push({
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
    entries,
    ...(matchedSessionId ? { session_id: matchedSessionId } : {}),
  };
}

export async function collectClaudeSessionUsage(input: {
  sessionId?: string;
  worktreePath: string;
}): Promise<RunTokenUsageSummary> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const claudeRoot = home ? path.join(home, '.claude') : '';
  if (!claudeRoot || !existsSync(claudeRoot)) {
    return emptyTokenUsageSummary({
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
    });
  }

  const projectDirs = encodeClaudeProjectDirCandidates(input.worktreePath).map((encoded) =>
    path.join(claudeRoot, 'projects', encoded),
  );
  const candidates: string[] = [];
  if (input.sessionId) {
    for (const projectDir of projectDirs) {
      candidates.push(path.join(projectDir, `${input.sessionId}.jsonl`));
    }
    candidates.push(path.join(claudeRoot, 'sessions', `${input.sessionId}.json`));
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

  for (const candidate of candidates) {
    if (!existsSync(candidate) || !candidate.endsWith('.jsonl')) continue;
    try {
      const usage = await sumUsageFromClaudeJsonl(candidate, input.sessionId);
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
