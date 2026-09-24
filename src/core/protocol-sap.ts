/**
 * SAP (System ↔ Agent Protocol) v1 frames: `agent.execute` / `agent.cancel`
 * commands and the single `agent.execution_result` receipt. Enums are frozen
 * with the other two protocols by issue #145; SAP has no `unknown` status —
 * loss of contact is decided locally by System and never faked as a receipt,
 * and one execute takes at most one terminal receipt.
 */
import { z } from 'zod';
import { envelopeShape, instructionSchema, receiptFrameBase } from './protocol-envelope';

// protocol 字段值 = "system-agent"（SAP 的线名）。const 声明让类型就是字面量。
export const SAP_PROTOCOL = 'system-agent';
// §2.1 枚举冻结：v1 只有这两个 command。改枚举必须先改设计稿 §2.1 和这里。
export const SAP_COMMANDS = ['agent.execute', 'agent.cancel'] as const;
export type SapCommandName = (typeof SAP_COMMANDS)[number];
// SAP 没有 unknown：失联/超时由 System 本地判定，不伪造回执（§2.1 SAP status 表）。
export const SAP_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export type SapStatus = (typeof SAP_STATUSES)[number];
// 回执的 result 字面量：三种 status 共用这一个（两份设计稿均无 cancel 专用 result）。
export const SAP_RESULT = 'agent.execution_result';

// 下行命令：System → Agent，派发一次执行（示例 §3.1）。
// producer 钉 system、consumer 钉 agent——身份写反在 producer.kind 字段层就被拒。
export const sapExecuteCommandSchema = z
  .object(
    envelopeShape({
      protocol: SAP_PROTOCOL,
      producer: 'system',
      consumer: 'agent',
      variant: {
        command: z.literal('agent.execute'), // 方向字段之一：「有 command」的那半边
        council_seat: z.string().min(1).nullable(), // Council 席位名；单 Agent 时 null（键不省略）
        instruction: instructionSchema, // 必填指令 {text, ref}（§2.1 载荷必填 instruction.text）
      },
    }),
  )
  .strict(); // command 帧敢带 result/status → 多余键拒收（方向 XOR 的结构保证）

// 下行命令：取消一个未终态的 execute（§2.1：载荷必填 target_exchange_id，
// 且 causation 指向该 execute）。
export const sapCancelCommandSchema = z
  .object(
    envelopeShape({
      protocol: SAP_PROTOCOL,
      producer: 'system',
      consumer: 'agent',
      variant: {
        command: z.literal('agent.cancel'),
        target_exchange_id: z.string().min(1), // 要取消的那条 agent.execute 的 exchange_id
      },
    }),
  )
  .strict()
  .superRefine((frame, ctx) => {
    // 「causation 指向该 execute」的机器化：两字段不相等即拒
    // （例：causation 是 null 而 target 有值 → 拒；对应反例 agent.cancel causation not pointing at target）。
    if (frame.causation_id !== frame.target_exchange_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['causation_id'],
        message: 'agent.cancel must causally point at the execute it cancels (target_exchange_id)',
      });
    }
  });

// 上行回执：Agent → System（示例 §3.2）。身份对调：agent → system。
// status×error 交叉：failed ⇒ error 必填；completed ⇒ error 必 null；cancelled 不限。
export const sapReceiptFrameSchema = receiptFrameBase({
  protocol: SAP_PROTOCOL,
  result: SAP_RESULT,
  statuses: SAP_STATUSES, // z.enum 用：status 写成 succeeded/unknown（ADP 的词）→ 拒
  requireError: ['failed'],
  forbidError: ['completed'],
  producer: 'agent',
  consumer: 'system',
});

// SAP 三帧的并集。z.union 语义：按序试每个分支，任一分支完整通过即通过；
// 三帧全过不了（非法 status / 身份错 / 方向混用）→ 整体拒收。
export const sapFrameSchema = z.union([
  sapExecuteCommandSchema,
  sapCancelCommandSchema,
  sapReceiptFrameSchema,
]);
// z.infer 从 schema 反推 TS 联合类型——类型与运行时校验同源，改 schema 类型跟着变。
export type SapFrame = z.infer<typeof sapFrameSchema>;
