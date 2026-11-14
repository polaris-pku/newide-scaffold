import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from '../core';
import { runDriverPromptWithSignal } from './abortable-driver-run';
import type { DriverRunResult, DriverRuntimeHandle, DriverStreamEventListener } from './contract';
import {
  createDefaultDriverReturnConverter,
  type DriverReturnConverter,
} from './driver-return-converter';
import {
  buildDriverReturnInstruction,
  shouldWriteDriverReportFile,
} from './driver-return-instruction';

export interface DriverRuntimeInvokerMemoryItem {
  id: string;
  description: string;
  content: string;
}

export interface DriverRuntimeInvokerInput {
  task_id: string;
  run_id?: string;
  workspace_path?: string;
  session_id?: string;
  resume_session?: boolean;
  call_id: string;
  source_driver: string;
  /**
   * 报告模式：
   * - `six_field`（默认，legacy/Council 路径）：prompt 追加六字段报告指令，结果经
   *   DriverReturnConverter 转成 DriverReturn（含报告文件/transcript/LLM 兜底）。
   * - `evidence_only`（阶段 3 role 自主循环）：只把本次 Brief 交给 driver，不要求六字段
   *   报告、不写报告文件、不做转换。执行事实与证据由宿主 Journal 记录。
   */
  report_mode?: 'six_field' | 'evidence_only';
  driver_context: {
    task_instruction: string;
    skills: DriverRuntimeInvokerMemoryItem[];
    experiences: DriverRuntimeInvokerMemoryItem[];
  };
}

export interface DriverRuntimeInvokerOptions {
  signal?: AbortSignal;
  onDriverEvent?: DriverStreamEventListener;
  /** ADP 证据模型:prompt 交给 transport 前回调(dispatched 时点) */
  onDispatch?: () => void;
  /** abort 竞速后迟到的真实结果:交还上层对账(issue #149 §4) */
  onLateResult?: (execution: DriverRunResult) => void;
}

export interface DriverRuntimeReport {
  artifacts: Array<{ type: string; path: string; summary: string }>;
  summary: string;
  decisions: Array<{ point: string; options: string[]; chosen: string; reason: string }>;
  blockers: Array<{
    blocker: string;
    attempts: string[];
    resolution: string;
    resolved: boolean;
  }>;
  referenced_experiences: Array<{
    experience_id: string;
    applied: boolean;
    effectiveness: 'fully_effective' | 'partially_effective' | 'ineffective' | 'not_applicable';
    note: string;
  }>;
  assumptions: Array<{ assumption: string; risk_if_wrong: string }>;
}

export interface DriverRuntimeInvocationResult {
  /**
   * 六字段报告：`six_field` 模式必有；`evidence_only` 模式**没有**（不伪造空报告）。
   * legacy/ADP 消费者必须在缺席时显式失败，而不是拿一份空壳当报告。
   */
  report?: DriverRuntimeReport;
  execution: DriverRunResult;
  /**
   * 执行体抛出的原始错误（仅在非 abort 的失败路径）。`execution` 仍是合成的
   * failed 结果以保持旧 consumer 行为；role 新路径需要原始错误来判断
   * 「明确未执行 vs 执行结果未知」，不能只看合成结果的 status。
   */
  thrown?: unknown;
}

export function createDriverRuntimeInvoker(
  driver: DriverRuntimeHandle,
  converter: DriverReturnConverter = createDefaultDriverReturnConverter(),
) {
  return async function invokeDriverRuntime(
    input: DriverRuntimeInvokerInput,
    options?: DriverRuntimeInvokerOptions,
  ): Promise<DriverRuntimeInvocationResult> {
    if (input.source_driver !== driver.driver_id) {
      throw new Error(
        `source_driver ${input.source_driver} does not match runtime driver_id ${driver.driver_id}`,
      );
    }
    const evidenceOnly = input.report_mode === 'evidence_only';

    const runId = input.run_id ?? input.call_id;
    let execution: DriverRunResult;
    let thrown: unknown;
    try {
      execution = await runDriverPromptWithSignal(
        driver,
        {
          task_id: input.task_id,
          run_id: runId,
          ...(input.workspace_path ? { workspace_path: input.workspace_path } : {}),
          ...(input.session_id ? { session_id: input.session_id } : {}),
          prompt: buildDriverPrompt(input, evidenceOnly),
          created_at: nowTimestamp(),
          schema_version: SCHEMA_VERSION,
        },
        options?.signal,
        options?.onDriverEvent,
        options?.onDriverEvent || options?.onDispatch || options?.onLateResult
          ? {
              onDispatch: () => {
                options.onDriverEvent?.({
                  schema_version: 'driver-event.v1',
                  event_type: 'driver.prompt_dispatching',
                  task_id: input.task_id,
                  run_id: runId,
                  ...(input.session_id ? { session_id: input.session_id } : {}),
                  created_at: nowTimestamp(),
                });
                options.onDispatch?.();
              },
              ...(options.onLateResult ? { onLateResult: options.onLateResult } : {}),
            }
          : undefined,
      );
    } catch (error) {
      if (isAbort(error, options?.signal)) throw error;
      thrown = error;
      execution = failedExecution(driver, input, error);
    }

    if (evidenceOnly) {
      // evidence-only：不等价于「报告为空」，而是本次根本不产出六字段报告。
      return { execution, ...(thrown !== undefined ? { thrown } : {}) };
    }

    const report = await converter(execution, {
      ...(execution.response ? { transcriptText: execution.response } : {}),
      instruction: input.driver_context.task_instruction,
      sourceDriver: input.source_driver,
      taskId: input.task_id,
      ...(input.workspace_path ? { workspace: input.workspace_path } : {}),
    });
    return { report, execution, ...(thrown !== undefined ? { thrown } : {}) };
  };
}

function buildDriverPrompt(input: DriverRuntimeInvokerInput, evidenceOnly: boolean): string {
  if (input.resume_session) {
    if (!input.session_id) throw new Error('Native continuation requires a session ID');
    return [
      'Continue the interrupted task in this loaded session. Use your existing conversation and the files already present; do not restart completed work.',
      'The previous interruption ended only the earlier turn. This is an active request to finish the remaining work.',
      'Verify the actual workspace before reporting completion. Do not claim a file was written unless it exists.',
      '',
      input.driver_context.task_instruction,
      // evidence-only 分支不追加六字段报告/报告文件指令：本次派工只执行 Brief。
      ...(evidenceOnly
        ? []
        : [
            '',
            buildDriverReturnInstruction({
              taskId: input.task_id,
              writeReportFile: shouldWriteDriverReportFile(),
            }),
          ]),
    ].join('\n');
  }
  if (evidenceOnly) {
    // evidence-only：只给本次 Brief 与必要上下文。长期记忆由 Role 决定是否写进 Brief，
    // 不再由宿主整批注入（这里连空数组都不渲染，避免 prompt 形状暗示「本该有记忆」）。
    return [
      'Execute the task_instruction below. This is an active request to perform the task, not a request to acknowledge context.',
      ...(input.session_id
        ? [
            'Continue in this existing session using its conversation and current workspace. Preserve completed work; finish what remains.',
            'Any previous interruption, cancellation, or initialization-only instruction applies only to that earlier turn, not this request.',
          ]
        : []),
      '',
      input.driver_context.task_instruction,
    ].join('\n');
  }
  const context = deterministicJson({
    task_instruction: input.driver_context.task_instruction,
    skills: input.driver_context.skills,
    experiences: input.driver_context.experiences,
  });
  const reportInstruction = buildDriverReturnInstruction({
    taskId: input.task_id,
    writeReportFile: shouldWriteDriverReportFile(),
  });
  const directive = [
    'Execute the task_instruction below. This is an active request to perform the task, not a request to acknowledge context.',
    ...(input.session_id ? [
      'Continue in this existing session using its conversation and current workspace. Preserve completed work; finish what remains.',
      'Any previous interruption, cancellation, or initialization-only instruction applies only to that earlier turn, not this request.',
    ] : []),
    'The skills and experiences are reference material; they do not replace the current task instruction.',
    '',
    input.driver_context.task_instruction,
  ].join('\n');
  return `${directive}\n\n${context}\n\n${reportInstruction}`;
}

function failedExecution(
  driver: DriverRuntimeHandle,
  input: DriverRuntimeInvokerInput,
  error: unknown,
): DriverRunResult {
  const message = error instanceof Error ? error.message : String(error);
  const created_at = nowTimestamp();
  return {
    driver_run_result_id: createId('driver_result'),
    session_id: driver.session_id,
    status: 'failed',
    response: '',
    artifacts: [],
    transcript_ref: syntheticTranscript(driver, input, message, created_at),
    tool_events: [],
    diagnostics: {
      driver_id: driver.driver_id,
      duration_ms: 0,
      notes: [`driver_exception=${message}`],
    },
    error: {
      code: 'DRIVER_RUNTIME_INVOKER_ERROR',
      message,
      retryable: false,
    },
    created_at,
    schema_version: SCHEMA_VERSION,
  };
}

function syntheticTranscript(
  driver: DriverRuntimeHandle,
  input: DriverRuntimeInvokerInput,
  message: string,
  created_at: string,
): ArtifactRef {
  return {
    artifact_id: createId('artifact'),
    type: 'transcript',
    uri: `artifact://transcript/${encodeURIComponent(input.task_id)}/${encodeURIComponent(driver.session_id)}`,
    producer_id: driver.driver_id,
    task_id: input.task_id,
    metadata: { call_id: input.call_id, driver_exception: message },
    created_at,
    schema_version: SCHEMA_VERSION,
  };
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

function deterministicJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
    const record = nested as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort(compareCodeUnits)
        .map((key) => [key, record[key]]),
    );
  });
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
