import type Database from 'better-sqlite3';
import type { PersistedMailboxDelivery, PersistedMailboxEnvelope } from '../persistence';
import type { MessageTimeoutAction } from './mailbox-event-types';
import { SCHEMA_VERSION } from '../core';
import type { MailboxTimeoutStore } from './mailbox-timeout-store';

export class SqliteMailboxTimeoutStore implements MailboxTimeoutStore {
  constructor(private readonly db: Database.Database) {}

  listTimedOutDeliveries(now: string): PersistedMailboxEnvelope[] {
    const sql = `
      SELECT
        m.message_id,
        m.thread_id,
        m.from_agent_id,
        m.type,
        m.payload,
        m.artifact_refs,
        m.requires_ack,
        m.created_at as message_created_at,
        m.schema_version as message_schema_version,
        d.delivery_id,
        d.recipient_agent_id,
        d.recipient_role_id,
        d.status,
        d.deadline_at,
        d.retry_count,
        d.created_at as delivery_created_at,
        d.updated_at,
        d.schema_version as delivery_schema_version
      FROM persisted_mailbox_messages m
      JOIN persisted_mailbox_deliveries d ON m.message_id = d.message_id
      WHERE d.status = 'pending'
        AND d.deadline_at IS NOT NULL
        AND d.deadline_at < ?
        AND d.retry_count < 3
      ORDER BY d.deadline_at ASC
      LIMIT 100
    `;

    const rows = this.db.prepare(sql).all(now) as any[];
    return rows.map((row) => ({
      message: {
        message_id: row.message_id,
        thread_id: row.thread_id,
        from_agent_id: row.from_agent_id,
        type: row.type,
        payload: JSON.parse(row.payload || '{}'),
        artifact_refs: row.artifact_refs ? JSON.parse(row.artifact_refs) : undefined,
        requires_ack: Boolean(row.requires_ack),
        created_at: row.message_created_at,
        schema_version: row.message_schema_version,
      },
      delivery: {
        delivery_id: row.delivery_id,
        message_id: row.message_id,
        recipient_agent_id: row.recipient_agent_id,
        recipient_role_id: row.recipient_role_id,
        status: row.status,
        deadline_at: row.deadline_at,
        retry_count: row.retry_count,
        created_at: row.delivery_created_at,
        updated_at: row.updated_at,
        schema_version: row.delivery_schema_version,
      },
    } as PersistedMailboxEnvelope));
  }

  recordMailboxTimeout(
    deliveryId: string,
    timeoutAt: string,
    action: MessageTimeoutAction,
  ): PersistedMailboxDelivery {
    const newStatus = action === 'retry' ? 'pending' : action;

    const sql = `
      UPDATE persisted_mailbox_deliveries
      SET status = ?,
          last_timeout_at = ?,
          retry_count = retry_count + 1,
          updated_at = ?
      WHERE delivery_id = ?
    `;

    this.db.prepare(sql).run(newStatus, timeoutAt, timeoutAt, deliveryId);

    return this.getDelivery(deliveryId)!;
  }

  recordMailboxFailure(
    deliveryId: string,
    errorCode: string,
    errorMessage: string,
  ): PersistedMailboxDelivery {
    const now = new Date().toISOString();

    const sql = `
      UPDATE persisted_mailbox_deliveries
      SET status = 'failed',
          last_failed_at = ?,
          failure_reason = ?,
          updated_at = ?
      WHERE delivery_id = ?
    `;

    this.db
      .prepare(sql)
      .run(now, JSON.stringify({ code: errorCode, message: errorMessage }), now, deliveryId);

    return this.getDelivery(deliveryId)!;
  }

  recordMailboxRead(deliveryId: string, readAt: string): PersistedMailboxDelivery {
    const sql = `
      UPDATE persisted_mailbox_deliveries
      SET read_at = ?,
          updated_at = ?
      WHERE delivery_id = ?
    `;

    this.db.prepare(sql).run(readAt, readAt, deliveryId);

    return this.getDelivery(deliveryId)!;
  }

  private getDelivery(deliveryId: string): PersistedMailboxDelivery | null {
    const sql = `
      SELECT
        delivery_id,
        message_id,
        recipient_agent_id,
        recipient_role_id,
        status,
        deadline_at,
        retry_count,
        created_at,
        updated_at,
        schema_version
      FROM persisted_mailbox_deliveries
      WHERE delivery_id = ?
    `;

    const row = this.db.prepare(sql).get(deliveryId) as any;
    if (!row) return null;

    return {
      delivery_id: row.delivery_id,
      message_id: row.message_id,
      recipient_agent_id: row.recipient_agent_id,
      recipient_role_id: row.recipient_role_id,
      status: row.status,
      deadline_at: row.deadline_at,
      retry_count: row.retry_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
      schema_version: row.schema_version,
    };
  }
}
