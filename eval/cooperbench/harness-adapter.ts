import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { featureDirName, parseCooperBenchCaseId } from './cases';
import type { CooperBenchEvalJson, CooperBenchHarnessReport, CooperBenchSetting } from './types';
import { writeJson } from '../run-summary';
import { resolveCooperBenchDatasetDir, resolveCooperBenchRoot } from './paths';

export interface CooperBenchHarnessAdapterOptions {
  runDir: string;
  cooperbenchRunName: string;
  logsRoot: string;
  caseIds: string[];
  setting: CooperBenchSetting;
  cooperbenchRoot?: string;
  datasetDir?: string;
  backend?: 'docker' | 'modal' | 'gcp';
  concurrency?: number;
  force?: boolean;
  dryRun?: boolean;
}

export interface CooperBenchHarnessAdapterResult {
  commandPath: string;
  harnessReportPath: string;
  command: {
    cwd: string;
    command: string;
    args: string[];
  };
  report?: CooperBenchHarnessReport;
}

export function resolveCooperBenchPython(cooperbenchRoot: string): string {
  const fromEnv = process.env.NEWIDE_COOPERBENCH_PYTHON?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const homeVenv = process.env.HOME
    ? join(process.env.HOME, '.venvs', 'cooperbench', 'bin', 'python')
    : undefined;
  const candidates = [
    ...(homeVenv ? [homeVenv] : []),
    join(cooperbenchRoot, '.venv', 'bin', 'python'),
    join(cooperbenchRoot, '.venv', 'Scripts', 'python.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return 'python';
}

export function buildCooperBenchEvalCommand(input: {
  cooperbenchRoot: string;
  cooperbenchRunName: string;
  logsRoot: string;
  datasetDir: string;
  backend: string;
  concurrency: number;
  force: boolean;
}): CooperBenchHarnessAdapterResult['command'] {
  const args = [
    '-m',
    'cooperbench.cli',
    'eval',
    '-n',
    input.cooperbenchRunName,
    '--backend',
    input.backend,
    '--log-dir',
    input.logsRoot.replace(/\\/g, '/'),
    '--dataset-dir',
    input.datasetDir.replace(/\\/g, '/'),
    '-c',
    String(input.concurrency),
  ];
  if (input.force) {
    args.push('--force');
  }
  return {
    cwd: input.cooperbenchRoot,
    command: resolveCooperBenchPython(input.cooperbenchRoot),
    args,
  };
}

export function collectCooperBenchEvalReports(input: {
  logsRoot: string;
  cooperbenchRunName: string;
  setting: CooperBenchSetting;
  caseIds: string[];
}): CooperBenchHarnessReport {
  const report: CooperBenchHarnessReport = {};
  for (const caseId of input.caseIds) {
    const parts = parseCooperBenchCaseId(caseId);
    const evalPath = join(
      input.logsRoot,
      input.cooperbenchRunName,
      input.setting,
      parts.repo,
      String(parts.task_id),
      featureDirName(parts.features),
      'eval.json',
    );
    if (!existsSync(evalPath)) {
      continue;
    }
    report[caseId] = JSON.parse(readFileSync(evalPath, 'utf-8')) as CooperBenchEvalJson;
  }
  return report;
}

export function runCooperBenchHarnessAdapter(
  options: CooperBenchHarnessAdapterOptions,
): CooperBenchHarnessAdapterResult {
  const cooperbenchRoot = resolve(options.cooperbenchRoot ?? resolveCooperBenchRoot());
  const datasetDir = resolve(options.datasetDir ?? resolveCooperBenchDatasetDir());
  const backend = options.backend ?? 'docker';
  const concurrency = options.concurrency ?? 2;
  const force = options.force ?? false;

  mkdirSync(options.runDir, { recursive: true });
  const commandPath = join(options.runDir, 'harness-command.json');
  const harnessReportPath = join(options.runDir, 'harness-report.json');

  const command = buildCooperBenchEvalCommand({
    cooperbenchRoot,
    cooperbenchRunName: options.cooperbenchRunName,
    logsRoot: options.logsRoot,
    datasetDir,
    backend,
    concurrency,
    force,
  });
  writeJson(commandPath, command);

  if (options.dryRun) {
    return { commandPath, harnessReportPath, command };
  }

  const result = spawnSync(command.command, command.args, {
    cwd: command.cwd,
    encoding: 'utf-8',
    shell: false,
    env: process.env,
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || result.stdout?.trim() || 'unknown error';
    throw new Error(
      `CooperBench harness failed (exit=${String(result.status)}): ${stderr}\nCommand: ${command.command} ${command.args.join(' ')}`,
    );
  }

  const report = collectCooperBenchEvalReports({
    logsRoot: options.logsRoot,
    cooperbenchRunName: options.cooperbenchRunName,
    setting: options.setting,
    caseIds: options.caseIds,
  });
  writeJson(harnessReportPath, report);
  return { commandPath, harnessReportPath, command, report };
}
