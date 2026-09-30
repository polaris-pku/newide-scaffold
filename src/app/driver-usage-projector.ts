/**
 * driver 侧 usage 观测的聚合。
 *
 * 核心语义:`usage_update.used` 是 Session 级**累计**上下文观测，重复 update 要按
 * Session 折叠（取 max）而不是累加。这个折叠口径此前只活在「终态回读
 * `driver-stream.jsonl`」这一条旁路上；现在抽出纯折叠函数 `foldUsageObservation`，
 * 让两条数据源共享同一口径：
 *
 * - 正源:`TaskDriverUsageAccumulator` —— 事件流到达即折叠，进程内看到的是全量；
 * - 兜底:终态回读审计文件（崩溃恢复 / 跨进程的 council 续 run）。
 *
 * 审计文件可能被保留上限截断（`truncated: true` 标记后停写）。截断文件喂出的
 * 观测会被标成 `complete: false`，聚合结果不再冒充完整数据；与正源合并时，
 * 只要某个 Session 被任一完整来源覆盖过，它就是完整的。
 *
 * 盘上读取有两条通道，优先级固定：**账本 `driver-usage.jsonl` 在前，副本
 * `driver-stream.jsonl` 在后**。账本是逐条同步追加的观测（见 driver-usage-jsonl-sink），
 * 不受保留上限截断，所以同一个 run 有账本时不必再看副本——那份副本缺的正是尾。
 * 升级前跑完的历史 run 只有副本，兜底路径因此必须留着。
 *
 * 完整性判据按通道给：账本没有上限，它缺尾只因「session 在终值到来前就没跑了」，而
 * `cost` 只在 session 结束时来一次，于是「带 cost」就是「拿到终值」的判据；副本仍按
 * 「整份文件未被截断」判定，保持历史行为不变。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DriverStreamEvent } from '../driver/contract';

export interface DriverUsageCost {
  amount: number;
  currency: string;
}

export interface DriverSessionUsage {
  session_id: string;
  role_id?: string;
  context_tokens_used: number;
  context_window_size?: number;
  reported_cost?: DriverUsageCost;
  /** 该 Session 的观测是否可能缺尾（只被截断文件喂过时为 false）。 */
  complete?: boolean;
}

export interface TaskDriverUsage {
  available: boolean;
  source: 'driver_stream_usage_update' | 'unavailable';
  metric: 'context_tokens_used';
  context_tokens_used: number;
  reported_costs: DriverUsageCost[];
  sessions: DriverSessionUsage[];
  /** 全部 Session 都完整时为 true；存在可能缺尾的 Session 时为 false。 */
  complete: boolean;
}

interface MutableSessionUsage extends DriverSessionUsage {
  costObservedAt?: string;
}

/** 一次 usage 观测——折叠的最小单位：session 级累计占用，外加可能到来的终值成本。 */
export type DriverUsageObservation = MutableSessionUsage;

export const DRIVER_USAGE_RECORD_SCHEMA = 'newide.driver-usage-record.v1';

/**
 * `driver-usage.jsonl` 的一行。刻意只装 driver 侧：scaffold 侧的 proxy LLM 账本已经在
 * `telemetry.jsonl`（schema `newide.token_usage.v1`）里逐条落盘且实测完好，两套口径各归
 * 各的文件，join 发生在读的一侧——把两套写进同一个文件才会真的让人相加。
 *
 * `metric` 是必须的自描述：`context_tokens_used` 是**占用观测**，同 session 内重复
 * update 取 max，跨 session 才求和；它和 billed tokens 不是同一个量，读的人不看这个字段
 * 就会算错。
 */
export interface DriverUsageRecord {
  schema_version: typeof DRIVER_USAGE_RECORD_SCHEMA;
  recorded_at: string;
  run_id: string;
  task_id: string;
  /** run 内单调序号，接收点分配；driver 自带的序号每次 invoke 重置，不能当去重键。 */
  stream_sequence: number;
  session_id: string;
  role_id?: string;
  metric: 'context_tokens_used';
  context_tokens_used: number;
  context_window_size?: number;
  /** 只在 session 结束时出现一次；带它的行即该 session 的终值。 */
  reported_cost?: DriverUsageCost;
}

/** 观测 → 账本行。折叠规则留给读的一侧，写只如实记录看到了什么。 */
export function driverUsageRecordFromObservation(
  observation: DriverUsageObservation,
  identity: { run_id: string; task_id: string; stream_sequence: number; recorded_at: string },
): DriverUsageRecord {
  return {
    schema_version: DRIVER_USAGE_RECORD_SCHEMA,
    recorded_at: identity.recorded_at,
    run_id: identity.run_id,
    task_id: identity.task_id,
    stream_sequence: identity.stream_sequence,
    session_id: observation.session_id,
    ...(observation.role_id ? { role_id: observation.role_id } : {}),
    metric: 'context_tokens_used',
    context_tokens_used: observation.context_tokens_used,
    ...(observation.context_window_size !== undefined
      ? { context_window_size: observation.context_window_size }
      : {}),
    ...(observation.reported_cost ? { reported_cost: observation.reported_cost } : {}),
  };
}

/**
 * 账本行 → 观测。字段缺失、schema 不认识或 `metric` 不是本口径的一律跳过：宁可少一个
 * session，也不能把别的口径的数字折进 `context_tokens_used`。
 */
export function driverUsageObservationFromRecord(
  record: Record<string, unknown>,
): DriverUsageObservation | undefined {
  if (record.schema_version !== DRIVER_USAGE_RECORD_SCHEMA) return undefined;
  if (record.metric !== 'context_tokens_used') return undefined;
  const sessionId = nonemptyString(record.session_id);
  const used = finiteNonnegative(record.context_tokens_used);
  if (!sessionId || used === undefined) return undefined;
  const size = finiteNonnegative(record.context_window_size);
  const roleId = nonemptyString(record.role_id);
  const cost = asRecord(record.reported_cost);
  const amount = finiteNonnegative(cost?.amount);
  const currency = nonemptyString(cost?.currency);
  const reportedCost = amount !== undefined && currency ? { amount, currency } : undefined;
  return {
    session_id: sessionId,
    ...(roleId ? { role_id: roleId } : {}),
    context_tokens_used: used,
    ...(size !== undefined ? { context_window_size: size } : {}),
    ...(reportedCost
      ? {
          reported_cost: reportedCost,
          costObservedAt: nonemptyString(record.recorded_at) ?? '',
        }
      : {}),
    complete: reportedCost !== undefined,
  };
}

/**
 * 任务级 usage 累加器：事件流到达即折叠，是 `summary.driver_context_usage` 的正源。
 * 相比回读审计文件，它不受保留上限截断影响——截断只砍文件，砍不到进程内存。
 */
export class TaskDriverUsageAccumulator {
  private readonly sessions = new Map<string, MutableSessionUsage>();

  observe(event: DriverStreamEvent, recordedAt?: string): void {
    const observation = usageObservationFromDriverEvent(
      event,
      recordedAt ?? (event.created_at ?? ''),
      true,
    );
    if (observation) foldUsageObservation(this.sessions, observation);
  }

  finalize(): TaskDriverUsage {
    return finalizeUsageSessions(this.sessions);
  }
}

/**
 * 合并两条数据源：文件回读在前、进程内累加在后（后者更新鲜，cost 冲突时让它赢）。
 * `used`/`size` 取 max 的折叠口径与单源一致，完整标记按「任一完整来源覆盖即完整」。
 */
export function mergeTaskDriverUsage(
  fileScanned: TaskDriverUsage,
  accumulated?: TaskDriverUsage,
): TaskDriverUsage {
  const sessions = new Map<string, MutableSessionUsage>();
  for (const source of [fileScanned, accumulated]) {
    if (!source?.available) continue;
    for (const session of source.sessions) {
      foldUsageObservation(sessions, {
        session_id: session.session_id,
        ...(session.role_id ? { role_id: session.role_id } : {}),
        context_tokens_used: session.context_tokens_used,
        ...(session.context_window_size !== undefined
          ? { context_window_size: session.context_window_size }
          : {}),
        ...(session.reported_cost ? { reported_cost: session.reported_cost } : {}),
        complete: session.complete !== false,
      });
    }
  }
  return finalizeUsageSessions(sessions);
}

/**
 * Project durable ACP usage snapshots into one Task aggregate.
 *
 * 逐个 run 目录读，账本优先：`driver-usage.jsonl` 有记录就不再碰那个 run 的
 * `driver-stream.jsonl`——同一批观测，副本缺的正是尾（实测 council 11,943 行只到前
 * 75 秒，五个角色一个终值都没有）。没有账本的 run（升级前跑的、或关掉开关的）走副本
 * 兜底，那条路径的语义一字未改。
 *
 * 多个 run 目录可以属于同一个 task（council 的续 run），所以全部折叠进同一张表：
 * `used` 取 max、cost 取观测时间最新的一次，跨 session 才求和。
 */
export async function projectTaskDriverUsage(
  runsRoot: string,
  taskId: string,
): Promise<TaskDriverUsage> {
  const sessions = new Map<string, MutableSessionUsage>();
  const runDirectories = await fs.readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  for (const directory of runDirectories) {
    if (!directory.isDirectory()) continue;
    const runDir = path.join(runsRoot, directory.name);
    const ledger = await readUsageLedgerObservations(path.join(runDir, 'driver-usage.jsonl'), taskId);
    const observations =
      ledger.length > 0
        ? ledger
        : await readCappedStreamObservations(path.join(runDir, 'driver-stream.jsonl'), taskId);
    for (const observation of observations) foldUsageObservation(sessions, observation);
  }
  return finalizeUsageSessions(sessions);
}

/** 逐条追加的账本：没有保留上限，所以只需按 task 过滤。 */
async function readUsageLedgerObservations(
  ledgerPath: string,
  taskId: string,
): Promise<MutableSessionUsage[]> {
  const records = await readJsonLines(ledgerPath);
  const observations: MutableSessionUsage[] = [];
  for (const record of records) {
    if (!record || record.task_id !== taskId) continue;
    const observation = driverUsageObservationFromRecord(record);
    if (observation) observations.push(observation);
  }
  return observations;
}

/**
 * 回读 `<runsRoot>/<runId>/driver-stream.jsonl` 的兜底来源；`truncated: true`
 * 标记之后的观测全部缺失，因此该文件喂出的观测都标 `complete: false`。
 */
async function readCappedStreamObservations(
  auditPath: string,
  taskId: string,
): Promise<MutableSessionUsage[]> {
  const records = await readJsonLines(auditPath);
  // 截断标记是文件级事实：标记之后的观测没落盘，标记之前的观测也都缺「后续
  // 更新」——`used` 是累计值，尾部丢了就可能偏小。所以整个文件喂出的观测都
  // 标 complete: false，只把完整性判给进程内的正源。
  const truncated = records.some((record) => record?.truncated === true);
  const observations: MutableSessionUsage[] = [];
  for (const record of records) {
    if (!record) continue;
    if (record.truncated === true) continue;
    if (record.task_id !== taskId) continue;
    const observation = usageObservationFromDriverEvent(
      asRecord(record.event) as unknown as DriverStreamEvent,
      typeof record.recorded_at === 'string' ? record.recorded_at : '',
      !truncated,
    );
    if (observation) observations.push(observation);
  }
  return observations;
}

async function readJsonLines(filePath: string): Promise<Array<Record<string, unknown> | undefined>> {
  const text = await fs.readFile(filePath, 'utf8').catch(() => undefined);
  if (!text) return [];
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => parseJsonRecord(line));
}

/** 从一条 driver 事件提取 usage 观测；非 usage_update 或缺关键字段时返回 undefined。 */
export function usageObservationFromDriverEvent(
  event: DriverStreamEvent | undefined,
  recordedAt: string,
  complete: boolean,
): MutableSessionUsage | undefined {
  const eventType = event?.event_type;
  if (eventType !== 'usage_update') return undefined;
  const payload = asRecord(event?.payload);
  const update = asRecord(payload?.update);
  const used = finiteNonnegative(update?.used);
  const sessionId =
    nonemptyString(event?.session_id) ?? nonemptyString(payload?.sessionId) ?? undefined;
  if (used === undefined || !sessionId) return undefined;
  const size = finiteNonnegative(update?.size);
  const cost = asRecord(update?.cost);
  const amount = finiteNonnegative(cost?.amount);
  const currency = nonemptyString(cost?.currency);
  return {
    session_id: sessionId,
    ...(nonemptyString(event?.role_id) ? { role_id: nonemptyString(event?.role_id)! } : {}),
    context_tokens_used: used,
    ...(size !== undefined ? { context_window_size: size } : {}),
    ...(amount !== undefined && currency
      ? { reported_cost: { amount, currency }, costObservedAt: recordedAt }
      : {}),
    complete,
  };
}

/**
 * 折叠一次观测：累计值取 max、cost 取观测时间最新的一次、完整标记按「任一来源完整
 * 即完整」。文件回读与实时累加共用这一个口径，两条通道才不会分叉。
 */
function foldUsageObservation(
  sessions: Map<string, MutableSessionUsage>,
  observation: MutableSessionUsage,
): void {
  const current = sessions.get(observation.session_id);
  if (!current) {
    sessions.set(observation.session_id, { ...observation });
    return;
  }
  current.context_tokens_used = Math.max(
    current.context_tokens_used,
    observation.context_tokens_used,
  );
  if (observation.context_window_size !== undefined) {
    current.context_window_size = Math.max(
      current.context_window_size ?? 0,
      observation.context_window_size,
    );
  }
  if (!current.role_id && observation.role_id) current.role_id = observation.role_id;
  if (
    observation.reported_cost &&
    (!current.costObservedAt || (observation.costObservedAt ?? '') >= current.costObservedAt)
  ) {
    current.reported_cost = observation.reported_cost;
    current.costObservedAt = observation.costObservedAt ?? '';
  }
  current.complete = current.complete === true || observation.complete === true;
}

function finalizeUsageSessions(sessions: Map<string, MutableSessionUsage>): TaskDriverUsage {
  const projectedSessions = [...sessions.values()]
    .map(({ costObservedAt: _costObservedAt, ...session }) => ({
      ...session,
      complete: session.complete !== false,
    }))
    .sort((left, right) => left.session_id.localeCompare(right.session_id));
  const costByCurrency = new Map<string, number>();
  for (const session of projectedSessions) {
    if (!session.reported_cost) continue;
    costByCurrency.set(
      session.reported_cost.currency,
      (costByCurrency.get(session.reported_cost.currency) ?? 0) + session.reported_cost.amount,
    );
  }
  return {
    available: projectedSessions.length > 0,
    source: projectedSessions.length > 0 ? 'driver_stream_usage_update' : 'unavailable',
    metric: 'context_tokens_used',
    context_tokens_used: projectedSessions.reduce(
      (total, session) => total + session.context_tokens_used,
      0,
    ),
    reported_costs: [...costByCurrency.entries()]
      .map(([currency, amount]) => ({ amount, currency }))
      .sort((left, right) => left.currency.localeCompare(right.currency)),
    sessions: projectedSessions,
    complete: projectedSessions.length > 0 && projectedSessions.every((s) => s.complete),
  };
}

function parseJsonRecord(line: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function isDriverStreamUsage(value: unknown): value is TaskDriverUsage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.available === true &&
    record.source === 'driver_stream_usage_update' &&
    typeof record.context_tokens_used === 'number' &&
    Number.isFinite(record.context_tokens_used)
  );
}

/**
 * 择优写入 summary：**完整优先于数值大**。来自截断文件的残缺数字再大也不能盖过
 * 完整观测；双方都完整或都不完整时才比 `context_tokens_used`。老 summary 里没有
 * `complete` 字段的一律按完整处理（与旧行为一致）。
 */
export function preferDriverUsage(
  existing: unknown,
  projected?: TaskDriverUsage,
): TaskDriverUsage | undefined {
  const current = isDriverStreamUsage(existing) ? existing : undefined;
  if (!projected?.available) return current;
  if (!current) return projected;
  const projectedComplete = projected.complete !== false;
  const currentComplete = current.complete !== false;
  if (projectedComplete !== currentComplete) return projectedComplete ? projected : current;
  return projected.context_tokens_used > current.context_tokens_used ? projected : current;
}
