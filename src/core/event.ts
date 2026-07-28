import type { EventId, RunId, SchemaVersion, TaskId, Timestamp } from './ids';

export type EventType =
  | 'task.created'
  | 'run.created'
  | 'driver.session_started'
  | 'memory.context_pack_built'
  | 'driver.run_result'
  | 'artifact.registered'
  | 'task.completed'
  | 'hook.matched'
  | 'gate.requested'
  | 'gate.result'
  | 'council.decision'
  | 'merge.authorization'
  | 'checkpoint.saved'
  | 'run.completed'
  | 'mailbox.sent'
  | 'mailbox.delivery_read'
  | 'mailbox.delivery_acked'
  | 'mailbox.delivery_replied'
  | 'mailbox.delivery_timeout'
  | 'mailbox.delivery_failed'
  | (string & {});

export interface Event {
  event_id: EventId;
  event_type: EventType;
  subject_id: string;
  run_id?: RunId;
  task_id?: TaskId;
  payload: Record<string, unknown>;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}
