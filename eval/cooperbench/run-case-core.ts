import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CompositeTelemetrySink,
  JsonlTelemetrySink,
} from '../../src/telemetry/jsonl-telemetry-sink';
import { createFHarnessTelemetryPort } from '../../src/telemetry/harness-port';
import { InMemoryTelemetrySink } from '../../src/telemetry/telemetry-sink';
import { writeJson } from '../run-summary';
import { assertCaseExists, parseCooperBenchCaseId, parseCooperBenchSetting } from './cases';
import {
  computeCoordinationDeficit,
  deriveFailureTaxonomy,
  getCooperBenchCaseReport,
  readCooperBenchHarnessReport,
} from './harness-report';
import { runCooperBenchHarnessAdapter } from './harness-adapter';
import { materializeCooperBenchLogs } from './materialize-logs';
import {
  loadCooperBenchManifest,
  loadCooperBenchSubset,
  resolveCooperBenchDatasetDir,
  resolveCooperBenchRunDir,
} from './paths';
import {
  buildCooperBenchPrediction,
  describeCooperBenchPredictionMode,
  writeCooperBenchPredictionsJsonl,
} from './prediction-writer';
import { buildCooperBenchSummary } from './run-summary';
import type {
  CooperBenchHarnessReport,
  CooperBenchPatchSource,
  CooperBenchPredictionMode,
  CooperBenchRunMeta,
  CooperBenchSetting,
  CooperBenchSummary,
} from './types';

export interface RunCooperBenchCaseOptions {
  caseId: string;
  runId?: string;
  predictionMode?: CooperBenchPredictionMode;
  setting?: CooperBenchSetting;
  modelName?: string;
  datasetSubset?: string;
  outRoot?: string;
  patchFile?: string;
  agent1PatchFile?: string;
  agent2PatchFile?: string;
  harnessReportPath?: string;
  runHarness?: boolean;
  harnessDryRun?: boolean;
  cooperbenchRoot?: string;
  datasetDir?: string;
  backend?: 'docker' | 'modal' | 'gcp';
  force?: boolean;
}

export interface RunCooperBenchCaseResult {
  runDir: string;
  summary: CooperBenchSummary;
  runMeta: CooperBenchRunMeta;
}

export interface RunCooperBenchSmokeOptions {
  predictionMode?: CooperBenchPredictionMode;
  setting?: CooperBenchSetting;
  modelName?: string;
  datasetSubset?: string;
  runId?: string;
  outRoot?: string;
  patchFile?: string;
  agent1PatchFile?: string;
  agent2PatchFile?: string;
}

function createRunId(caseId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `cb_${stamp}_${caseId}`;
}

function parsePredictionMode(value: string | undefined): CooperBenchPredictionMode {
  const mode = (value ?? 'stub').trim();
  if (mode === 'stub' || mode === 'oracle' || mode === 'real') {
    return mode;
  }
  throw new Error(`Invalid --mode "${value}". Expected stub|oracle|real.`);
}

function readOptionalFile(path: string | undefined): string | undefined {
  if (!path?.trim()) {
    return undefined;
  }
  if (!existsSync(path)) {
    throw new Error(`Patch file not found: ${path}`);
  }
  return readFileSync(path, 'utf-8');
}

export async function runCooperBenchCase(
  options: RunCooperBenchCaseOptions,
): Promise<RunCooperBenchCaseResult> {
  const manifest = loadCooperBenchManifest();
  const predictionMode = parsePredictionMode(options.predictionMode);
  const setting = parseCooperBenchSetting(options.setting ?? manifest.default_setting);
  const modelName = options.modelName ?? manifest.default_model_name;
  const datasetDir = options.datasetDir?.trim() || resolveCooperBenchDatasetDir(manifest);
  const parts = parseCooperBenchCaseId(options.caseId);
  assertCaseExists(datasetDir, parts);

  const runId = options.runId ?? createRunId(parts.case_id);
  const runDir = resolveCooperBenchRunDir(runId, options.outRoot);
  mkdirSync(runDir, { recursive: true });

  const realSoloPatch = readOptionalFile(options.patchFile);
  const realAgent1Patch = readOptionalFile(options.agent1PatchFile);
  const realAgent2Patch = readOptionalFile(options.agent2PatchFile);

  let patchSource: CooperBenchPatchSource;
  if (predictionMode === 'stub') {
    patchSource = 'stub';
  } else if (predictionMode === 'oracle') {
    patchSource = 'oracle';
  } else if (setting === 'coop' && options.agent1PatchFile && options.agent2PatchFile) {
    patchSource = 'agent_patch_files';
  } else {
    patchSource = 'patch_file';
  }

  const prediction = buildCooperBenchPrediction({
    parts,
    setting,
    modelName,
    mode: predictionMode,
    datasetDir,
    ...(realSoloPatch !== undefined ? { realSoloPatch } : {}),
    ...(realAgent1Patch !== undefined ? { realAgent1Patch } : {}),
    ...(realAgent2Patch !== undefined ? { realAgent2Patch } : {}),
  });
  const predictionSemantics = describeCooperBenchPredictionMode(predictionMode, patchSource);

  const telemetryPath = join(runDir, 'telemetry.jsonl');
  const predictionsPath = join(runDir, 'predictions.jsonl');
  const datasetManifestPath = join(runDir, 'dataset-manifest.json');
  const runMetaPath = join(runDir, 'run-meta.json');
  const summaryPath = join(runDir, 'summary.json');
  const logsRoot = join(runDir, 'cooperbench-logs');
  const cooperbenchRunName = 'newide';

  writeCooperBenchPredictionsJsonl(predictionsPath, [prediction]);
  writeJson(datasetManifestPath, {
    bench: 'CooperBench',
    dataset_dir: datasetDir,
    dataset_subset: options.datasetSubset ?? null,
    case_ids: [parts.case_id],
    setting,
  });

  materializeCooperBenchLogs({
    logsRoot,
    cooperbenchRunName,
    setting,
    predictions: [prediction],
    modelName,
  });

  const runMeta: CooperBenchRunMeta = {
    run_id: runId,
    case_id: parts.case_id,
    setting,
    prediction_mode: predictionMode,
    prediction_semantics: predictionSemantics,
    model_name: modelName,
    dataset_dir: datasetDir,
    dataset_manifest_path: datasetManifestPath,
    patch_source: patchSource,
    cooperbench_logs_dir: logsRoot,
    cooperbench_run_name: cooperbenchRunName,
    started_at: new Date().toISOString(),
  };
  if (options.datasetSubset) {
    runMeta.dataset_subset = options.datasetSubset;
  }
  writeJson(runMetaPath, runMeta);

  const memorySink = new InMemoryTelemetrySink();
  const sink = new CompositeTelemetrySink([memorySink, new JsonlTelemetrySink(telemetryPath)]);
  const harnessPort = createFHarnessTelemetryPort(sink);

  let harnessReport: CooperBenchHarnessReport | undefined;
  let harnessReportPath: string | undefined;

  if (options.harnessReportPath) {
    harnessReportPath = options.harnessReportPath;
    harnessReport = readCooperBenchHarnessReport(options.harnessReportPath);
  }

  if (options.runHarness) {
    const harness = runCooperBenchHarnessAdapter({
      runDir,
      cooperbenchRunName,
      logsRoot,
      caseIds: [parts.case_id],
      setting,
      ...(options.cooperbenchRoot ? { cooperbenchRoot: options.cooperbenchRoot } : {}),
      ...(options.datasetDir ? { datasetDir: options.datasetDir } : {}),
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.force ? { force: true } : {}),
      dryRun: options.harnessDryRun === true,
    });
    harnessReportPath = harness.harnessReportPath;
    if (harness.report) {
      harnessReport = harness.report;
    }
  }

  if (harnessReport) {
    const caseReport = getCooperBenchCaseReport(harnessReport, parts.case_id);
    await harnessPort.recordCooperBenchEvaluation({
      case_id: parts.case_id,
      both_passed: caseReport?.both_passed === true,
      coordination_deficit: computeCoordinationDeficit(caseReport),
      failure_taxonomy: deriveFailureTaxonomy(caseReport),
    });
    if (harnessReportPath) {
      writeJson(harnessReportPath, harnessReport);
    }
  }

  const summary = buildCooperBenchSummary({
    runId,
    caseIds: [parts.case_id],
    setting,
    predictionMode,
    predictionSemantics,
    modelName,
    telemetryPath,
    predictionsPath,
    datasetManifestPath,
    patchSource,
    ...(options.datasetSubset ? { datasetSubset: options.datasetSubset } : {}),
    ...(harnessReport ? { harnessReport } : {}),
    ...(harnessReportPath ? { harnessReportPath } : {}),
    telemetrySink: memorySink,
  });
  writeJson(summaryPath, summary);

  return { runDir, summary, runMeta };
}

export async function runCooperBenchSmoke(
  options: RunCooperBenchSmokeOptions = {},
): Promise<RunCooperBenchCaseResult[]> {
  const manifest = loadCooperBenchManifest();
  const subsetId = options.datasetSubset ?? manifest.default_subset;
  const subset = loadCooperBenchSubset(manifest, subsetId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseRunId = options.runId ?? `cb_smoke_${subsetId}_${stamp}`;

  const results: RunCooperBenchCaseResult[] = [];
  for (const caseId of subset.case_ids) {
    results.push(
      await runCooperBenchCase({
        caseId,
        runId: `${baseRunId}__${caseId}`,
        setting: options.setting ?? subset.default_setting,
        datasetSubset: subsetId,
        ...(options.predictionMode ? { predictionMode: options.predictionMode } : {}),
        ...(options.modelName ? { modelName: options.modelName } : {}),
        ...(options.outRoot ? { outRoot: options.outRoot } : {}),
        ...(options.patchFile ? { patchFile: options.patchFile } : {}),
        ...(options.agent1PatchFile ? { agent1PatchFile: options.agent1PatchFile } : {}),
        ...(options.agent2PatchFile ? { agent2PatchFile: options.agent2PatchFile } : {}),
      }),
    );
  }
  return results;
}

export { parsePredictionMode, parseCooperBenchSetting };
