#!/usr/bin/env node
import { readFlag } from '../cli-args';
import { parseCooperBenchSetting, parsePredictionMode, runCooperBenchSmoke } from './run-case-core';

async function main(): Promise<void> {
  const results = await runCooperBenchSmoke({
    predictionMode: parsePredictionMode(readFlag('--mode')),
    setting: parseCooperBenchSetting(readFlag('--setting')),
    ...(readFlag('--run-id') ? { runId: readFlag('--run-id')! } : {}),
    ...(readFlag('--model') ? { modelName: readFlag('--model')! } : {}),
    ...(readFlag('--subset') ? { datasetSubset: readFlag('--subset')! } : {}),
    ...(readFlag('--out-root') ? { outRoot: readFlag('--out-root')! } : {}),
    ...(readFlag('--patch-file') ? { patchFile: readFlag('--patch-file')! } : {}),
    ...(readFlag('--agent1-patch') ? { agent1PatchFile: readFlag('--agent1-patch')! } : {}),
    ...(readFlag('--agent2-patch') ? { agent2PatchFile: readFlag('--agent2-patch')! } : {}),
  });

  console.log(`[F-Eval/CooperBench] smoke runs=${results.length}`);
  for (const result of results) {
    console.log(
      `[F-Eval/CooperBench] ${result.runMeta.case_id} -> ${result.runDir} (events=${result.summary.telemetry_event_types.length})`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
