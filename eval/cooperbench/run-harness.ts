#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasFlag, readFlag } from '../cli-args';
import { parseCooperBenchSetting } from './cases';
import { runCooperBenchHarnessAdapter } from './harness-adapter';
import type { CooperBenchPrediction } from './types';

async function main(): Promise<void> {
  const runDir = readFlag('--run-dir');
  const predictionsPath = readFlag('--predictions');
  if (!runDir && !predictionsPath) {
    console.error(
      'Usage: pnpm eval:cooperbench-harness -- --run-dir <.newide/eval/cb_...> [--dry-run] [--force]',
    );
    process.exitCode = 1;
    return;
  }

  const resolvedRunDir = runDir!;
  const predsPath = predictionsPath ?? join(resolvedRunDir, 'predictions.jsonl');
  if (!existsSync(predsPath)) {
    throw new Error(`predictions.jsonl not found: ${predsPath}`);
  }

  const predictions = readFileSync(predsPath, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CooperBenchPrediction);

  const runMetaPath = join(resolvedRunDir, 'run-meta.json');
  const runMeta = existsSync(runMetaPath)
    ? (JSON.parse(readFileSync(runMetaPath, 'utf-8')) as {
        setting?: string;
        cooperbench_run_name?: string;
        cooperbench_logs_dir?: string;
      })
    : {};

  const setting = parseCooperBenchSetting(readFlag('--setting') ?? runMeta.setting ?? 'coop');
  const cooperbenchRunName = readFlag('--name') ?? runMeta.cooperbench_run_name ?? 'newide';
  const logsRoot =
    readFlag('--log-dir') ??
    runMeta.cooperbench_logs_dir ??
    join(resolvedRunDir, 'cooperbench-logs');

  const result = runCooperBenchHarnessAdapter({
    runDir: resolvedRunDir,
    cooperbenchRunName,
    logsRoot,
    caseIds: predictions.map((p) => p.case_id),
    setting,
    ...(readFlag('--cooperbench-root') ? { cooperbenchRoot: readFlag('--cooperbench-root')! } : {}),
    ...(readFlag('--dataset-dir') ? { datasetDir: readFlag('--dataset-dir')! } : {}),
    ...(readFlag('--backend')
      ? { backend: readFlag('--backend') as 'docker' | 'modal' | 'gcp' }
      : {}),
    force: hasFlag('--force'),
    dryRun: hasFlag('--dry-run'),
  });

  console.log(`[F-Eval/CooperBench] harness command -> ${result.commandPath}`);
  if (result.report) {
    console.log(`[F-Eval/CooperBench] harness report -> ${result.harnessReportPath}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
