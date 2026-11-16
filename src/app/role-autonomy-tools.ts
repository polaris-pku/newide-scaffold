/**
 * role-autonomy-tools — 阶段 2「角色自主循环」的**隔离工具表**（5 个允许工具）。
 *
 * 职责与核心逻辑：
 * - 只暴露 `dispatch_execution` / `query_memory` / `read_evidence` / `update_plan` /
 *   `finish_task` 五个工具；不出现 `invoke_driver` / `invoke_council` / `mailbox_send` 与任何
 *   fs/shell/git/network 工具（RD-OWN-02 / OWN-01）。工具授权以冻结策略的 `tool_allowlist`
 *   为准，未授权工具一律 `ROLE_UNKNOWN_TOOL`。
 * - 模型侧参数一律走共享契约里的 strict zod schema：`dispatch_id` / `task_id` / `run_id` /
 *   `role_id` / `sequence` / `accepted_at` / 预算等宿主身份字段出现在模型参数里会被拒绝
 *   （RD-DIS-02）。宿主身份、sequence、accepted_at、budget_before 全由本模块构造。
 * - `dispatch_execution` 用 `buildExecutionBrief` 构造完整 Brief 并计算 canonical hash，
 *   再交给 {@link RoleDispatchPort}（真实实现是阶段 1 的 `runJournaledDispatch` 写屏障）。
 *   写屏障失败映射成 typed termination（evidence→evidence_write_failed；accepted/dispatched/
 *   settled→journal_write_failed，与 engine 共用同一转换函数）；
 *   driver 的 `succeeded` 只是**本次派工**的结果，本模块不据此结束循环。
 * - `finish_task` 只做「校验 → 交还缺口 / 接受一次」；接受后所有剩余工具（含再次 finish）
 *   一律 `ROLE_ALREADY_FINISHED`。真正写 finish 行由 loop 负责（避免工具表拥有终态写权限）。
 * - 同一回复里的多个 dispatch 由调用方（loop）串行调用本模块；本模块自身不并发派工。
 *
 * 边界：本文件不调用 LLM、不写文件、不决定终态；只依赖共享契约端口与 driver 的纯函数。
 */
import { z } from 'zod';
import { createId } from '../core';
import type { BudgetSnapshot, ExecutionBriefHostIdentity } from '../driver';
import {
  buildExecutionBrief,
  DispatchJournalBarrierError as DispatchJournalBarrierErrorClass,
  ExecutionContractViolation,
} from '../driver';
import type { ToolCall, ToolDefinition } from '../memory';
import type {
  RoleBudgetPort,
  RoleDispatchExecutionArgs,
  RoleDispatchObservation,
  RoleDispatchPort,
  RoleFinishArgs,
  RoleFinishRecord,
  RoleFinishValidatorPort,
  RoleFrozenPolicy,
  RoleJournalPort,
  RoleLoopContextInput,
  RoleMemoryPort,
  RoleQueryMemoryArgs,
  RoleReadEvidenceArgs,
  RoleToolName,
  RoleToolResult,
  RoleUpdatePlanArgs,
} from './role-autonomy-contract';
import {
  ROLE_TOOL_NAMES,
  RoleDispatchExecutionArgsSchema,
  RoleFinishArgsSchema,
  RoleQueryMemoryArgsSchema,
  RoleReadEvidenceArgsSchema,
  RoleTerminationError,
  roleTerminationFromDispatchBarrier,
  RoleUpdatePlanArgsSchema,
} from './role-autonomy-contract';

// ─────────────────────────────────────────────────────────────
// 工具定义（JSON Schema 与运行时 Zod 同源生成）
// ─────────────────────────────────────────────────────────────

/**
 * 工具参数 JSON Schema 由共享契约里的 Zod schema **同源生成**（`z.toJSONSchema`），
 * 不再手写第二份字段表：模型看到的合法参数与宿主接受/校验的参数不会漂移。
 *
 * 生成后做一次保守收敛，并记录原因（provider 兼容性）：
 * - 删除 `$schema`（只是 meta，provider 不需要）；
 * - 删除 `default`：运行时 Zod 仍会应用默认值，模型侧只看到「可选字段」，避免 provider
 *   对 default 关键字支持不一致；
 * - `const: x` → `enum: [x]`、`oneOf` → `anyOf`、整数 `exclusiveMinimum: n` →
 *   `minimum: n + 1`：都保持等价语义，但落在更广的 function-calling JSON Schema 子集内。
 * 字段说明用 Zod `.describe()` 携带（见 role-autonomy-contract.ts），不在这里重复维护。
 * 该收敛由 `role-execution-loop-tools.test.ts` 的表驱动断言覆盖；真实 provider 的端到端
 * 兼容性未在本轮验证（风险记录在契约 RD-IMP-14）。
 */
const ROLE_AUTONOMY_ARG_SCHEMAS = {
  dispatch_execution: RoleDispatchExecutionArgsSchema,
  query_memory: RoleQueryMemoryArgsSchema,
  read_evidence: RoleReadEvidenceArgsSchema,
  update_plan: RoleUpdatePlanArgsSchema,
  finish_task: RoleFinishArgsSchema,
} satisfies Record<RoleToolName, z.ZodType>;

function toToolParameters(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete generated.$schema;
  return sanitizeToolSchema(generated) as Record<string, unknown>;
}

function sanitizeToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeToolSchema(item));
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === 'default' || key === '$schema') continue;
    if (key === 'const') {
      result.enum = [child];
      continue;
    }
    if (key === 'exclusiveMinimum' && typeof child === 'number' && source.type === 'integer') {
      result.minimum = child + 1;
      continue;
    }
    result[key === 'oneOf' ? 'anyOf' : key] = sanitizeToolSchema(child);
  }
  return result;
}

const ROLE_AUTONOMY_TOOL_PARAMETERS: Record<RoleToolName, Record<string, unknown>> = {
  dispatch_execution: toToolParameters(ROLE_AUTONOMY_ARG_SCHEMAS.dispatch_execution),
  query_memory: toToolParameters(ROLE_AUTONOMY_ARG_SCHEMAS.query_memory),
  read_evidence: toToolParameters(ROLE_AUTONOMY_ARG_SCHEMAS.read_evidence),
  update_plan: toToolParameters(ROLE_AUTONOMY_ARG_SCHEMAS.update_plan),
  finish_task: toToolParameters(ROLE_AUTONOMY_ARG_SCHEMAS.finish_task),
};

const ROLE_AUTONOMY_TOOL_DESCRIPTIONS: Record<RoleToolName, string> = {
  dispatch_execution:
    '派发一次 driver 执行（一次明确 attempt）。宿主填身份/sequence/预算；你只给指令与验收标准。',
  query_memory: '按关键词检索本角色的长期记忆（只读）。',
  read_evidence: '读取本 Run 已登记 evidence ref 的内容（可分页，宿主校验 hash/大小/路径）。',
  update_plan: '记录/更新你的当前计划（只是计划，不构成执行或完成证据）。',
  finish_task:
    '显式结束：说明每条任务要求的满足情况（verification），宿主校验证据事实后接受或返回具体缺口。',
};

/** 五个工具定义（按 {@link ROLE_TOOL_NAMES} 顺序）；可再按冻结授权过滤。 */
export const ROLE_AUTONOMY_TOOL_DEFINITIONS: readonly ToolDefinition[] = ROLE_TOOL_NAMES.map(
  (name) => ({
    type: 'function' as const,
    function: {
      name,
      description: ROLE_AUTONOMY_TOOL_DESCRIPTIONS[name],
      parameters: ROLE_AUTONOMY_TOOL_PARAMETERS[name],
    },
  }),
);

/** 按冻结策略的工具授权过滤；未在 allowlist 的工具不会出现在 LLM 工具表里。 */
export function roleToolDefinitionsForAllowlist(
  allowlist: readonly RoleToolName[],
): ToolDefinition[] {
  const allowed = new Set(allowlist);
  return ROLE_AUTONOMY_TOOL_DEFINITIONS.filter((definition) =>
    allowed.has(definition.function.name as RoleToolName),
  );
}
// ─────────────────────────────────────────────────────────────
// 参数校验（strict zod；模型伪造宿主身份字段会被拒收）
// ─────────────────────────────────────────────────────────────

type ParsedArguments = {
  [Name in RoleToolName]: { name: Name; args: z.output<(typeof ROLE_AUTONOMY_ARG_SCHEMAS)[Name]> };
}[RoleToolName];

interface ArgumentParseFailure {
  ok: false;
  message: string;
}

type ArgumentParseOutcome = { ok: true; parsed: ParsedArguments } | ArgumentParseFailure;

/** 工具名是否属于隔离工具表。 */
export function isRoleToolName(value: string): value is RoleToolName {
  return (ROLE_TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * 按工具名解析参数。`rawArguments` 是模型给的 JSON 字符串；解析/校验失败返回稳定错误，
 * 由调用方转成 `ROLE_INVALID_ARGUMENTS` 工具结果。
 */
export function parseRoleToolCallArguments(
  name: RoleToolName,
  rawArguments: string,
): ArgumentParseOutcome {
  let value: unknown;
  try {
    value = JSON.parse(rawArguments);
  } catch {
    return { ok: false, message: 'tool arguments must be valid JSON' };
  }
  const result = ROLE_AUTONOMY_ARG_SCHEMAS[name].safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      message: result.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    };
  }
  // name 与 args 的关联由上面的同一 registry 索引保证，避免维护第二份工具名分派表。
  return { ok: true, parsed: { name, args: result.data } as ParsedArguments };
}

// ─────────────────────────────────────────────────────────────
// 工具执行器
// ─────────────────────────────────────────────────────────────

export interface RoleToolExecutorOptions {
  journal: RoleJournalPort;
  dispatch: RoleDispatchPort;
  memory: RoleMemoryPort;
  budget: RoleBudgetPort;
  finish: RoleFinishValidatorPort;
  policy: RoleFrozenPolicy;
  context: RoleLoopContextInput;
  /** 宿主时钟（测试注入；缺省系统时间）。 */
  now?: () => Date;
  /** 用户取消信号：取消后不得再派工；finish 校验会带上 cancelled。 */
  signal?: AbortSignal;
  /** 阶段 4：计划更新的投影观察（不改变工具语义；缺失时不发事件）。 */
  on_plan_updated?: (plan: string) => void;
}

/**
 * 工具执行器：持有「已 finish / 已派工 / 当前计划」状态，串行执行同一回复里的工具调用。
 * 只暴露 {@link RoleToolExecutor.execute}；loop 负责 LLM/预算/历史。
 */
export interface RoleToolExecutor {
  readonly definitions: ToolDefinition[];
  readonly dispatches: readonly RoleDispatchObservation[];
  readonly plan: string | undefined;
  readonly finished: boolean;
  readonly finishRecord: RoleFinishRecord | undefined;
  execute(call: ToolCall): Promise<RoleToolResult>;
}

export function createRoleToolExecutor(options: RoleToolExecutorOptions): RoleToolExecutor {
  const now = options.now ?? (() => new Date());
  const allowlist = new Set<RoleToolName>(options.policy.tool_allowlist);
  const definitions = roleToolDefinitionsForAllowlist(options.policy.tool_allowlist);
  const dispatches: RoleDispatchObservation[] = [];
  let plan: string | undefined;
  let finished = false;
  let finishRecord: RoleFinishRecord | undefined;

  const cancelled = (): boolean => options.signal?.aborted ?? false;

  const ensureNotCancelled = (): void => {
    if (!cancelled()) return;
    throw new RoleTerminationError({
      code: 'host_failed',
      actor: 'user',
      message: 'role execution cancelled by user signal',
      details: { reason: 'cancelled' },
    });
  };

  const executeDispatch = async (args: RoleDispatchExecutionArgs): Promise<RoleToolResult> => {
    ensureNotCancelled();
    options.budget.assertDispatchAllowed(now());

    // 身份/sequence/accepted_at 由宿主填：sequence 取 Journal 已有记录数 + 1（RD-DIS-02）。
    const fold = await options.journal.fold();
    const identity: ExecutionBriefHostIdentity = {
      dispatch_id: createId('dsp'),
      task_id: options.context.task_id,
      run_id: options.context.run_id,
      role_id: options.context.role_id,
      sequence: fold.records.length + 1,
      accepted_at: now().toISOString(),
    };
    // 单 dispatch 超时的唯一有效值：min(模型请求, 冻结上限)。模型只能收紧、不能突破；
    // Brief/Journal/实际执行使用同一个有效值，恢复也不扩大上限。
    const frozenDispatchTimeoutMs = options.policy.budget.limits.dispatch_timeout_ms;
    const effectiveTimeoutMs =
      args.timeout_ms === undefined
        ? frozenDispatchTimeoutMs
        : Math.min(args.timeout_ms, frozenDispatchTimeoutMs);
    const request: Record<string, unknown> = {
      kind: args.kind,
      instruction: args.instruction,
      acceptance: args.acceptance,
      constraints: args.constraints,
      expected_artifacts: args.expected_artifacts,
      session: args.session,
      timeout_ms: effectiveTimeoutMs,
    };
    if (args.read_only !== undefined) request.read_only = args.read_only;
    if (args.verification_command !== undefined) {
      request.verification_command = args.verification_command;
    }
    if (args.retry_of !== undefined) request.retry_of = args.retry_of;
    if (args.reconciliation_ref !== undefined) {
      request.reconciliation_ref = args.reconciliation_ref;
    }

    // Session 已由宿主冻结：reuse 只允许本 role/run 已确认的那一个 Session；
    // 不一致时**不派工**，也不悄悄改成 fresh 或复用别的 Session。
    if (args.session.mode === 'reuse') {
      const confirmedSessionId = options.context.confirmed_session_id;
      if (
        confirmedSessionId === undefined ||
        confirmedSessionId.length === 0 ||
        args.session.session_id !== confirmedSessionId
      ) {
        return toolError(
          'ROLE_INVALID_ARGUMENTS',
          'reuse session is not the confirmed session of this role/run',
          { reason: 'session_reuse_unconfirmed' },
        );
      }
    }
    const confirmedSessions =
      options.context.confirmed_session_id !== undefined
        ? [
            {
              session_id: options.context.confirmed_session_id,
              run_id: options.context.run_id,
              role_id: options.context.role_id,
              ...(options.context.frozen_driver_id !== undefined
                ? { driver_id: options.context.frozen_driver_id }
                : {}),
            },
          ]
        : [];

    let built;
    try {
      built = buildExecutionBrief({ identity, request, confirmed_sessions: confirmedSessions });
    } catch (error) {
      if (error instanceof ExecutionContractViolation) {
        return toolError(
          'ROLE_INVALID_ARGUMENTS',
          `dispatch_execution request rejected: ${error.code}`,
          { contract_code: error.code },
        );
      }
      throw error;
    }

    const budgetSnapshot = options.budget.snapshot(now());
    const budgetBefore: BudgetSnapshot = {
      dispatches_left: Math.max(
        0,
        budgetSnapshot.frozen.limits.max_dispatches - budgetSnapshot.consumed.dispatches,
      ),
      role_tokens_left: Math.max(
        0,
        budgetSnapshot.frozen.limits.role_token_budget - budgetSnapshot.consumed.tokens,
      ),
      deadline_at: budgetSnapshot.frozen.deadline_at,
    };

    let observation: RoleDispatchObservation;
    try {
      observation = await options.dispatch.run({
        brief: built.brief,
        brief_sha256: built.brief_sha256,
        budget_before: budgetBefore,
      });
    } catch (error) {
      if (error instanceof DispatchJournalBarrierErrorClass) {
        // retry_of/reconciliation_ref 写错是**可纠正的参数错误**，不是宿主写盘失败：
        // 把 journal 的原始错误码交还 Role，让它按 recovery_hint 补字段重派，而不是终止 Run。
        const cause = (error as { original_error?: { code?: unknown; message?: unknown } })
          .original_error;
        const causeCode = typeof cause?.code === 'string' ? cause.code : undefined;
        if (
          causeCode === 'journal_retry_not_allowed' ||
          causeCode === 'journal_retry_without_evidence' ||
          causeCode === 'journal_unknown_dispatch'
        ) {
          return toolError(
            'ROLE_INVALID_ARGUMENTS',
            `dispatch retry rejected: ${String(cause?.message ?? causeCode)}`,
            {
              contract_code: causeCode,
              recovery_hint:
                'Recovering an unknown dispatch requires retry_of=<dispatch_id> AND ' +
                'reconciliation_ref={path, sha256} copied from that dispatch evidence_ref/evidence_sha256.',
            },
          );
        }
        throw roleTerminationFromDispatchBarrier(error);
      }
      if (error instanceof ExecutionContractViolation) {
        return toolError(
          'ROLE_INVALID_ARGUMENTS',
          `dispatch_execution rejected by contract: ${error.code}`,
          { contract_code: error.code },
        );
      }
      if (error instanceof RoleTerminationError) throw error;
      throw new RoleTerminationError(
        {
          code: 'host_failed',
          actor: 'host',
          message: 'role dispatch failed unexpectedly',
          details: { dispatch_id: built.brief.dispatch_id },
        },
        error,
      );
    }

    // 派工已 settled：只计数，不再检查（预算在派工前已检查）。
    options.budget.recordDispatch();
    dispatches.push(observation);

    const data: Record<string, unknown> = {
      dispatch_id: observation.dispatch_id,
      status: observation.status,
      evidence_ref: observation.evidence_ref,
      evidence_sha256: observation.evidence_sha256,
      violations: observation.violations,
      attempts: observation.attempts,
      sequence: identity.sequence,
      checks: observation.evidence.checks,
    };
    // 让 Role 每轮都看到剩余墙钟，而不是只在启动时拿到一个绝对 deadline；
    // 否则长任务会按“还有几十次派工”的惯性排期，无法为最终验证留窗口。
    const budgetAfter = options.budget.snapshot(now());
    const dispatchesLeft = Math.max(
      0,
      budgetAfter.frozen.limits.max_dispatches - budgetAfter.consumed.dispatches,
    );
    const roleTokensLeft = Math.max(
      0,
      budgetAfter.frozen.limits.role_token_budget - budgetAfter.consumed.tokens,
    );
    data.budget_after =
      process.env.NEWIDE_ROLE_TIME_BLIND === '1'
        ? { dispatches_left: dispatchesLeft, role_tokens_left: roleTokensLeft }
        : {
            wall_clock_remaining_ms: budgetAfter.wall_clock_remaining_ms,
            deadline_at: budgetAfter.frozen.deadline_at,
            dispatches_left: dispatchesLeft,
            role_tokens_left: roleTokensLeft,
          };
    if (
      built.brief.kind === 'verify' &&
      !observation.evidence.checks.some((check) => check.provenance === 'host_observed')
    ) {
      data.verification_gap =
        '本次派工没有宿主检查证据；如需验证命令，请用 verify + fresh + verification_command ' +
        '给出 executable/args。不要重复同样的自然语言派工取证；无法验证时如实 finish(blocked)。';
    }
    if (observation.evidence.response_excerpt !== undefined) {
      data.response_excerpt = observation.evidence.response_excerpt;
    }
    if (observation.status === 'unknown') {
      // unknown 不会被宿主自动当作成功或失败；Role 若接续这项工作，必须显式建立
      // retry 链，否则 finish(completed) 会被“未收束 unknown”拒绝。unknown 目标还要求
      // reconciliation_ref 取证，所以把现成的 ref 直接写进提示，避免 Role 只写 retry_of
      // 后被 journal 拒绝、再被误报成宿主写失败。
      const reconciliation = JSON.stringify({
        path: observation.evidence_ref.path,
        sha256: observation.evidence_sha256,
      });
      data.recovery_hint =
        `Dispatch ${observation.dispatch_id} is unresolved (status=unknown). ` +
        `To recover its work, send a dispatch with retry_of="${observation.dispatch_id}" ` +
        `AND reconciliation_ref=${reconciliation}; ` +
        'without both fields the retry is rejected and the run cannot finish as completed. ' +
        'A verify dispatch that changed no workspace files is treated as harmless.';
    }
    if (options.context.frozen_driver_id !== undefined) {
      data.frozen_driver_id = options.context.frozen_driver_id;
    }
    return { ok: true, data };
  };

  const executeQueryMemory = async (args: RoleQueryMemoryArgs): Promise<RoleToolResult> => {
    try {
      const result = await options.memory.query({
        query: args.query,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      return { ok: true, data: { text: result.text, count: result.count } };
    } catch (error) {
      return toolError('ROLE_MEMORY_UNAVAILABLE', 'role memory query is unavailable', {
        reason: describeError(error),
      });
    }
  };

  const executeReadEvidence = async (args: RoleReadEvidenceArgs): Promise<RoleToolResult> => {
    try {
      const page = await options.journal.readEvidence(args.ref, {
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      return {
        ok: true,
        data: {
          text: page.text,
          offset: page.offset,
          limit: page.limit,
          total_bytes: page.total_bytes,
          truncated: page.truncated,
          sha256: page.sha256,
        },
      };
    } catch (error) {
      return toolError('ROLE_EVIDENCE_UNAVAILABLE', 'evidence ref is not readable', {
        reason: describeError(error),
        ...(journalErrorCode(error) !== undefined ? { journal_code: journalErrorCode(error) } : {}),
      });
    }
  };

  const executeUpdatePlan = async (args: RoleUpdatePlanArgs): Promise<RoleToolResult> => {
    plan = args.plan;
    // 计划只是 role 的自述事实（投影用），不是执行/完成证据；观察失败不影响工具结果。
    options.on_plan_updated?.(plan);
    return { ok: true, data: { plan, updated: true } };
  };

  const executeFinish = async (args: RoleFinishArgs): Promise<RoleToolResult> => {
    // 最终交付对象事实在 finish 时刻现算：内容指纹用于拒绝过期检查证据
    // （旧版本成功后又修改）；语义验收由 role 的 verification 陈述负责。
    const workspaceState =
      options.context.workspace_fingerprint !== undefined
        ? await options.context.workspace_fingerprint().catch(() => undefined)
        : undefined;
    const decision = await options.finish.validate({
      request: args,
      journal: options.journal,
      context: options.context,
      budget: options.budget,
      dispatches: [...dispatches],
      cancelled: cancelled(),
      ...(workspaceState?.sha256 !== undefined
        ? { current_workspace_sha256: workspaceState.sha256 }
        : {}),
      now: now(),
    });
    if (!decision.accepted) {
      return {
        ok: false,
        error: {
          code: 'ROLE_FINISH_REJECTED',
          message: 'finish_task was rejected by the host',
          detail: { gaps: decision.gaps ?? [] },
        },
      };
    }
    if (decision.record === undefined) {
      throw new RoleTerminationError({
        code: 'host_failed',
        actor: 'host',
        message: 'finish validator accepted without returning a finish record',
      });
    }
    finished = true;
    finishRecord = decision.record;
    return {
      ok: true,
      data: {
        accepted: true,
        status: decision.record.status,
        summary: decision.record.summary,
        evidence_refs: decision.record.evidence_refs,
        unresolved: decision.record.unresolved,
        response_only: decision.record.response_only,
        zero_dispatch: dispatches.length === 0,
      },
    };
  };

  const executor: RoleToolExecutor = {
    definitions,
    get dispatches(): readonly RoleDispatchObservation[] {
      return dispatches;
    },
    get plan(): string | undefined {
      return plan;
    },
    get finished(): boolean {
      return finished;
    },
    get finishRecord(): RoleFinishRecord | undefined {
      return finishRecord;
    },
    async execute(call: ToolCall): Promise<RoleToolResult> {
      const name = call.function.name;
      if (!isRoleToolName(name) || !allowlist.has(name)) {
        return toolError('ROLE_UNKNOWN_TOOL', `tool ${name} is not in the role tool allowlist`);
      }
      if (finished) {
        return toolError(
          'ROLE_ALREADY_FINISHED',
          'finish_task was already accepted; no further tools are allowed',
        );
      }
      const parsed = parseRoleToolCallArguments(name, call.function.arguments);
      if (!parsed.ok) {
        return toolError('ROLE_INVALID_ARGUMENTS', parsed.message);
      }
      switch (parsed.parsed.name) {
        case 'dispatch_execution':
          return executeDispatch(parsed.parsed.args);
        case 'query_memory':
          return executeQueryMemory(parsed.parsed.args);
        case 'read_evidence':
          return executeReadEvidence(parsed.parsed.args);
        case 'update_plan':
          return executeUpdatePlan(parsed.parsed.args);
        case 'finish_task':
          return executeFinish(parsed.parsed.args);
      }
    },
  };
  return executor;
}

// ─────────────────────────────────────────────────────────────
// 辅助
// ─────────────────────────────────────────────────────────────

function toolError(
  code: RoleToolResult['error'] extends { code: infer C } | undefined ? C : never,
  message: string,
  detail?: unknown,
): RoleToolResult {
  return {
    ok: false,
    error: { code, message, ...(detail !== undefined ? { detail } : {}) },
  };
}

function journalErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1_000);
  return String(error).slice(0, 1_000);
}
