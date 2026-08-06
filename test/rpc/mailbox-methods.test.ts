import { describe, expect, it, vi } from 'vitest';
import {
  MailboxDeliveryNotFoundError,
  type MailboxReplyInput,
  type MailboxSendInput,
} from '../../src/mailbox';
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
      async (
        _taskId: string,
        _workspacePath: string,
        _recipientRoleId: string,
        _afterDeliveryId?: string,
      ) => [envelope()],
    );
    const acknowledgeMailboxDelivery = vi.fn(
      async (_deliveryId: string, _recipientRoleId: string) => ({
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
          task_id: 'task_1',
          workspace_path: '/workspace',
          thread_id: 'thread_1',
          from_role_id: 'role_source',
          to_role_id: 'role_target',
          type: 'ask_help',
          payload: { question: 'Review?' },
          requires_ack: true,
          deadline_seconds: 60,
          idempotency_key: 'send_1',
        },
      }),
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":2,"method":"mailbox.inbox","params":{"task_id":"task_1","workspace_path":"/workspace","role_id":"role_target","after_delivery_id":"delivery_previous"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":3,"method":"mailbox.ack","params":{"delivery_id":"delivery_1","role_id":"role_target"}}',
    );
    await session.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'mailbox.reply',
        params: {
          source_delivery_id: 'delivery_1',
          from_role_id: 'role_target',
          type: 'decision_response',
          payload: { answer: 'Approved' },
          requires_ack: false,
          idempotency_key: 'reply_1',
        },
      }),
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":5,"method":"mailbox.inbox","params":{"role_id":"role_target"}}',
    );

    expect(output.map((line) => JSON.parse(line))).toMatchObject([
      { id: 1, result: { message: { message_id: 'message_1' } } },
      { id: 2, result: { deliveries: [{ delivery: { delivery_id: 'delivery_1' } }] } },
      { id: 3, result: { delivery_id: 'delivery_1', status: 'acknowledged' } },
      { id: 4, result: { source_delivery: { status: 'acknowledged' } } },
      { id: 5, error: { code: -32602, message: 'Invalid params' } },
    ]);
    expect(listMailboxInbox).toHaveBeenCalledWith(
      'task_1',
      '/workspace',
      'role_target',
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
      '{"jsonrpc":"2.0","id":1,"method":"mailbox.ack","params":{"delivery_id":"delivery_missing","role_id":"role_target"}}',
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
    task_id: 'task_1',
    workspace_path: '/workspace',
    recipient_role_id: 'role_target',
    recipient_session_id: 'session_target',
    status: 'injected',
    retry_count: 1,
    injected_at: '2026-07-19T08:00:01.000Z',
    created_at: '2026-07-19T08:00:00.000Z',
    updated_at: '2026-07-19T08:00:01.000Z',
    schema_version: 'v0',
  };
  return {
    message: {
      message_id: 'message_1',
      task_id: 'task_1',
      workspace_path: '/workspace',
      thread_id: 'thread_1',
      from_role_id: 'role_source',
      type: 'ask_help',
      payload: { question: 'Review?' },
      artifact_refs: [],
      requires_ack: true,
      idempotency_key: 'send_1',
      created_at: '2026-07-19T08:00:00.000Z',
      schema_version: 'v0',
    },
    delivery,
  };
}
