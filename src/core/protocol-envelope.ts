/**
 * Communication Protocol v1 shared envelope: the common fields, principal
 * identity, the minimal error shape, the instruction payload, and the receipt
 * base shared by SAP / ADP / AAP frames. Runtime authority is zod; downstream
 * directions (P1/A1/B1/C1) must depend on these exports via the src/core
 * barrel instead of copying the contract.
 *
 * Frozen global semantics (P0, issue #145):
 * - Session binding key is `task_id + workspace_path + role_id → session_id`;
 *   `run_id` travels on every frame but is not part of the key. The live
 *   implementation stays in src/coordination/participant-session-registry.ts.
 * - `causation_id` only points at another protocol exchange (or null for a
 *   root). Calls never enter the causal graph — their journal rows leave the
 *   column empty; ordering inside one task/run is `journal.seq`.
 * - Direction is exactly one of: `command` present, or `result`+`status`
 *   present. Receipts are `result + status + summary + error` with
 *   `error := null | { code, message, retryable }`. `retryable` is a hint
 *   only; real retries are deployment-level `auto_retry[side_effect]`, which
 *   never enters the envelope.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = '1.0' as const;

export const PROTOCOL_IDS = ['system-agent', 'agent-driver', 'agent-agent'] as const;
export type ProtocolId = (typeof PROTOCOL_IDS)[number];
export const protocolIdSchema = z.enum(PROTOCOL_IDS);

export const PRINCIPAL_KINDS = ['system', 'agent', 'driver'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];
export const principalKindSchema = z.enum(PRINCIPAL_KINDS);

/** Identity on the wire carries only `kind` + `role_id` — nothing else. */
export const principalSchema = z
  .object({
    kind: principalKindSchema,
    role_id: z.string().min(1).nullable(),
  })
  .strict();
export type ProtocolPrincipal = z.infer<typeof principalSchema>;

/** Pins `kind` to a literal so a wrong identity is rejected at the field. */
export function principalOfKind<K extends PrincipalKind>(kind: K) {
  return z
    .object({
      kind: z.literal(kind),
      role_id: z.string().min(1).nullable(),
    })
    .strict();
}

export const protocolErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();
export type ProtocolError = z.infer<typeof protocolErrorSchema>;

export const instructionSchema = z
  .object({
    text: z.string().min(1),
    ref: z.string().nullable(),
  })
  .strict();
export type Instruction = z.infer<typeof instructionSchema>;

/**
 * The 12 shared envelope fields in frozen field order (protocol first,
 * direction fields last) so schema output key order — and therefore fixture
 * byte-level round-trips — stay stable.
 */
export function envelopeShape<const P extends ProtocolId, V extends z.ZodRawShape>(opts: {
  protocol: P;
  producer: PrincipalKind;
  consumer: PrincipalKind;
  variant: V;
}) {
  return {
    protocol: z.literal(opts.protocol),
    protocol_version: z.literal(PROTOCOL_VERSION),
    exchange_id: z.string().min(1),
    /** Protocol exchange or null only; calls leave journal causation empty. */
    causation_id: z.string().min(1).nullable(),
    task_id: z.string().min(1),
    run_id: z.string().min(1),
    producer: principalOfKind(opts.producer),
    consumer: principalOfKind(opts.consumer),
    attempt: z.number().int().min(1),
    created_at: z.iso.datetime(),
    deadline_at: z.iso.datetime(),
    ...opts.variant,
  };
}

/**
 * Builds a receipt frame (`result + status + summary + error`) with the
 * cross-field rule: statuses in `requireError` must carry a non-null error,
 * statuses in `forbidError` must carry null.
 */
export function receiptFrameBase<
  const P extends ProtocolId,
  const R extends string,
  const S extends readonly [string, ...string[]],
>(opts: {
  protocol: P;
  result: R;
  statuses: S;
  requireError: readonly string[];
  forbidError: readonly string[];
  producer: PrincipalKind;
  consumer: PrincipalKind;
}) {
  return z
    .object(
      envelopeShape({
        protocol: opts.protocol,
        producer: opts.producer,
        consumer: opts.consumer,
        variant: {
          result: z.literal(opts.result),
          status: z.enum(opts.statuses),
          summary: z.string(),
          error: protocolErrorSchema.nullable(),
        },
      }),
    )
    .strict()
    .superRefine((frame, ctx) => {
      if (opts.requireError.includes(frame.status) && frame.error === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['error'],
          message: `error is required when status is "${frame.status}"`,
        });
      }
      if (opts.forbidError.includes(frame.status) && frame.error !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['error'],
          message: `error must be null when status is "${frame.status}"`,
        });
      }
    });
}

/**
 * Frozen P0 semantics of the session binding key (issue #145):
 * `task_id + workspace_path + role_id → session_id`. Freeze only — the live
 * registry stays in src/coordination/participant-session-registry.ts; do not
 * reimplement it here.
 */
export interface SessionBindingKey {
  readonly task_id: string;
  readonly workspace_path: string;
  readonly role_id: string;
}
