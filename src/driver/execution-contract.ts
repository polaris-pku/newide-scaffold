/**
 * 执行契约（阶段 1）：ExecutionBrief / ExecutionEvidence / Dispatch Journal 行 /
 * 折叠后的 DispatchRecord 的**唯一 schema 来源**。
 *
 * 职责与核心逻辑：
 * - 把「role 可以说什么」与「宿主填什么」分成两个 schema：`RoleExecutionRequestSchema`
 *   是 role 提供的**内容字段**（`.strict()`，出现 `dispatch_id` 等宿主身份键会被拒收），
 *   `ExecutionBriefSchema` 才是落盘的完整 brief；`buildExecutionBrief` 是宿主侧唯一构造入口，
 *   负责填身份、规范化只读语义、并校验 `reuse` 的 Session 确实属于本 role/run 且已被确认。
 * - `ExecutionEvidenceSchema` 固定 transport 为两个**正交字段**：
 *   `transport.evidence`（`not_executed | execution_unconfirmed`，沿用
 *   `driver-transport-error.ts` 的两值）与 `transport.result_received`（布尔）。
 *   禁止合并成三值状态；runner 进程退出码只允许出现在 `transport.runner_exit_code`，
 *   不能冒充 `checks[].exit_code`（本仓拿不到命令级退出码，见 RD-EVD-03）。
 * - usage 缺失一律 `missing: true` + `source: 'none'`，不得填 0；driver 回复里的字符串
 *   只能落到 `driver_reported`，runner exit 0 不等于检查通过。
 * - Journal 行与折叠记录也在这里定义：append-only 文件本身由
 *   `src/persistence/run-dispatch-journal.ts` 实现，本文件只做协议/语义校验；
 *   `DispatchJournalPort` 是写屏障编排（`dispatch-attempt.ts`）依赖的最小端口，
 *   避免 driver 模块反向依赖 persistence 的运行时实现。
 * - 语义交叉校验尽量放进 schema（`.superRefine`），解析即拒绝，避免「先落盘再发现矛盾」。
 *
 * 本文件不读写文件、不调用 driver，也不改变任何生产默认路径。
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createId } from '../core';
import type { DriverUsage } from './contract';
import type { DriverExecutionEvidence } from './driver-transport-error';

// ─────────────────────────────────────────────────────────────
// 常量与版本
// ─────────────────────────────────────────────────────────────

/** 业务契约代次；与 schema_version（以 `.v1` 结尾的本地 schema 标识）独立。 */
export const EXECUTION_CONTRACT_VERSION = 2;

export const EXECUTION_BRIEF_SCHEMA_VERSION = 'newide.execution_brief.v1';
export const EXECUTION_EVIDENCE_SCHEMA_VERSION = 'newide.execution_evidence.v1';
export const DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION = 'newide.dispatch_journal_entry.v1';
export const DISPATCH_RECORD_SCHEMA_VERSION = 'newide.dispatch_record.v1';

/** 单次派工默认超时（设计 §5：10 分钟）。 */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 600_000;

/**
 * Driver 报告回传给 Role 的截断长度。默认 2,000 字符（既有行为）；部署/实验可用
 * `NEWIDE_ROLE_RESPONSE_EXCERPT_CHARS` 放大，让 Role 读到报告后段的失败与限制。
 * schema 上限固定为 20,000，避免凭环境变量把持久化 evidence 撑到不可控大小。
 */
const DEFAULT_RESPONSE_EXCERPT_CHARS = 2_000;
const MAX_RESPONSE_EXCERPT_CHARS = 20_000;

function responseExcerptChars(): number {
  const raw = process.env.NEWIDE_ROLE_RESPONSE_EXCERPT_CHARS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_RESPONSE_EXCERPT_CHARS;
  return Math.min(parsed, MAX_RESPONSE_EXCERPT_CHARS);
}

export const EXECUTION_KINDS = ['investigate', 'execute', 'verify'] as const;
export const EXECUTION_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
] as const;
export const JOURNAL_VIOLATIONS = [
  'read_only_changed',
  'scope_unconfirmed',
  'evidence_missing',
  'journal_recovered',
] as const;

// ─────────────────────────────────────────────────────────────
// 基础工具：id / hash / ref / canonical JSON
// ─────────────────────────────────────────────────────────────

const IdSchema = z.string().trim().min(1).max(256);
export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex characters');

/**
 * evidence ref 的 path 必须是**相对路径**：拒绝绝对路径、盘符/协议前缀（含 `file://`）、
 * 反斜杠、空段与 `.`/`..` 目录穿越。真正的「已登记」校验在受控读取层（ref registry）做。
 */
export function isSafeRelativeRefPath(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  // `file://`、`C:`、`http:` 之类都带 scheme 前缀。
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
  if (value.includes('\\')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export const EvidenceRefSchema = z
  .object({
    path: z.string().min(1).max(1024).refine(isSafeRelativeRefPath, {
      message: 'evidence ref path must be a safe relative path (no absolute paths, file://, or ..)',
    }),
    sha256: Sha256Schema,
  })
  .strict();

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** 递归按键排序的 JSON：同一对象不同键序得到同一字符串，保证 hash 可重算。 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) sorted[key] = sortJsonValue(item);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashJsonValue(value: unknown): string {
  return sha256Hex(canonicalJsonStringify(value));
}

// ─────────────────────────────────────────────────────────────
// 契约违例（宿主校验失败的稳定错误类型）
// ─────────────────────────────────────────────────────────────

export type ExecutionContractViolationCode =
  | 'brief_invalid'
  | 'role_supplied_host_identity'
  | 'investigate_must_be_read_only'
  | 'execute_must_not_be_read_only'
  | 'session_reuse_requires_session_id'
  | 'session_reuse_unconfirmed'
  | 'brief_hash_mismatch'
  | 'retry_not_allowed'
  | 'retry_without_evidence'
  | 'evidence_inconsistent';

/** 宿主侧校验失败：调用方据此返回 typed error，**不得**降级成「继续执行」。 */
export class ExecutionContractViolation extends Error {
  constructor(
    readonly code: ExecutionContractViolationCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ExecutionContractViolation';
  }
}

// ─────────────────────────────────────────────────────────────
// ExecutionBrief
// ─────────────────────────────────────────────────────────────

export const ExecutionKindSchema = z.enum(EXECUTION_KINDS);
export type ExecutionKind = z.infer<typeof ExecutionKindSchema>;

export const ExecutionSessionSchema = z
  .object({
    mode: z.enum(['fresh', 'reuse']).default('fresh'),
    session_id: IdSchema.optional(),
  })
  .strict()
  .superRefine((session, ctx) => {
    // RD-DIS-03：只有显式 reuse 才带 session_id；fresh 不允许夹带。
    if (session.mode === 'reuse' && !session.session_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['session_id'],
        message: 'session.mode=reuse requires session_id',
      });
    }
    if (session.mode === 'fresh' && session.session_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['session_id'],
        message: 'session.mode=fresh must not carry session_id',
      });
    }
  });

export type ExecutionSession = z.infer<typeof ExecutionSessionSchema>;

/** Explicit argv for a local verification dispatch; never parsed from free-form instructions. */
export const VerificationCommandSchema = z
  .object({
    executable: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine((value) => !value.includes('\0')),
    args: z
      .array(
        z
          .string()
          .max(8_000)
          .refine((value) => !value.includes('\0')),
      )
      .max(128)
      .default([]),
  })
  .strict()
  .refine(
    (command) =>
      [command.executable, ...command.args].map((part) => JSON.stringify(part)).join(' ').length <=
      4_096,
    'verification command exceeds the evidence command size limit',
  );

/**
 * role 可提供的内容字段。`.strict()` 是身份防伪的第一道门：role 试图塞
 * `dispatch_id` / `task_id` / `run_id` / `role_id` / `sequence` / `accepted_at` 会被拒收。
 */
export const RoleExecutionRequestSchema = z
  .object({
    kind: ExecutionKindSchema,
    read_only: z.boolean().optional(),
    verification_command: VerificationCommandSchema.optional(),
    instruction: z.string().trim().min(1).max(24_000),
    acceptance: z.array(z.string().trim().min(1).max(2_000)).max(32).optional().default([]),
    constraints: z.array(z.string().trim().min(1).max(2_000)).max(32).optional().default([]),
    expected_artifacts: z.array(z.string().min(1).max(1_024)).max(32).optional().default([]),
    retry_of: IdSchema.optional(),
    reconciliation_ref: EvidenceRefSchema.optional(),
    session: ExecutionSessionSchema.optional().default({ mode: 'fresh' }),
    timeout_ms: z
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .optional()
      .default(DEFAULT_DISPATCH_TIMEOUT_MS),
  })
  .strict();

export type RoleExecutionRequest = z.infer<typeof RoleExecutionRequestSchema>;

const HOST_IDENTITY_KEYS = [
  'dispatch_id',
  'task_id',
  'run_id',
  'role_id',
  'sequence',
  'accepted_at',
  'brief_sha256',
  'budget_before',
] as const;

/**
 * 完整 brief（落盘形态）：宿主身份字段齐全。
 * `read_only` 在宿主构造时已按 kind 规范化，落盘后是确定布尔值。
 */
export const ExecutionBriefSchema = z
  .object({
    schema_version: z.literal(EXECUTION_BRIEF_SCHEMA_VERSION),
    contract_version: z.literal(EXECUTION_CONTRACT_VERSION),
    // 宿主身份（RD-DIS-02）：role/driver 不可伪造或覆盖。
    dispatch_id: IdSchema,
    task_id: IdSchema,
    run_id: IdSchema,
    role_id: IdSchema,
    sequence: z.number().int().positive(),
    accepted_at: z.iso.datetime(),
    // role 内容字段
    kind: ExecutionKindSchema,
    read_only: z.boolean(),
    verification_command: VerificationCommandSchema.optional(),
    instruction: z.string().trim().min(1).max(24_000),
    acceptance: z.array(z.string().trim().min(1).max(2_000)).max(32),
    constraints: z.array(z.string().trim().min(1).max(2_000)).max(32),
    expected_artifacts: z.array(z.string().min(1).max(1_024)).max(32),
    retry_of: IdSchema.optional(),
    reconciliation_ref: EvidenceRefSchema.optional(),
    session: ExecutionSessionSchema,
    timeout_ms: z.number().int().min(1_000).max(3_600_000),
  })
  .strict()
  .superRefine((brief, ctx) => {
    if (
      brief.verification_command !== undefined &&
      (brief.kind !== 'verify' || brief.session.mode !== 'fresh')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['verification_command'],
        message: 'verification_command requires kind=verify and session.mode=fresh',
      });
    }
    if (brief.kind === 'investigate' && brief.read_only !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['read_only'],
        message: 'investigate briefs must be read-only',
      });
    }
    if (brief.kind === 'execute' && brief.read_only !== false) {
      ctx.addIssue({
        code: 'custom',
        path: ['read_only'],
        message: 'execute briefs must not be read-only',
      });
    }
    if (brief.retry_of !== undefined && brief.retry_of === brief.dispatch_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['retry_of'],
        message: 'retry_of must reference a different dispatch_id',
      });
    }
  });

export type ExecutionBrief = z.infer<typeof ExecutionBriefSchema>;

/** 宿主已知且已确认的 Session：只允许本 role/run 的 session 被 reuse。 */
export interface ConfirmedDriverSession {
  session_id: string;
  run_id: string;
  role_id: string;
  driver_id?: string;
}

export interface ExecutionBriefHostIdentity {
  dispatch_id: string;
  task_id: string;
  run_id: string;
  role_id: string;
  sequence: number;
  accepted_at?: string;
}

export interface BuiltExecutionBrief {
  brief: ExecutionBrief;
  brief_sha256: string;
}

export function hashExecutionBrief(brief: ExecutionBrief): string {
  return hashJsonValue(brief);
}

/** 重算并比对 brief hash；不一致即拒绝（fail closed）。 */
export function verifyExecutionBrief(brief: ExecutionBrief, brief_sha256: string): void {
  if (hashExecutionBrief(brief) !== brief_sha256) {
    throw new ExecutionContractViolation(
      'brief_hash_mismatch',
      `brief hash mismatch for dispatch ${brief.dispatch_id}`,
    );
  }
}

/**
 * 按 kind 固定只读语义（RD-DIS-01）：
 * - investigate 必须只读（role 显式 `false` 视为契约违例，不是「悄悄改回 true」）；
 * - execute 必然是写；
 * - verify 缺省只读，产生测试缓存/快照时必须显式 `read_only:false`。
 */
export function normalizeReadOnlyForKind(
  kind: ExecutionKind,
  readOnly: boolean | undefined,
): boolean {
  if (kind === 'investigate') {
    if (readOnly === false) {
      throw new ExecutionContractViolation(
        'investigate_must_be_read_only',
        'investigate brief must be read-only',
      );
    }
    return true;
  }
  if (kind === 'execute') {
    if (readOnly === true) {
      throw new ExecutionContractViolation(
        'execute_must_not_be_read_only',
        'execute brief cannot be read-only',
      );
    }
    return false;
  }
  // verify: 缺省只读；写测试缓存/快照要显式声明 false 并解释。
  return readOnly ?? true;
}

export interface BuildExecutionBriefInput {
  identity: ExecutionBriefHostIdentity;
  request: unknown;
  /** 宿主确认过的本 run/role Session 集合；reuse 时必须命中。 */
  confirmed_sessions?: readonly ConfirmedDriverSession[];
}

/**
 * 宿主侧唯一 Brief 构造入口。role 的原始请求先过严格 schema（伪造身份键直接拒收），
 * 再由宿主填入身份并校验 Session reuse 的**归属与确认状态**（不能只靠 schema 形状）。
 */
export function buildExecutionBrief(input: BuildExecutionBriefInput): BuiltExecutionBrief {
  assertNoHostIdentityKeys(input.request);
  let request: RoleExecutionRequest;
  try {
    request = RoleExecutionRequestSchema.parse(input.request);
  } catch (error) {
    throw new ExecutionContractViolation(
      'brief_invalid',
      'execution brief request is invalid',
      error,
    );
  }

  if (
    request.verification_command !== undefined &&
    (request.kind !== 'verify' || request.session.mode !== 'fresh')
  ) {
    throw new ExecutionContractViolation(
      'brief_invalid',
      'verification_command requires kind=verify and session.mode=fresh',
    );
  }
  const readOnly = normalizeReadOnlyForKind(request.kind, request.read_only);
  if (request.session.mode === 'reuse') {
    const sessionId = request.session.session_id;
    if (!sessionId) {
      throw new ExecutionContractViolation(
        'session_reuse_requires_session_id',
        'reuse session requires session_id',
      );
    }
    const confirmed = (input.confirmed_sessions ?? []).some(
      (session) =>
        session.session_id === sessionId &&
        session.run_id === input.identity.run_id &&
        session.role_id === input.identity.role_id,
    );
    if (!confirmed) {
      throw new ExecutionContractViolation(
        'session_reuse_unconfirmed',
        `session ${sessionId} is not a confirmed session of role ${input.identity.role_id} in run ${input.identity.run_id}`,
      );
    }
  }

  const acceptedAt = input.identity.accepted_at ?? new Date().toISOString();
  const brief = ExecutionBriefSchema.parse({
    schema_version: EXECUTION_BRIEF_SCHEMA_VERSION,
    contract_version: EXECUTION_CONTRACT_VERSION,
    dispatch_id: input.identity.dispatch_id,
    task_id: input.identity.task_id,
    run_id: input.identity.run_id,
    role_id: input.identity.role_id,
    sequence: input.identity.sequence,
    accepted_at: acceptedAt,
    kind: request.kind,
    read_only: readOnly,
    ...(request.verification_command !== undefined
      ? { verification_command: request.verification_command }
      : {}),
    instruction: request.instruction,
    acceptance: request.acceptance,
    constraints: request.constraints,
    expected_artifacts: request.expected_artifacts,
    ...(request.retry_of !== undefined ? { retry_of: request.retry_of } : {}),
    ...(request.reconciliation_ref !== undefined
      ? { reconciliation_ref: request.reconciliation_ref }
      : {}),
    session: request.session,
    timeout_ms: request.timeout_ms,
  });
  return { brief, brief_sha256: hashExecutionBrief(brief) };
}

function assertNoHostIdentityKeys(request: unknown): void {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return;
  const found = HOST_IDENTITY_KEYS.filter((key) => key in (request as Record<string, unknown>));
  if (found.length > 0) {
    throw new ExecutionContractViolation(
      'role_supplied_host_identity',
      `role request must not supply host identity fields: ${found.join(', ')}`,
      { fields: found },
    );
  }
}

// ─────────────────────────────────────────────────────────────
// ExecutionEvidence
// ─────────────────────────────────────────────────────────────

export const ExecutionStatusSchema = z.enum(EXECUTION_STATUSES);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const JournalViolationSchema = z.enum(JOURNAL_VIOLATIONS);
export type JournalViolation = z.infer<typeof JournalViolationSchema>;

/**
 * 检查观测：`provenance` 只有 host_observed / driver_reported；
 * `observation` 表示取回的数据完整度。runner 进程退出码**不是**命令级退出码，
 * 构造时不允许把它填进 `exit_code`（`DriverAttemptObservation` 里它只在 transport 下）。
 */
export const ExecutionCheckSchema = z
  .object({
    command: z.string().trim().min(1).max(4_096).optional(),
    exit_code: z.number().int().nullable().optional(),
    stdout_ref: EvidenceRefSchema.optional(),
    stderr_ref: EvidenceRefSchema.optional(),
    provenance: z.enum(['host_observed', 'driver_reported']),
    observation: z.enum(['complete', 'partial', 'missing']),
    /**
     * 证据适用对象（工作区相对路径，交付产物目标）。host_observed 检查只有作用于最终
     * 交付对象时才能支撑 completed；旧行为/旧数据可缺省。
     */
    target_paths: z.array(z.string().trim().min(1).max(1_024)).max(256).optional(),
    /**
     * 被检查内容身份（工作区 canonical 内容指纹）。只有 Driver 在命令结束时上报、宿主独立重算
     * 比对通过的指纹才会写入（`driver.command_observed.checked_workspace_sha256`）；finish 校验时
     * 与当前最终内容指纹比较，不一致即「旧版本成功后又修改」→ 过期证据，不能支撑 completed。
     * 事件到达时刻的快照不能直接冒充该值（见 `command-observation.ts`）。
     */
    workspace_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    /** 观察时间（ISO）；仅作审计，不替代指纹过期判定。 */
    observed_at: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine((check, ctx) => {
    const hasObservedData =
      (check.exit_code !== undefined && check.exit_code !== null) ||
      check.stdout_ref !== undefined ||
      check.stderr_ref !== undefined;
    if (check.provenance === 'host_observed' && !hasObservedData) {
      ctx.addIssue({
        code: 'custom',
        path: ['provenance'],
        message: 'host_observed check requires exit_code/stdout_ref/stderr_ref',
      });
    }
    if (check.observation === 'complete' && !hasObservedData) {
      ctx.addIssue({
        code: 'custom',
        path: ['observation'],
        message: 'observation=complete requires retrieved command-level data',
      });
    }
    if (check.observation === 'missing' && hasObservedData) {
      ctx.addIssue({
        code: 'custom',
        path: ['observation'],
        message: 'observation=missing must not carry retrieved data',
      });
    }
  });

export type ExecutionCheck = z.infer<typeof ExecutionCheckSchema>;

/**
 * transport 证据：两个并列正交字段（RD-EVD-05）。
 * `evidence` 只表达 transport 层两值事实；`result_received` 独立表达
 * **是否收到过 DriverRunResult**——它不等于「执行结局已确认」：
 * driver 返回 failed + EXTERNAL_DRIVER_TRANSPORT_ERROR 时 ADP 结局是 unknown，
 * 但 result 对象确实已收到，因此 `unknown + result_received=true + execution_unconfirmed`
 * 是合法组合；启动失败才是 `failed + false + not_executed`。
 * 禁止把 result_received 并入 evidence 枚举。
 */
export const TransportEvidenceSchema = z
  .object({
    evidence: z.enum(['not_executed', 'execution_unconfirmed']),
    result_received: z.boolean(),
    /**
     * 旧持久化数据缺少「是否收到结果」事实时的显式缺失标记（兼容字段）：
     * 只允许与 `result_received=false + execution_unconfirmed` 同现，不凭空猜测。
     */
    result_received_missing: z.boolean().optional(),
    /** runner 进程退出码（不是检查命令退出码）。 */
    runner_exit_code: z.number().int().nullable().optional(),
    signal: z.string().min(1).max(200).optional(),
    stderr_ref: EvidenceRefSchema.optional(),
  })
  .strict()
  .superRefine((transport, ctx) => {
    if (transport.evidence === 'not_executed' && transport.result_received) {
      ctx.addIssue({
        code: 'custom',
        path: ['result_received'],
        message: 'not_executed transport evidence cannot carry a received result',
      });
    }
    if (transport.result_received_missing === true) {
      if (transport.result_received) {
        ctx.addIssue({
          code: 'custom',
          path: ['result_received_missing'],
          message: 'result_received_missing cannot claim a received result',
        });
      }
      if (transport.evidence !== 'execution_unconfirmed') {
        ctx.addIssue({
          code: 'custom',
          path: ['result_received_missing'],
          message: 'result_received_missing requires execution_unconfirmed transport evidence',
        });
      }
    }
  });

export type TransportEvidence = z.infer<typeof TransportEvidenceSchema>;

/**
 * usage：缺失必须 `missing: true` + `source: 'none'`，不能填 0。
 * `missing` 与 `source` 必须一致；缺失时不得携带 token 数字。
 */
export const ExecutionUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    thought_tokens: z.number().int().nonnegative().optional(),
    cached_read_tokens: z.number().int().nonnegative().optional(),
    cached_write_tokens: z.number().int().nonnegative().optional(),
    missing: z.boolean(),
    source: z.enum(['driver_result', 'driver_ledger', 'none']),
  })
  .strict()
  .superRefine((usage, ctx) => {
    const tokenKeys = [
      'input_tokens',
      'output_tokens',
      'total_tokens',
      'thought_tokens',
      'cached_read_tokens',
      'cached_write_tokens',
    ] as const;
    const hasTokens = tokenKeys.some((key) => usage[key] !== undefined);
    if (usage.missing && usage.source !== 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'missing usage must use source=none',
      });
    }
    if (!usage.missing && usage.source === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'source=none must be reported as missing',
      });
    }
    if (usage.missing && hasTokens) {
      ctx.addIssue({
        code: 'custom',
        path: ['missing'],
        message: 'missing usage must not carry token numbers (never fill 0)',
      });
    }
    if (!usage.missing && !hasTokens) {
      ctx.addIssue({
        code: 'custom',
        path: ['missing'],
        message: 'non-missing usage requires at least one token number',
      });
    }
  });

export type ExecutionUsage = z.infer<typeof ExecutionUsageSchema>;

/**
 * workspace 差异只是 host 的有限观察（覆盖范围如实声明），不是 OS 写隔离。
 */
export const WorkspaceDeltaSchema = z
  .object({
    changed_paths: z.array(z.string().min(1).max(1_024)).max(4_096),
    coverage: z.enum(['complete', 'partial', 'unavailable']),
  })
  .strict();

export type WorkspaceDelta = z.infer<typeof WorkspaceDeltaSchema>;

export const ExecutionErrorInfoSchema = z
  .object({
    code: z.string().trim().min(1).max(200),
    message: z.string().min(1).max(4_000),
    retryable: z.boolean(),
  })
  .strict();

export type ExecutionErrorInfo = z.infer<typeof ExecutionErrorInfoSchema>;

export const EvidenceArtifactSchema = z
  .object({
    ref: EvidenceRefSchema,
    kind: z.string().trim().min(1).max(200),
    source: z.enum(['host_observed', 'driver_reported']),
  })
  .strict();

export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

export const ExecutionEvidenceSchema = z
  .object({
    schema_version: z.literal(EXECUTION_EVIDENCE_SCHEMA_VERSION),
    contract_version: z.literal(EXECUTION_CONTRACT_VERSION),
    evidence_id: IdSchema,
    dispatch_id: IdSchema,
    status: ExecutionStatusSchema,
    driver_id: IdSchema.optional(),
    driver_run_result_id: IdSchema.optional(),
    session_id: IdSchema.optional(),
    response_excerpt: z.string().max(MAX_RESPONSE_EXCERPT_CHARS).optional(),
    artifacts: z.array(EvidenceArtifactSchema).max(256),
    transcript_ref: EvidenceRefSchema.optional(),
    tool_events_ref: EvidenceRefSchema.optional(),
    checks: z.array(ExecutionCheckSchema).max(128),
    transport: TransportEvidenceSchema,
    workspace_delta: WorkspaceDeltaSchema.optional(),
    usage: ExecutionUsageSchema,
    duration_ms: z.number().nonnegative(),
    error: ExecutionErrorInfoSchema.optional(),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    const received = evidence.transport.result_received;
    if (evidence.status === 'succeeded' && !received) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'succeeded evidence requires result_received=true',
      });
    }
    if (evidence.status === 'interrupted' && !received) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'interrupted evidence requires result_received=true',
      });
    }
    // unknown 与 result_received 正交：driver 返回 failed + 传输错误码时 ADP 结局是
    // unknown，但 DriverRunResult 确实已收到（unknown + true + execution_unconfirmed 合法）。
    // 不允许的是把 unknown 与 not_executed、或 unknown 与「结局已确认」混为一谈。
    if (
      evidence.transport.evidence === 'not_executed' &&
      evidence.status !== 'failed' &&
      evidence.status !== 'cancelled'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'not_executed transport evidence maps to failed/cancelled only',
      });
    }
    if (evidence.status === 'succeeded' && evidence.error !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'succeeded evidence must not carry an error',
      });
    }
    if (evidence.status === 'failed' && evidence.error === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'failed evidence requires an error',
      });
    }
  });

export type ExecutionEvidence = z.infer<typeof ExecutionEvidenceSchema>;

export function hashExecutionEvidence(evidence: ExecutionEvidence): string {
  return hashJsonValue(evidence);
}

export function verifyExecutionEvidence(evidence: ExecutionEvidence, sha256: string): void {
  if (hashExecutionEvidence(evidence) !== sha256) {
    throw new ExecutionContractViolation(
      'evidence_inconsistent',
      `evidence hash mismatch for dispatch ${evidence.dispatch_id}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// 构造辅助：driver 自报数据 → 分级 evidence
// ─────────────────────────────────────────────────────────────

/** 外部 driver 的 usage 字段全部可选；形状不受本仓控制。 */
export type DriverUsageLike = Pick<
  DriverUsage,
  | 'total_tokens'
  | 'input_tokens'
  | 'output_tokens'
  | 'thought_tokens'
  | 'cached_read_tokens'
  | 'cached_write_tokens'
>;

const USAGE_NUMBER_KEYS = [
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'thought_tokens',
  'cached_read_tokens',
  'cached_write_tokens',
] as const;

/**
 * usage 归一：没有任何可用的 token 数字 → `missing: true` + `source: 'none'`。
 * 非整数/负数/非有限值按缺失丢弃，不伪造 0。
 */
export function normalizeDriverUsage(
  usage: DriverUsageLike | null | undefined,
  source: 'driver_result' | 'driver_ledger' = 'driver_result',
): ExecutionUsage {
  const tokens: Record<string, number> = {};
  for (const key of USAGE_NUMBER_KEYS) {
    const value = usage?.[key];
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value >= 0
    ) {
      tokens[key] = value;
    }
  }
  if (Object.keys(tokens).length === 0) {
    return ExecutionUsageSchema.parse({ missing: true, source: 'none' });
  }
  return ExecutionUsageSchema.parse({ ...tokens, missing: false, source });
}

/** host 取回了命令级观察（退码或原始输出 ref）才算 host_observed。 */
export function hostObservedCheck(input: {
  command?: string;
  exit_code?: number | null;
  stdout_ref?: EvidenceRef;
  stderr_ref?: EvidenceRef;
  observation?: 'complete' | 'partial';
  target_paths?: string[];
  workspace_sha256?: string;
  observed_at?: string;
}): ExecutionCheck {
  return ExecutionCheckSchema.parse({
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.exit_code !== undefined ? { exit_code: input.exit_code } : {}),
    ...(input.stdout_ref !== undefined ? { stdout_ref: input.stdout_ref } : {}),
    ...(input.stderr_ref !== undefined ? { stderr_ref: input.stderr_ref } : {}),
    ...(input.target_paths !== undefined ? { target_paths: input.target_paths } : {}),
    ...(input.workspace_sha256 !== undefined ? { workspace_sha256: input.workspace_sha256 } : {}),
    ...(input.observed_at !== undefined ? { observed_at: input.observed_at } : {}),
    provenance: 'host_observed',
    observation: input.observation ?? 'complete',
  });
}

/**
 * driver 自述（含回复里的「测试通过」）一律 driver_reported。
 * 未提供原始 ref 时 observation 记 partial/missing——runner exit 0 不能升级成检查通过。
 */
export function driverReportedCheck(input: {
  command?: string;
  claimed_exit_code?: number | null;
  stdout_ref?: EvidenceRef;
  stderr_ref?: EvidenceRef;
  observation?: 'complete' | 'partial' | 'missing';
}): ExecutionCheck {
  return ExecutionCheckSchema.parse({
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.claimed_exit_code !== undefined ? { exit_code: input.claimed_exit_code } : {}),
    ...(input.stdout_ref !== undefined ? { stdout_ref: input.stdout_ref } : {}),
    ...(input.stderr_ref !== undefined ? { stderr_ref: input.stderr_ref } : {}),
    provenance: 'driver_reported',
    observation: input.observation ?? 'missing',
  });
}

/** driver 返回值的最小映射形状（不对外部 ACP 契约做私有变体）。 */
export interface DriverAttemptResultLike {
  status: Exclude<ExecutionStatus, 'unknown'>;
  driver_id?: string;
  driver_run_result_id?: string;
  session_id?: string;
  response?: string;
  transcript_ref?: EvidenceRef;
  tool_events_ref?: EvidenceRef;
  artifacts?: readonly EvidenceArtifact[];
  usage?: DriverUsageLike | null;
  error?: ExecutionErrorInfo;
  duration_ms?: number;
}

/**
 * 宿主证据检查结论（例如只读违规）：只允许把**成功**降级为 failed/unknown，
 * 永远不能把失败/未知升级为成功，也不能改写原始 ADP receipt / DriverRunResult 事实。
 * `buildExecutionEvidence` 在最终状态为 succeeded 时才应用它。
 */
export interface HostStatusOverride {
  status: 'failed' | 'unknown';
  /** status=failed 时必填：说明宿主为何不接受成功。 */
  error?: ExecutionErrorInfo;
  reason: string;
}

/**
 * 一次尝试的观察结果：execute 回调（真实 driver 或 fake driver）只提供事实，
 * 由 `buildExecutionEvidence` 统一派生 status / transport / usage 语义。
 */
export interface DriverAttemptObservation {
  result?: DriverAttemptResultLike;
  error?: ExecutionErrorInfo;
  /**
   * 「是否收到过 DriverRunResult」的**独立事实**。当调用方用证据化状态映射把
   * 已收到结果映射成 `unknown`（例如 failed + EXTERNAL_DRIVER_TRANSPORT_ERROR）时，
   * 结果对象本身无法放进 `result`（其 status 不允许 unknown），必须通过本字段如实表达，
   * 不能从 status 反推。缺省时按 `result !== undefined || adp_receipt?.result_received` 判定。
   */
  result_received?: boolean;
  transport: {
    evidence: DriverExecutionEvidence;
    runner_exit_code?: number | null;
    signal?: string;
    stderr_ref?: EvidenceRef;
  };
  /** ADP receipt（若有）；优先级高于本地对 status 的猜测。 */
  adp_receipt?: {
    status: ExecutionStatus;
    /** 是否收到过 DriverRunResult（不等于「结局已确认」；启动失败 failed=false 合法）。 */
    result_received: boolean;
    /**
     * 旧持久化数据没有记录「是否收到结果」时的显式缺失标记；只允许 false + 未执行确认。
     * buildExecutionEvidence 只在没有 result、且 receipt 明确缺失时才透传。
     */
    result_received_missing?: boolean;
  };
  /** 宿主证据检查结论；只降级、不升级，不改写 receipt/result 原始事实。 */
  status_override?: HostStatusOverride;
  checks?: readonly ExecutionCheck[];
  workspace_delta?: WorkspaceDelta;
  response_excerpt?: string;
  artifacts?: readonly EvidenceArtifact[];
  transcript_ref?: EvidenceRef;
  tool_events_ref?: EvidenceRef;
  duration_ms?: number;
  usage?: DriverUsageLike | null;
}

export interface BuildExecutionEvidenceInput {
  dispatch_id: string;
  observation: DriverAttemptObservation;
  evidence_id?: string;
}

/**
 * 把一次尝试派生成严格 evidence。
 *
 * 优先级（RD-JRN-04）：ADP receipt > driver result > transport 证据猜测。
 * 但 transport 的 `evidence` 与 `result_received` 是两个**正交事实**，不能互相推导：
 * - `result_received` 表示「是否收到过 DriverRunResult」，**不等于结局已确认**。
 *   启动失败 receipt 是 `failed + false + not_executed`；driver 返回 failed +
 *   EXTERNAL_DRIVER_TRANSPORT_ERROR 时 ADP 结局是 `unknown`，但 result 对象确实收到，
 *   因此 `unknown + true + execution_unconfirmed` 是合法组合；interrupted 且观察到副作用
 *   映射为 unknown 时同样保留 `result_received=true`。
 * - 真正矛盾的输入（本地有 result 却报 not_executed、receipt 说 succeeded 却没有结果、
 *   显式 missing 又声称收到结果）抛 `evidence_inconsistent`，不静默改写事实。
 * - 只有 `not_executed` 明确证据才落到 failed/cancelled，其余不确定一律 `unknown`；
 *   `unknown` 的副作用不确定语义不变、禁止自动重放，host `status_override` 只能把成功降级。
 * - runner 退出码只放 transport，checks 只由调用方显式提供（不会被 runner 退码自动填充）；
 * - usage 缺失 → missing，不填 0。
 */
export function buildExecutionEvidence(input: BuildExecutionEvidenceInput): ExecutionEvidence {
  const { observation } = input;
  const result = observation.result;
  const receipt = observation.adp_receipt;
  const transportEvidence = observation.transport.evidence;

  // 1) result_received：与 transport.evidence 正交，不能从 receipt.status / 映射后的 status 推导。
  const explicitReceived = observation.result_received;
  const resultReceived =
    explicitReceived !== undefined
      ? explicitReceived
      : result !== undefined
        ? true
        : receipt !== undefined
          ? receipt.result_received
          : false;
  // 允许 explicitReceived=true 且没有 result/receipt：调用方明确声明收到过 DriverRunResult
  // （但证据化映射后的结局未知，例如 failed + EXTERNAL_DRIVER_TRANSPORT_ERROR）。
  if (explicitReceived === false && result !== undefined) {
    throw new ExecutionContractViolation(
      'evidence_inconsistent',
      'observation.result_received=false contradicts a local driver result',
    );
  }
  // 旧持久化数据显式标注缺失时，只在「没有 result 且未声称收到」时透传，不凭空猜。
  const resultReceivedMissing =
    result === undefined &&
    explicitReceived === undefined &&
    receipt !== undefined &&
    receipt.result_received_missing === true &&
    !receipt.result_received;

  // 2) 保守矛盾校验（fail closed，不伪造事实）。
  if (receipt !== undefined) {
    if (receipt.result_received_missing === true && resultReceived) {
      throw new ExecutionContractViolation(
        'evidence_inconsistent',
        'result_received_missing contradicts a received driver result',
      );
    }
    if (
      (receipt.status === 'succeeded' || receipt.status === 'interrupted') &&
      !receipt.result_received
    ) {
      throw new ExecutionContractViolation(
        'evidence_inconsistent',
        `ADP receipt status ${receipt.status} requires result_received=true`,
      );
    }
    if (result !== undefined && !receipt.result_received) {
      throw new ExecutionContractViolation(
        'evidence_inconsistent',
        'local driver result contradicts ADP receipt result_received=false',
      );
    }
  }
  if (resultReceived && transportEvidence === 'not_executed') {
    throw new ExecutionContractViolation(
      'evidence_inconsistent',
      'received driver result contradicts transport evidence not_executed',
    );
  }
  if (resultReceivedMissing && transportEvidence !== 'execution_unconfirmed') {
    throw new ExecutionContractViolation(
      'evidence_inconsistent',
      'result_received_missing requires execution_unconfirmed transport evidence',
    );
  }

  let status: ExecutionStatus;
  if (receipt) status = receipt.status;
  else if (result) status = result.status;
  else if (transportEvidence === 'not_executed') status = 'failed';
  else status = 'unknown';

  if (status === 'failed' && !resultReceived && transportEvidence === 'execution_unconfirmed') {
    // 既没有执行结果、transport 又无法确认执行/副作用，不能把结局写成确定 failed。
    throw new ExecutionContractViolation(
      'evidence_inconsistent',
      'failed evidence without a received result requires not_executed transport evidence',
    );
  }

  // 3) 宿主证据检查结论：只允许把成功降级；不改写 receipt/result 原始事实。
  const override = observation.status_override;
  if (override !== undefined) {
    if (override.status === 'failed' && override.error === undefined) {
      throw new ExecutionContractViolation(
        'evidence_inconsistent',
        'status_override=failed requires an error explaining the host verdict',
      );
    }
    if (status === 'succeeded') status = override.status;
  }

  const durationMs = observation.duration_ms ?? result?.duration_ms ?? 0;
  const responseExcerpt = observation.response_excerpt ?? result?.response;
  const usage = normalizeDriverUsage(observation.usage ?? result?.usage ?? null);
  const artifacts = observation.artifacts ?? result?.artifacts ?? [];
  const overrideError =
    status !== 'succeeded' && override?.status === 'failed' ? override.error : undefined;
  const error = deriveEvidenceError(status, overrideError ?? observation.error ?? result?.error);

  const evidence: Record<string, unknown> = {
    schema_version: EXECUTION_EVIDENCE_SCHEMA_VERSION,
    contract_version: EXECUTION_CONTRACT_VERSION,
    evidence_id: input.evidence_id ?? createId('evd'),
    dispatch_id: input.dispatch_id,
    status,
    artifacts,
    checks: observation.checks ?? [],
    transport: {
      evidence: transportEvidence,
      result_received: resultReceived,
      ...(resultReceivedMissing ? { result_received_missing: true } : {}),
      ...(observation.transport.runner_exit_code !== undefined
        ? { runner_exit_code: observation.transport.runner_exit_code }
        : {}),
      ...(observation.transport.signal !== undefined
        ? { signal: observation.transport.signal }
        : {}),
      ...(observation.transport.stderr_ref !== undefined
        ? { stderr_ref: observation.transport.stderr_ref }
        : {}),
    },
    usage,
    duration_ms: durationMs,
  };
  if (result?.driver_id !== undefined) evidence.driver_id = result.driver_id;
  if (result?.driver_run_result_id !== undefined) {
    evidence.driver_run_result_id = result.driver_run_result_id;
  }
  if (result?.session_id !== undefined) evidence.session_id = result.session_id;
  if (responseExcerpt !== undefined) {
    evidence.response_excerpt = responseExcerpt.slice(0, responseExcerptChars());
  }
  if (result?.transcript_ref !== undefined) evidence.transcript_ref = result.transcript_ref;
  if (result?.tool_events_ref !== undefined) evidence.tool_events_ref = result.tool_events_ref;
  if (observation.transcript_ref !== undefined)
    evidence.transcript_ref = observation.transcript_ref;
  if (observation.tool_events_ref !== undefined) {
    evidence.tool_events_ref = observation.tool_events_ref;
  }
  if (observation.workspace_delta !== undefined) {
    evidence.workspace_delta = observation.workspace_delta;
  }
  if (error !== undefined) evidence.error = error;

  return ExecutionEvidenceSchema.parse(evidence);
}

function deriveEvidenceError(
  status: ExecutionStatus,
  error: ExecutionErrorInfo | undefined,
): ExecutionErrorInfo | undefined {
  if (status === 'succeeded' || status === 'unknown' || status === 'interrupted') return undefined;
  if (error !== undefined) return error;
  if (status !== 'failed') return undefined;
  // failed 必须带 error；driver 未给出细节时用稳定占位码，不臆造可重试语义。
  return {
    code: 'DRIVER_FAILED_WITHOUT_ERROR',
    message: 'driver reported failure without error detail',
    retryable: false,
  };
}

// ─────────────────────────────────────────────────────────────
// Journal 行（append-only）与折叠记录
// ─────────────────────────────────────────────────────────────

export const BudgetSnapshotSchema = z
  .object({
    dispatches_left: z.number().int().nonnegative(),
    role_tokens_left: z.number().int().nonnegative(),
    deadline_at: z.iso.datetime(),
  })
  .strict();

export type BudgetSnapshot = z.infer<typeof BudgetSnapshotSchema>;

const dispatchJournalEntryBaseShape = {
  schema_version: z.literal(DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION),
  entry_id: IdSchema,
  dispatch_id: IdSchema,
  run_id: IdSchema,
  task_id: IdSchema,
  role_id: IdSchema,
  sequence: z.number().int().positive(),
  at: z.iso.datetime(),
} as const;

function assertBriefIdentityMatchesEntry(
  brief: ExecutionBrief,
  entry: {
    dispatch_id: string;
    run_id: string;
    task_id: string;
    role_id: string;
    sequence: number;
    at: string;
  },
  ctx: z.RefinementCtx,
): void {
  const mismatches: Array<[string, string, string]> = [
    ['dispatch_id', brief.dispatch_id, entry.dispatch_id],
    ['run_id', brief.run_id, entry.run_id],
    ['task_id', brief.task_id, entry.task_id],
    ['role_id', brief.role_id, entry.role_id],
  ];
  for (const [field, actual, expected] of mismatches) {
    if (actual !== expected) {
      ctx.addIssue({ code: 'custom', path: ['brief', field], message: `${field} mismatch` });
    }
  }
  if (brief.sequence !== entry.sequence) {
    ctx.addIssue({ code: 'custom', path: ['brief', 'sequence'], message: 'sequence mismatch' });
  }
  if (brief.accepted_at !== entry.at) {
    ctx.addIssue({
      code: 'custom',
      path: ['brief', 'accepted_at'],
      message: 'accepted_at must equal journal entry at',
    });
  }
}

export const DispatchAcceptedJournalEntrySchema = z
  .object({
    ...dispatchJournalEntryBaseShape,
    event: z.literal('accepted'),
    brief: ExecutionBriefSchema,
    brief_sha256: Sha256Schema,
    budget_before: BudgetSnapshotSchema,
  })
  .strict()
  .superRefine((entry, ctx) => {
    assertBriefIdentityMatchesEntry(entry.brief, entry, ctx);
    if (hashExecutionBrief(entry.brief) !== entry.brief_sha256) {
      ctx.addIssue({
        code: 'custom',
        path: ['brief_sha256'],
        message: 'brief_sha256 does not match brief content',
      });
    }
  });

export type DispatchAcceptedJournalEntry = z.infer<typeof DispatchAcceptedJournalEntrySchema>;

export const DispatchDispatchedJournalEntrySchema = z
  .object({
    ...dispatchJournalEntryBaseShape,
    event: z.literal('dispatched'),
    adp_exchange_id: IdSchema.optional(),
    session_id: IdSchema.optional(),
  })
  .strict();

export type DispatchDispatchedJournalEntry = z.infer<typeof DispatchDispatchedJournalEntrySchema>;

export const DispatchSettledJournalEntrySchema = z
  .object({
    ...dispatchJournalEntryBaseShape,
    event: z.literal('settled'),
    status: ExecutionStatusSchema,
    evidence: ExecutionEvidenceSchema,
    evidence_sha256: Sha256Schema,
    violations: z.array(JournalViolationSchema),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.evidence.dispatch_id !== entry.dispatch_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence', 'dispatch_id'],
        message: 'evidence dispatch_id mismatch',
      });
    }
    if (entry.status !== entry.evidence.status) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'settled status must equal evidence.status',
      });
    }
    if (hashExecutionEvidence(entry.evidence) !== entry.evidence_sha256) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence_sha256'],
        message: 'evidence_sha256 does not match evidence content',
      });
    }
  });

export type DispatchSettledJournalEntry = z.infer<typeof DispatchSettledJournalEntrySchema>;

export const DispatchReconciledJournalEntrySchema = z
  .object({
    ...dispatchJournalEntryBaseShape,
    event: z.literal('reconciled'),
    status: z.enum(['succeeded', 'failed', 'unknown']),
    evidence_ref: EvidenceRefSchema.optional(),
    evidence: ExecutionEvidenceSchema.optional(),
    evidence_sha256: Sha256Schema.optional(),
    reason: z.string().trim().min(1).max(4_000),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.evidence !== undefined) {
      if (entry.evidence.dispatch_id !== entry.dispatch_id) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence', 'dispatch_id'],
          message: 'reconciled evidence dispatch_id mismatch',
        });
      }
      if (entry.evidence.status !== entry.status) {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'reconciled status must equal evidence.status',
        });
      }
      if (entry.evidence_sha256 === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_sha256'],
          message: 'reconciled evidence requires evidence_sha256',
        });
      } else if (hashExecutionEvidence(entry.evidence) !== entry.evidence_sha256) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_sha256'],
          message: 'evidence_sha256 does not match evidence content',
        });
      }
    } else if (entry.evidence_sha256 !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence_sha256'],
        message: 'evidence_sha256 requires evidence',
      });
    }
  });

export type DispatchReconciledJournalEntry = z.infer<typeof DispatchReconciledJournalEntrySchema>;

const controlJournalEntryBaseShape = {
  schema_version: z.literal(DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION),
  entry_id: IdSchema,
  run_id: IdSchema,
  task_id: IdSchema,
  role_id: IdSchema,
  at: z.iso.datetime(),
} as const;

/** 冻结的 routing 引用（阶段 2 只做记录，不迁移 Session/记忆）。 */
export const JournalFrozenRoutingSchema = z
  .object({
    driver_id: IdSchema.optional(),
    profile_id: IdSchema.optional(),
  })
  .strict();

export type JournalFrozenRouting = z.infer<typeof JournalFrozenRoutingSchema>;

/**
 * 冻结配置与预算（RD-SEL-03/§5）；control 行不属于某个 dispatch，不伪造 sequence。
 *
 * 阶段 2 在阶段 1 基础上做**加法扩展**（全部 optional，旧行仍可解析）：
 * `engine` / `engine_version` / `tool_allowlist` / `routing` / `dispatch_timeout_ms`。
 * 没有这些字段的旧 init 行按 legacy 解释，不得用部署默认值补假冻结记录。
 */
export const JournalInitEntrySchema = z
  .object({
    ...controlJournalEntryBaseShape,
    event: z.literal('init'),
    autonomy: z.boolean(),
    evidence_only: z.boolean(),
    buffer_v2: z.boolean(),
    max_dispatches: z.number().int().positive(),
    max_role_rounds: z.number().int().positive(),
    role_token_budget: z.number().int().positive(),
    deadline_at: z.iso.datetime(),
    engine: z.enum(['legacy', 'role_autonomy']).optional(),
    engine_version: z.string().trim().min(1).max(120).optional(),
    tool_allowlist: z.array(z.string().trim().min(1).max(120)).max(32).optional(),
    routing: JournalFrozenRoutingSchema.optional(),
    dispatch_timeout_ms: z.number().int().positive().optional(),
    /** TaskBudget.max_tool_calls 映射后的任务级工具调用上限（旧行可缺省）。 */
    max_tool_calls: z.number().int().positive().optional(),
  })
  .strict();

export type JournalInitEntry = z.infer<typeof JournalInitEntrySchema>;

/** Role 验证陈述的唯一字段契约；工具输入可添加默认值，持久化仍要求完整引用数组。 */
export const JournalVerificationClaimSchema = z
  .object({
    requirement: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe('你用一句话描述的一条任务要求（自由文本，不要求逐字照抄 completion_criteria）'),
    outcome: z
      .enum(['passed', 'failed', 'not_run'])
      .describe(
        'passed=你确认该要求已满足；failed=尝试过但没有满足；not_run=未验证/无法验证（必须如实说明）',
      ),
    dispatch_ids: z
      .array(z.string().trim().min(1).max(120))
      .max(32)
      .describe('支撑该结论的派工 id；outcome=passed 时必须至少一个，且宿主观察到通过的检查证据'),
    evidence_refs: z
      .array(EvidenceRefSchema)
      .max(32)
      .describe('支撑该结论的受控 evidence 引用（host 校验登记与 sha256）'),
    note: z.string().trim().max(2_000).optional().describe('补充说明（如未验证原因）'),
  })
  .strict();
export type JournalVerificationClaim = z.infer<typeof JournalVerificationClaimSchema>;

export const JournalFinishEntrySchema = z
  .object({
    ...controlJournalEntryBaseShape,
    event: z.literal('finish'),
    actor: z.enum(['role', 'host', 'user']),
    status: z.enum(['completed', 'blocked', 'failed', 'cancelled', 'interrupted']),
    reason: z.string().max(4_000),
    evidence_refs: z.array(EvidenceRefSchema),
    /**
     * 阶段 2 的 role finish 事实（加法扩展，旧行可读）：summary / unresolved /
     * role_reflection / response_only / zero_dispatch。暂停原因仍走 `reason`。
     */
    summary: z.string().max(8_000).optional(),
    unresolved: z.array(z.string().trim().min(1).max(2_000)).max(32).optional(),
    role_reflection: z.string().max(8_000).optional(),
    response_only: z.boolean().optional(),
    zero_dispatch: z.boolean().optional(),
    /**
     * role 对任务要求满足情况的显式陈述（阶段 2 精简后的完成语义载体）：
     * `passed` 必须引用真实派工及其 host_observed 通过检查；`failed`/`not_run` 是 role 的如实陈述。
     * 旧 finish 行没有该字段时按空数组解释。
     */
    verification: z.array(JournalVerificationClaimSchema).max(32).optional(),
    /**
     * 已退役的「完成要求 → 宿主命令」映射（阶段 2 早期格式）。只为读取旧 finish 行保留；
     * 生产不再写入、宿主也不据此放行。新记录用 `verification`。
     */
    checks: z
      .array(
        z
          .object({
            criterion: z.string().trim().min(1).max(2_000),
            command: z.string().trim().min(1).max(4_096),
            clause: z.string().trim().min(1).max(2_000).optional(),
            target_paths: z.array(z.string().trim().min(1).max(1_024)).max(256).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
  })
  .strict();

export type JournalFinishEntry = z.infer<typeof JournalFinishEntrySchema>;

/**
 * role 单回合的预算消费事实（阶段 2 新增 control 行）：恢复时据此还原已消费回合与 token，
 * 不能靠 restart 清零。`usage_missing` 为 true 时 token 字段不得填 0 冒充已知用量。
 */
export const JournalRoleRoundEntrySchema = z
  .object({
    ...controlJournalEntryBaseShape,
    event: z.literal('role_round'),
    round: z.number().int().positive(),
    input_tokens: z.number().int().min(0).optional(),
    output_tokens: z.number().int().min(0).optional(),
    usage_missing: z.boolean(),
    /** 本回合执行的环境工具调用数；恢复工具调用预算用（旧行可缺省）。 */
    tool_calls: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.usage_missing) {
      if (entry.input_tokens !== undefined || entry.output_tokens !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['usage_missing'],
          message: 'usage_missing role_round must not carry token counts',
        });
      }
      return;
    }
    if (entry.input_tokens === undefined || entry.output_tokens === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['usage_missing'],
        message: 'role_round requires input_tokens/output_tokens unless usage is missing',
      });
    }
  });

export type JournalRoleRoundEntry = z.infer<typeof JournalRoleRoundEntrySchema>;

/**
 * 尾部半写修复痕迹：`discarded_tail_sha256` 指向被丢弃的原始字节；
 * `discarded_tail_ref` 指向保留原始字节的侧车文件（不覆盖历史）。
 */
export const JournalRepairEntrySchema = z
  .object({
    ...controlJournalEntryBaseShape,
    event: z.literal('repair'),
    discarded_tail_sha256: Sha256Schema,
    discarded_tail_ref: EvidenceRefSchema.optional(),
    reason: z.string().trim().min(1).max(4_000),
  })
  .strict();

export type JournalRepairEntry = z.infer<typeof JournalRepairEntrySchema>;

export const DispatchJournalEntrySchema = z.discriminatedUnion('event', [
  DispatchAcceptedJournalEntrySchema,
  DispatchDispatchedJournalEntrySchema,
  DispatchSettledJournalEntrySchema,
  DispatchReconciledJournalEntrySchema,
]);

export type DispatchJournalEntry = z.infer<typeof DispatchJournalEntrySchema>;

export const JournalControlEntrySchema = z.discriminatedUnion('event', [
  JournalInitEntrySchema,
  JournalFinishEntrySchema,
  JournalRoleRoundEntrySchema,
  JournalRepairEntrySchema,
]);

export type JournalControlEntry = z.infer<typeof JournalControlEntrySchema>;

/** 一行 journal：event 值互斥，统一按 `event` 判别。 */
export const DispatchJournalLineSchema = z.discriminatedUnion('event', [
  JournalInitEntrySchema,
  DispatchAcceptedJournalEntrySchema,
  DispatchDispatchedJournalEntrySchema,
  DispatchSettledJournalEntrySchema,
  DispatchReconciledJournalEntrySchema,
  JournalFinishEntrySchema,
  JournalRoleRoundEntrySchema,
  JournalRepairEntrySchema,
]);

export type DispatchJournalLine = z.infer<typeof DispatchJournalLineSchema>;

export function isControlJournalEntry(entry: DispatchJournalLine): entry is JournalControlEntry {
  return (
    entry.event === 'init' ||
    entry.event === 'finish' ||
    entry.event === 'role_round' ||
    entry.event === 'repair'
  );
}

export function isDispatchJournalEntry(entry: DispatchJournalLine): entry is DispatchJournalEntry {
  return !isControlJournalEntry(entry);
}

/**
 * 折叠后的派工记录。
 *
 * `phase` 表示 journal 证据到达的最远阶段；`status` 是**可对账状态**：
 * - accepted 且无 dispatched/交付证据 → `not_executed`（可显式重派）；
 * - dispatched 且无 settled/可信 receipt → `unknown`（禁止自动重放）；
 * - settled → settled 的 status；迟到的 reconciled 只记录在 `reconciled` 字段，
 *   不悄悄改写已发出的终态。
 */
export const DispatchRecordStatusSchema = z.enum([
  'not_executed',
  'unknown',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

export type DispatchRecordStatus = z.infer<typeof DispatchRecordStatusSchema>;

export const DispatchRecordSchema = z
  .object({
    schema_version: z.literal(DISPATCH_RECORD_SCHEMA_VERSION),
    dispatch_id: IdSchema,
    run_id: IdSchema,
    task_id: IdSchema,
    role_id: IdSchema,
    sequence: z.number().int().positive(),
    phase: z.enum(['accepted', 'dispatched', 'settled']),
    status: DispatchRecordStatusSchema,
    brief: ExecutionBriefSchema,
    brief_sha256: Sha256Schema,
    evidence: ExecutionEvidenceSchema.optional(),
    evidence_sha256: Sha256Schema.optional(),
    violations: z.array(JournalViolationSchema),
    reconciled: z
      .object({
        status: z.enum(['succeeded', 'failed', 'unknown']),
        evidence_ref: EvidenceRefSchema.optional(),
        reason: z.string().min(1),
        at: z.iso.datetime(),
      })
      .strict()
      .optional(),
    accepted_at: z.iso.datetime(),
    dispatched_at: z.iso.datetime().optional(),
    settled_at: z.iso.datetime().optional(),
    adp_exchange_id: IdSchema.optional(),
    session_id: IdSchema.optional(),
  })
  .strict();

export type DispatchRecord = z.infer<typeof DispatchRecordSchema>;

// ─────────────────────────────────────────────────────────────
// 写屏障端口（persistence 实现文件 I/O，driver 负责编排）
// ─────────────────────────────────────────────────────────────

export interface AcceptedAppendInput {
  brief: ExecutionBrief;
  brief_sha256: string;
  budget_before: BudgetSnapshot;
  /** 同一次尝试的写重试可复用 entry_id；新尝试必须换新的 dispatch_id。 */
  entry_id?: string;
  at?: string;
}

export interface DispatchedAppendInput {
  dispatch_id: string;
  adp_exchange_id?: string;
  session_id?: string;
  entry_id?: string;
  at?: string;
}

export interface EvidenceAppendInput {
  dispatch_id: string;
  evidence: ExecutionEvidence;
}

export interface EvidenceArtifactRef {
  ref: EvidenceRef;
  sha256: string;
}

export interface SettledAppendInput {
  dispatch_id: string;
  status: ExecutionStatus;
  evidence: ExecutionEvidence;
  evidence_sha256: string;
  violations: readonly JournalViolation[];
  entry_id?: string;
  at?: string;
}

/**
 * 跨 Run 显式重试的锚点（阶段 2 复审修复）：当前 Run 的 Journal 不认识祖先 Run 的
 * dispatch_id，engine 必须先从祖先 Journal 读出真实记录并**通过受控 evidence 读取校验**
 * 后，才能把锚点交给当前 Journal 的 retry 校验。锚点不是执行事实，只是外部引用。
 */
export interface ForeignRetryAnchor {
  dispatch_id: string;
  /** accepted-only 的 not_executed 也允许作为锚点（明确未执行，可安全重试）。 */
  status: ExecutionStatus | 'not_executed';
  /** 祖先 Journal 中该记录可验证的受控 ref（path+sha256 双向绑定）。 */
  evidence_refs: EvidenceRef[];
}

export interface ReconciledAppendInput {
  dispatch_id: string;
  status: 'succeeded' | 'failed' | 'unknown';
  reason: string;
  evidence_ref?: EvidenceRef;
  evidence?: ExecutionEvidence;
  evidence_sha256?: string;
  entry_id?: string;
  at?: string;
}

/**
 * 写屏障需要的最小端口。persistence 的 `RunDispatchJournal` 实现它；
 * driver 的 `dispatch-attempt.ts` 只依赖这个接口，避免 driver → persistence 的运行时依赖。
 */
export interface DispatchJournalPort {
  appendAccepted(input: AcceptedAppendInput): Promise<void>;
  appendDispatched(input: DispatchedAppendInput): Promise<void>;
  appendEvidence(input: EvidenceAppendInput): Promise<EvidenceArtifactRef>;
  appendSettled(input: SettledAppendInput): Promise<void>;
  appendReconciled(input: ReconciledAppendInput): Promise<void>;
}
