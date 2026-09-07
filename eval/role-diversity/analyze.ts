import { promises as fs } from 'node:fs';
import path from 'node:path';

const resultArgument = process.argv.slice(2).find((argument) => argument !== '--');
const resultRoot = path.resolve(resultArgument ?? '');
if (!resultArgument) {
  throw new Error('Usage: tsx analyze-role-diversity.ts <result-root>');
}

const cellPaths = await findFiles(resultRoot, 'cell.json');
const cells = await Promise.all(cellPaths.map((file) => readJson<Cell>(file)));
const completed = cells.filter((cell): cell is Cell => cell?.status === 'completed');
const groups = new Map<string, Cell[]>();
for (const cell of completed) {
  const key = `${cell.condition}::${cell.instance_id}`;
  groups.set(key, [...(groups.get(key) ?? []), cell]);
}

const cellMetrics = await Promise.all(completed.map(buildCellMetrics));
const metricsByCell = new Map(cellMetrics.map((item) => [cellKey(item), item]));
const comparisons: PairComparison[] = [];
for (const group of groups.values()) {
  const ordered = [...group].sort((left, right) => left.role_key.localeCompare(right.role_key));
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const left = metricsByCell.get(cellKey(ordered[leftIndex]!))!;
      const right = metricsByCell.get(cellKey(ordered[rightIndex]!))!;
      comparisons.push({
        condition: left.condition,
        instance_id: left.instance_id,
        left_role: left.role_key,
        right_role: right.role_key,
        plan_word_jaccard: jaccard(left.plan_words, right.plan_words),
        changed_path_jaccard: jaccard(left.changed_paths, right.changed_paths),
        added_line_jaccard: jaccard(left.added_lines, right.added_lines),
        exact_plan: left.plan_sha256 === right.plan_sha256,
        exact_patch: left.patch_sha256 === right.patch_sha256,
      });
    }
  }
}

const conditionSummary = ['independent_plan', 'shared_neutral_plan'].map((condition) => {
  const conditionCells = cellMetrics.filter((cell) => cell.condition === condition);
  const pairs = comparisons.filter((pair) => pair.condition === condition);
  return {
    condition,
    cells: conditionCells.length,
    mean_wall_ms: mean(conditionCells.map((cell) => cell.wall_ms)),
    mean_context_tokens: mean(conditionCells.map((cell) => cell.context_tokens)),
    mean_reported_cost_usd: mean(conditionCells.map((cell) => cell.reported_cost_usd)),
    mean_changed_paths: mean(conditionCells.map((cell) => cell.changed_paths.length)),
    mean_plan_word_jaccard: mean(pairs.map((pair) => pair.plan_word_jaccard)),
    mean_changed_path_jaccard: mean(pairs.map((pair) => pair.changed_path_jaccard)),
    mean_added_line_jaccard: mean(pairs.map((pair) => pair.added_line_jaccard)),
  };
});

const sharedHashes = new Map<string, Set<string>>();
for (const cell of completed.filter((item) => item.condition === 'shared_neutral_plan')) {
  const hashes = sharedHashes.get(cell.instance_id) ?? new Set<string>();
  if (cell.shared_plan_sha256) hashes.add(cell.shared_plan_sha256);
  sharedHashes.set(cell.instance_id, hashes);
}

const report = {
  generated_at: new Date().toISOString(),
  result_root: resultRoot,
  completed_cells: completed.length,
  failed_cells: cells.filter((cell) => cell?.status === 'failed').length,
  shared_plan_hashes: Object.fromEntries(
    [...sharedHashes].map(([instance, hashes]) => [instance, [...hashes]]),
  ),
  condition_summary: conditionSummary,
  cells: cellMetrics,
  pairwise_comparisons: comparisons,
};
await fs.writeFile(
  path.join(resultRoot, 'diversity-analysis.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
await fs.writeFile(path.join(resultRoot, 'diversity-analysis.md'), markdown(report), 'utf8');
console.log(path.join(resultRoot, 'diversity-analysis.md'));

async function buildCellMetrics(cell: Cell): Promise<CellMetrics> {
  const plan = await fs.readFile(cell.plan_path, 'utf8');
  const patch = await fs.readFile(cell.patch_path, 'utf8');
  const trajectoryPath = path.join(path.dirname(cell.plan_path), 'trajectory.jsonl');
  const trajectory = await readTrajectory(trajectoryPath);
  return {
    ...cell,
    plan_words: uniqueWords(plan),
    changed_paths: changedPaths(patch),
    added_lines: addedLines(patch),
    trajectory_events: trajectory.events,
    tool_calls: trajectory.tools,
    context_tokens: contextTokens(cell),
    reported_cost_usd: reportedCost(cell),
  };
}

async function readTrajectory(filePath: string): Promise<{ events: number; tools: Record<string, number> }> {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const completedTools = new Map<string, string>();
  for (const line of lines) {
    const envelope = JSON.parse(line) as Record<string, unknown>;
    const event = asRecord(envelope.event) ?? envelope;
    if (event.event_type !== 'tool_call_update') continue;
    const payload = asRecord(event.payload);
    const update = asRecord(payload?.update);
    if (update?.status !== 'completed' || typeof update.toolCallId !== 'string') continue;
    const meta = asRecord(update._meta);
    const claude = asRecord(meta?.claudeCode);
    completedTools.set(
      update.toolCallId,
      typeof claude?.toolName === 'string' ? claude.toolName : 'unknown',
    );
  }
  const tools: Record<string, number> = {};
  for (const tool of completedTools.values()) tools[tool] = (tools[tool] ?? 0) + 1;
  return { events: lines.length, tools };
}

function markdown(report: {
  completed_cells: number;
  failed_cells: number;
  condition_summary: typeof conditionSummary;
  cells: CellMetrics[];
  pairwise_comparisons: PairComparison[];
}): string {
  const lines = [
    '# Role-diversity analysis',
    '',
    `Completed cells: ${report.completed_cells}; failed cells: ${report.failed_cells}.`,
    '',
    '## Condition summary',
    '',
    '| Condition | Cells | Mean time | Mean context | Mean cost | Mean files | Plan Jaccard | Path Jaccard | Added-line Jaccard |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.condition_summary.map(
      (item) =>
        `| ${item.condition} | ${item.cells} | ${duration(item.mean_wall_ms)} | ${Math.round(item.mean_context_tokens)} | $${item.mean_reported_cost_usd.toFixed(3)} | ${item.mean_changed_paths.toFixed(1)} | ${item.mean_plan_word_jaccard.toFixed(3)} | ${item.mean_changed_path_jaccard.toFixed(3)} | ${item.mean_added_line_jaccard.toFixed(3)} |`,
    ),
    '',
    '## Cells',
    '',
    '| Condition | Instance | Role | Time | Context | Cost | Files | Events | Plan SHA | Patch SHA |',
    '|---|---|---|---:|---:|---:|---:|---:|---|---|',
    ...report.cells.map(
      (cell) =>
        `| ${cell.condition} | ${cell.instance_id} | ${cell.role_key} | ${duration(cell.wall_ms)} | ${cell.context_tokens} | $${cell.reported_cost_usd.toFixed(3)} | ${cell.changed_paths.length} | ${cell.trajectory_events} | ${cell.plan_sha256?.slice(0, 10) ?? '-'} | ${cell.patch_sha256?.slice(0, 10) ?? '-'} |`,
    ),
    '',
    '## Pairwise comparisons',
    '',
    '| Condition | Instance | Roles | Plan Jaccard | Path Jaccard | Added-line Jaccard | Exact patch |',
    '|---|---|---|---:|---:|---:|---|',
    ...report.pairwise_comparisons.map(
      (pair) =>
        `| ${pair.condition} | ${pair.instance_id} | ${pair.left_role} / ${pair.right_role} | ${pair.plan_word_jaccard.toFixed(3)} | ${pair.changed_path_jaccard.toFixed(3)} | ${pair.added_line_jaccard.toFixed(3)} | ${pair.exact_patch ? 'yes' : 'no'} |`,
    ),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function uniqueWords(value: string): string[] {
  return [
    ...new Set(
      (value.toLowerCase().match(/[a-z_][a-z0-9_]+|[\p{Script=Han}]+/gu) ?? []).filter(
        (word) => word.length > 1,
      ),
    ),
  ].sort();
}

function changedPaths(patch: string): string[] {
  return [...new Set([...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]!))].sort();
}

function addedLines(patch: string): string[] {
  return [
    ...new Set(
      patch
        .split(/\r?\n/)
        .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
        .map((line) => line.slice(1).trim())
        .filter(Boolean),
    ),
  ].sort();
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / union.size;
}

function contextTokens(cell: Cell): number {
  const usage = asRecord(cell.driver_usage);
  return typeof usage?.context_tokens_used === 'number' ? usage.context_tokens_used : 0;
}

function reportedCost(cell: Cell): number {
  const usage = asRecord(cell.driver_usage);
  const costs = Array.isArray(usage?.reported_costs) ? usage.reported_costs : [];
  return costs.reduce((sum, item) => {
    const cost = asRecord(item);
    return sum + (cost?.currency === 'USD' && typeof cost.amount === 'number' ? cost.amount : 0);
  }, 0);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function duration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function cellKey(cell: Pick<Cell, 'condition' | 'instance_id' | 'role_key'>): string {
  return `${cell.condition}::${cell.instance_id}::${cell.role_key}`;
}

async function findFiles(root: string, name: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await findFiles(candidate, name)));
    else if (entry.name === name) output.push(candidate);
  }
  return output;
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface Cell {
  status: 'completed' | 'failed';
  condition: string;
  role_key: string;
  role_id: string;
  instance_id: string;
  wall_ms: number;
  plan_path: string;
  plan_sha256?: string;
  patch_path: string;
  patch_sha256?: string;
  shared_plan_sha256?: string;
  driver_usage?: unknown;
}

interface CellMetrics extends Cell {
  plan_words: string[];
  changed_paths: string[];
  added_lines: string[];
  trajectory_events: number;
  tool_calls: Record<string, number>;
  context_tokens: number;
  reported_cost_usd: number;
}

interface PairComparison {
  condition: string;
  instance_id: string;
  left_role: string;
  right_role: string;
  plan_word_jaccard: number;
  changed_path_jaccard: number;
  added_line_jaccard: number;
  exact_plan: boolean;
  exact_patch: boolean;
}
