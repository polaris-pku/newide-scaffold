import type { AgentMessageType } from '../core';
import type { Tool } from '../memory';

export interface MailboxSendToolInput {
  to_role_id: string;
  type: AgentMessageType;
  payload: Record<string, unknown>;
}

export interface MailboxToolOutcome {
  kind: 'request' | 'reply';
  message_id: string;
  delivery_id: string;
  thread_id: string;
  from_role_id: string;
  to_role_id: string;
  status: 'pending' | 'injected';
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
    'When handling an inbound Mailbox message, use the same tool to reply to its sender.';
  readonly inputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      to_role_id: {
        type: 'string',
        minLength: 1,
        description: 'Recipient role_id from the collaboration brief.',
      },
      type: {
        type: 'string',
        enum: MESSAGE_TYPES,
        description: 'Business message type.',
      },
      payload: {
        type: 'object',
        additionalProperties: true,
        description: 'Structured message content.',
      },
    },
    required: ['to_role_id', 'type', 'payload'],
  };

  constructor(private readonly handler: MailboxSendToolHandler) {}

  execute(input: MailboxSendToolInput): Promise<MailboxToolOutcome> {
    return this.handler(input);
  }
}

export function expectsMailboxReply(type: AgentMessageType): boolean {
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
