/**
 * driver-stream 的重放与对账。
 *
 * 背景：driver 事件流有两级消费——全量落盘的 `driver-stream.jsonl`（真相源）与投影进
 * 事件模型的 `timeline.json`（消费形态）。投影改动、截断、老 run 都可能让两级出现
 * 差集，本脚本回答两件事：
 *
 *   重放：从 driver-stream.jsonl 重新投影出事件流（timeline 的 driver 部分可由此重建）
 *   对账：真相源投影出的事件与 timeline.json 里实际存的事件差在哪——丢在哪个序号、
 *         哪个类型变了、谁多出来了
 *
 * 与 consumption-report 同一个信条：**降级而不报错**。老 run 没有 driver-stream.jsonl
 * （写入器曾默认空转）或没有 timeline.json 都是常态，缺哪份写进 `missing`，免得把
 * 「没有数据」读成「对账通过」。
 *
 * 用法：
 *   node --import tsx scripts/driver-stream-reconcile.ts --all [--runs-root <dir>] [--json]
 *   node --import tsx scripts/driver-stream-reconcile.ts --run <run_id> [--replay] [--json]
 *
 * 默认根目录与后端一致：`NEWIDE_STATE_ROOT`（缺省 `<cwd>/.newide`）下的 `runs/`。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readDriverStreamAuditLines,
  type DriverStreamAuditLine,
} from '../src/app/driver-stream-refs';
import { projectDriverStreamLifecycleEvent } from '../src/app/driver-stream-projection';

/** 缺哪份数据。看报告的人据此区分「对账通过」与「没得对」。 */
export type MissingReconcileSignal = 'driver-stream' | 'timeline';

/** 重放产物：真相源投影出的事件，按信封序号排列。 */
export interface ReplayedDriverEvent {
  /** driver 侧序号（每次 invoke 重置，多 invoke 下不唯一）；缺失为 -1。 */
  sequence: number;
  /** run 级单调序号（信封字段）；老数据没有。 */
  stream_sequence?: number;
  event_type: string;
  payload: Record<string, unknown>;
}

export interface DriverStreamReplay {
  run_id: string;
  truncated: boolean;
  audit_events: number;
  events: ReplayedDriverEvent[];
}

export interface TypeMismatch {
  /** 对账键值：见 `DriverStreamReconcileResult.key`。 */
  sequence: number;
  replayed: string;
  timeline: string;
}

export interface DriverStreamReconcileResult {
  run_id: string;
  missing: MissingReconcileSignal[];
  /** 真相源被保留策略截断过：差集可能来自截断而不是投影。 */
  truncated: boolean;
  audit_events: number;
  timeline_driver_events: number;
  /**
   * 对账键。`stream_sequence`（run 级唯一）在两侧都有时逐序号精确配对；老数据
   * 退化为 `sequence`（每次 invoke 重置），此时按「同键的类型多重集」配对——
   * 同一键出现多次不算差异，只有类型组成对不上才是。
   */
  key: 'stream_sequence' | 'sequence';
  /** 真相源里有、timeline 里没有的键——投影丢失点。 */
  missing_in_timeline: number[];
  /** timeline 里有、真相源里没有的键——多见于截断或外部写入。 */
  unexpected_in_timeline: number[];
  /** 同键下类型对不上——投影逻辑在两次消费之间变过。 */
  type_mismatches: TypeMismatch[];
  by_type_replayed: Record<string, number>;
  by_type_timeline: Record<string, number>;
  /** 已有数据里没有差异。缺数据时两边都空也算 true，配合 missing 一起读。 */
  ok: boolean;
}

/** 从 driver-stream.jsonl 重放出事件流。真相源缺失时返回空事件集。 */
export async function replayDriverStream(
  runsRoot: string,
  runId: string,
): Promise<DriverStreamReplay> {
  const lines = await readDriverStreamAuditLines(runsRoot, runId);
  return buildReplay(runId, lines);
}

function buildReplay(runId: string, lines: DriverStreamAuditLine[]): DriverStreamReplay {
  const events: ReplayedDriverEvent[] = [];
  for (const line of lines) {
    if (!line.event) continue;
    const projected = projectDriverStreamLifecycleEvent(line.event, line.stream_sequence);
    if (!projected) continue;
    events.push({
      sequence: typeof line.event.sequence === 'number' ? line.event.sequence : -1,
      ...(typeof line.stream_sequence === 'number' ? { stream_sequence: line.stream_sequence } : {}),
      event_type: String(projected.event_type),
      payload: projected.payload,
    });
  }
  return {
    run_id: runId,
    truncated: lines.some((line) => line.truncated === true),
    audit_events: lines.filter((line) => line.event !== undefined).length,
    events,
  };
}

/** 对账真相源与 timeline.json 的 driver 事件部分。 */
export async function reconcileDriverStreamRun(
  runsRoot: string,
  runId: string,
): Promise<DriverStreamReconcileResult> {
  const replay = await replayDriverStream(runsRoot, runId);
  const timelineEvents = await readTimelineDriverEvents(runsRoot, runId);
  const missing: MissingReconcileSignal[] = [];
  if (replay.audit_events === 0) missing.push('driver-stream');
  if (timelineEvents === undefined) missing.push('timeline');

  // 键的选择：两侧都有 run 级唯一序号时精确配对；否则退化为 driver 侧序号，
  // 按「同键类型多重集」配对——invoke 间序号碰撞不再报假差异。
  const keyKind: 'stream_sequence' | 'sequence' =
    replay.events.length > 0 &&
    replay.events.every((event) => event.stream_sequence !== undefined) &&
    (timelineEvents?.length ?? 0) > 0 &&
    (timelineEvents ?? []).every((event) => event.stream_sequence !== undefined)
      ? 'stream_sequence'
      : 'sequence';
  const keyOf = (
    event: ReplayedDriverEvent | TimelineDriverEvent,
  ): number => (keyKind === 'stream_sequence' ? (event.stream_sequence ?? -1) : event.sequence);

  const timelineIndex = new Map<number, Map<string, number>>();
  for (const event of timelineEvents ?? []) {
    const bucket = timelineIndex.get(keyOf(event)) ?? new Map<string, number>();
    bucket.set(event.event_type, (bucket.get(event.event_type) ?? 0) + 1);
    timelineIndex.set(keyOf(event), bucket);
  }

  const missingInTimeline: number[] = [];
  const typeMismatches: TypeMismatch[] = [];
  const byTypeReplayed: Record<string, number> = {};
  for (const event of replay.events) {
    byTypeReplayed[event.event_type] = (byTypeReplayed[event.event_type] ?? 0) + 1;
    const key = keyOf(event);
    const bucket = timelineIndex.get(key);
    if (bucket && takeType(bucket, event.event_type)) continue;
    if (bucket && bucket.size > 0) {
      // 同键还在，只是类型对不上：按类型组成报告差异，并配对掉一条避免重复报。
      const counterpart = [...bucket.keys()].sort()[0];
      takeType(bucket, counterpart);
      typeMismatches.push({ sequence: key, replayed: event.event_type, timeline: counterpart });
      continue;
    }
    missingInTimeline.push(key);
  }

  const unexpectedInTimeline = [...timelineIndex.entries()]
    .filter(([, bucket]) => bucket.size > 0)
    .map(([key]) => key)
    .sort((left, right) => left - right);

  const byTypeTimeline: Record<string, number> = {};
  for (const event of timelineEvents ?? []) {
    byTypeTimeline[event.event_type] = (byTypeTimeline[event.event_type] ?? 0) + 1;
  }

  return {
    run_id: runId,
    missing: [...missing].sort(),
    truncated: replay.truncated,
    audit_events: replay.audit_events,
    timeline_driver_events: timelineEvents?.length ?? 0,
    key: keyKind,
    missing_in_timeline: missingInTimeline.sort((left, right) => left - right),
    unexpected_in_timeline: unexpectedInTimeline,
    type_mismatches: typeMismatches,
    by_type_replayed: sortRecord(byTypeReplayed),
    by_type_timeline: sortRecord(byTypeTimeline),
    ok: missingInTimeline.length === 0 && typeMismatches.length === 0 && unexpectedInTimeline.length === 0,
  };
}

/** 从类型多重集里配对掉一条；配到返回 true。 */
function takeType(bucket: Map<string, number>, eventType: string): boolean {
  const count = bucket.get(eventType) ?? 0;
  if (count === 0) return false;
  if (count === 1) bucket.delete(eventType);
  else bucket.set(eventType, count - 1);
  return true;
}

interface TimelineDriverEvent {
  /** driver 侧序号；两侧都没有 run 级序号时作退化键。 */
  sequence: number;
  /** run 级单调序号；老 timeline 没有。 */
  stream_sequence?: number;
  event_type: string;
}

/**
 * 读 timeline.json 里的 driver 事件流投影部分。
 *
 * 判别与 consumption 归属同一口径：payload 带 event_sequence / stream_sequence。
 * 文件不存在返回 undefined（区别于「存在但没有 driver 事件」的空数组）。
 */
async function readTimelineDriverEvents(
  runsRoot: string,
  runId: string,
): Promise<TimelineDriverEvent[] | undefined> {
  const raw = await fs
    .readFile(path.join(runsRoot, runId, 'timeline.json'), 'utf8')
    .catch(() => undefined);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const events: TimelineDriverEvent[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const payload =
      record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
        ? (record.payload as Record<string, unknown>)
        : {};
    const eventSequence = payload.event_sequence;
    const streamSequence = payload.stream_sequence;
    if (typeof eventSequence !== 'number' && typeof streamSequence !== 'number') continue;
    events.push({
      sequence: typeof eventSequence === 'number' ? eventSequence : -1,
      ...(typeof streamSequence === 'number' ? { stream_sequence: streamSequence } : {}),
      event_type: typeof record.type === 'string' ? record.type : 'unknown',
    });
  }
  return events;
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

export function renderDriverStreamReconcile(results: readonly DriverStreamReconcileResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const flags = [
      result.ok ? 'OK' : 'DIFF',
      result.truncated ? 'truncated' : undefined,
      result.missing.length > 0 ? `missing=${result.missing.join('+')}` : undefined,
    ].filter((flag): flag is string => flag !== undefined);
    lines.push(`${result.run_id}  [${flags.join(' ')}]`);
    lines.push(
      `  audit=${result.audit_events}  timeline_driver=${result.timeline_driver_events}  key=${result.key}`,
    );
    if (result.missing_in_timeline.length > 0) {
      lines.push(`  丢失于 timeline（投影丢失点）: ${result.missing_in_timeline.join(', ')}`);
    }
    if (result.unexpected_in_timeline.length > 0) {
      lines.push(`  timeline 多出: ${result.unexpected_in_timeline.join(', ')}`);
    }
    for (const mismatch of result.type_mismatches) {
      lines.push(
        `  类型不一致 seq=${mismatch.sequence}: 重放=${mismatch.replayed} timeline=${mismatch.timeline}`,
      );
    }
  }
  return lines.join('\n');
}

export interface DriverStreamCliOptions {
  runsRoot: string;
  runId?: string;
  all: boolean;
  replay: boolean;
  json: boolean;
}

export function parseDriverStreamCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): DriverStreamCliOptions {
  const options: DriverStreamCliOptions = {
    runsRoot: resolveRunsRoot(env),
    all: false,
    replay: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') {
      options.all = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--replay') {
      options.replay = true;
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
      throw new Error(`未知参数：${arg}。支持 --run <id> / --all / --runs-root <dir> / --replay / --json`);
    }
  }
  if (!options.all && !options.runId) {
    throw new Error('需要 --run <run_id> 或 --all 之一');
  }
  return options;
}

function resolveRunsRoot(env: NodeJS.ProcessEnv): string {
  const stateRoot = env.NEWIDE_STATE_ROOT || path.join(process.cwd(), '.newide');
  return path.join(stateRoot, 'runs');
}

async function main(): Promise<void> {
  const options = parseDriverStreamCliArgs(process.argv.slice(2));
  const runIds = options.runId ? [options.runId] : await listRunIds(options.runsRoot);
  if (runIds.length === 0) {
    process.stdout.write(`没有可对账的 run：${options.runsRoot}\n`);
    return;
  }

  if (options.replay) {
    const replays = [];
    for (const runId of runIds) replays.push(await replayDriverStream(options.runsRoot, runId));
    process.stdout.write(`${JSON.stringify(replays, null, 2)}\n`);
    return;
  }

  const results = [];
  for (const runId of runIds) {
    results.push(await reconcileDriverStreamRun(options.runsRoot, runId));
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ runs: results }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderDriverStreamReconcile(results)}\n`);
}

async function listRunIds(runsRoot: string): Promise<string[]> {
  const entries = await fs.readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
