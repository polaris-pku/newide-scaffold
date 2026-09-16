/**
 * guards — 跑实验前的花费闸门（纯函数，可离线单测）
 *
 * 起因是一次实测事故：驱动客户端在 system prompt 的第 0 个块里注入了一个每请求都变的
 * `cch` 字段，前缀因此永远无法复用，**缓存从未命中**。同样的调用序列从 ~1/10 的价钱
 * 变成全价，一轮 16 格烧掉 2470 万全价输入 token。三个闸门针对的都是这件事：
 *
 *   1. `cacheGuard`   —— 一格跑完就看缓存读是否为 0。是就停，不等跑完 16 格。
 *   2. `cellCostGuard`—— 单格的实时花费上限（按 driver 自己报的 USD），由 harness 取消该格。
 *   3. `runCostGuard` —— 整轮累计花费上限，跨格累加，超了就停。
 *   4. `consecutiveFailureGuard` —— 连续若干格失败就停，用来掐掉额度耗尽那类整片失败。
 *
 * 闸门判据刻意**不**依赖任何估算公式：USD 与缓存读都是 driver 自报的实测值。
 * 缺读数（`undefined`）一律放行——取不到数不该把实验判死，那是 driver-usage 里
 * `unavailable_reason` 的职责。
 */
import type { DriverTokenEvidence } from './driver-usage';

export interface GuardVerdict {
  ok: boolean;
  /** 不通过时的完整说明（含已花费金额与可用的豁免开关），直接抛给用户 */
  reason?: string;
}

/** 单格：driver 报了几次推理、其中缓存读为零 → 缓存从未命中 */
export const ZERO_CACHE_MIN_CALLS = 2;

/**
 * 缓存闸门。
 *
 * 判据是「有 ≥2 次推理、但缓存读为 0」：一次调用的格子本来就没有可复用的前缀，不构成证据；
 * 两次以上还没有一个读命中，就只能是前缀不可复用（或网关不回该字段）。
 *
 * 为什么值得把它做成硬闸门：这是**静默**失效。产出照常有、终态照常 completed、单元证据
 * 照常落盘，只有账单是十倍。事后从 cells.jsonl 里看不出来。
 */
export function cacheGuard(
  driverTokens: DriverTokenEvidence | undefined,
  options: { allowZeroCache: boolean; spentUsd?: number },
): GuardVerdict {
  if (options.allowZeroCache) return { ok: true };
  if (!driverTokens) return { ok: true };
  if (driverTokens.call_count < ZERO_CACHE_MIN_CALLS) return { ok: true };
  if (driverTokens.cache_read_input_tokens > 0) return { ok: true };

  const spent =
    options.spentUsd === undefined ? '' : ` This cell reported $${options.spentUsd.toFixed(4)}.`;
  return {
    ok: false,
    reason:
      `driver made ${String(driverTokens.call_count)} inference call(s) with zero cache reads ` +
      `(${String(driverTokens.billed_input_tokens)} input tokens billed at full price). ` +
      'This is not a low hit rate — the prefix was never reusable, so every call pays for the ' +
      'whole context again.' +
      spent +
      ' Known causes: the driver client build (the ACP package\'s bundled Claude Code) writes a ' +
      'per-request `cch` value into the first system block, or the active gateway does not strip ' +
      'the `x-anthropic-billing-header` block. See eval/role-divergence/README.md. ' +
      'Pass --allow-zero-cache to run anyway.',
  };
}

/**
 * 从单元证据的 `driver_usage` 里取本格 driver 自报花费（USD）。
 *
 * 宽松取数：这一列来自驱动轨迹的 `usage_update.cost`，字段名换过、也可能整个缺席，
 * 取不到就返回 undefined（= 这道闸不设），绝不猜一个数出来当账单。
 */
export function cellCostUsd(driverUsage: unknown): number | undefined {
  if (!driverUsage || typeof driverUsage !== 'object') return undefined;
  const costs = (driverUsage as { reported_costs?: unknown }).reported_costs;
  if (!Array.isArray(costs)) return undefined;
  const amounts = costs
    .map((entry) =>
      entry && typeof entry === 'object' ? (entry as { amount?: unknown }).amount : undefined,
    )
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return amounts.length === 0 ? undefined : Math.max(...amounts);
}

/** 单格实时花费上限（USD）。`spent` 取 driver 轨迹里累计 `cost.amount` 的峰值。 */
export function cellCostGuard(spentUsd: number, capUsd: number, cellId: string): GuardVerdict {
  if (!Number.isFinite(spentUsd) || spentUsd <= capUsd) return { ok: true };
  return {
    ok: false,
    reason:
      `cell ${cellId} reached $${spentUsd.toFixed(4)} of driver-reported cost, over the ` +
      `$${capUsd.toFixed(2)} per-cell cap. Cancelled to stop the spend. ` +
      'Raise it with --max-cell-cost-usd if this cell is legitimately expensive.',
  };
}

/** 整轮累计花费上限（USD）。`spent` 是本轮**已花**的累计值，不含被跳过的历史格子。 */
export function runCostGuard(spentUsd: number, capUsd: number, cellsDone: number): GuardVerdict {
  if (!Number.isFinite(spentUsd) || spentUsd <= capUsd) return { ok: true };
  return {
    ok: false,
    reason:
      `run stopped after ${String(cellsDone)} cell(s): cumulative driver cost $${spentUsd.toFixed(4)} ` +
      `exceeded the $${capUsd.toFixed(2)} run cap. Completed cells are cached, so re-running with ` +
      'a higher --max-run-cost-usd resumes without paying for them again.',
  };
}

/**
 * 连败熔断：连续多少格失败就停下。
 *
 * 取 3 而不是 2：实测的孤立失败（撞 45 分钟时限、撞 $10 单格上限、撞 120k 上下文上限）
 * 都是**单格**事件，前后都夹着成功格，连不成串；而额度耗尽那类整片失败是连着来的。
 * 门槛落在两者之间，既不误伤离群格，又能在第 3 格就停住，而不是把剩下的待跑格全判失败。
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 连败闸门。
 *
 * 起因是实测事故：token 额度耗尽后，driver 的请求直接失败，每格都写成 `failed`
 * （错误是「driver produced no review.md」，缓存读为 0）。**其余三道具都拦不住它**——
 * `cacheGuard` 要求 ≥2 次推理才判，而多数格一次调用都没发出去；`cellCostGuard` 和
 * `runCostGuard` 都看 driver 自报花费，失败格压根没花钱。于是它会一路把剩余待跑格
 * 逐格判失败，空转到底。
 *
 * 判据只看「连着失败了几格」，不看失败原因——额度耗尽、网络断、供应商挂掉都会长成
 * 这个样子。失败格不是 `completed`，所以这里停下是**无损**的：续跑时会自动重试。
 */
export function consecutiveFailureGuard(streak: number, cellId: string): GuardVerdict {
  if (!Number.isFinite(streak) || streak < MAX_CONSECUTIVE_FAILURES) return { ok: true };
  return {
    ok: false,
    reason:
      `run stopped after ${String(streak)} consecutive failed cells (last: ${cellId}). ` +
      'A single isolated failure is normal (timeout, per-cell cost cap), but a run of them ' +
      'usually means the provider is refusing requests — an exhausted token quota, a revoked ' +
      'key, or an outage. Nothing was lost: failed cells are not "completed", so re-running the ' +
      'same command retries exactly them and skips everything already finished.',
  };
}

/**
 * 整轮上限的默认值：按**待跑**格数给，而不是按总格数。
 *
 * 已完成单元会被跳过、不再花钱，所以用总格数当基数会让续跑一开局就被判超限。
 * 每格预算取 `perCellUsd`（默认 $3，实测中位 $1.45、最高 $3.39），下有 `minimumUsd`
 * 保底，避免只有一格时上限低到把正常花费也拦掉。
 */
export function resolveRunCostCap(input: {
  explicitUsd?: number;
  pendingCells: number;
  perCellUsd: number;
  minimumUsd: number;
}): number {
  if (input.explicitUsd !== undefined && Number.isFinite(input.explicitUsd)) {
    return input.explicitUsd;
  }
  return Math.max(input.minimumUsd, input.perCellUsd * Math.max(input.pendingCells, 1));
}
