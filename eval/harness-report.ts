import { readFileSync } from 'node:fs';
import type { SweBenchHarnessReport, SweBenchInstanceReport } from './types';

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

export function hasP2pRegression(report: SweBenchInstanceReport | undefined): boolean {
  const passToPass = report?.tests_status?.PASS_TO_PASS;
  if (!passToPass) {
    return false;
  }
  return Object.values(passToPass).some((status) => status !== 'PASSED');
}

export function countApplied(report: SweBenchInstanceReport | undefined): boolean {
  return report?.patch_successfully_applied === true;
}
