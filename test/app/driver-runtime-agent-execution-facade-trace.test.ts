/**
 * DriverRuntimeAgentExecutionFacade 轨迹集成测试：验证配置 trace 后，
 * 顶层 Agent 的一次执行会落出完整的 agent.execution → agent.turn →
 * agent.tool → driver.run span 层级（parent_span_id 显式建链），
 * 且失败 / LLM 异常时的状态映射正确，重放能重建嵌套瀑布。
 */
import { describe, expect, it } from 'vitest';
import { DriverRuntimeAgentExecutionFacade } from '../../src/app/driver-runtime-agent-execution-facade';
import { SCHEMA_VERSION, nowTimestamp, type ArtifactRef } from '../../src/core';
import { MockDriver } from '../../src/driver/mock-driver';
import type {
  DriverCapabilities,
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
} from '../../src/driver';
import { InMemoryBufferRepository, InMemoryRepository } from '../../src/memory';
import type { ToolCallResult, ToolCallingClient } from '../../src/memory';
import { InMemoryTraceStore, TraceProjector, replayTrajectory } from '../../src/trace';

const RUN_ID = 'run_trace_facade_001';
const TASK_ID = 'task_trace_facade_001';
const ROLE_ID = 'role_trace_engineer';

function scriptedLlm(responses: ToolCallResult[]): ToolCallingClient {
  let callIndex = 0;
  return {
    completeWithTools: async () => {
      const response = responses[callIndex];
      if (response === undefined) {
        throw new Error(`Unexpected LLM call #${String(callIndex)}`);
      }
      callIndex += 1;
      return response;
    },
  };
}

function toolCall(name: string, id: string, args: Record<string, unknown>): ToolCallResult {
  return {
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function request(): {
  task_id: string;
  run_id: string;
  role_id: string;
  instruction: string;
  input_artifact_refs: string[];
  context_policy: string;
  schema_version: string;
} {
  return {
    task_id: TASK_ID,
    run_id: RUN_ID,
    role_id: ROLE_ID,
    instruction: 'Execute through B runtime with tool calls.',
    input_artifact_refs: [],
    context_policy: 'default',
    schema_version: SCHEMA_VERSION,
  };
}

function transcriptArtifact(): ArtifactRef {
  return {
    artifact_id: 'artifact_transcript_trace',
    type: 'transcript',
    uri: `artifact://transcript/${TASK_ID}`,
    producer_id: 'mock-driver',
    task_id: TASK_ID,
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function driverResult(status: 'succeeded' | 'failed'): DriverRunResult {
  return {
    driver_run_result_id: 'driver_result_trace',
    session_id: 'mock-session',
    status,
    response: status === 'succeeded' ? 'Done.' : '',
    artifacts: [],
    transcript_ref: transcriptArtifact(),
    tool_events: [],
    diagnostics: { driver_id: 'mock-driver', duration_ms: 1, notes: [] },
    ...(status === 'failed'
      ? { error: { code: 'MOCK_FAILED', message: 'Mock driver failed.', retryable: false } }
      : {}),
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

class StubDriver implements DriverRuntimeHandle {
  readonly driver_id = 'mock-driver';
  readonly session_id = 'mock-session';
  readonly capabilities: DriverCapabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: true,
    supports_permission_events: false,
  };

  constructor(private readonly status: 'succeeded' | 'failed') {}

  async sendPrompt(_input: DriverPrompt): Promise<DriverRunResult> {
    return driverResult(this.status);
  }

  async interrupt(_reason: string): Promise<void> {
    return Promise.resolve();
  }

  async collectTranscript(): Promise<ArtifactRef> {
    return transcriptArtifact();
  }
}

async function runTraced(options: {
  llm: ToolCallingClient;
  driver?: DriverRuntimeHandle;
}): Promise<{ store: InMemoryTraceStore; result: Awaited<ReturnType<DriverRuntimeAgentExecutionFacade['runAgent']>> }> {
  const store = new InMemoryTraceStore();
  const facade = new DriverRuntimeAgentExecutionFacade({
    driver: options.driver ?? new MockDriver(),
    repository: new InMemoryRepository(),
    bufferRepository: new InMemoryBufferRepository(),
    llm: options.llm,
    trace: new TraceProjector(store),
  });
  await facade.ready();
  const result = await facade.runAgent(request());
  return { store, result };
}

describe('DriverRuntimeAgentExecutionFacade trace', () => {
  it('emits agent.execution -> turn -> tool -> driver.run spans with explicit parents', async () => {
    const { store } = await runTraced({
      llm: scriptedLlm([
        {
          content: null,
          tool_calls: [
            {
              id: 'call_query',
              type: 'function',
              function: {
                name: 'query_memory',
                arguments: JSON.stringify({ query: 'past experience' }),
              },
            },
            {
              id: 'call_driver',
              type: 'function',
              function: {
                name: 'invoke_driver',
                arguments: JSON.stringify({ instruction: 'Build the feature' }),
              },
            },
          ],
        },
        { content: 'Task completed. [done]', tool_calls: undefined },
      ]),
    });

    const records = await store.load(RUN_ID);
    expect(records.length).toBeGreaterThan(0);
    for (let i = 1; i < records.length; i += 1) {
      expect(records[i]!.sequence).toBeGreaterThan(records[i - 1]!.sequence);
    }

    const executionStart = records.find(
      (record) => record.kind === 'agent.execution' && record.phase === 'start',
    )!;
    const executionEnd = records.find(
      (record) => record.kind === 'agent.execution' && record.phase === 'end',
    )!;
    expect(executionEnd.span_id).toBe(executionStart.span_id);
    expect(executionEnd.status).toBe('ok');
    expect(executionEnd.agent_id).toBe(ROLE_ID);

    const turnStart = records.find(
      (record) => record.kind === 'agent.turn' && record.phase === 'start',
    )!;
    expect(turnStart.parent_span_id).toBe(executionStart.span_id);
    expect(turnStart.agent_id).toBe(ROLE_ID);
    const turnEnd = records.find(
      (record) => record.kind === 'agent.turn' && record.phase === 'end',
    )!;
    expect(turnEnd.span_id).toBe(turnStart.span_id);
    expect(turnEnd.status).toBe('ok');

    const toolStarts = records.filter(
      (record) => record.kind === 'agent.tool' && record.phase === 'start',
    );
    expect(toolStarts.map((record) => record.summary)).toEqual([
      'query_memory',
      'invoke_driver',
    ]);
    for (const toolStart of toolStarts) {
      expect(toolStart.parent_span_id).toBe(turnStart.span_id);
    }
    const driverToolStart = toolStarts.find((record) => record.summary === 'invoke_driver')!;
    const driverToolEnd = records.find(
      (record) =>
        record.kind === 'agent.tool' &&
        record.phase === 'end' &&
        record.span_id === driverToolStart.span_id,
    )!;
    expect(driverToolEnd.status).toBe('ok');
    expect(driverToolEnd.summary).toBe('invoke_driver → ok');

    const driverStart = records.find(
      (record) => record.kind === 'driver.run' && record.phase === 'start',
    )!;
    expect(driverStart.parent_span_id).toBe(driverToolStart.span_id);
    const driverEnd = records.find(
      (record) => record.kind === 'driver.run' && record.phase === 'end',
    )!;
    expect(driverEnd.span_id).toBe(driverStart.span_id);
    expect(driverEnd.status).toBe('ok');
    expect(driverEnd.summary).toContain('succeeded');
  });

  it('replays the spans as a nested waterfall', async () => {
    const { store } = await runTraced({
      llm: scriptedLlm([
        toolCall('invoke_driver', 'call_driver', { instruction: 'Build the feature' }),
        { content: 'Task completed. [done]', tool_calls: undefined },
      ]),
    });

    const records = await store.load(RUN_ID);
    const replay = replayTrajectory(records, RUN_ID);

    const executionNode = replay.tree.find((node) => node.span.kind === 'agent.execution');
    expect(executionNode).toBeDefined();
    const turnNodes = executionNode!.children.filter((node) => node.span.kind === 'agent.turn');
    expect(turnNodes.length).toBeGreaterThan(0);
    const toolNodes = turnNodes[0]!.children.filter((node) => node.span.kind === 'agent.tool');
    expect(toolNodes).toHaveLength(1);
    expect(toolNodes[0]!.span.summary).toBe('invoke_driver → ok');
    const driverNode = toolNodes[0]!.children.find((node) => node.span.kind === 'driver.run');
    expect(driverNode).toBeDefined();
    expect(driverNode!.span.status).toBe('ok');
    expect(replay.rendered).toContain('› agent.tool');
  });

  it('maps a failed driver run to error statuses on driver.run and agent.execution', async () => {
    const { store, result } = await runTraced({
      llm: scriptedLlm([
        toolCall('invoke_driver', 'call_driver', { instruction: 'Build the feature' }),
        { content: 'Task completed. [done]', tool_calls: undefined },
      ]),
      driver: new StubDriver('failed'),
    });

    expect(result.status).toBe('failed');
    const records = await store.load(RUN_ID);
    const driverEnd = records.find(
      (record) => record.kind === 'driver.run' && record.phase === 'end',
    )!;
    expect(driverEnd.status).toBe('error');
    const executionEnd = records.find(
      (record) => record.kind === 'agent.execution' && record.phase === 'end',
    )!;
    expect(executionEnd.status).toBe('error');
  });

  it('closes the turn and execution spans as error when the LLM throws', async () => {
    const { store, result } = await runTraced({
      llm: {
        completeWithTools: async () => {
          throw new Error('llm unavailable');
        },
      },
    });

    expect(result.status).toBe('failed');
    const records = await store.load(RUN_ID);
    const turnEnd = records.find(
      (record) => record.kind === 'agent.turn' && record.phase === 'end',
    )!;
    expect(turnEnd.status).toBe('error');
    const executionEnd = records.find(
      (record) => record.kind === 'agent.execution' && record.phase === 'end',
    )!;
    expect(executionEnd.status).toBe('error');
  });
});
