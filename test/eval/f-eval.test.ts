import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getInstanceReport, hasP2pRegression } from '../../eval/harness-report';
import { indexDatasetById, loadDataset } from '../../eval/load-dataset';
import { buildPrediction, writePredictionsJsonl } from '../../eval/prediction-writer';
import { assertWorktreeClean } from '../../eval/prepare-worktree';
import { runEvalInstance, runEvalSmoke } from '../../eval/run-instance-core';
import { runSweEvoHarnessAdapter } from '../../eval/sweevo-harness-adapter';
import type { SweEvoInstance } from '../../eval/types';
import { parsePredictionMode } from '../../eval/validation';

const SAMPLE_INSTANCE: SweEvoInstance = {
  repo: 'demo/repo',
  instance_id: 'demo__repo_1.0_1.1',
  base_commit: 'abc123',
  patch: 'diff --git a/README.md b/README.md\n',
  problem_statement: 'Fix the bug in demo repo.',
  FAIL_TO_PASS: ['tests/test_demo.py::test_fix'],
  PASS_TO_PASS: ['tests/test_demo.py::test_existing'],
};

describe('F eval utilities', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.NEWIDE_SCAFFOLD_ROOT;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads dataset jsonl and builds oracle SWE-bench predictions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-dataset-'));
    tempDirs.push(dir);
    const jsonlPath = join(dir, 'test.jsonl');
    writeFileSync(jsonlPath, `${JSON.stringify(SAMPLE_INSTANCE)}\n`, 'utf-8');

    const rows = await loadDataset(jsonlPath);
    const byId = indexDatasetById(rows);
    const prediction = buildPrediction(
      byId.get(SAMPLE_INSTANCE.instance_id)!,
      'mock-model',
      'oracle',
    );

    expect(prediction).toEqual({
      instance_id: SAMPLE_INSTANCE.instance_id,
      model_name_or_path: 'mock-model',
      model_patch: SAMPLE_INSTANCE.patch,
    });
  });

  it('writes predictions jsonl in SWE-bench format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-predictions-'));
    tempDirs.push(dir);
    const path = join(dir, 'predictions.jsonl');
    writePredictionsJsonl(path, [
      {
        instance_id: 'a',
        model_name_or_path: 'mock',
        model_patch: 'patch-a',
      },
    ]);

    expect(JSON.parse(readFileSync(path, 'utf-8').trim())).toEqual({
      instance_id: 'a',
      model_name_or_path: 'mock',
      model_patch: 'patch-a',
    });
  });

  it('rejects invalid prediction modes', () => {
    expect(() => parsePredictionMode('glod')).toThrow(/Invalid --mode/);
  });

  it('detects p2p regression from harness report', () => {
    const report = getInstanceReport(
      {
        'demo__repo_1.0_1.1': {
          resolved: false,
          patch_successfully_applied: true,
          tests_status: {
            PASS_TO_PASS: {
              'tests/test_demo.py::test_existing': 'FAILED',
            },
          },
        },
      },
      'demo__repo_1.0_1.1',
    );

    expect(hasP2pRegression(report)).toBe(true);
  });

  it('runs eval instance with oracle prediction without mock scaffold flow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-run-'));
    tempDirs.push(dir);
    const datasetPath = join(dir, 'test.jsonl');
    const outRoot = join(dir, 'runs');
    writeFileSync(datasetPath, `${JSON.stringify(SAMPLE_INSTANCE)}\n`, 'utf-8');

    const result = await runEvalInstance({
      instanceId: SAMPLE_INSTANCE.instance_id,
      runId: 'unit_run',
      datasetPath,
      outRoot,
      predictionMode: 'oracle',
      memoryAblation: 'B2',
      modelName: 'mock-model',
    });

    const summary = JSON.parse(readFileSync(join(result.runDir, 'summary.json'), 'utf-8')) as {
      telemetry_event_types: string[];
      prediction_semantics: string;
      dataset_manifest_path: string;
    };

    expect(summary.telemetry_event_types).toEqual([]);
    expect(summary.prediction_semantics).toBe('oracle_gold_patch_replay');
    expect(readFileSync(result.summary.telemetry_path, 'utf-8')).toBe('');
    expect(readFileSync(summary.dataset_manifest_path, 'utf-8')).toContain(
      SAMPLE_INSTANCE.instance_id,
    );

    const predictions = readFileSync(result.summary.predictions_path, 'utf-8').trim();
    expect(predictions).toContain(SAMPLE_INSTANCE.instance_id);
  });

  it('defaults eval instance to stub predictions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-default-stub-'));
    tempDirs.push(dir);
    const datasetPath = join(dir, 'test.jsonl');
    const outRoot = join(dir, 'runs');
    writeFileSync(datasetPath, `${JSON.stringify(SAMPLE_INSTANCE)}\n`, 'utf-8');

    const result = await runEvalInstance({
      instanceId: SAMPLE_INSTANCE.instance_id,
      runId: 'unit_stub_run',
      datasetPath,
      outRoot,
    });

    const predictions = readFileSync(result.summary.predictions_path, 'utf-8');
    expect(result.summary.prediction_mode).toBe('stub');
    expect(predictions).toContain('F-direction pipeline stub');
  });

  it('folds an existing harness report into summary after predictions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-harness-report-'));
    tempDirs.push(dir);
    const datasetPath = join(dir, 'test.jsonl');
    const outRoot = join(dir, 'runs');
    const harnessReportPath = join(dir, 'report.json');
    writeFileSync(datasetPath, `${JSON.stringify(SAMPLE_INSTANCE)}\n`, 'utf-8');
    writeFileSync(
      harnessReportPath,
      JSON.stringify({
        [SAMPLE_INSTANCE.instance_id]: {
          resolved: true,
          patch_successfully_applied: true,
          tests_status: {
            FAIL_TO_PASS: { 'tests/test_demo.py::test_fix': 'PASSED' },
            PASS_TO_PASS: { 'tests/test_demo.py::test_existing': 'PASSED' },
          },
        },
      }),
      'utf-8',
    );

    const result = await runEvalInstance({
      instanceId: SAMPLE_INSTANCE.instance_id,
      runId: 'unit_harness_fold',
      datasetPath,
      outRoot,
      predictionMode: 'oracle',
      modelName: 'oracle-check',
      harnessReportPath,
    });

    expect(result.summary.resolved_count).toBe(1);
    expect(result.summary.applied_count).toBe(1);
    expect(result.summary.unresolved_count).toBe(0);
    expect(result.summary.harness_report_path).toBe(harnessReportPath);
    expect(result.summary.telemetry_event_types).toContain('harness.swe_evo_evaluated');
  });

  it('collects a backend worktree diff and prepares the SWE-EVO harness automatically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-worktree-'));
    tempDirs.push(dir);
    const worktreePath = join(dir, 'worktree');
    const datasetPath = join(dir, 'test.jsonl');
    const backendSummaryPath = join(dir, 'backend-summary.json');
    const outRoot = join(dir, 'runs');
    mkdirSync(worktreePath, { recursive: true });
    execFileSync('git', ['init'], { cwd: worktreePath });
    writeFileSync(join(worktreePath, 'README.md'), 'before\n', 'utf-8');
    writeFileSync(join(worktreePath, 'staged-file.txt'), 'before staged\n', 'utf-8');
    writeFileSync(join(worktreePath, 'delete-me.txt'), 'delete me\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync(
      'git',
      ['-c', 'user.name=F Eval', '-c', 'user.email=f-eval@example.test', 'commit', '-m', 'base'],
      { cwd: worktreePath },
    );
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim();
    writeFileSync(join(worktreePath, 'README.md'), 'after\n', 'utf-8');
    writeFileSync(join(worktreePath, 'staged-file.txt'), 'after staged\n', 'utf-8');
    execFileSync('git', ['add', 'staged-file.txt'], { cwd: worktreePath });
    rmSync(join(worktreePath, 'delete-me.txt'));
    writeFileSync(join(worktreePath, 'new-file.txt'), 'new\n', 'utf-8');
    writeFileSync(join(worktreePath, 'binary.dat'), Buffer.from([0x00, 0xff, 0x10, 0x80]));
    const originalIndexDiff = execFileSync('git', ['diff', '--cached'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    });

    const instance = { ...SAMPLE_INSTANCE, base_commit: baseCommit };
    writeFileSync(datasetPath, `${JSON.stringify(instance)}\n`, 'utf-8');
    writeFileSync(backendSummaryPath, JSON.stringify({ worktree_path: worktreePath }), 'utf-8');
    mkdirSync(join(dir, 'eval'), { recursive: true });
    writeFileSync(
      join(dir, 'eval', 'manifest.json'),
      JSON.stringify({
        dataset_version: 'unit',
        dataset_jsonl: 'test.jsonl',
        smoke_instance_ids: [instance.instance_id],
        default_model_name: 'mock',
      }),
      'utf-8',
    );
    process.env.NEWIDE_SCAFFOLD_ROOT = dir;

    const result = await runEvalInstance({
      instanceId: instance.instance_id,
      runId: 'backend_patch_run',
      datasetPath,
      outRoot,
      predictionMode: 'real',
      backendSummaryPath,
      allowDirtyWorktree: true,
      runSweEvoHarness: true,
      harnessDryRun: true,
      sweEvoRoot: dir,
    });

    const prediction = JSON.parse(
      readFileSync(result.summary.predictions_path, 'utf-8').trim(),
    ) as { model_patch: string };
    expect(prediction.model_patch).toContain('diff --git a/README.md b/README.md');
    expect(prediction.model_patch).toContain('diff --git a/staged-file.txt b/staged-file.txt');
    expect(prediction.model_patch).toContain('diff --git a/delete-me.txt b/delete-me.txt');
    expect(prediction.model_patch).toContain('deleted file mode');
    expect(prediction.model_patch).toContain('diff --git a/new-file.txt b/new-file.txt');
    expect(prediction.model_patch).toContain('diff --git a/binary.dat b/binary.dat');
    expect(prediction.model_patch).toContain('GIT binary patch');
    expect(result.summary.patch_source).toBe('worktree_git_diff');
    expect(result.summary.prediction_semantics).toBe('worktree_git_diff_collected');
    expect(result.harness?.commandPath).toBeTruthy();
    expect(
      execFileSync('git', ['diff', '--cached'], { cwd: worktreePath, encoding: 'utf-8' }),
    ).toBe(originalIndexDiff);
  });

  it('prepares SWE-EVO OpenHands-compatible harness artifacts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-harness-'));
    tempDirs.push(dir);
    const predictionsPath = join(dir, 'predictions.jsonl');
    const datasetPath = join(dir, 'test.jsonl');
    writeFileSync(datasetPath, `${JSON.stringify(SAMPLE_INSTANCE)}\n`, 'utf-8');
    writePredictionsJsonl(predictionsPath, [
      {
        instance_id: SAMPLE_INSTANCE.instance_id,
        model_name_or_path: 'mock',
        model_patch: SAMPLE_INSTANCE.patch,
      },
    ]);

    process.env.NEWIDE_SCAFFOLD_ROOT = dir;
    mkdirSync(join(dir, 'eval'), { recursive: true });
    writeFileSync(
      join(dir, 'eval', 'manifest.json'),
      JSON.stringify({
        dataset_version: 'unit',
        dataset_jsonl: 'test.jsonl',
        smoke_instance_ids: [SAMPLE_INSTANCE.instance_id],
        default_model_name: 'mock',
      }),
      'utf-8',
    );

    const result = await runSweEvoHarnessAdapter({
      predictionsPath,
      runId: 'adapter_run',
      outRoot: join(dir, 'runs'),
      sweEvoRoot: dir,
      dryRun: true,
    });

    expect(readFileSync(result.trajectoryPath, 'utf-8')).toContain('git_patch');
    expect(
      readFileSync(join(result.outputFinalDir, `${SAMPLE_INSTANCE.instance_id}.json`), 'utf-8'),
    ).toContain(SAMPLE_INSTANCE.instance_id);
    expect(readFileSync(result.commandPath, 'utf-8')).toContain('evaluate_instance.py');
    expect(JSON.parse(readFileSync(result.harnessReportPath, 'utf-8'))).toEqual({});
  });

  it('runs smoke eval end-to-end for a pinned instance list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-smoke-'));
    tempDirs.push(dir);
    const datasetPath = join(dir, 'test.jsonl');
    const outRoot = join(dir, 'runs');
    writeFileSync(datasetPath, `${JSON.stringify(SAMPLE_INSTANCE)}\n`, 'utf-8');

    const results = await runEvalSmoke({
      runId: 'unit_smoke',
      datasetPath,
      outRoot,
      instanceIds: [SAMPLE_INSTANCE.instance_id],
      predictionMode: 'stub',
    });

    expect(results).toHaveLength(1);
    const runDir = results[0]!.runDir;
    expect(readFileSync(join(runDir, 'dataset-manifest.json'), 'utf-8')).toContain(
      SAMPLE_INSTANCE.instance_id,
    );
    expect(readFileSync(join(runDir, 'summary.json'), 'utf-8')).toContain(
      'deterministic_stub_baseline',
    );
    expect(readFileSync(join(runDir, 'telemetry.jsonl'), 'utf-8')).toBe('');
  });

  it('rejects dirty worktrees unless allowDirtyWorktree is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-dirty-'));
    tempDirs.push(dir);
    const worktreePath = join(dir, 'worktree');
    const datasetPath = join(dir, 'test.jsonl');
    const outRoot = join(dir, 'runs');
    mkdirSync(worktreePath, { recursive: true });
    execFileSync('git', ['init'], { cwd: worktreePath });
    writeFileSync(join(worktreePath, 'README.md'), 'before\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync(
      'git',
      ['-c', 'user.name=F Eval', '-c', 'user.email=f-eval@example.test', 'commit', '-m', 'base'],
      { cwd: worktreePath },
    );
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim();
    writeFileSync(join(worktreePath, 'README.md'), 'dirty\n', 'utf-8');

    const instance = { ...SAMPLE_INSTANCE, base_commit: baseCommit };
    writeFileSync(datasetPath, `${JSON.stringify(instance)}\n`, 'utf-8');
    mkdirSync(join(dir, 'eval'), { recursive: true });
    writeFileSync(
      join(dir, 'eval', 'manifest.json'),
      JSON.stringify({
        dataset_version: 'unit',
        dataset_jsonl: 'test.jsonl',
        smoke_instance_ids: [instance.instance_id],
        default_model_name: 'mock',
      }),
      'utf-8',
    );
    process.env.NEWIDE_SCAFFOLD_ROOT = dir;

    await expect(assertWorktreeClean(worktreePath)).rejects.toThrow(/Worktree is dirty/);

    await expect(
      runEvalInstance({
        instanceId: instance.instance_id,
        runId: 'dirty_reject',
        datasetPath,
        outRoot,
        predictionMode: 'real',
        worktreePath,
      }),
    ).rejects.toThrow(/Worktree is dirty/);
  });

  it('seeds an ephemeral worktree from a patch file and collects the diff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-ephemeral-'));
    tempDirs.push(dir);
    const sourceRepo = join(dir, 'source');
    const datasetPath = join(dir, 'test.jsonl');
    const patchFile = join(dir, 'seed.patch');
    const outRoot = join(dir, 'runs');
    mkdirSync(sourceRepo, { recursive: true });
    execFileSync('git', ['init'], { cwd: sourceRepo });
    writeFileSync(join(sourceRepo, 'README.md'), 'before\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: sourceRepo });
    execFileSync(
      'git',
      ['-c', 'user.name=F Eval', '-c', 'user.email=f-eval@example.test', 'commit', '-m', 'base'],
      { cwd: sourceRepo },
    );
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sourceRepo,
      encoding: 'utf-8',
    }).trim();

    writeFileSync(
      patchFile,
      [
        'diff --git a/README.md b/README.md',
        'index 1111111..2222222 100644',
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1 +1 @@',
        '-before',
        '+after',
        '',
      ].join('\n'),
      'utf-8',
    );

    const instance = { ...SAMPLE_INSTANCE, base_commit: baseCommit };
    writeFileSync(datasetPath, `${JSON.stringify(instance)}\n`, 'utf-8');
    mkdirSync(join(dir, 'eval'), { recursive: true });
    writeFileSync(
      join(dir, 'eval', 'manifest.json'),
      JSON.stringify({
        dataset_version: 'unit',
        dataset_jsonl: 'test.jsonl',
        smoke_instance_ids: [instance.instance_id],
        default_model_name: 'mock',
      }),
      'utf-8',
    );
    process.env.NEWIDE_SCAFFOLD_ROOT = dir;

    const result = await runEvalInstance({
      instanceId: instance.instance_id,
      runId: 'ephemeral_seed',
      datasetPath,
      outRoot,
      predictionMode: 'real',
      ephemeralFrom: sourceRepo,
      patchFile,
    });

    const prediction = JSON.parse(
      readFileSync(result.summary.predictions_path, 'utf-8').trim(),
    ) as { model_patch: string };
    expect(prediction.model_patch).toContain('README.md');
    expect(prediction.model_patch).toContain('+after');
    expect(result.summary.patch_source).toBe('worktree_git_diff');
    // Default cleanup removes the ephemeral repo directory.
    await expect(assertWorktreeClean(sourceRepo)).resolves.toBeUndefined();
  });
});
