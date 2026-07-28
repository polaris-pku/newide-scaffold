import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MailboxValidationError,
  PersistentMailboxService,
} from '../../src/app/persistent-mailbox-service';
import type {
  AgentMailboxWakePort,
  AgentMailboxWakeRequestV1,
} from '../../src/protocol/agent-mailbox-wake';
import { SqliteCoordinationStore } from '../../src/persistence';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('PersistentMailboxService', () => {
  it('persists, wakes, delivers and explicitly acknowledges a message', async () => {
    const { store, service, wake } = createService();

    const sent = await service.send({
      thread_id: 'thread_1',
      from_agent_id: 'agent_source',
      to: [{ agent_id: 'agent_sleeping' }],
      type: 'ask_help',
      payload: { question: 'Can you review this?' },
      artifact_refs: ['artifact_1'],
      requires_ack: true,
      deadline_seconds: 60,
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
          recipient_agent_id: 'agent_sleeping',
          status: 'pending',
          retry_count: 1,
        },
      ],
    });
    expect(wake.requests).toEqual([
      expect.objectContaining({
        contract_version: 'agent-mailbox-wake.v1',
        message_id: 'message_1',
        delivery_id: 'delivery_1',
        recipient_agent_id: 'agent_sleeping',
      }),
    ]);

    const inbox = service.inbox({ agent_id: 'agent_sleeping' });
    expect(inbox).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ message_id: 'message_1' }),
        delivery: expect.objectContaining({
          delivery_id: 'delivery_1',
          status: 'delivered',
        }),
      }),
    ]);
    expect(service.ack('delivery_1', { agent_id: 'agent_sleeping' })).toMatchObject({
      status: 'acknowledged',
    });
    store.close();
  });

  it('acks the received delivery and wakes recipients of a persisted reply', async () => {
    const { store, service, wake } = createService();
    await service.send({
      thread_id: 'thread_1',
      from_agent_id: 'agent_source',
      to: [{ role_id: 'role_reviewer' }],
      type: 'decision_request',
      payload: { question: 'Approve?' },
      requires_ack: true,
      deadline_seconds: 60,
    });
    service.inbox({ role_id: 'role_reviewer' });

    const replied = await service.reply({
      source_delivery_id: 'delivery_1',
      source_recipient: { role_id: 'role_reviewer' },
      from_agent_id: 'agent_reviewer',
      to: [{ agent_id: 'agent_source' }],
      type: 'decision_response',
      payload: { answer: 'Approved' },
      requires_ack: false,
    });

    expect(replied).toMatchObject({
      source_delivery: { delivery_id: 'delivery_1', status: 'acknowledged' },
      reply: {
        message: { message_id: 'message_2', reply_to_message_id: 'message_1' },
        deliveries: [
          {
            delivery_id: 'delivery_2',
            recipient_agent_id: 'agent_source',
            status: 'pending',
          },
        ],
      },
    });
    expect(wake.requests).toHaveLength(2);
    expect(wake.requests[1]).toMatchObject({ recipient_agent_id: 'agent_source' });
    store.close();
  });

  it('replays the same pending delivery after restart when the first wake failed', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-mailbox-service-replay-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'coordination.sqlite');
    const firstStore = new SqliteCoordinationStore(databasePath);
    const failingWake = new RecordingWakePort(new Error('B runtime unavailable'));
    const first = new PersistentMailboxService(firstStore, failingWake, deterministicOptions());
    const sent = await first.send({
      thread_id: 'thread_restart',
      from_agent_id: 'agent_source',
      to: [{ agent_id: 'agent_sleeping' }],
      type: 'status_update',
      payload: { status: 'waiting' },
      requires_ack: false,
    });
    expect(sent.deliveries[0]).toMatchObject({
      delivery_id: 'delivery_1',
      status: 'pending',
      retry_count: 1,
      last_error: { code: 'AGENT_WAKE_FAILED', message: 'B runtime unavailable' },
    });
    firstStore.close();

    const reopenedStore = new SqliteCoordinationStore(databasePath);
    const healthyWake = new RecordingWakePort();
    const restarted = new PersistentMailboxService(
      reopenedStore,
      healthyWake,
      deterministicOptions(),
    );
    const replayed = await restarted.replayPendingDeliveries();

    expect(replayed).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ message_id: 'message_1' }),
        delivery: expect.objectContaining({
          delivery_id: 'delivery_1',
          status: 'pending',
          retry_count: 2,
        }),
      }),
    ]);
    expect(replayed[0]?.delivery).not.toHaveProperty('last_error');
    expect(healthyWake.requests).toHaveLength(1);
    reopenedStore.close();
  });

  it('rejects ack-required messages without a deadline', async () => {
    const { store, service } = createService();
    await expect(
      service.send({
        thread_id: 'thread_1',
        from_agent_id: 'agent_source',
        to: [{ agent_id: 'agent_target' }],
        type: 'handoff',
        payload: {},
        requires_ack: true,
      }),
    ).rejects.toBeInstanceOf(MailboxValidationError);
    expect(store.listReplayableMailboxDeliveries()).toEqual([]);
    store.close();
  });
});

class RecordingWakePort implements AgentMailboxWakePort {
  readonly requests: AgentMailboxWakeRequestV1[] = [];

  constructor(private readonly error?: Error) {}

  async wakeAgent(request: AgentMailboxWakeRequestV1): Promise<void> {
    this.requests.push(request);
    if (this.error) throw this.error;
  }
}

function createService(): {
  store: SqliteCoordinationStore;
  service: PersistentMailboxService;
  wake: RecordingWakePort;
} {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-mailbox-service-'));
  temporaryDirectories.push(directory);
  const store = new SqliteCoordinationStore(path.join(directory, 'coordination.sqlite'));
  const wake = new RecordingWakePort();
  return {
    store,
    wake,
    service: new PersistentMailboxService(store, wake, deterministicOptions()),
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
