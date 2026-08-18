#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasFlag, readFlag } from './cli-args';
import { getScaffoldRoot } from './paths';
import { runSweEvoHarnessAdapter } from './sweevo-harness-adapter';

function applyDotenvFiles(repoRoot: string): void {
  for (const name of ['.env', '.env.local']) {
    const filePath = join(repoRoot, name);
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

function readMaxWorkers(): number {
  const raw = readFlag('--max-workers');
  if (!raw) {
    return 4;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid --max-workers "${raw}". Expected a positive integer.`);
  }
  return value;
}

async function main(): Promise<void> {
  applyDotenvFiles(getScaffoldRoot());
  const predictionsPath = readFlag('--predictions');
  const runId = readFlag('--run-id');
  if (!predictionsPath || !runId) {
    console.error(
      'Usage: pnpm eval:sweevo-harness -- --predictions <predictions.jsonl> --run-id <id> [--dry-run] [--report-source <report.json>] [--out-root <dir>] [--swe-evo-root <dir>] [--max-workers 4]',
    );
    process.exitCode = 1;
    return;
  }

  const result = await runSweEvoHarnessAdapter({
    predictionsPath,
    runId,
    maxWorkers: readMaxWorkers(),
    dryRun: hasFlag('--dry-run'),
    ...(readFlag('--out-root') ? { outRoot: readFlag('--out-root')! } : {}),
    ...(readFlag('--swe-evo-root') ? { sweEvoRoot: readFlag('--swe-evo-root')! } : {}),
    ...(readFlag('--report-source') ? { reportSource: readFlag('--report-source')! } : {}),
  });

  console.log(`[F-Eval] harness_run_dir=${result.runDir}`);
  console.log(`[F-Eval] trajectory=${result.trajectoryPath}`);
  console.log(`[F-Eval] output_final=${result.outputFinalDir}`);
  console.log(`[F-Eval] command=${result.commandPath}`);
  console.log(`[F-Eval] harness_report=${result.harnessReportPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
