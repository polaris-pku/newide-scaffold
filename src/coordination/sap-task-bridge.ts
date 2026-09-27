import {
  PROTOCOL_VERSION,
  createId,
  sapExecuteCommandSchema,
  sapCancelCommandSchema,
  sapReceiptFrameSchema,
  type SapFrame,
} from '../core';
import type {
  ProtocolDeliveryStore,
  ProtocolDeliveryTransaction,
  ProtocolInboxRecord,
  ProtocolOutboxRecord,
} from '../persistence';

export type SapExecuteFrame = Extract<SapFrame, { command: 'agent.execute' }>;
export type SapCancelFrame = Extract<SapFrame, { command: 'agent.cancel' }>;
export type SapResultFrame = Extract<SapFrame, { result: 'agent.execution_result' }>;

export interface SapExecuteDispatch {
  outbox_id: string;
  destination: string;
  frame: SapExecuteFrame;
}

export interface SapExecutionAdmission {
  should_execute: boolean;
  execute_inbox: ProtocolInboxRecord;
  execute_outbox: ProtocolOutboxRecord;
  lease_owner: string;
}

export interface SapTaskBridgeOptions {
  store: ProtocolDeliveryStore;
  now?: () => string;
  create_id?: (prefix: string) => string;
  lease_duration_ms?: number;
  default_deadline_ms?: number;
}

/**
 * Host-side SAP persistence boundary. It validates P0 frames and maps the
 * in-process Agent call onto the same inbox/outbox semantics used by remote
 * delivery. It does not own Task cursor transitions; TaskProcessor commits
 * those through the same transaction port.
 */
export class SapTaskBridge {
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;
  private readonly leaseDurationMs: number;
  private readonly defaultDeadlineMs: number;

  constructor(private readonly options: SapTaskBridgeOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.create_id ?? createId;
    this.leaseDurationMs = positiveDuration(options.lease_duration_ms, 30 * 60_000);
    this.defaultDeadlineMs = positiveDuration(options.default_deadline_ms, 24 * 60 * 60_000);
  }

  createExecute(input: {
    task_id: string;
    run_id: string;
    role_id: string;
    instruction: string;
    instruction_ref?: string;
    council_seat?: string;
    deadline_at?: string;
    exchange_id?: string;
  }): SapExecuteDispatch {
    const createdAt = this.now();
    const exchangeId = input.exchange_id ?? this.createId('sap_execute');
    const frame = sapExecuteCommandSchema.parse({
      protocol: 'system-agent',
      protocol_version: PROTOCOL_VERSION,
      exchange_id: exchangeId,
      causation_id: null,
      task_id: input.task_id,
      run_id: input.run_id,
      producer: { kind: 'system', role_id: null },
      consumer: { kind: 'agent', role_id: input.role_id },
      attempt: 1,
      created_at: createdAt,
      deadline_at:
        input.deadline_at ?? new Date(Date.parse(createdAt) + this.defaultDeadlineMs).toISOString(),
      command: 'agent.execute',
      council_seat: input.council_seat ?? null,
      instruction: { text: input.instruction, ref: input.instruction_ref ?? null },
    });
    return {
      outbox_id: `outbox_${exchangeId}`,
      destination: input.role_id,
      frame,
    };
  }

  enqueueExecute(
    transaction: ProtocolDeliveryTransaction,
    dispatch: SapExecuteDispatch,
  ): ProtocolOutboxRecord {
    const existing = transaction.getOutbox(dispatch.outbox_id);
    if (existing) {
      if (existing.exchange_id !== dispatch.frame.exchange_id) {
        throw new Error(`SAP outbox ${dispatch.outbox_id} conflicts with another exchange`);
      }
      return existing;
    }
    return transaction.enqueueOutbox({
      id: dispatch.outbox_id,
      destination: dispatch.destination,
      frame: dispatch.frame,
    });
  }

  beginExecute(dispatch: SapExecuteDispatch): SapExecutionAdmission {
    const now = this.now();
    const leaseOwner = `sap-agent:${dispatch.frame.consumer.role_id}:${dispatch.frame.exchange_id}`;
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
      if (existingInbox?.status === 'complete') {
        return {
          should_execute: false,
          execute_inbox: existingInbox,
          execute_outbox: requireOutbox(transaction, dispatch.outbox_id),
          lease_owner: leaseOwner,
        };
      }
      const outbox = requireOutbox(transaction, dispatch.outbox_id);
      const claimedOutbox = transaction.claimOutbox(
        dispatch.outbox_id,
        leaseOwner,
        now,
        leaseExpiresAt,
        outbox.revision,
      );
      if (!claimedOutbox) {
        return {
          should_execute: false,
          execute_inbox:
            existingInbox ??
            transaction.receiveInbox({
              consumer_id: dispatch.destination,
              frame: dispatch.frame,
              received_at: now,
            }).inbox,
          execute_outbox: outbox,
          lease_owner: leaseOwner,
        };
      }
      const received = transaction.receiveInbox({
        consumer_id: dispatch.destination,
        frame: dispatch.frame,
        received_at: now,
      }).inbox;
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
          execute_inbox: received,
          execute_outbox: claimedOutbox,
          lease_owner: leaseOwner,
        };
      }
      return {
        should_execute: true,
        execute_inbox: claimedInbox,
        execute_outbox: transaction.markOutboxSent(
          dispatch.outbox_id,
          leaseOwner,
          claimedOutbox.revision,
          now,
        ),
        lease_owner: leaseOwner,
      };
    });
  }

  createResult(input: {
    execute: SapExecuteFrame;
    status: SapResultFrame['status'];
    summary: string;
    error?: SapResultFrame['error'];
    exchange_id?: string;
  }): SapResultFrame {
    const createdAt = this.now();
    return sapReceiptFrameSchema.parse({
      protocol: 'system-agent',
      protocol_version: PROTOCOL_VERSION,
      exchange_id: input.exchange_id ?? this.createId('sap_result'),
      causation_id: input.execute.exchange_id,
      task_id: input.execute.task_id,
      run_id: input.execute.run_id,
      producer: { kind: 'agent', role_id: input.execute.consumer.role_id },
      consumer: { kind: 'system', role_id: null },
      attempt: 1,
      created_at: createdAt,
      deadline_at: input.execute.deadline_at,
      result: 'agent.execution_result',
      status: input.status,
      summary: input.summary,
      error: input.error ?? null,
    });
  }

  createCancel(input: {
    execute: SapExecuteFrame;
    exchange_id?: string;
  }): SapCancelFrame {
    const createdAt = this.now();
    return sapCancelCommandSchema.parse({
      protocol: 'system-agent',
      protocol_version: PROTOCOL_VERSION,
      exchange_id: input.exchange_id ?? this.createId('sap_cancel'),
      causation_id: input.execute.exchange_id,
      task_id: input.execute.task_id,
      run_id: input.execute.run_id,
      producer: { kind: 'system', role_id: null },
      consumer: { kind: 'agent', role_id: input.execute.consumer.role_id },
      attempt: 1,
      created_at: createdAt,
      deadline_at: input.execute.deadline_at,
      command: 'agent.cancel',
      target_exchange_id: input.execute.exchange_id,
    });
  }
}

function requireOutbox(
  transaction: ProtocolDeliveryTransaction,
  outboxId: string,
): ProtocolOutboxRecord {
  const outbox = transaction.getOutbox(outboxId);
  if (!outbox) throw new Error(`SAP outbox ${outboxId} was not found`);
  return outbox;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error('SAP duration must be positive');
  return value;
}

function minTimestamp(left: string, right: string): string {
  return left <= right ? left : right;
}
