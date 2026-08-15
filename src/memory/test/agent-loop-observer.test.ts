/**
 * AgentLoopObserver 测试：验证 Agent 自循环观测端口在 dispatchTask 期间
 * 按序触发 LLM 轮次与工具调用回调（成功 / 失败 / 未知工具 / LLM 异常），
 * 且不配置 observer 时行为不变（由既有测试覆盖）。
 */
import { describe, expect, it } from 'vitest';
import { AgentManager } from '../runtime/agent-manager';
import { InvokeDriverTool } from '../runtime/tools/invoke-driver-tool';
import type {
  AgentLlmTurnEndEvent,
  AgentLlmTurnErrorEvent,
  AgentLlmTurnStartEvent,
  AgentLoopObserver,
  AgentToolCallEndEvent,
  AgentToolCallStartEvent,
} from '../runtime/agent-loop-observer';
import type { Tool, ToolCallResult, ToolCallingClient } from '../runtime/tool';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import type { DriverReturn } from '../schemas';

type RecordedEvent =
  | ({ kind: 'llm.start' } & AgentLlmTurnStartEvent)
  | ({ kind: 'llm.end' } & AgentLlmTurnEndEvent)
  | ({ kind: 'llm.error' } & AgentLlmTurnErrorEvent)
  | ({ kind: 'tool.start' } & AgentToolCallStartEvent)
  | ({ kind: 'tool.end' } & AgentToolCallEndEvent);

function createMockToolClient(responses: ToolCallResult[]): ToolCallingClient {
  let callIndex = 0;
  return {
    completeWithTools: async () => {
      const response = responses[callIndex];
      if (response === undefined) {
        throw new Error(`Unexpected call #${String(callIndex)} - no more mock responses`);
      }
      callIndex += 1;
      return response;
    },
  };
}

function createRecordingObserver(events: RecordedEvent[]): AgentLoopObserver {
  return {
    onLlmTurnStart: (event) => events.push({ kind: 'llm.start', ...event }),
    onLlmTurnEnd: (event) => events.push({ kind: 'llm.end', ...event }),
    onLlmTurnError: (event) => events.push({ kind: 'llm.error', ...event }),
    onToolCallStart: (event) => events.push({ kind: 'tool.start', ...event }),
    onToolCallEnd: (event) => events.push({ kind: 'tool.end', ...event }),
  };
}

const ROLE_ID = 'role_observer';
const TASK = {
  spec: 'Observer task.',
  task_id: 'task_observer_001',
  call_id: 'call_observer_001',
  source_driver: 'tool-agent',
};

async function createManager(options: {
  llm: ToolCallingClient;
  tools?: Tool[];
  observer?: AgentLoopObserver;
}): Promise<AgentManager> {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  const manager = await AgentManager.create(repository, bufferRepository, {
    tools: {
      llm: options.llm,
      tools: options.tools ?? [],
      ...(options.observer ? { observer: options.observer } : {}),
    },
  });
  await manager.createAgent({ role_id: ROLE_ID, name: 'Observer Agent', tags: [] });
  return manager;
}

function driverReturn(summary: string): DriverReturn {
  return {
    summary,
    artifacts: [{ type: 'text', path: 'out.txt', summary }],
    decisions: [],
    blockers: [],
    referenced_experiences: [],
    assumptions: [],
  };
}

describe('AgentLoopObserver', () => {
  it('fires llm turn and tool call events in order around a driver invocation', async () => {
    const events: RecordedEvent[] = [];
    const manager = await createManager({
      llm: createMockToolClient([
        {
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'invoke_driver',
                arguments: '{"instruction": "Build the feature"}',
              },
            },
          ],
        },
        { content: 'Task completed. [done]', tool_calls: undefined },
      ]),
      tools: [
        new InvokeDriverTool(async (task) => driverReturn(`Executed: ${task.instruction}`)),
      ],
      observer: createRecordingObserver(events),
    });

    const result = await manager.dispatchTask(ROLE_ID, TASK);

    expect(result.status).toBe('completed');
    expect(events.map((event) => event.kind)).toEqual([
      'llm.start',
      'tool.start',
      'tool.end',
      'llm.end',
      'llm.start',
      'llm.end',
    ]);
    const turnStart = events[0] as AgentLlmTurnStartEvent;
    expect(turnStart.round).toBe(1);
    const toolStart = events[1] as AgentToolCallStartEvent;
    expect(toolStart.tool_name).toBe('invoke_driver');
    expect(toolStart.tool_call_id).toBe('call_1');
    expect(toolStart.arguments).toBe('{"instruction": "Build the feature"}');
    const toolEnd = events[2] as AgentToolCallEndEvent;
    expect(toolEnd.ok).toBe(true);
    const turnEnd = events[3] as AgentLlmTurnEndEvent;
    expect(turnEnd.toolCallCount).toBe(1);
    expect((events[4] as AgentLlmTurnStartEvent).round).toBe(2);
  });

  it('reports tool failures through onToolCallEnd with ok=false', async () => {
    const events: RecordedEvent[] = [];
    const manager = await createManager({
      llm: createMockToolClient([
        {
          content: null,
          tool_calls: [
            {
              id: 'call_fail',
              type: 'function',
              function: {
                name: 'invoke_driver',
                arguments: '{"instruction": "boom"}',
              },
            },
          ],
        },
      ]),
      tools: [
        new InvokeDriverTool(async () => {
          throw new Error('driver exploded');
        }),
      ],
      observer: createRecordingObserver(events),
    });

    await manager.dispatchTask(ROLE_ID, TASK);

    const toolEnd = events.find((event) => event.kind === 'tool.end') as
      | AgentToolCallEndEvent
      | undefined;
    expect(toolEnd).toBeDefined();
    expect(toolEnd!.ok).toBe(false);
    expect(toolEnd!.error).toBe('driver exploded');
  });

  it('reports unknown tools through onToolCallEnd with ok=false', async () => {
    const events: RecordedEvent[] = [];
    const manager = await createManager({
      llm: createMockToolClient([
        {
          content: null,
          tool_calls: [
            {
              id: 'call_ghost',
              type: 'function',
              function: { name: 'ghost_tool', arguments: '{}' },
            },
          ],
        },
        { content: 'Task completed. [done]', tool_calls: undefined },
      ]),
      observer: createRecordingObserver(events),
    });

    await manager.dispatchTask(ROLE_ID, TASK);

    const toolEnd = events.find((event) => event.kind === 'tool.end') as
      | AgentToolCallEndEvent
      | undefined;
    expect(toolEnd).toBeDefined();
    expect(toolEnd!.ok).toBe(false);
    expect(toolEnd!.error).toContain('unknown tool');
  });

  it('fires onLlmTurnError and fails the dispatch when the LLM call throws', async () => {
    const events: RecordedEvent[] = [];
    const manager = await createManager({
      llm: {
        completeWithTools: async () => {
          throw new Error('llm unavailable');
        },
      },
      observer: createRecordingObserver(events),
    });

    const result = await manager.dispatchTask(ROLE_ID, TASK);

    expect(result.status).toBe('failed');
    const error = events.find((event) => event.kind === 'llm.error') as
      | AgentLlmTurnErrorEvent
      | undefined;
    expect(error).toBeDefined();
    expect(error!.round).toBe(1);
    expect(events.some((event) => event.kind === 'llm.end')).toBe(false);
  });
});
