import {
  SCHEMA_VERSION,
  createId,
  type AgentMessageType,
  type MessageRecipient,
} from '../core';
import type {
  MailboxStateStore,
  PersistedMailboxDelivery,
  PersistedMailboxEnvelope,
  PersistedMailboxError,
  PersistedMailboxMessage,
  SaveMailboxReplyResult,
} from '../persistence';
import type { AgentMailboxWakePort } from '../protocol/agent-mailbox-wake';

export interface PersistentMailboxServiceOptions {
  now?: () => string;
  createMessageId?: () => string;
  createDeliveryId?: () => string;
}

export interface MailboxSendInput {
  thread_id: string;
  from_agent_id: string;
  to: MessageRecipient[];
  type: AgentMessageType;
  payload: Record<string, unknown>;
  artifact_refs?: string[];
  requires_ack: boolean;
  deadline_seconds?: number;
}

export interface MailboxSendResult {
  message: PersistedMailboxMessage;
  deliveries: PersistedMailboxDelivery[];
}

export interface MailboxReplyInput extends Omit<MailboxSendInput, 'thread_id'> {
  source_delivery_id: string;
  source_recipient: MessageRecipient;
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
    private readonly wakePort: AgentMailboxWakePort,
    options: PersistentMailboxServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createMessageId = options.createMessageId ?? (() => createId('message'));
    this.createDeliveryId = options.createDeliveryId ?? (() => createId('delivery'));
  }

  async send(input: MailboxSendInput): Promise<MailboxSendResult> {
    this.validateSend(input);
    const createdAt = this.now();
    const message = this.createMessage(input, createdAt);
    const deliveries = this.createDeliveries(message.message_id, input, createdAt);
    this.store.saveMailboxMessage(message, deliveries);
    return { message, deliveries: await this.wakeDeliveries(message, deliveries) };
  }

  inbox(recipient: MessageRecipient, afterDeliveryId?: string): PersistedMailboxEnvelope[] {
    validateRecipient(recipient);
    return this.store.receiveMailboxInbox(recipient, this.now(), afterDeliveryId);
  }

  ack(deliveryId: string, recipient: MessageRecipient): PersistedMailboxDelivery {
    const envelope = this.requireDelivery(deliveryId);
    this.assertRecipient(envelope.delivery, recipient);
    if (envelope.delivery.status === 'pending') {
      throw new MailboxDeliveryStateError(deliveryId, envelope.delivery.status);
    }
    return this.store.acknowledgeMailboxDelivery(deliveryId, recipient, this.now());
  }

  async reply(input: MailboxReplyInput): Promise<SaveMailboxReplyResult> {
    this.validateSend(input);
    const source = this.requireDelivery(input.source_delivery_id);
    this.assertRecipient(source.delivery, input.source_recipient);
    if (source.delivery.status === 'pending') {
      throw new MailboxDeliveryStateError(input.source_delivery_id, source.delivery.status);
    }
    const createdAt = this.now();
    const message = this.createMessage(
      { ...input, thread_id: source.message.thread_id },
      createdAt,
      source.message.message_id,
    );
    const deliveries = this.createDeliveries(message.message_id, input, createdAt);
    const saved = this.store.saveMailboxReply({
      source_delivery_id: input.source_delivery_id,
      source_recipient: input.source_recipient,
      message,
      deliveries,
      acknowledged_at: createdAt,
    });
    return {
      source_delivery: saved.source_delivery,
      reply: {
        message,
        deliveries: await this.wakeDeliveries(message, deliveries),
      },
    };
  }

  async replayPendingDeliveries(): Promise<PersistedMailboxEnvelope[]> {
    const replayable = this.store.listReplayableMailboxDeliveries();
    const deliveries = await this.wakeEnvelopes(replayable);
    return replayable.map((envelope, index) => ({
      message: envelope.message,
      delivery: deliveries[index] ?? envelope.delivery,
    }));
  }

  private validateSend(input: Omit<MailboxSendInput, 'thread_id'> & { thread_id?: string }): void {
    if (input.requires_ack && input.deadline_seconds === undefined) {
      throw new MailboxValidationError('requires_ack messages must set deadline_seconds');
    }
    if (input.deadline_seconds !== undefined && input.deadline_seconds <= 0) {
      throw new MailboxValidationError('deadline_seconds must be positive');
    }
    if (input.to.length === 0) {
      throw new MailboxValidationError('messages must have at least one recipient');
    }
    const recipients = new Set<string>();
    for (const recipient of input.to) {
      validateRecipient(recipient);
      const key = recipientKey(recipient);
      if (recipients.has(key)) throw new MailboxValidationError(`Duplicate recipient ${key}`);
      recipients.add(key);
    }
  }

  private createMessage(
    input: MailboxSendInput,
    createdAt: string,
    replyToMessageId?: string,
  ): PersistedMailboxMessage {
    return {
      message_id: this.createMessageId(),
      thread_id: input.thread_id,
      from_agent_id: input.from_agent_id,
      type: input.type,
      payload: { ...input.payload },
      artifact_refs: [...(input.artifact_refs ?? [])],
      requires_ack: input.requires_ack,
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      created_at: createdAt,
      schema_version: SCHEMA_VERSION,
    };
  }

  private createDeliveries(
    messageId: string,
    input: Pick<MailboxSendInput, 'to' | 'deadline_seconds'>,
    createdAt: string,
  ): PersistedMailboxDelivery[] {
    const deadlineAt = input.deadline_seconds
      ? new Date(Date.parse(createdAt) + input.deadline_seconds * 1000).toISOString()
      : undefined;
    return input.to.map((recipient) => ({
      delivery_id: this.createDeliveryId(),
      message_id: messageId,
      ...(recipient.agent_id ? { recipient_agent_id: recipient.agent_id } : {}),
      ...(recipient.role_id ? { recipient_role_id: recipient.role_id } : {}),
      status: 'pending',
      ...(deadlineAt ? { deadline_at: deadlineAt } : {}),
      retry_count: 0,
      created_at: createdAt,
      updated_at: createdAt,
      schema_version: SCHEMA_VERSION,
    }));
  }

  private async wakeDeliveries(
    message: PersistedMailboxMessage,
    deliveries: PersistedMailboxDelivery[],
  ): Promise<PersistedMailboxDelivery[]> {
    return this.wakeEnvelopes(deliveries.map((delivery) => ({ message, delivery })));
  }

  private async wakeEnvelopes(
    envelopes: PersistedMailboxEnvelope[],
  ): Promise<PersistedMailboxDelivery[]> {
    const results: PersistedMailboxDelivery[] = [];
    for (const { message, delivery } of envelopes) {
      let error: PersistedMailboxError | undefined;
      try {
        await this.wakePort.wakeAgent({
          contract_version: 'agent-mailbox-wake.v1',
          message_id: message.message_id,
          delivery_id: delivery.delivery_id,
          thread_id: message.thread_id,
          ...(delivery.recipient_agent_id
            ? { recipient_agent_id: delivery.recipient_agent_id }
            : {}),
          ...(delivery.recipient_role_id
            ? { recipient_role_id: delivery.recipient_role_id }
            : {}),
          schema_version: SCHEMA_VERSION,
        });
      } catch (cause) {
        error = {
          code: 'AGENT_WAKE_FAILED',
          message: cause instanceof Error ? cause.message : String(cause),
        };
      }
      results.push(
        this.store.recordMailboxWakeAttempt(delivery.delivery_id, {
          attempted_at: this.now(),
          ...(error ? { error } : {}),
        }),
      );
    }
    return results;
  }

  private requireDelivery(deliveryId: string): PersistedMailboxEnvelope {
    const envelope = this.store.getMailboxEnvelope(deliveryId);
    if (!envelope) throw new MailboxDeliveryNotFoundError(deliveryId);
    return envelope;
  }

  private assertRecipient(
    delivery: PersistedMailboxDelivery,
    recipient: MessageRecipient,
  ): void {
    validateRecipient(recipient);
    if (
      (recipient.agent_id && delivery.recipient_agent_id !== recipient.agent_id) ||
      (recipient.role_id && delivery.recipient_role_id !== recipient.role_id)
    ) {
      throw new MailboxRecipientMismatchError(delivery.delivery_id);
    }
  }
}

function validateRecipient(recipient: MessageRecipient): void {
  const count = Number(Boolean(recipient.agent_id)) + Number(Boolean(recipient.role_id));
  if (count !== 1) {
    throw new MailboxValidationError(
      'message recipients must set exactly one of agent_id or role_id',
    );
  }
}

function recipientKey(recipient: MessageRecipient): string {
  return recipient.agent_id ? `agent:${recipient.agent_id}` : `role:${recipient.role_id ?? ''}`;
}
