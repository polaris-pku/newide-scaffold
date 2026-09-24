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

// protocol 字段值 = "agent-agent"（AAP 的线名）。
export const AAP_PROTOCOL = 'agent-agent';
// §2.1 枚举冻结：v1 只有 agent.ask 一问（notice/cancel 不进本波）。
export const AAP_COMMANDS = ['agent.ask'] as const;
export type AapCommandName = (typeof AAP_COMMANDS)[number];
// 与 SAP 同集合、无 unknown：阻塞超时由发件方本地判定，不产生 reply（§2.1/§5.4）。
export const AAP_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export type AapStatus = (typeof AAP_STATUSES)[number];
// 回执的 result 字面量（示例 §5.4）。
export const AAP_RESULT = 'agent.reply';

// 下行问句：A → B，发件方阻塞等回信或 deadline_at 超时（示例 §5.3）。
// 两端都是 agent（role_id 区分具体角色）。
// 注意：阻塞上限用的是公共字段里的 deadline_at（§2.1 载荷必填），variant 里不再重复。
export const aapAskCommandSchema = z
  .object(
    envelopeShape({
      protocol: AAP_PROTOCOL,
      producer: 'agent',
      consumer: 'agent',
      variant: {
        command: z.literal('agent.ask'), // 方向字段：「有 command」的那半边
        instruction: instructionSchema, // 必填指令 {text, ref}
      },
    }),
  )
  .strict();

// 上行回信：B → A（示例 §5.4）。reply 只有 result+status 那半边：
// 没有 command 键（方向靠「有 result+status」表达）；
// message_id / side_effect / kind 若被塞进来，.strict() 以多余键拒收。
// status×error：failed ⇒ 必填；completed ⇒ 必 null（与 SAP 相同）。
export const aapReplyFrameSchema = receiptFrameBase({
  protocol: AAP_PROTOCOL,
  result: AAP_RESULT,
  statuses: AAP_STATUSES,
  requireError: ['failed'],
  forbidError: ['completed'],
  producer: 'agent',
  consumer: 'agent',
});

// AAP 两帧的并集：问 / 答，任一通过即全通过。
export const aapFrameSchema = z.union([aapAskCommandSchema, aapReplyFrameSchema]);
export type AapFrame = z.infer<typeof aapFrameSchema>;
