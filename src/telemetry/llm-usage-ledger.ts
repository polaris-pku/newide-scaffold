/**
 * Per-run LLM token ledger (AsyncLocalStorage).
 *
 * LiteLLM adapters call recordProxyLlmUsage() after each API call.
 * Integration flow finalizes the ledger into summary.token_usage and
 * emits proxy.llm_usage_recorded onto the active TelemetrySink.
 *
 * 记账（ledger entry）与上报（sink emission）是两件独立的事，会各自失败：
 * 没有 ledger 时 entry 无处可放，缺 sink / 缺 case_id 时事件发不出去。两种失败都
 * 不报错——只是汇总数字变小，看报告的人无从察觉——所以每次失败都进丢弃计数器
 * （`snapshotLlmUsageDropCounters`），能上报时再补一条 `llm.usage_dropped`。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  buildLlmUsageDroppedTelemetry,
  buildProxyUsageTelemetry,
  type LlmUsageDropReason,
} from './event-builders';
import { getLlmUsageAttribution, type LlmUsageAttribution } from './llm-usage-attribution';
import { emitTelemetry, type TelemetrySink } from './telemetry-sink';

export type LlmUsageSource = 'proxy' | 'claude_session_jsonl';

/**
 * 一条 LLM 用量记录。
 *
 * 继承 `LlmUsageAttribution`：归属字段与 `recordProxyLlmUsage` 的补全规则同源，
 * 两边各写一份必然漂移。
 */
export interface LlmUsageEntry extends LlmUsageAttribution {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  model?: string;
  temperature?: number;
  seed?: number;
  source: LlmUsageSource;
  recorded_at: string;
}

export interface LlmUsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** input + cache_creation + cache_read (Claude billed input-ish). */
  total_input_tokens: number;
  total_tokens: number;
  call_count: number;
  sources: LlmUsageSource[];
  by_source: Partial<Record<LlmUsageSource, Omit<LlmUsageTotals, 'by_source' | 'sources'>>>;
}

export interface RunTokenUsageSummary extends LlmUsageTotals {
  schema_version: 'newide.token_usage.v1';
  source: LlmUsageSource | 'mixed' | 'unavailable';
  session_id?: string;
  session_path?: string;
}

export interface LlmUsageLedger {
  case_id: string;
  run_id?: string;
  task_id?: string;
  sink?: TelemetrySink;
  scaffold_variant?: string;
  entries: LlmUsageEntry[];
}

const storage = new AsyncLocalStorage<LlmUsageLedger>();
/** Survives ALS exit so async maintenance can keep attributing tokens to a run. */
const runLedgers = new Map<string, LlmUsageLedger>();

function createLedger(
  input: Omit<LlmUsageLedger, 'entries'> & { entries?: LlmUsageEntry[] },
): LlmUsageLedger {
  return {
    case_id: input.case_id,
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    ...(input.sink ? { sink: input.sink } : {}),
    ...(input.scaffold_variant ? { scaffold_variant: input.scaffold_variant } : {}),
    entries: input.entries ?? [],
  };
}

export function runWithLlmUsageLedger<T>(
  input: Omit<LlmUsageLedger, 'entries'> & { entries?: LlmUsageEntry[] },
  fn: () => T,
): T {
  const existing = input.run_id ? runLedgers.get(input.run_id) : undefined;
  const ledger = existing ?? createLedger(input);
  if (input.run_id) {
    if (input.sink) ledger.sink = input.sink;
    if (input.task_id) ledger.task_id = input.task_id;
    if (input.case_id) ledger.case_id = input.case_id;
    if (input.scaffold_variant) ledger.scaffold_variant = input.scaffold_variant;
    runLedgers.set(input.run_id, ledger);
  }
  return storage.run(ledger, fn);
}

export function getActiveLlmUsageLedger(): LlmUsageLedger | undefined {
  return storage.getStore();
}

export function getRunLlmUsageLedger(runId: string): LlmUsageLedger | undefined {
  return runLedgers.get(runId);
}

export function bindActiveLlmUsageIdentity(input: {
  run_id?: string;
  task_id?: string;
  case_id?: string;
}): void {
  const ledger = storage.getStore();
  if (!ledger) return;
  if (input.run_id) ledger.run_id = input.run_id;
  if (input.task_id) ledger.task_id = input.task_id;
  if (input.case_id) ledger.case_id = input.case_id;
  if (ledger.run_id) runLedgers.set(ledger.run_id, ledger);
}

export function snapshotRunLedgerUsage(runId: string): RunTokenUsageSummary {
  const ledger = runLedgers.get(runId);
  if (!ledger) return emptyTokenUsageSummary();
  return toRunTokenUsageSummary(ledger.entries);
}

export function releaseRunLlmUsageLedger(runId: string): void {
  runLedgers.delete(runId);
}

/**
 * 每条流失原因各发生多少次。
 *
 * 同一次调用可以同时命中多个原因——既没有 ledger 也没有 sink 时，entry 无处可放、
 * 事件也发不出去，两件事都真的发生了。所以这里的数字回答的是「这个原因发生了几次」，
 * 不是「丢了几条记录」，两者不可相加后当记录数读。
 */
export type LlmUsageDropCounters = Record<LlmUsageDropReason, number>;

const dropCounters: LlmUsageDropCounters = {
  dropped_no_ledger: 0,
  dropped_no_sink: 0,
  dropped_no_case_id: 0,
};

/**
 * 计数器是「没有 sink 时」唯一的观测面：那条用量丢失的原因本身就是没有出口，
 * 无从上报，只能留在进程内。长驻进程可定期读它并与 sink 侧的 `llm.usage_dropped`
 * 对账。
 */
export function snapshotLlmUsageDropCounters(): LlmUsageDropCounters {
  return { ...dropCounters };
}

/** 把计数器归零。长驻进程取基线、测试之间隔离用。 */
export function resetLlmUsageDropCounters(): void {
  dropCounters.dropped_no_ledger = 0;
  dropCounters.dropped_no_sink = 0;
  dropCounters.dropped_no_case_id = 0;
}

function countLlmUsageDrop(reason: LlmUsageDropReason): void {
  dropCounters[reason] += 1;
}

export function summarizeLlmUsageEntries(entries: readonly LlmUsageEntry[]): LlmUsageTotals {
  const bySource = new Map<LlmUsageSource, LlmUsageEntry[]>();
  for (const entry of entries) {
    const bucket = bySource.get(entry.source) ?? [];
    bucket.push(entry);
    bySource.set(entry.source, bucket);
  }

  const summarize = (bucket: readonly LlmUsageEntry[]) => {
    const input_tokens = bucket.reduce((sum, row) => sum + row.input_tokens, 0);
    const output_tokens = bucket.reduce((sum, row) => sum + row.output_tokens, 0);
    const cache_creation_input_tokens = bucket.reduce(
      (sum, row) => sum + (row.cache_creation_input_tokens ?? 0),
      0,
    );
    const cache_read_input_tokens = bucket.reduce(
      (sum, row) => sum + (row.cache_read_input_tokens ?? 0),
      0,
    );
    const total_input_tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens;
    return {
      input_tokens,
      output_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens,
      total_input_tokens,
      total_tokens: total_input_tokens + output_tokens,
      call_count: bucket.length,
    };
  };

  const overall = summarize(entries);
  const by_source: LlmUsageTotals['by_source'] = {};
  const sources: LlmUsageSource[] = [];
  for (const [source, bucket] of bySource) {
    sources.push(source);
    by_source[source] = summarize(bucket);
  }
  sources.sort();
  return { ...overall, sources, by_source };
}

/** 归属维度的键名；`round` 是数值，分组时按字符串标签处理。 */
export type LlmUsageAttributionKey = keyof LlmUsageAttribution;

/** 未标注该维度的 entry 归入这个桶。 */
export const UNATTRIBUTED_LLM_USAGE_GROUP = 'unattributed';

/**
 * 按某个归属维度分桶后各自汇总，回答「token 花在哪一层」。
 *
 * 没标该维度的 entry 归入 `unattributed` 桶而不是被丢掉：有多少 token 没有归属
 * 本身就是需要被看见的信号——如果在这里静默丢弃，漏标归属的表现会是「各环节加起来
 * 比总数少」，而看不出少在哪。
 *
 * 桶序 = entry 首次出现的顺序（即时间序），空输入返回 `{}`。
 */
export function groupLlmUsageEntriesBy(
  entries: readonly LlmUsageEntry[],
  key: LlmUsageAttributionKey,
): Record<string, LlmUsageTotals> {
  const buckets = new Map<string, LlmUsageEntry[]>();
  for (const entry of entries) {
    const value = entry[key];
    const bucketKey = value === undefined ? UNATTRIBUTED_LLM_USAGE_GROUP : String(value);
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(entry);
    buckets.set(bucketKey, bucket);
  }

  const grouped: Record<string, LlmUsageTotals> = {};
  for (const [bucketKey, bucket] of buckets) {
    grouped[bucketKey] = summarizeLlmUsageEntries(bucket);
  }
  return grouped;
}

export function isPopulatedRunTokenUsage(value: unknown): value is RunTokenUsageSummary {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<RunTokenUsageSummary>;
  if (record.schema_version !== 'newide.token_usage.v1') return false;
  const totalTokens = Number(record.total_tokens ?? 0);
  const callCount = Number(record.call_count ?? 0);
  return (
    Number.isFinite(totalTokens) &&
    Number.isFinite(callCount) &&
    (totalTokens > 0 || callCount > 0)
  );
}

export function emptyTokenUsageSummary(
  extras: Partial<RunTokenUsageSummary> = {},
): RunTokenUsageSummary {
  return {
    schema_version: 'newide.token_usage.v1',
    source: 'unavailable',
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: 0,
    total_tokens: 0,
    call_count: 0,
    sources: [],
    by_source: {},
    ...extras,
  };
}

export function toRunTokenUsageSummary(
  entries: readonly LlmUsageEntry[],
  extras: Partial<RunTokenUsageSummary> = {},
): RunTokenUsageSummary {
  if (entries.length === 0) {
    return emptyTokenUsageSummary(extras);
  }
  const totals = summarizeLlmUsageEntries(entries);
  const source: RunTokenUsageSummary['source'] =
    totals.sources.length === 1 ? (totals.sources[0] ?? 'unavailable') : 'mixed';
  return {
    schema_version: 'newide.token_usage.v1',
    source,
    ...totals,
    ...extras,
  };
}

export async function recordProxyLlmUsage(
  input: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    model?: string;
    temperature?: number;
    seed?: number;
    source?: LlmUsageSource;
    case_id?: string;
    run_id?: string;
    task_id?: string;
    sink?: TelemetrySink;
    scaffold_variant?: string;
    /**
     * 归属维度可以在这里显式给出，也可以留空由归属域（runWithLlmUsageAttribution）
     * 补全。两个 adapter 都不传，靠作用域自动归属，签名因此一行都不用改。
     */
  } & LlmUsageAttribution,
): Promise<void> {
  const ledger = storage.getStore();
  const source = input.source ?? 'proxy';
  const sink = input.sink ?? ledger?.sink;
  const caseId = input.case_id ?? ledger?.case_id;
  const runId = input.run_id ?? ledger?.run_id;
  const taskId = input.task_id ?? ledger?.task_id;

  const entry: LlmUsageEntry = {
    input_tokens: Math.max(0, Math.floor(input.input_tokens)),
    output_tokens: Math.max(0, Math.floor(input.output_tokens)),
    ...(input.cache_creation_input_tokens !== undefined
      ? {
          cache_creation_input_tokens: Math.max(
            0,
            Math.floor(input.cache_creation_input_tokens),
          ),
        }
      : {}),
    ...(input.cache_read_input_tokens !== undefined
      ? { cache_read_input_tokens: Math.max(0, Math.floor(input.cache_read_input_tokens)) }
      : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    source,
    recorded_at: new Date().toISOString(),
    ...resolveUsageAttribution(input),
  };

  if (ledger) {
    ledger.entries.push(entry);
  } else {
    // 记账失败不改变上报：显式传了 sink 的调用点仍应把用量事件发出去。所以这里
    // 不 return，只是如实记下「这批 token 进不了 run 级汇总」。
    await reportLlmUsageDrop('dropped_no_ledger', sink, entry, caseId, runId, taskId);
  }

  if (!sink) {
    // 没有出口就无从上报，这条丢失只留在计数器里。
    countLlmUsageDrop('dropped_no_sink');
    return;
  }

  if (!caseId) {
    await reportLlmUsageDrop('dropped_no_case_id', sink, entry, undefined, runId, taskId);
    return;
  }

  const scaffoldVariant = input.scaffold_variant ?? ledger?.scaffold_variant;
  await emitTelemetry(
    sink,
    buildProxyUsageTelemetry({
      case_id: caseId,
      input_tokens: entry.input_tokens,
      output_tokens: entry.output_tokens,
      ...(entry.cache_creation_input_tokens !== undefined
        ? { cache_creation_input_tokens: entry.cache_creation_input_tokens }
        : {}),
      ...(entry.cache_read_input_tokens !== undefined
        ? { cache_read_input_tokens: entry.cache_read_input_tokens }
        : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
      ...(entry.seed !== undefined ? { seed: entry.seed } : {}),
      ...(scaffoldVariant ? { scaffold_variant: scaffoldVariant } : {}),
      ...(entry.stage_cursor ? { stage_cursor: entry.stage_cursor } : {}),
      ...(entry.role_id ? { role_id: entry.role_id } : {}),
      ...(entry.agent_id ? { agent_id: entry.agent_id } : {}),
      ...(entry.tool_name ? { tool_name: entry.tool_name } : {}),
      ...(entry.round !== undefined ? { round: entry.round } : {}),
      ...(runId ? { run_id: runId } : {}),
      ...(taskId ? { task_id: taskId } : {}),
    }),
  );
}

/** 调用点显式给的归属优先，其余从归属域补全；两处都不确定就留空。 */
function resolveUsageAttribution(input: LlmUsageAttribution): LlmUsageAttribution {
  const scoped = getLlmUsageAttribution();
  const resolved: LlmUsageAttribution = {};
  const stageCursor = input.stage_cursor ?? scoped?.stage_cursor;
  if (stageCursor !== undefined) resolved.stage_cursor = stageCursor;
  const roleId = input.role_id ?? scoped?.role_id;
  if (roleId !== undefined) resolved.role_id = roleId;
  const agentId = input.agent_id ?? scoped?.agent_id;
  if (agentId !== undefined) resolved.agent_id = agentId;
  const toolName = input.tool_name ?? scoped?.tool_name;
  if (toolName !== undefined) resolved.tool_name = toolName;
  const round = input.round ?? scoped?.round;
  if (round !== undefined) resolved.round = round;
  return resolved;
}

/**
 * 记一次流失，并在有出口时补一条 `llm.usage_dropped`。
 *
 * 上报是 best-effort：上报丢弃这件事本身再失败，就只剩计数器这一条观测面。不能让
 * 「记不上账」升级成「调用失败」——观测反过来弄挂生产正是本模块要避免的事。
 */
async function reportLlmUsageDrop(
  reason: LlmUsageDropReason,
  sink: TelemetrySink | undefined,
  entry: LlmUsageEntry,
  caseId: string | undefined,
  runId: string | undefined,
  taskId: string | undefined,
): Promise<void> {
  countLlmUsageDrop(reason);
  if (!sink) return;
  try {
    await emitTelemetry(
      sink,
      buildLlmUsageDroppedTelemetry({
        reason,
        ...(caseId ? { case_id: caseId } : {}),
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.stage_cursor ? { stage_cursor: entry.stage_cursor } : {}),
        ...(entry.role_id ? { role_id: entry.role_id } : {}),
        ...(entry.agent_id ? { agent_id: entry.agent_id } : {}),
        ...(entry.tool_name ? { tool_name: entry.tool_name } : {}),
        ...(entry.round !== undefined ? { round: entry.round } : {}),
        ...(runId ? { run_id: runId } : {}),
        ...(taskId ? { task_id: taskId } : {}),
      }),
    );
  } catch {
    // 吞掉：计数器已经记过了。
  }
}

export function activeLedgerTokenCostTotal(): number {
  const ledger = storage.getStore();
  if (!ledger || ledger.entries.length === 0) return 0;
  return summarizeLlmUsageEntries(ledger.entries).total_tokens;
}

export function snapshotActiveLedgerUsage(): RunTokenUsageSummary {
  const ledger = storage.getStore();
  if (!ledger) return emptyTokenUsageSummary();
  return toRunTokenUsageSummary(ledger.entries);
}
