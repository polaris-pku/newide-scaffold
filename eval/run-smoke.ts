#!/usr/bin/env node
import { buildRunSmokeOptions, readFlag, runEvalSmoke } from './cli-args';
import { parseMemoryAblation, parsePredictionMode } from './validation';

async function main(): Promise<void> {
  const mode = parsePredictionMode(readFlag('--mode'));
  const ablation = parseMemoryAblation(readFlag('--ablation'));

  const results = await runEvalSmoke(
    buildRunSmokeOptions({
      mode,
      ablation,
      ...(readFlag('--run-id') ? { runId: readFlag('--run-id')! } : {}),
      ...(readFlag('--model') ? { modelName: readFlag('--model')! } : {}),
      ...(readFlag('--dataset') ? { datasetPath: readFlag('--dataset')! } : {}),
      ...(readFlag('--subset') ? { datasetSubset: readFlag('--subset')! } : {}),
      ...(readFlag('--out-root') ? { outRoot: readFlag('--out-root')! } : {}),
      ...(readFlag('--patch-file') ? { patchFile: readFlag('--patch-file')! } : {}),
    }),
  );

  console.log(`[F-Eval] smoke runs=${results.length}`);
  for (const result of results) {
    console.log(
      `[F-Eval] ${result.runMeta.instance_id} -> ${result.runDir} (events=${result.summary.telemetry_event_types.length})`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
