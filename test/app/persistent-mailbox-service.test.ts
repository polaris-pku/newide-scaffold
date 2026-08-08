import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MailboxValidationError,
  PersistentMailboxService,
} from '../../src/mailbox';
import { SqliteCoordinationStore } from '../../src/persistence';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('PersistentMailboxService', () => {
  it('persists, injects and explicitly acknowledges a scoped role message', async () => {
    const { store, service } = createService();

    const sent = await service.send({
      task_id: 'task_1',
      workspace_path: '/workspace',
      thread_id: 'thread_1',
      from_role_id: 'role_source',
      to_role_id: 'role_reviewer',
      type: 'ask_help',
      payload: { question: 'Can you review this?' },
      artifact_refs: ['artifact_1'],
      requires_ack: true,
      deadline_seconds: 60,
      idempotency_key: 'send_1',
    });

    expect(sent).toMatchObject({
      message: {
        message_id: 'message_1',
        thread_id: 'thread_1',
        artifact_refs: ['artifact_1'],
      },
      deliveries: [
        {
          delivery_id: 'delivery_1',
          recipient_role_id: 'role_reviewer',
          status: 'pending',
          retry_count: 0,
        },
      ],
    });
    const inbox = service.inbox('task_1', '/workspace', 'role_reviewer');
    expect(inbox).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ message_id: 'message_1' }),
        delivery: expect.objectContaining({
          delivery_id: 'delivery_1',
          status: 'pending',
        }),
      }),
    ]);
    expect(service.markInjected('delivery_1', 'role_reviewer', 'session_reviewer')).toMatchObject({
      status: 'injected',
      recipient_session_id: 'session_reviewer',
    });
    expect(service.ack('delivery_1', 'role_reviewer')).toMatchObject({
      status: 'acknowledged',
    });
    store.close();
  });

  it('acks the injected delivery and persists one causal reply', async () => {
    const { store, service } = createService();
    await service.send({
      task_id: 'task_1',
      workspace_path: '/workspace',
      thread_id: 'thread_1',
      from_role_id: 'role_source',
      to_role_id: 'role_reviewer',
      type: 'decision_request',
      payload: { question: 'Approve?' },
      requires_ack: true,
      deadline_seconds: 60,
      idempotency_key: 'request_1',
    });
    service.markInjected('delivery_1', 'role_reviewer', 'session_reviewer');

    const replied = await service.reply({
      source_delivery_id: 'delivery_1',
      from_role_id: 'role_reviewer',
      type: 'decision_response',
      payload: { answer: 'Approved' },
      requires_ack: false,
      idempotency_key: 'reply_1',
    });

    expect(replied).toMatchObject({
      source_delivery: { delivery_id: 'delivery_1', status: 'acknowledged' },
      reply: {
        message: { message_id: 'message_2', reply_to_message_id: 'message_1' },
        deliveries: [
          {
            delivery_id: 'delivery_2',
            recipient_role_id: 'role_source',
            status: 'pending',
          },
        ],
      },
    });
    store.close();
  });

  it('returns the same pending delivery after restart', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-mailbox-service-replay-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'coordination.sqlite');
    const firstStore = new SqliteCoordinationStore(databasePath);
    const first = new PersistentMailboxService(firstStore, deterministicOptions());
    const sent = await first.send({
      task_id: 'task_restart',
      workspace_path: '/workspace',
      thread_id: 'thread_restart',
      from_role_id: 'role_source',
      to_role_id: 'role_sleeping',
      type: 'status_update',
      payload: { status: 'waiting' },
      requires_ack: false,
      idempotency_key: 'restart_1',
    });
    expect(sent.deliveries[0]).toMatchObject({
      delivery_id: 'delivery_1',
      status: 'pending',
      retry_count: 0,
    });
    firstStore.close();

    const reopenedStore = new SqliteCoordinationStore(databasePath);
    const restarted = new PersistentMailboxService(reopenedStore, deterministicOptions());
    const replayed = await restarted.replayPendingDeliveries();

    expect(replayed).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ message_id: 'message_1' }),
        delivery: expect.objectContaining({
          delivery_id: 'delivery_1',
          status: 'pending',
          retry_count: 0,
        }),
      }),
    ]);
    reopenedStore.close();
  });

  it('returns stable IDs for the same idempotency key and rejects changed content', async () => {
    const { store, service } = createService();
    const input = {
      task_id: 'task_1',
      workspace_path: '/workspace',
      thread_id: 'thread_1',
      from_role_id: 'role_source',
      to_role_id: 'role_reviewer',
      type: 'ask_help' as const,
      payload: { question: 'Review?' },
      requires_ack: false,
      idempotency_key: 'stable_send',
    };

    const first = await service.send(input);
    expect(await service.send(input)).toEqual(first);
    await expect(
      service.send({ ...input, payload: { question: 'Different request' } }),
    ).rejects.toBeInstanceOf(MailboxValidationError);
    store.close();
  });

  it('rejects ack-required messages without a deadline', async () => {
    const { store, service } = createService();
    await expect(
      service.send({
        task_id: 'task_1',
        workspace_path: '/workspace',
        thread_id: 'thread_1',
        from_role_id: 'role_source',
        to_role_id: 'role_target',
        type: 'handoff',
        payload: {},
        requires_ack: true,
        idempotency_key: 'handoff_1',
      }),
    ).rejects.toBeInstanceOf(MailboxValidationError);
    expect(store.listReplayableMailboxDeliveries()).toEqual([]);
    store.close();
  });
});

function createService(): {
  store: SqliteCoordinationStore;
  service: PersistentMailboxService;
} {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-mailbox-service-'));
  temporaryDirectories.push(directory);
  const store = new SqliteCoordinationStore(path.join(directory, 'coordination.sqlite'));
  return {
    store,
    service: new PersistentMailboxService(store, deterministicOptions()),
  };
}

function deterministicOptions(): {
  now: () => string;
  createMessageId: () => string;
  createDeliveryId: () => string;
} {
  let time = 0;
  let messages = 0;
  let deliveries = 0;
  return {
    now: () => `2026-07-19T07:00:${String(time++).padStart(2, '0')}.000Z`,
    createMessageId: () => `message_${String(++messages)}`,
    createDeliveryId: () => `delivery_${String(++deliveries)}`,
  };
}
