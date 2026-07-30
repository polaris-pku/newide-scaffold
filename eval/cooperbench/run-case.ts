#!/usr/bin/env node
import { hasFlag, readFlag } from '../cli-args';
import { parseCooperBenchSetting, parsePredictionMode, runCooperBenchCase } from './run-case-core';

async function main(): Promise<void> {
  const caseId = readFlag('--case-id');
  if (!caseId) {
    console.error(
      [
        'Usage: pnpm eval:cooperbench-case -- --case-id <id> [--mode stub|oracle|real]',
        '  [--setting solo|coop] [--model <name>] [--subset <id>]',
        '  [--patch-file <solo.patch>] [--agent1-patch <p1>] [--agent2-patch <p2>]',
        '  [--run-harness] [--harness-dry-run] [--harness-report <report.json>]',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  const result = await runCooperBenchCase({
    caseId,
    predictionMode: parsePredictionMode(readFlag('--mode')),
    setting: parseCooperBenchSetting(readFlag('--setting')),
    ...(readFlag('--run-id') ? { runId: readFlag('--run-id')! } : {}),
    ...(readFlag('--model') ? { modelName: readFlag('--model')! } : {}),
    ...(readFlag('--subset') ? { datasetSubset: readFlag('--subset')! } : {}),
    ...(readFlag('--out-root') ? { outRoot: readFlag('--out-root')! } : {}),
    ...(readFlag('--patch-file') ? { patchFile: readFlag('--patch-file')! } : {}),
    ...(readFlag('--agent1-patch') ? { agent1PatchFile: readFlag('--agent1-patch')! } : {}),
    ...(readFlag('--agent2-patch') ? { agent2PatchFile: readFlag('--agent2-patch')! } : {}),
    ...(readFlag('--harness-report') ? { harnessReportPath: readFlag('--harness-report')! } : {}),
    ...(readFlag('--cooperbench-root') ? { cooperbenchRoot: readFlag('--cooperbench-root')! } : {}),
    ...(readFlag('--dataset-dir') ? { datasetDir: readFlag('--dataset-dir')! } : {}),
    ...(readFlag('--backend')
      ? { backend: readFlag('--backend') as 'docker' | 'modal' | 'gcp' }
      : {}),
    runHarness: hasFlag('--run-harness'),
    harnessDryRun: hasFlag('--harness-dry-run'),
    force: hasFlag('--force'),
  });

  console.log(
    `[F-Eval/CooperBench] ${result.runMeta.case_id} -> ${result.runDir} (both_passed=${result.summary.both_passed_count})`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
