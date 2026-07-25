import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadManifest, resolveDatasetJsonl, resolveRunDir, resolveSweEvoRoot } from './paths';
import { getInstanceOrThrow, indexDatasetById, loadDataset } from './load-dataset';
import { writeJson } from './run-summary';
import type { SweBenchHarnessReport, SweBenchPrediction, SweEvoInstance } from './types';

export interface SweEvoHarnessAdapterOptions {
  predictionsPath: string;
  runId: string;
  outRoot?: string;
  sweEvoRoot?: string;
  maxWorkers?: number;
  dryRun?: boolean;
  reportSource?: string;
}

export interface SweEvoHarnessAdapterResult {
  runDir: string;
  trajectoryDir: string;
  trajectoryPath: string;
  commandPath: string;
  harnessReportPath: string;
  workDir: string;
  outputFinalDir: string;
  command: {
    cwd: string;
    command: string;
    args: string[];
  };
}

export function readPredictionsJsonl(path: string): SweBenchPrediction[] {
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SweBenchPrediction);
}

export function writeOpenHandsTrajectory(path: string, predictions: SweBenchPrediction[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = predictions
    .map((prediction) =>
      JSON.stringify({
        instance_id: prediction.instance_id,
        test_result: {
          git_patch: prediction.model_patch,
        },
      }),
    )
    .join('\n');
  writeFileSync(path, body.length > 0 ? `${body}\n` : '', 'utf-8');
}

export function buildSweEvoHarnessCommand(input: {
  sweEvoRoot: string;
  workDir: string;
  trajectoryDir: string;
  maxWorkers: number;
}): SweEvoHarnessAdapterResult['command'] {
  return {
    cwd: input.workDir,
    command: 'python',
    args: [
      join(input.sweEvoRoot, 'SWE-bench', 'evaluate_instance.py'),
      '--scaffold',
      'OpenHands',
      '--trajectories_path',
      input.trajectoryDir.replace(/\\/g, '/'),
      '--max_workers',
      String(input.maxWorkers),
    ],
  };
}

export async function writeOutputFinalInstances(
  path: string,
  predictions: SweBenchPrediction[],
): Promise<void> {
  const manifest = loadManifest();
  const datasetPath = resolveDatasetJsonl(manifest);
  const instances = indexDatasetById(await loadDataset(datasetPath));
  mkdirSync(path, { recursive: true });

  for (const prediction of predictions) {
    const instance: SweEvoInstance = getInstanceOrThrow(instances, prediction.instance_id);
    writeJson(join(path, `${prediction.instance_id}.json`), instance);
  }
}

export function writeHarnessReport(path: string, report: SweBenchHarnessReport): void {
  writeJson(path, report);
}

export async function runSweEvoHarnessAdapter(
  options: SweEvoHarnessAdapterOptions,
): Promise<SweEvoHarnessAdapterResult> {
  const predictions = readPredictionsJsonl(options.predictionsPath);
  const runDir = resolveRunDir(options.runId, options.outRoot);
  const trajectoryDir = join(runDir, 'sweevo-openhands');
  const trajectoryPath = join(trajectoryDir, 'output.jsonl');
  const workDir = join(runDir, 'sweevo-work');
  const outputFinalDir = join(workDir, 'output_final');
  const commandPath = join(runDir, 'harness-command.json');
  const harnessReportPath = join(runDir, 'harness-report.json');
  const sweEvoRoot = resolve(options.sweEvoRoot ?? resolveSweEvoRoot() ?? '../SWE-EVO');
  const maxWorkers = options.maxWorkers ?? 4;

  mkdirSync(runDir, { recursive: true });
  const storedPredictionsPath = join(runDir, 'predictions.jsonl');
  if (resolve(options.predictionsPath) !== resolve(storedPredictionsPath)) {
    copyFileSync(options.predictionsPath, storedPredictionsPath);
  }
  writeOpenHandsTrajectory(trajectoryPath, predictions);
  await writeOutputFinalInstances(outputFinalDir, predictions);

  const command = buildSweEvoHarnessCommand({
    sweEvoRoot,
    workDir,
    trajectoryDir,
    maxWorkers,
  });
  writeJson(commandPath, {
    ...command,
    run_id: options.runId,
    predictions_path: options.predictionsPath,
    trajectory_path: trajectoryPath,
    output_final_dir: outputFinalDir,
    note: 'Run this command in the SWE-EVO environment. Pass --report-source when a harness report is available to normalize it into harness-report.json.',
  });

  if (options.reportSource) {
    const report = JSON.parse(readFileSync(options.reportSource, 'utf-8')) as SweBenchHarnessReport;
    writeHarnessReport(harnessReportPath, report);
  } else {
    writeHarnessReport(harnessReportPath, {});
  }

  if (!options.dryRun) {
    const completed = spawnSync(command.command, command.args, {
      cwd: command.cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (completed.status !== 0) {
      throw new Error(`SWE-EVO harness exited with status ${completed.status ?? 'unknown'}`);
    }
  }

  return {
    runDir,
    trajectoryDir,
    trajectoryPath,
    commandPath,
    harnessReportPath,
    workDir,
    outputFinalDir,
    command,
  };
}
