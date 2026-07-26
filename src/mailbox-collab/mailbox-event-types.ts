import type { Timestamp, MessageId, DeliveryId } from '../core';

export type MessageTimeoutAction = 'retry' | 'blocked' | 'failed' | 'waiting_input';

export interface MailboxSentEvent {
  message_id: MessageId;
  delivery_id: DeliveryId;
  recipient_agent_id?: string;
  recipient_role_id?: string;
  requires_ack: boolean;
  deadline_at?: Timestamp;
}

export interface MailboxDeliveryReadEvent {
  delivery_id: DeliveryId;
  message_id: MessageId;
  read_by_agent_id: string;
  read_at: Timestamp;
}

export interface MailboxDeliveryAckedEvent {
  delivery_id: DeliveryId;
  message_id: MessageId;
  acked_by_agent_id: string;
  acked_at: Timestamp;
}

export interface MailboxDeliveryRepliedEvent {
  reply_message_id: MessageId;
  reply_delivery_id: DeliveryId;
  source_delivery_id: DeliveryId;
  source_message_id: MessageId;
  replied_by_agent_id: string;
  replied_at: Timestamp;
}

export interface MailboxDeliveryTimeoutEvent {
  delivery_id: DeliveryId;
  message_id: MessageId;
  recipient_agent_id?: string;
  recipient_role_id?: string;
  action: MessageTimeoutAction;
  timeout_at: Timestamp;
  retry_count: number;
}

export interface MailboxDeliveryFailedEvent {
  delivery_id: DeliveryId;
  message_id: MessageId;
  error_code: string;
  error_message: string;
  failed_at: Timestamp;
}

export type MailboxEvent =
  | MailboxSentEvent
  | MailboxDeliveryReadEvent
  | MailboxDeliveryAckedEvent
  | MailboxDeliveryRepliedEvent
  | MailboxDeliveryTimeoutEvent
  | MailboxDeliveryFailedEvent;

export interface MailboxEventEmitter {
  emitSentEvent(event: MailboxSentEvent): void;
  emitReadEvent(event: MailboxDeliveryReadEvent): void;
  emitAckedEvent(event: MailboxDeliveryAckedEvent): void;
  emitRepliedEvent(event: MailboxDeliveryRepliedEvent): void;
  emitTimeoutEvent(event: MailboxDeliveryTimeoutEvent): void;
  emitFailureEvent(event: MailboxDeliveryFailedEvent): void;
}
