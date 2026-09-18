/**
 * 按 run 汇总「事件 / token / 耗时」三类信号，输出三张表。
 *
 * 数据源是 run 目录里的四份流水，互相独立、各自可能缺失：
 *
 *   summary.json  → `consumption` 块（PR8a 写入）：按 stage 的 token / 耗时 / 事件数
 *   latency.jsonl → 按 span 名的耗时明细
 *   audit.jsonl   → 事件流，按 event_type 计数
 *   telemetry.jsonl → telemetry 记录，按 event_type 计数（假 driver run 里本就没有）
 *
 * 缺失是常态而不是错误：老 run 没有 `consumption`（PR8a 之前的产物）、没有 span 的老
 * run 只有事件、假 LLM 的 run 一条 telemetry 记录都不产生。因此本脚本**降级而不报错**，
 * 并把缺哪类信号如实写进 `missing`，免得看报告的人把「没有」读成「是 0」。
 *
 * 用法：
 *   node --import tsx scripts/consumption-report.ts --all [--runs-root <dir>] [--json]
 *   node --import tsx scripts/consumption-report.ts --run <run_id> [--json]
 *
 * 默认根目录与后端一致：`NEWIDE_STATE_ROOT`（缺省 `<cwd>/.newide`）下的 `runs/`。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 根 span：唯一覆盖整个 run 的那个，它的耗时才是墙钟口径。 */
const ROOT_SPAN_NAME = 'run.loop_total';

export interface StageSignals {
  events: number;
  llm_calls: number;
  total_tokens: number;
  duration_ms: number;
}

export interface SpanSignals {
  count: number;
  total_duration_ms: number;
  max_duration_ms: number;
}

/** 缺哪类信号。看报告的人据此区分「没有」与「是 0」。 */
export type MissingSignal = 'summary' | 'consumption' | 'latency' | 'telemetry' | 'audit';

export interface RunConsumption {
  run_id: string;
  mode?: string;
  status?: string;
  missing: MissingSignal[];
  total_events: number;
  total_tokens: number;
  llm_calls: number;
  /**
   * 各 span 耗时之和。**会重叠**——`run.loop_total` 含各 stage，stage 又含 agent span，
   * 所以它明显大于墙钟，只能用来比较 span 之间的相对体量，不能当 run 的耗时读。
   */
  span_total_duration_ms: number;
  /** 墙钟：根 span `run.loop_total`。没有它就留空，不拿别的数字冒充。 */
  wall_ms?: number;
  by_stage: Record<string, StageSignals>;
  by_span: Record<string, SpanSignals>;
  by_event_type: Record<string, number>;
  telemetry_records: Record<string, number>;
}

export interface ConsumptionReportOptions {
  runsRoot: string;
  runIds?: string[];
}

export async function collectRunConsumption(
  runsRoot: string,
  runId: string,
): Promise<RunConsumption> {
  const runDir = path.join(runsRoot, runId);
  const missing: MissingSignal[] = [];
  const summary = await readJsonObject(path.join(runDir, 'summary.json'));
  if (!summary) missing.push('summary');
  const auditEvents = await readJsonl(path.join(runDir, 'audit.jsonl'));
  if (auditEvents.length === 0) missing.push('audit');
  const telemetryRecords = await readJsonl(path.join(runDir, 'telemetry.jsonl'));
  if (telemetryRecords.length === 0) missing.push('telemetry');

  const byEventType = countBy(auditEvents, (event) => readString(event.type));
  const telemetryByType = countBy(telemetryRecords, (record) => readString(record.event_type));

  const spans = await readJsonl(path.join(runDir, 'latency.jsonl'));
  const bySpan: Record<string, SpanSignals> = {};
  for (const span of spans) {
    const name = readString(span.name);
    if (!name) continue;
    const duration = readNumber(span.duration_ms);
    const bucket = bySpan[name] ?? { count: 0, total_duration_ms: 0, max_duration_ms: 0 };
    bucket.count += 1;
    bucket.total_duration_ms += duration;
    bucket.max_duration_ms = Math.max(bucket.max_duration_ms, duration);
    bySpan[name] = bucket;
  }
  if (spans.length === 0) missing.push('latency');

  const consumption = readRecord(summary?.consumption);
  if (!consumption) missing.push('consumption');
  const byStage = collectStages(consumption);

  return {
    run_id: runId,
    ...(readString(summary?.mode) ? { mode: readString(summary?.mode) } : {}),
    ...(readString(summary?.status) ? { status: readString(summary?.status) } : {}),
    missing: [...missing].sort(),
    total_events: auditEvents.length,
    // token 优先取 consumption（含 cache 的完整口径）；老 run 退回 token_usage 的
    // 运行级数字，两者不可加，所以只在 consumption 缺席时才用后者。
    total_tokens: readNumber(consumption?.totals?.total_tokens) || readNumber(summary?.token_usage?.total_tokens),
    llm_calls: readNumber(consumption?.totals?.llm_calls) || readNumber(summary?.token_usage?.call_count),
    span_total_duration_ms: Object.values(bySpan).reduce(
      (sum, span) => sum + span.total_duration_ms,
      0,
    ),
    ...(bySpan[ROOT_SPAN_NAME] ? { wall_ms: bySpan[ROOT_SPAN_NAME]!.total_duration_ms } : {}),
    by_stage: byStage,
    by_span: bySpan,
    by_event_type: byEventType,
    telemetry_records: telemetryByType,
  };
}

/** 把多个 run 合成一份（`--all` 用）；`missing` 取并集，便于判断整体降级到什么程度。 */
export function aggregateConsumption(runs: readonly RunConsumption[]): RunConsumption {
  const merged: RunConsumption = {
    run_id: '*',
    missing: [],
    total_events: 0,
    total_tokens: 0,
    llm_calls: 0,
    span_total_duration_ms: 0,
    by_stage: {},
    by_span: {},
    by_event_type: {},
    telemetry_records: {},
  };
  const missing = new Set<MissingSignal>();
  for (const run of runs) {
    for (const signal of run.missing) missing.add(signal);
    merged.total_events += run.total_events;
    merged.total_tokens += run.total_tokens;
    merged.llm_calls += run.llm_calls;
    merged.span_total_duration_ms += run.span_total_duration_ms;
    if (run.wall_ms !== undefined) {
      merged.wall_ms = (merged.wall_ms ?? 0) + run.wall_ms;
    }
    for (const [stage, signals] of Object.entries(run.by_stage)) {
      const bucket = (merged.by_stage[stage] ??= {
        events: 0,
        llm_calls: 0,
        total_tokens: 0,
        duration_ms: 0,
      });
      bucket.events += signals.events;
      bucket.llm_calls += signals.llm_calls;
      bucket.total_tokens += signals.total_tokens;
      bucket.duration_ms += signals.duration_ms;
    }
    for (const [name, signals] of Object.entries(run.by_span)) {
      const bucket = (merged.by_span[name] ??= {
        count: 0,
        total_duration_ms: 0,
        max_duration_ms: 0,
      });
      bucket.count += signals.count;
      bucket.total_duration_ms += signals.total_duration_ms;
      bucket.max_duration_ms = Math.max(bucket.max_duration_ms, signals.max_duration_ms);
    }
    for (const [type, count] of Object.entries(run.by_event_type)) {
      merged.by_event_type[type] = (merged.by_event_type[type] ?? 0) + count;
    }
    for (const [type, count] of Object.entries(run.telemetry_records)) {
      merged.telemetry_records[type] = (merged.telemetry_records[type] ?? 0) + count;
    }
  }
  merged.missing = [...missing].sort();
  return merged;
}

export async function collectConsumption(
  options: ConsumptionReportOptions,
): Promise<RunConsumption[]> {
  const runIds = options.runIds ?? (await listRunIds(options.runsRoot));
  const runs: RunConsumption[] = [];
  for (const runId of runIds) {
    runs.push(await collectRunConsumption(options.runsRoot, runId));
  }
  return runs;
}

export async function listRunIds(runsRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(runsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function renderConsumptionReport(
  runs: readonly RunConsumption[],
  options: { aggregate: boolean },
): string {
  const lines: string[] = [];
  const overall = options.aggregate ? aggregateConsumption(runs) : undefined;
  const sections = options.aggregate && overall ? [overall] : runs;

  for (const section of sections) {
    lines.push(renderHeader(section, runs.length), '');
    lines.push('按环节：', renderStages(section.by_stage), '');
    lines.push('按 span（耗时）：', renderSpans(section.by_span), '');
    lines.push('按事件类型：', renderCounts(section.by_event_type), '');
    if (Object.keys(section.telemetry_records).length > 0) {
      lines.push('telemetry 记录：', renderCounts(section.telemetry_records), '');
    }
    if (section.missing.length > 0) {
      lines.push(`缺失信号：${section.missing.join(' / ')}（缺不等于 0）`, '');
    }
  }
  return lines.join('\n');
}

function renderHeader(run: RunConsumption, runCount: number): string {
  const headline = `事件 ${run.total_events}  token ${run.total_tokens}  LLM 调用 ${run.llm_calls}  ${renderWall(run)}`;
  if (run.run_id !== '*') {
    const labels = [run.mode ? `mode=${run.mode}` : undefined, run.status ? `status=${run.status}` : undefined]
      .filter(Boolean)
      .join(' ');
    return `${run.run_id}${labels ? `  ${labels}` : ''}\n${headline}`;
  }
  return `全部 ${runCount} 个 run\n${headline}`;
}

/** 墙钟优先；没有根 span 就明说只有重叠的 span 之和，不拿它冒充 run 的耗时。 */
function renderWall(run: RunConsumption): string {
  if (run.wall_ms !== undefined) return `墙钟 ${formatMs(run.wall_ms)}`;
  return `墙钟 -（无 ${ROOT_SPAN_NAME}；span 合计 ${formatMs(run.span_total_duration_ms)}，会重叠）`;
}

function renderStages(byStage: Record<string, StageSignals>): string {
  const rows = Object.entries(byStage);
  if (rows.length === 0) return '  （无：该 run 没有 consumption 块，或全部事件都无归属）';
  return renderTable(
    ['stage', 'events', 'llm_calls', 'tokens', 'duration'],
    rows.map(([stage, signals]) => [
      stage,
      String(signals.events),
      String(signals.llm_calls),
      String(signals.total_tokens),
      formatMs(signals.duration_ms),
    ]),
  );
}

function renderSpans(bySpan: Record<string, SpanSignals>): string {
  const rows = Object.entries(bySpan);
  if (rows.length === 0) return '  （无：该 run 没有 latency.jsonl，只有事件计数）';
  return renderTable(
    ['span', 'count', 'total', 'max'],
    rows.map(([name, signals]) => [
      name,
      String(signals.count),
      formatMs(signals.total_duration_ms),
      formatMs(signals.max_duration_ms),
    ]),
  );
}

function renderCounts(counts: Record<string, number>): string {
  const rows = Object.entries(counts).sort(([left], [right]) => (left < right ? -1 : 1));
  if (rows.length === 0) return '  （无）';
  return renderTable(
    ['type', 'count'],
    rows.map(([type, count]) => [type, String(count)]),
  );
}

function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const format = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();
  return [format(header), ...rows.map(format)]
    .map((line) => `  ${line}`)
    .join('\n');
}

function formatMs(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)}ms` : '-';
}

function collectStages(
  consumption: Record<string, unknown> | undefined,
): Record<string, StageSignals> {
  const stages = readRecord(consumption?.by_stage);
  if (!stages) return {};
  const result: Record<string, StageSignals> = {};
  for (const [stage, raw] of Object.entries(stages)) {
    const signals = readRecord(raw);
    if (!signals) continue;
    result[stage] = {
      events: readNumber(signals.events),
      llm_calls: readNumber(signals.llm_calls),
      total_tokens: readNumber(signals.total_tokens),
      duration_ms: readNumber(signals.duration_ms),
    };
  }
  return result;
}

function countBy<T>(items: readonly T[], key: (item: T) => string | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const name = key(item);
    if (!name) continue;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

async function readJsonl(filePath: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFileOrUndefined(filePath);
  if (content === undefined) return [];
  const records: Array<Record<string, unknown>> = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // 半截行（进程被杀）不该让整份报告失败，跳过即可。
    }
  }
  return records;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  const content = await readFileOrUndefined(filePath);
  if (content === undefined) return undefined;
  try {
    return readRecord(JSON.parse(content));
  } catch {
    return undefined;
  }
}

async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveRunsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const stateRoot = path.resolve(env.NEWIDE_STATE_ROOT?.trim() || path.join(process.cwd(), '.newide'));
  return path.join(stateRoot, 'runs');
}

export interface ConsumptionCliOptions {
  all: boolean;
  runId?: string;
  runsRoot: string;
  json: boolean;
}

export function parseConsumptionCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ConsumptionCliOptions {
  const options: ConsumptionCliOptions = { all: false, runsRoot: resolveRunsRoot(env), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') {
      options.all = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--run') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--run 需要一个 run_id');
      options.runId = value;
      index += 1;
    } else if (arg === '--runs-root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--runs-root 需要一个目录');
      options.runsRoot = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`未知参数：${arg}。支持 --run <id> / --all / --runs-root <dir> / --json`);
    }
  }
  if (!options.all && !options.runId) {
    throw new Error('需要 --run <run_id> 或 --all 之一');
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseConsumptionCliArgs(process.argv.slice(2));
  const runIds = options.runId ? [options.runId] : undefined;
  const runs = await collectConsumption({
    runsRoot: options.runsRoot,
    ...(runIds ? { runIds } : {}),
  });
  if (runs.length === 0) {
    process.stdout.write(`没有可报告的 run：${options.runsRoot}\n`);
    return;
  }
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ runs, totals: aggregateConsumption(runs) }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(`${renderConsumptionReport(runs, { aggregate: options.all })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
