/** mailbox.* JSON-RPC 方法适配器。 */
import { z } from 'zod';
import type { AgentMessageType } from '../core';
import {
  MailboxDeliveryNotFoundError,
  MailboxDeliveryStateError,
  MailboxRecipientMismatchError,
  MailboxValidationError,
  type MailboxReplyInput,
  type MailboxSendInput,
  type MailboxSendResult,
} from '../mailbox';
import type {
  PersistedMailboxDelivery,
  PersistedMailboxEnvelope,
  SaveMailboxReplyResult,
} from '../mailbox';
import { JsonRpcMethodError, type JsonRpcDispatcher } from './json-rpc-dispatcher';
import { JSON_RPC_ERROR_CODES } from './json-rpc-line-protocol';

export interface MailboxMethodsService {
  sendMailboxMessage(input: MailboxSendInput): Promise<{
    message: MailboxSendResult['message'];
    deliveries: PersistedMailboxDelivery[];
  }>;
  listMailboxInbox(
    taskId: string,
    workspacePath: string,
    recipientRoleId: string,
    afterDeliveryId?: string,
  ): Promise<PersistedMailboxEnvelope[]>;
  acknowledgeMailboxDelivery(
    deliveryId: string,
    recipientRoleId: string,
  ): Promise<PersistedMailboxDelivery>;
  replyMailboxMessage(input: MailboxReplyInput): Promise<SaveMailboxReplyResult>;
}

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
    task_id: z.string().trim().min(1),
    workspace_path: z.string().trim().min(1),
    thread_id: z.string().trim().min(1),
    from_role_id: z.string().trim().min(1),
    to_role_id: z.string().trim().min(1),
    type: messageTypeSchema,
    payload: z.record(z.string(), z.unknown()),
    artifact_refs: z.array(z.string().trim().min(1)).optional(),
    requires_ack: z.boolean(),
    deadline_seconds: z.number().int().positive().optional(),
    idempotency_key: z.string().trim().min(1),
  })
  .strict();

const inboxParamsSchema = z
  .object({
    task_id: z.string().trim().min(1),
    workspace_path: z.string().trim().min(1),
    role_id: z.string().trim().min(1),
    after_delivery_id: z.string().trim().min(1).optional(),
  })
  .strict();

const ackParamsSchema = z
  .object({
    delivery_id: z.string().trim().min(1),
    role_id: z.string().trim().min(1),
  })
  .strict();

const replyParamsSchema = z
  .object({
    source_delivery_id: z.string().trim().min(1),
    from_role_id: z.string().trim().min(1),
    type: messageTypeSchema,
    payload: z.record(z.string(), z.unknown()),
    artifact_refs: z.array(z.string().trim().min(1)).optional(),
    requires_ack: z.boolean(),
    deadline_seconds: z.number().int().positive().optional(),
    idempotency_key: z.string().trim().min(1),
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
          .listMailboxInbox(
            parsed.task_id,
            parsed.workspace_path,
            parsed.role_id,
            parsed.after_delivery_id,
          )
          .then((deliveries) => ({ deliveries })),
      );
    });
    dispatcher.register('mailbox.ack', (params) => {
      const parsed = parseParams(ackParamsSchema, params);
      return this.callWithMailboxError(() =>
        this.service.acknowledgeMailboxDelivery(parsed.delivery_id, parsed.role_id),
      );
    });
    dispatcher.register('mailbox.reply', (params) => {
      const parsed = parseParams(replyParamsSchema, params);
      return this.callWithMailboxError(() =>
        this.service.replyMailboxMessage({
          source_delivery_id: parsed.source_delivery_id,
          from_role_id: parsed.from_role_id,
          type: parsed.type as AgentMessageType,
          payload: { ...parsed.payload },
          ...(parsed.artifact_refs ? { artifact_refs: [...parsed.artifact_refs] } : {}),
          requires_ack: parsed.requires_ack,
          ...(parsed.deadline_seconds !== undefined
            ? { deadline_seconds: parsed.deadline_seconds }
              : {}),
          idempotency_key: parsed.idempotency_key,
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

function toSendInput(input: z.infer<typeof sendParamsSchema>): MailboxSendInput {
  return {
    task_id: input.task_id,
    workspace_path: input.workspace_path,
    thread_id: input.thread_id,
    from_role_id: input.from_role_id,
    to_role_id: input.to_role_id,
    type: input.type as AgentMessageType,
    payload: { ...input.payload },
    ...(input.artifact_refs ? { artifact_refs: [...input.artifact_refs] } : {}),
    requires_ack: input.requires_ack,
    ...(input.deadline_seconds !== undefined
      ? { deadline_seconds: input.deadline_seconds }
        : {}),
    idempotency_key: input.idempotency_key,
  };
}
