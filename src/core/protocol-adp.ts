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

// protocol 字段值 = "agent-driver"（ADP 的线名）。
export const ADP_PROTOCOL = 'agent-driver';
// §2.1 枚举冻结：v1 只有这两个 command。
export const ADP_COMMANDS = ['driver.invoke', 'driver.cancel'] as const;
export type AdpCommandName = (typeof ADP_COMMANDS)[number];
// ADP 独有 unknown：断连/超时且副作用不明 → 不得自动当 failed 重跑，先对账（§2.1）。
export const ADP_STATUSES = ['succeeded', 'failed', 'cancelled', 'unknown'] as const;
export type AdpStatus = (typeof ADP_STATUSES)[number];
// 副作用分级（§2.1）：重试决策 = 部署级 auto_retry[side_effect]，该配置不进信封。
// read_only 只读 / workspace_write 写工作区 / external 外部系统副作用。
export const ADP_SIDE_EFFECTS = ['read_only', 'workspace_write', 'external'] as const;
export type AdpSideEffect = (typeof ADP_SIDE_EFFECTS)[number];
// 回执的 result 字面量：四种 status 共用（示例 §4.4）。
export const ADP_RESULT = 'driver.invocation_result';

// 下行命令：A（经包裹层）→ D，发起一次驱动调用（示例 §4.3）。
// 业务两端 = A ↔ D，故 producer 钉 agent、consumer 钉 driver（fixture 权威口径）。
export const adpInvokeCommandSchema = z
  .object(
    envelopeShape({
      protocol: ADP_PROTOCOL,
      producer: 'agent',
      consumer: 'driver',
      variant: {
        command: z.literal('driver.invoke'), // 方向字段：「有 command」的那半边
        workspace: z.object({ path: z.string().min(1) }).strict(), // 工作区路径（§4.3 示例 {path}；strict 拒多余键）
        side_effect: z.enum(ADP_SIDE_EFFECTS), // 必填（§2.1 载荷必填 side_effect）；非法枚举值拒
        instruction: instructionSchema, // 必填指令 {text, ref}
      },
    }),
  )
  .strict(); // auto_retry 等部署配置塞进来 → 多余键拒收

// 下行命令：取消一个未终态的 invoke。与 SAP cancel 同构：
// 载荷必填 target_exchange_id，且 causation 必须指向该 invoke。
export const adpCancelCommandSchema = z
  .object(
    envelopeShape({
      protocol: ADP_PROTOCOL,
      producer: 'agent',
      consumer: 'driver',
      variant: {
        command: z.literal('driver.cancel'),
        target_exchange_id: z.string().min(1), // 要取消的那条 driver.invoke 的 exchange_id
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

// 上行回执：D → A（经包裹层，示例 §4.4）。身份对调：driver → agent。
// status×error：failed ⇒ error 必填；succeeded ⇒ error 必 null；
// cancelled / unknown 不限（unknown 的语义在 status 本身，不在 error）。
export const adpReceiptFrameSchema = receiptFrameBase({
  protocol: ADP_PROTOCOL,
  result: ADP_RESULT,
  statuses: ADP_STATUSES,
  requireError: ['failed'],
  forbidError: ['succeeded'],
  producer: 'driver',
  consumer: 'agent',
});

// ADP 三帧的并集：任一分支完整通过即通过，全不过 → 拒收。
export const adpFrameSchema = z.union([
  adpInvokeCommandSchema,
  adpCancelCommandSchema,
  adpReceiptFrameSchema,
]);
export type AdpFrame = z.infer<typeof adpFrameSchema>;
