import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProductionGateExecutor,
  readProductionGateCommand,
} from '../../src/app/production-gate-executor';
import { completionCriterionId } from '../../src/coordinator/completion-criteria-evaluator';

const tempDirs: string[] = [];

describe('ProductionGateExecutor', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('runs a controlled command and records audited criterion evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-gate-'));
    tempDirs.push(root);
    const workspace = path.join(root, 'workspace');
    const runsRoot = path.join(root, 'runs');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    const criterion = 'The production verification command passes';
    const secret = 'hidden-gate-secret';
    const executor = new ProductionGateExecutor({
      runsRoot,
      env: { ...process.env, NEWIDE_GATE_TEST_SECRET: secret },
      command: {
        executable: process.execPath,
        args: ['-e', `process.stdout.write(${JSON.stringify(secret)})`],
        timeout_ms: 5_000,
        attest_completion_criteria: true,
      },
    });

    const result = await executor.execute({
      run_id: 'run_gate_success',
      task_id: 'task_gate_success',
      phase: 'pre_selection',
      workspace_path: workspace,
      completion_criteria: [criterion],
      artifact_refs: ['artifact_1'],
    });

    expect(result.gate_results).toEqual([
      expect.objectContaining({
        decision: 'allow',
        subject_type: 'completion_criterion',
        subject_id: completionCriterionId(criterion, 0),
      }),
    ]);
    const auditPath = result.gate_results[0]?.audit_ref;
    expect(auditPath).toEqual(expect.any(String));
    const audit = JSON.parse(await readFile(auditPath!, 'utf-8')) as Record<string, unknown>;
    expect(audit).toMatchObject({
      run_id: 'run_gate_success',
      task_id: 'task_gate_success',
      phase: 'pre_selection',
      cwd: workspace,
      exit_code: 0,
      timed_out: false,
      artifact_refs: ['artifact_1'],
      attested_completion_criteria: [criterion],
    });
    expect(await readFile(String(audit.stdout_ref), 'utf-8')).toBe('[REDACTED]');
  });

  it('returns a denying GateResult when the command fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-gate-fail-'));
    tempDirs.push(root);
    const executor = new ProductionGateExecutor({
      runsRoot: path.join(root, 'runs'),
      command: {
        executable: process.execPath,
        args: ['-e', 'process.exit(7)'],
        timeout_ms: 5_000,
        attest_completion_criteria: false,
      },
    });

    const result = await executor.execute({
      run_id: 'run_gate_failure',
      task_id: 'task_gate_failure',
      phase: 'post_council',
      workspace_path: root,
      completion_criteria: ['A criterion'],
      artifact_refs: [],
    });

    expect(result.gate_results[0]).toMatchObject({
      decision: 'deny',
      subject_type: 'task',
      subject_id: 'task_gate_failure',
      target_state: 'blocked',
    });
  });

  it('does not fabricate Gate evidence when no command is configured', async () => {
    const executor = new ProductionGateExecutor({ runsRoot: '/unused', env: {} });
    const result = await executor.execute({
      run_id: 'run_unconfigured',
      task_id: 'task_unconfigured',
      phase: 'pre_selection',
      workspace_path: process.cwd(),
      completion_criteria: ['A criterion'],
      artifact_refs: [],
    });

    expect(result).toMatchObject({
      matched: false,
      gate_results: [],
    });
  });
});

describe('readProductionGateCommand', () => {
  it('rejects non-array arguments instead of invoking a shell string', () => {
    expect(() =>
      readProductionGateCommand({
        NEWIDE_GATE_COMMAND: 'pnpm',
        NEWIDE_GATE_ARGS_JSON: '"test"',
      }),
    ).toThrow('NEWIDE_GATE_ARGS_JSON must be a JSON string array');
  });
});
