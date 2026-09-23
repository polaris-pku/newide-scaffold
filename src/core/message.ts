import type {
  ArtifactId,
  CheckpointId,
  ContextPackId,
  MemoryId,
  MessageId,
  RoleId,
  SchemaVersion,
  TaskId,
  ThreadId,
  Timestamp,
} from './ids';

export type AgentMessageType =
  | 'ask_help'
  | 'review_request'
  | 'proposal'
  | 'critique'
  | 'handoff'
  | 'status_update'
  | 'decision_request'
  | 'decision_response'
  | 'task.assigned'
  | 'driver.requested'
  | 'driver.completed';

export interface MessageRecipient {
  agent_id?: string;
  role_id?: RoleId;
}

/**
 * Mailbox-internal message envelope.
 *
 * Disposition (P0 decision, issue #145): **coexist** — cross-protocol
 * traffic (SAP/AAP/ADP frames) must use `protocolFrameSchema` from the
 * `src/core` barrel instead of this type; `Message` stays the mailbox's
 * internal envelope with no field changes and no consumer migration in P0.
 * Migration boundary is C2 (after C1): align `Message`/Delivery with the AAP
 * envelope via the delivery-boundary `exchange_id ↔ message_id` mapping —
 * `message_id` never enters a protocol envelope.
 */
export interface Message {
  message_id: MessageId;
  thread_id: ThreadId;
  from_agent_id: string;
  to: MessageRecipient[];
  type: AgentMessageType;
  payload: Record<string, unknown>;
  artifact_refs?: ArtifactId[];
  checkpoint_ref?: CheckpointId;
  causal_event_id?: string;
  requires_ack: boolean;
  deadline_seconds?: number;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface MessageRef {
  message_id: MessageId;
  thread_id: ThreadId;
  schema_version: SchemaVersion;
}

export interface MemoryPolicy {
  allow_in_driver_context: boolean;
  allow_in_council_proposer: boolean;
  allow_in_council_judge: boolean;
  max_memory_items: number;
}

export interface RoleProfileRef {
  role_id: RoleId;
  persona_ref: string;
  skill_refs: string[];
  capability_tags: string[];
  memory_policy: MemoryPolicy;
  schema_version: SchemaVersion;
}

export interface MemoryRef {
  memory_id: MemoryId;
  kind: 'experience' | 'skill' | 'persona' | 'project' | 'team';
  uri: string;
  summary?: string;
  schema_version: SchemaVersion;
}

export interface ContextPackRef {
  context_pack_id: ContextPackId;
  uri: string;
  task_id?: TaskId;
  schema_version: SchemaVersion;
}
