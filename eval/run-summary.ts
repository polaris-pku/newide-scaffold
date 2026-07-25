import { writeFileSync } from 'node:fs';
import type { InMemoryTelemetrySink } from '../src/telemetry/telemetry-sink';
import type {
  EvalRunMeta,
  EvalSummary,
  MemoryAblation,
  PatchSource,
  PredictionMode,
  SweBenchHarnessReport,
} from './types';
import { countApplied, getInstanceReport, hasP2pRegression } from './harness-report';

export interface BuildSummaryInput {
  runId: string;
  instanceIds: string[];
  predictionMode: PredictionMode;
  predictionSemantics: string;
  memoryAblation: MemoryAblation;
  modelName: string;
  telemetryPath: string;
  predictionsPath: string;
  datasetManifestPath: string;
  patchSource: PatchSource;
  worktreePath?: string;
  backendSummaryPath?: string;
  datasetSubset?: string;
  harnessReport?: SweBenchHarnessReport;
  harnessReportPath?: string;
  telemetrySink: InMemoryTelemetrySink;
}

export function buildEvalSummary(input: BuildSummaryInput): EvalSummary {
  let resolvedCount = 0;
  let unresolvedCount = 0;
  let appliedCount = 0;
  let p2pRegressionCount = 0;

  for (const instanceId of input.instanceIds) {
    const report = input.harnessReport
      ? getInstanceReport(input.harnessReport, instanceId)
      : undefined;
    if (report?.resolved) {
      resolvedCount += 1;
    } else if (report) {
      unresolvedCount += 1;
    }
    if (countApplied(report)) {
      appliedCount += 1;
    }
    if (hasP2pRegression(report)) {
      p2pRegressionCount += 1;
    }
  }

  const telemetryEventTypes = [...new Set(input.telemetrySink.list().map((r) => r.event_type))];

  const summary: EvalSummary = {
    run_id: input.runId,
    instance_ids: input.instanceIds,
    prediction_mode: input.predictionMode,
    prediction_semantics: input.predictionSemantics,
    memory_ablation: input.memoryAblation,
    model_name: input.modelName,
    telemetry_path: input.telemetryPath,
    predictions_path: input.predictionsPath,
    dataset_manifest_path: input.datasetManifestPath,
    patch_source: input.patchSource,
    resolved_count: resolvedCount,
    unresolved_count: unresolvedCount,
    applied_count: appliedCount,
    p2p_regression_count: p2pRegressionCount,
    telemetry_event_types: telemetryEventTypes.sort(),
    completed_at: new Date().toISOString(),
  };

  if (input.harnessReportPath) {
    summary.harness_report_path = input.harnessReportPath;
  }
  if (input.datasetSubset) {
    summary.dataset_subset = input.datasetSubset;
  }
  if (input.worktreePath) {
    summary.worktree_path = input.worktreePath;
  }
  if (input.backendSummaryPath) {
    summary.backend_summary_path = input.backendSummaryPath;
  }

  return summary;
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

export function writeRunMeta(path: string, meta: EvalRunMeta): void {
  writeJson(path, meta);
}
