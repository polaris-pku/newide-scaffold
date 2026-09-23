/**
 * AAP (Agent-Agent Protocol) v1 frames: the blocking one-question `agent.ask`
 * command and its `agent.reply` receipt. v1 ships question/answer only —
 * notices, cancels, parallel asks and multi-reply are out of scope.
 *
 * The reply carries no `command`, no `kind`, no `message_id` and no
 * `side_effect` (strict schemas reject all four): direction is implied by
 * `result`+`status`, and mailbox-internal `message_id` is mapped to
 * `exchange_id` only at the delivery boundary, never on the wire.
 */
import { z } from 'zod';
import { envelopeShape, instructionSchema, receiptFrameBase } from './protocol-envelope';

export const AAP_PROTOCOL = 'agent-agent';
export const AAP_COMMANDS = ['agent.ask'] as const;
export type AapCommandName = (typeof AAP_COMMANDS)[number];
export const AAP_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export type AapStatus = (typeof AAP_STATUSES)[number];
export const AAP_RESULT = 'agent.reply';

export const aapAskCommandSchema = z
  .object(
    envelopeShape({
      protocol: AAP_PROTOCOL,
      producer: 'agent',
      consumer: 'agent',
      variant: {
        command: z.literal('agent.ask'),
        instruction: instructionSchema,
      },
    }),
  )
  .strict();

export const aapReplyFrameSchema = receiptFrameBase({
  protocol: AAP_PROTOCOL,
  result: AAP_RESULT,
  statuses: AAP_STATUSES,
  requireError: ['failed'],
  forbidError: ['completed'],
  producer: 'agent',
  consumer: 'agent',
});

export const aapFrameSchema = z.union([aapAskCommandSchema, aapReplyFrameSchema]);
export type AapFrame = z.infer<typeof aapFrameSchema>;
