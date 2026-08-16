/**
 * Bounded IO previews for trajectory payloads.
 *
 * 轨迹记录的入参/出参（payload.input / payload.output）统一走这里有界序列化：
 * 字符串截断、数组截取、深度保护、循环引用保护、总预算兜底，保证每条
 * trajectory.jsonl 记录的体积可控；完整内容仍留在 artifacts / audit。
 */
export interface TraceIoLimits {
  /** 单个字符串值保留的最大字符数。 */
  string: number;
  /** 数组保留的最大项数（超出部分汇总为 “…N more”）。 */
  arrayItems: number;
  /** 对象最大嵌套深度，更深的值整体降级为截断的 JSON 字符串。 */
  depth: number;
  /** input / output 单侧序列化后的近似字符预算。 */
  budget: number;
}

export const TRACE_IO_LIMITS: TraceIoLimits = {
  string: 400,
  arrayItems: 8,
  depth: 4,
  budget: 2000,
};

const OMITTED = '[omitted: trace io budget exhausted]';
const CIRCULAR = '[circular reference]';
const MORE = (count: number): string => `…${String(count)} more`;

/** Exported for tests and callers that only need string truncation. */
export function truncatePreview(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

interface Budget {
  remaining: number;
}

function spend(budget: Budget, chars: number): void {
  budget.remaining -= chars;
}

function exhausted(budget: Budget): boolean {
  return budget.remaining <= 0;
}

function previewValue(
  value: unknown,
  limits: TraceIoLimits,
  budget: Budget,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (exhausted(budget)) return OMITTED;
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string') {
    const str = value as string;
    spend(budget, Math.min(str.length, limits.string));
    return truncatePreview(str, limits.string);
  }
  if (type === 'number') {
    spend(budget, 8);
    return Number.isFinite(value as number) ? value : String(value);
  }
  if (type === 'boolean') {
    spend(budget, 5);
    return value;
  }
  if (type === 'bigint' || type === 'function' || type === 'symbol') {
    const str = String(value);
    spend(budget, Math.min(str.length, limits.string));
    return truncatePreview(str, limits.string);
  }
  if (type !== 'object') return null;

  const obj = value as object;
  if (seen.has(obj)) return CIRCULAR;
  if (depth >= limits.depth) {
    const str = safeStringify(obj);
    spend(budget, Math.min(str.length, limits.string));
    return truncatePreview(str, limits.string);
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.slice(0, limits.arrayItems).map((item) =>
        previewValue(item, limits, budget, seen, depth + 1),
      );
      if (obj.length > limits.arrayItems) {
        items.push(MORE(obj.length - limits.arrayItems));
      }
      return items;
    }
    if (!isPlainObject(obj)) {
      // Date / Map / class instances: fall back to a bounded JSON string.
      const str = safeStringify(obj);
      spend(budget, Math.min(str.length, limits.string));
      return truncatePreview(str, limits.string);
    }
    const preview: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj)) {
      if (entry === undefined) continue;
      if (exhausted(budget)) {
        preview[key] = OMITTED;
        break;
      }
      preview[key] = previewValue(entry, limits, budget, seen, depth + 1);
    }
    return preview;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Bounded, JSON-safe preview of any value. Strings are truncated, arrays
 * capped, deep structures flattened, and a total character budget bounds the
 * result so a single trajectory record stays small.
 */
export function boundedPreview(value: unknown, limits: Partial<TraceIoLimits> = {}): unknown {
  const config: TraceIoLimits = { ...TRACE_IO_LIMITS, ...limits };
  const budget: Budget = { remaining: config.budget };
  const preview = previewValue(value, config, budget, new WeakSet(), 0);
  return preview === undefined ? null : preview;
}

function hasSide(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

/**
 * Build the uniform trajectory payload `{ input?, output? }` with bounded
 * previews; empty sides are omitted, and undefined is returned when both
 * sides are empty.
 */
export function ioPayload(
  sides: { input?: unknown; output?: unknown },
  limits: Partial<TraceIoLimits> = {},
): Record<string, unknown> | undefined {
  const payload: Record<string, unknown> = {};
  if (hasSide(sides.input)) payload.input = boundedPreview(sides.input, limits);
  if (hasSide(sides.output)) payload.output = boundedPreview(sides.output, limits);
  return Object.keys(payload).length > 0 ? payload : undefined;
}
