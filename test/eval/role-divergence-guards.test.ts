/**
 * guards — 花费闸门的离线守卫
 *
 * 守的是那次事故的形态：驱动客户端把每请求都变的 `cch` 写进 system prompt 第 0 块，
 * 前缀永远无法复用，缓存**从未命中**。它的可怕之处在于完全静默——产出照常有、终态
 * 照常 completed、证据照常落盘，只有账单是十倍。所以这里逐条钉死四件事：
 *
 *   1. 缓存闸门必须在「有 ≥2 次推理、缓存读为 0」时拦下，且不能误伤单次调用的格子；
 *   2. 花费闸门只在**拿到实测数**时才拦——取不到读数一律放行，缺读数不等于零花费；
 *   3. 整轮上限的基数必须是**待跑**格数，否则续跑一开局就被自己判超限；
 *   4. 连败闸门要在整片失败时拦下，且**不能**误伤实测里那些孤立失败（每次前后都夹着成功格）。
 */
import { describe, expect, it } from 'vitest';
import { emptyDriverTokenEvidence, type DriverTokenEvidence } from '../../eval/role-divergence/driver-usage';
import {
  cacheGuard,
  cellCostGuard,
  cellCostUsd,
  consecutiveFailureGuard,
  MAX_CONSECUTIVE_FAILURES,
  resolveRunCostCap,
  runCostGuard,
} from '../../eval/role-divergence/guards';

const tokens = (overrides: Partial<DriverTokenEvidence>): DriverTokenEvidence => ({
  ...emptyDriverTokenEvidence('test fixture'),
  ...overrides,
});

/** 实测形态：一次正常的 agent loop，前缀被复用 */
const cachedCell = tokens({
  call_count: 12,
  cache_read_input_tokens: 187_392,
  input_tokens: 4_100,
  billed_input_tokens: 191_492,
  cache_read_ratio: 0.9786,
});

/** 事故形态：12 次推理，缓存读恒为 0 */
const poisonedCell = tokens({
  call_count: 12,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  input_tokens: 957_019,
  billed_input_tokens: 957_019,
  cache_read_ratio: 0,
});

describe('cacheGuard', () => {
  it('缓存读为零但有多次推理 → 拦下，并给出成因与豁免开关', () => {
    const verdict = cacheGuard(poisonedCell, { allowZeroCache: false, spentUsd: 3.42 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('zero cache reads');
    expect(verdict.reason).toContain('12');
    expect(verdict.reason).toContain('$3.4200');
    expect(verdict.reason).toContain('--allow-zero-cache');
    expect(verdict.reason).toContain('cch');
  });

  it('命中率低也算通过——判据是「零」不是「低」', () => {
    const lowHit = tokens({ ...cachedCell, cache_read_ratio: 0.01, cache_read_input_tokens: 64 });
    expect(cacheGuard(lowHit, { allowZeroCache: false }).ok).toBe(true);
  });

  it('只跑过一次推理的格子不算证据', () => {
    const single = tokens({ call_count: 1, cache_read_input_tokens: 0, input_tokens: 19_401 });
    expect(cacheGuard(single, { allowZeroCache: false }).ok).toBe(true);
  });

  it('取不到台账时放行——缺读数不等于零花费', () => {
    expect(cacheGuard(undefined, { allowZeroCache: false }).ok).toBe(true);
  });

  it('--allow-zero-cache 显式放行', () => {
    expect(cacheGuard(poisonedCell, { allowZeroCache: true }).ok).toBe(true);
  });
});

describe('cellCostGuard', () => {
  it('未超上限放行', () => {
    expect(cellCostGuard(3.39, 10, 'cell-a').ok).toBe(true);
  });

  it('超上限拦下并点出旗标', () => {
    const verdict = cellCostGuard(15.5, 10, 'cell-a');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('cell-a');
    expect(verdict.reason).toContain('$15.5000');
    expect(verdict.reason).toContain('--max-cell-cost-usd');
  });

  it('读不到花费（NaN）不拦', () => {
    expect(cellCostGuard(Number.NaN, 10, 'cell-a').ok).toBe(true);
  });
});

describe('runCostGuard', () => {
  it('未超整轮上限放行', () => {
    expect(runCostGuard(22.15, 48, 16).ok).toBe(true);
  });

  it('超整轮上限拦下，并说明续跑无损', () => {
    const verdict = runCostGuard(60, 48, 16);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('$60.0000');
    expect(verdict.reason).toContain('$48.00');
    expect(verdict.reason).toContain('--max-run-cost-usd');
  });
});

describe('resolveRunCostCap', () => {
  it('显式值优先', () => {
    expect(
      resolveRunCostCap({ explicitUsd: 5, pendingCells: 100, perCellUsd: 3, minimumUsd: 15 }),
    ).toBe(5);
  });

  it('缺省按待跑格数推算', () => {
    expect(resolveRunCostCap({ pendingCells: 16, perCellUsd: 3, minimumUsd: 15 })).toBe(48);
  });

  it('格数很少时由下限兜底，免得正常花费也被拦', () => {
    expect(resolveRunCostCap({ pendingCells: 1, perCellUsd: 3, minimumUsd: 15 })).toBe(15);
  });
});

describe('cellCostUsd', () => {
  it('取 reported_costs 里的金额', () => {
    expect(cellCostUsd({ reported_costs: [{ amount: 1.4502, currency: 'USD' }] })).toBe(1.4502);
  });

  it('多条取最大——那是会话累计值', () => {
    expect(cellCostUsd({ reported_costs: [{ amount: 0.9 }, { amount: 3.39 }] })).toBe(3.39);
  });

  it('字段缺席/畸形一律 undefined，不猜一个数当账单', () => {
    expect(cellCostUsd(undefined)).toBeUndefined();
    expect(cellCostUsd({})).toBeUndefined();
    expect(cellCostUsd({ reported_costs: [{ currency: 'USD' }] })).toBeUndefined();
    expect(cellCostUsd({ reported_costs: 'nope' })).toBeUndefined();
  });
});

describe('consecutiveFailureGuard', () => {
  it('孤立失败放行——实测的时限/花费/上下文超限都是单格事件', () => {
    expect(consecutiveFailureGuard(1, 'cell_a').ok).toBe(true);
    expect(consecutiveFailureGuard(2, 'cell_a').ok).toBe(true);
  });

  it('连续失败到门槛就拦下', () => {
    const verdict = consecutiveFailureGuard(MAX_CONSECUTIVE_FAILURES, 'cell_c');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('cell_c');
  });

  it('门槛高于 2——两连败在实测里只是巧合', () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBeGreaterThan(2);
  });

  it('说明里必须点明续跑无损、失败格会被重试', () => {
    const verdict = consecutiveFailureGuard(MAX_CONSECUTIVE_FAILURES, 'cell_c');
    expect(verdict.reason).toContain('retries');
    expect(verdict.reason).toContain('quota');
  });

  it('拿不到计数（NaN）不拦——缺读数不该把实验判死', () => {
    expect(consecutiveFailureGuard(Number.NaN, 'cell_a').ok).toBe(true);
  });
});
