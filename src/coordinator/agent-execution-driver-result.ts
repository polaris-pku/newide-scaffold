/**
 * AgentExecutionResult 到 DriverRunResult 的兼容 adapter。
 *
 * 现有 v0 flow 下游仍消费 DriverRunResult；B path 先用这个薄 adapter 复用既有
 * artifact selection / gate / materialization 逻辑，不替换 direct-A baseline。
 */
import { nowTimestamp, type SchemaVersion } from '../core';
import type { DriverRunResult, DriverRunStatus } from '../driver';
import type { AgentExecutionResult, AgentExecutionStatus } from '../protocol/agent-execution';

export interface BuildDriverRunResultFromAgentExecutionInput {
  result: AgentExecutionResult;
  session_id?: string;
  schema_version: SchemaVersion;
}

export function buildDriverRunResultFromAgentExecution(
  input: BuildDriverRunResultFromAgentExecutionInput,
): DriverRunResult {
  return {
    driver_run_result_id: input.result.driver_run_result_id,
    session_id: input.result.session_id || input.session_id || `agent:${input.result.agent_run_id}`,
    status: mapAgentExecutionStatus(input.result.status),
    response: input.result.response,
    artifacts: [...input.result.artifact_refs],
    transcript_ref: input.result.transcript_ref,
    tool_events: [...input.result.tool_events],
    diagnostics: {
      driver_id: String(input.result.diagnostics.driver_id ?? input.result.role_id),
      duration_ms: readDurationMs(input.result.diagnostics.duration_ms),
      notes: ['Adapted from AgentExecutionFacade result.'],
    },
    ...(input.result.status === 'failed'
      ? {
          error: {
            code: String(input.result.diagnostics.driver_error_code ?? 'AGENT_EXECUTION_FAILED'),
            message: 'Agent execution failed.',
            retryable: false,
          },
        }
      : {}),
    created_at: nowTimestamp(),
    schema_version: input.schema_version,
  };
}

function mapAgentExecutionStatus(status: AgentExecutionStatus): DriverRunStatus {
  switch (status) {
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'interrupted':
      return 'interrupted';
  }
}

function readDurationMs(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}
