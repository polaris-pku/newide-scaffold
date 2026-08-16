import { SCHEMA_VERSION } from '../core';
import type {
  AgentExecutionFacade,
  AgentExecutionOptions,
  AgentExecutionResult,
} from '../protocol/agent-execution';
import { expectsMailboxReply, type MailboxToolOutcome } from './mailbox-send-tool';
import type { PersistedMailboxDelivery } from './mailbox-state-store';
import type { PersistentMailboxService } from './persistent-mailbox-service';
import type { ParticipantSessionRegistry } from '../coordination/participant-session-registry';

export interface ProcessMailboxDeliveryInput {
  delivery_id: string;
  run_id: string;
  signal?: AbortSignal;
}

export interface ProcessMailboxDeliveryResult {
  status: 'replied' | 'acknowledged' | 'retryable_failure';
  source_delivery: PersistedMailboxDelivery;
  recipient_result?: AgentExecutionResult;
  reply?: MailboxToolOutcome;
  error?: string;
}

/** Executes one pending Delivery through the existing production Agent facade. */
export class MailboxDeliveryWorker {
  constructor(
    private readonly mailbox: PersistentMailboxService,
    private readonly agents: AgentExecutionFacade,
    private readonly sessions?: ParticipantSessionRegistry,
  ) {}

  async process(input: ProcessMailboxDeliveryInput): Promise<ProcessMailboxDeliveryResult> {
    const envelope = this.mailbox.getEnvelope(input.delivery_id);
    if (
      envelope.delivery.status !== 'pending' &&
      envelope.delivery.status !== 'injected'
    ) {
      return {
        status: envelope.delivery.status === 'acknowledged' ? 'acknowledged' : 'retryable_failure',
        source_delivery: envelope.delivery,
        ...(envelope.delivery.status === 'failed'
          ? { error: envelope.delivery.last_error?.message ?? 'Delivery failed' }
          : {}),
      };
    }
    const sessionId = this.sessions?.get(
      envelope.message.task_id,
      envelope.message.workspace_path,
      envelope.delivery.recipient_role_id,
    ) ?? this.mailbox.findLatestSession(
      envelope.message.task_id,
      envelope.message.workspace_path,
      envelope.delivery.recipient_role_id,
    );
    if (!sessionId) {
      return {
        status: 'retryable_failure',
        source_delivery: envelope.delivery,
        error:
          'COLLABORATION_DEADLOCK: recipient Session is not explicitly provisioned; ' +
          'register the role Session before delivering the request',
      };
    }
    const options: AgentExecutionOptions | undefined = input.signal
      ? { signal: input.signal }
      : undefined;
    try {
      const result = await this.agents.runAgent(
        {
          task_id: envelope.message.task_id,
          run_id: input.run_id,
          role_id: envelope.delivery.recipient_role_id,
          instruction: renderMailboxInstruction(envelope),
          workspace_path: envelope.message.workspace_path,
          session_id: sessionId,
          mailbox_delivery_id: envelope.delivery.delivery_id,
          input_artifact_refs: [...envelope.message.artifact_refs],
          context_policy: 'mailbox_delivery',
          schema_version: SCHEMA_VERSION,
        },
        options,
      );
      if (result.status !== 'completed') {
        const error = `Recipient Agent ended with status ${result.status}`;
        const attempted = this.mailbox.recordDeliveryAttempt(envelope.delivery.delivery_id, {
          code: 'RECIPIENT_AGENT_INCOMPLETE',
          message: error,
        });
        return { status: 'retryable_failure', source_delivery: attempted, recipient_result: result, error };
      }

      const current = this.mailbox.getEnvelope(envelope.delivery.delivery_id).delivery;
      const injected =
        current.status === 'pending'
          ? this.mailbox.markInjected(
              current.delivery_id,
              current.recipient_role_id,
              sessionId,
            )
          : current;
      const reply = findReplyOutcome(result, injected.delivery_id);
      if (reply) {
        return { status: 'replied', source_delivery: this.mailbox.getEnvelope(injected.delivery_id).delivery, recipient_result: result, reply };
      }
      if (expectsBusinessReply(envelope)) {
        const attempted = this.mailbox.recordDeliveryAttempt(injected.delivery_id, {
          code: 'RECIPIENT_REPLY_MISSING',
          message: 'Recipient Agent completed without a required business reply',
        });
        return {
          status: 'retryable_failure',
          source_delivery: attempted,
          recipient_result: result,
          error: 'Recipient Agent completed without a required business reply',
        };
      }
      const acknowledged =
        injected.status === 'injected'
          ? this.mailbox.ack(injected.delivery_id, injected.recipient_role_id)
          : injected;
      return { status: 'acknowledged', source_delivery: acknowledged, recipient_result: result };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      const current = this.mailbox.getEnvelope(envelope.delivery.delivery_id).delivery;
      if (current.status === 'acknowledged' || current.status === 'failed') {
        return {
          status: current.status === 'acknowledged' ? 'acknowledged' : 'retryable_failure',
          source_delivery: current,
          ...(current.status === 'failed' ? { error } : {}),
        };
      }
      const attempted = this.mailbox.recordDeliveryAttempt(current.delivery_id, {
        code: 'RECIPIENT_AGENT_FAILED',
        message: error,
      });
      return { status: 'retryable_failure', source_delivery: attempted, error };
    }
  }
}

function renderMailboxInstruction(
  envelope: ReturnType<PersistentMailboxService['getEnvelope']>,
): string {
  return [
    `Handle Mailbox delivery ${envelope.delivery.delivery_id} from ${envelope.message.from_role_id}.`,
    `Kind: ${envelope.message.kind ?? legacyMailboxKind(envelope.message.type) ?? 'notice'}`,
    `Content: ${envelope.message.content ?? legacyMailboxContent(envelope.message.payload) ?? JSON.stringify(envelope.message.payload)}`,
    ...(envelope.message.artifact_refs.length > 0
      ? [`Artifact refs: ${JSON.stringify(envelope.message.artifact_refs)}`]
      : []),
    expectsBusinessReply(envelope)
      ? 'Use invoke_driver to assess the request, then reply to the sender with mailbox_send.'
      : 'Use invoke_driver to consume this reply and continue the Task; do not send an acknowledgement message.',
    'Do not modify workspace files unless the message explicitly asks for an implementation handoff.',
  ].join('\n');
}

function expectsBusinessReply(
  envelope: ReturnType<PersistentMailboxService['getEnvelope']>,
): boolean {
  return (
    !envelope.message.reply_to_message_id &&
    expectsMailboxReply(legacyMailboxKind(envelope.message.type, envelope.message.kind))
  );
}

function legacyMailboxKind(
  type: Parameters<typeof expectsMailboxReply>[0],
  kind?: 'request' | 'notice',
): 'request' | 'notice' {
  if (kind) return kind;
  return type === 'request' || type === 'notice' || expectsMailboxReply(type) ? 'request' : 'notice';
}

function legacyMailboxContent(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  if (typeof payload.content === 'string' && payload.content.trim()) return payload.content;
  return JSON.stringify(payload);
}

function findReplyOutcome(
  result: AgentExecutionResult,
  sourceDeliveryId: string,
): MailboxToolOutcome | undefined {
  const outcomes = result.diagnostics.mailbox_outcomes;
  if (!Array.isArray(outcomes)) return undefined;
  return outcomes.find(
    (value): value is MailboxToolOutcome =>
      isMailboxToolOutcome(value) &&
      value.kind === 'reply' &&
      value.source_delivery_id === sourceDeliveryId,
  );
}

function isMailboxToolOutcome(value: unknown): value is MailboxToolOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const outcome = value as Partial<MailboxToolOutcome>;
  return (
    (outcome.kind === 'request' || outcome.kind === 'notice' || outcome.kind === 'reply') &&
      typeof outcome.message_id === 'string' &&
    typeof outcome.delivery_id === 'string' &&
    typeof outcome.wait_for_reply === 'boolean'
  );
}
