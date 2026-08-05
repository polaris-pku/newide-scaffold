/** Mailbox-owned persistence port. SQLite remains an application adapter. */
import type { AgentMessageType, SchemaVersion, Timestamp } from '../core';

/** The only business semantics exposed to an Agent through Mailbox. */
export type MailboxMessageKind = 'request' | 'notice';

export type PersistedMailboxDeliveryStatus =
  | 'pending'
  | 'injected'
  | 'acknowledged'
  | 'failed';

export interface PersistedMailboxError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PersistedMailboxMessage {
  message_id: string;
  task_id: string;
  workspace_path: string;
  thread_id: string;
  from_role_id: string;
  /** Canonical Agent-facing message kind. Optional only for pre-contract rows. */
  kind?: MailboxMessageKind;
  /** Canonical human-readable message body. Optional only for pre-contract rows. */
  content?: string;
  /** Legacy fields retained for Host RPC and historical audit compatibility. */
  type: AgentMessageType;
  payload: Record<string, unknown>;
  artifact_refs: string[];
  requires_ack: boolean;
  reply_to_message_id?: string;
  idempotency_key: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface PersistedMailboxDelivery {
  delivery_id: string;
  message_id: string;
  task_id: string;
  workspace_path: string;
  recipient_role_id: string;
  recipient_session_id?: string;
  status: PersistedMailboxDeliveryStatus;
  deadline_at?: Timestamp;
  injected_at?: Timestamp;
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
  source_recipient_role_id: string;
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
  listMailboxInbox(
    taskId: string,
    workspacePath: string,
    recipientRoleId: string,
    afterDeliveryId?: string,
  ): PersistedMailboxEnvelope[];
  markMailboxDeliveryInjected(
    deliveryId: string,
    input: {
      recipient_role_id: string;
      recipient_session_id: string;
      injected_at: Timestamp;
    },
  ): PersistedMailboxDelivery;
  markMailboxDeliveryFailed(
    deliveryId: string,
    input: { failed_at: Timestamp; error: PersistedMailboxError },
  ): PersistedMailboxDelivery;
  acknowledgeMailboxDelivery(
    deliveryId: string,
    recipientRoleId: string,
    acknowledgedAt: Timestamp,
  ): PersistedMailboxDelivery;
  saveMailboxReply(input: SaveMailboxReplyInput): SaveMailboxReplyResult;
  recordMailboxDeliveryAttempt(
    deliveryId: string,
    input: { attempted_at: Timestamp; error?: PersistedMailboxError },
  ): PersistedMailboxDelivery;
  getMailboxEnvelope(deliveryId: string): PersistedMailboxEnvelope | undefined;
  findLatestMailboxSession(
    taskId: string,
    workspacePath: string,
    recipientRoleId: string,
  ): string | undefined;
  listMailboxThread(threadId: string): PersistedMailboxMessage[];
  listReplayableMailboxDeliveries(scope?: {
    task_id?: string;
    workspace_path?: string;
    recipient_role_id?: string;
  }): PersistedMailboxEnvelope[];
  /** Latest durable delivery position for a Task/workspace checkpoint. */
  getMailboxHighWatermark(
    taskId: string,
    workspacePath: string,
  ): { created_at: Timestamp; delivery_id: string } | undefined;
  /** Pending/injected deliveries committed after a checkpoint watermark. */
  listMailboxDeliveriesAfter(
    taskId: string,
    workspacePath: string,
    after?: { created_at: Timestamp; delivery_id: string },
  ): PersistedMailboxEnvelope[];
  findMailboxSendByIdempotencyKey(
    taskId: string,
    fromRoleId: string,
    idempotencyKey: string,
  ): MailboxSendPersistenceResult | undefined;
}

export interface MailboxSendPersistenceResult {
  message: PersistedMailboxMessage;
  deliveries: PersistedMailboxDelivery[];
}
