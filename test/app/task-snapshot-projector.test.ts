import { describe, expect, it } from 'vitest';
import type { RunSnapshot } from '../../src/protocol/run-snapshot';
import { taskSnapshotSchema } from '../../src/protocol/task-snapshot';
import { projectTaskSnapshot, type TaskRunFact } from '../../src/app/task-snapshot-projector';

describe('projectTaskSnapshot', () => {
  it('projects a running task from its immutable definition and current run fact', () => {
    const snapshot = projectTaskSnapshot({
      task_id: 'task_1',
      task_request: {
        spec: 'Build task-first RPC',
        role_id: 'role_backend_engineer',
        risk_level: 'medium',
        affected_paths: ['src/app/**'],
        completion_criteria: ['task.get returns a valid snapshot'],
        budget: { max_tool_calls: 20 },
      },
      created_at: '2026-07-19T01:00:00.000Z',
      runs: [
        fact({
          run_id: 'run_current',
          status: 'running',
          restartable: false,
          started_at: '2026-07-19T01:00:01.000Z',
          revision: 4,
        }),
      ],
    });

    expect(taskSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      revision: 5,
      task: {
        task_id: 'task_1',
        status: 'running',
        spec: 'Build task-first RPC',
        role_id: 'role_backend_engineer',
        risk_level: 'medium',
        affected_paths: ['src/app/**'],
        completion_criteria: ['task.get returns a valid snapshot'],
        budget: { max_tool_calls: 20 },
      },
      current_run: {
        run_id: 'run_current',
        status: 'running',
      },
      run_history: [],
      warnings: [],
    });
  });

  it('projects market, autonomous Council and final output from terminal evidence', () => {
    const result = {
      quality: 'best_effort' as const,
      final_artifact_ref: 'artifact_final',
      final_artifact_sha256: 'a'.repeat(64),
      warnings: ['review coverage was incomplete'],
      unmet_criteria: ['optional benchmark was unavailable'],
      verification_refs: ['verification_1'],
      decision_record_ref: 'decision_1',
    };
    const terminal = runSnapshot({
      market: {
        winner_agent_id: 'agent_winner',
        winner_bid_id: 'bid_1',
        ledger_ref: 'file:///market/ledger.json',
        audit_ref: 'file:///market/audit.json',
        policy_version: 'market-v0',
        seed: 'seed_1',
      },
      council: {
        enabled: true,
        status: 'completed',
        decision_id: 'decision_1',
        verdict: 'select',
        selected_artifact_refs: ['artifact_final'],
        required_next_actions: [],
        blocked_by: [],
        can_create_merge_authorization: false,
        result,
      },
      artifacts: [{ artifact_id: 'artifact_final' }],
      final_output: {
        status: 'completed',
        artifact_refs: ['artifact_final'],
        files_written: ['/workspace/final.ts'],
        changed_files: ['final.ts'],
        response: 'Completed with warnings.',
      },
    });

    const snapshot = projectTaskSnapshot({
      task_id: 'task_1',
      task_request: {
        spec: 'Produce the best implementation',
        completion_criteria: ['A final artifact is delivered'],
      },
      created_at: '2026-07-19T01:00:00.000Z',
      runs: [
        fact({
          run_id: 'run_done',
          status: 'completed',
          mode: 'council',
          restartable: true,
          started_at: '2026-07-19T01:00:01.000Z',
          completed_at: '2026-07-19T01:01:00.000Z',
          revision: 12,
          snapshot: terminal,
        }),
      ],
    });

    expect(taskSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.task).toMatchObject({ status: 'completed', owner_agent_id: 'agent_winner' });
    expect(snapshot.market).toEqual(terminal.market);
    expect(snapshot.council).toEqual({
      status: 'completed',
      decision_id: 'decision_1',
      verdict: 'select',
      result,
    });
    expect(snapshot.warnings).toEqual(result.warnings);
    expect(snapshot.final_output).toEqual({
      artifact_refs: ['artifact_final'],
      files_written: ['/workspace/final.ts'],
      changed_files: ['final.ts'],
      response: 'Completed with warnings.',
      sha256: 'a'.repeat(64),
    });
  });

  it('projects an interrupted process as a blocked, manually recoverable task', () => {
    const snapshot = projectTaskSnapshot({
      task_id: 'task_1',
      task_request: {
        spec: 'Long-running task',
        completion_criteria: ['Task eventually completes'],
      },
      created_at: '2026-07-19T01:00:00.000Z',
      runs: [
        fact({
          run_id: 'run_interrupted',
          status: 'interrupted',
          restartable: true,
          started_at: '2026-07-19T01:00:01.000Z',
          revision: 2,
        }),
      ],
    });

    expect(taskSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.task.status).toBe('blocked');
    expect(snapshot.current_run).toBeUndefined();
    expect(snapshot.run_history[0]).toMatchObject({
      run_id: 'run_interrupted',
      status: 'interrupted',
      restartable: true,
    });
    expect(snapshot.waiting_reason).toBe(
      'The previous backend process ended before a terminal result was saved.',
    );
  });

  it('rejects ambiguous or cross-task run facts', () => {
    const base = {
      task_id: 'task_1',
      task_request: { spec: 'Task', completion_criteria: ['Done'] },
      created_at: '2026-07-19T01:00:00.000Z',
    };

    expect(() =>
      projectTaskSnapshot({
        ...base,
        runs: [
          fact({ run_id: 'run_1', status: 'running', restartable: false }),
          fact({ run_id: 'run_2', status: 'running', restartable: false }),
        ],
      }),
    ).toThrow('multiple current runs');
    expect(() =>
      projectTaskSnapshot({
        ...base,
        runs: [
          fact({
            run_id: 'run_other',
            task_id: 'task_other',
            status: 'completed',
            restartable: true,
          }),
        ],
      }),
    ).toThrow('belongs to another task');
  });
});

function fact(
  overrides: Partial<TaskRunFact> & Pick<TaskRunFact, 'run_id' | 'status' | 'restartable'>,
): TaskRunFact {
  return {
    task_id: 'task_1',
    mode: 'single_agent',
    revision: 0,
    ...overrides,
  };
}

function runSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    schema_version: 'v0',
    run_id: 'run_done',
    task_id: 'task_1',
    mode: 'council',
    status: 'completed',
    current: { stage: 'delivery', active_node_code: 'N18' },
    timeline: [],
    agent_runs: [],
    artifacts: [],
    gates: [],
    errors: [],
    ...overrides,
  };
}
