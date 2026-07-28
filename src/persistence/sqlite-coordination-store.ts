import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  SCHEMA_VERSION,
  TASK_STATUSES,
  type AgentMessageType,
  type Event,
  type MessageRecipient,
} from '../core';
import {
  type CoordinationStateCommit,
  type CoordinationStateStore,
  type PersistedCoordinationEvent,
  type PersistedFullCheckpoint,
  type PersistedRunState,
  type PersistedTaskAggregate,
  type PersistedTaskRuntimeState,
  type PersistedTaskState,
  parseTaskCursorInput,
  type TaskResumeCursor,
} from './coordination-state-store';
import type {
  MailboxStateStore,
  PersistedMailboxDelivery,
  PersistedMailboxEnvelope,
  PersistedMailboxMessage,
  SaveMailboxReplyInput,
  SaveMailboxReplyResult,
} from './mailbox-state-store';

const RUN_STATUSES = [
  'created',
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
] as const;

const RUN_MODES = ['single_agent', 'council'] as const;
const RESUME_CURSORS = [
  'select_agent',
  'execute_agent',
  'council',
  'gate',
  'deliver',
  'mailbox_wait',
  'done',
] as const;
const MAILBOX_MESSAGE_TYPES = [
  'ask_help',
  'review_request',
  'proposal',
  'critique',
  'handoff',
  'status_update',
  'decision_request',
  'decision_response',
  'task.assigned',
  'driver.requested',
  'driver.completed',
] as const satisfies readonly AgentMessageType[];
const MAILBOX_DELIVERY_STATUSES = ['pending', 'delivered', 'acknowledged'] as const;

type SqlRow = Record<string, unknown>;

export class SqliteCoordinationStore implements CoordinationStateStore, MailboxStateStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    try {
      this.configure();
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  commitState(input: CoordinationStateCommit): PersistedCoordinationEvent[] {
    validateCommit(input);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.writeTask(input);
      if (input.run) this.writeRun(input.run);
      this.writeRuntimeState(input.runtime_state);
      if (input.checkpoint) this.writeCheckpoint(input.checkpoint);
      const events = input.events.map((event) => this.writeEvent(event));
      this.database.exec('COMMIT');
      return events;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getTaskAggregate(taskId: string): PersistedTaskAggregate | undefined {
    const taskRow = this.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!taskRow) return undefined;
    const runtimeRow = this.database
      .prepare('SELECT * FROM task_runtime_states WHERE task_id = ?')
      .get(taskId);
    if (!runtimeRow) throw new Error(`Task ${taskId} has no runtime state`);
    const runs = this.database
      .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC, run_id DESC')
      .all(taskId)
      .map((row) => readRun(row));
    return {
      task: readTask(taskRow),
      runs,
      runtime_state: readRuntimeState(runtimeRow),
      events: this.listEvents(taskId),
    };
  }

  listTaskAggregates(): PersistedTaskAggregate[] {
    return this.database
      .prepare('SELECT task_id FROM tasks ORDER BY updated_at DESC, task_id DESC')
      .all()
      .map((row) => this.getTaskAggregate(readString(row, 'task_id')))
      .filter((aggregate): aggregate is PersistedTaskAggregate => aggregate !== undefined);
  }

  listEvents(taskId: string, afterSequence = 0): PersistedCoordinationEvent[] {
    return this.database
      .prepare('SELECT * FROM events WHERE task_id = ? AND sequence > ? ORDER BY sequence ASC')
      .all(taskId, afterSequence)
      .map((row) => readEvent(row));
  }

  getLatestCheckpoint(taskId: string): PersistedFullCheckpoint | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM checkpoints
         WHERE task_id = ? AND checkpoint_type = 'full' AND validity_status = 'valid'
         ORDER BY created_at DESC, checkpoint_id DESC
         LIMIT 1`,
      )
      .get(taskId);
    return row ? readCheckpoint(row) : undefined;
  }

  saveMailboxMessage(
    message: PersistedMailboxMessage,
    deliveries: PersistedMailboxDelivery[],
  ): void {
    validateMailboxWrite(message, deliveries);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.writeMailboxMessage(message);
      for (const delivery of deliveries) this.writeMailboxDelivery(delivery);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  receiveMailboxInbox(
    recipient: MessageRecipient,
    deliveredAt: string,
    afterDeliveryId?: string,
  ): PersistedMailboxEnvelope[] {
    validateMailboxRecipient(recipient);
    const cursor = afterDeliveryId ? this.requireMailboxDelivery(afterDeliveryId) : undefined;
    if (cursor && !deliveryMatchesRecipient(cursor, recipient)) {
      throw new Error(`Mailbox delivery cursor ${afterDeliveryId} belongs to another recipient`);
    }
    const where = recipient.agent_id
      ? 'recipient_agent_id = ?'
      : 'recipient_role_id = ?';
    const recipientId = recipient.agent_id ?? recipient.role_id;
    const cursorClause = cursor
      ? 'AND (created_at > ? OR (created_at = ? AND delivery_id > ?))'
      : '';
    const parameters: SQLInputValue[] = [recipientId ?? ''];
    if (cursor) parameters.push(cursor.created_at, cursor.created_at, cursor.delivery_id);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.database
        .prepare(
          `SELECT * FROM deliveries
           WHERE ${where} AND status IN ('pending', 'delivered') ${cursorClause}
           ORDER BY created_at ASC, delivery_id ASC`,
        )
        .all(...parameters);
      const deliveries = rows.map((row) => readMailboxDelivery(row));
      const update = this.database.prepare(
        `UPDATE deliveries
         SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?), updated_at = ?
         WHERE delivery_id = ? AND status = 'pending'`,
      );
      for (const delivery of deliveries) {
        update.run(deliveredAt, deliveredAt, delivery.delivery_id);
      }
      const envelopes = deliveries.map((delivery) =>
        this.readMailboxEnvelope(delivery.delivery_id),
      );
      this.database.exec('COMMIT');
      return envelopes;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  acknowledgeMailboxDelivery(
    deliveryId: string,
    recipient: MessageRecipient,
    acknowledgedAt: string,
  ): PersistedMailboxDelivery {
    validateMailboxRecipient(recipient);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const delivery = this.requireMailboxDelivery(deliveryId);
      assertMailboxDeliveryRecipient(delivery, recipient);
      if (delivery.status === 'pending') {
        throw new Error(`Mailbox delivery ${deliveryId} must be delivered before acknowledgement`);
      }
      if (delivery.status === 'delivered') {
        this.database
          .prepare(
            `UPDATE deliveries
             SET status = 'acknowledged', acknowledged_at = ?, updated_at = ?
             WHERE delivery_id = ?`,
          )
          .run(acknowledgedAt, acknowledgedAt, deliveryId);
      }
      const acknowledged = this.requireMailboxDelivery(deliveryId);
      this.database.exec('COMMIT');
      return acknowledged;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  saveMailboxReply(input: SaveMailboxReplyInput): SaveMailboxReplyResult {
    validateMailboxRecipient(input.source_recipient);
    validateMailboxWrite(input.message, input.deliveries);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const source = this.requireMailboxDelivery(input.source_delivery_id);
      assertMailboxDeliveryRecipient(source, input.source_recipient);
      if (source.status === 'pending') {
        throw new Error(
          `Mailbox delivery ${input.source_delivery_id} must be delivered before reply`,
        );
      }
      if (input.message.reply_to_message_id !== source.message_id) {
        throw new Error('Mailbox reply must reference the source message');
      }
      if (source.status === 'delivered') {
        this.database
          .prepare(
            `UPDATE deliveries
             SET status = 'acknowledged', acknowledged_at = ?, updated_at = ?
             WHERE delivery_id = ?`,
          )
          .run(input.acknowledged_at, input.acknowledged_at, input.source_delivery_id);
      }
      this.writeMailboxMessage(input.message);
      for (const delivery of input.deliveries) this.writeMailboxDelivery(delivery);
      const result = {
        source_delivery: this.requireMailboxDelivery(input.source_delivery_id),
        reply: { message: input.message, deliveries: input.deliveries },
      };
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  recordMailboxWakeAttempt(
    deliveryId: string,
    input: { attempted_at: string; error?: { code: string; message: string; details?: Record<string, unknown> } },
  ): PersistedMailboxDelivery {
    const result = this.database
      .prepare(
        `UPDATE deliveries
         SET retry_count = retry_count + 1, last_error_json = ?, updated_at = ?
         WHERE delivery_id = ? AND status IN ('pending', 'delivered')`,
      )
      .run(input.error ? toJson(input.error) : null, input.attempted_at, deliveryId);
    if (result.changes === 0) {
      throw new Error(`Replayable mailbox delivery ${deliveryId} was not found`);
    }
    return this.requireMailboxDelivery(deliveryId);
  }

  getMailboxEnvelope(deliveryId: string): PersistedMailboxEnvelope | undefined {
    const row = this.database
      .prepare('SELECT delivery_id FROM deliveries WHERE delivery_id = ?')
      .get(deliveryId);
    return row ? this.readMailboxEnvelope(deliveryId) : undefined;
  }

  listMailboxThread(threadId: string): PersistedMailboxMessage[] {
    return this.database
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, message_id')
      .all(threadId)
      .map((row) => readMailboxMessage(row));
  }

  listReplayableMailboxDeliveries(): PersistedMailboxEnvelope[] {
    return this.database
      .prepare(
        `SELECT delivery_id FROM deliveries
         WHERE status IN ('pending', 'delivered')
         ORDER BY created_at, delivery_id`,
      )
      .all()
      .map((row) => this.readMailboxEnvelope(readString(row, 'delivery_id')));
  }

  close(): void {
    this.database.close();
  }

  private configure(): void {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
  }

  private migrate(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
          task_id TEXT PRIMARY KEY,
          parent_id TEXT,
          status TEXT NOT NULL CHECK (status IN (${sqlList(TASK_STATUSES)})),
          owner_agent_id TEXT,
          role_id TEXT,
          risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
          spec TEXT NOT NULL,
          completion_criteria_json TEXT NOT NULL,
          affected_paths_json TEXT NOT NULL,
          budget_json TEXT,
          workspace_path TEXT NOT NULL,
          warnings_json TEXT NOT NULL,
          final_output_json TEXT,
          error_json TEXT,
          revision INTEGER NOT NULL CHECK (revision > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schema_version TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN (${sqlList(RUN_STATUSES)})),
          mode TEXT NOT NULL CHECK (mode IN (${sqlList(RUN_MODES)})),
          workspace_path TEXT NOT NULL,
          session_id TEXT,
          restarted_from_run_id TEXT REFERENCES runs(run_id),
          snapshot_json TEXT,
          error_json TEXT,
          revision INTEGER NOT NULL CHECK (revision > 0),
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schema_version TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_task
          ON runs(task_id)
          WHERE status IN ('created', 'running');

        CREATE TABLE IF NOT EXISTS task_runtime_states (
          task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,
          current_run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
          resume_cursor TEXT NOT NULL CHECK (resume_cursor IN (${sqlList(RESUME_CURSORS)})),
          cursor_input_json TEXT,
          waiting_on_json TEXT NOT NULL,
          interrupt_state_json TEXT,
          artifact_refs_json TEXT NOT NULL,
          diagnostics_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schema_version TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          run_id TEXT REFERENCES runs(run_id),
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          schema_version TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS events_by_task_sequence ON events(task_id, sequence);
        CREATE INDEX IF NOT EXISTS events_by_run_sequence ON events(run_id, sequence);

        CREATE TABLE IF NOT EXISTS checkpoints (
          checkpoint_id TEXT PRIMARY KEY,
          parent_checkpoint_id TEXT REFERENCES checkpoints(checkpoint_id),
          checkpoint_type TEXT NOT NULL CHECK (checkpoint_type IN ('full', 'incremental')),
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          trigger TEXT NOT NULL,
          mechanical_snapshot_json TEXT NOT NULL,
          semantic_handoff_json TEXT NOT NULL,
          runtime_state_json TEXT,
          interrupt_state_json TEXT,
          artifact_refs_json TEXT NOT NULL,
          validity_status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          schema_version TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          from_agent_id TEXT NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          artifact_refs_json TEXT NOT NULL,
          requires_ack INTEGER NOT NULL CHECK (requires_ack IN (0, 1)),
          reply_to_message_id TEXT REFERENCES messages(message_id),
          created_at TEXT NOT NULL,
          schema_version TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS deliveries (
          delivery_id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
          recipient_agent_id TEXT,
          recipient_role_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'acknowledged')),
          deadline_at TEXT,
          delivered_at TEXT,
          acknowledged_at TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
          last_error_json TEXT,
          last_delivery_event_id TEXT REFERENCES events(event_id),
          replay_cursor TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          CHECK (recipient_agent_id IS NOT NULL OR recipient_role_id IS NOT NULL)
        );

        CREATE INDEX IF NOT EXISTS messages_by_thread
          ON messages(thread_id, created_at, message_id);
        CREATE INDEX IF NOT EXISTS deliveries_by_agent_status
          ON deliveries(recipient_agent_id, status, created_at, delivery_id);
        CREATE INDEX IF NOT EXISTS deliveries_by_role_status
          ON deliveries(recipient_role_id, status, created_at, delivery_id);
      `);
      this.database
        .prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(1, new Date().toISOString());
      ensureRuntimeCursorInputColumn(this.database);
      this.database
        .prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(2, new Date().toISOString());
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private writeTask(input: CoordinationStateCommit): void {
    const current = this.database
      .prepare('SELECT revision FROM tasks WHERE task_id = ?')
      .get(input.task.task_id);
    if (!current) {
      if (input.expected_task_revision !== undefined) {
        throw new Error(`Task ${input.task.task_id} does not exist`);
      }
      if (input.task.revision !== 1) {
        throw new Error(`New task ${input.task.task_id} must start at revision 1`);
      }
      taskInsert(this.database).run(...taskValues(input.task));
      return;
    }

    const currentRevision = readNumber(current, 'revision');
    if (input.expected_task_revision !== currentRevision) {
      throw new Error(
        `Task ${input.task.task_id} revision conflict: expected ${String(input.expected_task_revision)}, current ${String(currentRevision)}`,
      );
    }
    if (input.task.revision !== currentRevision + 1) {
      throw new Error(`Task ${input.task.task_id} revision must advance by one`);
    }
    taskUpdate(this.database).run(...taskValues(input.task), input.task.task_id);
  }

  private writeRun(run: PersistedRunState): void {
    const active = isActiveRun(run.status)
      ? this.database
          .prepare(
            "SELECT run_id FROM runs WHERE task_id = ? AND status IN ('created', 'running') AND run_id <> ?",
          )
          .get(run.task_id, run.run_id)
      : undefined;
    if (active) {
      throw new Error(`Task ${run.task_id} already has active run ${readString(active, 'run_id')}`);
    }

    const current = this.database
      .prepare('SELECT task_id, revision FROM runs WHERE run_id = ?')
      .get(run.run_id);
    if (!current) {
      if (run.revision !== 1) throw new Error(`New run ${run.run_id} must start at revision 1`);
      runInsert(this.database).run(...runValues(run));
      return;
    }
    if (readString(current, 'task_id') !== run.task_id) {
      throw new Error(`Run ${run.run_id} cannot change task ownership`);
    }
    if (run.revision !== readNumber(current, 'revision') + 1) {
      throw new Error(`Run ${run.run_id} revision must advance by one`);
    }
    runUpdate(this.database).run(...runValues(run), run.run_id);
  }

  private writeRuntimeState(state: PersistedTaskRuntimeState): void {
    this.database
      .prepare(
        `INSERT INTO task_runtime_states (
          task_id, current_run_id, resume_cursor, cursor_input_json, waiting_on_json, interrupt_state_json,
          artifact_refs_json, diagnostics_json, updated_at, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          current_run_id = excluded.current_run_id,
          resume_cursor = excluded.resume_cursor,
          cursor_input_json = excluded.cursor_input_json,
          waiting_on_json = excluded.waiting_on_json,
          interrupt_state_json = excluded.interrupt_state_json,
          artifact_refs_json = excluded.artifact_refs_json,
          diagnostics_json = excluded.diagnostics_json,
          updated_at = excluded.updated_at,
          schema_version = excluded.schema_version`,
      )
      .run(
        state.task_id,
        state.current_run_id ?? null,
        state.resume_cursor,
        state.cursor_input ? toJson(state.cursor_input) : null,
        toJson(state.waiting_on),
        state.interrupt_state ? toJson(state.interrupt_state) : null,
        toJson(state.artifact_refs),
        toJson(state.diagnostics),
        state.updated_at,
        state.schema_version,
      );
  }

  private writeCheckpoint(checkpoint: PersistedFullCheckpoint): void {
    this.database
      .prepare(
        `INSERT INTO checkpoints (
          checkpoint_id, parent_checkpoint_id, checkpoint_type, task_id, agent_id, trigger,
          mechanical_snapshot_json, semantic_handoff_json, runtime_state_json,
          interrupt_state_json, artifact_refs_json, validity_status, created_at, schema_version
        ) VALUES (?, ?, 'full', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpoint.checkpoint_id,
        checkpoint.parent_checkpoint_id ?? null,
        checkpoint.task_id,
        checkpoint.agent_id,
        checkpoint.trigger,
        toJson(checkpoint.mechanical_snapshot),
        toJson(checkpoint.semantic_handoff),
        toJson({
          run_id: checkpoint.run_id,
          ...(checkpoint.session_id ? { session_id: checkpoint.session_id } : {}),
          resume_cursor: checkpoint.resume_cursor,
          message_thread: checkpoint.message_thread,
        }),
        checkpoint.interrupt_state ? toJson(checkpoint.interrupt_state) : null,
        toJson(checkpoint.artifact_refs),
        checkpoint.validity_status,
        checkpoint.created_at,
        checkpoint.schema_version,
      );
  }

  private writeEvent(event: Event): PersistedCoordinationEvent {
    if (!event.task_id) throw new Error(`Coordination event ${event.event_id} requires task_id`);
    const result = this.database
      .prepare(
        `INSERT INTO events (
          event_id, event_type, subject_id, run_id, task_id, payload_json, created_at, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.event_id,
        event.event_type,
        event.subject_id,
        event.run_id ?? null,
        event.task_id,
        toJson(event.payload),
        event.created_at,
        event.schema_version,
      );
    return { ...event, sequence: Number(result.lastInsertRowid) };
  }

  private writeMailboxMessage(message: PersistedMailboxMessage): void {
    this.database
      .prepare(
        `INSERT INTO messages (
          message_id, thread_id, from_agent_id, type, payload_json, artifact_refs_json,
          requires_ack, reply_to_message_id, created_at, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.message_id,
        message.thread_id,
        message.from_agent_id,
        message.type,
        toJson(message.payload),
        toJson(message.artifact_refs),
        message.requires_ack ? 1 : 0,
        message.reply_to_message_id ?? null,
        message.created_at,
        message.schema_version,
      );
  }

  private writeMailboxDelivery(delivery: PersistedMailboxDelivery): void {
    this.database
      .prepare(
        `INSERT INTO deliveries (
          delivery_id, message_id, recipient_agent_id, recipient_role_id, status, deadline_at,
          delivered_at, acknowledged_at, retry_count, last_error_json, last_delivery_event_id,
          replay_cursor, created_at, updated_at, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        delivery.delivery_id,
        delivery.message_id,
        delivery.recipient_agent_id ?? null,
        delivery.recipient_role_id ?? null,
        delivery.status,
        delivery.deadline_at ?? null,
        delivery.delivered_at ?? null,
        delivery.acknowledged_at ?? null,
        delivery.retry_count,
        delivery.last_error ? toJson(delivery.last_error) : null,
        delivery.last_delivery_event_id ?? null,
        delivery.replay_cursor ?? null,
        delivery.created_at,
        delivery.updated_at,
        delivery.schema_version,
      );
  }

  private requireMailboxDelivery(deliveryId: string): PersistedMailboxDelivery {
    const row = this.database
      .prepare('SELECT * FROM deliveries WHERE delivery_id = ?')
      .get(deliveryId);
    if (!row) throw new Error(`Mailbox delivery ${deliveryId} was not found`);
    return readMailboxDelivery(row);
  }

  private readMailboxEnvelope(deliveryId: string): PersistedMailboxEnvelope {
    const delivery = this.requireMailboxDelivery(deliveryId);
    const messageRow = this.database
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .get(delivery.message_id);
    if (!messageRow) throw new Error(`Mailbox message ${delivery.message_id} was not found`);
    return { message: readMailboxMessage(messageRow), delivery };
  }
}

function validateCommit(input: CoordinationStateCommit): void {
  if (input.events.length === 0) throw new Error('State commit requires at least one event');
  if (input.runtime_state.task_id !== input.task.task_id) {
    throw new Error('Runtime state belongs to another task');
  }
  if (input.runtime_state.cursor_input) {
    const cursorInput = parseTaskCursorInput(input.runtime_state.cursor_input);
    if (cursorInput.cursor !== input.runtime_state.resume_cursor) {
      throw new Error('Runtime cursor input does not match resume cursor');
    }
  }
  if (input.run && input.run.task_id !== input.task.task_id) {
    throw new Error('Run belongs to another task');
  }
  for (const event of input.events) {
    if (event.task_id !== input.task.task_id) throw new Error('Event belongs to another task');
    if (event.run_id && input.run && event.run_id !== input.run.run_id) {
      throw new Error('Event belongs to another run');
    }
  }
  if (input.task.status === 'completed') {
    const finalOutput = input.task.final_output;
    if (
      !finalOutput?.artifact_ref ||
      !finalOutput.workspace_path ||
      !/^[a-f0-9]{64}$/.test(finalOutput.sha256)
    ) {
      throw new Error('Completed task requires verifiable final artifact evidence');
    }
  }
  if (input.checkpoint) {
    if (
      input.checkpoint.task_id !== input.task.task_id ||
      (input.run && input.checkpoint.run_id !== input.run.run_id)
    ) {
      throw new Error('Checkpoint belongs to another task or run');
    }
    if (
      !input.events.some(
        (event) =>
          event.event_type === 'checkpoint.saved' &&
          event.subject_id === input.checkpoint?.checkpoint_id,
      )
    ) {
      throw new Error('Checkpoint state commit requires checkpoint.saved event');
    }
  }
}

function taskInsert(database: DatabaseSync): StatementSync {
  return database.prepare(
    `INSERT INTO tasks (
      task_id, parent_id, status, owner_agent_id, role_id, risk_level, spec,
      completion_criteria_json, affected_paths_json, budget_json, workspace_path,
      warnings_json, final_output_json, error_json, revision, created_at, updated_at, schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
}

function taskUpdate(database: DatabaseSync): StatementSync {
  return database.prepare(
    `UPDATE tasks SET
      task_id = ?, parent_id = ?, status = ?, owner_agent_id = ?, role_id = ?, risk_level = ?,
      spec = ?, completion_criteria_json = ?, affected_paths_json = ?, budget_json = ?,
      workspace_path = ?, warnings_json = ?, final_output_json = ?, error_json = ?, revision = ?,
      created_at = ?, updated_at = ?, schema_version = ?
    WHERE task_id = ?`,
  );
}

function taskValues(task: PersistedTaskState): SQLInputValue[] {
  return [
    task.task_id,
    task.parent_id ?? null,
    task.status,
    task.owner_agent_id ?? null,
    task.role_id ?? null,
    task.risk_level,
    task.spec,
    toJson(task.completion_criteria),
    toJson(task.affected_paths),
    task.budget ? toJson(task.budget) : null,
    task.workspace_path,
    toJson(task.warnings),
    task.final_output ? toJson(task.final_output) : null,
    task.error ? toJson(task.error) : null,
    task.revision,
    task.created_at,
    task.updated_at,
    task.schema_version,
  ];
}

function runInsert(database: DatabaseSync): StatementSync {
  return database.prepare(
    `INSERT INTO runs (
      run_id, task_id, status, mode, workspace_path, session_id, restarted_from_run_id,
      snapshot_json, error_json, revision, started_at, completed_at, created_at, updated_at,
      schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
}

function runUpdate(database: DatabaseSync): StatementSync {
  return database.prepare(
    `UPDATE runs SET
      run_id = ?, task_id = ?, status = ?, mode = ?, workspace_path = ?, session_id = ?,
      restarted_from_run_id = ?, snapshot_json = ?, error_json = ?, revision = ?, started_at = ?,
      completed_at = ?, created_at = ?, updated_at = ?, schema_version = ?
    WHERE run_id = ?`,
  );
}

function runValues(run: PersistedRunState): SQLInputValue[] {
  return [
    run.run_id,
    run.task_id,
    run.status,
    run.mode,
    run.workspace_path,
    run.session_id ?? null,
    run.restarted_from_run_id ?? null,
    run.snapshot ? toJson(run.snapshot) : null,
    run.error ? toJson(run.error) : null,
    run.revision,
    run.started_at ?? null,
    run.completed_at ?? null,
    run.created_at,
    run.updated_at,
    run.schema_version,
  ];
}

function readTask(row: SqlRow): PersistedTaskState {
  const budget = readOptionalJson<Record<string, number>>(row, 'budget_json');
  const finalOutput = readOptionalJson<PersistedTaskState['final_output']>(
    row,
    'final_output_json',
  );
  const error = readOptionalJson<PersistedTaskState['error']>(row, 'error_json');
  return {
    task_id: readString(row, 'task_id'),
    ...(readOptionalString(row, 'parent_id') ? { parent_id: readString(row, 'parent_id') } : {}),
    status: readEnum(row, 'status', TASK_STATUSES),
    ...(readOptionalString(row, 'owner_agent_id')
      ? { owner_agent_id: readString(row, 'owner_agent_id') }
      : {}),
    ...(readOptionalString(row, 'role_id') ? { role_id: readString(row, 'role_id') } : {}),
    risk_level: readEnum(row, 'risk_level', ['low', 'medium', 'high', 'critical'] as const),
    spec: readString(row, 'spec'),
    completion_criteria: readJson<string[]>(row, 'completion_criteria_json'),
    affected_paths: readJson<string[]>(row, 'affected_paths_json'),
    ...(budget ? { budget } : {}),
    workspace_path: readString(row, 'workspace_path'),
    warnings: readJson<string[]>(row, 'warnings_json'),
    ...(finalOutput ? { final_output: finalOutput } : {}),
    ...(error ? { error } : {}),
    revision: readNumber(row, 'revision'),
    created_at: readString(row, 'created_at'),
    updated_at: readString(row, 'updated_at'),
    schema_version: readSchemaVersion(row),
  };
}

function readRun(row: SqlRow): PersistedRunState {
  const snapshot = readOptionalJson<PersistedRunState['snapshot']>(row, 'snapshot_json');
  const error = readOptionalJson<PersistedRunState['error']>(row, 'error_json');
  return {
    run_id: readString(row, 'run_id'),
    task_id: readString(row, 'task_id'),
    status: readEnum(row, 'status', RUN_STATUSES),
    mode: readEnum(row, 'mode', RUN_MODES),
    workspace_path: readString(row, 'workspace_path'),
    ...(readOptionalString(row, 'session_id') ? { session_id: readString(row, 'session_id') } : {}),
    ...(readOptionalString(row, 'restarted_from_run_id')
      ? { restarted_from_run_id: readString(row, 'restarted_from_run_id') }
      : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(error ? { error } : {}),
    revision: readNumber(row, 'revision'),
    ...(readOptionalString(row, 'started_at') ? { started_at: readString(row, 'started_at') } : {}),
    ...(readOptionalString(row, 'completed_at')
      ? { completed_at: readString(row, 'completed_at') }
      : {}),
    created_at: readString(row, 'created_at'),
    updated_at: readString(row, 'updated_at'),
    schema_version: readSchemaVersion(row),
  };
}

function readRuntimeState(row: SqlRow): PersistedTaskRuntimeState {
  const interruptState = readOptionalJson<Record<string, unknown>>(row, 'interrupt_state_json');
  const rawCursorInput = readOptionalJson<unknown>(row, 'cursor_input_json');
  const cursorInput =
    rawCursorInput === undefined ? undefined : parseTaskCursorInput(rawCursorInput);
  return {
    task_id: readString(row, 'task_id'),
    ...(readOptionalString(row, 'current_run_id')
      ? { current_run_id: readString(row, 'current_run_id') }
      : {}),
    resume_cursor: readEnum(row, 'resume_cursor', RESUME_CURSORS) as TaskResumeCursor,
    ...(cursorInput ? { cursor_input: cursorInput } : {}),
    waiting_on: readJson<Record<string, unknown>[]>(row, 'waiting_on_json'),
    ...(interruptState ? { interrupt_state: interruptState } : {}),
    artifact_refs: readJson<string[]>(row, 'artifact_refs_json'),
    diagnostics: readJson<Record<string, unknown>>(row, 'diagnostics_json'),
    updated_at: readString(row, 'updated_at'),
    schema_version: readSchemaVersion(row),
  };
}

function readEvent(row: SqlRow): PersistedCoordinationEvent {
  const runId = readOptionalString(row, 'run_id');
  return {
    sequence: readNumber(row, 'sequence'),
    event_id: readString(row, 'event_id'),
    event_type: readString(row, 'event_type'),
    subject_id: readString(row, 'subject_id'),
    ...(runId ? { run_id: runId } : {}),
    task_id: readString(row, 'task_id'),
    payload: readJson<Record<string, unknown>>(row, 'payload_json'),
    created_at: readString(row, 'created_at'),
    schema_version: readSchemaVersion(row),
  };
}

function readCheckpoint(row: SqlRow): PersistedFullCheckpoint {
  const runtime = readJson<{
    run_id: string;
    session_id?: string;
    resume_cursor: TaskResumeCursor;
    message_thread: PersistedFullCheckpoint['message_thread'];
  }>(row, 'runtime_state_json');
  const interruptState = readOptionalJson<Record<string, unknown>>(row, 'interrupt_state_json');
  return {
    checkpoint_id: readString(row, 'checkpoint_id'),
    ...(readOptionalString(row, 'parent_checkpoint_id')
      ? { parent_checkpoint_id: readString(row, 'parent_checkpoint_id') }
      : {}),
    task_id: readString(row, 'task_id'),
    run_id: runtime.run_id,
    agent_id: readString(row, 'agent_id'),
    ...(runtime.session_id ? { session_id: runtime.session_id } : {}),
    trigger: readEnum(row, 'trigger', [
      'manual',
      'periodic',
      'shutdown',
      'blocked',
      'escalated',
    ] as const),
    resume_cursor: readEnum(
      { resume_cursor: runtime.resume_cursor },
      'resume_cursor',
      RESUME_CURSORS,
    ),
    message_thread: runtime.message_thread,
    mechanical_snapshot: readJson<PersistedFullCheckpoint['mechanical_snapshot']>(
      row,
      'mechanical_snapshot_json',
    ),
    semantic_handoff: readJson<PersistedFullCheckpoint['semantic_handoff']>(
      row,
      'semantic_handoff_json',
    ),
    ...(interruptState ? { interrupt_state: interruptState } : {}),
    artifact_refs: readJson<string[]>(row, 'artifact_refs_json'),
    validity_status: readEnum(row, 'validity_status', ['valid', 'invalid', 'superseded'] as const),
    created_at: readString(row, 'created_at'),
    schema_version: readSchemaVersion(row),
  };
}

function readMailboxMessage(row: SqlRow): PersistedMailboxMessage {
  return {
    message_id: readString(row, 'message_id'),
    thread_id: readString(row, 'thread_id'),
    from_agent_id: readString(row, 'from_agent_id'),
    type: readEnum(row, 'type', MAILBOX_MESSAGE_TYPES),
    payload: readJson<Record<string, unknown>>(row, 'payload_json'),
    artifact_refs: readJson<string[]>(row, 'artifact_refs_json'),
    requires_ack: readNumber(row, 'requires_ack') === 1,
    ...(readOptionalString(row, 'reply_to_message_id')
      ? { reply_to_message_id: readString(row, 'reply_to_message_id') }
      : {}),
    created_at: readString(row, 'created_at'),
    schema_version: readSchemaVersion(row),
  };
}

function readMailboxDelivery(row: SqlRow): PersistedMailboxDelivery {
  const lastError = readOptionalJson<PersistedMailboxDelivery['last_error']>(
    row,
    'last_error_json',
  );
  return {
    delivery_id: readString(row, 'delivery_id'),
    message_id: readString(row, 'message_id'),
    ...(readOptionalString(row, 'recipient_agent_id')
      ? { recipient_agent_id: readString(row, 'recipient_agent_id') }
      : {}),
    ...(readOptionalString(row, 'recipient_role_id')
      ? { recipient_role_id: readString(row, 'recipient_role_id') }
      : {}),
    status: readEnum(row, 'status', MAILBOX_DELIVERY_STATUSES),
    ...(readOptionalString(row, 'deadline_at')
      ? { deadline_at: readString(row, 'deadline_at') }
      : {}),
    ...(readOptionalString(row, 'delivered_at')
      ? { delivered_at: readString(row, 'delivered_at') }
      : {}),
    ...(readOptionalString(row, 'acknowledged_at')
      ? { acknowledged_at: readString(row, 'acknowledged_at') }
      : {}),
    retry_count: readNumber(row, 'retry_count'),
    ...(lastError ? { last_error: lastError } : {}),
    ...(readOptionalString(row, 'last_delivery_event_id')
      ? { last_delivery_event_id: readString(row, 'last_delivery_event_id') }
      : {}),
    ...(readOptionalString(row, 'replay_cursor')
      ? { replay_cursor: readString(row, 'replay_cursor') }
      : {}),
    created_at: readString(row, 'created_at'),
    updated_at: readString(row, 'updated_at'),
    schema_version: readSchemaVersion(row),
  };
}

function validateMailboxWrite(
  message: PersistedMailboxMessage,
  deliveries: PersistedMailboxDelivery[],
): void {
  if (deliveries.length === 0) throw new Error('Mailbox message requires at least one delivery');
  if (message.schema_version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported mailbox message schema: ${message.schema_version}`);
  }
  const recipients = new Set<string>();
  for (const delivery of deliveries) {
    if (delivery.message_id !== message.message_id) {
      throw new Error('Mailbox delivery belongs to another message');
    }
    if (delivery.status !== 'pending') {
      throw new Error('New mailbox delivery must be pending');
    }
    const recipient = delivery.recipient_agent_id
      ? { agent_id: delivery.recipient_agent_id }
      : delivery.recipient_role_id
        ? { role_id: delivery.recipient_role_id }
        : {};
    validateMailboxRecipient(recipient);
    const key = delivery.recipient_agent_id
      ? `agent:${delivery.recipient_agent_id}`
      : `role:${delivery.recipient_role_id ?? ''}`;
    if (recipients.has(key)) throw new Error(`Duplicate mailbox recipient ${key}`);
    recipients.add(key);
    if (delivery.schema_version !== SCHEMA_VERSION) {
      throw new Error(`Unsupported mailbox delivery schema: ${delivery.schema_version}`);
    }
  }
}

function validateMailboxRecipient(recipient: MessageRecipient): void {
  const count = Number(Boolean(recipient.agent_id)) + Number(Boolean(recipient.role_id));
  if (count !== 1) {
    throw new Error('Mailbox recipient must set exactly one of agent_id or role_id');
  }
}

function deliveryMatchesRecipient(
  delivery: PersistedMailboxDelivery,
  recipient: MessageRecipient,
): boolean {
  return (
    (recipient.agent_id !== undefined && delivery.recipient_agent_id === recipient.agent_id) ||
    (recipient.role_id !== undefined && delivery.recipient_role_id === recipient.role_id)
  );
}

function assertMailboxDeliveryRecipient(
  delivery: PersistedMailboxDelivery,
  recipient: MessageRecipient,
): void {
  if (!deliveryMatchesRecipient(delivery, recipient)) {
    throw new Error(`Mailbox delivery ${delivery.delivery_id} belongs to another recipient`);
  }
}

function readString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string`);
  return value;
}

function readOptionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string or null`);
  return value;
}

function readNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') throw new Error(`Expected ${key} to be a number`);
  return value;
}

function readSchemaVersion(row: SqlRow): typeof SCHEMA_VERSION {
  const value = readString(row, 'schema_version');
  if (value !== SCHEMA_VERSION) throw new Error(`Unsupported schema_version: ${value}`);
  return value;
}

function readJson<T>(row: SqlRow, key: string): T {
  return JSON.parse(readString(row, key)) as T;
}

function readOptionalJson<T>(row: SqlRow, key: string): T | undefined {
  const value = readOptionalString(row, key);
  return value === undefined ? undefined : (JSON.parse(value) as T);
}

function readEnum<const T extends readonly string[]>(
  row: SqlRow,
  key: string,
  values: T,
): T[number] {
  const value = readString(row, key);
  if (!values.includes(value)) throw new Error(`Invalid ${key}: ${value}`);
  return value as T[number];
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');
}

function ensureRuntimeCursorInputColumn(database: DatabaseSync): void {
  const columns = database
    .prepare('PRAGMA table_info(task_runtime_states)')
    .all()
    .map((row) => String((row as SqlRow).name));
  if (!columns.includes('cursor_input_json')) {
    database.exec('ALTER TABLE task_runtime_states ADD COLUMN cursor_input_json TEXT');
  }
}

function isActiveRun(status: PersistedRunState['status']): boolean {
  return status === 'created' || status === 'running';
}

export type { CoordinationStateCommit } from './coordination-state-store';
