/**
 * CallJournalPort（进程内调用留档，B1）测试
 *
 * 验证：
 *   1. query_memory 成功 → 收到 1 条 memory_query 事件，身份字段完整
 *   2. query_memory 抛错 → 记 error 事件，执行循环照常完成
 *   3. 不注入 port → 行为与既有一致（不留档、不报错）
 *   4. 非 query_memory 工具不留档（范围过滤）
 *   5. 不同 role / task×run 的事件互不串
 *   6. AgentManager 两个注入点（loadAllAgents / createAgent）都透传 port
 *   7. processPendingBuffer 成功 → extract 事件；失败 → error 事件且异常原样上抛
 *   8. processPendingBuffer 不传 port → 无事件
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { Agent } from '../runtime/agent';
import type { AgentToolConfig } from '../runtime/agent';
import { AgentManager } from '../runtime/agent-manager';
import type { ToolCallResult, ToolCallingClient, Tool } from '../runtime/tool';
import type { AgentTaskRequest } from '../agent-types';
import type { CallJournalEvent, CallJournalPort } from '../ports/call-journal';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { ingestTaskBuffer, processPendingBuffer } from '../services/memory-cycle';
import type { ExperienceExtractor } from '../ports/experience-extractor';
import type { DriverReturn } from '../schemas';

// ──────────────────────────────────────────────
// 测试基础设施
// ──────────────────────────────────────────────

/** 收集事件的 stub port；可选注入抛错模拟实现违约 */
function createStubPort(options: { throwOnRecord?: boolean } = {}): CallJournalPort & {
  events: CallJournalEvent[];
} {
  const events: CallJournalEvent[] = [];
  return {
    events,
    record(event: CallJournalEvent): void {
      if (options.throwOnRecord) throw new Error('journal sink exploded');
      events.push(event);
    },
  };
}

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

function textResponse(content: string): ToolCallResult {
  return { content, tool_calls: undefined };
}

/** LLM 第一步调用 query_memory，第二步报告完成 */
function queryThenDone(callId: string, toolName = 'query_memory'): ToolCallResult[] {
  return [
    {
      content: null,
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: { name: toolName, arguments: '{"query": "how to test"}' },
        },
      ],
    },
    textResponse('Task completed.'),
  ];
}

/** 名为 query_memory 的桩工具（可控成败），返回形状与 QueryMemoryOutput 对齐 */
function createQueryTool(options: { fail?: boolean } = {}): Tool {
  return {
    name: 'query_memory',
    description: 'stub',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      if (options.fail) throw new Error('retrieval backend unavailable');
      return { skills: [{ id: 's1', description: 'd', content: 'c' }], experiences: [] };
    },
  };
}

async function createTestInfra(role_id: string) {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  await repository.initializeAgent({ role_id, name: role_id, tags: [] });
  await bufferRepository.ensureAgent(role_id);
  const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
  return { repository, bufferRepository, memory };
}

function createTestTask(overrides: Partial<AgentTaskRequest> = {}): AgentTaskRequest {
  return {
    spec: 'Journal test task.',
    task_id: 'task_journal_001',
    call_id: 'call_journal_001',
    source_driver: 'test-driver',
    ...overrides,
  };
}

function createToolConfig(
  mockLlm: ToolCallingClient,
  tools: Tool[],
  callJournal?: CallJournalPort,
): AgentToolConfig {
  return {
    llm: mockLlm,
    tools,
    maxToolCalls: 20,
    ...(callJournal ? { callJournal } : {}),
  };
}

const DRIVER_RETURN: DriverReturn = {
  artifacts: [],
  summary: '完成了一次检索测试',
  decisions: [],
  blockers: [],
  referenced_experiences: [],
  assumptions: [],
};

const NOOP_PROMOTE = async () => ({
  check: { eligible: false, auto_approved: false, reasons: [], blocking_rules: [] },
});

// ──────────────────────────────────────────────
// memory_query：Agent 循环 emit
// ──────────────────────────────────────────────

describe('CallJournalPort · memory_query', () => {
  it('query_memory 成功 → 1 条事件，身份字段完整', async () => {
    const { memory } = await createTestInfra('role_jq_ok');
    const port = createStubPort();
    const agent = new Agent(
      memory,
      createToolConfig(createMockToolClient(queryThenDone('call_tool_77')), [createQueryTool()], port),
    );

    await agent.executeTask(
      createTestTask({ run_id: 'run_jq_001', workspace_path: 'D:\\ws\\proj' }),
    );

    expect(port.events).toHaveLength(1);
    const event = port.events[0]!;
    expect(event).toMatchObject({
      call_id: 'call_tool_77',
      event: 'memory_query',
      task_id: 'task_journal_001',
      run_id: 'run_jq_001',
      role_id: 'role_jq_ok',
      workspace_path: 'D:\\ws\\proj',
      status: 'ok',
    });
    expect(event.summary).toBe('skills=1 experiences=0');
    expect(event.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(event.completed_at))).toBe(false);
  });

  it('query_memory 抛错 → 记 error 事件，循环照常完成、buffer 照写', async () => {
    const { memory, bufferRepository } = await createTestInfra('role_jq_err');
    const port = createStubPort();
    const agent = new Agent(
      memory,
      createToolConfig(
        createMockToolClient(queryThenDone('call_tool_err')),
        [createQueryTool({ fail: true })],
        port,
      ),
    );

    const result = await agent.executeTask(createTestTask({ run_id: 'run_jq_err' }));

    expect(result.agent_id).toBe('role_jq_err');
    expect(port.events).toHaveLength(1);
    expect(port.events[0]).toMatchObject({
      call_id: 'call_tool_err',
      status: 'error',
      run_id: 'run_jq_err',
    });
    expect(port.events[0]!.summary).toContain('retrieval backend unavailable');
    const meta = await bufferRepository.getBufferMeta('role_jq_err');
    expect(meta.pending_count).toBe(1);
  });

  it('不注入 port → 行为不变（无事件、无异常）', async () => {
    const { memory } = await createTestInfra('role_jq_noport');
    const agent = new Agent(
      memory,
      createToolConfig(createMockToolClient(queryThenDone('call_np')), [createQueryTool()]),
    );

    await expect(agent.executeTask(createTestTask())).resolves.toBeDefined();
  });

  it('port 实现抛错（违约）→ 不打断执行循环', async () => {
    const { memory } = await createTestInfra('role_jq_throw');
    const agent = new Agent(
      memory,
      createToolConfig(
        createMockToolClient(queryThenDone('call_throw')),
        [createQueryTool()],
        createStubPort({ throwOnRecord: true }),
      ),
    );

    await expect(agent.executeTask(createTestTask())).resolves.toBeDefined();
  });

  it('非 query_memory 工具 → 零事件', async () => {
    const { memory } = await createTestInfra('role_jq_other');
    const port = createStubPort();
    const otherTool: Tool = {
      name: 'other_tool',
      description: 'not memory',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    };
    const agent = new Agent(
      memory,
      createToolConfig(createMockToolClient(queryThenDone('call_other', 'other_tool')), [otherTool], port),
    );

    await agent.executeTask(createTestTask({ run_id: 'run_other' }));
    expect(port.events).toHaveLength(0);
  });

  it('不同 role / task×run 的事件逐条对应，不串', async () => {
    const port = createStubPort();
    const runOne = async (role: string, taskId: string, runId: string) => {
      const { memory } = await createTestInfra(role);
      const agent = new Agent(
        memory,
        createToolConfig(
          createMockToolClient(queryThenDone(`call_${role}`)),
          [createQueryTool()],
          port,
        ),
      );
      await agent.executeTask(createTestTask({ task_id: taskId, run_id: runId }));
    };

    await runOne('role_split_a', 'task_a', 'run_a');
    await runOne('role_split_b', 'task_b', 'run_b');

    expect(port.events).toHaveLength(2);
    expect(port.events[0]).toMatchObject({
      role_id: 'role_split_a', task_id: 'task_a', run_id: 'run_a',
    });
    expect(port.events[1]).toMatchObject({
      role_id: 'role_split_b', task_id: 'task_b', run_id: 'run_b',
    });
  });
});

// ──────────────────────────────────────────────
// memory_query：AgentManager 两个注入点
// ──────────────────────────────────────────────

describe('CallJournalPort · AgentManager 注入点', () => {
  it('create 前已注册的 Agent（loadAllAgents 注入点）→ dispatch 留档', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    await repository.initializeAgent({ role_id: 'role_preload', name: 'Pre', tags: [] });
    await bufferRepository.ensureAgent('role_preload');
    const port = createStubPort();

    const manager = await AgentManager.create(repository, bufferRepository, {
      tools: createToolConfig(
        createMockToolClient(queryThenDone('call_preload')),
        [createQueryTool()],
        port,
      ),
    });
    const result = await manager.dispatchTask(
      'role_preload',
      createTestTask({ run_id: 'run_preload' }),
    );

    expect(result.status).not.toBe('blocked');
    expect(port.events).toHaveLength(1);
    expect(port.events[0]).toMatchObject({
      event: 'memory_query', role_id: 'role_preload', run_id: 'run_preload',
    });
  });

  it('create 后新建的 Agent（instantiateAgent 注入点）→ dispatch 留档', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    const port = createStubPort();
    const manager = await AgentManager.create(repository, bufferRepository, {
      tools: createToolConfig(
        createMockToolClient(queryThenDone('call_fresh')),
        [createQueryTool()],
        port,
      ),
    });
    await manager.createAgent({ role_id: 'role_fresh', name: 'Fresh', tags: [] });
    const result = await manager.dispatchTask(
      'role_fresh',
      createTestTask({ run_id: 'run_fresh' }),
    );

    expect(result.status).not.toBe('blocked');
    expect(port.events).toHaveLength(1);
    expect(port.events[0]).toMatchObject({
      event: 'memory_query', role_id: 'role_fresh', run_id: 'run_fresh',
    });
  });
});

// ──────────────────────────────────────────────
// extract：processPendingBuffer emit
// ──────────────────────────────────────────────

describe('CallJournalPort · extract', () => {
  async function seedPendingBuffer(roleId: string, taskId: string): Promise<{
    repository: InMemoryRepository;
    bufferRepository: InMemoryBufferRepository;
    seq: number;
  }> {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    await repository.initializeAgent({ role_id: roleId, name: roleId, tags: [] });
    await bufferRepository.ensureAgent(roleId);
    const memory = createAgentMemoryScope(repository, bufferRepository, roleId);
    const { seq } = await ingestTaskBuffer(memory, {
      task: { spec: 'extract journal task', task_id: taskId },
      task_id: taskId,
      call_id: `call_${taskId}`,
      source_driver: 'test-driver',
      driver_return: DRIVER_RETURN,
    });
    return { repository, bufferRepository, seq };
  }

  const succeedingExtractor: ExperienceExtractor = {
    extract: async () => ({
      experiences: [],
      result: {
        experiences_created: 0,
        experiences_updated: 0,
        negative_experiences: 0,
        skills_promoted: 0,
      },
    }),
  };

  const failingExtractor: ExperienceExtractor = {
    extract: async () => {
      throw new Error('llm unavailable');
    },
  };

  it('提取成功 → 1 条 extract 事件，身份完整、call_id 含 role 与 seq', async () => {
    const { repository, bufferRepository, seq } = await seedPendingBuffer(
      'role_ext_ok',
      'task_ext_ok',
    );
    const memory = createAgentMemoryScope(repository, bufferRepository, 'role_ext_ok');
    const port = createStubPort();

    await processPendingBuffer(memory, seq, {
      task: {
        spec: 'extract journal task',
        task_id: 'task_ext_ok',
        run_id: 'run_ext_ok',
        workspace_path: '/ws/ext',
      },
      extractor: succeedingExtractor,
      promote: NOOP_PROMOTE as any,
      callJournal: port,
    });

    expect(port.events).toHaveLength(1);
    const event = port.events[0]!;
    expect(event).toMatchObject({
      event: 'extract',
      task_id: 'task_ext_ok',
      run_id: 'run_ext_ok',
      role_id: 'role_ext_ok',
      workspace_path: '/ws/ext',
      status: 'ok',
    });
    expect(event.call_id).toContain('extract:role_ext_ok:');
    expect(event.call_id).toContain(`:${String(seq)}:`);
    expect(event.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('提取失败 → 记 error 事件，异常原样上抛、buffer 未标 processed', async () => {
    const { repository, bufferRepository, seq } = await seedPendingBuffer(
      'role_ext_err',
      'task_ext_err',
    );
    const memory = createAgentMemoryScope(repository, bufferRepository, 'role_ext_err');
    const port = createStubPort();

    await expect(
      processPendingBuffer(memory, seq, {
        task: { spec: 'x', task_id: 'task_ext_err', run_id: 'run_ext_err' },
        extractor: failingExtractor,
        promote: NOOP_PROMOTE as any,
        callJournal: port,
      }),
    ).rejects.toThrow('llm unavailable');

    expect(port.events).toHaveLength(1);
    expect(port.events[0]).toMatchObject({
      event: 'extract', status: 'error', role_id: 'role_ext_err',
    });
    expect(port.events[0]!.summary).toContain('llm unavailable');
    expect(await memory.listPendingBufferSeqs()).toContain(seq);
  });

  it('不传 port → 无事件、正常完成', async () => {
    const { repository, bufferRepository, seq } = await seedPendingBuffer(
      'role_ext_noport',
      'task_ext_noport',
    );
    const memory = createAgentMemoryScope(repository, bufferRepository, 'role_ext_noport');

    const result = await processPendingBuffer(memory, seq, {
      task: { spec: 'x', task_id: 'task_ext_noport' },
      extractor: succeedingExtractor,
      promote: NOOP_PROMOTE as any,
    });

    expect(result.extraction.experiences).toHaveLength(0);
    expect(await memory.listPendingBufferSeqs()).not.toContain(seq);
  });

  it('失败重试的 call_id 与首次不同（幂等索引不会吞掉重试成功行）', async () => {
    const { repository, bufferRepository, seq } = await seedPendingBuffer(
      'role_ext_retry',
      'task_ext_retry',
    );
    const memory = createAgentMemoryScope(repository, bufferRepository, 'role_ext_retry');
    const port = createStubPort();
    const task = { spec: 'x', task_id: 'task_ext_retry', run_id: 'run_ext_retry' };

    await expect(
      processPendingBuffer(memory, seq, {
        task, extractor: failingExtractor, promote: NOOP_PROMOTE as any, callJournal: port,
      }),
    ).rejects.toThrow();
    await processPendingBuffer(memory, seq, {
      task, extractor: succeedingExtractor, promote: NOOP_PROMOTE as any, callJournal: port,
    });

    expect(port.events).toHaveLength(2);
    const [failed, retried] = port.events;
    expect(failed!.status).toBe('error');
    expect(retried!.status).toBe('ok');
    expect(retried!.call_id).not.toBe(failed!.call_id);
  });
});
