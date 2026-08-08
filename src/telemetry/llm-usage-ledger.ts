/**
 * Per-run LLM token ledger (AsyncLocalStorage).
 *
 * LiteLLM adapters call recordProxyLlmUsage() after each API call.
 * Integration flow finalizes the ledger into summary.token_usage and
 * emits proxy.llm_usage_recorded onto the active TelemetrySink.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { buildProxyUsageTelemetry } from './event-builders';
import { emitTelemetry, type TelemetrySink } from './telemetry-sink';

export type LlmUsageSource = 'proxy' | 'claude_session_jsonl';

export interface LlmUsageEntry {
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

export async function recordProxyLlmUsage(input: {
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
}): Promise<void> {
  const ledger = storage.getStore();
  const source = input.source ?? 'proxy';
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
  };
  ledger?.entries.push(entry);

  const sink = input.sink ?? ledger?.sink;
  if (!sink) return;

  const caseId = input.case_id ?? ledger?.case_id;
  if (!caseId) return;

  const scaffoldVariant = input.scaffold_variant ?? ledger?.scaffold_variant;
  const runId = input.run_id ?? ledger?.run_id;
  const taskId = input.task_id ?? ledger?.task_id;
  await emitTelemetry(
    sink,
    buildProxyUsageTelemetry({
      case_id: caseId,
      input_tokens: entry.input_tokens,
      output_tokens: entry.output_tokens,
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
      ...(entry.seed !== undefined ? { seed: entry.seed } : {}),
      ...(scaffoldVariant ? { scaffold_variant: scaffoldVariant } : {}),
      ...(runId ? { run_id: runId } : {}),
      ...(taskId ? { task_id: taskId } : {}),
    }),
  );
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
