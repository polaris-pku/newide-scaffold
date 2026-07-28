import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PersistedMailboxDelivery,
  PersistedMailboxMessage,
} from '../../src/persistence/mailbox-state-store';
import { SqliteCoordinationStore } from '../../src/persistence';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SqliteCoordinationStore persistent mailbox', () => {
  it('persists send, inbox delivery and ack across a database restart', () => {
    const { databasePath, store } = createStore();
    const message = mailboxMessage('message_1');
    const agentDelivery = mailboxDelivery('delivery_agent', message.message_id, {
      agent_id: 'agent_reviewer',
    });
    const roleDelivery = mailboxDelivery('delivery_role', message.message_id, {
      role_id: 'role_reviewer',
    });

    store.saveMailboxMessage(message, [agentDelivery, roleDelivery]);
    expect(store.listReplayableMailboxDeliveries()).toEqual([
      { message, delivery: agentDelivery },
      { message, delivery: roleDelivery },
    ]);

    const inbox = store.receiveMailboxInbox(
      { agent_id: 'agent_reviewer' },
      '2026-07-19T06:00:01.000Z',
    );
    expect(inbox).toEqual([
      {
        message,
        delivery: {
          ...agentDelivery,
          status: 'delivered',
          delivered_at: '2026-07-19T06:00:01.000Z',
          updated_at: '2026-07-19T06:00:01.000Z',
        },
      },
    ]);
    expect(
      store.acknowledgeMailboxDelivery(
        agentDelivery.delivery_id,
        { agent_id: 'agent_reviewer' },
        '2026-07-19T06:00:02.000Z',
      ),
    ).toMatchObject({
      delivery_id: agentDelivery.delivery_id,
      status: 'acknowledged',
      acknowledged_at: '2026-07-19T06:00:02.000Z',
    });
    store.close();

    const reopened = new SqliteCoordinationStore(databasePath);
    expect(reopened.listMailboxThread('thread_1')).toEqual([message]);
    expect(reopened.listReplayableMailboxDeliveries()).toEqual([
      { message, delivery: roleDelivery },
    ]);
    reopened.close();
  });

  it('acks the source delivery and creates a reply delivery in one transaction', () => {
    const { store } = createStore();
    const source = mailboxMessage('message_source');
    const sourceDelivery = mailboxDelivery('delivery_source', source.message_id, {
      agent_id: 'agent_target',
    });
    store.saveMailboxMessage(source, [sourceDelivery]);
    store.receiveMailboxInbox({ agent_id: 'agent_target' }, '2026-07-19T06:01:00.000Z');

    const reply = mailboxMessage('message_reply', source.message_id);
    const replyDelivery = mailboxDelivery('delivery_reply', reply.message_id, {
      agent_id: 'agent_source',
    });
    const result = store.saveMailboxReply({
      source_delivery_id: sourceDelivery.delivery_id,
      source_recipient: { agent_id: 'agent_target' },
      message: reply,
      deliveries: [replyDelivery],
      acknowledged_at: '2026-07-19T06:01:01.000Z',
    });

    expect(result.source_delivery).toMatchObject({
      delivery_id: sourceDelivery.delivery_id,
      status: 'acknowledged',
    });
    expect(result.reply).toEqual({ message: reply, deliveries: [replyDelivery] });
    expect(store.listMailboxThread('thread_1')).toEqual([source, reply]);
    expect(store.listReplayableMailboxDeliveries()).toEqual([
      { message: reply, delivery: replyDelivery },
    ]);
    store.close();
  });

  it('records failed wake attempts without losing the pending delivery', () => {
    const { store } = createStore();
    const message = mailboxMessage('message_retry');
    const delivery = mailboxDelivery('delivery_retry', message.message_id, {
      agent_id: 'agent_sleeping',
    });
    store.saveMailboxMessage(message, [delivery]);

    expect(
      store.recordMailboxWakeAttempt(delivery.delivery_id, {
        attempted_at: '2026-07-19T06:02:00.000Z',
        error: { code: 'WAKE_FAILED', message: 'B runtime unavailable' },
      }),
    ).toMatchObject({
      status: 'pending',
      retry_count: 1,
      last_error: { code: 'WAKE_FAILED', message: 'B runtime unavailable' },
    });
    expect(store.listReplayableMailboxDeliveries()).toHaveLength(1);
    store.close();
  });
});

function createStore(): { databasePath: string; store: SqliteCoordinationStore } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-mailbox-sqlite-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'coordination.sqlite');
  return { databasePath, store: new SqliteCoordinationStore(databasePath) };
}

function mailboxMessage(
  messageId: string,
  replyToMessageId?: string,
): PersistedMailboxMessage {
  return {
    message_id: messageId,
    thread_id: 'thread_1',
    from_agent_id: 'agent_source',
    type: replyToMessageId ? 'decision_response' : 'decision_request',
    payload: replyToMessageId ? { answer: 'Approved' } : { question: 'Approve?' },
    artifact_refs: [],
    requires_ack: true,
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    created_at: replyToMessageId
      ? '2026-07-19T06:01:01.000Z'
      : '2026-07-19T06:00:00.000Z',
    schema_version: 'v0',
  };
}

function mailboxDelivery(
  deliveryId: string,
  messageId: string,
  recipient: { agent_id: string } | { role_id: string },
): PersistedMailboxDelivery {
  return {
    delivery_id: deliveryId,
    message_id: messageId,
    ...('agent_id' in recipient
      ? { recipient_agent_id: recipient.agent_id }
      : { recipient_role_id: recipient.role_id }),
    status: 'pending',
    retry_count: 0,
    created_at: '2026-07-19T06:00:00.000Z',
    updated_at: '2026-07-19T06:00:00.000Z',
    schema_version: 'v0',
  };
}
