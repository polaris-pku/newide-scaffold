#!/usr/bin/env node
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CompositeTelemetrySink,
  JsonlTelemetrySink,
} from '../../src/telemetry/jsonl-telemetry-sink';
import { createFHarnessTelemetryPort } from '../../src/telemetry/harness-port';
import { InMemoryTelemetrySink } from '../../src/telemetry/telemetry-sink';
import { readFlag } from '../cli-args';
import { writeJson } from '../run-summary';
import { parseCooperBenchSetting } from './cases';
import {
  computeCoordinationDeficit,
  deriveFailureTaxonomy,
  getCooperBenchCaseReport,
  readCooperBenchHarnessReport,
} from './harness-report';
import { resolveCooperBenchRunDir } from './paths';
import { writeCooperBenchPredictionsJsonl } from './prediction-writer';
import { buildCooperBenchSummary } from './run-summary';

async function main(): Promise<void> {
  const harnessReportPath = readFlag('--harness-report');
  const runId = readFlag('--run-id');
  const caseIdsRaw = readFlag('--case-ids');

  if (!harnessReportPath || !runId || !caseIdsRaw) {
    console.error(
      'Usage: pnpm eval:cooperbench-record -- --run-id <id> --harness-report <report.json> --case-ids id1,id2 [--setting coop]',
    );
    process.exitCode = 1;
    return;
  }

  const caseIds = caseIdsRaw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const setting = parseCooperBenchSetting(readFlag('--setting'));
  const outRoot = readFlag('--out-root');
  const runDir = resolveCooperBenchRunDir(runId, outRoot);
  mkdirSync(runDir, { recursive: true });

  const telemetryPath = join(runDir, 'telemetry.jsonl');
  const summaryPath = join(runDir, 'summary.json');
  const predictionsPath = join(runDir, 'predictions.jsonl');
  const datasetManifestPath = join(runDir, 'dataset-manifest.json');
  const predictionsSource = readFlag('--predictions');

  if (predictionsSource) {
    copyFileSync(predictionsSource, predictionsPath);
  } else {
    writeCooperBenchPredictionsJsonl(
      predictionsPath,
      caseIds.map((caseId) => ({
        case_id: caseId,
        setting,
        model_name_or_path: 'harness-import',
        agent1_patch: '',
        agent2_patch: '',
      })),
    );
  }

  writeJson(datasetManifestPath, {
    source: 'harness-import',
    bench: 'CooperBench',
    case_ids: caseIds,
    setting,
    harness_report_path: harnessReportPath,
  });

  const memorySink = new InMemoryTelemetrySink();
  const sink = new CompositeTelemetrySink([memorySink, new JsonlTelemetrySink(telemetryPath)]);
  const harnessPort = createFHarnessTelemetryPort(sink);
  const harnessReport = readCooperBenchHarnessReport(harnessReportPath);

  for (const caseId of caseIds) {
    const caseReport = getCooperBenchCaseReport(harnessReport, caseId);
    await harnessPort.recordCooperBenchEvaluation({
      case_id: caseId,
      both_passed: caseReport?.both_passed === true,
      coordination_deficit: computeCoordinationDeficit(caseReport),
      failure_taxonomy: deriveFailureTaxonomy(caseReport),
    });
  }

  const summary = buildCooperBenchSummary({
    runId,
    caseIds,
    setting,
    predictionMode: 'real',
    predictionSemantics: predictionsSource
      ? 'imported_predictions_with_external_harness_report'
      : 'harness_report_import_without_predictions',
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
  console.log(`[F-Eval/CooperBench] recorded -> ${summaryPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
