/**
 * Agent 上下文成对落盘集成测试（工作包 A）
 *
 * 验证「一次 tool-calling 任务的 DriverReturn 与清理后的 AgentContextSnapshot
 * 落进同一个 Buffer 序号」这条契约的端到端形态：
 *
 *   1. 真实写盘 → pending/ 下 report_<seq>.json 与 context_<seq>.json 同时存在
 *   2. getPendingBuffer 读回的 agentContext 能被定位到同一个 seq
 *   3. 清理器缺席/返回 null/抛错 → 任务照样完成，但降级原因必须留痕
 *   4. 经验提取器的输入里同时有 DriverReturn 和上下文的 thinking/planning
 *
 * 这里的存储用 FileBufferRepository（不是内存替身）：成对落盘本身就是文件行为，
 * 内存替身跑过不能说明盘上对得上。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../runtime/agent';
import type { AgentToolConfig } from '../runtime/agent';
import type { ToolCallResult, ToolCallingClient } from '../runtime/tool';
import { InvokeDriverTool } from '../runtime/tools/invoke-driver-tool';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { FileBufferRepository } from '../adapters/file-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { LlmExperienceExtractor } from '../adapters/llm-experience-extractor';
import type { AgentContextCleaner, AgentContextCleanInput } from '../ports/agent-context-cleaner';
import type { LlmClient, LlmMessage } from '../ports/llm-client';
import { nowTimestamp } from '../../core';
import type { AgentContextSnapshot, DriverReturn, ExperienceRecord, SkillRecord } from '../schemas';

const THINKING_TRACE = 'Thought: reuse the existing serializer instead of adding a second code path.';
const PLANNING_TRACE = 'Step 1: read the serializer. Step 2: extend it. Step 3: verify.';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ──────────────────────────────────────────────
// Test doubles
// ──────────────────────────────────────────────

function mockToolClient(responses: ToolCallResult[]): ToolCallingClient {
  let callIndex = 0;
  return {
    completeWithTools: async () => {
      const response = responses[callIndex];
      if (response === undefined) {
        throw new Error(`Unexpected tool call #${String(callIndex)} — no more scripted responses`);
      }
      callIndex++;
      return response;
    },
  };
}

function driverCallResponse(id: string): ToolCallResult {
  return {
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name: 'invoke_driver', arguments: '{"instruction": "Implement the change"}' },
      },
    ],
  };
}

const DONE_RESPONSE: ToolCallResult = { content: 'Task completed. [done]', tool_calls: undefined };

/** 反复「先调 driver、再报完成」的客户端：给一个用例里跑两次任务的场景用。 */
function repeatingToolClient(): ToolCallingClient {
  let turn = 0;
  return {
    completeWithTools: async () => {
      turn++;
      return turn % 2 === 1 ? driverCallResponse(`call_${String(turn)}`) : DONE_RESPONSE;
    },
  };
}

function sampleDriverReturn(summary: string): DriverReturn {
  return {
    artifacts: [{ type: 'file', path: 'src/result.ts', summary: 'created' }],
    summary,
    decisions: [],
    blockers: [],
    referenced_experiences: [],
    assumptions: [],
  };
}

/** 记录调用参数的清理器替身：返回快照或按剧本失败。 */
class RecordingCleaner implements AgentContextCleaner {
  readonly inputs: AgentContextCleanInput[] = [];

  constructor(private readonly behavior: 'snapshot' | 'null' | 'throw' = 'snapshot') {}

  async clean(input: AgentContextCleanInput): Promise<AgentContextSnapshot | null> {
    this.inputs.push(input);
    if (this.behavior === 'null') return null;
    if (this.behavior === 'throw') throw new Error('cleaner exploded');
    return {
      snapshot_id: randomUUID(),
      source_task_id: input.source_task_id,
      agent_id: input.agent_id,
      thinking_trace: THINKING_TRACE,
      planning_trace: PLANNING_TRACE,
      driver_calls: input.driver_returns.map((call) => ({
        call_id: call.call_id,
        driver_id: call.driver_id,
        driver_return_ref: 'placeholder',
      })),
      cleaned_at: nowTimestamp(),
      original_token_count: 400,
      cleaned_token_count: 100,
      compression_ratio: 0.25,
    };
  }
}

function driverTool(returned: DriverReturn) {
  return new InvokeDriverTool(async () => returned);
}

interface Harness {
  role_id: string;
  agentStateRoot: string;
  bufferRepository: FileBufferRepository;
  pendingReportPath: (seq: number) => string;
  pendingContextPath: (seq: number) => string;
}

/**
 * 一块盘（agentStateRoot）+ 一个已初始化的 Agent，外加一个据此造 Agent 实例的小工厂。
 *
 * 每个用例都开自己的 stateRoot：成对落盘是文件行为，共享目录会让上一个用例的
 * seq 影响下一个用例的断言。
 */
async function createInfra(agentStateRoot: string, role_id: string): Promise<{
  harness: Harness;
  makeAgent: (toolConfig: AgentToolConfig) => Promise<Agent>;
}> {
  const repository = new InMemoryRepository();
  const bufferRepository = new FileBufferRepository({ agentStateRoot });
  await repository.initializeAgent({ role_id, name: role_id, tags: [] });
  await bufferRepository.ensureAgent(role_id);
  const harness: Harness = {
    role_id,
    agentStateRoot,
    bufferRepository,
    pendingReportPath: (seq) => join(agentStateRoot, role_id, 'buffer', 'pending', `report_${seq}.json`),
    pendingContextPath: (seq) => join(agentStateRoot, role_id, 'buffer', 'pending', `context_${seq}.json`),
  };
  return {
    harness,
    makeAgent: async (toolConfig) =>
      new Agent(createAgentMemoryScope(repository, bufferRepository, role_id), toolConfig),
  };
}

async function freshStateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'newide-context-pairing-'));
  tempDirs.push(root);
  return root;
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe('AgentContextSnapshot pairing', () => {
  it('一次真实 tool-calling 任务后 report_<seq>.json 与 context_<seq>.json 同时存在', async () => {
    const stateRoot = await freshStateRoot();
    const { makeAgent } = await createInfra(stateRoot, 'role_pairing');
    const cleaner = new RecordingCleaner('snapshot');
    const returned = sampleDriverReturn('Implemented the change.');
    const agent = await makeAgent({
      llm: mockToolClient([driverCallResponse('call_1'), DONE_RESPONSE]),
      tools: [driverTool(returned)],
      contextCleaner: cleaner,
    });

    const cycle = await agent.executeTask({
      spec: 'Implement the change in src/result.ts.',
      task_id: 'task_pairing_001',
      call_id: 'call_pairing_001',
      source_driver: 'acp-external',
    });

    expect(cycle.buffer_seq).toBe(1);
    // 本用例不传 retrieval，只关心上下文那条线：不该冒出清理相关的降级
    expect((cycle.warnings ?? []).filter((w) => w.startsWith('context_cleaning'))).toEqual([]);

    // 盘上两份文件都在，且 report 指向了同号的 context
    const pendingDir = join(stateRoot, 'role_pairing', 'buffer', 'pending');
    expect(existsSync(join(pendingDir, 'report_1.json'))).toBe(true);
    expect(existsSync(join(pendingDir, 'context_1.json'))).toBe(true);

    const report = JSON.parse(await readFile(join(pendingDir, 'report_1.json'), 'utf8')) as {
      context_snapshot_ref?: string;
      source_task_id: string;
      driver_return: DriverReturn;
    };
    expect(report.context_snapshot_ref).toBe('1');
    expect(report.driver_return.summary).toBe('Implemented the change.');

    const pending = await new FileBufferRepository({ agentStateRoot: stateRoot }).getPendingBuffer(
      'role_pairing',
      1,
    );
    // 提取器的两个输入源都能从同一个 seq 取到，且指向同一次任务
    expect(pending?.agentContext?.source_task_id).toBe(report.source_task_id);
    expect(pending?.agentContext?.agent_id).toBe('role_pairing');

    // 清理器收到的正是本次任务的原文与本次 driver 调用
    expect(cleaner.inputs).toHaveLength(1);
    expect(cleaner.inputs[0]!.source_task_id).toBe('task_pairing_001');
    expect(cleaner.inputs[0]!.raw_context).toContain('Implement the change in src/result.ts.');
    expect(cleaner.inputs[0]!.raw_context).toContain('tool_call invoke_driver');
    expect(cleaner.inputs[0]!.driver_returns).toHaveLength(1);
  });

  it('context 快照内的 driver_calls 如实列出本次每一次 invoke_driver', async () => {
    const stateRoot = await freshStateRoot();
    const { harness, makeAgent } = await createInfra(stateRoot, 'role_multi_call');
    const cleaner = new RecordingCleaner('snapshot');
    const agent = await makeAgent({
      llm: mockToolClient([
        driverCallResponse('call_a'),
        driverCallResponse('call_b'),
        DONE_RESPONSE,
      ]),
      tools: [driverTool(sampleDriverReturn('Did both.') )],
      contextCleaner: cleaner,
    });

    await agent.executeTask({
      spec: 'Do two things.',
      task_id: 'task_multi_call',
      call_id: 'call_multi',
      source_driver: 'acp-external',
    });

    // 落进 Buffer 的 driver_return 只有最后一次，但快照要记全
    expect(cleaner.inputs[0]!.driver_returns.map((call) => call.call_id)).toEqual([
      'call_a',
      'call_b',
    ]);
    expect(cleaner.inputs[0]!.driver_returns.map((call) => call.driver_id)).toEqual([
      'acp-external',
      'acp-external',
    ]);

    const pending = await harness.bufferRepository.getPendingBuffer('role_multi_call', 1);
    expect(pending?.agentContext?.driver_calls).toHaveLength(2);
    // 两条调用都指向同号 report：Buffer 里只有一份最终报告，引用不能编出第二份
    expect(pending?.agentContext?.driver_calls.map((call) => call.driver_return_ref)).toEqual([
      'report_1.json',
      'report_1.json',
    ]);
  });

  it('清理器返回 null → 任务完成、无 context 文件，warning 记明降级', async () => {
    const stateRoot = await freshStateRoot();
    const { harness, makeAgent } = await createInfra(stateRoot, 'role_cleaner_null');
    const agent = await makeAgent({
      llm: mockToolClient([driverCallResponse('call_1'), DONE_RESPONSE]),
      tools: [driverTool(sampleDriverReturn('Done.'))],
      contextCleaner: new RecordingCleaner('null'),
    });

    const cycle = await agent.executeTask({
      spec: 'A task whose cleaning fails.',
      task_id: 'task_cleaner_null',
      call_id: 'call_null',
      source_driver: 'acp-external',
    });

    expect(cycle.buffer_seq).toBe(1);
    expect(String(cycle.warnings?.join(' '))).toContain('context_cleaning_failed');
    // 关键的「不静默」：没有 context 文件，且 report 不带 context_snapshot_ref，
    // 于是下游能分辨这是降级，而不是拿到一个看起来完整、其实是空的快照。
    expect(existsSync(harness.pendingContextPath(1))).toBe(false);
    const pending = await harness.bufferRepository.getPendingBuffer('role_cleaner_null', 1);
    expect(pending?.agentContext).toBeUndefined();
    expect(pending?.snapshot.context_snapshot_ref).toBeUndefined();
  });

  it('清理器抛错 → 任务完成、降级留痕（清理失败不得拦住 Driver 任务）', async () => {
    const stateRoot = await freshStateRoot();
    const { makeAgent } = await createInfra(stateRoot, 'role_cleaner_throw');
    const agent = await makeAgent({
      llm: mockToolClient([driverCallResponse('call_1'), DONE_RESPONSE]),
      tools: [driverTool(sampleDriverReturn('Done anyway.'))],
      contextCleaner: new RecordingCleaner('throw'),
    });

    const cycle = await agent.executeTask({
      spec: 'A task whose cleaner throws.',
      task_id: 'task_cleaner_throw',
      call_id: 'call_throw',
      source_driver: 'acp-external',
    });

    expect(cycle.buffer_snapshot.driver_return.summary).toBe('Done anyway.');
    expect(String(cycle.warnings?.join(' '))).toContain('cleaner exploded');
  });

  it('未注入清理器 → 只落 DriverReturn，并说明为什么没有上下文', async () => {
    const stateRoot = await freshStateRoot();
    const { harness, makeAgent } = await createInfra(stateRoot, 'role_no_cleaner');
    const agent = await makeAgent({
      llm: mockToolClient([driverCallResponse('call_1'), DONE_RESPONSE]),
      tools: [driverTool(sampleDriverReturn('Done without context.'))],
    });

    const cycle = await agent.executeTask({
      spec: 'A task with no cleaner configured.',
      task_id: 'task_no_cleaner',
      call_id: 'call_no_cleaner',
      source_driver: 'acp-external',
    });

    expect(String(cycle.warnings?.join(' '))).toContain('no AgentContextCleaner is configured');
    expect(existsSync(harness.pendingContextPath(1))).toBe(false);
    expect(existsSync(harness.pendingReportPath(1))).toBe(true);
  });

  it('本次真实检索结果如实回填 MemoryCycleResult；缺省时空数组并记明原因', async () => {
    const stateRoot = await freshStateRoot();
    const { makeAgent } = await createInfra(stateRoot, 'role_retrieval');
    const experience = {
      id: randomUUID(),
      description: 'Reuse the serializer',
      content: 'Reuse the serializer instead of adding a new one.',
    } as unknown as ExperienceRecord;
    const skill = { id: randomUUID(), description: 'Refactor safely' } as unknown as SkillRecord;

    const agent = await makeAgent({
      llm: repeatingToolClient(),
      tools: [driverTool(sampleDriverReturn('Done.'))],
    });

    const withRetrieval = await agent.executeTask({
      spec: 'Task with retrieval.',
      task_id: 'task_retrieval_present',
      call_id: 'call_retrieval',
      source_driver: 'acp-external',
      retrieval: { skills: [skill], experiences: [experience] },
    });
    expect(withRetrieval.retrieval.experiences).toEqual([experience]);
    expect(withRetrieval.retrieval.skills).toEqual([skill]);
    expect(withRetrieval.driver_context.experiences).toEqual([experience]);

    const withoutRetrieval = await agent.executeTask({
      spec: 'Task without retrieval.',
      task_id: 'task_retrieval_absent',
      call_id: 'call_retrieval_absent',
      source_driver: 'acp-external',
    });
    expect(withoutRetrieval.retrieval).toEqual({ skills: [], experiences: [] });
    expect(String(withoutRetrieval.warnings?.join(' '))).toContain('retrieval_unavailable');
  });

  it('端到端：落盘后经验提取器的输入同时含 DriverReturn 与上下文的 thinking/planning', async () => {
    const stateRoot = await freshStateRoot();
    const { harness, makeAgent } = await createInfra(stateRoot, 'role_extract_input');
    const agent = await makeAgent({
      llm: mockToolClient([driverCallResponse('call_1'), DONE_RESPONSE]),
      tools: [driverTool(sampleDriverReturn('Reused the serializer as planned.'))],
      contextCleaner: new RecordingCleaner('snapshot'),
    });

    await agent.executeTask({
      spec: 'Implement using the existing serializer.',
      task_id: 'task_extract_input',
      call_id: 'call_extract_input',
      source_driver: 'acp-external',
    });

    const pending = await harness.bufferRepository.getPendingBuffer('role_extract_input', 1);
    expect(pending).toBeDefined();

    const prompts: string[] = [];
    const llm: LlmClient = {
      complete: async (input: { messages: LlmMessage[] }) => {
        prompts.push(input.messages.find((message) => message.role === 'user')?.content ?? '');
        return JSON.stringify({ experiences: [] });
      },
    };
    await new LlmExperienceExtractor(llm).extract(pending!.snapshot, pending!.agentContext);

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    // DriverReturn 侧：提取器读的就是落盘的那份报告
    expect(prompt).toContain('## Driver Report (what was done)');
    expect(prompt).toContain('Reused the serializer as planned.');
    // AgentContext 侧：没有成对落盘的话这两行根本不存在
    expect(prompt).toContain('## Agent Context (why it was done)');
    expect(prompt).toContain(THINKING_TRACE);
    expect(prompt).toContain(PLANNING_TRACE);
  });
});
