/**
 * driver-usage — driver（Claude Code）的**真实计费**台账
 *
 * 为什么需要这个文件：`driver-stream.jsonl` 里的 `usage_update` 只有
 * `{size, used}` 两个数（上下文窗口占用），**没有缓存、没有输入/输出拆分**，所以
 * 「花了多少、缓存命中多少」在这条链路上完全不可见。
 *
 * 真实计费记录在 Claude Code 自己的 session jsonl 里（`~/.claude/projects/<编码工作区>/<sessionId>.jsonl`），
 * 每次推理一行，带 `input_tokens` / `output_tokens` /
 * `cache_creation_input_tokens` / `cache_read_input_tokens`。这才是唯一能回答
 * 「缓存命中率」的地方——实测第一次跑出 238 次推理、缓存读写全是 0，即**零命中**。
 *
 * 两个必须做对的过滤：
 *   1. 按 session_id 过滤。driver-stream 里的 `sessionId` 才是这一格的会话；
 *      project 目录里可能同时躺着同一工作区更早几次跑的会话文件。
 *   2. 按 run 时间窗过滤。`driver-repos` 与工作区会被复用，同一个会话文件持续追加，
 *      不做时间窗过滤会把上一轮的开销算进这一轮。
 *
 * 口径说明（写进证据，避免事后误读）：
 *   - `uncached_input_tokens` 是**全价**部分。
 *   - `cache_creation_input_tokens` 按 1.25x 计价，`cache_read_input_tokens` 按 0.1x。
 *   - `effective_input_tokens` 是加权后的「等价全价 token」，用它与
 *     `naive_input_tokens`（全部按全价算）比较，就是缓存带来的实际节省。
 */
import {
  readClaudeSessionUsageEntries,
  resolveClaudeSessionJsonlPaths,
} from '../../src/telemetry';

/** Anthropic 口径的缓存倍率；写进台账，便于事后换算。 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** 一次推理的原始计费行 */
export interface DriverCallRecord {
  index: number;
  timestamp?: string;
  model?: string;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  /** input + cache_creation + cache_read，即计费意义上的输入总量 */
  billed_input_tokens: number;
  /** 该次调用结束时的累计计费输入量，用来画成本曲线 */
  cumulative_billed_input_tokens: number;
  /** 命中率 = cache_read / billed_input */
  cache_read_ratio: number;
}

export interface DriverTokenEvidence {
  schema_version: 'newide.driver_token_usage.v1';
  /** 这一格真实发生了几次推理 */
  call_count: number;
  /** 加权后的等价全价输入量（缓存读 0.1x、缓存写 1.25x） */
  effective_input_tokens: number;
  /** 若完全不走缓存，同样这些请求要花多少全价输入量 */
  naive_input_tokens: number;
  /** naive - effective：缓存的实际节省（全价 token 当量） */
  cache_saved_input_tokens: number;
  /** 若这些输入全部命中缓存（读 0.1x，忽略写入成本）会是多少 */
  ideal_cache_input_tokens: number;
  cache_read_ratio: number;
  cache_creation_ratio: number;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  billed_input_tokens: number;
  total_tokens: number;
  /** 峰值单次调用输入量（≈ 峰值上下文） */
  max_call_input_tokens: number;
  first_call_input_tokens: number;
  last_call_input_tokens: number;
  models: string[];
  session_ids: string[];
  /** 命中的会话文件绝对路径；为空说明轨迹解析到了 sessionId 但找不到文件 */
  session_files: string[];
  /**
   * 被丢弃的流式分片行数。留着它，是为了让「238 行 usage 却只算 79 次调用」这件事
   * 在证据里自证，而不是让事后读数据的人以为是取数丢失。
   */
  skipped_fragment_rows: number;
  /** `recorded_at` 口径的时间跨度 */
  first_recorded_at?: string;
  last_recorded_at?: string;
  /** 无法取数时的显式原因，不静默失败 */
  unavailable_reason?: string;
  calls: DriverCallRecord[];
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

export function emptyDriverTokenEvidence(reason: string): DriverTokenEvidence {
  return {
    schema_version: 'newide.driver_token_usage.v1',
    call_count: 0,
    effective_input_tokens: 0,
    naive_input_tokens: 0,
    cache_saved_input_tokens: 0,
    ideal_cache_input_tokens: 0,
    cache_read_ratio: 0,
    cache_creation_ratio: 0,
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    billed_input_tokens: 0,
    total_tokens: 0,
    max_call_input_tokens: 0,
    first_call_input_tokens: 0,
    last_call_input_tokens: 0,
    models: [],
    session_ids: [],
    session_files: [],
    skipped_fragment_rows: 0,
    unavailable_reason: reason,
    calls: [],
  };
}

/**
 * 把原始计费行折成证据。纯函数——文件解析与聚合分离，聚合可以离线单测/重算。
 *
 * 会丢掉「全零」行作为兜底（正常链路里流式分片已在解析层按 `stop_reason: null` 剔除，
 * 见 `readClaudeSessionUsageEntries`）。无条件保留全零行会虚报 `call_count`，并把
 * 命中率的分母做小——那正是最该看清的那个数。
 */
export function summarizeDriverTokenUsage(input: {
  rows: readonly {
    input_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens: number;
    recorded_at: string;
    model?: string;
  }[];
  sessionIds?: readonly string[];
  sessionFiles?: readonly string[];
  skippedFragmentRows?: number;
}): DriverTokenEvidence {
  const usable = input.rows.filter(
    (row) =>
      row.input_tokens > 0 ||
      (row.cache_creation_input_tokens ?? 0) > 0 ||
      (row.cache_read_input_tokens ?? 0) > 0 ||
      row.output_tokens > 0,
  );
  if (usable.length === 0) return emptyDriverTokenEvidence('no billed usage rows found');

  const calls: DriverCallRecord[] = [];
  let cumulative = 0;
  let inputTotal = 0;
  let creationTotal = 0;
  let readTotal = 0;
  let outputTotal = 0;
  const models = new Set<string>();

  usable.forEach((row, position) => {
    const creation = row.cache_creation_input_tokens ?? 0;
    const read = row.cache_read_input_tokens ?? 0;
    const billed = row.input_tokens + creation + read;
    cumulative += billed;
    inputTotal += row.input_tokens;
    creationTotal += creation;
    readTotal += read;
    outputTotal += row.output_tokens;
    if (row.model) models.add(row.model);

    calls.push({
      index: position + 1,
      timestamp: row.recorded_at,
      ...(row.model ? { model: row.model } : {}),
      input_tokens: row.input_tokens,
      cache_creation_input_tokens: creation,
      cache_read_input_tokens: read,
      output_tokens: row.output_tokens,
      billed_input_tokens: billed,
      cumulative_billed_input_tokens: cumulative,
      cache_read_ratio: billed > 0 ? round4(read / billed) : 0,
    });
  });

  const billedInput = inputTotal + creationTotal + readTotal;
  const effective = inputTotal + creationTotal * CACHE_WRITE_MULTIPLIER + readTotal * CACHE_READ_MULTIPLIER;
  const maxCall = calls.reduce((max, call) => Math.max(max, call.billed_input_tokens), 0);

  return {
    schema_version: 'newide.driver_token_usage.v1',
    call_count: calls.length,
    effective_input_tokens: Math.round(effective),
    naive_input_tokens: billedInput,
    cache_saved_input_tokens: Math.round(billedInput - effective),
    ideal_cache_input_tokens: Math.round(billedInput * CACHE_READ_MULTIPLIER),
    cache_read_ratio: billedInput > 0 ? round4(readTotal / billedInput) : 0,
    cache_creation_ratio: billedInput > 0 ? round4(creationTotal / billedInput) : 0,
    input_tokens: inputTotal,
    cache_creation_input_tokens: creationTotal,
    cache_read_input_tokens: readTotal,
    output_tokens: outputTotal,
    billed_input_tokens: billedInput,
    total_tokens: billedInput + outputTotal,
    max_call_input_tokens: maxCall,
    first_call_input_tokens: calls[0]?.billed_input_tokens ?? 0,
    last_call_input_tokens: calls[calls.length - 1]?.billed_input_tokens ?? 0,
    models: [...models].sort(),
    session_ids: [...(input.sessionIds ?? [])],
    session_files: [...(input.sessionFiles ?? [])],
    skipped_fragment_rows: input.skippedFragmentRows ?? 0,
    ...(calls[0]?.timestamp ? { first_recorded_at: calls[0].timestamp } : {}),
    ...(calls[calls.length - 1]?.timestamp
      ? { last_recorded_at: calls[calls.length - 1]!.timestamp }
      : {}),
    calls,
  };
}

/**
 * 跑后取数：从 driver 的 Claude 会话文件里读这一格的真实计费。
 *
 * 找不到 sessionId / 找不到文件 / 文件里没有本次窗口的记录，都会返回带
 * `unavailable_reason` 的空证据——**不抛异常**。原因是这一步失败不该把一格已经
 * 跑完的实验判死；但它必须可见，否则「没记录」会被误读成「没花钱」。
 */
export async function collectDriverTokenUsage(input: {
  workspacePath: string;
  sessionIds: readonly string[];
  since?: string;
  until?: string;
}): Promise<DriverTokenEvidence> {
  if (input.sessionIds.length === 0) {
    return emptyDriverTokenEvidence('driver stream carried no sessionId');
  }

  const sessionIdSet = new Set(input.sessionIds);
  const sessionFiles: string[] = [];
  const rows: {
    input_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens: number;
    recorded_at: string;
    model?: string;
  }[] = [];
  let skippedFragmentRows = 0;

  for (const sessionId of input.sessionIds) {
    const candidates = await resolveClaudeSessionJsonlPaths({
      sessionId,
      worktreePath: input.workspacePath,
    });
    for (const filePath of candidates) {
      let parsed;
      try {
        parsed = await readClaudeSessionUsageEntries({
          filePath,
          sessionId,
          ...(input.since ? { since: input.since } : {}),
          ...(input.until ? { until: input.until } : {}),
        });
      } catch {
        continue;
      }
      if (parsed.entries.length === 0) continue;
      if (!sessionFiles.includes(filePath)) sessionFiles.push(filePath);
      skippedFragmentRows += parsed.skipped_fragment_rows;
      for (const entry of parsed.entries) {
        // 双保险：解析层已按 sessionId 过滤，这里再挡一次，防止文件里混入别的会话。
        if (entry.source !== 'claude_session_jsonl') continue;
        rows.push({
          input_tokens: entry.input_tokens,
          ...(entry.cache_creation_input_tokens !== undefined
            ? { cache_creation_input_tokens: entry.cache_creation_input_tokens }
            : {}),
          ...(entry.cache_read_input_tokens !== undefined
            ? { cache_read_input_tokens: entry.cache_read_input_tokens }
            : {}),
          output_tokens: entry.output_tokens,
          recorded_at: entry.recorded_at,
          ...(entry.model ? { model: entry.model } : {}),
        });
      }
      // 一个 sessionId 只认第一个命中的文件，避免同一会话被多路径重复计入。
      break;
    }
  }

  if (rows.length === 0) {
    return {
      ...emptyDriverTokenEvidence(
        `no claude session usage rows for session(s) ${[...sessionIdSet].join(', ')} in this run window`,
      ),
      session_ids: [...input.sessionIds],
      session_files: sessionFiles,
      skipped_fragment_rows: skippedFragmentRows,
    };
  }

  return summarizeDriverTokenUsage({
    rows,
    sessionIds: input.sessionIds,
    sessionFiles,
    skippedFragmentRows,
  });
}

/** 供报告脚本复用：把证据里的 calls 折成累计曲线。 */
export function cumulativeCurve(evidence: DriverTokenEvidence): number[] {
  return evidence.calls.map((call) => call.cumulative_billed_input_tokens);
}
