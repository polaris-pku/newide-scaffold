import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompositeTelemetrySink, JsonlTelemetrySink } from '../src/telemetry/jsonl-telemetry-sink';
import { createFHarnessTelemetryPort } from '../src/telemetry/harness-port';
import { InMemoryTelemetrySink } from '../src/telemetry/telemetry-sink';
import { getInstanceOrThrow, indexDatasetById, loadDataset } from './load-dataset';
import { loadDatasetSubset, loadManifest, resolveDatasetJsonl, resolveRunDir } from './paths';
import { buildPrediction, writePredictionsJsonl } from './prediction-writer';
import { getInstanceReport, hasP2pRegression, readHarnessReport } from './harness-report';
import { buildEvalSummary, writeJson, writeRunMeta } from './run-summary';
import { runSweEvoHarnessAdapter, type SweEvoHarnessAdapterResult } from './sweevo-harness-adapter';
import type {
  EvalRunMeta,
  EvalSummary,
  MemoryAblation,
  PatchSource,
  PredictionMode,
  SweBenchHarnessReport,
  SweEvoInstance,
} from './types';
import { describePredictionMode } from './validation';
import {
  applyPatchToWorktree,
  assertWorktreeClean,
  prepareEphemeralWorktree,
  removeEphemeralWorktree,
} from './prepare-worktree';
import { collectWorktreePatch, readBackendWorktreePath } from './worktree-patch';

export interface RunInstanceOptions {
  instanceId: string;
  runId?: string;
  predictionMode?: PredictionMode;
  memoryAblation?: MemoryAblation;
  modelName?: string;
  datasetPath?: string;
  datasetSubset?: string;
  outRoot?: string;
  /** Optional pre-existing harness report to fold into summary/telemetry. */
  harnessReportPath?: string;
  instanceSeq?: number;
  patchFile?: string;
  worktreePath?: string;
  /** Source git repo used to create a disposable worktree at instance.base_commit */
  ephemeralFrom?: string;
  /** Allow collecting a patch from an already-dirty worktree (opt-in). */
  allowDirtyWorktree?: boolean;
  /** Keep ephemeral worktree after collecting the patch (default: remove). */
  keepWorktree?: boolean;
  backendSummaryPath?: string;
  runSweEvoHarness?: boolean;
  harnessDryRun?: boolean;
  sweEvoRoot?: string;
  harnessMaxWorkers?: number;
}

export interface RunInstanceResult {
  runDir: string;
  summary: EvalSummary;
  runMeta: EvalRunMeta;
  harness?: SweEvoHarnessAdapterResult;
}

function createRunId(instanceId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}_${instanceId}`;
}

function resolveInstanceDatasetPath(
  manifest: ReturnType<typeof loadManifest>,
  options: Pick<RunInstanceOptions, 'datasetPath' | 'datasetSubset'>,
): string {
  if (options.datasetPath?.trim()) {
    return resolveDatasetJsonl(manifest, options.datasetPath);
  }
  if (options.datasetSubset) {
    const subset = loadDatasetSubset(manifest, options.datasetSubset);
    if (subset.source_jsonl?.trim()) {
      return resolveDatasetJsonl(manifest, subset.source_jsonl);
    }
  }
  return resolveDatasetJsonl(manifest);
}

export async function runEvalInstance(options: RunInstanceOptions): Promise<RunInstanceResult> {
  const manifest = loadManifest();
  const datasetPath = resolveInstanceDatasetPath(manifest, options);
  const instances = indexDatasetById(await loadDataset(datasetPath));
  const instance = getInstanceOrThrow(instances, options.instanceId);

  const predictionMode = options.predictionMode ?? 'stub';
  const memoryAblation = options.memoryAblation ?? 'B2';
  const modelName = options.modelName ?? manifest.default_model_name;
  const runId = options.runId ?? createRunId(instance.instance_id);
  const runDir = resolveRunDir(runId, options.outRoot);
  mkdirSync(runDir, { recursive: true });
  const patchInput = await resolvePatchInput(instance, predictionMode, options, runId);
  const predictionSemantics = describePredictionMode(predictionMode, patchInput.patchSource);

  const telemetryPath = join(runDir, 'telemetry.jsonl');
  const predictionsPath = join(runDir, 'predictions.jsonl');
  const datasetManifestPath = join(runDir, 'dataset-manifest.json');
  const runMetaPath = join(runDir, 'run-meta.json');
  const summaryPath = join(runDir, 'summary.json');
  const datasetSubset = options.datasetSubset;

  try {
    writeFileSync(telemetryPath, '', { flag: 'a' });
    writeJson(datasetManifestPath, {
      dataset_version: manifest.dataset_version,
      dataset_jsonl: datasetPath,
      dataset_hf_dir: manifest.dataset_hf_dir,
      subset_id: datasetSubset,
      instance_ids: [instance.instance_id],
    });

    const memorySink = new InMemoryTelemetrySink();
    const sink = new CompositeTelemetrySink([memorySink, new JsonlTelemetrySink(telemetryPath)]);

    const runMeta: EvalRunMeta = {
      run_id: runId,
      instance_id: instance.instance_id,
      repo: instance.repo,
      prediction_mode: predictionMode,
      prediction_semantics: predictionSemantics,
      memory_ablation: memoryAblation,
      model_name: modelName,
      dataset_jsonl: datasetPath,
      dataset_manifest_path: datasetManifestPath,
      patch_source: patchInput.patchSource,
      ...(patchInput.worktreePath ? { worktree_path: patchInput.worktreePath } : {}),
      ...(options.backendSummaryPath ? { backend_summary_path: options.backendSummaryPath } : {}),
      started_at: new Date().toISOString(),
    };
    if (datasetSubset) {
      runMeta.dataset_subset = datasetSubset;
    }
    writeRunMeta(runMetaPath, runMeta);

    const prediction = buildPrediction(instance, modelName, predictionMode, patchInput.realPatch);
    writePredictionsJsonl(predictionsPath, [prediction]);

    const harnessPort = createFHarnessTelemetryPort(sink);
    let harnessReport: SweBenchHarnessReport | undefined;
    let harnessReportPath = options.harnessReportPath;
    let harness: SweEvoHarnessAdapterResult | undefined;

    if (options.runSweEvoHarness) {
      harness = await runSweEvoHarnessAdapter({
        predictionsPath,
        runId,
        ...(options.outRoot ? { outRoot: options.outRoot } : {}),
        ...(options.sweEvoRoot ? { sweEvoRoot: options.sweEvoRoot } : {}),
        ...(options.harnessMaxWorkers ? { maxWorkers: options.harnessMaxWorkers } : {}),
        dryRun: options.harnessDryRun ?? false,
      });
      harnessReportPath = harness.harnessReportPath;
      const fromAdapter = readHarnessReport(harness.harnessReportPath);
      if (Object.keys(fromAdapter).length > 0) {
        harnessReport = fromAdapter;
      }
    }

    if (!harnessReport && harnessReportPath) {
      const candidate = readHarnessReport(harnessReportPath);
      if (Object.keys(candidate).length > 0) {
        harnessReport = candidate;
      }
    }

    const hasHarnessScores = Boolean(harnessReport && harnessReportPath);

    if (hasHarnessScores && harnessReport && harnessReportPath) {
      const instanceReport = getInstanceReport(harnessReport, instance.instance_id);
      await harnessPort.recordSweEvoEvaluation({
        instance_id: instance.instance_id,
        instance_seq: options.instanceSeq ?? 1,
        resolved: instanceReport?.resolved === true,
        applied: instanceReport?.patch_successfully_applied === true,
        p2p_regression: hasP2pRegression(instanceReport),
        memory_ablation: memoryAblation,
      });
    }

    const summaryInput = {
      runId,
      instanceIds: [instance.instance_id],
      predictionMode,
      predictionSemantics,
      memoryAblation,
      modelName,
      telemetryPath,
      predictionsPath,
      datasetManifestPath,
      patchSource: patchInput.patchSource,
      ...(patchInput.worktreePath ? { worktreePath: patchInput.worktreePath } : {}),
      ...(options.backendSummaryPath ? { backendSummaryPath: options.backendSummaryPath } : {}),
      telemetrySink: memorySink,
    };

    const summary = buildEvalSummary(
      hasHarnessScores && harnessReport && harnessReportPath
        ? {
            ...summaryInput,
            harnessReport,
            harnessReportPath,
          }
        : summaryInput,
    );
    writeJson(summaryPath, summary);

    return { runDir, summary, runMeta, ...(harness ? { harness } : {}) };
  } finally {
    if (patchInput.ephemeral && !options.keepWorktree) {
      await removeEphemeralWorktree(
        patchInput.ephemeral.sourceRepo,
        patchInput.ephemeral.worktreePath,
      );
    }
  }
}

interface ResolvedPatchInput {
  patchSource: PatchSource;
  realPatch?: string;
  worktreePath?: string;
  ephemeral?: { sourceRepo: string; worktreePath: string };
}

async function resolvePatchInput(
  instance: SweEvoInstance,
  predictionMode: PredictionMode,
  options: RunInstanceOptions,
  runId: string,
): Promise<ResolvedPatchInput> {
  if (predictionMode === 'stub') return { patchSource: 'stub' };
  if (predictionMode === 'oracle') return { patchSource: 'oracle' };

  // Ephemeral disposable worktree: clean checkout at base_commit, optional seed patch, then diff.
  if (options.ephemeralFrom) {
    const prepared = await prepareEphemeralWorktree({
      sourceRepo: options.ephemeralFrom,
      baseCommit: instance.base_commit,
      runId,
    });
    try {
      const seedPatch =
        options.patchFile !== undefined ? readFileSync(options.patchFile, 'utf-8') : undefined;
      if (seedPatch !== undefined) {
        await applyPatchToWorktree(prepared.worktreePath, seedPatch);
      } else {
        throw new Error(
          [
            'Ephemeral worktree was created clean at base_commit.',
            'Pass --patch-file <patch> to seed changes onto the disposable tree, then collect.',
            'To let an agent edit first: re-run with',
            `--ephemeral-from ${options.ephemeralFrom} --keep-worktree` +
              ' (prepare-only is not supported yet), or point the agent at a fresh worktree and',
            'collect with --worktree-path <dir> --allow-dirty-worktree.',
          ].join(' '),
        );
      }
      return {
        patchSource: 'worktree_git_diff',
        realPatch: await collectWorktreePatch(prepared.worktreePath, {
          baseRef: instance.base_commit,
        }),
        worktreePath: prepared.worktreePath,
        ephemeral: { sourceRepo: prepared.sourceRepo, worktreePath: prepared.worktreePath },
      };
    } catch (error) {
      if (!options.keepWorktree) {
        await removeEphemeralWorktree(prepared.sourceRepo, prepared.worktreePath);
      }
      throw error;
    }
  }

  if (options.patchFile) {
    return {
      patchSource: 'patch_file',
      realPatch: readFileSync(options.patchFile, 'utf-8'),
    };
  }

  const worktreePath =
    options.worktreePath ??
    (options.backendSummaryPath ? readBackendWorktreePath(options.backendSummaryPath) : undefined);
  if (!worktreePath) {
    throw new Error(
      'Prediction mode "real" requires --patch-file, --worktree-path, --backend-summary, or --ephemeral-from.',
    );
  }

  if (!options.allowDirtyWorktree) {
    await assertWorktreeClean(worktreePath);
  }

  return {
    patchSource: 'worktree_git_diff',
    realPatch: await collectWorktreePatch(worktreePath, { baseRef: instance.base_commit }),
    worktreePath,
  };
}

export interface RunSmokeOptions {
  runId?: string;
  predictionMode?: PredictionMode;
  memoryAblation?: MemoryAblation;
  modelName?: string;
  datasetPath?: string;
  datasetSubset?: string;
  outRoot?: string;
  instanceIds?: string[];
  patchFile?: string;
}

export async function runEvalSmoke(options: RunSmokeOptions = {}): Promise<RunInstanceResult[]> {
  const manifest = loadManifest();
  const subsetId = options.datasetSubset ?? manifest.default_subset ?? 'v0-smoke';
  const subset = options.instanceIds ? undefined : loadDatasetSubset(manifest, subsetId);
  const instanceIds =
    options.instanceIds ?? subset?.instance_ids ?? manifest.smoke_instance_ids ?? [];
  if (instanceIds.length === 0) {
    throw new Error(
      `No instance ids for smoke run (subset="${subsetId}"). Pass --subset or instanceIds.`,
    );
  }
  const datasetPath = options.datasetPath?.trim() || subset?.source_jsonl?.trim() || undefined;
  const runId = options.runId ?? `smoke_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const results: RunInstanceResult[] = [];

  for (let index = 0; index < instanceIds.length; index += 1) {
    const instanceId = instanceIds[index]!;
    const instanceOptions: RunInstanceOptions = {
      instanceId,
      runId: `${runId}__${instanceId}`,
      instanceSeq: index + 1,
      datasetSubset: subsetId,
    };
    if (options.predictionMode) {
      instanceOptions.predictionMode = options.predictionMode;
    }
    if (options.memoryAblation) {
      instanceOptions.memoryAblation = options.memoryAblation;
    }
    if (options.modelName) {
      instanceOptions.modelName = options.modelName;
    }
    if (datasetPath) {
      instanceOptions.datasetPath = datasetPath;
    }
    if (options.datasetSubset) {
      instanceOptions.datasetSubset = options.datasetSubset;
    }
    if (options.outRoot) {
      instanceOptions.outRoot = options.outRoot;
    }
    if (options.patchFile) {
      instanceOptions.patchFile = options.patchFile;
    }

    const result = await runEvalInstance(instanceOptions);
    results.push(result);
  }

  return results;
}
