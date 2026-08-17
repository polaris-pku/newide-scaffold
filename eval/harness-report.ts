import { readFileSync } from 'node:fs';
import type { SweBenchHarnessReport, SweBenchInstanceReport, SweBenchTestStatus } from './types';

export function readHarnessReport(path: string): SweBenchHarnessReport {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as SweBenchHarnessReport;
}

export function getInstanceReport(
  report: SweBenchHarnessReport,
  instanceId: string,
): SweBenchInstanceReport | undefined {
  return report[instanceId];
}

function isSuccessFailureShape(
  status: SweBenchTestStatus,
): status is { success?: string[]; failure?: string[] } {
  const candidate = status as { success?: unknown; failure?: unknown };
  return Array.isArray(candidate.success) || Array.isArray(candidate.failure);
}

/** Count of tests marked failing, handling both harness report shapes. */
export function countFailedTests(status: SweBenchTestStatus | undefined): number {
  if (!status) return 0;
  if (isSuccessFailureShape(status)) {
    return status.failure?.length ?? 0;
  }
  return Object.values(status).filter((value) => value !== 'PASSED').length;
}

export function hasP2pRegression(report: SweBenchInstanceReport | undefined): boolean {
  return countFailedTests(report?.tests_status?.PASS_TO_PASS) > 0;
}

export function countApplied(report: SweBenchInstanceReport | undefined): boolean {
  return report?.patch_successfully_applied === true;
}
