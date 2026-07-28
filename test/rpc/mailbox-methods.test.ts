import { describe, expect, it, vi } from 'vitest';
import {
  MailboxDeliveryNotFoundError,
  type MailboxReplyInput,
  type MailboxSendInput,
} from '../../src/app/persistent-mailbox-service';
import type { MessageRecipient } from '../../src/core';
import type {
  PersistedMailboxDelivery,
  PersistedMailboxEnvelope,
} from '../../src/persistence';
import { JsonRpcDispatcher, JsonRpcLineSession } from '../../src/rpc/json-rpc-dispatcher';
import { MailboxRpcMethods, type MailboxMethodsService } from '../../src/rpc/mailbox-methods';

describe('MailboxRpcMethods', () => {
  it('exposes send, inbox, ack and reply with strict parameters', async () => {
    const output: string[] = [];
    const sendMailboxMessage = vi.fn(async (_input: MailboxSendInput) => ({
      message: envelope().message,
      deliveries: [envelope().delivery],
    }));
    const listMailboxInbox = vi.fn(
      async (_recipient: MessageRecipient, _afterDeliveryId?: string) => [envelope()],
    );
    const acknowledgeMailboxDelivery = vi.fn(
      async (_deliveryId: string, _recipient: MessageRecipient) => ({
        ...envelope().delivery,
        status: 'acknowledged' as const,
      }),
    );
    const replyMailboxMessage = vi.fn(async (_input: MailboxReplyInput) => ({
      source_delivery: {
        ...envelope().delivery,
        status: 'acknowledged' as const,
      },
      reply: { message: envelope().message, deliveries: [envelope().delivery] },
    }));
    const session = sessionWith(
      {
        sendMailboxMessage,
        listMailboxInbox,
        acknowledgeMailboxDelivery,
        replyMailboxMessage,
      },
      output,
    );

    await session.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'mailbox.send',
        params: {
          thread_id: 'thread_1',
          from_agent_id: 'agent_source',
          to: [{ agent_id: 'agent_target' }],
          type: 'ask_help',
          payload: { question: 'Review?' },
          requires_ack: true,
          deadline_seconds: 60,
        },
      }),
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":2,"method":"mailbox.inbox","params":{"agent_id":"agent_target","after_delivery_id":"delivery_previous"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":3,"method":"mailbox.ack","params":{"delivery_id":"delivery_1","agent_id":"agent_target"}}',
    );
    await session.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'mailbox.reply',
        params: {
          source_delivery_id: 'delivery_1',
          source_recipient: { agent_id: 'agent_target' },
          from_agent_id: 'agent_target',
          to: [{ agent_id: 'agent_source' }],
          type: 'decision_response',
          payload: { answer: 'Approved' },
          requires_ack: false,
        },
      }),
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":5,"method":"mailbox.inbox","params":{"agent_id":"a","role_id":"r"}}',
    );

    expect(output.map((line) => JSON.parse(line))).toMatchObject([
      { id: 1, result: { message: { message_id: 'message_1' } } },
      { id: 2, result: { deliveries: [{ delivery: { delivery_id: 'delivery_1' } }] } },
      { id: 3, result: { delivery_id: 'delivery_1', status: 'acknowledged' } },
      { id: 4, result: { source_delivery: { status: 'acknowledged' } } },
      { id: 5, error: { code: -32602, message: 'Invalid params' } },
    ]);
    expect(listMailboxInbox).toHaveBeenCalledWith(
      { agent_id: 'agent_target' },
      'delivery_previous',
    );
  });

  it('maps a missing Delivery to a stable JSON-RPC error', async () => {
    const output: string[] = [];
    const service = fakeService({
      acknowledgeMailboxDelivery: async (deliveryId) => {
        throw new MailboxDeliveryNotFoundError(deliveryId);
      },
    });
    const session = sessionWith(service, output);

    await session.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"mailbox.ack","params":{"delivery_id":"delivery_missing","agent_id":"agent_target"}}',
    );

    expect(output.map((line) => JSON.parse(line))).toMatchObject([
      {
        id: 1,
        error: {
          code: -32011,
          message: 'Mailbox delivery not found',
          data: { delivery_id: 'delivery_missing' },
        },
      },
    ]);
  });
});

function sessionWith(service: MailboxMethodsService, output: string[]): JsonRpcLineSession {
  const dispatcher = new JsonRpcDispatcher();
  new MailboxRpcMethods(service).register(dispatcher);
  return new JsonRpcLineSession(dispatcher, (line) => output.push(line));
}

function fakeService(overrides: Partial<MailboxMethodsService> = {}): MailboxMethodsService {
  return {
    sendMailboxMessage: async () => ({
      message: envelope().message,
      deliveries: [envelope().delivery],
    }),
    listMailboxInbox: async () => [envelope()],
    acknowledgeMailboxDelivery: async () => envelope().delivery,
    replyMailboxMessage: async () => ({
      source_delivery: envelope().delivery,
      reply: { message: envelope().message, deliveries: [envelope().delivery] },
    }),
    ...overrides,
  };
}

function envelope(): PersistedMailboxEnvelope {
  const delivery: PersistedMailboxDelivery = {
    delivery_id: 'delivery_1',
    message_id: 'message_1',
    recipient_agent_id: 'agent_target',
    status: 'delivered',
    retry_count: 1,
    delivered_at: '2026-07-19T08:00:01.000Z',
    created_at: '2026-07-19T08:00:00.000Z',
    updated_at: '2026-07-19T08:00:01.000Z',
    schema_version: 'v0',
  };
  return {
    message: {
      message_id: 'message_1',
      thread_id: 'thread_1',
      from_agent_id: 'agent_source',
      type: 'ask_help',
      payload: { question: 'Review?' },
      artifact_refs: [],
      requires_ack: true,
      created_at: '2026-07-19T08:00:00.000Z',
      schema_version: 'v0',
    },
    delivery,
  };
}
