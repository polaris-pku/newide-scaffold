/**
 * Top-level Communication Protocol v1 frame: the union of every SAP, ADP and
 * AAP frame. This is the single dependency surface P0 freezes for the A/B/C
 * directions — validate untrusted frames with `protocolFrameSchema`.
 *
 * Frozen global semantics (P0, issue #145):
 * - Session binding: `task_id + workspace_path + role_id → session_id`
 *   (`run_id` rides every frame but is not part of the key).
 * - Causality: `causation_id` points only at protocol exchanges or null;
 *   calls never enter the causal graph and their journal rows leave the
 *   column empty; ordering within one task/run is `journal.seq`.
 * - Direction: exactly one of `command` vs `result`+`status`; receipts are
 *   `result + status + summary + error` across all three protocols.
 *
 * This module re-exports only the union and its type; the per-protocol
 * schemas come out of the core barrel directly, keeping the star-export
 * surface unambiguous.
 */
import { z } from 'zod';
import { aapFrameSchema } from './protocol-aap';
import { adpFrameSchema } from './protocol-adp';
import { sapFrameSchema } from './protocol-sap';

export const protocolFrameSchema = z.union([sapFrameSchema, adpFrameSchema, aapFrameSchema]);
export type ProtocolFrame = z.infer<typeof protocolFrameSchema>;
