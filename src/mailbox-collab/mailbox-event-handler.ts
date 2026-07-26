import type { EventStore } from '../coordinator/event-store';
import type {
  MailboxDeliveryAckedEvent,
  MailboxDeliveryFailedEvent,
  MailboxDeliveryRepliedEvent,
  MailboxDeliveryTimeoutEvent,
  MailboxSentEvent,
} from './mailbox-event-types';

export class MailboxEventHandler {
  constructor(private readonly eventStore: EventStore) {}

  onMailboxSent(event: MailboxSentEvent): void {
    this.eventStore.append({
      event_type: 'mailbox.sent',
      subject_id: event.delivery_id,
      payload: {
        message_id: event.message_id,
        delivery_id: event.delivery_id,
        recipient_agent_id: event.recipient_agent_id,
        recipient_role_id: event.recipient_role_id,
        requires_ack: event.requires_ack,
        deadline_at: event.deadline_at,
      },
    });
  }

  onMailboxAcked(event: MailboxDeliveryAckedEvent): void {
    this.eventStore.append({
      event_type: 'mailbox.delivery_acked',
      subject_id: event.delivery_id,
      payload: {
        delivery_id: event.delivery_id,
        message_id: event.message_id,
        acked_by_agent_id: event.acked_by_agent_id,
        acked_at: event.acked_at,
      },
    });
  }

  onMailboxReplied(event: MailboxDeliveryRepliedEvent): void {
    this.eventStore.append({
      event_type: 'mailbox.delivery_replied',
      subject_id: event.reply_delivery_id,
      payload: {
        reply_message_id: event.reply_message_id,
        reply_delivery_id: event.reply_delivery_id,
        source_delivery_id: event.source_delivery_id,
        source_message_id: event.source_message_id,
        replied_by_agent_id: event.replied_by_agent_id,
        replied_at: event.replied_at,
      },
    });
  }

  onMailboxTimeout(event: MailboxDeliveryTimeoutEvent): void {
    this.eventStore.append({
      event_type: 'mailbox.delivery_timeout',
      subject_id: event.delivery_id,
      payload: {
        delivery_id: event.delivery_id,
        message_id: event.message_id,
        recipient_agent_id: event.recipient_agent_id,
        recipient_role_id: event.recipient_role_id,
        action: event.action,
        timeout_at: event.timeout_at,
        retry_count: event.retry_count,
      },
    });
  }

  onMailboxFailed(event: MailboxDeliveryFailedEvent): void {
    this.eventStore.append({
      event_type: 'mailbox.delivery_failed',
      subject_id: event.delivery_id,
      payload: {
        delivery_id: event.delivery_id,
        message_id: event.message_id,
        error_code: event.error_code,
        error_message: event.error_message,
        failed_at: event.failed_at,
      },
    });
  }
}
