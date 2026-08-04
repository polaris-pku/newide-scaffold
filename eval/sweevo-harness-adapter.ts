import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
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
  /** Override dataset JSONL (e.g. verified-30 slice); defaults to manifest.dataset_jsonl. */
  datasetPath?: string;
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

/** Convert a Windows path to a WSL `/mnt/<drive>/...` path. No-op for already-POSIX paths. */
export function toWslPath(pathLike: string): string {
  const forward = pathLike.replace(/\\/g, '/');
  if (forward.startsWith('/mnt/') || (forward.startsWith('/') && !/^[A-Za-z]:/.test(pathLike))) {
    // Already a WSL/POSIX absolute path — do not resolve on Windows (would become D:\mnt\...).
    return forward;
  }
  const absolute = resolve(pathLike);
  const match = /^([A-Za-z]):[\\/]?(.*)$/.exec(absolute);
  if (!match) {
    return absolute.replace(/\\/g, '/');
  }
  const drive = match[1]!.toLowerCase();
  const rest = (match[2] ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

function resolveSweEvoPython(): string {
  return process.env.NEWIDE_SWE_EVO_PYTHON?.trim() || 'python';
}

function resolveSweEvoWslDistro(): string {
  return process.env.NEWIDE_SWE_EVO_WSL_DISTRO?.trim() || 'Ubuntu-22.04';
}

function resolveSweEvoWslPython(): string {
  return process.env.NEWIDE_SWE_EVO_WSL_PYTHON?.trim() || 'python3';
}

export function buildSweEvoHarnessCommand(input: {
  sweEvoRoot: string;
  workDir: string;
  trajectoryDir: string;
  maxWorkers: number;
}): SweEvoHarnessAdapterResult['command'] {
  const python = resolveSweEvoPython();
  const scriptPath = join(input.sweEvoRoot, 'SWE-bench', 'evaluate_instance.py');
  const viaWsl = python.toLowerCase() === 'wsl';
  const trajectoriesPath = viaWsl
    ? toWslPath(input.trajectoryDir)
    : input.trajectoryDir.replace(/\\/g, '/');
  const scriptArgs = [
    '--scaffold',
    'OpenHands',
    '--trajectories_path',
    trajectoriesPath,
    '--max_workers',
    String(input.maxWorkers),
  ];

  if (viaWsl) {
    return {
      cwd: input.workDir,
      command: 'wsl',
      args: [
        '-d',
        resolveSweEvoWslDistro(),
        '--cd',
        toWslPath(input.workDir),
        '--',
        resolveSweEvoWslPython(),
        toWslPath(scriptPath),
        ...scriptArgs,
      ],
    };
  }

  return {
    cwd: input.workDir,
    command: python,
    args: [scriptPath, ...scriptArgs],
  };
}

export async function writeOutputFinalInstances(
  path: string,
  predictions: SweBenchPrediction[],
  datasetPathOverride?: string,
): Promise<void> {
  const manifest = loadManifest();
  const datasetPath = resolveDatasetJsonl(manifest, datasetPathOverride);
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

/**
 * Collect per-instance `report.json` files written by SWE-EVO's
 * `evaluate_instance.py` under `<workDir>/logs/run_evaluation/<run>/<run>/<instance_id>/`.
 * Returns a merged harness report keyed by instance_id.
 */
export function collectSweEvoInstanceReports(input: {
  workDir: string;
  trajectoryDir: string;
  instanceIds: string[];
}): { report: SweBenchHarnessReport; missing: string[] } {
  const runName = basename(input.trajectoryDir);
  const primaryDir = join(input.workDir, 'logs', 'run_evaluation', runName, runName);
  const searchRoot = join(input.workDir, 'logs', 'run_evaluation');
  const report: SweBenchHarnessReport = {};
  const missing: string[] = [];

  for (const instanceId of input.instanceIds) {
    let reportPath: string | undefined = join(primaryDir, instanceId, 'report.json');
    if (!existsSync(reportPath)) {
      reportPath = findInstanceReport(searchRoot, instanceId);
    }
    if (!reportPath) {
      missing.push(instanceId);
      continue;
    }
    const parsed = JSON.parse(readFileSync(reportPath, 'utf-8')) as SweBenchHarnessReport;
    const entry = parsed[instanceId] ?? Object.values(parsed)[0];
    if (entry) {
      report[instanceId] = entry;
    } else {
      missing.push(instanceId);
    }
  }
  return { report, missing };
}

function findInstanceReport(searchRoot: string, instanceId: string): string | undefined {
  if (!existsSync(searchRoot)) return undefined;
  const wanted = `${sep}${instanceId}${sep}report.json`;
  try {
    const entries = readdirSync(searchRoot, { recursive: true }) as string[];
    for (const entry of entries) {
      const candidate = String(entry);
      if (candidate.endsWith('report.json') && `${sep}${candidate}`.includes(wanted)) {
        return join(searchRoot, candidate);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
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
  await writeOutputFinalInstances(outputFinalDir, predictions, options.datasetPath);

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
    swe_evo_python: resolveSweEvoPython(),
    note: 'Run this command in the SWE-EVO environment. On Windows, set NEWIDE_SWE_EVO_PYTHON=wsl to invoke via WSL. Pass --report-source when a harness report is available to normalize it into harness-report.json.',
  });

  let report: SweBenchHarnessReport = {};
  if (options.reportSource) {
    report = JSON.parse(readFileSync(options.reportSource, 'utf-8')) as SweBenchHarnessReport;
  }
  writeHarnessReport(harnessReportPath, report);

  if (!options.dryRun) {
    const viaWsl = command.command === 'wsl';
    const completed = spawnSync(command.command, command.args, {
      // WSL uses `--cd`; Node cwd is only for native python.
      ...(viaWsl ? {} : { cwd: command.cwd }),
      stdio: 'inherit',
      // Avoid cmd.exe mangling `wsl -d ... -- python3 ...` arg boundaries.
      shell: process.platform === 'win32' && !viaWsl,
    });
    if (completed.status !== 0) {
      throw new Error(`SWE-EVO harness exited with status ${completed.status ?? 'unknown'}`);
    }

    // Fold the per-instance report.json files the harness just produced into
    // harness-report.json; otherwise downstream resolved/applied counts stay 0.
    const collected = collectSweEvoInstanceReports({
      workDir,
      trajectoryDir,
      instanceIds: predictions.map((prediction) => prediction.instance_id),
    });
    report = { ...report, ...collected.report };
    writeHarnessReport(harnessReportPath, report);
    if (Object.keys(report).length === 0 && predictions.length > 0) {
      throw new Error(
        `SWE-EVO harness completed but no per-instance report.json was found under ` +
          `${join(workDir, 'logs', 'run_evaluation')} (missing: ${collected.missing.join(', ')}). ` +
          'Refusing to score this run as all-unresolved; inspect harness logs.',
      );
    }
    if (collected.missing.length > 0) {
      console.warn(
        `[sweevo-harness] missing report.json for: ${collected.missing.join(', ')}`,
      );
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
