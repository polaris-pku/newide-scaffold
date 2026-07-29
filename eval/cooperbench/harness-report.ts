import { readFileSync } from 'node:fs';
import type { CooperBenchEvalJson, CooperBenchHarnessReport } from './types';

export function readCooperBenchHarnessReport(path: string): CooperBenchHarnessReport {
  return JSON.parse(readFileSync(path, 'utf-8')) as CooperBenchHarnessReport;
}

export function getCooperBenchCaseReport(
  report: CooperBenchHarnessReport | undefined,
  caseId: string,
): CooperBenchEvalJson | undefined {
  return report?.[caseId];
}

export function deriveFailureTaxonomy(evalJson: CooperBenchEvalJson | undefined): string[] {
  if (!evalJson) {
    return ['missing_eval'];
  }
  if (evalJson.error) {
    return ['error'];
  }
  if (evalJson.both_passed) {
    return [];
  }
  const taxonomy: string[] = [];
  const mergeStatus = evalJson.merge?.status;
  if (mergeStatus && mergeStatus !== 'ok' && mergeStatus !== 'identical') {
    taxonomy.push(`merge_${mergeStatus}`);
  }
  const f1 = evalJson.feature1?.passed === true;
  const f2 = evalJson.feature2?.passed === true;
  if (!f1 && !f2) {
    taxonomy.push('both_features_failed');
  } else if (!f1) {
    taxonomy.push('feature1_failed');
  } else if (!f2) {
    taxonomy.push('feature2_failed');
  } else {
    taxonomy.push('unknown_failure');
  }
  return taxonomy;
}

/**
 * Paper-style coordination deficit for a case:
 * - When solo_both_passed is known: 1 if solo passed and coop failed, else 0.
 * - Otherwise: 0 if both_passed else 1 (single-setting proxy; not a true deficit).
 */
export function computeCoordinationDeficit(evalJson: CooperBenchEvalJson | undefined): number {
  if (!evalJson) {
    return 1;
  }
  if (typeof evalJson.solo_both_passed === 'boolean' && evalJson.setting === 'coop') {
    return evalJson.solo_both_passed && !evalJson.both_passed ? 1 : 0;
  }
  return evalJson.both_passed ? 0 : 1;
}
