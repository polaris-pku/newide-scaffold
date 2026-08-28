#!/usr/bin/env node
/**
 * Serial SWE-EVO harness pass over an existing ablation experiment dir.
 *
 * Agent phase writes predictions.jsonl without --run-harness. This script
 * scores those predictions one Docker job at a time, then folds results
 * back into eval summary.json, per-instance JSON, arm-summary.json,
 * metrics.jsonl, and summary.json.
 *
 * Usage:
 *   pnpm tsx scripts/run-sweevo-harness-serial.ts -- --experiment-dir <dir>
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getInstanceReport, hasP2pRegression, readHarnessReport } from '../eval/harness-report';
import { getScaffoldRoot } from '../eval/paths';
import { writeJson } from '../eval/run-summary';
import {
  resolveHarnessTimeoutSeconds,
  runSweEvoHarnessAdapter,
} from '../eval/sweevo-harness-adapter';
import type { MemoryAblation, SweBenchHarnessReport } from '../eval/types';

interface InstanceRow {
  ablation: MemoryAblation;
  instance_id: string;
  instance_seq?: number;
  status: 'ok' | 'failed' | 'skipped_eval';
  snapshot_status?: string;
  harness_scored?: boolean;
  resolved?: boolean;
  applied?: boolean;
  p2p_regression?: boolean;
  eval_run_dir?: string;
  eval_predictions_path?: string;
  eval_error?: string;
  [key: string]: unknown;
}

interface ArmSummary {
  ablation: MemoryAblation;
  state_root?: string;
  database_schema?: string;
  total_count: number;
  scored_count: number;
  resolved_count: number;
  intent_to_treat_resolved_rate: number;
  applied_count: number;
  p2p_regression_count: number;
  instances: InstanceRow[];
  [key: string]: unknown;
}

const repoRoot = getScaffoldRoot();
applyDotenvFiles(repoRoot);

const experimentDir = resolve(
  repoRoot,
  readFlag('--experiment-dir') ??
    (() => {
      throw new Error('Usage: pnpm tsx scripts/run-sweevo-harness-serial.ts -- --experiment-dir <dir>');
    })(),
);

if (!existsSync(experimentDir)) {
  throw new Error(`experiment dir not found: ${experimentDir}`);
}

const dryRun = hasFlag('--dry-run');
const arms = (['B0', 'B1', 'B2', 'B3'] as MemoryAblation[]).filter((arm) =>
  existsSync(join(experimentDir, arm, 'arm-summary.json')),
);

if (arms.length === 0) {
  throw new Error(`No arm-summary.json under ${experimentDir}`);
}

log(`experiment dir: ${experimentDir}`);
log(`arms: ${arms.join(',')} dry_run=${String(dryRun)}`);

for (const ablation of arms) {
  const armDir = join(experimentDir, ablation);
  const armSummaryPath = join(armDir, 'arm-summary.json');
  const arm = (await readJson(armSummaryPath)) as ArmSummary;
  const jobs = [...arm.instances].sort(
    (left, right) => (left.instance_seq ?? 0) - (right.instance_seq ?? 0),
  );

  log('');
  log(`=== serial harness ${ablation} (${jobs.length} instances) ===`);

  for (const row of jobs) {
    const predictionsPath = row.eval_predictions_path;
    const evalRunDir = row.eval_run_dir;
    if (!predictionsPath || !evalRunDir || !existsSync(predictionsPath)) {
      log(`  skip ${row.instance_id}: no predictions`);
      continue;
    }

    const runMetaPath = join(evalRunDir, 'run-meta.json');
    const runMeta = existsSync(runMetaPath)
      ? ((await readJson(runMetaPath)) as { run_id?: string; dataset_jsonl?: string })
      : {};
    const runId = runMeta.run_id ?? evalRunDir.split('/').at(-1);
    if (!runId) {
      row.status = 'failed';
      row.eval_error = 'missing run_id for serial harness';
      log(`  fail ${row.instance_id}: missing run_id`);
      continue;
    }

    const timeoutSeconds = resolveHarnessTimeoutSeconds(row.instance_id);
    if (timeoutSeconds) {
      log(`  harness timeout override ${row.instance_id}: ${String(timeoutSeconds)}s`);
    }

    try {
      const harness = await runSweEvoHarnessAdapter({
        predictionsPath,
        runId,
        outRoot: join(armDir, 'eval'),
        instanceId: row.instance_id,
        dryRun,
        ...(runMeta.dataset_jsonl ? { datasetPath: runMeta.dataset_jsonl } : {}),
        ...(timeoutSeconds ? { timeoutSeconds } : {}),
        ...(process.env.NEWIDE_SWE_EVO_ROOT
          ? { sweEvoRoot: resolve(repoRoot, process.env.NEWIDE_SWE_EVO_ROOT) }
          : {}),
      });

      const report = existsSync(harness.harnessReportPath)
        ? readHarnessReport(harness.harnessReportPath)
        : {};
      applyHarnessToRow(row, report, row.instance_id);
      await foldEvalSummary(evalRunDir, harness.harnessReportPath, report, row.instance_id);
      log(
        `  ${row.instance_id} scored=${String(row.harness_scored)} resolved=${String(row.resolved)} applied=${String(row.applied)}`,
      );
    } catch (error) {
      row.harness_scored = false;
      row.status = 'failed';
      row.eval_error = error instanceof Error ? error.message : String(error);
      log(`  fail ${row.instance_id}: ${row.eval_error}`);
    }

    await fs.writeFile(
      join(armDir, `${sanitizeFileName(row.instance_id)}.json`),
      `${JSON.stringify(row, null, 2)}\n`,
      'utf-8',
    );
  }

  arm.instances = jobs;
  arm.total_count = jobs.length;
  arm.scored_count = jobs.filter((row) => row.harness_scored === true).length;
  arm.resolved_count = jobs.filter((row) => row.resolved === true).length;
  arm.intent_to_treat_resolved_rate =
    jobs.length > 0 ? arm.resolved_count / jobs.length : 0;
  arm.applied_count = jobs.filter((row) => row.applied === true).length;
  arm.p2p_regression_count = jobs.filter((row) => row.p2p_regression === true).length;
  await fs.writeFile(armSummaryPath, `${JSON.stringify(arm, null, 2)}\n`, 'utf-8');
}

const mergedArms: ArmSummary[] = [];
for (const ablation of arms) {
  mergedArms.push((await readJson(join(experimentDir, ablation, 'arm-summary.json'))) as ArmSummary);
}

const metricsRows = mergedArms.flatMap((arm) => arm.instances);
const metricsPath = join(experimentDir, 'metrics.jsonl');
await fs.writeFile(
  metricsPath,
  `${metricsRows.map((row) => JSON.stringify(row)).join('\n')}${metricsRows.length > 0 ? '\n' : ''}`,
  'utf-8',
);

const summaryPath = join(experimentDir, 'summary.json');
const existing = existsSync(summaryPath)
  ? ((await readJson(summaryPath)) as Record<string, unknown>)
  : {};
const finishedAt = new Date();
const summary = {
  ...existing,
  schema_version: existing.schema_version ?? 'sweevo-memory-ablation.v0',
  finished_at: finishedAt.toISOString(),
  harness_serial_finished_at: finishedAt.toISOString(),
  experiment_root: experimentDir,
  run_harness: true,
  harness_serial: true,
  metrics_path: metricsPath,
  arms: mergedArms,
};
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');

log('');
log(`summary: ${summaryPath}`);
log(`metrics: ${metricsPath}`);
for (const arm of mergedArms) {
  log(
    `  ${arm.ablation} scored=${String(arm.scored_count)}/${String(arm.total_count)} resolved=${String(arm.resolved_count)} applied=${String(arm.applied_count)}`,
  );
}

const failed = mergedArms.some((arm) => arm.instances.some((row) => row.status === 'failed'));
if (failed) process.exitCode = 1;

function applyHarnessToRow(
  row: InstanceRow,
  report: SweBenchHarnessReport,
  instanceId: string,
): void {
  const instanceReport = getInstanceReport(report, instanceId);
  const scored =
    Boolean(instanceReport) &&
    (instanceReport?.resolved === true || instanceReport?.resolved === false);
  row.harness_scored = scored;
  if (scored) {
    row.resolved = instanceReport?.resolved === true;
    row.applied = instanceReport?.patch_successfully_applied === true;
    row.p2p_regression = hasP2pRegression(instanceReport);
  }
  const snapshotOk = row.snapshot_status === 'succeeded' || row.snapshot_status === 'completed';
  row.status = snapshotOk && scored ? 'ok' : 'failed';
  if (scored) delete row.eval_error;
}

async function foldEvalSummary(
  evalRunDir: string,
  harnessReportPath: string,
  report: SweBenchHarnessReport,
  instanceId: string,
): Promise<void> {
  const summaryPath = join(evalRunDir, 'summary.json');
  if (!existsSync(summaryPath)) return;
  const summary = (await readJson(summaryPath)) as Record<string, unknown>;
  const instanceReport = getInstanceReport(report, instanceId);
  summary.harness_report_path = harnessReportPath;
  summary.resolved_count = instanceReport?.resolved === true ? 1 : 0;
  summary.unresolved_count = instanceReport && instanceReport.resolved !== true ? 1 : 0;
  summary.applied_count = instanceReport?.patch_successfully_applied === true ? 1 : 0;
  summary.p2p_regression_count = hasP2pRegression(instanceReport) ? 1 : 0;
  summary.completed_at = new Date().toISOString();
  writeJson(summaryPath, summary);
}

function applyDotenvFiles(root: string): void {
  for (const name of ['.env', '.env.local']) {
    const filePath = join(root, name);
    if (!existsSync(filePath)) continue;
    for (const raw of readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      const value = line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
      process.env[key] ??= value;
    }
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as unknown;
}

function sanitizeFileName(value: string): string {
  return value.replaceAll(/[<>:"/\\|?*]/g, '_');
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}
