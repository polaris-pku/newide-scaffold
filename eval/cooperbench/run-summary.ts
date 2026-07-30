import type { InMemoryTelemetrySink } from '../../src/telemetry/telemetry-sink';
import { computeCoordinationDeficit, getCooperBenchCaseReport } from './harness-report';
import type {
  CooperBenchHarnessReport,
  CooperBenchPredictionMode,
  CooperBenchPatchSource,
  CooperBenchSetting,
  CooperBenchSummary,
} from './types';

export function buildCooperBenchSummary(input: {
  runId: string;
  caseIds: string[];
  setting: CooperBenchSetting;
  predictionMode: CooperBenchPredictionMode;
  predictionSemantics: string;
  modelName: string;
  telemetryPath: string;
  predictionsPath: string;
  datasetManifestPath: string;
  patchSource: CooperBenchPatchSource;
  datasetSubset?: string;
  harnessReport?: CooperBenchHarnessReport;
  harnessReportPath?: string;
  telemetrySink: InMemoryTelemetrySink;
}): CooperBenchSummary {
  let bothPassedCount = 0;
  let bothFailedCount = 0;
  let coordinationDeficitSum = 0;

  for (const caseId of input.caseIds) {
    const caseReport = getCooperBenchCaseReport(input.harnessReport, caseId);
    if (caseReport?.both_passed) {
      bothPassedCount += 1;
    } else if (caseReport) {
      bothFailedCount += 1;
    }
    if (caseReport) {
      coordinationDeficitSum += computeCoordinationDeficit(caseReport);
    }
  }

  const telemetryEventTypes = [...new Set(input.telemetrySink.list().map((r) => r.event_type))];

  const summary: CooperBenchSummary = {
    run_id: input.runId,
    case_ids: input.caseIds,
    setting: input.setting,
    prediction_mode: input.predictionMode,
    prediction_semantics: input.predictionSemantics,
    model_name: input.modelName,
    telemetry_path: input.telemetryPath,
    predictions_path: input.predictionsPath,
    dataset_manifest_path: input.datasetManifestPath,
    patch_source: input.patchSource,
    both_passed_count: bothPassedCount,
    both_failed_count: bothFailedCount,
    coordination_deficit_sum: coordinationDeficitSum,
    telemetry_event_types: telemetryEventTypes.sort(),
    completed_at: new Date().toISOString(),
  };

  if (input.harnessReportPath) {
    summary.harness_report_path = input.harnessReportPath;
  }
  if (input.datasetSubset) {
    summary.dataset_subset = input.datasetSubset;
  }

  return summary;
}
