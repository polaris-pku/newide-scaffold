import type { DatabaseSync } from 'node:sqlite';
import { protocolFrameSchema, type ProtocolFrame } from '../core/protocol-frame';
import type {
  AppendProtocolCall,
  CompleteProtocolInbox,
  EnqueueProtocolOutbox,
  ProtocolInboxKey,
  ProtocolInboxRecord,
  ProtocolJournalRecord,
  ProtocolOutboxRecord,
} from './protocol-delivery-store';

export function migrateProtocolDelivery(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      protocol TEXT NOT NULL,
      exchange_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      destination TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('held', 'pending', 'sent', 'complete', 'failed')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      next_attempt_at TEXT NOT NULL,
      activated_at TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      completed_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      revision INTEGER NOT NULL CHECK (revision > 0),
      UNIQUE(protocol, exchange_id)
    );
    CREATE INDEX IF NOT EXISTS outbox_recovery
      ON outbox(status, next_attempt_at, lease_expires_at);
    CREATE INDEX IF NOT EXISTS outbox_task
      ON outbox(task_id, run_id, created_at);

    CREATE TABLE IF NOT EXISTS inbox (
      consumer_id TEXT NOT NULL,
      protocol TEXT NOT NULL,
      exchange_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'complete')),
      received_at TEXT NOT NULL,
      completed_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      reply_exchange_id TEXT,
      revision INTEGER NOT NULL CHECK (revision > 0),
      PRIMARY KEY (consumer_id, protocol, exchange_id)
    );
    CREATE INDEX IF NOT EXISTS inbox_recovery
      ON inbox(status, lease_expires_at, received_at);
    CREATE INDEX IF NOT EXISTS inbox_task
      ON inbox(task_id, run_id, received_at);

    CREATE TABLE IF NOT EXISTS journal (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('sap', 'aap', 'adp', 'call')),
      id TEXT NOT NULL,
      causation_id TEXT,
      role_id TEXT,
      event TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT,
      CHECK (kind != 'call' OR (causation_id IS NULL AND payload_json IS NULL)),
      CHECK (kind = 'call' OR payload_json IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS journal_task_run_seq
      ON journal(task_id, run_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS journal_call_id
      ON journal(id) WHERE kind = 'call';
    CREATE TABLE IF NOT EXISTS outbox_archive AS SELECT * FROM outbox WHERE 0;
    CREATE TABLE IF NOT EXISTS inbox_archive AS SELECT * FROM inbox WHERE 0;
  `);
}

export class SqliteProtocolDelivery {
  constructor(private readonly database: DatabaseSync) {}

  enqueueOutbox(input: EnqueueProtocolOutbox): ProtocolOutboxRecord {
    const frame = protocolFrameSchema.parse(input.frame);
    required(input.id, 'outbox id');
    required(input.destination, 'destination');
    if (frame.attempt !== 1) throw new Error('New outbox exchange must start at attempt 1');
    const status = input.status ?? 'pending';
    const activatedAt = status === 'held' ? (input.activated_at ?? null) : null;
    const nextAttemptAt = input.next_attempt_at ?? frame.created_at;
    this.database.prepare(`
      INSERT INTO outbox (
        id, protocol, exchange_id, task_id, run_id, destination, payload_json,
        status, attempt, next_attempt_at, activated_at, created_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1)
    `).run(
      input.id, frame.protocol, frame.exchange_id, frame.task_id, frame.run_id,
      input.destination, JSON.stringify(frame), status, nextAttemptAt, activatedAt, frame.created_at,
    );
    this.appendFrame(frame, 'outbox.enqueued', status, input.destination, frame.created_at);
    return this.requireOutbox(input.id);
  }

  receiveInbox(input: {
    consumer_id: string;
    frame: ProtocolFrame;
    received_at: string;
  }): { inbox: ProtocolInboxRecord; inserted: boolean } {
    const frame = protocolFrameSchema.parse(input.frame);
    required(input.consumer_id, 'consumer_id');
    const result = this.database.prepare(`
      INSERT INTO inbox (
        consumer_id, protocol, exchange_id, task_id, run_id, payload_json,
        status, received_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, 'received', ?, 1)
      ON CONFLICT(consumer_id, protocol, exchange_id) DO NOTHING
    `).run(
      input.consumer_id, frame.protocol, frame.exchange_id, frame.task_id,
      frame.run_id, JSON.stringify(frame), input.received_at,
    );
    const key = {
      consumer_id: input.consumer_id,
      protocol: frame.protocol,
      exchange_id: frame.exchange_id,
    };
    const inbox = this.requireInbox(key);
    if (JSON.stringify({ ...inbox.frame, attempt: 1 }) !==
        JSON.stringify({ ...frame, attempt: 1 })) {
      throw new Error(`Exchange ${frame.exchange_id} conflicts with an existing inbox frame`);
    }
    if (result.changes === 0) return { inbox, inserted: false };
    this.appendFrame(frame, 'inbox.received', 'received', input.consumer_id, input.received_at);
    if ('result' in frame && frame.causation_id) {
      const original = this.database.prepare(`
        SELECT id FROM outbox
        WHERE protocol = ? AND exchange_id = ? AND task_id = ?
      `).get(frame.protocol, frame.causation_id, frame.task_id);
      if (original) {
        const id = String(original.id);
        const updated = this.database.prepare(`
          UPDATE outbox SET status = 'complete', completed_at = ?,
            lease_owner = NULL, lease_expires_at = NULL, revision = revision + 1
          WHERE id = ? AND status IN ('held', 'pending', 'sent')
        `).run(input.received_at, id);
        if (updated.changes) {
          this.appendFrame(frame, 'outbox.completed', 'complete', id, input.received_at);
        }
      }
    }
    return { inbox, inserted: true };
  }

  completeInbox(input: CompleteProtocolInbox): ProtocolInboxRecord {
    const current = this.requireInbox(input.key);
    if (
      current.status !== 'processing' || current.lease_owner !== input.lease_owner ||
      current.revision !== input.expected_revision ||
      !current.lease_expires_at || current.lease_expires_at <= input.completed_at
    ) {
      throw new Error(`Inbox ${input.key.exchange_id} lease or revision conflict`);
    }
    if (input.reply) {
      const reply = protocolFrameSchema.parse(input.reply.frame);
      if (
        !('result' in reply) || reply.causation_id !== current.exchange_id ||
        reply.protocol !== current.protocol || reply.task_id !== current.task_id
      ) {
        throw new Error('Inbox reply must be a receipt caused by the completed exchange');
      }
      this.enqueueOutbox(input.reply);
    }
    this.database.prepare(`
      UPDATE inbox SET status = 'complete', completed_at = ?,
        lease_owner = NULL, lease_expires_at = NULL, reply_exchange_id = ?,
        revision = revision + 1
      WHERE consumer_id = ? AND protocol = ? AND exchange_id = ? AND revision = ?
    `).run(
      input.completed_at, input.reply?.frame.exchange_id ?? null,
      input.key.consumer_id, input.key.protocol, input.key.exchange_id,
      input.expected_revision,
    );
    this.appendFrame(current.frame, 'inbox.completed', 'complete', input.key.consumer_id, input.completed_at);
    return this.requireInbox(input.key);
  }

  appendCall(input: AppendProtocolCall): ProtocolJournalRecord {
    required(input.call_id, 'call_id');
    required(input.event, 'event');
    const existing = this.database.prepare(
      `SELECT * FROM journal WHERE kind = 'call' AND id = ?`,
    ).get(input.call_id);
    if (existing) return readJournal(existing);
    return this.insertJournal({
      task_id: input.task_id, run_id: input.run_id, ts: input.completed_at,
      kind: 'call', id: input.call_id, causation_id: null, role_id: input.role_id,
      event: input.event, status: input.status, summary: input.summary, frame: null,
    });
  }

  getOutbox(id: string): ProtocolOutboxRecord | undefined {
    const row = this.database.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
    return row ? readOutbox(row) : undefined;
  }

  getInbox(key: ProtocolInboxKey): ProtocolInboxRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM inbox WHERE consumer_id = ? AND protocol = ? AND exchange_id = ?
    `).get(key.consumer_id, key.protocol, key.exchange_id);
    return row ? readInbox(row) : undefined;
  }

  listJournal(taskId: string, runId: string, afterSeq = 0): ProtocolJournalRecord[] {
    return this.database.prepare(`
      SELECT * FROM journal
      WHERE task_id = ? AND run_id = ? AND seq > ? ORDER BY seq ASC
    `).all(taskId, runId, afterSeq).map(readJournal);
  }

  listRecoverableOutbox(now: string): ProtocolOutboxRecord[] {
    return this.database.prepare(`
      SELECT * FROM outbox
      WHERE (status = 'pending' OR (status = 'held' AND activated_at IS NOT NULL))
        AND next_attempt_at <= ?
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      ORDER BY next_attempt_at, created_at, id
    `).all(now, now).map(readOutbox);
  }

  listRecoverableInbox(now: string): ProtocolInboxRecord[] {
    return this.database.prepare(`
      SELECT * FROM inbox
      WHERE status = 'received'
        OR (status = 'processing' AND lease_expires_at <= ?)
      ORDER BY received_at, consumer_id, protocol, exchange_id
    `).all(now).map(readInbox);
  }

  activateOutbox(id: string, expectedRevision: number, at: string): ProtocolOutboxRecord {
    const result = this.database.prepare(`
      UPDATE outbox SET activated_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'held' AND activated_at IS NULL AND revision = ?
    `).run(at, id, expectedRevision);
    if (!result.changes) throw new Error(`Outbox ${id} activation conflict`);
    const record = this.requireOutbox(id);
    this.appendFrame(record.frame, 'outbox.activated', record.status, id, at);
    return record;
  }

  claimOutbox(
    id: string, owner: string, now: string, leaseExpiresAt: string, expectedRevision: number,
  ): ProtocolOutboxRecord | undefined {
    assertLease(owner, now, leaseExpiresAt);
    const result = this.database.prepare(`
      UPDATE outbox SET status = 'pending', lease_owner = ?, lease_expires_at = ?,
        attempt = attempt + 1, revision = revision + 1
      WHERE id = ? AND revision = ? AND next_attempt_at <= ?
        AND (status = 'pending' OR (status = 'held' AND activated_at IS NOT NULL))
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(owner, leaseExpiresAt, id, expectedRevision, now, now);
    if (!result.changes) return undefined;
    const record = this.requireOutbox(id);
    this.appendFrame(record.frame, 'outbox.claimed', record.status, owner, now);
    return record;
  }

  renewOutboxLease(
    id: string, owner: string, expectedRevision: number, now: string, leaseExpiresAt: string,
  ): ProtocolOutboxRecord {
    assertLease(owner, now, leaseExpiresAt);
    const result = this.database.prepare(`
      UPDATE outbox SET lease_expires_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'pending' AND lease_owner = ? AND revision = ?
        AND lease_expires_at > ?
    `).run(leaseExpiresAt, id, owner, expectedRevision, now);
    if (!result.changes) throw new Error(`Outbox ${id} lease or revision conflict`);
    const record = this.requireOutbox(id);
    this.appendFrame(record.frame, 'outbox.lease_renewed', record.status, owner, now);
    return record;
  }

  markOutboxSent(id: string, owner: string, expectedRevision: number, at: string): ProtocolOutboxRecord {
    const current = this.requireOutbox(id);
    if (current.status === 'complete') return current;
    return this.updateClaimedOutbox(id, owner, expectedRevision, at, 'sent', at);
  }

  retryOutbox(
    id: string, owner: string, expectedRevision: number, now: string, nextAttemptAt: string,
  ): ProtocolOutboxRecord {
    if (nextAttemptAt < now) throw new Error('Outbox retry time cannot be before now');
    return this.updateClaimedOutbox(id, owner, expectedRevision, now, 'pending', null, nextAttemptAt);
  }

  failOutbox(id: string, owner: string, expectedRevision: number, at: string): ProtocolOutboxRecord {
    return this.updateClaimedOutbox(id, owner, expectedRevision, at, 'failed', at);
  }

  claimInbox(
    key: ProtocolInboxKey, owner: string, now: string, leaseExpiresAt: string,
    expectedRevision: number,
  ): ProtocolInboxRecord | undefined {
    assertLease(owner, now, leaseExpiresAt);
    const result = this.database.prepare(`
      UPDATE inbox SET status = 'processing', lease_owner = ?,
        lease_expires_at = ?, revision = revision + 1
      WHERE consumer_id = ? AND protocol = ? AND exchange_id = ? AND revision = ?
        AND (status = 'received' OR (status = 'processing' AND lease_expires_at <= ?))
    `).run(
      owner, leaseExpiresAt, key.consumer_id, key.protocol, key.exchange_id,
      expectedRevision, now,
    );
    if (!result.changes) return undefined;
    const record = this.requireInbox(key);
    this.appendFrame(record.frame, 'inbox.claimed', record.status, owner, now);
    return record;
  }

  renewInboxLease(
    key: ProtocolInboxKey, owner: string, expectedRevision: number,
    now: string, leaseExpiresAt: string,
  ): ProtocolInboxRecord {
    assertLease(owner, now, leaseExpiresAt);
    const result = this.database.prepare(`
      UPDATE inbox SET lease_expires_at = ?, revision = revision + 1
      WHERE consumer_id = ? AND protocol = ? AND exchange_id = ? AND status = 'processing'
        AND lease_owner = ? AND revision = ? AND lease_expires_at > ?
    `).run(
      leaseExpiresAt, key.consumer_id, key.protocol, key.exchange_id,
      owner, expectedRevision, now,
    );
    if (!result.changes) throw new Error(`Inbox ${key.exchange_id} lease or revision conflict`);
    const record = this.requireInbox(key);
    this.appendFrame(record.frame, 'inbox.lease_renewed', record.status, owner, now);
    return record;
  }

  archiveSettled(before: string, limit = 1000): { outbox: number; inbox: number } {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('Archive limit must be positive');
    const outboxRows = this.database.prepare(`
      SELECT id FROM outbox
      WHERE status IN ('complete', 'failed') AND completed_at IS NOT NULL
        AND completed_at < ? ORDER BY completed_at, id LIMIT ?
    `).all(before, limit);
    const inboxRows = this.database.prepare(`
      SELECT consumer_id, protocol, exchange_id FROM inbox
      WHERE status = 'complete' AND completed_at IS NOT NULL
        AND completed_at < ? ORDER BY completed_at, consumer_id, protocol, exchange_id LIMIT ?
    `).all(before, limit);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const row of outboxRows) {
        this.database.prepare(`
          INSERT OR IGNORE INTO outbox_archive SELECT * FROM outbox WHERE id = ?
        `).run(String(row.id));
        this.database.prepare('DELETE FROM outbox WHERE id = ?').run(String(row.id));
      }
      for (const row of inboxRows) {
        this.database.prepare(`
          INSERT OR IGNORE INTO inbox_archive
          SELECT * FROM inbox WHERE consumer_id = ? AND protocol = ? AND exchange_id = ?
        `).run(String(row.consumer_id), String(row.protocol), String(row.exchange_id));
        this.database.prepare(`
          DELETE FROM inbox WHERE consumer_id = ? AND protocol = ? AND exchange_id = ?
        `).run(String(row.consumer_id), String(row.protocol), String(row.exchange_id));
      }
      this.database.exec('COMMIT');
      return { outbox: outboxRows.length, inbox: inboxRows.length };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private updateClaimedOutbox(
    id: string, owner: string, expectedRevision: number, at: string,
    status: 'pending' | 'sent' | 'failed', completedAt: string | null,
    nextAttemptAt?: string,
  ): ProtocolOutboxRecord {
    const result = this.database.prepare(`
      UPDATE outbox SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
        completed_at = CASE WHEN ? = 'failed' THEN ? ELSE completed_at END,
        next_attempt_at = COALESCE(?, next_attempt_at),
        lease_owner = NULL, lease_expires_at = NULL, revision = revision + 1
      WHERE id = ? AND status = 'pending' AND lease_owner = ? AND revision = ?
        AND lease_expires_at > ?
    `).run(
      status, status, completedAt, status, completedAt,
      nextAttemptAt ?? null, id, owner, expectedRevision, at,
    );
    if (!result.changes) throw new Error(`Outbox ${id} lease or revision conflict`);
    const record = this.requireOutbox(id);
    const event = status === 'pending' ? 'outbox.retry_scheduled' : `outbox.${status}`;
    this.appendFrame(record.frame, event, status, id, at);
    return record;
  }

  private appendFrame(
    frame: ProtocolFrame, event: string, status: string, summary: string, at: string,
  ): ProtocolJournalRecord {
    const kind = frame.protocol === 'system-agent' ? 'sap'
      : frame.protocol === 'agent-agent' ? 'aap' : 'adp';
    return this.insertJournal({
      task_id: frame.task_id, run_id: frame.run_id, ts: at, kind,
      id: frame.exchange_id, causation_id: frame.causation_id,
      role_id: frame.producer.role_id, event, status, summary, frame,
    });
  }

  private insertJournal(entry: Omit<ProtocolJournalRecord, 'seq'>): ProtocolJournalRecord {
    const result = this.database.prepare(`
      INSERT INTO journal (
        task_id, run_id, ts, kind, id, causation_id, role_id,
        event, status, summary, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.task_id, entry.run_id, entry.ts, entry.kind, entry.id,
      entry.causation_id, entry.role_id, entry.event, entry.status,
      entry.summary, entry.frame ? JSON.stringify(entry.frame) : null,
    );
    return { ...entry, seq: Number(result.lastInsertRowid) };
  }

  private requireOutbox(id: string): ProtocolOutboxRecord {
    const record = this.getOutbox(id);
    if (!record) throw new Error(`Outbox ${id} was not found`);
    return record;
  }

  private requireInbox(key: ProtocolInboxKey): ProtocolInboxRecord {
    const record = this.getInbox(key);
    if (!record) throw new Error(`Inbox ${key.exchange_id} was not found`);
    return record;
  }
}

function readOutbox(row: Record<string, unknown>): ProtocolOutboxRecord {
  const storedFrame = protocolFrameSchema.parse(JSON.parse(String(row.payload_json)));
  const attempt = Number(row.attempt);
  return {
    id: String(row.id), protocol: row.protocol as ProtocolOutboxRecord['protocol'],
    exchange_id: String(row.exchange_id), task_id: String(row.task_id),
    run_id: String(row.run_id), destination: String(row.destination),
    frame: attempt > 0 ? { ...storedFrame, attempt } : storedFrame,
    status: row.status as ProtocolOutboxRecord['status'], attempt,
    next_attempt_at: String(row.next_attempt_at),
    activated_at: nullable(row.activated_at), created_at: String(row.created_at),
    sent_at: nullable(row.sent_at), completed_at: nullable(row.completed_at),
    lease_owner: nullable(row.lease_owner), lease_expires_at: nullable(row.lease_expires_at),
    revision: Number(row.revision),
  };
}

function readInbox(row: Record<string, unknown>): ProtocolInboxRecord {
  return {
    consumer_id: String(row.consumer_id), protocol: row.protocol as ProtocolInboxRecord['protocol'],
    exchange_id: String(row.exchange_id), task_id: String(row.task_id),
    run_id: String(row.run_id),
    frame: protocolFrameSchema.parse(JSON.parse(String(row.payload_json))),
    status: row.status as ProtocolInboxRecord['status'], received_at: String(row.received_at),
    completed_at: nullable(row.completed_at), lease_owner: nullable(row.lease_owner),
    lease_expires_at: nullable(row.lease_expires_at),
    reply_exchange_id: nullable(row.reply_exchange_id), revision: Number(row.revision),
  };
}

function readJournal(row: Record<string, unknown>): ProtocolJournalRecord {
  return {
    seq: Number(row.seq), task_id: String(row.task_id), run_id: String(row.run_id),
    ts: String(row.ts), kind: row.kind as ProtocolJournalRecord['kind'], id: String(row.id),
    causation_id: nullable(row.causation_id), role_id: nullable(row.role_id),
    event: String(row.event), status: String(row.status), summary: String(row.summary),
    frame: row.payload_json === null ? null
      : protocolFrameSchema.parse(JSON.parse(String(row.payload_json))),
  };
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function required(value: string, name: string): void {
  if (!value) throw new Error(`${name} must not be empty`);
}

function assertLease(owner: string, now: string, expiresAt: string): void {
  required(owner, 'lease owner');
  if (expiresAt <= now) throw new Error('Lease expiry must be after now');
}
