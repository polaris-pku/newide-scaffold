import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SapTaskBridge } from '../../src/coordination/sap-task-bridge';
import type { CoordinationStateCommit } from '../../src/persistence';
import { SqliteCoordinationStore } from '../../src/persistence';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SapTaskBridge', () => {
  it('persists one execute and admits it only once across restart', () => {
    const databasePath = createDatabase();
    const store = new SqliteCoordinationStore(databasePath);
    store.commitState(initialCommit());
    const bridge = createBridge(store);
    const dispatch = bridge.createExecute({
      task_id: 'task_sap',
      run_id: 'run_sap',
      role_id: 'role_engineer',
      instruction: 'Implement the requested change.',
      exchange_id: 'sap_execute_1',
    });
    store.withProtocolTransaction((transaction) => bridge.enqueueExecute(transaction, dispatch));

    const first = bridge.beginExecute(dispatch);
    expect(first.should_execute).toBe(true);
    expect(first.execute_outbox.status).toBe('sent');
    expect(first.execute_inbox.status).toBe('processing');
    store.close();

    const reopened = new SqliteCoordinationStore(databasePath);
    const resumed = createBridge(reopened).beginExecute(dispatch);
    expect(resumed.should_execute).toBe(false);
    expect(reopened.listRecoverableOutbox('2026-09-27T08:30:00.000Z')).toEqual([]);
    reopened.close();
  });

  it('builds valid result and cancel frames caused by the execute exchange', () => {
    const store = new SqliteCoordinationStore(':memory:');
    store.commitState(initialCommit());
    const bridge = createBridge(store);
    const dispatch = bridge.createExecute({
      task_id: 'task_sap',
      run_id: 'run_sap',
      role_id: 'role_engineer',
      instruction: 'Implement the requested change.',
      council_seat: 'reviewer',
      exchange_id: 'sap_execute_2',
    });
    expect(dispatch.frame.council_seat).toBe('reviewer');
    expect(bridge.createResult({
      execute: dispatch.frame,
      status: 'completed',
      summary: 'Completed.',
      exchange_id: 'sap_result_2',
    })).toMatchObject({
      causation_id: 'sap_execute_2',
      status: 'completed',
      producer: { kind: 'agent', role_id: 'role_engineer' },
    });
    expect(bridge.createCancel({ execute: dispatch.frame, exchange_id: 'sap_cancel_2' }))
      .toMatchObject({
        causation_id: 'sap_execute_2',
        target_exchange_id: 'sap_execute_2',
        command: 'agent.cancel',
      });
    store.close();
  });

  it('accepts one terminal result and records competing results without changing the accepted reply', () => {
    const store = new SqliteCoordinationStore(':memory:');
    store.commitState(initialCommit());
    const bridge = createBridge(store);
    const dispatch = bridge.createExecute({
      task_id: 'task_sap',
      run_id: 'run_sap',
      role_id: 'role_engineer',
      instruction: 'Implement the requested change.',
      exchange_id: 'sap_execute_result_race',
    });
    bridge.persistExecute(dispatch);
    const admission = bridge.beginExecute(dispatch);
    const accepted = bridge.createResult({
      execute: dispatch.frame,
      status: 'completed',
      summary: 'Completed.',
      exchange_id: 'sap_result_accepted',
    });
    const competing = bridge.createResult({
      execute: dispatch.frame,
      status: 'failed',
      summary: 'Conflicting result.',
      error: { code: 'conflict', message: 'Conflicting result.', retryable: false },
      exchange_id: 'sap_result_competing',
    });

    expect(bridge.acceptResult(admission, accepted)).toBe('accepted');
    expect(bridge.acceptResult(admission, accepted)).toBe('duplicate');
    expect(bridge.acceptResult(admission, competing)).toBe('late');
    expect(store.getInbox({
      consumer_id: 'role_engineer',
      protocol: 'system-agent',
      exchange_id: dispatch.frame.exchange_id,
    })).toMatchObject({ status: 'complete', reply_exchange_id: accepted.exchange_id });
    expect(store.getInbox({
      consumer_id: 'system',
      protocol: 'system-agent',
      exchange_id: competing.exchange_id,
    })).toMatchObject({ status: 'complete' });
    expect(store.listJournal('task_sap', 'run_sap').filter((entry) =>
      entry.event === 'inbox.completed' && entry.id === dispatch.frame.exchange_id,
    )).toHaveLength(1);
    store.close();
  });

  it('does not accept a result after cancel or deadline, but keeps the late result auditable', () => {
    const store = new SqliteCoordinationStore(':memory:');
    store.commitState(initialCommit());
    let now = '2026-09-27T08:00:00.000Z';
    const bridge = new SapTaskBridge({ store, now: () => now });
    const cancelled = bridge.createExecute({
      task_id: 'task_sap', run_id: 'run_sap', role_id: 'role_engineer',
      instruction: 'Work.', exchange_id: 'sap_execute_cancelled',
    });
    bridge.persistExecute(cancelled);
    const cancelledAdmission = bridge.beginExecute(cancelled);
    bridge.enqueueCancel(cancelled, bridge.createCancel({ execute: cancelled.frame }));
    now = '2026-09-27T08:31:00.000Z';
    expect(bridge.beginExecute(cancelled).should_execute).toBe(false);
    now = '2026-09-27T08:00:00.000Z';
    const cancelledResult = bridge.createResult({
      execute: cancelled.frame, status: 'completed', summary: 'Completed after cancel.',
      exchange_id: 'sap_result_after_cancel',
    });
    expect(bridge.acceptResult(cancelledAdmission, cancelledResult)).toBe('late');
    expect(store.getOutbox('outbox_sap_cancel_sap_execute_cancelled')).toBeDefined();

    const expired = bridge.createExecute({
      task_id: 'task_sap', run_id: 'run_sap', role_id: 'role_engineer',
      instruction: 'Work.', exchange_id: 'sap_execute_expired',
      deadline_at: '2026-09-27T08:01:00.000Z',
    });
    bridge.persistExecute(expired);
    const expiredAdmission = bridge.beginExecute(expired);
    now = '2026-09-27T08:02:00.000Z';
    const expiredResult = bridge.createResult({
      execute: expired.frame, status: 'completed', summary: 'Completed too late.',
      exchange_id: 'sap_result_after_deadline',
    });
    expect(bridge.acceptResult(expiredAdmission, expiredResult)).toBe('late');
    for (const exchangeId of [cancelled.frame.exchange_id, expired.frame.exchange_id]) {
      expect(store.getInbox({
        consumer_id: 'role_engineer', protocol: 'system-agent', exchange_id: exchangeId,
      })).toMatchObject({ status: 'processing', reply_exchange_id: null });
    }
    expect(store.listJournal('task_sap', 'run_sap').map((entry) => entry.id))
      .toContain(expiredResult.exchange_id);
    store.close();
  });

  it('rolls back the SAP reply when the Task state commit fails', () => {
    const store = new SqliteCoordinationStore(':memory:');
    store.commitState(initialCommit());
    const bridge = createBridge(store);
    const dispatch = bridge.createExecute({
      task_id: 'task_sap', run_id: 'run_sap', role_id: 'role_engineer',
      instruction: 'Work.', exchange_id: 'sap_execute_rollback',
    });
    bridge.persistExecute(dispatch);
    const admission = bridge.beginExecute(dispatch);
    const result = bridge.createResult({
      execute: dispatch.frame, status: 'completed', summary: 'Completed.',
      exchange_id: 'sap_result_rollback',
    });
    expect(() => bridge.commitResult({ ...initialCommit(), expected_task_revision: 999 }, admission, result))
      .toThrow();
    expect(store.getInbox({
      consumer_id: 'role_engineer', protocol: 'system-agent',
      exchange_id: dispatch.frame.exchange_id,
    })).toMatchObject({ status: 'processing', reply_exchange_id: null });
    expect(store.getOutbox(`outbox_${result.exchange_id}`)).toBeUndefined();
    store.close();
  });
});

function createDatabase(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-sap-bridge-'));
  directories.push(directory);
  return path.join(directory, 'coordination.sqlite');
}

function createBridge(store: SqliteCoordinationStore): SapTaskBridge {
  return new SapTaskBridge({
    store,
    now: () => '2026-09-27T08:00:00.000Z',
    create_id: (prefix) => `${prefix}_generated`,
  });
}

function initialCommit(): CoordinationStateCommit {
  const at = '2026-09-27T07:59:00.000Z';
  return {
    task: {
      task_id: 'task_sap',
      status: 'running',
      role_id: 'role_engineer',
      risk_level: 'low',
      spec: 'Implement SAP integration',
      completion_criteria: ['SAP state is durable'],
      affected_paths: ['src/coordination/**'],
      workspace_path: '/workspace',
      warnings: [],
      revision: 1,
      created_at: at,
      updated_at: at,
      schema_version: 'v0',
    },
    run: {
      run_id: 'run_sap',
      task_id: 'task_sap',
      status: 'running',
      mode: 'single_agent',
      workspace_path: '/workspace',
      revision: 1,
      created_at: at,
      updated_at: at,
      schema_version: 'v0',
    },
    runtime_state: {
      task_id: 'task_sap',
      current_run_id: 'run_sap',
      resume_cursor: 'execute_agent',
      cursor_input: { cursor: 'execute_agent', winner_agent_id: 'role_engineer' },
      waiting_on: [],
      artifact_refs: [],
      diagnostics: {},
      updated_at: at,
      schema_version: 'v0',
    },
    events: [{
      event_id: 'event_sap_created',
      event_type: 'run.started',
      subject_id: 'run_sap',
      task_id: 'task_sap',
      run_id: 'run_sap',
      payload: {},
      created_at: at,
      schema_version: 'v0',
    }],
  };
}
