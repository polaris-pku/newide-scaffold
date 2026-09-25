import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { protocolFrameSchema } from '../../src/core/protocol-frame';
import type { CoordinationStateCommit } from '../../src/persistence/coordination-state-store';
import { SqliteCoordinationStore } from '../../src/persistence/sqlite-coordination-store';
import type { ProtocolDeliveryTransaction } from '../../src/persistence/protocol-delivery-store';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createDatabase(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-protocol-delivery-'));
  directories.push(directory);
  return path.join(directory, 'coordination.sqlite');
}

function initialCommit(): CoordinationStateCommit {
  const at = '2026-09-21T09:00:00.000Z';
  return {
    task: {
      task_id: 'task-0088', status: 'created', risk_level: 'medium',
      spec: 'Review the patch', completion_criteria: ['reviewed'], affected_paths: [],
      workspace_path: '/workspace', warnings: [], revision: 1,
      created_at: at, updated_at: at, schema_version: 'v0',
    },
    run: {
      run_id: 'run-20260921-001', task_id: 'task-0088', status: 'created',
      mode: 'single_agent', workspace_path: '/workspace', revision: 1,
      created_at: at, updated_at: at, schema_version: 'v0',
    },
    runtime_state: {
      task_id: 'task-0088', current_run_id: 'run-20260921-001',
      resume_cursor: 'execute_agent', waiting_on: [], artifact_refs: [], diagnostics: {},
      updated_at: at, schema_version: 'v0',
    },
    events: [{
      event_id: 'event-task-created', event_type: 'task.created',
      subject_id: 'task-0088', task_id: 'task-0088', run_id: 'run-20260921-001',
      payload: {}, created_at: at, schema_version: 'v0',
    }],
  };
}

function frame(name: 'v1-aap-ask' | 'v1-aap-reply') {
  const fixture = new URL(`../../fixtures/protocol/${name}.json`, import.meta.url);
  return protocolFrameSchema.parse(JSON.parse(readFileSync(fixture, 'utf8')));
}

const ask = frame('v1-aap-ask');
const reply = frame('v1-aap-reply');
const inboxKey = { consumer_id: 'reviewer', protocol: ask.protocol, exchange_id: ask.exchange_id };

describe('protocol transactional delivery', () => {
  it('commits task, outbox and journal together, and rolls all of them back on failure', () => {
    const databasePath = createDatabase();
    const store = new SqliteCoordinationStore(databasePath);
    expect(() => store.withProtocolTransaction((transaction) => {
      transaction.commitState(initialCommit());
      transaction.enqueueOutbox({ id: 'out-1', destination: 'reviewer', frame: ask });
      throw new Error('crash before commit');
    })).toThrow('crash before commit');
    expect(store.getTaskAggregate('task-0088')).toBeUndefined();
    expect(store.getOutbox('out-1')).toBeUndefined();
    expect(store.listJournal('task-0088', 'run-20260921-001')).toEqual([]);

    store.withProtocolTransaction((transaction) => {
      transaction.commitState(initialCommit());
      transaction.enqueueOutbox({ id: 'out-1', destination: 'reviewer', frame: ask });
      transaction.appendCall({
        task_id: ask.task_id, run_id: ask.run_id, call_id: 'call-1', role_id: 'implementer',
        event: 'memory_query', status: 'ok', summary: 'done',
        completed_at: '2026-09-21T09:04:01.000Z',
        session_id: 'sess-1', duration_ms: 42,
      });
    });
    expect(store.getTaskAggregate('task-0088')).toBeDefined();
    expect(store.getOutbox('out-1')?.status).toBe('pending');
    expect(store.listJournal(ask.task_id, ask.run_id).map(({ seq, kind, causation_id }) =>
      ({ seq, kind, causation_id }))).toEqual([
      { seq: 1, kind: 'aap', causation_id: ask.causation_id },
      { seq: 2, kind: 'call', causation_id: null },
    ]);
    const callRow = store.listJournal(ask.task_id, ask.run_id)[1];
    expect(callRow.session_id).toBe('sess-1');
    expect(callRow.duration_ms).toBe(42);
    store.close();

    const reopened = new SqliteCoordinationStore(databasePath);
    expect(reopened.getOutbox('out-1')).toBeDefined();
    expect(reopened.listRecoverableOutbox('2026-09-21T09:04:10.000Z')).toHaveLength(1);
    // 两新列跨重开持久
    expect(reopened.listJournal(ask.task_id, ask.run_id)[1].duration_ms).toBe(42);
    reopened.close();
  });

  it('rejects async work inside the synchronous SQLite transaction', () => {
    const store = new SqliteCoordinationStore(createDatabase());
    expect(() => store.withProtocolTransaction(async (tx) => {
      tx.commitState(initialCommit());
    })).toThrow('must be synchronous');
    expect(store.getTaskAggregate('task-0088')).toBeUndefined();
    store.close();
  });

  it('rejects writes through a transaction object after commit', () => {
    const store = new SqliteCoordinationStore(createDatabase());
    let leaked: ProtocolDeliveryTransaction | undefined;
    store.withProtocolTransaction((tx) => {
      tx.commitState(initialCommit());
      leaked = tx;
    });
    expect(() => leaked!.enqueueOutbox({ id: 'late', destination: 'reviewer', frame: ask }))
      .toThrow('no longer active');
    expect(store.getOutbox('late')).toBeUndefined();
    store.close();
  });

  it('makes call journal append idempotent and archives only settled rows', () => {
    const store = new SqliteCoordinationStore(createDatabase());
    store.commitState(initialCommit());
    store.withProtocolTransaction((tx) => {
      const first = tx.appendCall({
        task_id: ask.task_id, run_id: ask.run_id, call_id: 'call-archive', role_id: 'implementer',
        event: 'memory_query', status: 'ok', summary: 'done',
        completed_at: '2026-09-21T09:04:01.000Z',
        session_id: 'sess-a', duration_ms: 7,
      });
      const second = tx.appendCall({
        task_id: ask.task_id, run_id: ask.run_id, call_id: 'call-archive', role_id: 'implementer',
        event: 'memory_query', status: 'ok', summary: 'duplicate',
        completed_at: '2026-09-21T09:04:02.000Z',
      });
      expect(second).toEqual(first);
      expect(second.session_id).toBe('sess-a');
      expect(second.duration_ms).toBe(7);
    });
    store.withProtocolTransaction((tx) => {
      tx.enqueueOutbox({ id: 'settled', destination: 'reviewer', frame: ask });
    });
    const claimed = store.claimOutbox('settled', 'worker', '2026-09-21T09:04:00.000Z',
      '2026-09-21T09:05:00.000Z', 1)!;
    store.markOutboxSent('settled', 'worker', claimed.revision, '2026-09-21T09:04:30.000Z');
    const archived = store.archiveSettled('2026-09-21T09:05:00.000Z');
    expect(archived).toEqual({ outbox: 0, inbox: 0 });
    expect(store.getOutbox('settled')?.status).toBe('sent');
    store.withProtocolTransaction((tx) => {
      tx.enqueueOutbox({ id: 'failed', destination: 'reviewer', frame: {
        ...ask, exchange_id: 'ex-aap-failed', attempt: 1,
      } });
    });
    const failed = store.claimOutbox('failed', 'worker', '2026-09-21T09:04:00.000Z',
      '2026-09-21T09:05:00.000Z', 1)!;
    store.failOutbox('failed', 'worker', failed.revision, '2026-09-21T09:04:30.000Z');
    expect(store.archiveSettled('2026-09-21T09:07:00.000Z')).toEqual({ outbox: 1, inbox: 0 });
    expect(store.getOutbox('failed')).toBeUndefined();
    expect(store.getOutbox('settled')?.status).toBe('sent');
    store.close();
  });

  it('claims each outbox once across workers, recovers expired leases and never replays sent', () => {
    const databasePath = createDatabase();
    const first = new SqliteCoordinationStore(databasePath);
    first.commitState(initialCommit());
    first.withProtocolTransaction((tx) => {
      tx.enqueueOutbox({ id: 'held', destination: 'reviewer', frame: ask, status: 'held' });
    });
    const second = new SqliteCoordinationStore(databasePath);
    expect(first.listRecoverableOutbox('2026-09-21T09:04:01.000Z')).toEqual([]);
    const activated = first.activateOutbox('held', 1, '2026-09-21T09:04:00.000Z');
    const claimed = first.claimOutbox(
      'held', 'worker-a', '2026-09-21T09:04:00.000Z', '2026-09-21T09:05:00.000Z',
      activated.revision,
    );
    expect(claimed?.attempt).toBe(1);
    expect(second.claimOutbox(
      'held', 'worker-b', '2026-09-21T09:04:01.000Z', '2026-09-21T09:06:00.000Z',
      activated.revision,
    )).toBeUndefined();
    expect(() => first.markOutboxSent('held', 'worker-a', claimed!.revision,
      '2026-09-21T09:05:01.000Z')).toThrow('conflict');
    const recovered = second.claimOutbox(
      'held', 'worker-b', '2026-09-21T09:05:01.000Z', '2026-09-21T09:06:00.000Z',
      claimed!.revision,
    );
    expect(recovered?.attempt).toBe(2);
    expect(recovered?.frame.attempt).toBe(2);
    expect(second.getOutbox('held')?.frame.attempt).toBe(2);
    second.markOutboxSent('held', 'worker-b', recovered!.revision, '2026-09-21T09:05:30.000Z');
    expect(first.listRecoverableOutbox('2026-09-21T09:20:00.000Z')).toEqual([]);
    expect(first.claimOutbox('held', 'worker-a', '2026-09-21T09:20:00.000Z',
      '2026-09-21T09:21:00.000Z', recovered!.revision + 1)).toBeUndefined();
    first.close();
    second.close();
  });

  it('deduplicates inbox, atomically commits reply and completes original by causation after restart', () => {
    const databasePath = createDatabase();
    const store = new SqliteCoordinationStore(databasePath);
    store.commitState(initialCommit());
    store.withProtocolTransaction((tx) => {
      tx.enqueueOutbox({ id: 'original', destination: 'reviewer', frame: ask });
      expect(tx.receiveInbox({ consumer_id: 'reviewer', frame: ask,
        received_at: '2026-09-21T09:04:02.000Z' }).inserted).toBe(true);
      expect(tx.receiveInbox({ consumer_id: 'reviewer', frame: { ...ask, attempt: 2 },
        received_at: '2026-09-21T09:04:03.000Z' }).inserted).toBe(false);
      expect(() => tx.receiveInbox({ consumer_id: 'reviewer',
        frame: { ...ask, instruction: { text: 'changed request', ref: null } },
        received_at: '2026-09-21T09:04:03.000Z' })).toThrow('conflicts');
    });
    const claimed = store.claimInbox(inboxKey, 'worker-a', '2026-09-21T09:04:03.000Z',
      '2026-09-21T09:20:00.000Z', 1)!;
    const businessCommit: CoordinationStateCommit = {
      ...initialCommit(), expected_task_revision: 1,
      task: { ...initialCommit().task, status: 'running', revision: 2,
        updated_at: '2026-09-21T09:08:12.000Z' },
      events: [{ ...initialCommit().events[0], event_id: 'event-review-complete',
        event_type: 'task.updated', created_at: '2026-09-21T09:08:12.000Z' }],
      run: undefined,
    };
    expect(() => store.withProtocolTransaction((tx) => {
      tx.commitState(businessCommit);
      tx.completeInbox({ key: inboxKey, lease_owner: 'worker-a',
        expected_revision: claimed.revision, completed_at: '2026-09-21T09:08:12.000Z',
        reply: { id: 'reply-out', destination: 'implementer', frame: reply } });
      throw new Error('crash before reply commit');
    })).toThrow('crash before reply commit');
    expect(store.getInbox(inboxKey)?.status).toBe('processing');
    expect(store.getOutbox('reply-out')).toBeUndefined();
    expect(store.getTaskAggregate('task-0088')?.task.revision).toBe(1);
    store.withProtocolTransaction((tx) => {
      tx.commitState(businessCommit);
      tx.completeInbox({ key: inboxKey, lease_owner: 'worker-a',
        expected_revision: claimed.revision, completed_at: '2026-09-21T09:08:12.000Z',
        reply: { id: 'reply-out', destination: 'implementer', frame: reply } });
    });
    store.close();

    const reopened = new SqliteCoordinationStore(databasePath);
    expect(reopened.getInbox(inboxKey)).toMatchObject({ status: 'complete',
      reply_exchange_id: reply.exchange_id });
    expect(reopened.getTaskAggregate('task-0088')?.task.revision).toBe(2);
    expect(reopened.getOutbox('reply-out')?.status).toBe('pending');
    expect(reopened.listRecoverableInbox('2026-09-21T09:30:00.000Z')).toEqual([]);
    const original = reopened.claimOutbox('original', 'sender', '2026-09-21T09:08:13.000Z',
      '2026-09-21T09:20:00.000Z', 1)!;
    reopened.markOutboxSent('original', 'sender', original.revision,
      '2026-09-21T09:08:14.000Z');
    reopened.withProtocolTransaction((tx) => {
      expect(tx.receiveInbox({ consumer_id: 'implementer', frame: reply,
        received_at: '2026-09-21T09:08:15.000Z' }).inserted).toBe(true);
    });
    expect(reopened.getOutbox('original')?.status).toBe('complete');
    expect(reopened.listRecoverableOutbox('2026-09-21T09:30:00.000Z')
      .map((record) => record.id)).toEqual(['reply-out']);
    const seq = reopened.listJournal(ask.task_id, ask.run_id).map((entry) => entry.seq);
    expect(seq).toEqual([...seq].sort((left, right) => left - right));
    reopened.close();
  });

  it('recovers only received or expired processing inbox rows', () => {
    const store = new SqliteCoordinationStore(createDatabase());
    store.commitState(initialCommit());
    store.withProtocolTransaction((tx) => tx.receiveInbox({
      consumer_id: 'reviewer', frame: ask, received_at: '2026-09-21T09:04:02.000Z',
    }));
    expect(store.listRecoverableInbox('2026-09-21T09:04:03.000Z')).toHaveLength(1);
    const claimed = store.claimInbox(inboxKey, 'worker-a', '2026-09-21T09:04:03.000Z',
      '2026-09-21T09:05:00.000Z', 1)!;
    expect(store.listRecoverableInbox('2026-09-21T09:04:30.000Z')).toEqual([]);
    expect(store.listRecoverableInbox('2026-09-21T09:05:01.000Z')).toHaveLength(1);
    expect(store.claimInbox(inboxKey, 'worker-b', '2026-09-21T09:05:01.000Z',
      '2026-09-21T09:06:00.000Z', claimed.revision)?.lease_owner).toBe('worker-b');
    store.close();
  });

  it('keeps a completed original when its delivery acknowledgement arrives after the reply', () => {
    const store = new SqliteCoordinationStore(createDatabase());
    store.commitState(initialCommit());
    store.withProtocolTransaction((tx) => {
      tx.enqueueOutbox({ id: 'original', destination: 'reviewer', frame: ask });
    });
    const claimed = store.claimOutbox('original', 'sender', '2026-09-21T09:04:00.000Z',
      '2026-09-21T09:10:00.000Z', 1)!;
    store.withProtocolTransaction((tx) => {
      tx.receiveInbox({ consumer_id: 'implementer', frame: reply,
        received_at: '2026-09-21T09:08:12.000Z' });
    });
    expect(store.getOutbox('original')?.status).toBe('complete');
    expect(store.markOutboxSent('original', 'sender', claimed.revision,
      '2026-09-21T09:08:13.000Z').status).toBe('complete');
    expect(store.listRecoverableOutbox('2026-09-21T09:20:00.000Z')).toEqual([]);
    store.close();
  });

  it('renews leases and schedules retries without admitting another worker', () => {
    const store = new SqliteCoordinationStore(createDatabase());
    store.commitState(initialCommit());
    store.withProtocolTransaction((tx) => {
      tx.enqueueOutbox({ id: 'out-1', destination: 'reviewer', frame: ask });
      tx.receiveInbox({ consumer_id: 'reviewer', frame: ask,
        received_at: '2026-09-21T09:04:00.000Z' });
    });
    const outbox = store.claimOutbox('out-1', 'worker-a', '2026-09-21T09:04:00.000Z',
      '2026-09-21T09:05:00.000Z', 1)!;
    const renewedOutbox = store.renewOutboxLease('out-1', 'worker-a', outbox.revision,
      '2026-09-21T09:04:30.000Z', '2026-09-21T09:06:00.000Z');
    expect(store.claimOutbox('out-1', 'worker-b', '2026-09-21T09:05:30.000Z',
      '2026-09-21T09:07:00.000Z', renewedOutbox.revision)).toBeUndefined();
    expect(() => store.retryOutbox('out-1', 'worker-a', outbox.revision,
      '2026-09-21T09:05:00.000Z', '2026-09-21T09:08:00.000Z')).toThrow('conflict');
    store.retryOutbox('out-1', 'worker-a', renewedOutbox.revision,
      '2026-09-21T09:05:00.000Z', '2026-09-21T09:08:00.000Z');
    expect(store.listRecoverableOutbox('2026-09-21T09:07:59.000Z')).toEqual([]);
    expect(store.listRecoverableOutbox('2026-09-21T09:08:00.000Z')).toHaveLength(1);

    const inbox = store.claimInbox(inboxKey, 'worker-a', '2026-09-21T09:04:00.000Z',
      '2026-09-21T09:05:00.000Z', 1)!;
    const renewedInbox = store.renewInboxLease(inboxKey, 'worker-a', inbox.revision,
      '2026-09-21T09:04:30.000Z', '2026-09-21T09:06:00.000Z');
    expect(store.listRecoverableInbox('2026-09-21T09:05:30.000Z')).toEqual([]);
    expect(renewedInbox.lease_expires_at).toBe('2026-09-21T09:06:00.000Z');
    store.close();
  });
});
