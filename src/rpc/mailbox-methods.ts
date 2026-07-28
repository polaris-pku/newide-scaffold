/** mailbox.* JSON-RPC 方法适配器。 */
import { z } from 'zod';
import type { AgentMessageType, MessageRecipient } from '../core';
import {
  MailboxDeliveryNotFoundError,
  MailboxDeliveryStateError,
  MailboxRecipientMismatchError,
  MailboxValidationError,
  type MailboxReplyInput,
  type MailboxSendInput,
  type MailboxSendResult,
} from '../app/persistent-mailbox-service';
import type {
  PersistedMailboxDelivery,
  PersistedMailboxEnvelope,
  SaveMailboxReplyResult,
} from '../persistence';
import { JsonRpcMethodError, type JsonRpcDispatcher } from './json-rpc-dispatcher';
import { JSON_RPC_ERROR_CODES } from './json-rpc-line-protocol';

export interface MailboxMethodsService {
  sendMailboxMessage(input: MailboxSendInput): Promise<{
    message: MailboxSendResult['message'];
    deliveries: PersistedMailboxDelivery[];
  }>;
  listMailboxInbox(
    recipient: MessageRecipient,
    afterDeliveryId?: string,
  ): Promise<PersistedMailboxEnvelope[]>;
  acknowledgeMailboxDelivery(
    deliveryId: string,
    recipient: MessageRecipient,
  ): Promise<PersistedMailboxDelivery>;
  replyMailboxMessage(input: MailboxReplyInput): Promise<SaveMailboxReplyResult>;
}

const recipientSchema = z
  .object({
    agent_id: z.string().trim().min(1).optional(),
    role_id: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => (value.agent_id !== undefined) !== (value.role_id !== undefined));

const messageTypeSchema = z.enum([
  'ask_help',
  'review_request',
  'proposal',
  'critique',
  'handoff',
  'status_update',
  'decision_request',
  'decision_response',
  'task.assigned',
  'driver.requested',
  'driver.completed',
]);

const sendParamsSchema = z
  .object({
    thread_id: z.string().trim().min(1),
    from_agent_id: z.string().trim().min(1),
    to: z.array(recipientSchema).min(1),
    type: messageTypeSchema,
    payload: z.record(z.string(), z.unknown()),
    artifact_refs: z.array(z.string().trim().min(1)).optional(),
    requires_ack: z.boolean(),
    deadline_seconds: z.number().int().positive().optional(),
  })
  .strict();

const inboxParamsSchema = z
  .object({
    agent_id: z.string().trim().min(1).optional(),
    role_id: z.string().trim().min(1).optional(),
    after_delivery_id: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => (value.agent_id !== undefined) !== (value.role_id !== undefined));

const ackParamsSchema = z
  .object({
    delivery_id: z.string().trim().min(1),
    agent_id: z.string().trim().min(1).optional(),
    role_id: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => (value.agent_id !== undefined) !== (value.role_id !== undefined));

const replyParamsSchema = z
  .object({
    source_delivery_id: z.string().trim().min(1),
    source_recipient: recipientSchema,
    from_agent_id: z.string().trim().min(1),
    to: z.array(recipientSchema).min(1),
    type: messageTypeSchema,
    payload: z.record(z.string(), z.unknown()),
    artifact_refs: z.array(z.string().trim().min(1)).optional(),
    requires_ack: z.boolean(),
    deadline_seconds: z.number().int().positive().optional(),
  })
  .strict();

export class MailboxRpcMethods {
  constructor(private readonly service: MailboxMethodsService) {}

  register(dispatcher: JsonRpcDispatcher): void {
    dispatcher.register('mailbox.send', (params) => {
      const parsed = parseParams(sendParamsSchema, params);
      return this.callWithMailboxError(() =>
        this.service.sendMailboxMessage(toSendInput(parsed)),
      );
    });
    dispatcher.register('mailbox.inbox', (params) => {
      const parsed = parseParams(inboxParamsSchema, params);
      return this.callWithMailboxError(() =>
        this.service
          .listMailboxInbox(toRecipient(parsed), parsed.after_delivery_id)
          .then((deliveries) => ({ deliveries })),
      );
    });
    dispatcher.register('mailbox.ack', (params) => {
      const parsed = parseParams(ackParamsSchema, params);
      return this.callWithMailboxError(() =>
        this.service.acknowledgeMailboxDelivery(parsed.delivery_id, toRecipient(parsed)),
      );
    });
    dispatcher.register('mailbox.reply', (params) => {
      const parsed = parseParams(replyParamsSchema, params);
      return this.callWithMailboxError(() =>
        this.service.replyMailboxMessage({
          source_delivery_id: parsed.source_delivery_id,
          source_recipient: toRecipient(parsed.source_recipient),
          from_agent_id: parsed.from_agent_id,
          to: parsed.to.map((recipient) => toRecipient(recipient)),
          type: parsed.type as AgentMessageType,
          payload: { ...parsed.payload },
          ...(parsed.artifact_refs ? { artifact_refs: [...parsed.artifact_refs] } : {}),
          requires_ack: parsed.requires_ack,
          ...(parsed.deadline_seconds !== undefined
            ? { deadline_seconds: parsed.deadline_seconds }
            : {}),
        }),
      );
    });
  }

  private async callWithMailboxError<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MailboxDeliveryNotFoundError) {
        throw new JsonRpcMethodError(
          JSON_RPC_ERROR_CODES.MAILBOX_DELIVERY_NOT_FOUND,
          'Mailbox delivery not found',
          { delivery_id: error.deliveryId },
        );
      }
      if (error instanceof MailboxRecipientMismatchError) {
        throw new JsonRpcMethodError(
          JSON_RPC_ERROR_CODES.MAILBOX_RECIPIENT_MISMATCH,
          'Mailbox recipient mismatch',
          { delivery_id: error.deliveryId },
        );
      }
      if (error instanceof MailboxDeliveryStateError) {
        throw new JsonRpcMethodError(
          JSON_RPC_ERROR_CODES.MAILBOX_DELIVERY_STATE,
          'Mailbox delivery is not in a handleable state',
          { delivery_id: error.deliveryId, status: error.status },
        );
      }
      if (error instanceof MailboxValidationError) {
        throw new JsonRpcMethodError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params');
      }
      throw error;
    }
  }
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcMethodError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params');
  }
  return parsed.data;
}

type RawRecipient = { agent_id?: string | undefined; role_id?: string | undefined };

function toRecipient(input: RawRecipient): MessageRecipient {
  return input.agent_id ? { agent_id: input.agent_id } : { role_id: input.role_id as string };
}

function toSendInput(input: z.infer<typeof sendParamsSchema>): MailboxSendInput {
  return {
    thread_id: input.thread_id,
    from_agent_id: input.from_agent_id,
    to: input.to.map((recipient) => toRecipient(recipient)),
    type: input.type as AgentMessageType,
    payload: { ...input.payload },
    ...(input.artifact_refs ? { artifact_refs: [...input.artifact_refs] } : {}),
    requires_ack: input.requires_ack,
    ...(input.deadline_seconds !== undefined
      ? { deadline_seconds: input.deadline_seconds }
      : {}),
  };
}
