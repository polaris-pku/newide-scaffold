import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PersistedMailboxDelivery,
  PersistedMailboxMessage,
} from '../../src/mailbox';
import { SqliteCoordinationStore } from '../../src/persistence';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SqliteCoordinationStore persistent mailbox', () => {
  it('persists a scoped delivery, Session injection and ack across restart', () => {
    const { databasePath, store } = createStore();
    const message = mailboxMessage('message_1');
    const delivery = mailboxDelivery('delivery_1', message.message_id, 'role_reviewer');

    store.saveMailboxMessage(message, [delivery]);
    expect(store.listReplayableMailboxDeliveries()).toEqual([{ message, delivery }]);
    expect(store.listMailboxInbox('task_1', '/workspace', 'role_reviewer')).toEqual([
      { message, delivery },
    ]);
    expect(
      store.markMailboxDeliveryInjected(delivery.delivery_id, {
        recipient_role_id: 'role_reviewer',
        recipient_session_id: 'session_reviewer',
        injected_at: '2026-07-19T06:00:01.000Z',
      }),
    ).toMatchObject({
      status: 'injected',
      recipient_session_id: 'session_reviewer',
      injected_at: '2026-07-19T06:00:01.000Z',
    });
    expect(
      store.acknowledgeMailboxDelivery(
        delivery.delivery_id,
        'role_reviewer',
        '2026-07-19T06:00:02.000Z',
      ),
    ).toMatchObject({ status: 'acknowledged' });
    store.close();

    const reopened = new SqliteCoordinationStore(databasePath);
    expect(reopened.listMailboxThread('thread_1')).toEqual([message]);
    expect(reopened.listReplayableMailboxDeliveries()).toEqual([]);
    reopened.close();
  });

  it('acks the source delivery and creates one reply delivery atomically', () => {
    const { store } = createStore();
    const source = mailboxMessage('message_source');
    const sourceDelivery = mailboxDelivery(
      'delivery_source',
      source.message_id,
      'role_reviewer',
    );
    store.saveMailboxMessage(source, [sourceDelivery]);
    store.markMailboxDeliveryInjected(sourceDelivery.delivery_id, {
      recipient_role_id: 'role_reviewer',
      recipient_session_id: 'session_reviewer',
      injected_at: '2026-07-19T06:01:00.000Z',
    });

    const reply = mailboxMessage('message_reply', source.message_id, 'role_reviewer');
    const replyDelivery = mailboxDelivery(
      'delivery_reply',
      reply.message_id,
      'role_source',
    );
    const result = store.saveMailboxReply({
      source_delivery_id: sourceDelivery.delivery_id,
      source_recipient_role_id: 'role_reviewer',
      message: reply,
      deliveries: [replyDelivery],
      acknowledged_at: '2026-07-19T06:01:01.000Z',
    });

    expect(result.source_delivery).toMatchObject({ status: 'acknowledged' });
    expect(result.reply).toEqual({ message: reply, deliveries: [replyDelivery] });
    expect(store.listMailboxThread('thread_1')).toEqual([source, reply]);
    expect(store.listReplayableMailboxDeliveries()).toEqual([
      { message: reply, delivery: replyDelivery },
    ]);
    store.close();
  });

  it('records retry evidence without claiming pending delivery was injected', () => {
    const { store } = createStore();
    const message = mailboxMessage('message_retry');
    const delivery = mailboxDelivery('delivery_retry', message.message_id, 'role_reviewer');
    store.saveMailboxMessage(message, [delivery]);

    expect(
      store.recordMailboxDeliveryAttempt(delivery.delivery_id, {
        attempted_at: '2026-07-19T06:02:00.000Z',
        error: { code: 'SESSION_UNAVAILABLE', message: 'Session unavailable' },
      }),
    ).toMatchObject({
      status: 'pending',
      retry_count: 1,
      last_error: { code: 'SESSION_UNAVAILABLE' },
    });
    store.close();
  });

  it('keeps legacy unscoped deliveries as audit history without redelivery', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-mailbox-legacy-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'coordination.sqlite');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, from_agent_id TEXT NOT NULL,
        type TEXT NOT NULL, payload_json TEXT NOT NULL, artifact_refs_json TEXT NOT NULL,
        requires_ack INTEGER NOT NULL, reply_to_message_id TEXT, created_at TEXT NOT NULL,
        schema_version TEXT NOT NULL
      );
      CREATE TABLE deliveries (
        delivery_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, recipient_agent_id TEXT,
        recipient_role_id TEXT, status TEXT NOT NULL, deadline_at TEXT, delivered_at TEXT,
        acknowledged_at TEXT, retry_count INTEGER NOT NULL, last_error_json TEXT,
        last_delivery_event_id TEXT, replay_cursor TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, schema_version TEXT NOT NULL
      );
      INSERT INTO messages VALUES (
        'message_legacy', 'thread_legacy', 'role_legacy_sender', 'ask_help', '{}', '[]',
        0, NULL, '2026-07-19T06:00:00.000Z', 'v0'
      );
      INSERT INTO deliveries VALUES (
        'delivery_legacy', 'message_legacy', 'role_legacy_receiver', NULL, 'delivered',
        NULL, '2026-07-19T06:00:01.000Z', NULL, 1, NULL, NULL, NULL,
        '2026-07-19T06:00:00.000Z', '2026-07-19T06:00:01.000Z', 'v0'
      );
    `);
    legacy.close();

    const migrated = new SqliteCoordinationStore(databasePath);
    expect(migrated.listReplayableMailboxDeliveries()).toEqual([]);
    migrated.close();
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
  fromRoleId = 'role_source',
): PersistedMailboxMessage {
  return {
    message_id: messageId,
    task_id: 'task_1',
    workspace_path: '/workspace',
    thread_id: 'thread_1',
    from_role_id: fromRoleId,
    type: replyToMessageId ? 'decision_response' : 'decision_request',
    payload: replyToMessageId ? { answer: 'Approved' } : { question: 'Approve?' },
    artifact_refs: [],
    requires_ack: true,
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    idempotency_key: `key_${messageId}`,
    created_at: replyToMessageId
      ? '2026-07-19T06:01:01.000Z'
      : '2026-07-19T06:00:00.000Z',
    schema_version: 'v0',
  };
}

function mailboxDelivery(
  deliveryId: string,
  messageId: string,
  recipientRoleId: string,
): PersistedMailboxDelivery {
  return {
    delivery_id: deliveryId,
    message_id: messageId,
    task_id: 'task_1',
    workspace_path: '/workspace',
    recipient_role_id: recipientRoleId,
    status: 'pending',
    retry_count: 0,
    created_at: '2026-07-19T06:00:00.000Z',
    updated_at: '2026-07-19T06:00:00.000Z',
    schema_version: 'v0',
  };
}
