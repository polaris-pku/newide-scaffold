/**
 * SAP (System ↔ Agent Protocol) v1 frames: `agent.execute` / `agent.cancel`
 * commands and the single `agent.execution_result` receipt. Enums are frozen
 * with the other two protocols by issue #145; SAP has no `unknown` status —
 * loss of contact is decided locally by System and never faked as a receipt,
 * and one execute takes at most one terminal receipt.
 */
import { z } from 'zod';
import { envelopeShape, instructionSchema, receiptFrameBase } from './protocol-envelope';

export const SAP_PROTOCOL = 'system-agent';
export const SAP_COMMANDS = ['agent.execute', 'agent.cancel'] as const;
export type SapCommandName = (typeof SAP_COMMANDS)[number];
export const SAP_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export type SapStatus = (typeof SAP_STATUSES)[number];
export const SAP_RESULT = 'agent.execution_result';

export const sapExecuteCommandSchema = z
  .object(
    envelopeShape({
      protocol: SAP_PROTOCOL,
      producer: 'system',
      consumer: 'agent',
      variant: {
        command: z.literal('agent.execute'),
        council_seat: z.string().min(1).nullable(),
        instruction: instructionSchema,
      },
    }),
  )
  .strict();

export const sapCancelCommandSchema = z
  .object(
    envelopeShape({
      protocol: SAP_PROTOCOL,
      producer: 'system',
      consumer: 'agent',
      variant: {
        command: z.literal('agent.cancel'),
        target_exchange_id: z.string().min(1),
      },
    }),
  )
  .strict()
  .superRefine((frame, ctx) => {
    if (frame.causation_id !== frame.target_exchange_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['causation_id'],
        message: 'agent.cancel must causally point at the execute it cancels (target_exchange_id)',
      });
    }
  });

export const sapReceiptFrameSchema = receiptFrameBase({
  protocol: SAP_PROTOCOL,
  result: SAP_RESULT,
  statuses: SAP_STATUSES,
  requireError: ['failed'],
  forbidError: ['completed'],
  producer: 'agent',
  consumer: 'system',
});

export const sapFrameSchema = z.union([
  sapExecuteCommandSchema,
  sapCancelCommandSchema,
  sapReceiptFrameSchema,
]);
export type SapFrame = z.infer<typeof sapFrameSchema>;
