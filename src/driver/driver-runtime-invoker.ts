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
  call_id: string;
  source_driver: string;
  driver_context: {
    task_instruction: string;
    skills: DriverRuntimeInvokerMemoryItem[];
    experiences: DriverRuntimeInvokerMemoryItem[];
  };
}

export interface DriverRuntimeInvokerOptions {
  signal?: AbortSignal;
  onDriverEvent?: DriverStreamEventListener;
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
  report: DriverRuntimeReport;
  execution: DriverRunResult;
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

    const runId = input.run_id ?? input.call_id;
    let execution: DriverRunResult;
    try {
      execution = await runDriverPromptWithSignal(
        driver,
        {
          task_id: input.task_id,
          run_id: runId,
          ...(input.workspace_path ? { workspace_path: input.workspace_path } : {}),
          ...(input.session_id ? { session_id: input.session_id } : {}),
          prompt: buildDriverPrompt(input),
          created_at: nowTimestamp(),
          schema_version: SCHEMA_VERSION,
        },
        options?.signal,
        options?.onDriverEvent,
      );
    } catch (error) {
      if (isAbort(error, options?.signal)) throw error;
      execution = failedExecution(driver, input, error);
    }

    const report = await converter(execution, {
      ...(execution.response ? { transcriptText: execution.response } : {}),
      instruction: input.driver_context.task_instruction,
      sourceDriver: input.source_driver,
      taskId: input.task_id,
      ...(input.workspace_path ? { workspace: input.workspace_path } : {}),
    });
    return { report, execution };
  };
}

function buildDriverPrompt(input: DriverRuntimeInvokerInput): string {
  const context = deterministicJson({
    task_instruction: input.driver_context.task_instruction,
    skills: input.driver_context.skills,
    experiences: input.driver_context.experiences,
  });
  const reportInstruction = buildDriverReturnInstruction({
    taskId: input.task_id,
    writeReportFile: shouldWriteDriverReportFile(),
  });
  return `${context}\n\n${reportInstruction}`;
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
