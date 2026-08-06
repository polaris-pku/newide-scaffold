import type { AgentMessageType } from '../core';
import type { Tool } from '../memory';
import type { MailboxMessageKind } from './mailbox-state-store';

export interface MailboxSendToolInput {
  to_role_id: string;
  /** Canonical Agent-facing contract. */
  kind: MailboxMessageKind;
  content: string;
  artifact_refs?: string[];
  /** Accepted by the Host adapter only while older prompts are replayed. */
  type?: AgentMessageType;
  payload?: Record<string, unknown>;
}

export interface MailboxToolOutcome {
  kind: 'request' | 'notice' | 'reply';
  message_id: string;
  delivery_id: string;
  thread_id: string;
  from_role_id: string;
  to_role_id: string;
  status: 'pending' | 'injected';
  wait_for_reply: boolean;
  source_delivery_id?: string;
}

export type MailboxSendToolHandler = (
  input: MailboxSendToolInput,
) => Promise<MailboxToolOutcome>;

export const MAILBOX_SEND_TOOL_NAME = 'mailbox_send';

const MESSAGE_TYPES: readonly AgentMessageType[] = [
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
];

/** The only Mailbox action exposed to the top-level B Agent. */
export class MailboxSendTool implements Tool<MailboxSendToolInput, MailboxToolOutcome> {
  readonly name = MAILBOX_SEND_TOOL_NAME;
  readonly description =
    'Send one task-scoped message to a visible teammate role. ' +
    'Use kind=request when a response is needed and kind=notice for durable information. ' +
    'When handling an inbound request, use the same tool to reply to its sender.';
  readonly inputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      to_role_id: {
        type: 'string',
        minLength: 1,
        description: 'Recipient role_id from the collaboration brief.',
      },
      kind: {
        type: 'string',
        enum: ['request', 'notice'],
        description: 'request waits for one business reply; notice is durable and non-waking.',
      },
      content: {
        type: 'string',
        minLength: 1,
        description: 'Human-readable message body.',
      },
      artifact_refs: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        description: 'Optional artifact IDs or URIs needed by the recipient.',
      },
    },
    required: ['to_role_id', 'kind', 'content'],
  };

  constructor(private readonly handler: MailboxSendToolHandler) {}

  execute(input: MailboxSendToolInput): Promise<MailboxToolOutcome> {
    return this.handler(input);
  }
}

export function expectsMailboxReply(type: AgentMessageType | MailboxMessageKind): boolean {
  if (type === 'request') return true;
  if (type === 'notice') return false;
  return (
    type === 'ask_help' ||
    type === 'review_request' ||
    type === 'proposal' ||
    type === 'decision_request'
  );
}

export function isAgentMessageType(value: unknown): value is AgentMessageType {
  return typeof value === 'string' && MESSAGE_TYPES.includes(value as AgentMessageType);
}
