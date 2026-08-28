import { promises as fs } from 'node:fs';
import path from 'node:path';

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
}

export interface TaskDriverUsage {
  available: boolean;
  source: 'driver_stream_usage_update' | 'unavailable';
  metric: 'context_tokens_used';
  context_tokens_used: number;
  reported_costs: DriverUsageCost[];
  sessions: DriverSessionUsage[];
}

interface MutableSessionUsage extends DriverSessionUsage {
  costObservedAt?: string;
}

/**
 * Project durable ACP usage snapshots into one Task aggregate.
 * `usage_update.used` is a cumulative context observation, so repeated updates are
 * collapsed per Session instead of being added together.
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
    for (const line of audit.split('\n')) {
      if (!line.trim()) continue;
      const observation = parseUsageObservation(line, taskId);
      if (!observation) continue;
      const current = sessions.get(observation.session_id);
      if (!current) {
        sessions.set(observation.session_id, { ...observation });
        continue;
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
        (!current.costObservedAt ||
          (observation.costObservedAt ?? '') >= current.costObservedAt)
      ) {
        current.reported_cost = observation.reported_cost;
        current.costObservedAt = observation.costObservedAt ?? '';
      }
    }
  }

  const projectedSessions = [...sessions.values()]
    .map(({ costObservedAt: _costObservedAt, ...session }) => session)
    .sort((left, right) => left.session_id.localeCompare(right.session_id));
  const costByCurrency = new Map<string, number>();
  for (const session of projectedSessions) {
    if (!session.reported_cost) continue;
    costByCurrency.set(
      session.reported_cost.currency,
      (costByCurrency.get(session.reported_cost.currency) ?? 0) +
        session.reported_cost.amount,
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
  };
}

function parseUsageObservation(
  line: string,
  taskId: string,
): MutableSessionUsage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (!record || record.task_id !== taskId) return undefined;
  const event = asRecord(record.event);
  if (!event || event.event_type !== 'usage_update') return undefined;
  const payload = asRecord(event.payload);
  const update = asRecord(payload?.update);
  const used = finiteNonnegative(update?.used);
  const sessionId = nonemptyString(event.session_id) ?? nonemptyString(payload?.sessionId);
  if (used === undefined || !sessionId) return undefined;
  const size = finiteNonnegative(update?.size);
  const cost = asRecord(update?.cost);
  const amount = finiteNonnegative(cost?.amount);
  const currency = nonemptyString(cost?.currency);
  return {
    session_id: sessionId,
    ...(nonemptyString(event.role_id) ? { role_id: nonemptyString(event.role_id)! } : {}),
    context_tokens_used: used,
    ...(size !== undefined ? { context_window_size: size } : {}),
    ...(amount !== undefined && currency
      ? { reported_cost: { amount, currency }, costObservedAt: String(record.recorded_at ?? '') }
      : {}),
  };
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

export function preferDriverUsage(
  existing: unknown,
  projected?: TaskDriverUsage,
): TaskDriverUsage | undefined {
  const current = isDriverStreamUsage(existing) ? existing : undefined;
  if (!projected?.available) return current;
  if (!current || projected.context_tokens_used > current.context_tokens_used) return projected;
  return current;
}
