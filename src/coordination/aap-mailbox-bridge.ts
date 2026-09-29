import {
  AAP_PROTOCOL,
  PROTOCOL_VERSION,
  aapAskCommandSchema,
  aapReplyFrameSchema,
  createId,
  type AapFrame,
} from '../core';
import type {
  CoordinationStateCommit,
  PersistedCoordinationEvent,
  ProtocolDeliveryStore,
  ProtocolDeliveryTransaction,
  ProtocolInboxRecord,
  ProtocolOutboxRecord,
} from '../persistence';

export type AapAskFrame = Extract<AapFrame, { command: 'agent.ask' }>;
export type AapReplyFrame = Extract<AapFrame, { result: 'agent.reply' }>;

/** A durable AAP question is the protocol view of one Mailbox request. */
export interface AapAskDispatch {
  outbox_id: string;
  destination: string;
  message_id: string;
  delivery_id: string;
  frame: AapAskFrame;
}

export interface AapAskAdmission {
  should_execute: boolean;
  ask_inbox: ProtocolInboxRecord;
  ask_outbox: ProtocolOutboxRecord;
  lease_owner: string;
}

export type AapReplyDisposition = 'accepted' | 'duplicate' | 'late';

export interface AapMailboxBridgeOptions {
  store: ProtocolDeliveryStore;
  now?: () => string;
  create_id?: (prefix: string) => string;
  lease_duration_ms?: number;
  default_deadline_ms?: number;
}

/**
 * System-side AAP adapter for the existing persistent Mailbox.
 *
 * Mailbox owns message/thread ids. AAP owns exchange ids and delivery
 * idempotency. The adapter is the only place that maps the two; no Mailbox
 * implementation detail is placed in an AAP frame.
 */
export class AapMailboxBridge {
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;
  private readonly leaseDurationMs: number;
  private readonly defaultDeadlineMs: number;

  constructor(private readonly options: AapMailboxBridgeOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.create_id ?? createId;
    this.leaseDurationMs = positiveDuration(options.lease_duration_ms, 30 * 60_000);
    this.defaultDeadlineMs = positiveDuration(options.default_deadline_ms, 10 * 60_000);
  }

  createAsk(input: {
    task_id: string;
    run_id: string;
    from_role_id: string;
    to_role_id: string;
    message_id: string;
    delivery_id: string;
    content: string;
    deadline_at?: string;
    causation_id?: string | null;
    exchange_id?: string;
  }): AapAskDispatch {
    const createdAt = this.now();
    const exchangeId = input.exchange_id ?? this.createId('aap_ask');
    const frame = aapAskCommandSchema.parse({
      protocol: AAP_PROTOCOL,
      protocol_version: PROTOCOL_VERSION,
      exchange_id: exchangeId,
      causation_id: input.causation_id ?? null,
      task_id: input.task_id,
      run_id: input.run_id,
      producer: { kind: 'agent', role_id: input.from_role_id },
      consumer: { kind: 'agent', role_id: input.to_role_id },
      attempt: 1,
      created_at: createdAt,
      deadline_at:
        input.deadline_at ??
        new Date(Date.parse(createdAt) + this.defaultDeadlineMs).toISOString(),
      command: 'agent.ask',
      instruction: { text: input.content, ref: null },
    });
    return {
      outbox_id: `outbox_${exchangeId}`,
      destination: input.to_role_id,
      message_id: input.message_id,
      delivery_id: input.delivery_id,
      frame,
    };
  }

  /** Commit Task mailbox_wait and activate its AAP outbox atomically. */
  commitWait(
    state: CoordinationStateCommit,
    dispatch: AapAskDispatch,
  ): PersistedCoordinationEvent[] {
    return this.options.store.withProtocolTransaction((transaction) => {
      const events = transaction.commitState(state);
      const outbox = this.enqueueAsk(transaction, dispatch);
      if (outbox.status === 'held' && outbox.activated_at === null) {
        transaction.activateOutbox(outbox.id, outbox.revision, dispatch.frame.created_at);
      }
      return events;
    });
  }

  enqueueAsk(
    transaction: ProtocolDeliveryTransaction,
    dispatch: AapAskDispatch,
  ): ProtocolOutboxRecord {
    const existing = transaction.getOutbox(dispatch.outbox_id);
    if (existing) {
      if (existing.exchange_id !== dispatch.frame.exchange_id) {
        throw new Error(`AAP outbox ${dispatch.outbox_id} conflicts with another exchange`);
      }
      return existing;
    }
    return transaction.enqueueOutbox({
      id: dispatch.outbox_id,
      destination: dispatch.destination,
      frame: dispatch.frame,
      status: 'held',
    });
  }

  persistAsk(dispatch: AapAskDispatch): ProtocolOutboxRecord {
    return this.options.store.withProtocolTransaction((transaction) => {
      const outbox = this.enqueueAsk(transaction, dispatch);
      if (outbox.status === 'held' && outbox.activated_at === null) {
        return transaction.activateOutbox(outbox.id, outbox.revision, dispatch.frame.created_at);
      }
      return outbox;
    });
  }

  /** Admit one question exactly once and lease it for the recipient Agent. */
  beginAsk(dispatch: AapAskDispatch): AapAskAdmission {
    const now = this.now();
    const leaseOwner = `aap-agent:${dispatch.destination}:${dispatch.frame.exchange_id}`;
    const leaseExpiresAt = minTimestamp(
      new Date(Date.parse(now) + this.leaseDurationMs).toISOString(),
      dispatch.frame.deadline_at,
    );
    return this.options.store.withProtocolTransaction((transaction) => {
      const existingInbox = transaction.getInbox({
        consumer_id: dispatch.destination,
        protocol: dispatch.frame.protocol,
        exchange_id: dispatch.frame.exchange_id,
      });
      const outbox = requireOutbox(transaction, dispatch.outbox_id);
      if (existingInbox?.status === 'complete') {
        return {
          should_execute: false,
          ask_inbox: existingInbox,
          ask_outbox: outbox,
          lease_owner: leaseOwner,
        };
      }
      if (existingInbox) {
        const reclaimed = transaction.claimInbox(
          {
            consumer_id: existingInbox.consumer_id,
            protocol: existingInbox.protocol,
            exchange_id: existingInbox.exchange_id,
          },
          leaseOwner,
          now,
          leaseExpiresAt,
          existingInbox.revision,
        );
        return {
          should_execute: reclaimed !== undefined,
          ask_inbox: reclaimed ?? existingInbox,
          ask_outbox: outbox,
          lease_owner: leaseOwner,
        };
      }
      const claimedOutbox = transaction.claimOutbox(
        dispatch.outbox_id,
        leaseOwner,
        now,
        leaseExpiresAt,
        outbox.revision,
      );
      const received = transaction.receiveInbox({
        consumer_id: dispatch.destination,
        frame: dispatch.frame,
        received_at: now,
      }).inbox;
      // A crash can leave the outbox marked sent before the receiver inbox is
      // recorded. Sent-without-inbox is therefore recoverable, not complete.
      if (!claimedOutbox && outbox.status !== 'sent') {
        return {
          should_execute: false,
          ask_inbox: received,
          ask_outbox: outbox,
          lease_owner: leaseOwner,
        };
      }
      const claimedInbox = transaction.claimInbox(
        {
          consumer_id: received.consumer_id,
          protocol: received.protocol,
          exchange_id: received.exchange_id,
        },
        leaseOwner,
        now,
        leaseExpiresAt,
        received.revision,
      );
      if (!claimedInbox) {
        return {
          should_execute: false,
          ask_inbox: received,
          ask_outbox: claimedOutbox ?? outbox,
          lease_owner: leaseOwner,
        };
      }
      return {
        should_execute: true,
        ask_inbox: claimedInbox,
        ask_outbox: claimedOutbox
          ? transaction.markOutboxSent(
              dispatch.outbox_id,
              leaseOwner,
              claimedOutbox.revision,
              now,
            )
          : outbox,
        lease_owner: leaseOwner,
      };
    });
  }

  createReply(input: {
    ask: AapAskFrame;
    status: AapReplyFrame['status'];
    summary: string;
    error?: AapReplyFrame['error'];
    exchange_id?: string;
  }): AapReplyFrame {
    const createdAt = this.now();
    return aapReplyFrameSchema.parse({
      protocol: AAP_PROTOCOL,
      protocol_version: PROTOCOL_VERSION,
      exchange_id: input.exchange_id ?? this.createId('aap_reply'),
      causation_id: input.ask.exchange_id,
      task_id: input.ask.task_id,
      run_id: input.ask.run_id,
      producer: { kind: 'agent', role_id: input.ask.consumer.role_id },
      consumer: { kind: 'agent', role_id: input.ask.producer.role_id },
      attempt: 1,
      created_at: createdAt,
      deadline_at: input.ask.deadline_at,
      result: 'agent.reply',
      status: input.status,
      summary: input.summary,
      error: input.error ?? null,
    });
  }

  acceptReply(admission: AapAskAdmission, reply: AapReplyFrame): AapReplyDisposition {
    return this.options.store.withProtocolTransaction((transaction) => {
      const disposition = classifyReply(transaction, admission, reply);
      if (disposition === 'accepted') completeReply(transaction, admission, reply, this.leaseDurationMs);
      if (disposition === 'late') recordLateReply(transaction, reply, this.leaseDurationMs);
      return disposition;
    });
  }
}

function classifyReply(
  transaction: ProtocolDeliveryTransaction,
  admission: AapAskAdmission,
  reply: AapReplyFrame,
): AapReplyDisposition {
  if (reply.causation_id !== admission.ask_inbox.exchange_id) {
    throw new Error('AAP reply does not belong to the admitted ask exchange');
  }
  const current = transaction.getInbox({
    consumer_id: admission.ask_inbox.consumer_id,
    protocol: admission.ask_inbox.protocol,
    exchange_id: admission.ask_inbox.exchange_id,
  });
  if (current?.status === 'complete') {
    return current.reply_exchange_id === reply.exchange_id ? 'duplicate' : 'late';
  }
  return reply.created_at > admission.ask_inbox.frame.deadline_at ? 'late' : 'accepted';
}

function completeReply(
  transaction: ProtocolDeliveryTransaction,
  admission: AapAskAdmission,
  reply: AapReplyFrame,
  leaseDurationMs: number,
): void {
  transaction.completeInbox({
    key: {
      consumer_id: admission.ask_inbox.consumer_id,
      protocol: admission.ask_inbox.protocol,
      exchange_id: admission.ask_inbox.exchange_id,
    },
    lease_owner: admission.lease_owner,
    expected_revision: admission.ask_inbox.revision,
    completed_at: reply.created_at,
    reply: {
      id: `outbox_${reply.exchange_id}`,
      destination: reply.consumer.role_id ?? 'system',
      frame: reply,
    },
  });
  deliverReplyToSystem(transaction, reply, leaseDurationMs);
}

function recordLateReply(
  transaction: ProtocolDeliveryTransaction,
  reply: AapReplyFrame,
  leaseDurationMs: number,
): void {
  const outboxId = `outbox_${reply.exchange_id}`;
  if (!transaction.getOutbox(outboxId)) {
    transaction.enqueueOutbox({ id: outboxId, destination: 'system', frame: reply });
  }
  deliverReplyToSystem(transaction, reply, leaseDurationMs);
}

function deliverReplyToSystem(
  transaction: ProtocolDeliveryTransaction,
  reply: AapReplyFrame,
  leaseDurationMs: number,
): void {
  const outbox = requireOutbox(transaction, `outbox_${reply.exchange_id}`);
  const owner = `aap-system:${reply.exchange_id}`;
  const now = reply.created_at;
  const expires = new Date(Date.parse(now) + leaseDurationMs).toISOString();
  const claimed = outbox.status === 'pending'
    ? transaction.claimOutbox(outbox.id, owner, now, expires, outbox.revision)
    : outbox;
  if (claimed && claimed.status === 'pending') {
    transaction.markOutboxSent(claimed.id, owner, claimed.revision, now);
  }
  const systemInbox = transaction.receiveInbox({
    consumer_id: 'system',
    frame: reply,
    received_at: now,
  }).inbox;
  if (systemInbox.status === 'complete') return;
  const claimedInbox = transaction.claimInbox(
    { consumer_id: systemInbox.consumer_id, protocol: systemInbox.protocol, exchange_id: systemInbox.exchange_id },
    owner,
    now,
    expires,
    systemInbox.revision,
  );
  if (!claimedInbox) return;
  transaction.completeInbox({
    key: { consumer_id: claimedInbox.consumer_id, protocol: claimedInbox.protocol, exchange_id: claimedInbox.exchange_id },
    lease_owner: owner,
    expected_revision: claimedInbox.revision,
    completed_at: now,
  });
}

function requireOutbox(transaction: ProtocolDeliveryTransaction, id: string): ProtocolOutboxRecord {
  const record = transaction.getOutbox(id);
  if (!record) throw new Error(`AAP outbox ${id} was not found`);
  return record;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function minTimestamp(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}
