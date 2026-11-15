/**
 * run-dispatch-projection — 把 run 时间线里已有的派工事实折成对外进度投影（阶段 4）。
 *
 * 职责与核心逻辑：
 * - **输入是事实，不是新账本**：只读 `agent.dispatch_*` / `agent.role_terminated` 等低频
 *   生命周期事件（词表见 `run-dispatch-events.ts`）。Journal 仍是派工唯一事实源，本模块
 *   的结果可以随时从时间线重算，也可以由 Journal 分页读取接口独立重建。
 * - **按稳定身份去重**：同一 `dispatch_id` 的重复 accepted/settled/reconciled 只累计一次；
 *   同一父 Run 重复的 inherited 事件也只算一次。缺投影不补执行——这里没有副作用。
 * - **不虚构进度**：没有派工事实就返回空（调用方让字段缺席），不编 0 派工/百分比；
 *   派工状态缺失时按契约折叠：accepted 无 started = `not_executed`，started 无 settled =
 *   `unknown`，已 settled/reconciled 以已落账状态为准。
 * - **Journal 是事实源，事件是投影**：恢复/回读边界可以把 Journal 折叠记录作为
 *   `journal_records` 传入（阶段 4 修复 R4-01）。合并按 `dispatch_id` 幂等，只补缺失事实、
 *   不覆盖事件里已落账的终态；`unknown` 经可信 reconciled 收束按
 *   `effectiveDispatchRecordStatus` 的同一规则解释（R4-02）。
 * - **继承与当前分开**：父链派工只进 `summary.inherited`，绝不与当前 Run 的 `total` 混加。
 *
 * 边界：纯函数，不读写文件、不派工、不改终态；事件载荷只含低频元数据（不含指令/对话/
 * transcript）。正文按受控 evidence ref 由 RPC 分页读取。
 */
import type { DispatchRecord } from '../driver';
import { DISPATCH_EVIDENCE_DIR, DISPATCH_JOURNAL_DIR } from '../persistence';
import { ROLE_DISPATCH_EVENT } from './run-dispatch-events';
import { effectiveDispatchRecordStatus } from './role-autonomy-contract';
import type {
  RunDispatchProgress,
  RunDispatchStatus,
  RunDispatchSummary,
} from '../protocol/run-snapshot';

/** 时间线事件的最小投影输入：持久事件与存活期事件都满足它。 */
export interface DispatchTimelineEvent {
  type: string;
  payload: Record<string, unknown>;
  created_at?: string;
}

export interface ProjectDispatchOptions {
  /**
   * Run 是否仍在运行。只有运行中才把「accepted/started 无 settled」报成在飞 `current`；
   * 终态 Run 上同一份事件更可能表示进程在派工途中被杀（unknown/not_executed），
   * 报成「正在派工」会替读者编一个不存在的进行状态。
   */
  running?: boolean;
  /**
   * Journal 折叠记录（只读事实源）。用于补齐事件出口失败、或进程在事件落盘前崩溃时
   * 缺失的当前 Run 派工事实；按 `dispatch_id` 幂等合并，只补空位、不覆盖已落账终态。
   *
   * 传 `undefined` 表示「调用方没有 Journal 事实」（legacy Run）——此时行为与纯事件投影
   * 完全一致，不虚构任何派工。
   */
  journal_records?: readonly DispatchRecord[];
}

export interface DispatchFactsProjection {
  summary?: RunDispatchSummary;
  progress?: RunDispatchProgress;
}

const DISPATCH_STATUSES: readonly RunDispatchStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
  'not_executed',
];

const DISPATCH_KINDS = ['investigate', 'execute', 'verify'] as const;
type DispatchKind = (typeof DISPATCH_KINDS)[number];

const TERMINATION_ACTORS = ['role', 'host', 'user'] as const;
type TerminationActor = (typeof TERMINATION_ACTORS)[number];

const MAX_UNKNOWN_IDS = 64;
const MAX_EVIDENCE_REFS = 32;
const MAX_PLAN_CHARS = 8_000;

interface DispatchAccumulator {
  dispatch_id: string;
  kind?: DispatchKind;
  accepted_at?: string;
  started_at?: string;
  settled_at?: string;
  status?: RunDispatchStatus;
  violations: Set<string>;
  evidence_ref?: { path: string; sha256: string };
  /** 最近一次相关事件在输入序列里的位置；用于「最近派工/在飞派工」判定。 */
  last_index: number;
  updated_at?: string;
  /** 最近一次事实发生时间（事件 `created_at` 或 Journal 记录时间），优先于输入顺序。 */
  last_at?: string;
}

/**
 * 把一段（按时间排序的）时间线折成派工摘要与动态进度。
 *
 * 没有任何派工相关事件时返回空对象——调用方据此让字段缺席，而不是写一个「0 派工」的假事实。
 */
export function projectDispatchFacts(
  events: readonly DispatchTimelineEvent[],
  options: ProjectDispatchOptions = {},
): DispatchFactsProjection {
  const dispatches = new Map<string, DispatchAccumulator>();
  const inheritedByRun = new Map<
    string,
    {
      dispatch_count: number;
      by_status: Map<string, number>;
      unresolved: string[];
      violation_count: number;
    }
  >();
  let plan: { plan: string; updated_at: string } | undefined;
  let finishRequested: { status: 'completed' | 'blocked' | 'failed'; requested_at: string } | undefined;
  let terminated:
    | { code: string; actor: TerminationActor; message?: string; terminated_at: string }
    | undefined;
  let sawDispatchFact = false;

  for (const [index, event] of events.entries()) {
    const payload = event.payload ?? {};
    switch (event.type) {
      case ROLE_DISPATCH_EVENT.accepted: {
        const dispatch = accumulatorFor(dispatches, payload, index, event.created_at);
        if (dispatch === undefined) break;
        sawDispatchFact = true;
        assignKind(dispatch, payload.kind);
        const acceptedAt = readString(payload.accepted_at) ?? event.created_at;
        if (dispatch.accepted_at === undefined && acceptedAt !== undefined) {
          dispatch.accepted_at = acceptedAt;
        }
        break;
      }
      case ROLE_DISPATCH_EVENT.started: {
        const dispatch = accumulatorFor(dispatches, payload, index, event.created_at);
        if (dispatch === undefined) break;
        sawDispatchFact = true;
        assignKind(dispatch, payload.kind);
        const startedAt = readString(payload.started_at) ?? event.created_at;
        if (dispatch.started_at === undefined && startedAt !== undefined) {
          dispatch.started_at = startedAt;
        }
        break;
      }
      case ROLE_DISPATCH_EVENT.settled: {
        const dispatch = accumulatorFor(dispatches, payload, index, event.created_at);
        if (dispatch === undefined) break;
        sawDispatchFact = true;
        assignKind(dispatch, payload.kind);
        const status = readStatus(payload.status);
        // 已落账的 settled 是权威终态：后到的重复 settled（同身份重放）不覆盖它。
        if (dispatch.status === undefined && status !== undefined) dispatch.status = status;
        if (dispatch.settled_at === undefined && event.created_at !== undefined) {
          dispatch.settled_at = event.created_at;
        }
        for (const violation of readStringArray(payload.violations)) {
          dispatch.violations.add(violation);
        }
        const ref = readEvidenceRef(payload.evidence_ref);
        if (dispatch.evidence_ref === undefined && ref !== undefined) dispatch.evidence_ref = ref;
        break;
      }
      case ROLE_DISPATCH_EVENT.reconciled: {
        const dispatch = accumulatorFor(dispatches, payload, index, event.created_at);
        if (dispatch === undefined) break;
        sawDispatchFact = true;
        const status = readStatus(payload.status);
        // 对账只允许把 unknown 收束成可信状态，不得改写已发终态（RD-JRN-04）。
        if (status !== undefined && (dispatch.status === undefined || dispatch.status === 'unknown')) {
          dispatch.status = status;
        }
        break;
      }
      case ROLE_DISPATCH_EVENT.inherited: {
        const sourceRunId = readString(payload.source_run_id);
        if (sourceRunId === undefined) break;
        // 同一父 Run 重复投影只算一次（KV 以 source_run_id 为稳定身份）。
        inheritedByRun.set(sourceRunId, {
          dispatch_count: readCount(payload.dispatch_count),
          by_status: readCountRecord(payload.by_status),
          unresolved: readStringArray(payload.unresolved_dispatch_ids),
          violation_count: readNestedCount(payload.violations),
        });
        break;
      }
      case ROLE_DISPATCH_EVENT.plan_updated: {
        const text = readString(payload.plan);
        if (text === undefined) break;
        const updatedAt = event.created_at ?? readString(payload.updated_at);
        if (updatedAt === undefined) break;
        plan = { plan: text.slice(0, MAX_PLAN_CHARS), updated_at: updatedAt };
        break;
      }
      case ROLE_DISPATCH_EVENT.finish_requested: {
        const status = readFinishStatus(payload.status);
        const requestedAt = event.created_at;
        if (status === undefined || requestedAt === undefined) break;
        finishRequested = { status, requested_at: requestedAt };
        break;
      }
      case ROLE_DISPATCH_EVENT.role_terminated: {
        const code = readString(payload.code);
        const actor = readActor(payload.actor);
        const terminatedAt = event.created_at;
        if (code === undefined || actor === undefined || terminatedAt === undefined) break;
        const message = readString(payload.message);
        terminated = {
          code,
          actor,
          ...(message !== undefined ? { message: message.slice(0, 4_000) } : {}),
          terminated_at: terminatedAt,
        };
        break;
      }
      default:
        break;
    }
  }

  // Journal 事实补齐（R4-01）：事件是投影，Journal 才是事实源。合并放在事件折叠之后，
  // 因此「事件里已有的事实」优先（不会用 Journal 覆盖已落账终态），只补空位/升级 unknown。
  if (options.journal_records !== undefined && options.journal_records.length > 0) {
    mergeJournalRecords(dispatches, options.journal_records, events.length);
    sawDispatchFact = true;
  }

  const summary = summarize(dispatches, inheritedByRun, sawDispatchFact);
  const progress = progressOf(dispatches, plan, finishRequested, terminated, options);
  return {
    ...(summary !== undefined ? { summary } : {}),
    ...(progress !== undefined ? { progress } : {}),
  };
}

function accumulatorFor(
  dispatches: Map<string, DispatchAccumulator>,
  payload: Record<string, unknown>,
  index: number,
  createdAt: string | undefined,
): DispatchAccumulator | undefined {
  const dispatchId = readString(payload.dispatch_id);
  if (dispatchId === undefined) return undefined;
  const existing = dispatches.get(dispatchId);
  if (existing !== undefined) {
    existing.last_index = index;
    noteTimestamp(existing, createdAt);
    return existing;
  }
  const created: DispatchAccumulator = {
    dispatch_id: dispatchId,
    violations: new Set<string>(),
    last_index: index,
  };
  noteTimestamp(created, createdAt);
  dispatches.set(dispatchId, created);
  return created;
}

/** 记录事实发生时间：`last_at` 用于选「最近派工」，`updated_at` 是它的对外投影字段。 */
function noteTimestamp(dispatch: DispatchAccumulator, timestamp: string | undefined): void {
  if (timestamp === undefined) return;
  if (dispatch.last_at === undefined || timestamp > dispatch.last_at) {
    dispatch.last_at = timestamp;
  }
  if (dispatch.updated_at === undefined || timestamp > dispatch.updated_at) {
    dispatch.updated_at = timestamp;
  }
}

/**
 * 把 Journal 折叠记录按 `dispatch_id` 合进事件折叠结果（阶段 4 修复 R4-01）。
 *
 * 只补空位：事件里已经有的 accepted/started/settled 事实不被 Journal 覆盖（事件是同一
 * Journal 的投影，重复恢复不能放大计数）；唯一允许的「改写」是把事件里的原始 `unknown`
 * 升级为 Journal 记录上可信 reconciled 的有效状态（R4-02 的同一解释规则）。
 *
 * `last_index` 对 Journal-only 记录排在事件之后，但「最近派工」优先按事实时间
 * （`last_at`）比较，因此不会把更早的补投影误报成最近一次派工。
 */
function mergeJournalRecords(
  dispatches: Map<string, DispatchAccumulator>,
  records: readonly DispatchRecord[],
  eventCount: number,
): void {
  for (const [offset, record] of records.entries()) {
    let dispatch = dispatches.get(record.dispatch_id);
    if (dispatch === undefined) {
      dispatch = {
        dispatch_id: record.dispatch_id,
        violations: new Set<string>(),
        last_index: eventCount + offset,
      };
      dispatches.set(record.dispatch_id, dispatch);
    }
    assignKind(dispatch, record.brief.kind);
    noteTimestamp(dispatch, record.settled_at ?? record.dispatched_at ?? record.accepted_at);
    if (dispatch.accepted_at === undefined) dispatch.accepted_at = record.accepted_at;
    if (dispatch.started_at === undefined && record.dispatched_at !== undefined) {
      dispatch.started_at = record.dispatched_at;
    }
    if (dispatch.settled_at === undefined && record.settled_at !== undefined) {
      dispatch.settled_at = record.settled_at;
    }
    for (const violation of record.violations) dispatch.violations.add(violation);
    if (dispatch.evidence_ref === undefined && record.evidence_sha256 !== undefined) {
      dispatch.evidence_ref = {
        path: `${DISPATCH_JOURNAL_DIR}/${DISPATCH_EVIDENCE_DIR}/${record.dispatch_id}.json`,
        sha256: record.evidence_sha256,
      };
    }
    // dispatched 无 settled 的有效状态仍是 unknown；accepted 无 dispatched 仍是 not_executed。
    // 这两种「没有落账终态」的情形都不写 status，让 `effectiveStatus` 继续按事件折叠规则解释，
    // 运行中的 `current`（accepted/started）才不会因为补投影而消失。
    const effective = effectiveDispatchRecordStatus(record);
    if (
      (dispatch.status === undefined || dispatch.status === 'unknown') &&
      effective !== 'unknown' &&
      effective !== 'not_executed'
    ) {
      dispatch.status = effective;
    }
  }
}

/** 折叠状态：已落账 > started 无 settled = unknown > accepted 无 started = not_executed。 */
function effectiveStatus(dispatch: DispatchAccumulator): RunDispatchStatus {
  if (dispatch.status !== undefined) return dispatch.status;
  if (dispatch.started_at !== undefined) return 'unknown';
  return 'not_executed';
}

/** 「更近」判定：事实时间优先，没有可比时间时退回输入顺序（同一输入内顺序是权威）。 */
function isLaterDispatch(
  candidate: DispatchAccumulator,
  current: DispatchAccumulator,
): boolean {
  if (
    candidate.last_at !== undefined &&
    current.last_at !== undefined &&
    candidate.last_at !== current.last_at
  ) {
    return candidate.last_at > current.last_at;
  }
  return candidate.last_index >= current.last_index;
}

function summarize(
  dispatches: Map<string, DispatchAccumulator>,
  inheritedByRun: Map<
    string,
    {
      dispatch_count: number;
      by_status: Map<string, number>;
      unresolved: string[];
      violation_count: number;
    }
  >,
  sawDispatchFact: boolean,
): RunDispatchSummary | undefined {
  if (!sawDispatchFact && inheritedByRun.size === 0) return undefined;

  const byStatus: Record<string, number> = {};
  const unknownIds: string[] = [];
  const violationKinds = new Set<string>();
  let violationCount = 0;
  let last: DispatchAccumulator | undefined;
  for (const dispatch of dispatches.values()) {
    const status = effectiveStatus(dispatch);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (status === 'unknown' && unknownIds.length < MAX_UNKNOWN_IDS) {
      unknownIds.push(dispatch.dispatch_id);
    }
    violationCount += dispatch.violations.size;
    for (const kind of dispatch.violations) violationKinds.add(kind);
    if (last === undefined || isLaterDispatch(dispatch, last)) last = dispatch;
  }

  let inherited: RunDispatchSummary['inherited'];
  if (inheritedByRun.size > 0) {
    const inheritedStatus: Record<string, number> = {};
    const sourceRunIds: string[] = [];
    const unresolved = new Set<string>();
    let inheritedTotal = 0;
    for (const [sourceRunId, facts] of inheritedByRun) {
      sourceRunIds.push(sourceRunId);
      inheritedTotal += facts.dispatch_count;
      for (const [status, count] of facts.by_status) {
        inheritedStatus[status] = (inheritedStatus[status] ?? 0) + count;
      }
      for (const id of facts.unresolved) unresolved.add(id);
    }
    inherited = {
      total: inheritedTotal,
      by_status: inheritedStatus,
      source_run_ids: sourceRunIds,
      unresolved_dispatch_ids: [...unresolved].slice(0, MAX_UNKNOWN_IDS),
    };
  }

  const updatedAt =
    last === undefined
      ? undefined
      : (last.updated_at ?? last.settled_at ?? last.started_at ?? last.accepted_at);

  return {
    total: dispatches.size,
    by_status: byStatus,
    ...(last !== undefined && updatedAt !== undefined
      ? {
          last_dispatch: {
            dispatch_id: last.dispatch_id,
            ...(last.kind !== undefined ? { kind: last.kind } : {}),
            status: effectiveStatus(last),
            updated_at: updatedAt,
          },
        }
      : {}),
    unknown: { count: byStatus.unknown ?? 0, dispatch_ids: unknownIds },
    violations: { count: violationCount, kinds: [...violationKinds].sort() },
    ...(inherited !== undefined ? { inherited } : {}),
  };
}

function progressOf(
  dispatches: Map<string, DispatchAccumulator>,
  plan: { plan: string; updated_at: string } | undefined,
  finishRequested:
    | { status: 'completed' | 'blocked' | 'failed'; requested_at: string }
    | undefined,
  terminated:
    | { code: string; actor: TerminationActor; message?: string; terminated_at: string }
    | undefined,
  options: ProjectDispatchOptions,
): RunDispatchProgress | undefined {
  // 只有仍在运行的 Run 才报在飞派工：终态 Run 上「accepted 无 settled」是恢复语义，
  // 不是在飞。这里不看瞬时 activity，用的是持久事件的折叠事实。
  let current: RunDispatchProgress['current'];
  if (options.running !== false) {
    let latest: DispatchAccumulator | undefined;
    for (const dispatch of dispatches.values()) {
      if (dispatch.status !== undefined) continue;
      if (latest === undefined || isLaterDispatch(dispatch, latest)) latest = dispatch;
    }
    if (latest !== undefined) {
      const state = latest.started_at !== undefined ? 'started' : 'accepted';
      current = {
        dispatch_id: latest.dispatch_id,
        ...(latest.kind !== undefined ? { kind: latest.kind } : {}),
        state,
        ...(latest.started_at !== undefined ? { started_at: latest.started_at } : {}),
      };
    }
  }

  const evidenceRefs: NonNullable<RunDispatchProgress['evidence_refs']> = [];
  for (const dispatch of [...dispatches.values()].sort((left, right) => right.last_index - left.last_index)) {
    if (evidenceRefs.length >= MAX_EVIDENCE_REFS) break;
    if (dispatch.evidence_ref === undefined) continue;
    evidenceRefs.push({
      dispatch_id: dispatch.dispatch_id,
      path: dispatch.evidence_ref.path,
      sha256: dispatch.evidence_ref.sha256,
    });
  }

  const progress: RunDispatchProgress = {
    ...(current !== undefined ? { current } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(finishRequested !== undefined ? { finish_requested: finishRequested } : {}),
    ...(terminated !== undefined ? { terminated } : {}),
    ...(evidenceRefs.length > 0 ? { evidence_refs: evidenceRefs } : {}),
  };
  return Object.keys(progress).length > 0 ? progress : undefined;
}

// ── 防御性读取：事件载荷来自持久化数据，旧版本可能缺字段/类型漂移 ──

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === 'string' && entry.length > 0 ? [entry] : []))
    : [];
}

function readKind(value: unknown): DispatchKind | undefined {
  return DISPATCH_KINDS.find((kind) => kind === value);
}

/** 只在首次拿到合法 kind 时写入（exactOptionalPropertyTypes 下不能把 undefined 赋给可选字段）。 */
function assignKind(dispatch: DispatchAccumulator, value: unknown): void {
  if (dispatch.kind !== undefined) return;
  const kind = readKind(value);
  if (kind !== undefined) dispatch.kind = kind;
}

function readStatus(value: unknown): RunDispatchStatus | undefined {
  return DISPATCH_STATUSES.find((status) => status === value);
}

function readFinishStatus(
  value: unknown,
): 'completed' | 'blocked' | 'failed' | undefined {
  return value === 'completed' || value === 'blocked' || value === 'failed' ? value : undefined;
}

function readActor(value: unknown): TerminationActor | undefined {
  return TERMINATION_ACTORS.find((actor) => actor === value);
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readCountRecord(value: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return counts;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const count = readCount(entry);
    if (count > 0) counts.set(key, count);
  }
  return counts;
}

function readNestedCount(value: unknown): number {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 0;
  return readCount((value as Record<string, unknown>).count);
}

function readEvidenceRef(value: unknown): { path: string; sha256: string } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const refPath = readString(record.path);
  const sha256 = readString(record.sha256);
  return refPath !== undefined && sha256 !== undefined ? { path: refPath, sha256 } : undefined;
}
