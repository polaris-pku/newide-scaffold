import {
  SCHEMA_VERSION,
  createId,
  type AgentMessageType,
} from '../core';
import type {
  MailboxStateStore,
  PersistedMailboxDelivery,
  PersistedMailboxEnvelope,
  PersistedMailboxError,
  PersistedMailboxMessage,
  MailboxSendPersistenceResult,
  SaveMailboxReplyResult,
} from './mailbox-state-store';
export interface PersistentMailboxServiceOptions {
  now?: () => string;
  createMessageId?: () => string;
  createDeliveryId?: () => string;
}

export interface MailboxSendInput {
  task_id: string;
  workspace_path: string;
  thread_id: string;
  from_role_id: string;
  to_role_id: string;
  type: AgentMessageType;
  payload: Record<string, unknown>;
  artifact_refs?: string[];
  requires_ack: boolean;
  deadline_seconds?: number;
  idempotency_key: string;
}

export interface MailboxSendResult {
  message: PersistedMailboxMessage;
  deliveries: PersistedMailboxDelivery[];
}

export interface MailboxReplyInput
  extends Omit<MailboxSendInput, 'task_id' | 'workspace_path' | 'thread_id' | 'to_role_id'> {
  source_delivery_id: string;
}

export class MailboxValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailboxValidationError';
  }
}

export class MailboxDeliveryNotFoundError extends Error {
  constructor(readonly deliveryId: string) {
    super(`Mailbox delivery ${deliveryId} was not found`);
    this.name = 'MailboxDeliveryNotFoundError';
  }
}

export class MailboxRecipientMismatchError extends Error {
  constructor(readonly deliveryId: string) {
    super(`Mailbox delivery ${deliveryId} belongs to another recipient`);
    this.name = 'MailboxRecipientMismatchError';
  }
}

export class MailboxDeliveryStateError extends Error {
  constructor(
    readonly deliveryId: string,
    readonly status: PersistedMailboxDelivery['status'],
  ) {
    super(`Mailbox delivery ${deliveryId} cannot be handled from ${status}`);
    this.name = 'MailboxDeliveryStateError';
  }
}

export class PersistentMailboxService {
  private readonly now: () => string;
  private readonly createMessageId: () => string;
  private readonly createDeliveryId: () => string;

  constructor(
    private readonly store: MailboxStateStore,
    options: PersistentMailboxServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createMessageId = options.createMessageId ?? (() => createId('message'));
    this.createDeliveryId = options.createDeliveryId ?? (() => createId('delivery'));
  }

  async send(input: MailboxSendInput): Promise<MailboxSendResult> {
    this.validateSend(input);
    const existing = this.store.findMailboxSendByIdempotencyKey(
      input.task_id,
      input.from_role_id,
      input.idempotency_key,
    );
    if (existing) {
      this.assertIdempotentReplay(existing, input);
      return existing;
    }
    const createdAt = this.now();
    const message = this.createMessage(input, createdAt);
    const deliveries = this.createDeliveries(message.message_id, input, createdAt);
    this.store.saveMailboxMessage(message, deliveries);
    return { message, deliveries };
  }

  inbox(
    taskId: string,
    workspacePath: string,
    recipientRoleId: string,
    afterDeliveryId?: string,
  ): PersistedMailboxEnvelope[] {
    requireText(taskId, 'task_id');
    requireText(workspacePath, 'workspace_path');
    requireText(recipientRoleId, 'recipient_role_id');
    return this.store.listMailboxInbox(
      taskId,
      workspacePath,
      recipientRoleId,
      afterDeliveryId,
    );
  }

  markInjected(
    deliveryId: string,
    recipientRoleId: string,
    recipientSessionId: string,
  ): PersistedMailboxDelivery {
    requireText(recipientRoleId, 'recipient_role_id');
    requireText(recipientSessionId, 'recipient_session_id');
    return this.store.markMailboxDeliveryInjected(deliveryId, {
      recipient_role_id: recipientRoleId,
      recipient_session_id: recipientSessionId,
      injected_at: this.now(),
    });
  }

  markFailed(
    deliveryId: string,
    error: PersistedMailboxError,
  ): PersistedMailboxDelivery {
    return this.store.markMailboxDeliveryFailed(deliveryId, {
      failed_at: this.now(),
      error,
    });
  }

  recordDeliveryAttempt(
    deliveryId: string,
    error?: PersistedMailboxError,
  ): PersistedMailboxDelivery {
    return this.store.recordMailboxDeliveryAttempt(deliveryId, {
      attempted_at: this.now(),
      ...(error ? { error } : {}),
    });
  }

  ack(deliveryId: string, recipientRoleId: string): PersistedMailboxDelivery {
    const envelope = this.requireDelivery(deliveryId);
    this.assertRecipient(envelope.delivery, recipientRoleId);
    if (envelope.delivery.status === 'pending') {
      throw new MailboxDeliveryStateError(deliveryId, envelope.delivery.status);
    }
    return this.store.acknowledgeMailboxDelivery(deliveryId, recipientRoleId, this.now());
  }

  async reply(input: MailboxReplyInput): Promise<SaveMailboxReplyResult> {
    const source = this.requireDelivery(input.source_delivery_id);
    this.assertRecipient(source.delivery, input.from_role_id);
    const normalized: MailboxSendInput = {
      ...input,
      task_id: source.message.task_id,
      workspace_path: source.message.workspace_path,
      thread_id: source.message.thread_id,
      to_role_id: source.message.from_role_id,
    };
    this.validateSend(normalized);
    const existing = this.store.findMailboxSendByIdempotencyKey(
      source.message.task_id,
      input.from_role_id,
      input.idempotency_key,
    );
    if (existing) {
      this.assertIdempotentReplay(existing, normalized);
      if (existing.message.reply_to_message_id !== source.message.message_id) {
        throw new MailboxValidationError('idempotency_key belongs to another reply');
      }
      return { source_delivery: source.delivery, reply: existing };
    }
    if (source.delivery.status === 'pending') {
      throw new MailboxDeliveryStateError(input.source_delivery_id, source.delivery.status);
    }
    const createdAt = this.now();
    const message = this.createMessage(normalized, createdAt, source.message.message_id);
    const deliveries = this.createDeliveries(message.message_id, normalized, createdAt);
    const saved = this.store.saveMailboxReply({
      source_delivery_id: input.source_delivery_id,
      source_recipient_role_id: input.from_role_id,
      message,
      deliveries,
      acknowledged_at: createdAt,
    });
    return {
      source_delivery: saved.source_delivery,
      reply: {
        message,
        deliveries,
      },
    };
  }

  async replayPendingDeliveries(): Promise<PersistedMailboxEnvelope[]> {
    return this.store.listReplayableMailboxDeliveries();
  }

  getEnvelope(deliveryId: string): PersistedMailboxEnvelope {
    return this.requireDelivery(deliveryId);
  }

  findLatestSession(
    taskId: string,
    workspacePath: string,
    recipientRoleId: string,
  ): string | undefined {
    return this.store.findLatestMailboxSession(taskId, workspacePath, recipientRoleId);
  }

  findReplyDelivery(
    sourceDeliveryId: string,
    recipientRoleId: string,
  ): PersistedMailboxEnvelope | undefined {
    const source = this.requireDelivery(sourceDeliveryId);
    return this.store
      .listMailboxInbox(
        source.message.task_id,
        source.message.workspace_path,
        recipientRoleId,
      )
      .find(
        (candidate) =>
          candidate.message.reply_to_message_id === source.message.message_id &&
          candidate.message.thread_id === source.message.thread_id,
      );
  }

  private validateSend(input: Omit<MailboxSendInput, 'thread_id'> & { thread_id?: string }): void {
    if (input.requires_ack && input.deadline_seconds === undefined) {
      throw new MailboxValidationError('requires_ack messages must set deadline_seconds');
    }
    if (input.deadline_seconds !== undefined && input.deadline_seconds <= 0) {
      throw new MailboxValidationError('deadline_seconds must be positive');
    }
    requireText(input.task_id, 'task_id');
    requireText(input.workspace_path, 'workspace_path');
    requireText(input.from_role_id, 'from_role_id');
    requireText(input.to_role_id, 'to_role_id');
    requireText(input.idempotency_key, 'idempotency_key');
    if (input.thread_id !== undefined) requireText(input.thread_id, 'thread_id');
    if (input.from_role_id === input.to_role_id) {
      throw new MailboxValidationError('Mailbox sender and recipient must be different roles');
    }
  }

  private createMessage(
    input: MailboxSendInput,
    createdAt: string,
    replyToMessageId?: string,
  ): PersistedMailboxMessage {
    return {
      message_id: this.createMessageId(),
      task_id: input.task_id,
      workspace_path: input.workspace_path,
      thread_id: input.thread_id,
      from_role_id: input.from_role_id,
      type: input.type,
      payload: { ...input.payload },
      artifact_refs: [...(input.artifact_refs ?? [])],
      requires_ack: input.requires_ack,
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      idempotency_key: input.idempotency_key,
      created_at: createdAt,
      schema_version: SCHEMA_VERSION,
    };
  }

  private createDeliveries(
    messageId: string,
    input: Pick<
      MailboxSendInput,
      'task_id' | 'workspace_path' | 'to_role_id' | 'deadline_seconds'
    >,
    createdAt: string,
  ): PersistedMailboxDelivery[] {
    const deadlineAt = input.deadline_seconds
      ? new Date(Date.parse(createdAt) + input.deadline_seconds * 1000).toISOString()
      : undefined;
    return [{
      delivery_id: this.createDeliveryId(),
      message_id: messageId,
      task_id: input.task_id,
      workspace_path: input.workspace_path,
      recipient_role_id: input.to_role_id,
      status: 'pending',
      ...(deadlineAt ? { deadline_at: deadlineAt } : {}),
      retry_count: 0,
      created_at: createdAt,
      updated_at: createdAt,
      schema_version: SCHEMA_VERSION,
    }];
  }

  private requireDelivery(deliveryId: string): PersistedMailboxEnvelope {
    const envelope = this.store.getMailboxEnvelope(deliveryId);
    if (!envelope) throw new MailboxDeliveryNotFoundError(deliveryId);
    return envelope;
  }

  private assertRecipient(
    delivery: PersistedMailboxDelivery,
    recipientRoleId: string,
  ): void {
    if (delivery.recipient_role_id !== recipientRoleId) {
      throw new MailboxRecipientMismatchError(delivery.delivery_id);
    }
  }

  private assertIdempotentReplay(
    existing: MailboxSendPersistenceResult,
    input: Omit<MailboxSendInput, 'thread_id'> & { thread_id?: string },
  ): void {
    const delivery = existing.deliveries[0];
    const expectedDeadline = input.deadline_seconds
      ? new Date(
          Date.parse(existing.message.created_at) + input.deadline_seconds * 1000,
        ).toISOString()
      : undefined;
    if (
      existing.message.workspace_path !== input.workspace_path ||
      (input.thread_id !== undefined && existing.message.thread_id !== input.thread_id) ||
      existing.message.from_role_id !== input.from_role_id ||
      existing.message.type !== input.type ||
      JSON.stringify(existing.message.payload) !== JSON.stringify(input.payload) ||
      JSON.stringify(existing.message.artifact_refs) !==
        JSON.stringify(input.artifact_refs ?? []) ||
      existing.message.requires_ack !== input.requires_ack ||
      delivery?.recipient_role_id !== input.to_role_id ||
      delivery?.deadline_at !== expectedDeadline
    ) {
      throw new MailboxValidationError('idempotency_key was reused with different content');
    }
  }
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new MailboxValidationError(`${field} is required`);
}
