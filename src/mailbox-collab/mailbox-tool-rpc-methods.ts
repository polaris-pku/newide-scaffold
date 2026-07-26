import { z } from 'zod';
import type { MessageRecipient } from '../core';
import type { MailboxReplyInput } from '../persistence';
import type { PersistentMailboxService } from '../app/persistent-mailbox-service';
import { JsonRpcMethodError, type JsonRpcDispatcher } from '../rpc/json-rpc-dispatcher';
import { JSON_RPC_ERROR_CODES } from '../rpc/json-rpc-line-protocol';

export interface MailboxToolService {
  readInbox(
    recipient: MessageRecipient,
    limit?: number,
  ): Promise<{
    envelopes: Array<{
      message: Record<string, unknown>;
      delivery: Record<string, unknown>;
    }>;
  }>;

  acknowledgeMessage(deliveryId: string, recipient: MessageRecipient): Promise<{ success: boolean }>;

  replyMessage(input: MailboxReplyInput): Promise<Record<string, unknown>>;
}

const recipientSchema = z
  .object({
    agent_id: z.string().trim().min(1).optional(),
    role_id: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => (value.agent_id !== undefined) !== (value.role_id !== undefined));

const readInboxParamsSchema = z
  .object({
    agent_id: z.string().trim().min(1).optional(),
    role_id: z.string().trim().min(1).optional(),
    limit: z.number().int().positive().optional().default(10),
  })
  .strict()
  .refine((value) => (value.agent_id !== undefined) !== (value.role_id !== undefined));

const acknowledgeParamsSchema = z
  .object({
    delivery_id: z.string().trim().min(1),
    agent_id: z.string().trim().min(1).optional(),
    role_id: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => (value.agent_id !== undefined) !== (value.role_id !== undefined));

export class MailboxToolRpcMethods {
  constructor(private readonly mailboxService: PersistentMailboxService) {}

  register(dispatcher: JsonRpcDispatcher): void {
    dispatcher.register('mailbox.read', (params) => {
      return this.callWithError(async () => {
        const parsed = parseParams(readInboxParamsSchema, params);
        const recipient = toRecipient(parsed);
        const envelopes = this.mailboxService.inbox(recipient, parsed.limit);

        return {
          envelopes: envelopes.map((e) => ({
            message: {
              message_id: e.message.message_id,
              thread_id: e.message.thread_id,
              from_agent_id: e.message.from_agent_id,
              type: e.message.type,
              payload: e.message.payload,
              requires_ack: e.message.requires_ack,
              artifact_refs: e.message.artifact_refs,
              created_at: e.message.created_at,
            },
            delivery: {
              delivery_id: e.delivery.delivery_id,
              message_id: e.delivery.message_id,
              recipient_agent_id: e.delivery.recipient_agent_id,
              recipient_role_id: e.delivery.recipient_role_id,
              status: e.delivery.status,
              deadline_at: e.delivery.deadline_at,
              created_at: e.delivery.created_at,
              updated_at: e.delivery.updated_at,
            },
          })),
        };
      });
    });

    dispatcher.register('mailbox.acknowledge', (params) => {
      return this.callWithError(async () => {
        const parsed = parseParams(acknowledgeParamsSchema, params);
        const recipient = toRecipient(parsed);

        this.mailboxService.ack(parsed.delivery_id, recipient);

        return { success: true };
      });
    });
  }

  private async callWithError<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof JsonRpcMethodError) {
        throw error;
      }
      throw new JsonRpcMethodError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        error instanceof Error ? error.message : 'Unknown error',
      );
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
