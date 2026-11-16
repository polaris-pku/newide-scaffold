/**
 * role-execution-loop — 阶段 2 的 role 自主循环（单一 `execute_agent` 阶段内的多轮决策）。
 *
 * 职责与核心逻辑：
 * - 首轮上下文 = 冻结策略 + 任务指令 + 自动召回文本；role 决定给 driver 的指导，driver 只执行
 *   本次 Brief 指令（不继承原始任务锁定，RD-DIS-05 / 计划 §6.3）。
 * - 回合循环固定三拍：`budget.assertRoundAllowed` → `llm.completeWithTools` →
 *   `budget.recordRound(round, usage)` → 串行执行本回复的 tool_calls。
 *   **纯文本（含“完成/done”）不结束循环**；零派工也必须显式 `finish_task`。
 * - 工具执行全部委托给隔离工具表（role-autonomy-tools）；同一回复多个 dispatch 串行执行；
 *   finish 接受后剩余工具由工具表以 `ROLE_ALREADY_FINISHED` 拒绝。
 * - finish 接受后由本 loop 调用 `role-autonomy-finish` 的唯一生产落盘点 `persistRoleFinish`
 *   （actor=role，带 summary/unresolved/role_reflection/response_only/verification/zero_dispatch）；
 *   写失败抛 `RoleTerminationError({code:'journal_write_failed',actor:'host'})`，然后返回
 *   {@link RoleLoopOutcome}（status 取 finish.status）。
 * - 取消（AbortSignal）/预算触限/写屏障失败/LLM 异常一律抛 {@link RoleTerminationError}，
 *   本 loop 不吞、不返回 outcome；usage 缺失只标 `usage_missing`，绝不填 0。
 * - 历史与工具结果按 `limits` 截断，避免上下文无限增长。
 *
 * 边界：本文件不直接调用 driver/persistence 运行时（只依赖共享契约端口），不写 Task/Run 终态；
 * Gate/Deliver 与 C 层游标仍由既有提交路径负责（RD-FIN-01 / RD-TRM-01）。
 */
import type { ToolCallMessage } from '../memory';
import type {
  RoleFrozenPolicy,
  RoleLlmCompletion,
  RoleLoopOptions,
  RoleLoopOutcome,
} from './role-autonomy-contract';
import {
  isRoleAutonomySwitchCombinationValid,
  resolveUnresolvedDispatchIds,
  ROLE_TOOL_NAMES,
  RoleTerminationError,
} from './role-autonomy-contract';
import { persistRoleFinish } from './role-autonomy-finish';
import { createRoleToolExecutor } from './role-autonomy-tools';
import { armAbortDeadline } from './role-deadline';

/** 历史消息上限（含 system/assistant/tool；超限从最旧的对话消息开始丢）。 */
const DEFAULT_HISTORY_MESSAGES = 80;
/** 单个工具结果 JSON 字符上限；超出截断并打标记（不静默丢失事实类型）。 */
const DEFAULT_TOOL_RESULT_CHARS = 8_000;
/** 保留完整内容的最近 dispatch 工具结果条数；更早的压缩成占位符。 */
const DEFAULT_DISPATCH_HISTORY = 12;
const TRUNCATION_MARKER = '…[truncated]';

interface ResolvedLimits {
  history_messages: number;
  tool_result_chars: number;
  dispatch_history: number;
}

/**
 * 运行 role 自主循环，直到 role 显式 finish（返回 outcome）或宿主终止（抛 typed termination）。
 *
 * 不变量：
 * - 只有 finish 被接受才返回；纯文本/单次 driver 成功都不会结束。
 * - 预算检查在调用 LLM 之前、派工之前各一次；取消在每个 LLM 调用与每个工具调用之前检查。
 * - `journal.appendFinish` 失败视为宿主失败（journal_write_failed），不返回成功 outcome。
 */
export async function runRoleExecutionLoop(options: RoleLoopOptions): Promise<RoleLoopOutcome> {
  const now = options.clock ?? (() => new Date());
  const limits = resolveLimits(options.limits);
  validatePolicy(options.policy);
  throwIfCancelled(options.signal);
  // 恢复时额度已耗尽：不得先做记忆召回/LLM 等外部调用才发现（RD-TRM-03）。
  options.budget.assertRoundAllowed(now());
  options.budget.assertTokenBudget(now());

  const recallText = await recallMemory(options, now);
  const messages: ToolCallMessage[] = [
    { role: 'system', content: buildSystemPrompt(options, recallText) },
    { role: 'user', content: options.context.instruction },
  ];
  const executor = createRoleToolExecutor({
    journal: options.journal,
    dispatch: options.dispatch,
    memory: options.memory,
    budget: options.budget,
    finish: options.finish,
    policy: options.policy,
    context: options.context,
    now,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.on_plan_updated !== undefined ? { on_plan_updated: options.on_plan_updated } : {}),
  });

  let round = Math.max(0, Math.trunc(options.consumed.role_rounds));
  let inputTokens = 0;
  let outputTokens = 0;
  let usageMissing = options.consumed.tokens_missing;

  for (;;) {
    throwIfCancelled(options.signal);
    options.budget.assertRoundAllowed(now());
    round += 1;

    let completion: RoleLlmCompletion;
    try {
      completion = await runGuarded(options, now, (signal) =>
        options.llm.completeWithTools({
          messages: snapshotMessages(messages),
          tools: executor.definitions,
          signal,
        }),
      );
    } catch (error) {
      // LLM 因取消而失败时优先按用户取消收束；其它异常是宿主失败。
      throwIfCancelled(options.signal);
      if (error instanceof RoleTerminationError) throw error;
      throw new RoleTerminationError(
        {
          code: 'host_failed',
          actor: 'host',
          message: 'role LLM call failed',
          details: { round },
        },
        error,
      );
    }

    // 缺失 usage 只标 missing（不填 0）；已有 usage 才累计 token。
    if (completion.usage !== undefined) {
      inputTokens += completion.usage.input_tokens;
      outputTokens += completion.usage.output_tokens;
    } else {
      usageMissing = true;
    }
    // 任务级 tool-call 次数在**执行工具之前**按本回复声明的调用计入并检查；
    // 超限直接抛 budget_tool_calls，不产生半个回复的副作用。
    // `finish_task` 是结束控制而不是环境动作，不计入任务级 tool-call 上限。
    const countedToolCalls =
      completion.tool_calls?.filter((call) => call.function.name !== 'finish_task').length ?? 0;
    await options.budget.recordRound(
      round,
      completion.usage,
      now().toISOString(),
      countedToolCalls,
    );
    options.budget.assertTokenBudget(now());

    messages.push(assistantMessage(completion));

    // 同一回复多个 tool_call：串行执行；finish 接受后剩余工具由工具表拒绝（不产生副作用）。
    for (const call of completion.tool_calls ?? []) {
      throwIfCancelled(options.signal);
      // 工具执行同样受总墙钟/取消约束：底层不响应时上层停止等待并封锁后续副作用。
      const result = await runGuarded(options, now, () => executor.execute(call));
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: truncateToolContent(JSON.stringify(result), limits.tool_result_chars),
      });
    }

    const finishRecord = executor.finishRecord;
    if (finishRecord !== undefined) {
      // 阶段 4：结束请求也是低频投影事实（在唯一落盘点之前上报，失败不影响落盘语义）。
      options.on_finish_requested?.({
        status: finishRecord.status,
        verification_count: finishRecord.verification.length,
        unresolved_count: finishRecord.unresolved.length,
      });
      const recoveredDispatches = options.context.recovered_dispatches ?? [];
      const recoveredUnresolved = options.context.recovered_unresolved_dispatches ?? [];
      const allDispatches = [...recoveredDispatches, ...executor.dispatches];
      const zeroDispatch =
        (options.context.recovered_dispatch_count ?? 0) + executor.dispatches.length === 0;
      const unresolvedDispatches = uniqueIds([
        ...recoveredUnresolved,
        ...(await collectUnresolvedDispatchIds(options)),
      ]);
      // 唯一生产落盘点：finish 行由 role-autonomy-finish 的 persistRoleFinish 写入
      // （与测试共用同一入口，时间/entry_id/zero_dispatch/错误映射只维护一份）。
      await runGuarded(options, now, () =>
        persistRoleFinish({
          journal: options.journal,
          record: finishRecord,
          zero_dispatch: zeroDispatch,
        }),
      );
      return {
        status: finishRecord.status,
        finish: finishRecord,
        // 最终答复 = 已接受 finish 的 summary：不拿调查阶段的旧正文冒充（RD-FIN-01/04）。
        response: finishRecord.summary,
        dispatches: allDispatches,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          usage_missing: usageMissing,
          role_rounds: round,
        },
        zero_dispatch: zeroDispatch,
        plan: executor.plan,
        unresolved_dispatches: unresolvedDispatches,
      };
    }

    trimHistory(messages, limits.history_messages);
    compressOldDispatchResults(messages, limits.dispatch_history);
  }
}

// ─────────────────────────────────────────────────────────────
// outcome 辅助
// ─────────────────────────────────────────────────────────────

/**
 * 未收束 dispatch：统一 reducer 的结果（本次观察不额外合并——它们已经在 Journal 折叠里；
 * 只保留 Journal 折叠失败时不伪造、不崩的语义）。恢复前的 unknown 由上下文单独传入。
 */
async function collectUnresolvedDispatchIds(options: RoleLoopOptions): Promise<string[]> {
  try {
    const fold = await options.journal.fold();
    return resolveUnresolvedDispatchIds(fold.records);
  } catch {
    // Journal 折叠失败不应把已接受的 finish 变成异常；以恢复前事实为准。
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 首轮上下文
// ─────────────────────────────────────────────────────────────

async function recallMemory(options: RoleLoopOptions, now: () => Date): Promise<string> {
  try {
    const recall = await runGuarded(options, now, (signal) =>
      options.memory.recall(
        {
          task_id: options.context.task_id,
          run_id: options.context.run_id,
          role_id: options.context.role_id,
          instruction: options.context.instruction,
          ...(options.context.workspace_path !== undefined
            ? { workspace_path: options.context.workspace_path }
            : {}),
        },
        signal,
      ),
    );
    return recall.text;
  } catch (error) {
    // 取消/墙钟必须终止；记忆不可用只是增强项缺失。
    if (isTerminalGuardError(error)) throw error;
    return '（自动召回不可用）';
  }
}

/** 实验开关：不向 Role 暴露剩余时间（deadline / wall clock），用于“无时间信息”对照。 */
function roleTimeBlind(): boolean {
  return process.env.NEWIDE_ROLE_TIME_BLIND === '1';
}

function buildSystemPrompt(options: RoleLoopOptions, recallText: string): string {
  const { policy, context } = options;
  const limits = policy.budget.limits;
  const lines = [
    `你是 role ${context.role_id}（run ${context.run_id}，task ${context.task_id}），` +
      `执行引擎 ${policy.engine} ${policy.engine_version}。`,
    '你决定给 driver 的指导；driver 只执行你本次 dispatch_execution 的 Brief 指令，' +
      '不继承原始任务的锁定。',
    `任务指令：${context.instruction}`,
    `冻结预算：max_dispatches=${limits.max_dispatches}，max_role_rounds=${limits.max_role_rounds}，` +
      `role_token_budget=${limits.role_token_budget}，dispatch_timeout_ms=${limits.dispatch_timeout_ms}` +
      (roleTimeBlind() ? '。' : `，deadline_at=${policy.budget.deadline_at}。`),
    `允许工具（仅这些）：${policy.tool_allowlist.join('、')}。`,
    '同一回复里的多个 dispatch_execution 会按顺序串行执行；driver 的 succeeded 只代表本次派工' +
      '返回成功，不代表任务完成。',
    '纯文本（包括“完成/done/已完成”等）不会结束任务；必须调用 finish_task 显式结束。',
    '需要运行测试或其他明确验证命令时，优先 dispatch_execution(kind="verify", ' +
      'session={mode:"fresh"}, verification_command={executable:"node",args:["verify.mjs"]})；' +
      '用实际项目命令替换示例。该派工直接执行命令，不再询问 coding agent，checks 返回真实退出码与证据。' +
      '会写项目文件的验证请声明 read_only=false。纯调查/无需运行命令的任务不要为了结束再额外派 verify。' +
      '没有宿主证据的自然语言 verify 不应重复取证；改用明确命令，或如实说明限制并 finish(blocked)。',
    '**任务要求是否满足由你判断**：宿主不会从 completion_criteria 文本自动推导检查义务、也不解析命令。' +
      'finish_task 时用 verification 逐条说明：passed（你确认已满足，必须引用真实派工，宿主会核验该派工' +
      '是否有 host_observed + complete + exit 0 且内容指纹与最终交付一致的检查证据）、failed（尝试过但未满足）、' +
      'not_run（未验证/无法验证）。没有真实检查证据就写 passed 会被拒绝；driver 自述不是宿主观察。' +
      '未验证的要求请如实写成 not_run/failed 或列进 unresolved，不要编造。',
    `finish 上下文：response_only_allowed=${String(context.response_only_allowed)}。`,
  ];
  if (context.frozen_driver_id !== undefined) {
    lines.push(`冻结 driver：${context.frozen_driver_id}（仅作记录/回显）。`);
  }
  if (context.confirmed_session_id !== undefined) {
    lines.push(`可复用 Session：${context.confirmed_session_id}（reuse 只能复用它）。`);
  }
  if (context.recovery_summary !== undefined && context.recovery_summary.length > 0) {
    lines.push(`恢复上下文（只读事实，不自动重放）：\n${context.recovery_summary}`);
  }
  if (context.workspace_fingerprint !== undefined) {
    lines.push(
      '检查证据的适用性：host_observed 检查只有在检查结束时工作区内容与最终交付一致时才算通过' +
        '（检查后再改代码 → 旧证据过期，需要重新检查最终版本）。',
    );
  }
  lines.push(`自动召回记忆：\n${recallText.length > 0 ? recallText : '（无）'}`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// 终止与校验
// ─────────────────────────────────────────────────────────────

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw cancelledTermination();
}

function cancelledTermination(): RoleTerminationError {
  return new RoleTerminationError({
    code: 'host_cancelled',
    actor: 'user',
    message: 'role execution cancelled by user signal',
    details: { reason: 'cancelled' },
  });
}

function wallClockTermination(options: RoleLoopOptions, now: () => Date): RoleTerminationError {
  return new RoleTerminationError({
    code: 'budget_wall_clock',
    actor: 'host',
    message: `role wall clock exhausted (deadline ${options.policy.budget.deadline_at})`,
    details: {
      deadline_at: options.policy.budget.deadline_at,
      now: now().toISOString(),
    },
  });
}

function isTerminalGuardError(error: unknown): boolean {
  return error instanceof RoleTerminationError;
}

/**
 * 覆盖**在途等待**的取消/总墙钟守卫：
 * - 冻结绝对 deadline（不是「调用前检查一次」）控制整段外部等待；
 * - 向底层传递 AbortSignal；底层不响应时，上层仍停止等待并封锁后续副作用；
 * - 迟到 resolve/reject 被显式吞掉，不产生未处理 rejection、不覆盖终态；
 * - 用户取消与墙钟预算用不同原因码区分。
 */
async function runGuarded<T>(
  options: RoleLoopOptions,
  now: () => Date,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (options.signal?.aborted === true) throw cancelledTermination();
  const deadlineMs = Date.parse(options.policy.budget.deadline_at);
  if (!Number.isFinite(deadlineMs)) {
    throw new RoleTerminationError({
      code: 'host_failed',
      actor: 'host',
      message: `invalid frozen deadline_at: ${options.policy.budget.deadline_at}`,
    });
  }
  const remaining = deadlineMs - now().getTime();
  if (remaining <= 0) throw wallClockTermination(options, now);

  const deadline = new AbortController();
  // setTimeout 超过 2^31-1 ms 会被 Node 截成 1ms；长 deadline 必须分段续挂。
  const disarm = armAbortDeadline(deadline, remaining);
  const signal =
    options.signal !== undefined
      ? AbortSignal.any([deadline.signal, options.signal])
      : deadline.signal;
  try {
    const pending = operation(signal);
    // 迟到 rejection 必须被消费：abort 胜出后底层 promise 仍可能失败。
    pending.catch(() => undefined);
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      function cleanup(): void {
        signal.removeEventListener('abort', onAbort);
      }
      function onAbort(): void {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          options.signal?.aborted === true
            ? cancelledTermination()
            : wallClockTermination(options, now),
        );
      }
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  } finally {
    disarm();
  }
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}

/**
 * 冻结策略自检：引擎标记/开关组合/工具授权/预算上限非法时按宿主失败终止，
 * 不得用部署默认值补一份假冻结记录（RD-SEL-03/05）。
 */
function validatePolicy(policy: RoleFrozenPolicy): void {
  const problems: string[] = [];
  if (policy.engine !== 'role_autonomy') problems.push('engine');
  // 阶段 3：两个开关都已实现，但仍只接受合法组合（buffer_v2 依赖 evidence_only）。
  if (
    !isRoleAutonomySwitchCombinationValid({
      evidence_only: policy.evidence_only,
      buffer_v2: policy.buffer_v2,
    })
  ) {
    problems.push('buffer_v2_without_evidence_only');
  }
  if (!Array.isArray(policy.tool_allowlist) || policy.tool_allowlist.length === 0) {
    problems.push('tool_allowlist');
  } else {
    const unknownTools = policy.tool_allowlist.filter(
      (tool) => !(ROLE_TOOL_NAMES as readonly string[]).includes(tool),
    );
    if (unknownTools.length > 0) problems.push(`tool_allowlist:${unknownTools.join(',')}`);
  }
  const limits = policy.budget.limits;
  for (const key of [
    'max_dispatches',
    'max_role_rounds',
    'role_token_budget',
    'wall_clock_seconds',
    'dispatch_timeout_ms',
  ] as const) {
    if (!Number.isInteger(limits[key]) || limits[key] <= 0) problems.push(`budget.${key}`);
  }
  if (Number.isNaN(Date.parse(policy.budget.deadline_at))) problems.push('budget.deadline_at');
  if (problems.length === 0) return;
  throw new RoleTerminationError({
    code: 'host_failed',
    actor: 'host',
    message: `invalid frozen role policy: ${problems.join(', ')}`,
    details: { problems },
  });
}

// ─────────────────────────────────────────────────────────────
// 历史/大小限制
// ─────────────────────────────────────────────────────────────

function resolveLimits(limits: RoleLoopOptions['limits']): ResolvedLimits {
  return {
    history_messages: Math.max(2, limits?.history_messages ?? DEFAULT_HISTORY_MESSAGES),
    tool_result_chars: Math.max(256, limits?.tool_result_chars ?? DEFAULT_TOOL_RESULT_CHARS),
    dispatch_history: Math.max(1, limits?.dispatch_history ?? DEFAULT_DISPATCH_HISTORY),
  };
}

function assistantMessage(completion: RoleLlmCompletion): ToolCallMessage {
  const message: ToolCallMessage = { role: 'assistant', content: completion.content };
  if (completion.tool_calls !== undefined && completion.tool_calls.length > 0) {
    message.tool_calls = completion.tool_calls;
  }
  return message;
}

function snapshotMessages(messages: readonly ToolCallMessage[]): ToolCallMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.tool_calls !== undefined ? { tool_calls: [...message.tool_calls] } : {}),
  }));
}

function truncateToolContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const keep = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return `${content.slice(0, keep)}${TRUNCATION_MARKER}`;
}

/**
 * 从最旧的对话消息开始丢弃，保留 system 提示；不把「tool 消息」放在没有对应
 * assistant tool_call 的位置（避免破坏 tool-calling 配对）。
 */
function trimHistory(messages: ToolCallMessage[], maxMessages: number): void {
  if (messages.length <= maxMessages) return;
  const system = messages[0];
  let keepFrom = messages.length - (maxMessages - 1);
  while (keepFrom < messages.length && messages[keepFrom]?.role === 'tool') keepFrom += 1;
  const kept = messages.slice(keepFrom);
  messages.length = 0;
  if (system !== undefined) messages.push(system);
  messages.push(...kept);
}

/** 只保留最近 N 条 dispatch 工具结果的完整内容；更早的压缩成占位符。 */
function compressOldDispatchResults(
  messages: ToolCallMessage[],
  keepDispatchResults: number,
): void {
  const dispatchResultIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'tool') continue;
    if (isDispatchToolResult(message.content)) dispatchResultIndexes.push(index);
  }
  if (dispatchResultIndexes.length <= keepDispatchResults) return;
  const dropCount = dispatchResultIndexes.length - keepDispatchResults;
  for (const index of dispatchResultIndexes.slice(0, dropCount)) {
    const message = messages[index];
    if (message === undefined) continue;
    messages[index] = {
      role: 'tool',
      ...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}),
      content: JSON.stringify({ truncated: true, reason: 'dispatch_history_limit' }),
    };
  }
}

function isDispatchToolResult(content: string | null): boolean {
  if (content === null) return false;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== 'object') return false;
    return typeof Reflect.get(parsed, 'dispatch_id') === 'string';
  } catch {
    return false;
  }
}
