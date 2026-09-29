import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AapMailboxBridge, TaskProcessor } from '../../src/coordination';
import { PersistentMailboxService } from '../../src/mailbox';
import type { TaskCreateRequest } from '../../src/core';
import type { CoordinationStateCommit } from '../../src/persistence';
import { SqliteCoordinationStore } from '../../src/persistence';

describe('AapMailboxBridge', () => {
  let store: SqliteCoordinationStore | undefined;
  const directories: string[] = [];

  afterEach(() => {
    store?.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('atomically activates one Mailbox ask and admits it once after restart', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-aap-bridge-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'coordination.sqlite');
    store = new SqliteCoordinationStore(databasePath);
    store.commitState(initialCommit());
    const bridge = createBridge(store);
    const dispatch = bridge.createAsk({
      task_id: 'task_aap',
      run_id: 'run_aap',
      from_role_id: 'role_sender',
      to_role_id: 'role_reviewer',
      message_id: 'message_1',
      delivery_id: 'delivery_1',
      content: 'Please review the plan.',
      deadline_at: '2026-09-27T08:05:00.000Z',
      exchange_id: 'aap_ask_message_1',
    });
    bridge.commitWait(mailboxWaitCommit(), dispatch);

    expect(store.getOutbox(dispatch.outbox_id)).toMatchObject({
      status: 'held',
      activated_at: '2026-09-27T08:00:00.000Z',
      frame: { command: 'agent.ask', exchange_id: dispatch.frame.exchange_id },
    });
    expect(store.listRecoverableOutbox('2026-09-27T08:00:01.000Z')).toHaveLength(1);

    const first = bridge.beginAsk(dispatch);
    expect(first.should_execute).toBe(true);
    expect(first.ask_inbox.status).toBe('processing');
    store.close();
    store = new SqliteCoordinationStore(databasePath);
    expect(createBridge(store).beginAsk(dispatch).should_execute).toBe(false);
  });

  it('matches replies by causation and makes duplicate replies harmless', () => {
    store = new SqliteCoordinationStore(':memory:');
    store.commitState(initialCommit());
    const bridge = createBridge(store);
    const dispatch = bridge.createAsk({
      task_id: 'task_aap', run_id: 'run_aap', from_role_id: 'role_sender',
      to_role_id: 'role_reviewer', message_id: 'message_2', delivery_id: 'delivery_2',
      content: 'Review.', exchange_id: 'aap_ask_message_2',
    });
    bridge.persistAsk(dispatch);
    const admission = bridge.beginAsk(dispatch);
    const reply = bridge.createReply({
      ask: dispatch.frame,
      status: 'completed',
      summary: 'Approved.',
      exchange_id: 'aap_reply_message_2',
    });

    expect(bridge.acceptReply(admission, reply)).toBe('accepted');
    expect(bridge.acceptReply(admission, reply)).toBe('duplicate');
    expect(store.getInbox({
      consumer_id: 'role_reviewer', protocol: 'agent-agent',
      exchange_id: dispatch.frame.exchange_id,
    })).toMatchObject({ status: 'complete', reply_exchange_id: reply.exchange_id });
    expect(store.getInbox({
      consumer_id: 'system', protocol: 'agent-agent', exchange_id: reply.exchange_id,
    })).toMatchObject({ status: 'complete' });
  });

  it('recovers an outbox marked sent before its receiver inbox was recorded', () => {
    store = new SqliteCoordinationStore(':memory:');
    store.commitState(initialCommit());
    const bridge = createBridge(store);
    const dispatch = bridge.createAsk({
      task_id: 'task_aap', run_id: 'run_aap', from_role_id: 'role_sender',
      to_role_id: 'role_reviewer', message_id: 'message_crash', delivery_id: 'delivery_crash',
      content: 'Recover this ask.', exchange_id: 'aap_ask_crash',
    });
    bridge.persistAsk(dispatch);
    store.withProtocolTransaction((transaction) => {
      const outbox = transaction.getOutbox(dispatch.outbox_id)!;
      const claimed = transaction.claimOutbox(
        dispatch.outbox_id,
        'crashed-worker',
        '2026-09-27T08:00:00.000Z',
        '2026-09-27T08:05:00.000Z',
        outbox.revision,
      )!;
      transaction.markOutboxSent(
        dispatch.outbox_id,
        'crashed-worker',
        claimed.revision,
        '2026-09-27T08:00:00.000Z',
      );
    });
    expect(bridge.beginAsk(dispatch).should_execute).toBe(true);
  });

  it('rejects a reply with the wrong causation exchange', () => {
    store = new SqliteCoordinationStore(':memory:');
    store.commitState(initialCommit());
    const bridge = createBridge(store);
    const dispatch = bridge.createAsk({
      task_id: 'task_aap', run_id: 'run_aap', from_role_id: 'role_sender',
      to_role_id: 'role_reviewer', message_id: 'message_3', delivery_id: 'delivery_3',
      content: 'Review.', exchange_id: 'aap_ask_message_3',
    });
    bridge.persistAsk(dispatch);
    const admission = bridge.beginAsk(dispatch);
    const reply = bridge.createReply({ ask: dispatch.frame, status: 'completed', summary: 'No.' });
    const wrong = { ...reply, causation_id: 'aap_ask_other' };
    expect(() => bridge.acceptReply(admission, wrong)).toThrow(/does not belong/);
  });

  it('keeps a late reply auditable without reopening the ask', () => {
    store = new SqliteCoordinationStore(':memory:');
    store.commitState(initialCommit());
    let now = '2026-09-27T08:00:00.000Z';
    const bridge = new AapMailboxBridge({
      store,
      now: () => now,
      create_id: (prefix) => `${prefix}_generated`,
    });
    const dispatch = bridge.createAsk({
      task_id: 'task_aap', run_id: 'run_aap', from_role_id: 'role_sender',
      to_role_id: 'role_reviewer', message_id: 'message_late', delivery_id: 'delivery_late',
      content: 'Review.', deadline_at: '2026-09-27T08:01:00.000Z', exchange_id: 'aap_ask_late',
    });
    bridge.persistAsk(dispatch);
    const admission = bridge.beginAsk(dispatch);
    now = '2026-09-27T08:02:00.000Z';
    const reply = bridge.createReply({ ask: dispatch.frame, status: 'completed', summary: 'Too late.' });
    expect(bridge.acceptReply(admission, reply)).toBe('late');
    expect(store.getInbox({
      consumer_id: 'role_reviewer', protocol: 'agent-agent', exchange_id: dispatch.frame.exchange_id,
    })).toMatchObject({ status: 'processing', reply_exchange_id: null });
    expect(store.getInbox({
      consumer_id: 'system', protocol: 'agent-agent', exchange_id: reply.exchange_id,
    })).toMatchObject({ status: 'complete' });
  });

  it('rolls back the AAP outbox when the mailbox wait state cannot commit', () => {
    store = new SqliteCoordinationStore(':memory:');
    store.commitState(initialCommit());
    const bridge = createBridge(store);
    const dispatch = bridge.createAsk({
      task_id: 'task_aap', run_id: 'run_aap', from_role_id: 'role_sender',
      to_role_id: 'role_reviewer', message_id: 'message_rollback', delivery_id: 'delivery_rollback',
      content: 'Review.', exchange_id: 'aap_ask_rollback',
    });
    expect(() => bridge.commitWait({ ...mailboxWaitCommit(), expected_task_revision: 999 }, dispatch))
      .toThrow(/revision conflict/);
    expect(store.getOutbox(dispatch.outbox_id)).toBeUndefined();
  });

  it('commits Task mailbox_wait and its AAP outbox in one production path', async () => {
    store = new SqliteCoordinationStore(':memory:');
    const bridge = createBridge(store);
    const mailbox = new PersistentMailboxService(store, {
      now: () => '2026-09-27T08:00:00.000Z',
      createMessageId: () => 'message_task',
      createDeliveryId: () => 'delivery_task',
    });
    const processor = new TaskProcessor(store, {
      now: () => '2026-09-27T08:00:00.000Z',
      createEventId: (() => {
        let sequence = 0;
        return () => `event_task_${++sequence}`;
      })(),
      mailboxStore: store,
      aapBridge: bridge,
    });
    const request: TaskCreateRequest = {
      spec: 'Continue after review',
      role_id: 'role_sender',
      completion_criteria: ['reply is consumed'],
    };
    processor.beginRun({
      task_id: 'task_path', run_id: 'run_path', task_request: request,
      workspace_path: '/workspace', mode: 'single_agent',
      cursor_input: { cursor: 'select_agent', seed: 'seed', candidate_ids: ['role_sender'] },
    });
    processor.startStage({ run_id: 'run_path', expected_cursor: 'select_agent', invocation_id: 'select' });
    processor.advanceStage({
      run_id: 'run_path', expected_cursor: 'select_agent', invocation_id: 'select',
      evidence_ref: evidence('select'),
      next_input: { cursor: 'execute_agent', winner_agent_id: 'role_sender' },
    });
    const sent = await mailbox.send({
      task_id: 'task_path', workspace_path: '/workspace', thread_id: 'thread_path',
      from_role_id: 'role_sender', to_role_id: 'role_reviewer', kind: 'request',
      content: 'Review this.', requires_ack: true, deadline_seconds: 60,
      idempotency_key: 'task_path:ask',
    });
    processor.startStage({ run_id: 'run_path', expected_cursor: 'execute_agent', invocation_id: 'execute' });
    processor.advanceStage({
      run_id: 'run_path', expected_cursor: 'execute_agent', invocation_id: 'execute',
      evidence_ref: evidence('execute'), owner_agent_id: 'role_sender',
      next_input: { cursor: 'mailbox_wait', delivery_ids: [sent.deliveries[0]!.delivery_id], waiting_reason: 'Review' },
    });
    expect(store.getOutbox('outbox_aap_ask_message_task')).toMatchObject({
      status: 'held', activated_at: '2026-09-27T08:00:00.000Z',
    });
  });
});

function createBridge(store: SqliteCoordinationStore): AapMailboxBridge {
  return new AapMailboxBridge({
    store,
    now: () => '2026-09-27T08:00:00.000Z',
    create_id: (prefix) => `${prefix}_generated`,
  });
}

function evidence(stage: string): { uri: string; sha256: string } {
  return { uri: `file:///evidence/${stage}.json`, sha256: 'a'.repeat(64) };
}

function mailboxWaitCommit(): CoordinationStateCommit {
  const commit = initialCommit();
  return {
    ...commit,
    expected_task_revision: 1,
    task: { ...commit.task, status: 'waiting_help', revision: 2 },
    run: { ...commit.run, status: 'completed', revision: 2, completed_at: '2026-09-27T08:00:00.000Z' },
    runtime_state: {
      ...commit.runtime_state,
      current_run_id: undefined,
      resume_cursor: 'mailbox_wait',
      cursor_input: { cursor: 'mailbox_wait', delivery_ids: ['delivery_1'], waiting_reason: 'Review' },
      waiting_on: [{ kind: 'mailbox_reply', delivery_id: 'delivery_1' }],
    },
    events: [{ ...commit.events[0]!, event_id: 'event_aap_wait', event_type: 'task.waiting_help' }],
  };
}

function initialCommit(): CoordinationStateCommit {
  const at = '2026-09-27T07:59:00.000Z';
  return {
    task: {
      task_id: 'task_aap', status: 'running', owner_agent_id: 'role_sender', role_id: 'role_sender',
      risk_level: 'low', spec: 'AAP integration', completion_criteria: ['AAP is durable'],
      affected_paths: ['src/coordination/**'], workspace_path: '/workspace', warnings: [],
      revision: 1, created_at: at, updated_at: at, schema_version: 'v0',
    },
    run: {
      run_id: 'run_aap', task_id: 'task_aap', status: 'running', mode: 'single_agent',
      workspace_path: '/workspace', revision: 1, created_at: at, updated_at: at, schema_version: 'v0',
    },
    runtime_state: {
      task_id: 'task_aap', current_run_id: 'run_aap', resume_cursor: 'execute_agent',
      cursor_input: { cursor: 'execute_agent', winner_agent_id: 'role_sender' }, waiting_on: [],
      artifact_refs: [], diagnostics: {}, updated_at: at, schema_version: 'v0',
    },
    events: [{
      event_id: 'event_aap_created', event_type: 'run.started', subject_id: 'run_aap',
      task_id: 'task_aap', run_id: 'run_aap', payload: {}, created_at: at, schema_version: 'v0',
    }],
  };
}
