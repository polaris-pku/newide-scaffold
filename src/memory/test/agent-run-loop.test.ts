/**
 * Agent 自驱循环（executeTask）测试
 *
 * 验证：
 *   1. assignTask 正确初始化状态
 *   2. executeTask 单步完成（LLM 直接报告完成）
 *   3. executeTask 多步交互后完成
 *   4. executeTask 工具调用后完成
 *   5. executeTask 未知工具不中断
 *   6. executeTask 最大轮次保护
 *   7. executeTask 写入 buffer
 *   8. runOnce 向后兼容
 *   9. hasPendingTask 状态报告
 *   10. AgentManager.dispatchTask 异步派单
 *   11. executeTask 失败后释放 currentTask，避免后续 B_BLOCKED
 *   12. agent.llm_round / agent.tool.<name> span 与 LLM 调用、工具执行一一对应
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { Agent } from '../runtime/agent';
import type { AgentToolConfig } from '../runtime/agent';
import type { ToolCallResult, ToolCallingClient } from '../runtime/tool';
import type { Tool } from '../runtime/tool';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import type { AgentTaskRequest } from '../agent-types';
import type { DriverReturn } from '../schemas';
import {
  RunLatencyRecorder,
  runWithRunLatencyRecorder,
  type RunLatencySpan,
  type RunLatencyTraceSink,
} from '../../telemetry';

// ──────────────────────────────────────────────
// Mock ToolCallingClient
// ──────────────────────────────────────────────

function createMockToolClient(responses: ToolCallResult[]): ToolCallingClient {
  let callIndex = 0;
  return {
    completeWithTools: async () => {
      const response = responses[callIndex];
      if (response === undefined) {
        throw new Error(`Unexpected call #${callIndex} - no more mock responses`);
      }
      callIndex++;
      return response;
    },
  };
}

/** 简易文本回复的 mock */
function textResponse(content: string): ToolCallResult {
  return { content, tool_calls: undefined };
}

// ──────────────────────────────────────────────
// 共享测试基础设施
// ──────────────────────────────────────────────

async function createTestInfra(role_id = 'role_loop_test') {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  await repository.initializeAgent({ role_id, name: 'Test Agent', tags: [] });
  await bufferRepository.ensureAgent(role_id);
  const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
  return { repository, bufferRepository, memory, role_id };
}

function createTestTask(overrides: Partial<AgentTaskRequest> = {}): AgentTaskRequest {
  return {
    spec: 'Test task specification.',
    task_id: 'task_loop_001',
    call_id: 'call_loop_001',
    source_driver: 'test-driver',
    ...overrides,
  };
}

function createToolConfig(mockLlm: ToolCallingClient, tools?: Tool[]): AgentToolConfig {
  return {
    llm: mockLlm,
    tools: tools ?? [],
    maxToolCalls: 20,
  };
}

// ──────────────────────────────────────────────
// Agent 持久循环
// ──────────────────────────────────────────────

describe('Agent self-loop (executeTask)', () => {
  describe('assignTask', () => {
    it('为 Tool-calling Agent 正确初始化状态', async () => {
      const { memory } = await createTestInfra('role_assign');
      const agent = new Agent(memory, createToolConfig(createMockToolClient([])));

      expect(agent.hasPendingTask()).toBe(false);

      const task = createTestTask();
      (agent as any).assignTask(task);

      expect(agent.hasPendingTask()).toBe(true);
      expect(agent.getState()).toBe('running');
    });

    it('已有任务时 assignTask 抛出错误', async () => {
      const { memory } = await createTestInfra('role_assign_conflict');
      const agent = new Agent(memory, createToolConfig(createMockToolClient([])));

      (agent as any).assignTask(createTestTask());
      await expect(
        (agent as any).assignTask(createTestTask({ task_id: 'task_002' })),
      ).rejects.toThrow('already has a running task');
    });

    it('clearLoopState 后清除所有持久状态', async () => {
      const { memory } = await createTestInfra('role_stop_clear');
      const agent = new Agent(memory, createToolConfig(createMockToolClient([])));

      (agent as any).assignTask(createTestTask());
      expect(agent.hasPendingTask()).toBe(true);

      (agent as any).clearLoopState();
      (agent as any).state = 'stopped';
      expect(agent.hasPendingTask()).toBe(false);
      expect(agent.getState()).toBe('stopped');
    });
  });

  describe('executeTask 单步/多步执行', () => {
    it('LLM 直接报告完成 → 返回完整结果', async () => {
      const { memory } = await createTestInfra('role_one_step');
      const mockLlm = createMockToolClient([textResponse('Task completed. All done.')]);
      const agent = new Agent(memory, createToolConfig(mockLlm));

      const result = await agent.executeTask(createTestTask());
      expect(result.agent_id).toBe('role_one_step');
      expect(result.buffer_snapshot.task_id).toBe('task_loop_001');
      expect(agent.getState()).toBe('sleeping');
      expect(agent.hasPendingTask()).toBe(false);
    });

    it('多步交互后完成', async () => {
      const { memory } = await createTestInfra('role_multi_step');
      const mockLlm = createMockToolClient([
        textResponse('Step 1: analyzing...'),
        textResponse('Step 2: processing...'),
        textResponse('Step 3: almost done...'),
        textResponse('Task completed.'),
      ]);
      const agent = new Agent(memory, createToolConfig(mockLlm));

      const result = await agent.executeTask(createTestTask());
      expect(result.agent_id).toBe('role_multi_step');
      expect(agent.getState()).toBe('sleeping');
    });

    it('工具调用后完成', async () => {
      const { memory } = await createTestInfra('role_tool_step');
      let toolExecuted = false;
      const mockTool: Tool = {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          toolExecuted = true;
          return { result: 'tool output' };
        },
      };
      const mockLlm = createMockToolClient([
        {
          content: null,
          tool_calls: [
            {
              id: 'call_tool',
              type: 'function',
              function: { name: 'test_tool', arguments: '{}' },
            },
          ],
        },
        textResponse('Task completed. [done]'),
      ]);
      const agent = new Agent(memory, createToolConfig(mockLlm, [mockTool]));

      await agent.executeTask(createTestTask());
      expect(toolExecuted).toBe(true);
      expect(agent.getState()).toBe('sleeping');
    });

    it('未知工具不中断循环', async () => {
      const { memory } = await createTestInfra('role_unknown_tool');
      const mockLlm = createMockToolClient([
        {
          content: null,
          tool_calls: [
            {
              id: 'call_unknown',
              type: 'function',
              function: { name: 'nonexistent', arguments: '{}' },
            },
          ],
        },
        textResponse('Task completed.'),
      ]);
      const agent = new Agent(memory, createToolConfig(mockLlm));

      const result = await agent.executeTask(createTestTask());
      expect(result.agent_id).toBe('role_unknown_tool');
      expect(agent.getState()).toBe('sleeping');
    });

    it('完成时写入 buffer', async () => {
      const { memory, bufferRepository } = await createTestInfra('role_buffer');
      const mockLlm = createMockToolClient([textResponse('Task completed. [done]')]);
      const agent = new Agent(memory, createToolConfig(mockLlm));

      // 预先验证 buffer 为空
      const metaBefore = await bufferRepository.getBufferMeta('role_buffer');
      expect(metaBefore.total_processed).toBe(0);

      await agent.executeTask(createTestTask());

      // buffer 应有记录（pending 状态，提取已解耦不被同步标记为 processed）
      const metaAfter = await bufferRepository.getBufferMeta('role_buffer');
      expect(metaAfter.pending_count).toBe(1);
      expect(agent.getState()).toBe('sleeping');
    });
  });

  describe('executeTask 失败后释放任务', () => {
    it('LLM 抛错后释放 currentTask，同一 Agent 可再接任务', async () => {
      const { memory } = await createTestInfra('role_throw_release');
      const failing = new Agent(memory, createToolConfig(createMockToolClient([])));

      await expect(failing.executeTask(createTestTask())).rejects.toThrow('Unexpected call');
      expect(failing.getState()).toBe('sleeping');
      expect(failing.hasPendingTask()).toBe(false);

      const retryLlm = createMockToolClient([textResponse('Task completed. [done]')]);
      const retry = new Agent(memory, createToolConfig(retryLlm));
      // Same memory scope is fine; the regression is hasPendingTask staying true
      // on the agent that threw.
      await expect(
        retry.executeTask(createTestTask({ task_id: 'task_retry' })),
      ).resolves.toMatchObject({ agent_id: 'role_throw_release' });
      expect(retry.hasPendingTask()).toBe(false);
    });

    it('assignTask 冲突时不清除已有任务', async () => {
      const { memory } = await createTestInfra('role_assign_keep');
      const agent = new Agent(memory, createToolConfig(createMockToolClient([])));
      const held = createTestTask({ task_id: 'task_held' });
      await (agent as any).assignTask(held);

      await expect(
        agent.executeTask(createTestTask({ task_id: 'task_other' })),
      ).rejects.toThrow('already has a running task');
      expect(agent.hasPendingTask()).toBe(true);
      expect((agent as any).currentTask.task_id).toBe('task_held');
    });
  });

  describe('executeTask 最大轮次保护', () => {
    it('达到 maxToolCalls 时强制完成', async () => {
      const { memory } = await createTestInfra('role_maxrounds');
      // 一直返回文本，不报告完成
      const mockLlm = createMockToolClient(
        Array.from({ length: 5 }, () => textResponse('Still thinking...')),
      );
      const config: AgentToolConfig = {
        llm: mockLlm,
        tools: [],
        maxToolCalls: 3,
      };
      const agent = new Agent(memory, config);

      const result = await agent.executeTask(createTestTask());
      expect(result.agent_id).toBe('role_maxrounds');
      expect(agent.getState()).toBe('sleeping');
      expect(agent.hasPendingTask()).toBe(false);
    });
  });
});

// ──────────────────────────────────────────────
// 轮次与工具调用 span
// ──────────────────────────────────────────────

class CollectingLatencySink implements RunLatencyTraceSink {
  readonly spans: RunLatencySpan[] = [];

  append(span: RunLatencySpan): void {
    this.spans.push(span);
  }
}

function createLatencyRecorder(sink: RunLatencyTraceSink): RunLatencyRecorder {
  return new RunLatencyRecorder({
    run_id: 'run_agent_loop',
    task_id: 'task_loop_001',
    sink,
  });
}

/** 包一层计数器，用来对照 span 条数与被调用的 LLM 次数。 */
function countingClient(inner: ToolCallingClient): {
  client: ToolCallingClient;
  calls: () => number;
} {
  let calls = 0;
  return {
    client: {
      completeWithTools: async (input) => {
        calls += 1;
        return inner.completeWithTools(input);
      },
    },
    calls: () => calls,
  };
}

function createNamedTool(
  name: string,
  onExecute: () => void,
  output: unknown = { result: `${name} output` },
): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      onExecute();
      return output;
    },
  };
}

/**
 * `invoke_driver` 的返回值会被 Agent 当作 DriverReturn 写进 buffer，形状必须合法，
 * 否则 finalizeLoop 里的 schema 校验会失败——那是测试夹具的问题，不是被测代码的。
 */
const DRIVER_RETURN_STUB: DriverReturn = {
  artifacts: [],
  summary: 'stub driver return',
  decisions: [],
  blockers: [],
  referenced_experiences: [],
  assumptions: [],
};

function toolCallRound(...names: string[]): ToolCallResult {
  return {
    content: null,
    tool_calls: names.map((name, index) => ({
      id: `call_${name}_${index}`,
      type: 'function',
      function: { name, arguments: '{}' },
    })),
  };
}

describe('Agent 轮次与工具调用 span', () => {
  it('agent.llm_round 条数与 LLM 调用次数一致，且轮号从 0 递增', async () => {
    const { memory } = await createTestInfra('role_round_spans');
    const counted = countingClient(
      createMockToolClient([textResponse('Step 1: analyzing...'), textResponse('Task completed.')]),
    );
    const agent = new Agent(memory, createToolConfig(counted.client));
    const sink = new CollectingLatencySink();

    await runWithRunLatencyRecorder(createLatencyRecorder(sink), () =>
      agent.executeTask(createTestTask()),
    );

    const rounds = sink.spans.filter((span) => span.name === 'agent.llm_round');
    expect(counted.calls()).toBe(2);
    expect(rounds.length).toBe(counted.calls());
    expect(rounds.map((span) => span.round)).toEqual([0, 1]);
    expect(rounds.every((span) => span.layer === 'agent' && span.ok)).toBe(true);
    // 没有 role_id 就没法把 council 各席位的耗时分开，也对不上账本里按角色的 token。
    expect(rounds.every((span) => span.role_id === 'role_round_spans')).toBe(true);
  });

  it('达到 maxToolCalls 的那一轮不产生 span——没有 LLM 调用就没有轮次', async () => {
    const { memory } = await createTestInfra('role_round_cap_spans');
    const counted = countingClient(
      createMockToolClient(Array.from({ length: 5 }, () => textResponse('Still thinking...'))),
    );
    const config: AgentToolConfig = { llm: counted.client, tools: [], maxToolCalls: 3 };
    const agent = new Agent(memory, config);
    const sink = new CollectingLatencySink();

    await runWithRunLatencyRecorder(createLatencyRecorder(sink), () =>
      agent.executeTask(createTestTask()),
    );

    // 循环被调用 4 次（第 4 次撞上限直接退出），但只有前 3 次真的调了 LLM。
    expect(counted.calls()).toBe(3);
    expect(sink.spans.filter((span) => span.name === 'agent.llm_round').length).toBe(3);
  });

  it('agent.tool.<name> 覆盖每个被调用的工具，并与同轮 LLM span 共用轮号', async () => {
    const { memory } = await createTestInfra('role_tool_spans');
    const executed: string[] = [];
    const agent = new Agent(
      memory,
      createToolConfig(
        createMockToolClient([
          toolCallRound('query_memory', 'invoke_driver', 'mailbox_send'),
          textResponse('Task completed.'),
        ]),
        [
          createNamedTool('query_memory', () => executed.push('query_memory')),
          createNamedTool('invoke_driver', () => executed.push('invoke_driver'), DRIVER_RETURN_STUB),
          createNamedTool('mailbox_send', () => executed.push('mailbox_send')),
        ],
      ),
    );
    const sink = new CollectingLatencySink();

    await runWithRunLatencyRecorder(createLatencyRecorder(sink), () =>
      agent.executeTask(createTestTask()),
    );

    expect(executed).toEqual(['query_memory', 'invoke_driver', 'mailbox_send']);
    const toolSpans = sink.spans.filter((span) => span.name.startsWith('agent.tool.'));
    expect(toolSpans.map((span) => span.name)).toEqual([
      'agent.tool.query_memory',
      'agent.tool.invoke_driver',
      'agent.tool.mailbox_send',
    ]);
    expect(toolSpans.every((span) => span.layer === 'agent' && span.round === 0)).toBe(true);
    expect(toolSpans.every((span) => span.role_id === 'role_tool_spans')).toBe(true);
  });

  it('工具抛错时照样记 span，并标出 ok=false 与错误信息', async () => {
    const { memory } = await createTestInfra('role_tool_span_error');
    const failingTool: Tool = {
      name: 'boom',
      description: 'always fails',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('tool exploded');
      },
    };
    const agent = new Agent(
      memory,
      createToolConfig(
        createMockToolClient([toolCallRound('boom'), textResponse('Task completed.')]),
        [failingTool],
      ),
    );
    const sink = new CollectingLatencySink();

    await runWithRunLatencyRecorder(createLatencyRecorder(sink), () =>
      agent.executeTask(createTestTask()),
    );

    const [span] = sink.spans.filter((entry) => entry.name === 'agent.tool.boom');
    expect(span?.ok).toBe(false);
    expect(span?.error).toContain('tool exploded');
  });

  it('没有 recorder 时循环照常跑完，不产生任何 span 副作用', async () => {
    const { memory } = await createTestInfra('role_no_recorder');
    const agent = new Agent(
      memory,
      createToolConfig(
        createMockToolClient([toolCallRound('query_memory'), textResponse('Task completed.')]),
        [createNamedTool('query_memory', () => undefined)],
      ),
    );

    const result = await agent.executeTask(createTestTask());
    expect(result.agent_id).toBe('role_no_recorder');
    expect(agent.getState()).toBe('sleeping');
  });
});

// ──────────────────────────────────────────────
// runOnce 向后兼容
// ──────────────────────────────────────────────

describe('runOnce backward compatibility', () => {
  it('Tool-calling 模式 runOnce 仍能同步执行', async () => {
    const { memory } = await createTestInfra('role_compat_tc');
    const mockLlm = createMockToolClient([textResponse('Task completed. [done]')]);
    const agent = new Agent(memory, createToolConfig(mockLlm));

    const result = await agent.runOnce(createTestTask());
    expect(result.agent_id).toBe('role_compat_tc');
    expect(result.buffer_snapshot.task_id).toBe('task_loop_001');
  });

  it('Tool-calling 模式 runOnce 多轮交互正常', async () => {
    const { memory } = await createTestInfra('role_compat_multi');
    const mockLlm = createMockToolClient([
      textResponse('Let me think...'),
      textResponse('Working on it...'),
      textResponse('Task finished.'),
    ]);
    const agent = new Agent(memory, createToolConfig(mockLlm));

    const result = await agent.runOnce(createTestTask());
    expect(result.agent_id).toBe('role_compat_multi');
  });
});

// ──────────────────────────────────────────────
// AgentManager dispatchTask
// ──────────────────────────────────────────────

describe('AgentManager dispatchTask', () => {
  it('dispatchTask 同步执行完成（内部循环逐 tick 直至完成）', async () => {
    const { AgentManager } = await import('../runtime/agent-manager');
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();

    const mockLlm = createMockToolClient([
      textResponse('Processing...'),
      textResponse('Task complete. [done]'),
    ]);

    const manager = await AgentManager.create(repository, bufferRepository, {
      tools: { llm: mockLlm, tools: [] },
    });

    await manager.createAgent({ role_id: 'role_async_task', name: 'Async Agent', tags: [] });

    // dispatchTask 同步执行完成（内部循环逐 tick 直至完成）
    const result = await manager.dispatchTask(
      'role_async_task',
      createTestTask({ task_id: 'task_async' }),
    );
    expect(result.status).toBe('no_driver_invocation');
    expect(result.role_id).toBe('role_async_task');
    expect(result.cycle).toBeDefined();
    expect(result.cycle.buffer_snapshot.task_id).toBe('task_async');

    // agent 已回到 sleeping
    const agent = manager.getAgent('role_async_task')!;
    expect(agent.getState()).toBe('sleeping');

    // 验证 buffer 已写入（pending 状态，提取由离线 Processor 处理）
    const meta = await bufferRepository.getBufferMeta('role_async_task');
    expect(meta.pending_count).toBe(1);
  });

  it('executeTask 失败后同一 Agent 可再次 dispatch，不会 blocked', async () => {
    const { AgentManager } = await import('../runtime/agent-manager');
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    let calls = 0;
    const mockLlm: ToolCallingClient = {
      completeWithTools: async () => {
        calls += 1;
        if (calls === 1) throw new Error('driver exploded');
        return textResponse('Task completed. [done]');
      },
    };
    const manager = await AgentManager.create(repository, bufferRepository, {
      tools: { llm: mockLlm, tools: [] },
    });
    await manager.createAgent({ role_id: 'role_busy_leak', name: 'Busy', tags: [] });

    const first = await manager.dispatchTask('role_busy_leak', createTestTask({ task_id: 'task_fail' }));
    expect(first.status).toBe('failed');
    expect(manager.getAgent('role_busy_leak')!.hasPendingTask()).toBe(false);

    const second = await manager.dispatchTask(
      'role_busy_leak',
      createTestTask({ task_id: 'task_retry' }),
    );
    expect(second.status).not.toBe('blocked');
    expect(second.cycle.buffer_snapshot.driver_return.summary).not.toContain(
      'Agent is busy with another task.',
    );
    expect(manager.getAgent('role_busy_leak')!.hasPendingTask()).toBe(false);
  });
});
