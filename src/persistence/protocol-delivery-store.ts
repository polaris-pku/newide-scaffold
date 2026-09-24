import type { ProtocolFrame } from '../core/protocol-frame';
import type {
  CoordinationStateCommit,
  PersistedCoordinationEvent,
} from './coordination-state-store';

export type ProtocolOutboxStatus = 'held' | 'pending' | 'sent' | 'complete' | 'failed';
export type ProtocolInboxStatus = 'received' | 'processing' | 'complete';

export interface ProtocolOutboxRecord {
  id: string;
  protocol: ProtocolFrame['protocol'];
  exchange_id: string;
  task_id: string;
  run_id: string;
  destination: string;
  frame: ProtocolFrame;
  status: ProtocolOutboxStatus;
  attempt: number;
  next_attempt_at: string;
  activated_at: string | null;
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  revision: number;
}

export interface ProtocolInboxKey {
  consumer_id: string;
  protocol: ProtocolFrame['protocol'];
  exchange_id: string;
}

export interface ProtocolInboxRecord extends ProtocolInboxKey {
  task_id: string;
  run_id: string;
  frame: ProtocolFrame;
  status: ProtocolInboxStatus;
  received_at: string;
  completed_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  reply_exchange_id: string | null;
  revision: number;
}

export interface ProtocolJournalRecord {
  seq: number;
  task_id: string;
  run_id: string;
  ts: string;
  kind: 'sap' | 'aap' | 'adp' | 'call';
  id: string;
  causation_id: string | null;
  role_id: string | null;
  event: string;
  status: string;
  summary: string;
  frame: ProtocolFrame | null;
}

export interface EnqueueProtocolOutbox {
  id: string;
  destination: string;
  frame: ProtocolFrame;
  status?: 'held' | 'pending';
  activated_at?: string;
  next_attempt_at?: string;
}

export interface CompleteProtocolInbox {
  key: ProtocolInboxKey;
  lease_owner: string;
  expected_revision: number;
  completed_at: string;
  reply?: EnqueueProtocolOutbox;
}

export interface AppendProtocolCall {
  task_id: string;
  run_id: string;
  call_id: string;
  role_id: string | null;
  event: string;
  status: string;
  summary: string;
  completed_at: string;
}

/** All writes on this port use the same SQLite transaction and connection. */
export interface ProtocolDeliveryTransaction {
  commitState(input: CoordinationStateCommit): PersistedCoordinationEvent[];
  enqueueOutbox(input: EnqueueProtocolOutbox): ProtocolOutboxRecord;
  receiveInbox(input: {
    consumer_id: string;
    frame: ProtocolFrame;
    received_at: string;
  }): { inbox: ProtocolInboxRecord; inserted: boolean };
  completeInbox(input: CompleteProtocolInbox): ProtocolInboxRecord;
  appendCall(input: AppendProtocolCall): ProtocolJournalRecord;
}

export interface ProtocolDeliveryStore {
  withProtocolTransaction<T>(operation: (transaction: ProtocolDeliveryTransaction) => T): T;
  getOutbox(id: string): ProtocolOutboxRecord | undefined;
  getInbox(key: ProtocolInboxKey): ProtocolInboxRecord | undefined;
  listJournal(taskId: string, runId: string, afterSeq?: number): ProtocolJournalRecord[];
  listRecoverableOutbox(now: string): ProtocolOutboxRecord[];
  listRecoverableInbox(now: string): ProtocolInboxRecord[];
  activateOutbox(id: string, expectedRevision: number, at: string): ProtocolOutboxRecord;
  claimOutbox(
    id: string,
    owner: string,
    now: string,
    leaseExpiresAt: string,
    expectedRevision: number,
  ): ProtocolOutboxRecord | undefined;
  renewOutboxLease(
    id: string,
    owner: string,
    expectedRevision: number,
    now: string,
    leaseExpiresAt: string,
  ): ProtocolOutboxRecord;
  markOutboxSent(id: string, owner: string, expectedRevision: number, at: string): ProtocolOutboxRecord;
  retryOutbox(
    id: string,
    owner: string,
    expectedRevision: number,
    now: string,
    nextAttemptAt: string,
  ): ProtocolOutboxRecord;
  failOutbox(id: string, owner: string, expectedRevision: number, at: string): ProtocolOutboxRecord;
  claimInbox(
    key: ProtocolInboxKey,
    owner: string,
    now: string,
    leaseExpiresAt: string,
    expectedRevision: number,
  ): ProtocolInboxRecord | undefined;
  renewInboxLease(
    key: ProtocolInboxKey,
    owner: string,
    expectedRevision: number,
    now: string,
    leaseExpiresAt: string,
  ): ProtocolInboxRecord;
}
