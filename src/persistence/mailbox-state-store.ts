import type {
  AgentMessageType,
  MessageRecipient,
  SchemaVersion,
  Timestamp,
} from '../core';

export type PersistedMailboxDeliveryStatus = 'pending' | 'delivered' | 'acknowledged';

export interface PersistedMailboxError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PersistedMailboxMessage {
  message_id: string;
  thread_id: string;
  from_agent_id: string;
  type: AgentMessageType;
  payload: Record<string, unknown>;
  artifact_refs: string[];
  requires_ack: boolean;
  reply_to_message_id?: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface PersistedMailboxDelivery {
  delivery_id: string;
  message_id: string;
  recipient_agent_id?: string;
  recipient_role_id?: string;
  status: PersistedMailboxDeliveryStatus;
  deadline_at?: Timestamp;
  delivered_at?: Timestamp;
  acknowledged_at?: Timestamp;
  retry_count: number;
  last_error?: PersistedMailboxError;
  last_delivery_event_id?: string;
  replay_cursor?: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface PersistedMailboxEnvelope {
  message: PersistedMailboxMessage;
  delivery: PersistedMailboxDelivery;
}

export interface SaveMailboxReplyInput {
  source_delivery_id: string;
  source_recipient: MessageRecipient;
  message: PersistedMailboxMessage;
  deliveries: PersistedMailboxDelivery[];
  acknowledged_at: Timestamp;
}

export interface SaveMailboxReplyResult {
  source_delivery: PersistedMailboxDelivery;
  reply: {
    message: PersistedMailboxMessage;
    deliveries: PersistedMailboxDelivery[];
  };
}

export interface MailboxStateStore {
  saveMailboxMessage(
    message: PersistedMailboxMessage,
    deliveries: PersistedMailboxDelivery[],
  ): void;
  receiveMailboxInbox(
    recipient: MessageRecipient,
    deliveredAt: Timestamp,
    afterDeliveryId?: string,
  ): PersistedMailboxEnvelope[];
  acknowledgeMailboxDelivery(
    deliveryId: string,
    recipient: MessageRecipient,
    acknowledgedAt: Timestamp,
  ): PersistedMailboxDelivery;
  saveMailboxReply(input: SaveMailboxReplyInput): SaveMailboxReplyResult;
  recordMailboxWakeAttempt(
    deliveryId: string,
    input: { attempted_at: Timestamp; error?: PersistedMailboxError },
  ): PersistedMailboxDelivery;
  getMailboxEnvelope(deliveryId: string): PersistedMailboxEnvelope | undefined;
  listMailboxThread(threadId: string): PersistedMailboxMessage[];
  listReplayableMailboxDeliveries(): PersistedMailboxEnvelope[];
}
