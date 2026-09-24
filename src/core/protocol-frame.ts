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

// 总并集 = P0 对外唯一校验入口。z.union 按序试三个协议的帧集：
// - 合法帧必在且只在一个协议的某分支里完整通过；
// - 方向 XOR 不靠事后 refine：command 系分支带 result/status、receipt 系分支带 command
//   都会被各自的 .strict() 以多余键拒掉；两边都不带则没有分支能通过；
// - 用普通 z.union 而非 discriminatedUnion：每个 protocol 值有多个 variant，
//   普通 union 行为等价、实现更简单。
export const protocolFrameSchema = z.union([sapFrameSchema, adpFrameSchema, aapFrameSchema]);
// 类型与校验同源：ProtocolFrame = 8 种合法帧（3 command + 2 cancel + 3 receipt）的联合。
export type ProtocolFrame = z.infer<typeof protocolFrameSchema>;
