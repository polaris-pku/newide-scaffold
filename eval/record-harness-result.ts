#!/usr/bin/env node
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CompositeTelemetrySink, JsonlTelemetrySink } from '../src/telemetry/jsonl-telemetry-sink';
import { createFHarnessTelemetryPort } from '../src/telemetry/harness-port';
import { InMemoryTelemetrySink } from '../src/telemetry/telemetry-sink';
import { getInstanceReport, hasP2pRegression, readHarnessReport } from './harness-report';
import { resolveRunDir } from './paths';
import { buildEvalSummary, writeJson } from './run-summary';
import type { MemoryAblation } from './types';
import { writePredictionsJsonl } from './prediction-writer';
import { parseMemoryAblation } from './validation';

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const harnessReportPath = readFlag('--harness-report');
  const runId = readFlag('--run-id');
  const instanceIdsRaw = readFlag('--instance-ids');

  if (!harnessReportPath || !runId || !instanceIdsRaw) {
    console.error(
      'Usage: pnpm eval:record-harness -- --run-id <id> --harness-report <report.json> --instance-ids id1,id2 [--predictions <predictions.jsonl>] [--ablation B2] [--out-root <dir>]',
    );
    process.exitCode = 1;
    return;
  }

  const instanceIds = instanceIdsRaw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const memoryAblation: MemoryAblation = parseMemoryAblation(readFlag('--ablation'));
  const outRoot = readFlag('--out-root');
  const runDir = resolveRunDir(runId, outRoot);
  mkdirSync(runDir, { recursive: true });

  const telemetryPath = join(runDir, 'telemetry.jsonl');
  const summaryPath = join(runDir, 'summary.json');
  const predictionsPath = join(runDir, 'predictions.jsonl');
  const datasetManifestPath = join(runDir, 'dataset-manifest.json');
  const predictionsSource = readFlag('--predictions');

  if (predictionsSource) {
    copyFileSync(predictionsSource, predictionsPath);
  } else {
    writePredictionsJsonl(
      predictionsPath,
      instanceIds.map((instanceId) => ({
        instance_id: instanceId,
        model_name_or_path: 'harness-import',
        model_patch: '',
      })),
    );
  }
  writeJson(datasetManifestPath, {
    source: 'harness-import',
    instance_ids: instanceIds,
    predictions_source: predictionsSource ?? null,
    harness_report_path: harnessReportPath,
  });

  const memorySink = new InMemoryTelemetrySink();
  const sink = new CompositeTelemetrySink([memorySink, new JsonlTelemetrySink(telemetryPath)]);
  const harnessPort = createFHarnessTelemetryPort(sink);
  const harnessReport = readHarnessReport(harnessReportPath);

  for (let index = 0; index < instanceIds.length; index += 1) {
    const instanceId = instanceIds[index]!;
    const instanceReport = getInstanceReport(harnessReport, instanceId);
    await harnessPort.recordSweEvoEvaluation({
      instance_id: instanceId,
      instance_seq: index + 1,
      resolved: instanceReport?.resolved === true,
      applied: instanceReport?.patch_successfully_applied === true,
      p2p_regression: hasP2pRegression(instanceReport),
      memory_ablation: memoryAblation,
    });
  }

  const summary = buildEvalSummary({
    runId,
    instanceIds,
    predictionMode: 'real',
    predictionSemantics: predictionsSource
      ? 'imported_predictions_with_external_harness_report'
      : 'harness_report_import_without_predictions',
    memoryAblation,
    modelName: 'harness-import',
    telemetryPath,
    predictionsPath,
    datasetManifestPath,
    patchSource: 'harness_import',
    harnessReport,
    harnessReportPath,
    telemetrySink: memorySink,
  });
  writeJson(summaryPath, summary);

  console.log(`[F-Eval] recorded harness results for ${instanceIds.length} instance(s)`);
  console.log(`[F-Eval] telemetry=${telemetryPath}`);
  console.log(`[F-Eval] summary=${summaryPath}`);
  console.log(
    `[F-Eval] resolved=${summary.resolved_count} unresolved=${summary.unresolved_count} p2p_regression=${summary.p2p_regression_count}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
