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
import { ROLE_DISPATCH_EVENT } from '../src/app/run-dispatch-events';
import { effectiveDispatchRecordStatus } from '../src/app/role-autonomy-contract';
import {
  foldDispatchJournalLines,
  RunDispatchJournal,
  RunDispatchJournalError,
} from '../src/persistence';

/** 缺哪份数据。看报告的人据此区分「对账通过」与「没得对」。 */
export type MissingReconcileSignal = 'driver-stream' | 'timeline' | 'summary' | 'journal';

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

/** timeline 里的派工事件事实（只取身份，不看正文）。 */
export interface TimelineDispatchFacts {
  /** 出现在任一 `agent.dispatch_*` 事件里的 dispatch_id。 */
  dispatch_ids: string[];
  /** `agent.dispatch_settled` 的 dispatch_id 集合。 */
  settled_ids: string[];
}

/** Journal 折叠后的派工事实（损坏/半写时视为不可对账）。 */
export interface JournalDispatchFacts {
  total: number;
  by_status: Record<string, number>;
  dispatch_ids: string[];
  settled_ids: string[];
}

/** `summary.json` 的 `dispatch_summary` 事实：全量 id 不在摘要里，只能取它显式列出的部分。 */
export interface SummaryDispatchFacts {
  total: number;
  by_status: Record<string, number>;
  /** `last_dispatch.dispatch_id` + `unknown.dispatch_ids` ——摘要里唯一可对身份的部分。 */
  known_ids: string[];
}

/**
 * 派工身份/计数对账（阶段 4，OBS-02）。
 *
 * 三方口径：timeline 中 `agent.dispatch_settled` 的 id 集合、`summary.json` 的
 * `dispatch_summary`、Journal 折叠。差集只在两侧都有数据时计算；缺失来源进 `missing`，
 * 不把「没得对」写成「对上了」。
 */
export interface DispatchReconcile {
  journal?: JournalDispatchFacts;
  summary?: SummaryDispatchFacts;
  timeline: TimelineDispatchFacts;
  /** Journal 里已 settled 的派工，timeline 的 settled 集合里没有。 */
  missing_in_timeline: string[];
  /** timeline 的 settled 集合里出现、Journal 里没有的派工。 */
  unexpected_in_timeline: string[];
  /** summary 显式列出的派工，timeline 里没有对应事件。 */
  summary_ids_missing_in_timeline: string[];
  /** summary 显式列出的派工，Journal 里没有记录。 */
  summary_ids_not_in_journal: string[];
  /** 计数不一致（只在两侧来源都存在时比较）。 */
  count_mismatches: Array<{ metric: string; expected: number; actual: number }>;
  /** 派工视角没有差异（缺数据时两边都空也算 true，配合 missing 一起读）。 */
  ok: boolean;
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
  /** 派工身份/计数对账（阶段 4）：Journal / summary.dispatch_summary / timeline 三方。 */
  dispatch: DispatchReconcile;
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
  // 派工三方对账的另外两个来源；缺了就不比较，但要在 missing 里说清楚「没得对」。
  const summaryFacts = await readSummaryDispatchFacts(runsRoot, runId);
  const journalFacts = await readJournalDispatchFacts(runsRoot, runId);
  if (summaryFacts === undefined) missing.push('summary');
  if (journalFacts === undefined) missing.push('journal');
  const timelineDispatch =
    (await readTimelineDispatchFacts(runsRoot, runId)) ?? {
      dispatch_ids: [],
      settled_ids: [],
    };
  const dispatch = reconcileDispatchFacts(journalFacts, summaryFacts, timelineDispatch);

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
    dispatch,
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

// ─────────────────────────────────────────────────────────────
// 派工三方对账：Journal / summary.dispatch_summary / timeline
// ─────────────────────────────────────────────────────────────

/**
 * 三方对账纯函数：只在两侧来源都存在时算差集与计数差，缺失的一侧不参与比较。
 * `summary` 只显式列出 `last_dispatch.dispatch_id` 与 `unknown.dispatch_ids`，
 * 因此身份比较只用这组已知 id，不凭空补全。
 */
function reconcileDispatchFacts(
  journal: JournalDispatchFacts | undefined,
  summary: SummaryDispatchFacts | undefined,
  timeline: TimelineDispatchFacts,
): DispatchReconcile {
  const journalIds = new Set(journal?.dispatch_ids ?? []);
  const journalSettled = new Set(journal?.settled_ids ?? []);
  const timelineIds = new Set(timeline.dispatch_ids);
  const timelineSettled = new Set(timeline.settled_ids);

  const missingInTimeline =
    journal === undefined
      ? []
      : [...journalSettled].filter((id) => !timelineSettled.has(id)).sort();
  const unexpectedInTimeline =
    journal === undefined
      ? []
      : [...timelineSettled].filter((id) => !journalIds.has(id)).sort();

  const summaryIds = summary?.known_ids ?? [];
  const summaryIdsMissingInTimeline =
    summary === undefined ? [] : summaryIds.filter((id) => !timelineIds.has(id)).sort();
  const summaryIdsNotInJournal =
    summary === undefined || journal === undefined
      ? []
      : summaryIds.filter((id) => !journalIds.has(id)).sort();

  const countMismatches: DispatchReconcile['count_mismatches'] = [];
  if (journal !== undefined && summary !== undefined) {
    if (journal.total !== summary.total) {
      countMismatches.push({ metric: 'total', expected: journal.total, actual: summary.total });
    }
    const statuses = new Set([
      ...Object.keys(journal.by_status),
      ...Object.keys(summary.by_status),
    ]);
    for (const status of [...statuses].sort()) {
      const expected = journal.by_status[status] ?? 0;
      const actual = summary.by_status[status] ?? 0;
      if (expected !== actual) {
        countMismatches.push({
          metric: `by_status.${status}`,
          expected,
          actual,
        });
      }
    }
  }
  // timeline 的去重派工数只在它确实有派工事件时比较（没有事件是「没投影」，不是 0）。
  if (journal !== undefined && timelineIds.size > 0 && journal.total !== timelineIds.size) {
    countMismatches.push({
      metric: 'timeline.dispatch_ids',
      expected: journal.total,
      actual: timelineIds.size,
    });
  }

  return {
    ...(journal !== undefined ? { journal } : {}),
    ...(summary !== undefined ? { summary } : {}),
    timeline,
    missing_in_timeline: missingInTimeline,
    unexpected_in_timeline: unexpectedInTimeline,
    summary_ids_missing_in_timeline: summaryIdsMissingInTimeline,
    summary_ids_not_in_journal: summaryIdsNotInJournal,
    count_mismatches: countMismatches,
    ok:
      missingInTimeline.length === 0 &&
      unexpectedInTimeline.length === 0 &&
      summaryIdsMissingInTimeline.length === 0 &&
      summaryIdsNotInJournal.length === 0 &&
      countMismatches.length === 0,
  };
}

/** 读 timeline.json 里的派工事件身份；timeline 缺失返回 undefined（与「没有派工事件」区分）。 */
async function readTimelineDispatchFacts(
  runsRoot: string,
  runId: string,
): Promise<TimelineDispatchFacts | undefined> {
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
  const dispatchIds = new Set<string>();
  const settledIds = new Set<string>();
  for (const entry of parsed) {
    const record = readRecord(entry);
    if (!record) continue;
    const eventType = readString(record.type);
    const payload = readRecord(record.payload);
    const dispatchId = readString(payload?.dispatch_id);
    if (eventType === undefined || dispatchId === undefined) continue;
    if (
      eventType !== ROLE_DISPATCH_EVENT.accepted &&
      eventType !== ROLE_DISPATCH_EVENT.started &&
      eventType !== ROLE_DISPATCH_EVENT.settled &&
      eventType !== ROLE_DISPATCH_EVENT.reconciled
    ) {
      continue;
    }
    dispatchIds.add(dispatchId);
    if (eventType === ROLE_DISPATCH_EVENT.settled) settledIds.add(dispatchId);
  }
  return {
    dispatch_ids: [...dispatchIds].sort(),
    settled_ids: [...settledIds].sort(),
  };
}

/** 读 `summary.json` 的 `dispatch_summary`；没有该字段（旧 run）返回 undefined。 */
async function readSummaryDispatchFacts(
  runsRoot: string,
  runId: string,
): Promise<SummaryDispatchFacts | undefined> {
  const raw = await fs
    .readFile(path.join(runsRoot, runId, 'summary.json'), 'utf8')
    .catch(() => undefined);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const summary = readRecord(readRecord(parsed)?.dispatch_summary);
  if (summary === undefined) return undefined;
  const total = readCount(summary.total);
  const byStatus = readCountRecord(summary.by_status);
  const knownIds = new Set<string>();
  const lastDispatch = readString(readRecord(summary.last_dispatch)?.dispatch_id);
  if (lastDispatch !== undefined) knownIds.add(lastDispatch);
  const unknownIds = readRecord(summary.unknown)?.dispatch_ids;
  if (Array.isArray(unknownIds)) {
    for (const id of unknownIds) {
      const value = readString(id);
      if (value !== undefined) knownIds.add(value);
    }
  }
  return { total, by_status: byStatus, known_ids: [...knownIds].sort() };
}

/** 读本 run 的 Journal 并折叠成派工事实；没有 Journal / 损坏 / 半写都返回 undefined。 */
async function readJournalDispatchFacts(
  runsRoot: string,
  runId: string,
): Promise<JournalDispatchFacts | undefined> {
  const runDir = path.join(runsRoot, runId);
  let journal: RunDispatchJournal;
  try {
    journal = await RunDispatchJournal.peek({
      runDir,
      identity: { run_id: runId, task_id: runId, role_id: 'driver-stream-reconcile' },
    });
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return undefined;
    throw error;
  }
  const read = await journal.read();
  if (read.kind !== 'journal' || read.status !== 'ok') return undefined;
  const first = read.lines[0];
  if (first === undefined) return undefined;
  try {
    const fold = foldDispatchJournalLines(read.lines, {
      run_id: first.run_id,
      task_id: first.task_id,
      role_id: first.role_id,
    });
    const byStatus: Record<string, number> = {};
    const settledIds: string[] = [];
    for (const record of fold.records) {
      // 与快照投影 / Journal RPC 共用有效状态规则：原始 settled unknown 经可信 reconciled
      // 收束后按对账后状态计数，否则三方对账会拿两个不同的口径互相「对不上」（R4-02）。
      const status = effectiveDispatchRecordStatus(record);
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      if (record.phase === 'settled') settledIds.push(record.dispatch_id);
    }
    return {
      total: fold.records.length,
      by_status: sortRecord(byStatus),
      dispatch_ids: fold.records.map((record) => record.dispatch_id).sort(),
      settled_ids: settledIds.sort(),
    };
  } catch (error) {
    if (error instanceof RunDispatchJournalError) return undefined;
    throw error;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readCountRecord(value: unknown): Record<string, number> {
  const record = readRecord(value);
  const counts: Record<string, number> = {};
  if (!record) return counts;
  for (const [key, entry] of Object.entries(record)) {
    const count = readCount(entry);
    if (count > 0) counts[key] = count;
  }
  return counts;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === code
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
    lines.push(...renderDispatchReconcile(result.dispatch));
  }
  return lines.join('\n');
}

/** 渲染派工三方对账：只报实际算出来的差集与计数差，缺来源时上面已由 missing 标注。 */
function renderDispatchReconcile(dispatch: DispatchReconcile): string[] {
  const counts: string[] = [];
  if (dispatch.journal !== undefined) counts.push(`journal=${dispatch.journal.total}`);
  if (dispatch.summary !== undefined) counts.push(`summary=${dispatch.summary.total}`);
  counts.push(`timeline_settled=${dispatch.timeline.settled_ids.length}`);
  const lines = [`  派工对账：${counts.join('  ')}`];
  if (dispatch.missing_in_timeline.length > 0) {
    lines.push(`  Journal 已 settled 但 timeline 缺席: ${dispatch.missing_in_timeline.join(', ')}`);
  }
  if (dispatch.unexpected_in_timeline.length > 0) {
    lines.push(`  timeline settled 但 Journal 无记录: ${dispatch.unexpected_in_timeline.join(', ')}`);
  }
  if (dispatch.summary_ids_missing_in_timeline.length > 0) {
    lines.push(
      `  summary 列出但 timeline 无事件: ${dispatch.summary_ids_missing_in_timeline.join(', ')}`,
    );
  }
  if (dispatch.summary_ids_not_in_journal.length > 0) {
    lines.push(`  summary 列出但 Journal 无记录: ${dispatch.summary_ids_not_in_journal.join(', ')}`);
  }
  for (const mismatch of dispatch.count_mismatches) {
    lines.push(`  计数不一致 ${mismatch.metric}: ${mismatch.expected} != ${mismatch.actual}`);
  }
  if (dispatch.ok) lines.push('  派工身份/计数一致');
  return lines;
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
