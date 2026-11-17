/**
 * Best-effort Codex CLI session token scrape for ACP/driver runs.
 *
 * Codex writes one rollout JSONL per session under
 * `<CODEX_HOME>/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<sessionId>.jsonl`.
 * The first line is `session_meta` (session id + cwd); every `token_count` event
 * carries a **cumulative** `total_token_usage`, so the last such line is the
 * session total — summing lines would multiply the bill.
 *
 * The claude-demo counterpart lives in `collect-claude-session-usage.ts`; this
 * collector produces the same `RunTokenUsageSummary` shape with source
 * `codex_jsonl`, so the billed-usage merge can treat both drivers uniformly.
 *
 * Mapping into the Claude-style ledger fields:
 * - `input_tokens` = codex `input_tokens` − `cached_input_tokens` (uncached only,
 *   matching Claude's `usage.input_tokens` semantics);
 * - `cache_read_input_tokens` = `cached_input_tokens`;
 * - `cache_creation_input_tokens` = 0 (Codex has no separate cache-write count);
 * - `output_tokens` = codex `output_tokens` (reasoning tokens are included —
 *   codex reports `total_tokens = input_tokens + output_tokens`).
 *
 * Selection is strict: by the run's session id(s) when known, otherwise by the
 * session's recorded `cwd` matching the run worktree. A run without a matching
 * rollout yields an empty summary, so Claude runs are unaffected.
 */
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  emptyTokenUsageSummary,
  toRunTokenUsageSummary,
  type LlmUsageEntry,
  type RunTokenUsageSummary,
  type SessionBilledUsage,
} from './llm-usage-ledger';

interface CodexTotalUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

interface CodexRolloutUsage {
  totals?: CodexTotalUsage;
  sessionId?: string;
  cwd?: string;
}

function codexHomeCandidates(): string[] {
  const roots: string[] = [];
  // CODEX_HOME 本身就是 codex home 根目录；只有用户主目录才需要再拼 `.codex`。
  const explicit = process.env.CODEX_HOME;
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    roots.push(path.resolve(explicit));
  }
  for (const home of [process.env.USERPROFILE, process.env.HOME]) {
    if (typeof home === 'string' && home.trim().length > 0) {
      roots.push(path.join(path.resolve(home), '.codex'));
    }
  }
  return [...new Set(roots)];
}

/** `<root>/sessions/**` 下的 `*.jsonl`，最多向下走 4 层（yyyy/mm/dd）。 */
async function listRolloutFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRolloutFiles(full, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
  return files;
}

/** 一次读完 rollout：session_meta 给 id/cwd，最后的 token_count 给累计用量。 */
async function readRollout(filePath: string): Promise<CodexRolloutUsage> {
  const text = await fs.readFile(filePath, 'utf-8');
  const result: CodexRolloutUsage = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: {
      type?: string;
      payload?: {
        type?: string;
        id?: string;
        cwd?: string;
        info?: { total_token_usage?: Record<string, unknown> };
      };
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type === 'session_meta') {
      if (typeof event.payload?.id === 'string') result.sessionId = event.payload.id;
      if (typeof event.payload?.cwd === 'string') result.cwd = event.payload.cwd;
      continue;
    }
    const usage = event.payload?.info?.total_token_usage;
    if (event.type !== 'event_msg' || event.payload?.type !== 'token_count' || !usage) continue;
    const input = Number(usage.input_tokens ?? 0);
    const cached = Number(usage.cached_input_tokens ?? 0);
    const output = Number(usage.output_tokens ?? 0);
    const total = Number(usage.total_tokens ?? 0);
    if (![input, cached, output, total].every(Number.isFinite)) continue;
    // 累计值：后写覆盖先写；同一会话的多份 rollout 由调用方按 total 取最大。
    result.totals = {
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      total_tokens: total,
    };
  }
  return result;
}

/** 只读首行取 `cwd`（没有会话 id 时按工作目录匹配，不必整份解析）。 */
async function readRolloutCwd(filePath: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString('utf-8').split(/\r?\n/, 1)[0];
    const event = JSON.parse(firstLine ?? '') as { payload?: { cwd?: unknown } };
    return typeof event.payload?.cwd === 'string' ? event.payload.cwd : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function rolloutSessionId(filePath: string): string | undefined {
  // rollout-<iso-timestamp>-<sessionId>.jsonl
  const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    path.basename(filePath),
  );
  return match?.[1];
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function toEntry(totals: CodexTotalUsage): LlmUsageEntry {
  const cached = Math.max(0, Math.min(totals.cached_input_tokens, totals.input_tokens));
  return {
    // Claude 的 `input_tokens` 不含缓存读；Codex 的含，这里拆开对齐。
    input_tokens: Math.max(0, totals.input_tokens - cached),
    output_tokens: totals.output_tokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    model: 'codex-cli',
    source: 'codex_jsonl',
    recorded_at: new Date().toISOString(),
  };
}

function addSessionBilledUsage(
  previous: SessionBilledUsage | undefined,
  sessionId: string,
  entry: LlmUsageEntry,
): SessionBilledUsage {
  const next: SessionBilledUsage = previous ?? {
    session_id: sessionId,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: 0,
    total_tokens: 0,
    call_count: 0,
  };
  next.input_tokens += entry.input_tokens;
  next.output_tokens += entry.output_tokens;
  next.cache_creation_input_tokens += entry.cache_creation_input_tokens ?? 0;
  next.cache_read_input_tokens += entry.cache_read_input_tokens ?? 0;
  next.call_count += 1;
  next.total_input_tokens =
    next.input_tokens + next.cache_creation_input_tokens + next.cache_read_input_tokens;
  next.total_tokens = next.total_input_tokens + next.output_tokens;
  return next;
}

export async function collectCodexSessionUsage(input: {
  sessionId?: string;
  sessionIds?: readonly string[];
  worktreePath: string;
}): Promise<RunTokenUsageSummary> {
  const wantedIds = [
    ...new Set(
      [input.sessionId, ...(input.sessionIds ?? [])].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];

  const files = (
    await Promise.all(codexHomeCandidates().map((root) => listRolloutFiles(path.join(root, 'sessions'))))
  ).flat();
  if (files.length === 0) {
    return emptyTokenUsageSummary(input.sessionId ? { session_id: input.sessionId } : {});
  }

  const perSession = new Map<string, CodexTotalUsage>();
  const sessionPaths: string[] = [];
  // 有会话 id 时先按文件名后缀过滤（rollout 文件名以会话 id 结尾），避免为了匹配
  // 去读别的 run 的整份会话；没有 id 时才按 session_meta 的 cwd 匹配工作区。
  const candidates =
    wantedIds.length > 0
      ? files.filter((file) => {
          const name = path.basename(file);
          return wantedIds.some((id) => name.endsWith(`-${id}.jsonl`));
        })
      : files;
  for (const filePath of candidates) {
    if (wantedIds.length === 0) {
      const cwd = await readRolloutCwd(filePath);
      if (cwd === undefined || !samePath(cwd, input.worktreePath)) continue;
    }
    let usage: CodexRolloutUsage;
    try {
      usage = await readRollout(filePath);
    } catch {
      continue;
    }
    if (usage.totals === undefined) continue;
    const sessionId = usage.sessionId ?? rolloutSessionId(filePath);
    if (sessionId === undefined) continue;
    if (wantedIds.length > 0 && !wantedIds.includes(sessionId)) continue;

    // 同一会话可能有多份 rollout（resume 会重写累计值）：保留 total 最大的那份，
    // 求和会把同一批 token 数两遍。
    const previous = perSession.get(sessionId);
    if (previous === undefined || usage.totals.total_tokens > previous.total_tokens) {
      perSession.set(sessionId, usage.totals);
      if (!sessionPaths.includes(filePath)) sessionPaths.push(filePath);
    }
  }

  if (perSession.size === 0) {
    return emptyTokenUsageSummary(input.sessionId ? { session_id: input.sessionId } : {});
  }

  const entries: LlmUsageEntry[] = [];
  const bySession = new Map<string, SessionBilledUsage>();
  for (const [sessionId, totals] of perSession) {
    const entry = toEntry(totals);
    entries.push(entry);
    bySession.set(sessionId, addSessionBilledUsage(undefined, sessionId, entry));
  }

  return {
    ...toRunTokenUsageSummary(entries, {
      ...(sessionPaths.length === 1 ? { session_path: sessionPaths[0] } : {}),
      ...(perSession.size === 1 ? { session_id: [...perSession.keys()][0] } : {}),
    }),
    by_session: Object.fromEntries(
      [...bySession.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export type CollectCodexSessionUsage = typeof collectCodexSessionUsage;
