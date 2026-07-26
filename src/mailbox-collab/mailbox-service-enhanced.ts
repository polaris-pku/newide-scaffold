import type { MessageRecipient } from '../core';
import type {
  MailboxReplyInput,
  MailboxSendInput,
  PersistedMailboxDelivery,
  PersistedMailboxEnvelope,
} from '../persistence';
import type { PersistentMailboxService } from '../app/persistent-mailbox-service';
import type {
  MailboxDeliveryTimeoutEvent,
  MailboxDeliveryFailedEvent,
  MailboxSentEvent,
  MailboxDeliveryAckedEvent,
  MailboxDeliveryRepliedEvent,
  MailboxEventEmitter,
} from './mailbox-event-types';
import type { MailboxTimeoutStore } from './mailbox-timeout-store';

export interface TimeoutProcessResult {
  delivery: PersistedMailboxDelivery;
  event: MailboxDeliveryTimeoutEvent;
}

export class MailboxServiceEnhanced {
  private readonly maxRetries: number;
  private readonly eventEmitter?: MailboxEventEmitter;

  constructor(
    private readonly mailboxService: PersistentMailboxService,
    private readonly timeoutStore: MailboxTimeoutStore,
    options: { maxRetries?: number; eventEmitter?: MailboxEventEmitter } = {},
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.eventEmitter = options.eventEmitter;
  }

  async processTimeouts(now: string): Promise<TimeoutProcessResult[]> {
    const timedOutEnvelopes = this.timeoutStore.listTimedOutDeliveries(now);
    const results: TimeoutProcessResult[] = [];

    for (const envelope of timedOutEnvelopes) {
      const delivery = envelope.delivery;
      const retryCount = delivery.retry_count ?? 0;

      let action: 'retry' | 'blocked' | 'failed' | 'waiting_input';
      if (retryCount < this.maxRetries) {
        action = 'retry';
      } else {
        action = 'blocked';
      }

      const updatedDelivery = this.timeoutStore.recordMailboxTimeout(
        delivery.delivery_id,
        now,
        action,
      );

      const event: MailboxDeliveryTimeoutEvent = {
        delivery_id: delivery.delivery_id,
        message_id: delivery.message_id,
        ...(delivery.recipient_agent_id
          ? { recipient_agent_id: delivery.recipient_agent_id }
          : {}),
        ...(delivery.recipient_role_id ? { recipient_role_id: delivery.recipient_role_id } : {}),
        action,
        timeout_at: now,
        retry_count: updatedDelivery.retry_count ?? 0,
      };

      this.eventEmitter?.emitTimeoutEvent(event);

      results.push({ delivery: updatedDelivery, event });
    }

    return results;
  }

  recordFailure(
    deliveryId: string,
    errorCode: string,
    errorMessage: string,
  ): MailboxDeliveryFailedEvent {
    const now = new Date().toISOString();
    const delivery = this.timeoutStore.recordMailboxFailure(
      deliveryId,
      errorCode,
      errorMessage,
    );

    const event: MailboxDeliveryFailedEvent = {
      delivery_id: deliveryId,
      message_id: delivery.message_id,
      error_code: errorCode,
      error_message: errorMessage,
      failed_at: now,
    };

    this.eventEmitter?.emitFailureEvent(event);
    return event;
  }

  emitSentEvent(
    messageId: string,
    delivery: PersistedMailboxDelivery,
  ): MailboxSentEvent {
    const event: MailboxSentEvent = {
      message_id: messageId,
      delivery_id: delivery.delivery_id,
      recipient_agent_id: delivery.recipient_agent_id,
      recipient_role_id: delivery.recipient_role_id,
      requires_ack: !!delivery.requires_ack,
      deadline_at: delivery.deadline_at,
    };

    this.eventEmitter?.emitSentEvent(event);
    return event;
  }

  emitAckedEvent(
    deliveryId: string,
    messageId: string,
    agentId: string,
  ): MailboxDeliveryAckedEvent {
    const now = new Date().toISOString();
    const event: MailboxDeliveryAckedEvent = {
      delivery_id: deliveryId,
      message_id: messageId,
      acked_by_agent_id: agentId,
      acked_at: now,
    };

    this.eventEmitter?.emitAckedEvent(event);
    return event;
  }

  emitRepliedEvent(
    replyMessageId: string,
    replyDeliveryId: string,
    sourceDeliveryId: string,
    sourceMessageId: string,
    agentId: string,
  ): MailboxDeliveryRepliedEvent {
    const now = new Date().toISOString();
    const event: MailboxDeliveryRepliedEvent = {
      reply_message_id: replyMessageId,
      reply_delivery_id: replyDeliveryId,
      source_delivery_id: sourceDeliveryId,
      source_message_id: sourceMessageId,
      replied_by_agent_id: agentId,
      replied_at: now,
    };

    this.eventEmitter?.emitRepliedEvent(event);
    return event;
  }

  async recordRead(deliveryId: string): Promise<void> {
    const now = new Date().toISOString();
    await Promise.resolve(this.timeoutStore.recordMailboxRead(deliveryId, now));
  }
}
