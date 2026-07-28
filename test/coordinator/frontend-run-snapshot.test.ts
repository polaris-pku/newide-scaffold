import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core';
import { buildFrontendRunSnapshot } from '../../src/coordinator/frontend-run-snapshot';

describe('buildFrontendRunSnapshot', () => {
  it('should build a frontend-readable run snapshot from integration outputs', () => {
    const snapshot = buildFrontendRunSnapshot({
      task: {
        task_id: 'task_001',
        status: 'completed',
        role_id: 'role_ts_engineer',
        risk_level: 'low',
        spec: 'Build a result',
        completion_criteria: ['Result exists'],
        affected_paths: ['src/**'],
        created_at: '2026-07-07T00:00:00.000Z',
        updated_at: '2026-07-07T00:00:01.000Z',
        schema_version: SCHEMA_VERSION,
      },
      summary: {
        run_id: 'run_001',
        task_id: 'task_001',
        mode: 'single_agent',
        status: 'completed',
        outcome: 'completed_files',
        session_id: 'session_001',
        response: 'Implemented the requested result.',
        worktree_path: '.newide/worktrees/task_001',
        artifacts_materialized: 1,
        files_written: ['.newide/worktrees/task_001/artifact_001.json'],
        changed_files: ['src/result.ts'],
        tool_events: [
          {
            tool_event_id: 'tool_event_001',
            tool_name: 'edit',
            status: 'completed',
            summary: 'Edited src/result.ts',
            created_at: '2026-07-07T00:00:00.000Z',
            schema_version: SCHEMA_VERSION,
          },
        ],
        artifact_outputs: [
          {
            artifact_id: 'artifact_001',
            type: 'patch',
            uri: 'artifact://patch/task_001/result.patch',
            materialized_record_path: '.newide/worktrees/task_001/artifact_001.json',
          },
        ],
        driver_diagnostics: {
          driver_id: 'mock-driver',
          duration_ms: 120,
        },
        checkpoint_id: 'checkpoint_001',
        checkpoint_path: '.newide/runs/run_001/checkpoint.json',
        mailbox_message_refs: ['message_001', 'message_002'],
        mailbox_thread_id: 'run_001',
        market: {
          winner_agent_id: 'role_ts_engineer',
          winner_bid_id: 'bid_001',
          ledger_ref: 'file:///market/ledger.json',
          audit_ref: 'file:///market/audit.json',
          policy_version: 'market-v0',
          seed: 'run_001',
        },
        created_at: '2026-07-07T00:00:00.000Z',
        schema_version: SCHEMA_VERSION,
      },
      timeline: [
        { name: 'TaskCreated', id: 'task_001' },
        { name: 'RunCompleted', id: 'event_001' },
      ],
      checkpoint: {
        checkpoint_id: 'checkpoint_001',
        checkpoint_type: 'full',
        task_id: 'task_001',
        trigger: 'manual',
        mechanical_snapshot: {
          base_commit: 'demo-head',
          worktree_path: '.newide/worktrees/task_001',
          branch: 'integration-v0-demo',
          modified_files: ['.newide/worktrees/task_001/artifact_001.json'],
        },
        semantic_handoff: {
          done: ['driver completed'],
          in_progress: [],
          blocked_on: [],
          assumptions: [],
          next_steps: ['Ready for user review'],
          known_risks: [],
        },
        artifact_refs: ['artifact_001'],
        validity_status: 'valid',
        created_at: '2026-07-07T00:00:00.000Z',
        schema_version: SCHEMA_VERSION,
      },
      message_thread: [
        {
          message_id: 'message_001',
          thread_id: 'run_001',
          from_agent_id: 'coordinator',
          to: [{ agent_id: 'mock-driver' }],
          type: 'task.assigned',
          payload: { task_id: 'task_001' },
          requires_ack: false,
          created_at: '2026-07-07T00:00:00.000Z',
          schema_version: SCHEMA_VERSION,
        },
      ],
      links: {
        result_path: '.newide/runs/run_001/result.json',
        summary_path: '.newide/runs/run_001/summary.json',
        timeline_path: '.newide/runs/run_001/timeline.json',
        checkpoint_path: '.newide/runs/run_001/checkpoint.json',
        message_thread_path: '.newide/runs/run_001/message-thread.json',
        event_log_path: '.newide/runs/run_001/event-log.json',
        frontend_snapshot_path: '.newide/runs/run_001/frontend-snapshot.json',
      },
    });

    expect(snapshot).toMatchObject({
      snapshot_type: 'coordinator.frontend_run_snapshot.v0',
      schema_version: SCHEMA_VERSION,
      run_id: 'run_001',
      task_id: 'task_001',
      task: {
        status: 'completed',
        spec: 'Build a result',
        completion_criteria: ['Result exists'],
      },
      current: {
        stage: 'delivery',
        task_status: 'completed',
        active_node_code: 'N18',
      },
      run: {
        mode: 'single_agent',
        driver_id: 'mock-driver',
        session_id: 'session_001',
      },
      delivery_report: {
        worktree_path: '.newide/worktrees/task_001',
        artifacts_materialized: 1,
        outcome: 'completed_files',
        response: 'Implemented the requested result.',
        session_id: 'session_001',
        changed_files: ['src/result.ts'],
        tool_events: [expect.objectContaining({ tool_event_id: 'tool_event_001' })],
      },
      artifacts: [
        {
          artifact_id: 'artifact_001',
          materialized_record_path: '.newide/worktrees/task_001/artifact_001.json',
        },
      ],
      checkpoint: {
        checkpoint_id: 'checkpoint_001',
        semantic_handoff: {
          done: ['driver completed'],
          next_steps: ['Ready for user review'],
        },
      },
      mailbox: {
        thread_id: 'run_001',
        message_refs: ['message_001', 'message_002'],
      },
      market: {
        winner_agent_id: 'role_ts_engineer',
        winner_bid_id: 'bid_001',
        ledger_ref: 'file:///market/ledger.json',
        audit_ref: 'file:///market/audit.json',
        policy_version: 'market-v0',
        seed: 'run_001',
      },
      links: {
        event_log_path: '.newide/runs/run_001/event-log.json',
        frontend_snapshot_path: '.newide/runs/run_001/frontend-snapshot.json',
      },
    });
    expect(snapshot.timeline).toEqual([
      {
        id: 'task_001',
        name: 'TaskCreated',
        level: 'info',
        source: 'Coordinator',
        text: 'TaskCreated',
      },
      {
        id: 'event_001',
        name: 'RunCompleted',
        level: 'success',
        source: 'Coordinator',
        text: 'RunCompleted',
      },
    ]);
    expect(snapshot.flow.active_node_code).toBe('N18');
    expect(snapshot.flow.node_statuses).toHaveLength(19);
    expect(snapshot.flow.node_statuses.slice(0, 3)).toEqual([
      { code: 'N0', status: 'pending' },
      { code: 'N1', status: 'pending' },
      {
        code: 'N2',
        status: 'done',
        event_type: 'TaskCreated',
        event_id: 'task_001',
      },
    ]);
    expect(snapshot.flow.node_statuses.at(-1)).toEqual({
      code: 'N18',
      status: 'done',
      event_type: 'RunCompleted',
      event_id: 'event_001',
    });
  });
});
