/**
 * report-cost — 离线汇总某一批实验的 token 花费与缓存命中
 *
 * 用法：
 *   pnpm eval:role-divergence:cost -- --root=<结果根> [--json=<输出 json 路径>] [--quiet]
 *
 * 存在理由：实验跑到一半发现「token 消耗过快」时，需要能对**已有**结果反复算账，
 * 而不是重跑一次才知道钱花在哪。它只读 cells 下的单元证据，不触网、不启动后端。
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { collectCells } from './cache';
import { analyzeCosts, formatCostReport, type CellCostInput } from './cost-analysis';

interface Options {
  root: string;
  jsonPath?: string;
  quiet: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const value = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const hit = argv.find((arg) => arg.startsWith(prefix));
    if (hit) return hit.slice(prefix.length);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const root =
    value('root') ??
    process.env.ROLE_DIVERGENCE_ROOT ??
    path.join(process.cwd(), 'role-divergence-runs');
  return {
    root,
    ...(value('json') ? { jsonPath: value('json') as string } : {}),
    quiet: argv.includes('--quiet'),
  };
}

/**
 * 单元证据 → 计费输入。
 *
 * `driver_tokens` 与 `token_usage` 在证据里是 `unknown`（它们由别的模块写入），
 * 这里做一次形状检查而不是直接断言：台账字段缺失必须走
 * `cells_without_driver_usage`，不能被静默当成零花费。
 */
function toCostInput(cell: {
  cell_id: string;
  experiment: string;
  role_key: string;
  status: string;
  wall_ms: number;
  driver_tokens?: unknown;
  driver_tokens_error?: string;
  token_usage?: unknown;
}): CellCostInput {
  const agentUsage: CellCostInput['token_usage'] | undefined = isRecord(cell.token_usage)
    ? (cell.token_usage as CellCostInput['token_usage'])
    : undefined;
  const driverTokens: CellCostInput['driver_tokens'] | undefined = isRecord(cell.driver_tokens)
    ? (cell.driver_tokens as unknown as CellCostInput['driver_tokens'])
    : undefined;
  return {
    cell_id: cell.cell_id,
    experiment: cell.experiment,
    role_key: cell.role_key,
    status: cell.status,
    wall_ms: cell.wall_ms,
    ...(driverTokens ? { driver_tokens: driverTokens } : {}),
    ...(cell.driver_tokens_error ? { driver_tokens_error: cell.driver_tokens_error } : {}),
    ...(agentUsage ? { token_usage: agentUsage } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.root)) {
    throw new Error(`result root not found: ${options.root}`);
  }

  const cells = await collectCells(options.root);
  const analysis = analyzeCosts(cells.map(toCostInput));
  const report = formatCostReport(analysis);

  if (!options.quiet) {
    process.stdout.write(`${report}\n`);
  }

  const jsonPath =
    options.jsonPath ?? path.join(options.root, 'cost-analysis.json');
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(jsonPath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
  process.stdout.write(`\n明细已写入 ${jsonPath}\n`);

  // 有格子取不到台账时以非零退出，让 CI/批处理脚本能发现——但不影响报告本身。
  if (analysis.cells_without_driver_usage > 0 && analysis.cells_with_driver_usage === 0) {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`report-cost failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
