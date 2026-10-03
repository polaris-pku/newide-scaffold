/**
 * 把 run 收尾时手上的两份数据折成账本行。**纯函数**，不碰文件也不碰数据库。
 *
 * 两条腿各有一个来源，而且各自的**归属质量不一样**，这是本模块最要紧的地方：
 *
 * - **proxy 计费腿**：数 run 时间线里的 `proxy.llm_usage_recorded`。这些事件的 payload
 *   带 `role_id`（`event-builders.ts:180`），所以按角色归集是**精确**的。
 * - **driver 计费腿**：真实 coding agent 的用量从不进 run 事件流，只能靠 Claude Code 的
 *   session JSONL 刮取，刮完由 `buildDriverBilledUsage` 并进 `summary.driver_billed_usage`。
 *   角色归属要把 `by_session` 与 `driver_context_usage.sessions[]` 按 `session_id` join
 *   起来才有（`run-token-usage-merge.ts:117-163`）。
 *
 * 两处容易写错、这里刻意防住的：
 *
 * 1. **别把 `driver_usage` / `driver_context_usage` 当计费**。那两个块的 `metric` 是
 *    `context_tokens_used`——**上下文占用**（会话结束时上下文有多大），不是烧掉的流量。
 *    只有 `driver_billed_usage`（`metric: billed_tokens`）才是计费。把它俩混了就是本文档
 *    反复警告的「不同口径相加」，而且看起来还挺合理。
 * 2. **按角色归集必须在写入前完成**。主键是 `(run_id, role_id, source, metric)`，一个
 *    run 的同一角色只能有一行；逐会话直接写会让同角色的多行互相覆盖，**静默丢用量**。
 *
 * driver 腿还多一条保守规则：逐会话求和与权威腿总量**不相等时就不按角色写**，退化成一条
 * 未归属行。理由是这个账本必须能与 `summary.token_usage` 对上；为了一个好看的按角色分解
 * 而让总数对不上，等于用一致性换一点可读性。
 */
import type { RunUsageTokens } from '../protocol/run-snapshot';
import {
  TOKEN_USAGE_LEDGER_SCHEMA_VERSION,
  UNATTRIBUTED_ROLE_ID,
  type TokenUsageLedgerEntry,
} from '../persistence';

/** 时间线事件的最小形状；只要 type 与 payload，便于单测。 */
export interface LedgerTimelineEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface TokenUsageLedgerEntryInput {
  run_id: string;
  task_id: string;
  /**
   * run 事件流投影后的时间线。给了它就能把 proxy 腿**按角色精确归集**。
   *
   * 与 `proxyLeg` 同时给出时以本字段为准：时间线是逐次调用的原始记录，比汇总更细。
   */
  timeline?: readonly LedgerTimelineEvent[];
  /**
   * `summary.token_usage.by_source.proxy`，**回填**已有 run 时用（那条路上没有时间线）。
   *
   * 它**不按角色**归集：summary 的 proxy 腿只有一个总数，没有角色细分，而编造归属比留空
   * 更糟。所以回填出来的 proxy 行一律是未归属哨兵。
   */
  proxyLeg?: RunUsageTokens;
  /**
   * driver 计费腿的**权威总量**，即 `summary.token_usage.by_source.claude_session_jsonl`。
   * 缺席（或为 0）表示这次 run 没有 driver 计费数据，不写任何 driver 行——而不是写 0。
   */
  driverBilledLeg?: RunUsageTokens;
  /** `summary.driver_billed_usage` 块，用来取逐会话的角色归属。 */
  driverBilledUsage?: unknown;
  recorded_at: string;
}

export function buildTokenUsageLedgerEntries(
  input: TokenUsageLedgerEntryInput,
): TokenUsageLedgerEntry[] {
  const entries: TokenUsageLedgerEntry[] = [];
  for (const [roleId, tokens] of rollupProxy(input)) {
    entries.push(row(input, 'proxy', roleId, tokens));
  }
  for (const [roleId, tokens] of rollupDriverByRole(input)) {
    entries.push(row(input, 'claude_session_jsonl', roleId, tokens));
  }
  return entries;
}

/** proxy 腿：有时间线就按角色精确归集，没有就退回 summary 那个不带角色的总数。 */
function rollupProxy(input: TokenUsageLedgerEntryInput): Map<string, RunUsageTokens> {
  if (input.timeline !== undefined) return rollupProxyByRole(input.timeline);
  if (input.proxyLeg && input.proxyLeg.total_tokens > 0) {
    return new Map([[UNATTRIBUTED_ROLE_ID, { ...input.proxyLeg }]]);
  }
  return new Map();
}

function row(
  input: TokenUsageLedgerEntryInput,
  source: TokenUsageLedgerEntry['source'],
  roleId: string,
  tokens: RunUsageTokens,
): TokenUsageLedgerEntry {
  return {
    run_id: input.run_id,
    task_id: input.task_id,
    role_id: roleId,
    source,
    metric: 'billed_tokens',
    recorded_at: input.recorded_at,
    schema_version: TOKEN_USAGE_LEDGER_SCHEMA_VERSION,
    ...tokens,
  };
}

/**
 * proxy 腿按 `role_id` 归集。
 *
 * 口径与 `summarizeRunConsumption` 一致：`total_tokens = input + cache_creation +
 * cache_read + output`（**含 cache**）。注意 `resolveTokenUsageFromTimeline` 只数
 * input/output 并把 cache 写死 0——当前三个 `recordProxyLlmUsage` 调用点都不传 cache
 * （`litellm-*` 三个 adapter 都只给 input/output），所以两者今天数值相同；一旦有调用点
 * 开始传 cache，那一边就会变成**偏小的**那条。
 */
function rollupProxyByRole(
  timeline: readonly LedgerTimelineEvent[],
): Map<string, RunUsageTokens> {
  const byRole = new Map<string, RunUsageTokens>();
  for (const event of timeline) {
    if (event.type !== 'proxy.llm_usage_recorded') continue;
    const payload = event.payload ?? {};
    const tokens: RunUsageTokens = {
      input_tokens: readAmount(payload.input_tokens),
      output_tokens: readAmount(payload.output_tokens),
      cache_creation_input_tokens: readAmount(payload.cache_creation_input_tokens),
      cache_read_input_tokens: readAmount(payload.cache_read_input_tokens),
      total_input_tokens: 0,
      total_tokens: 0,
      call_count: 1,
    };
    tokens.total_input_tokens =
      tokens.input_tokens + tokens.cache_creation_input_tokens + tokens.cache_read_input_tokens;
    tokens.total_tokens = tokens.total_input_tokens + tokens.output_tokens;
    addInto(byRole, readRoleId(payload.role_id), tokens);
  }
  return byRole;
}

/** driver 计费腿按 `role_id` 归集；对不上权威总量时退化成一条未归属行。 */
function rollupDriverByRole(input: TokenUsageLedgerEntryInput): Map<string, RunUsageTokens> {
  const leg = input.driverBilledLeg;
  if (!leg || leg.total_tokens === 0) return new Map();

  const sessions = readDriverSessions(input.driverBilledUsage);
  if (sessions.length > 0) {
    const byRole = new Map<string, RunUsageTokens>();
    for (const session of sessions) addInto(byRole, readRoleId(session.role_id), session.tokens);
    if (equalsTotals(sumTokens(byRole), leg)) return byRole;
  }
  return new Map([[UNATTRIBUTED_ROLE_ID, { ...leg }]]);
}

interface DriverSessionRow {
  role_id: unknown;
  tokens: RunUsageTokens;
}

function readDriverSessions(block: unknown): DriverSessionRow[] {
  const sessions = asRecord(block)?.sessions;
  if (!Array.isArray(sessions)) return [];
  const rows: DriverSessionRow[] = [];
  for (const session of sessions) {
    const record = asRecord(session);
    if (!record) continue;
    const tokens: RunUsageTokens = {
      input_tokens: readAmount(record.input_tokens),
      output_tokens: readAmount(record.output_tokens),
      cache_creation_input_tokens: readAmount(record.cache_creation_input_tokens),
      cache_read_input_tokens: readAmount(record.cache_read_input_tokens),
      total_input_tokens: readAmount(record.total_input_tokens),
      total_tokens: readAmount(record.total_tokens),
      call_count: readAmount(record.call_count),
    };
    if (tokens.total_tokens === 0) continue;
    rows.push({ role_id: record.role_id, tokens });
  }
  return rows;
}

/**
 * 从 `summary.token_usage` 里取出 driver 计费腿（`by_source.claude_session_jsonl`）。
 *
 * 这是 driver 腿的**权威总量**：`driver_billed_usage` 顶层的同名字段就是它（或逐会话求和），
 * 而账本必须与 `summary.token_usage` 对得上。取不到时返回 `undefined`——**不是 0**，
 * 让调用方少写一行，而不是写一行 0。
 */
export function readClaudeSessionLeg(tokenUsage: unknown): RunUsageTokens | undefined {
  return readLeg(tokenUsage, 'claude_session_jsonl');
}

/**
 * 从 `summary.token_usage` 里取出 proxy 计费腿（`by_source.proxy`）。
 *
 * 回填时用。注意它**只有一个总数**，没有角色细分——所以回填出来的 proxy 行只能是
 * 未归属哨兵（见 `TokenUsageLedgerEntryInput.proxyLeg`）。
 */
export function readProxyLeg(tokenUsage: unknown): RunUsageTokens | undefined {
  return readLeg(tokenUsage, 'proxy');
}

function readLeg(tokenUsage: unknown, source: string): RunUsageTokens | undefined {
  const leg = asRecord(asRecord(tokenUsage)?.by_source)?.[source];
  const record = asRecord(leg);
  if (!record) return undefined;
  const tokens: RunUsageTokens = {
    input_tokens: readAmount(record.input_tokens),
    output_tokens: readAmount(record.output_tokens),
    cache_creation_input_tokens: readAmount(record.cache_creation_input_tokens),
    cache_read_input_tokens: readAmount(record.cache_read_input_tokens),
    total_input_tokens: readAmount(record.total_input_tokens),
    total_tokens: readAmount(record.total_tokens),
    call_count: readAmount(record.call_count),
  };
  return tokens.total_tokens > 0 ? tokens : undefined;
}

function addInto(target: Map<string, RunUsageTokens>, roleId: string, add: RunUsageTokens): void {
  const current = target.get(roleId) ?? emptyTokens();
  current.input_tokens += add.input_tokens;
  current.output_tokens += add.output_tokens;
  current.cache_creation_input_tokens += add.cache_creation_input_tokens;
  current.cache_read_input_tokens += add.cache_read_input_tokens;
  current.total_input_tokens += add.total_input_tokens;
  current.total_tokens += add.total_tokens;
  current.call_count += add.call_count;
  target.set(roleId, current);
}

function sumTokens(byRole: Map<string, RunUsageTokens>): RunUsageTokens {
  const total = emptyTokens();
  for (const tokens of byRole.values()) {
    total.input_tokens += tokens.input_tokens;
    total.output_tokens += tokens.output_tokens;
    total.cache_creation_input_tokens += tokens.cache_creation_input_tokens;
    total.cache_read_input_tokens += tokens.cache_read_input_tokens;
    total.total_input_tokens += tokens.total_input_tokens;
    total.total_tokens += tokens.total_tokens;
    total.call_count += tokens.call_count;
  }
  return total;
}

/**
 * 逐会话求和与权威腿是否一致——**只比 `total_tokens`**。
 *
 * 不连 `call_count` 一起比，是因为这条守卫要保证的不变量只关于 token 总量：账本的求和
 * 必须等于 `summary.token_usage` 的那条腿。调用次数是次要计数，逐会话的计数本来就来自
 * 会话本身；把它的差异也当成「对不上」，会在总量明明正确时白白丢掉角色分解。
 */
function equalsTotals(left: RunUsageTokens, right: RunUsageTokens): boolean {
  return left.total_tokens === right.total_tokens;
}

function emptyTokens(): RunUsageTokens {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: 0,
    total_tokens: 0,
    call_count: 0,
  };
}

/** 取不到角色时用未归属哨兵（空串），不用空 `undefined`——写入层的幂等键依赖它非空。 */
function readRoleId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : UNATTRIBUTED_ROLE_ID;
}

function readAmount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
