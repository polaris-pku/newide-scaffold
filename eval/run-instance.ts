#!/usr/bin/env node
import { buildRunInstanceOptions, hasFlag, readFlag, runEvalInstance } from './cli-args';
import { parseMemoryAblation, parsePredictionMode } from './validation';

async function main(): Promise<void> {
  const instanceId = readFlag('--instance-id');
  if (!instanceId) {
    console.error(
      [
        'Usage: pnpm eval:instance -- --instance-id <id> [--mode stub|oracle|real]',
        '[--patch-file <path> | --worktree-path <dir> | --backend-summary <summary.json> | --ephemeral-from <repo>]',
        '[--allow-dirty-worktree] [--keep-worktree]',
        '[--run-harness] [--harness-dry-run] [--swe-evo-root <dir>] [--max-workers 4]',
        '[--ablation B0|B1|B2|B3] [--subset <id>] [--run-id <id>] [--model <name>] [--harness-report <path>]',
      ].join(' '),
    );
    process.exitCode = 1;
    return;
  }

  const mode = parsePredictionMode(readFlag('--mode'));
  const ablation = parseMemoryAblation(readFlag('--ablation'));

  const result = await runEvalInstance(
    buildRunInstanceOptions({
      instanceId,
      mode,
      ablation,
      ...(readFlag('--run-id') ? { runId: readFlag('--run-id')! } : {}),
      ...(readFlag('--model') ? { modelName: readFlag('--model')! } : {}),
      ...(readFlag('--dataset') ? { datasetPath: readFlag('--dataset')! } : {}),
      ...(readFlag('--subset') ? { datasetSubset: readFlag('--subset')! } : {}),
      ...(readFlag('--out-root') ? { outRoot: readFlag('--out-root')! } : {}),
      ...(readFlag('--harness-report') ? { harnessReportPath: readFlag('--harness-report')! } : {}),
      ...(readFlag('--patch-file') ? { patchFile: readFlag('--patch-file')! } : {}),
      ...(readFlag('--worktree-path') ? { worktreePath: readFlag('--worktree-path')! } : {}),
      ...(readFlag('--ephemeral-from') ? { ephemeralFrom: readFlag('--ephemeral-from')! } : {}),
      allowDirtyWorktree: hasFlag('--allow-dirty-worktree'),
      keepWorktree: hasFlag('--keep-worktree'),
      ...(readFlag('--backend-summary')
        ? { backendSummaryPath: readFlag('--backend-summary')! }
        : {}),
      runSweEvoHarness: hasFlag('--run-harness'),
      harnessDryRun: hasFlag('--harness-dry-run'),
      ...(readFlag('--swe-evo-root') ? { sweEvoRoot: readFlag('--swe-evo-root')! } : {}),
      ...(readFlag('--max-workers')
        ? { harnessMaxWorkers: readPositiveInteger('--max-workers') }
        : {}),
    }),
  );

  console.log(`[F-Eval] run_dir=${result.runDir}`);
  console.log(`[F-Eval] telemetry=${result.summary.telemetry_path}`);
  console.log(`[F-Eval] predictions=${result.summary.predictions_path}`);
  console.log(`[F-Eval] summary=${result.runDir}/summary.json`);
  console.log(`[F-Eval] telemetry_events=${result.summary.telemetry_event_types.join(', ')}`);
  if (result.harness) {
    console.log(`[F-Eval] harness_command=${result.harness.commandPath}`);
    console.log(`[F-Eval] harness_report=${result.harness.harnessReportPath}`);
  }
  console.log(
    `[F-Eval] resolved=${result.summary.resolved_count} applied=${result.summary.applied_count} unresolved=${result.summary.unresolved_count}`,
  );
}

function readPositiveInteger(flag: string): number {
  const raw = readFlag(flag);
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${flag} "${raw ?? ''}". Expected a positive integer.`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
