import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatCooperBenchCaseId, parseCooperBenchCaseId } from '../../eval/cooperbench/cases';
import {
  computeCoordinationDeficit,
  deriveFailureTaxonomy,
} from '../../eval/cooperbench/harness-report';
import { materializeCooperBenchLogs } from '../../eval/cooperbench/materialize-logs';
import {
  buildCooperBenchPrediction,
  writeCooperBenchPredictionsJsonl,
} from '../../eval/cooperbench/prediction-writer';
import { runCooperBenchCase } from '../../eval/cooperbench/run-case-core';
import { buildCooperBenchEvalCommand } from '../../eval/cooperbench/harness-adapter';

describe('CooperBench F-eval utilities', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.NEWIDE_SCAFFOLD_ROOT;
    delete process.env.NEWIDE_COOPERBENCH_DATASET_DIR;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses and formats case ids', () => {
    const caseId = formatCooperBenchCaseId({
      repo: 'dottxt_ai_outlines_task',
      task_id: 1655,
      features: [1, 3],
    });
    expect(caseId).toBe('dottxt_ai_outlines_task__1655__f1_f3');
    expect(parseCooperBenchCaseId(caseId)).toEqual({
      case_id: caseId,
      repo: 'dottxt_ai_outlines_task',
      task_id: 1655,
      features: [1, 3],
    });
  });

  it('builds stub/oracle predictions and materializes coop log layout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-eval-'));
    tempDirs.push(dir);
    const datasetDir = join(dir, 'dataset');
    const feature1 = join(datasetDir, 'demo_task', 'task1', 'feature1');
    const feature2 = join(datasetDir, 'demo_task', 'task1', 'feature2');
    mkdirSync(feature1, { recursive: true });
    mkdirSync(feature2, { recursive: true });
    writeFileSync(join(feature1, 'feature.patch'), 'gold-1\n', 'utf-8');
    writeFileSync(join(feature2, 'feature.patch'), 'gold-2\n', 'utf-8');

    const parts = parseCooperBenchCaseId('demo_task__1__f1_f2');
    const oracle = buildCooperBenchPrediction({
      parts,
      setting: 'coop',
      modelName: 'oracle-model',
      mode: 'oracle',
      datasetDir,
    });
    expect(oracle.agent1_patch).toBe('gold-1\n');
    expect(oracle.agent2_patch).toBe('gold-2\n');

    const logsRoot = join(dir, 'logs');
    materializeCooperBenchLogs({
      logsRoot,
      cooperbenchRunName: 'newide',
      setting: 'coop',
      predictions: [oracle],
      modelName: 'oracle-model',
    });

    const agent1 = join(logsRoot, 'newide', 'coop', 'demo_task', '1', 'f1_f2', 'agent1.patch');
    const agent2 = join(logsRoot, 'newide', 'coop', 'demo_task', '1', 'f1_f2', 'agent2.patch');
    expect(readFileSync(agent1, 'utf-8')).toBe('gold-1\n');
    expect(readFileSync(agent2, 'utf-8')).toBe('gold-2\n');

    const predictionsPath = join(dir, 'predictions.jsonl');
    writeCooperBenchPredictionsJsonl(predictionsPath, [oracle]);
    expect(JSON.parse(readFileSync(predictionsPath, 'utf-8').trim()).case_id).toBe(
      'demo_task__1__f1_f2',
    );
  });

  it('derives taxonomy and coordination deficit', () => {
    expect(
      deriveFailureTaxonomy({
        repo: 'r',
        task_id: 1,
        features: [1, 2],
        setting: 'coop',
        both_passed: false,
        feature1: { passed: true },
        feature2: { passed: false },
        merge: { status: 'conflict' },
      }),
    ).toEqual(['merge_conflict', 'feature2_failed']);

    expect(
      computeCoordinationDeficit({
        repo: 'r',
        task_id: 1,
        features: [1, 2],
        setting: 'coop',
        both_passed: false,
        solo_both_passed: true,
      }),
    ).toBe(1);
  });

  it('builds cooperbench eval command', () => {
    const command = buildCooperBenchEvalCommand({
      cooperbenchRoot: 'D:/Code/NewIDE/CooperBench',
      cooperbenchRunName: 'newide',
      logsRoot: 'D:/logs',
      datasetDir: 'D:/dataset',
      backend: 'docker',
      concurrency: 2,
      force: true,
    });
    expect(command.command).toBe('python');
    expect(command.args).toContain('eval');
    expect(command.args).toContain('--force');
    expect(command.cwd).toBe('D:/Code/NewIDE/CooperBench');
  });

  it('runs stub case end-to-end without docker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-run-'));
    tempDirs.push(dir);
    const datasetDir = join(dir, 'dataset');
    const feature1 = join(datasetDir, 'demo_task', 'task9', 'feature1');
    const feature3 = join(datasetDir, 'demo_task', 'task9', 'feature3');
    mkdirSync(feature1, { recursive: true });
    mkdirSync(feature3, { recursive: true });
    writeFileSync(join(feature1, 'feature.patch'), 'p1\n', 'utf-8');
    writeFileSync(join(feature3, 'feature.patch'), 'p3\n', 'utf-8');

    process.env.NEWIDE_COOPERBENCH_DATASET_DIR = datasetDir;

    const result = await runCooperBenchCase({
      caseId: 'demo_task__9__f1_f3',
      runId: 'cb_test_stub',
      predictionMode: 'stub',
      setting: 'coop',
      modelName: 'stub-model',
      outRoot: join(dir, 'out'),
      runHarness: true,
      harnessDryRun: true,
    });

    expect(result.summary.case_ids).toEqual(['demo_task__9__f1_f3']);
    expect(result.summary.prediction_mode).toBe('stub');
    expect(readFileSync(join(result.runDir, 'harness-command.json'), 'utf-8')).toContain(
      'cooperbench.cli',
    );
    expect(
      readFileSync(
        join(
          result.runDir,
          'cooperbench-logs',
          'newide',
          'coop',
          'demo_task',
          '9',
          'f1_f3',
          'agent1.patch',
        ),
        'utf-8',
      ),
    ).toContain('cooperbench stub');
  });
});
