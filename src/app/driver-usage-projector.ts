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

/**
 * 任务级 usage 累加器：事件流到达即折叠，是 `summary.driver_usage` 的正源。
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
 * 回读 `<runsRoot>/<runId>/driver-stream.jsonl` 的兜底来源；`truncated: true`
 * 标记之后的观测全部缺失，因此该文件喂出的观测都标 `complete: false`。
 */
export async function projectTaskDriverUsage(
  runsRoot: string,
  taskId: string,
): Promise<TaskDriverUsage> {
  const sessions = new Map<string, MutableSessionUsage>();
  const runDirectories = await fs.readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  for (const directory of runDirectories) {
    if (!directory.isDirectory()) continue;
    const auditPath = path.join(runsRoot, directory.name, 'driver-stream.jsonl');
    const audit = await fs.readFile(auditPath, 'utf8').catch(() => undefined);
    if (!audit) continue;
    // 截断标记是文件级事实：标记之后的观测没落盘，标记之前的观测也都缺「后续
    // 更新」——`used` 是累计值，尾部丢了就可能偏小。所以整个文件喂出的观测都
    // 标 complete: false，只把完整性判给进程内的正源。
    const records = audit
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => parseJsonRecord(line));
    const truncated = records.some((record) => record?.truncated === true);
    for (const record of records) {
      if (!record) continue;
      if (record.truncated === true) continue;
      if (record.task_id !== taskId) continue;
      const observation = usageObservationFromDriverEvent(
        asRecord(record.event) as unknown as DriverStreamEvent,
        typeof record.recorded_at === 'string' ? record.recorded_at : '',
        !truncated,
      );
      if (!observation) continue;
      foldUsageObservation(sessions, observation);
    }
  }
  return finalizeUsageSessions(sessions);
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
