import type { SchemaVersion } from '../core';

export interface AgentMailboxWakeRequestV1 {
  contract_version: 'agent-mailbox-wake.v1';
  message_id: string;
  delivery_id: string;
  thread_id: string;
  recipient_agent_id?: string;
  recipient_role_id?: string;
  schema_version: SchemaVersion;
}

/** C only requests a wake; B keeps ownership of the Agent process lifecycle. */
export interface AgentMailboxWakePort {
  wakeAgent(request: AgentMailboxWakeRequestV1): Promise<void>;
}
