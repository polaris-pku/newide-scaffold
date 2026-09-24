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

// 协议版本号：写进每一帧的 protocol_version；下面用 z.literal 钉死为 "1.0"。
// 任何一帧带别的版本（如 "2.0"）直接拒收——「类型、示例、枚举同版」靠这个常量统一。
export const PROTOCOL_VERSION = '1.0' as const;

// 三类协议的 protocol 字段取值（设计稿 §3/§4/§5 三个示例的头）：
// system-agent = SAP（System↔Agent）、agent-driver = ADP（A↔D）、agent-agent = AAP（A↔A）。
export const PROTOCOL_IDS = ['system-agent', 'agent-driver', 'agent-agent'] as const;
// typeof + [number] = 把常量数组收窄成字面量联合类型：
// 'system-agent' | 'agent-driver' | 'agent-agent'（不是宽泛的 string）。
export type ProtocolId = (typeof PROTOCOL_IDS)[number];
// z.enum(数组) = 运行时校验「值必须是数组之一」，并沿用上面的联合类型。
export const protocolIdSchema = z.enum(PROTOCOL_IDS);

// principal 的 kind 只有三种（设计稿 §1「身份只走 principal」）：
// system / agent / driver。会话等上下文走绑定表，不进每条消息。
export const PRINCIPAL_KINDS = ['system', 'agent', 'driver'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];
export const principalKindSchema = z.enum(PRINCIPAL_KINDS);

/**
 * Identity on the wire carries only `kind` + `role_id` — nothing else.
 * 信封上的 principal 只有这两个键；system / ADP 帧的 role_id 为 null。
 */
export const principalSchema = z
  .object({
    kind: principalKindSchema, // 枚举三选一
    role_id: z.string().min(1).nullable(), // 必填但可为 null；null = 无角色
  })
  .strict(); // 多余键（如 agent_id）拒收——对应反例「principal carrying an extra key」
export type ProtocolPrincipal = z.infer<typeof principalSchema>;

/**
 * Pins `kind` to a literal so a wrong identity is rejected at the field.
 * 工厂：为每一帧生成「kind 被钉死」的 principal schema。
 * 例：principalOfKind('system') 只接受 { kind: "system", role_id: ... }。
 * SAP execute 若把 producer 写成 driver，parse 在 producer.kind 这个路径上失败——
 * 报错直接指出是哪个键错，比事后 superRefine 笼统一句「身份不合法」精确。
 */
export function principalOfKind<K extends PrincipalKind>(kind: K) {
  return z.object({
    kind: z.literal(kind), // z.literal = 只接受这一个字面量值
    role_id: z.string().min(1).nullable(),
  }).strict();
}

// 回执错误的最小形状（设计稿 §2.1「error 最小形状（三协议共用）」：
//   error := null | { code, message, retryable }）。
// - code 非空串：对应「failed ⇒ 必填且 code 必有」
// - retryable 只是给人/上层的提示；真重试看部署级 auto_retry[side_effect]，不进信封
// - .strict() 拒收多余键——details/category 那套是 ApplicationErrorDataV1，不混进来
export const protocolErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();
export type ProtocolError = z.infer<typeof protocolErrorSchema>;

// 指令载荷：三协议 command 共用（示例 §3.1 / §4.3 / §5.3 均为 {text, ref}）。
// - text 非空：§2.1 各 command 的「载荷必填 instruction.text」
// - ref 可为 null 但键必须在：「不适用字段不省略，用 null 或 []」约定
export const instructionSchema = z
  .object({
    text: z.string().min(1),
    ref: z.string().nullable(),
  })
  .strict();
export type Instruction = z.infer<typeof instructionSchema>;

/**
 * The 11 shared envelope fields in frozen field order (protocol first,
 * direction fields last) so schema output key order — and therefore fixture
 * byte-level round-trips — stay stable.
 *
 * 泛型：P = 协议名字面量；V = 方向 variant 的额外字段（command 系或 receipt 系）。
 * 返回原始 shape 对象，由各协议文件用 z.object(...) 包裹成最终 schema。
 * 注意：下面对象的键序就是冻结字段序——zod 输出按 shape 键序排列，
 * 改动键序会破坏 fixture 的逐字节 round-trip 断言，等于改契约。
 */
export function envelopeShape<const P extends ProtocolId, V extends z.ZodRawShape>(opts: {
  protocol: P;
  producer: PrincipalKind;
  consumer: PrincipalKind;
  variant: V;
}) {
  return {
    // ---- 以下 11 个键 = 设计稿 §2 裁剪后的公共字段，顺序即契约 ----
    protocol: z.literal(opts.protocol), // 具体协议名，字面量钉死
    protocol_version: z.literal(PROTOCOL_VERSION), // 固定 "1.0"（见 PROTOCOL_VERSION）
    exchange_id: z.string().min(1), // 本帧唯一 id：投递边界 UNIQUE(consumer, protocol, exchange_id) 判重的键
    /**
     * Parent node: another protocol exchange or null only; calls leave
     * journal causation empty.
     * 因果语义（冻结）：只指向协议 exchange 或 null（根）；调用（工具调用/意图）
     * 不进因果图、其日志行该列留空；同 task/run 内排序靠 journal.seq。
     */
    causation_id: z.string().min(1).nullable(), // null = 因果树的根（如 §3.1 的 execute）
    task_id: z.string().min(1), // 业务任务 id（一条因果树挂在同一 task 下）
    run_id: z.string().min(1), // 本次运行 id（随帧记录，但不是会话绑定键）
    producer: principalOfKind(opts.producer), // 发送方身份；kind 按协议+方向钉死
    consumer: principalOfKind(opts.consumer), // 接收方身份；同上
    attempt: z.number().int().min(1), // 第几次尝试，从 1 起；重放同 exchange_id 时递增
    created_at: z.iso.datetime(), // ISO 8601 时间戳（zod4 的 z.iso.datetime()，要求 UTC Z 后缀）
    deadline_at: z.iso.datetime(), // 绝对截止时间（设计稿用绝对时间，不是相对秒数）
    ...opts.variant, // 方向字段永远殿后：有 command 或 有 result+status 恰好其一
  };
}

/**
 * Builds a receipt frame (`result + status + summary + error`) with the
 * cross-field rule: statuses in `requireError` must carry a non-null error,
 * statuses in `forbidError` must carry null.
 *
 * 泛型：P = 协议名；R = result 字面量；S = status 枚举元组（const 保留字面量类型）。
 * opts：
 * - statuses      该协议合法 status 全集（喂给 z.enum，跨协议串门即拒）
 * - requireError  这些 status 下 error 必须非 null（各协议的 failed）
 * - forbidError   这些 status 下 error 必须 null（completed / succeeded）
 * - producer/consumer  回执方向的身份（与同协议 command 方向相反）
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
          result: z.literal(opts.result), // 结果类型字面量，如 agent.execution_result
          status: z.enum(opts.statuses), // 状态枚举：SAP 帧带 unknown → 此键失败
          summary: z.string(), // 人读的一句结果摘要（必填；内容不强约束）
          error: protocolErrorSchema.nullable(), // 键必在；值 = null 或 {code, message, retryable}
        },
      }),
    )
    // .strict() 是方向判别的结构保证：回执帧敢带 command → 多余键拒收；
    // command 帧带 result/status 同理。两帧兼有/皆无都过不了 union 的所有分支。
    .strict()
    .superRefine((frame, ctx) => {
      // 跨字段规则 = §2.1 各协议 status 表的 error 列：
      if (opts.requireError.includes(frame.status) && frame.error === null) {
        ctx.addIssue({ // 造一条校验问题；path 指向出错的键，便于定位
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
      // 其余 status（cancelled / unknown）error 可 null 可非 null——协议没规定就不设卡。
    });
}

/**
 * Frozen P0 semantics of the session binding key (issue #145):
 * `task_id + workspace_path + role_id → session_id`. Freeze only — the live
 * registry stays in src/coordination/participant-session-registry.ts; do not
 * reimplement it here.
 * 只冻结键的组成（三个字段），run_id 不参与——见文件头「三条冻结语义」第 1 条。
 */
export interface SessionBindingKey {
  readonly task_id: string;
  readonly workspace_path: string;
  readonly role_id: string;
}
