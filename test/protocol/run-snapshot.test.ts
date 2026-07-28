import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isFrontendWorkflowV01Snapshot, runSnapshotSchema } from '../../src/protocol/run-snapshot';
import { projectRunSnapshot } from '../../src/app/run-snapshot-projector';

describe('RunSnapshot protocol', () => {
  it('keeps the cancelled fixture compatible with the runtime schema', async () => {
    const fixture = JSON.parse(
      await readFile('fixtures/protocol/run-snapshot-cancelled.json', 'utf-8'),
    );
    expect(runSnapshotSchema.parse(fixture)).toEqual(fixture);
  });

  it('rejects an incomplete snapshot that claims the v0.1 contract', async () => {
    const legacy = JSON.parse(
      await readFile('fixtures/protocol/run-snapshot-cancelled.json', 'utf-8'),
    );
    expect(
      runSnapshotSchema.safeParse({ ...legacy, contract_version: 'frontend-workflow.v0.1' })
        .success,
    ).toBe(false);
  });

  it('projects internal failure state into stable errors and final output', () => {
    const projected = projectRunSnapshot({
      schema_version: 'v0',
      revision: 1,
      run_id: 'run_failed',
      task_id: 'task_failed',
      status: 'failed',
      mode: 'council',
      current: { stage: 'intervention', active_node_code: 'N18' },
      events: [],
      error: {
        code: 'RUNNER_FAILED',
        message: 'driver exited',
        details: { phase: 'driver', retryable: false },
      },
    });

    expect(projected).toMatchObject({
      run_id: 'run_failed',
      task_id: 'task_failed',
      mode: 'council',
      status: 'failed',
      council: { enabled: true, status: 'failed', can_create_merge_authorization: false },
      errors: [
        {
          code: 'RUNNER_FAILED',
          message: 'driver exited',
          details: { phase: 'driver', retryable: false },
        },
      ],
      final_output: { status: 'failed', artifact_refs: [], files_written: [] },
    });
    expect(runSnapshotSchema.parse(projected)).toEqual(projected);
  });

  it('projects the frozen frontend task, run, flow, delivery, and link views', () => {
    const projected = projectRunSnapshot({
      schema_version: 'v0',
      revision: 2,
      run_id: 'run_frontend',
      task_id: 'task_frontend',
      status: 'completed',
      mode: 'single_agent',
      current: { stage: 'delivery', active_node_code: 'N18' },
      events: [
        event(1, 'task.created', {
          spec: 'Build a snake game',
          risk_level: 'low',
        }),
        event(2, 'run.started', { mode: 'single_agent' }),
        event(3, 'run.completed', { status: 'completed' }),
      ],
      snapshot: {
        snapshot_type: 'coordinator.frontend_run_snapshot.v0',
        schema_version: 'v0',
        generated_at: '2026-07-12T00:00:03.000Z',
        run_id: 'run_frontend',
        task_id: 'task_frontend',
        task: {
          task_id: 'task_frontend',
          status: 'completed',
          role_id: 'role_ts_engineer',
          risk_level: 'low',
          spec: 'Build a snake game',
          completion_criteria: ['Game runs'],
          affected_paths: ['snake.html'],
          created_at: '2026-07-12T00:00:01.000Z',
          updated_at: '2026-07-12T00:00:03.000Z',
          schema_version: 'v0',
        },
        current: { stage: 'delivery', task_status: 'completed', active_node_code: 'N18' },
        run: {
          run_id: 'run_frontend',
          task_id: 'task_frontend',
          status: 'completed',
          mode: 'single_agent',
          driver_id: 'claude',
          session_id: 'session_frontend',
          created_at: '2026-07-12T00:00:00.000Z',
        },
        flow: {
          active_node_code: 'N18',
          node_statuses: [{ code: 'N18', status: 'done', event_type: 'RunCompleted' }],
        },
        timeline: [],
        delivery_report: {
          worktree_path: '.newide/worktrees/task_frontend',
          files_written: ['output/snake.html'],
          changed_files: ['output/snake.html'],
          artifacts_materialized: 1,
          outcome: 'completed_files',
          response: 'Created the snake game.',
          session_id: 'session_frontend',
          tool_events: [],
          driver_diagnostics: { driver_id: 'claude', duration_ms: 10 },
        },
        artifacts: [],
        checkpoint: { checkpoint_id: 'checkpoint_1' } as never,
        mailbox: { thread_id: 'run_frontend', message_refs: [], messages: [] },
        links: { result_path: 'result.json' } as never,
      },
    });

    expect(projected).toMatchObject({
      contract_version: 'frontend-workflow.v0.1',
      task: {
        task_id: 'task_frontend',
        status: 'completed',
        spec: 'Build a snake game',
        completion_criteria: ['Game runs'],
        risk_level: 'low',
        affected_paths: ['snake.html'],
        role_id: 'role_ts_engineer',
      },
      run: {
        run_id: 'run_frontend',
        task_id: 'task_frontend',
        status: 'completed',
        mode: 'single_agent',
        session_id: 'session_frontend',
        event_ids: ['event_1', 'event_2', 'event_3'],
      },
      flow: { active_node_code: 'N18', node_statuses: [{ code: 'N18', status: 'done' }] },
      delivery_report: {
        worktree_path: '.newide/worktrees/task_frontend',
        files_written: ['output/snake.html'],
        changed_files: ['output/snake.html'],
        artifacts_materialized: 1,
        outcome: 'completed_files',
        response: 'Created the snake game.',
        session_id: 'session_frontend',
      },
      final_output: {
        outcome: 'completed_files',
        response: 'Created the snake game.',
        session_id: 'session_frontend',
        changed_files: ['output/snake.html'],
        tool_events: [],
      },
      links: { result_path: 'result.json' },
    });
    expect(runSnapshotSchema.parse(projected)).toEqual(projected);
    expect(isFrontendWorkflowV01Snapshot(projected)).toBe(true);
  });
});

function event(sequence: number, type: string, payload: Record<string, unknown>) {
  return {
    event_id: `event_${sequence}`,
    sequence,
    run_id: 'run_frontend',
    task_id: 'task_frontend',
    type,
    source: 'coordinator' as const,
    created_at: `2026-07-12T00:00:0${sequence}.000Z`,
    payload,
    schema_version: 'v0',
  };
}
