import { describe, expect, it } from 'vitest';
import { taskSnapshotSchema } from '../../src/protocol/task-snapshot';

describe('TaskSnapshot protocol', () => {
  it('accepts the complete Task-first business view', () => {
    const snapshot = taskSnapshot({
      current_run: {
        run_id: 'run_current',
        task_id: 'task_1',
        status: 'running',
        mode: 'single_agent',
        restartable: false,
        started_at: '2026-07-19T00:00:01.000Z',
      },
      market: {
        winner_agent_id: 'role_ts_engineer',
        winner_bid_id: 'bid_1',
        ledger_ref: 'file:///market/ledger.json',
        audit_ref: 'file:///market/audit.json',
        policy_version: 'market-v0',
        seed: 'run_current',
      },
      council: {
        status: 'completed',
        decision_id: 'decision_1',
        verdict: 'select',
        result: {
          quality: 'best_effort',
          final_artifact_ref: 'artifact_final',
          final_artifact_sha256: 'a'.repeat(64),
          warnings: ['review was incomplete'],
          unmet_criteria: ['one optional criterion'],
          verification_refs: ['verification_1'],
          decision_record_ref: 'decision_1',
        },
      },
      warnings: ['review was incomplete'],
      final_output: {
        artifact_refs: ['artifact_final'],
        files_written: ['/workspace/final.ts'],
        changed_files: ['final.ts'],
        response: 'Completed with warnings.',
        sha256: 'a'.repeat(64),
      },
    });

    expect(taskSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('accepts an interrupted historical run and an explicit waiting reason', () => {
    const snapshot = taskSnapshot({
      task: { ...baseTask(), status: 'blocked' },
      current_run: undefined,
      run_history: [
        {
          run_id: 'run_interrupted',
          task_id: 'task_1',
          status: 'interrupted',
          mode: 'single_agent',
          restartable: true,
          started_at: '2026-07-19T00:00:01.000Z',
        },
      ],
      waiting_reason: 'The previous backend process ended before a terminal result was saved.',
    });

    expect(taskSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('rejects cross-task runs and a non-running current run', () => {
    const wrongTask = taskSnapshot({
      run_history: [
        {
          run_id: 'run_other',
          task_id: 'task_other',
          status: 'completed',
          mode: 'single_agent',
          restartable: false,
        },
      ],
    });
    const terminalCurrent = taskSnapshot({
      current_run: {
        run_id: 'run_done',
        task_id: 'task_1',
        status: 'completed',
        mode: 'single_agent',
        restartable: false,
      },
    });

    expect(taskSnapshotSchema.safeParse(wrongTask).success).toBe(false);
    expect(taskSnapshotSchema.safeParse(terminalCurrent).success).toBe(false);
  });
});

function taskSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: 'task-snapshot.v0',
    schema_version: 'v0',
    revision: 1,
    task: baseTask(),
    current_run: undefined,
    run_history: [],
    warnings: [],
    ...overrides,
  };
}

function baseTask() {
  return {
    task_id: 'task_1',
    status: 'running',
    role_id: 'role_ts_engineer',
    risk_level: 'low',
    spec: 'Build the requested result.',
    completion_criteria: ['The result exists.'],
    affected_paths: ['src/**'],
    created_at: '2026-07-19T00:00:00.000Z',
    updated_at: '2026-07-19T00:00:01.000Z',
    schema_version: 'v0',
  };
}
