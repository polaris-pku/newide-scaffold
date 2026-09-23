/**
 * ADP (Agent-Driver Protocol) v1 frames: `driver.invoke` / `driver.cancel`
 * commands and the `driver.invocation_result` receipt. Business ends are
 * A ↔ D even though both frames are I/O-proxied by the wrapping layers.
 *
 * `auto_retry` is deployment config keyed by `side_effect` and never enters
 * the envelope (strict schemas reject it). `unknown` means the connection
 * dropped or timed out with side effects possibly applied — it must never be
 * auto-retried as `failed`; reconciliation runs first. Multi-frame progress
 * and `observed_effects` are deliberately not part of v1.
 */
import { z } from 'zod';
import { envelopeShape, instructionSchema, receiptFrameBase } from './protocol-envelope';

export const ADP_PROTOCOL = 'agent-driver';
export const ADP_COMMANDS = ['driver.invoke', 'driver.cancel'] as const;
export type AdpCommandName = (typeof ADP_COMMANDS)[number];
export const ADP_STATUSES = ['succeeded', 'failed', 'cancelled', 'unknown'] as const;
export type AdpStatus = (typeof ADP_STATUSES)[number];
export const ADP_SIDE_EFFECTS = ['read_only', 'workspace_write', 'external'] as const;
export type AdpSideEffect = (typeof ADP_SIDE_EFFECTS)[number];
export const ADP_RESULT = 'driver.invocation_result';

export const adpInvokeCommandSchema = z
  .object(
    envelopeShape({
      protocol: ADP_PROTOCOL,
      producer: 'agent',
      consumer: 'driver',
      variant: {
        command: z.literal('driver.invoke'),
        workspace: z.object({ path: z.string().min(1) }).strict(),
        side_effect: z.enum(ADP_SIDE_EFFECTS),
        instruction: instructionSchema,
      },
    }),
  )
  .strict();

export const adpCancelCommandSchema = z
  .object(
    envelopeShape({
      protocol: ADP_PROTOCOL,
      producer: 'agent',
      consumer: 'driver',
      variant: {
        command: z.literal('driver.cancel'),
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
        message: 'driver.cancel must causally point at the invoke it cancels (target_exchange_id)',
      });
    }
  });

export const adpReceiptFrameSchema = receiptFrameBase({
  protocol: ADP_PROTOCOL,
  result: ADP_RESULT,
  statuses: ADP_STATUSES,
  requireError: ['failed'],
  forbidError: ['succeeded'],
  producer: 'driver',
  consumer: 'agent',
});

export const adpFrameSchema = z.union([
  adpInvokeCommandSchema,
  adpCancelCommandSchema,
  adpReceiptFrameSchema,
]);
export type AdpFrame = z.infer<typeof adpFrameSchema>;
