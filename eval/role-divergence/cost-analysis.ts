/**
 * cost-analysis — 把逐格计费台账汇成「钱花在哪、缓存有没有生效」的报告
 *
 * 纯聚合与格式化，不碰文件系统：读取由 `report-cost.ts` 负责，这样口径可以离线单测，
 * 也能对已有结果反复重算而不必重跑实验。
 *
 * 三个必须一起看的读数（只看其中一个都会得出错误结论）：
 *   1. `billed_input_tokens` —— 计费意义上的输入总量。回答「花了多少」。
 *   2. `cache_read_ratio`   —— 缓存命中率。回答「缓存有没有在工作」。
 *   3. `effective_input_tokens` —— 加权后的等价全价量。回答「缓存省了多少」。
 * 只有 1 而没有 2/3，就会把「零命中导致的巨额全价开销」误当成「实验本来就这么贵」。
 */
import type { DriverTokenEvidence } from './driver-usage';

export interface CellCostInput {
  cell_id: string;
  experiment: string;
  role_key: string;
  status: string;
  wall_ms?: number;
  driver_tokens?: DriverTokenEvidence;
  driver_tokens_error?: string;
  /** 顶层 Agent 侧的记账（走 AI SDK，含它自己的缓存读数） */
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    total_input_tokens?: number;
    total_tokens?: number;
    call_count?: number;
  };
}

export interface CostBucket {
  key: string;
  cells: number;
  billed_input_tokens: number;
  effective_input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_ratio: number;
  cache_saved_input_tokens: number;
  driver_call_count: number;
}

export interface CellCostRow {
  cell_id: string;
  experiment: string;
  role_key: string;
  status: string;
  driver_call_count: number;
  billed_input_tokens: number;
  effective_input_tokens: number;
  cache_read_ratio: number;
  output_tokens: number;
  peak_call_input_tokens: number;
  first_call_input_tokens: number;
  wall_ms: number;
  agent_tokens: number;
  note?: string;
}

export interface CostAnalysis {
  schema_version: 'newide.role_divergence.cost.v1';
  cells_total: number;
  cells_with_driver_usage: number;
  cells_without_driver_usage: number;
  /** 逐格台账缺失的原因汇总，缺省 ≠ 零花费 */
  missing_reasons: Record<string, number>;
  totals: CostBucket;
  by_experiment: CostBucket[];
  by_role: CostBucket[];
  worst_cells: CellCostRow[];
  /** 顶层 Agent 侧合计（与 driver 侧分开看：driver 占绝对多数） */
  agent_totals: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    cache_read_ratio: number;
    call_count: number;
  };
}

function emptyBucket(key: string): CostBucket {
  return {
    key,
    cells: 0,
    billed_input_tokens: 0,
    effective_input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_ratio: 0,
    cache_saved_input_tokens: 0,
    driver_call_count: 0,
  };
}

function addToBucket(bucket: CostBucket, evidence: DriverTokenEvidence): void {
  bucket.cells += 1;
  bucket.billed_input_tokens += evidence.billed_input_tokens;
  bucket.effective_input_tokens += evidence.effective_input_tokens;
  bucket.output_tokens += evidence.output_tokens;
  bucket.cache_read_input_tokens += evidence.cache_read_input_tokens;
  bucket.cache_creation_input_tokens += evidence.cache_creation_input_tokens;
  bucket.driver_call_count += evidence.call_count;
}

function finalizeBucket(bucket: CostBucket): CostBucket {
  const billed = bucket.billed_input_tokens;
  return {
    ...bucket,
    cache_read_ratio: billed > 0 ? Math.round((bucket.cache_read_input_tokens / billed) * 10000) / 10000 : 0,
    cache_saved_input_tokens: billed - bucket.effective_input_tokens,
  };
}

function group(cells: readonly CellCostInput[], keyOf: (cell: CellCostInput) => string): CostBucket[] {
  const buckets = new Map<string, CostBucket>();
  for (const cell of cells) {
    const evidence = cell.driver_tokens;
    // 无台账的格不计入任何花销桶——但它会被 missing_reasons 单独计数，
    // 不会静默消失在分母之外。
    if (!evidence || evidence.call_count === 0) continue;
    const key = keyOf(cell);
    const bucket = buckets.get(key) ?? emptyBucket(key);
    addToBucket(bucket, evidence);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map(finalizeBucket)
    .sort((left, right) => right.billed_input_tokens - left.billed_input_tokens);
}

export function analyzeCosts(cells: readonly CellCostInput[]): CostAnalysis {
  const totals = emptyBucket('all');
  const missingReasons: Record<string, number> = {};
  let withUsage = 0;

  for (const cell of cells) {
    const evidence = cell.driver_tokens;
    if (evidence && evidence.call_count > 0) {
      withUsage += 1;
      addToBucket(totals, evidence);
      continue;
    }
    const reason =
      cell.driver_tokens_error ??
      evidence?.unavailable_reason ??
      'no driver_tokens recorded (cell predates this instrumentation)';
    missingReasons[reason] = (missingReasons[reason] ?? 0) + 1;
  }

  const rows: CellCostRow[] = cells.map((cell) => {
    const evidence = cell.driver_tokens;
    const agent = cell.token_usage;
    const agentTokens =
      (agent?.total_tokens ?? 0) ||
      (agent?.input_tokens ?? 0) +
        (agent?.output_tokens ?? 0) +
        (agent?.cache_creation_input_tokens ?? 0) +
        (agent?.cache_read_input_tokens ?? 0);
    return {
      cell_id: cell.cell_id,
      experiment: cell.experiment,
      role_key: cell.role_key,
      status: cell.status,
      driver_call_count: evidence?.call_count ?? 0,
      billed_input_tokens: evidence?.billed_input_tokens ?? 0,
      effective_input_tokens: evidence?.effective_input_tokens ?? 0,
      cache_read_ratio: evidence?.cache_read_ratio ?? 0,
      output_tokens: evidence?.output_tokens ?? 0,
      peak_call_input_tokens: evidence?.max_call_input_tokens ?? 0,
      first_call_input_tokens: evidence?.first_call_input_tokens ?? 0,
      wall_ms: cell.wall_ms ?? 0,
      agent_tokens: agentTokens,
      ...(evidence?.unavailable_reason ? { note: evidence.unavailable_reason } : {}),
      ...(cell.driver_tokens_error ? { note: cell.driver_tokens_error } : {}),
    };
  });

  const agentInput = cells.reduce((sum, cell) => sum + (cell.token_usage?.input_tokens ?? 0), 0);
  const agentOutput = cells.reduce((sum, cell) => sum + (cell.token_usage?.output_tokens ?? 0), 0);
  const agentCacheRead = cells.reduce(
    (sum, cell) => sum + (cell.token_usage?.cache_read_input_tokens ?? 0),
    0,
  );
  const agentCacheWrite = cells.reduce(
    (sum, cell) => sum + (cell.token_usage?.cache_creation_input_tokens ?? 0),
    0,
  );
  const agentBilled = agentInput + agentCacheRead + agentCacheWrite;

  return {
    schema_version: 'newide.role_divergence.cost.v1',
    cells_total: cells.length,
    cells_with_driver_usage: withUsage,
    cells_without_driver_usage: cells.length - withUsage,
    missing_reasons: missingReasons,
    totals: finalizeBucket(totals),
    by_experiment: group(cells, (cell) => cell.experiment),
    by_role: group(cells, (cell) => cell.role_key),
    worst_cells: rows
      .filter((row) => row.driver_call_count > 0)
      .sort((left, right) => right.billed_input_tokens - left.billed_input_tokens)
      .slice(0, 10),
    agent_totals: {
      input_tokens: agentInput,
      output_tokens: agentOutput,
      cache_creation_input_tokens: agentCacheWrite,
      cache_read_input_tokens: agentCacheRead,
      cache_read_ratio: agentBilled > 0 ? Math.round((agentCacheRead / agentBilled) * 10000) / 10000 : 0,
      call_count: cells.reduce((sum, cell) => sum + (cell.token_usage?.call_count ?? 0), 0),
    },
  };
}

const num = (value: number): string => value.toLocaleString('en-US');
const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;

/** 人看的报告。数字全部带千分位，比值一律百分数——避免手读时错位。 */
export function formatCostReport(analysis: CostAnalysis): string {
  const lines: string[] = [];
  const t = analysis.totals;

  lines.push('角色分歧实验 — token 花费与缓存命中');
  lines.push('='.repeat(64));
  lines.push(
    `格子：${String(analysis.cells_total)} 个，其中 ${String(analysis.cells_with_driver_usage)} 个有 driver 台账` +
      (analysis.cells_without_driver_usage > 0
        ? `，${String(analysis.cells_without_driver_usage)} 个缺（见下）`
        : ''),
  );
  lines.push('');
  lines.push('【driver（Claude Code）合计】');
  lines.push(`  推理次数                ${num(t.driver_call_count)}`);
  lines.push(`  计费输入（全价当量）    ${num(t.billed_input_tokens)}`);
  lines.push(`    其中全价输入          ${num(t.billed_input_tokens - t.cache_read_input_tokens - t.cache_creation_input_tokens)}`);
  lines.push(`    其中缓存写（1.25x）   ${num(t.cache_creation_input_tokens)}`);
  lines.push(`    其中缓存读（0.1x）    ${num(t.cache_read_input_tokens)}`);
  lines.push(`  输出                    ${num(t.output_tokens)}`);
  lines.push(`  实际加权花费            ${num(t.effective_input_tokens)}`);
  lines.push(`  缓存节省                ${num(t.cache_saved_input_tokens)}`);
  lines.push(`  缓存命中率              ${pct(t.cache_read_ratio)}`);
  lines.push('');
  lines.push('【顶层 Agent 侧合计（走 AI SDK，量级远小于 driver）】');
  lines.push(`  调用次数                ${num(analysis.agent_totals.call_count)}`);
  lines.push(
    `  输入/输出               ${num(analysis.agent_totals.input_tokens)} / ${num(analysis.agent_totals.output_tokens)}`,
  );
  lines.push(`  缓存命中率              ${pct(analysis.agent_totals.cache_read_ratio)}`);
  lines.push('');

  const verdict =
    t.billed_input_tokens === 0
      ? '无数据'
      : t.cache_read_ratio === 0
        ? `零命中 —— ${num(t.billed_input_tokens)} token 全部按全价计费，缓存一点没省`
        : `命中 ${pct(t.cache_read_ratio)}，较全价省下 ${num(t.cache_saved_input_tokens)} 全价当量`;
  lines.push(`结论：${verdict}`);
  if (t.cache_read_input_tokens === 0 && t.billed_input_tokens > 0) {
    lines.push(
      `      若这些输入全部命中缓存，加权花费会从 ${num(t.effective_input_tokens)} 降到约 ` +
        `${num(Math.round(t.billed_input_tokens * 0.1))}（约 1/10）。`,
    );
  }
  lines.push('');

  if (analysis.by_experiment.length > 0) {
    lines.push('【按实验】');
    lines.push('  实验              格数   推理    计费输入        命中率    加权花费');
    for (const bucket of analysis.by_experiment) {
      lines.push(
        `  ${bucket.key.padEnd(17)}${String(bucket.cells).padStart(3)}` +
          `${String(bucket.driver_call_count).padStart(7)}` +
          `${num(bucket.billed_input_tokens).padStart(15)}` +
          `${pct(bucket.cache_read_ratio).padStart(10)}` +
          `${num(bucket.effective_input_tokens).padStart(13)}`,
      );
    }
    lines.push('');
  }

  if (analysis.by_role.length > 0) {
    lines.push('【按角色】');
    lines.push('  角色              格数   推理    计费输入        命中率    加权花费');
    for (const bucket of analysis.by_role) {
      lines.push(
        `  ${bucket.key.padEnd(17)}${String(bucket.cells).padStart(3)}` +
          `${String(bucket.driver_call_count).padStart(7)}` +
          `${num(bucket.billed_input_tokens).padStart(15)}` +
          `${pct(bucket.cache_read_ratio).padStart(10)}` +
          `${num(bucket.effective_input_tokens).padStart(13)}`,
      );
    }
    lines.push('');
  }

  if (analysis.worst_cells.length > 0) {
    lines.push('【最贵的格（前 10）】');
    for (const row of analysis.worst_cells) {
      lines.push(
        `  ${num(row.billed_input_tokens).padStart(12)}  ${String(row.driver_call_count).padStart(4)} 次推理  ` +
          `峰值 ${num(row.peak_call_input_tokens).padStart(8)}  ${row.cell_id}`,
      );
    }
    lines.push('');
  }

  const reasons = Object.entries(analysis.missing_reasons);
  if (reasons.length > 0) {
    lines.push('【缺少 driver 台账的格（不是零花费，是取不到数）】');
    for (const [reason, count] of reasons.sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${String(count).padStart(3)} × ${reason}`);
    }
  }

  return lines.join('\n');
}
