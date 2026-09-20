import { describe, it, expect } from 'vitest';
import { LlmExperienceExtractor } from '../adapters/llm-experience-extractor';
import { MockLlmClient } from '../adapters/mock-llm-client';
import type { LlmClient } from '../ports/llm-client';
import type { BufferSnapshot, AgentContextSnapshot, DriverReturn } from '../schemas';

// ═══════════════════════════════════════════
//  Test fixtures
// ═══════════════════════════════════════════

const emptyDriverReturn: DriverReturn = {
  artifacts: [],
  summary: '',
  decisions: [],
  blockers: [],
  referenced_experiences: [],
  assumptions: [],
};

function makeBuffer(overrides: Partial<DriverReturn> = {}): BufferSnapshot {
  return {
    task_id: 'task_001',
    task_description: 'Fix login bug',
    source_task_id: 'task_001',
    source_driver: 'mock-driver',
    driver_return: { ...emptyDriverReturn, ...overrides },
    received_at: new Date().toISOString(),
    retry_count: 0,
    extraction_status: 'pending',
  };
}

function makeAgentContext(overrides: Partial<AgentContextSnapshot> = {}): AgentContextSnapshot {
  return {
    snapshot_id: 'snap_001',
    source_task_id: 'task_001',
    agent_id: 'agent_001',
    thinking_trace: 'Thought: token-based auth is more reliable',
    planning_trace: 'Step 1: implement JWT',
    driver_calls: [],
    cleaned_at: new Date().toISOString(),
    original_token_count: 1000,
    cleaned_token_count: 200,
    compression_ratio: 0.2,
    ...overrides,
  };
}

// ═══════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════

describe('LlmExperienceExtractor', () => {
  it('正常提取：LLM 返回有效 JSON → 解析成功', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          experiences: [
            {
              description: 'Use JWT for auth',
              content: 'JWT authentication proved more reliable than session-based approach',
              type: 'positive',
              confidence: 0.85,
              tags: ['auth', 'jwt'],
            },
          ],
        }),
      },
    ]);
    const extractor = new LlmExperienceExtractor(llm);

    const snapshot = makeBuffer({
      summary: 'Fixed auth by implementing JWT',
      decisions: [
        {
          point: 'Auth method',
          options: ['JWT', 'sessions'],
          chosen: 'JWT',
          reason: 'more scalable',
        },
      ],
    });

    const result = await extractor.extract(snapshot);

    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]!.type).toBe('positive');
    expect(result.experiences[0]!.description).toBe('Use JWT for auth');
    expect(result.experiences[0]!.content).toContain('JWT');
    expect(result.experiences[0]!.confidence).toBe(0.85);
    expect(result.experiences[0]!.tags).toEqual(['auth', 'jwt']);
    expect(result.result.experiences_created).toBe(1);
    expect(result.result.negative_experiences).toBe(0);
  });

  it('JSON 格式错误 → 降级到 rule-based 提取', async () => {
    const llm = new MockLlmClient([{ response: 'not valid json at all' }]);
    const extractor = new LlmExperienceExtractor(llm);

    const snapshot = makeBuffer({ summary: 'Worked' });

    const result = await extractor.extract(snapshot);

    // 降级后 rule-based 对于空 DriverReturn 产出一条 auto-generated 正经验
    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]!.type).toBe('positive');
    expect(result.experiences[0]!.tags).toContain('auto-generated');
    // 降级原因必须留痕，否则事后无法判断为什么没走 LLM
    expect(result.warnings?.[0]).toContain('LLM extraction failed');
    expect(result.warnings?.[0]).toContain('rule-based');
  });

  it('LLM 抛异常 → 降级到 rule-based 提取', async () => {
    const llm = new MockLlmClient([{ response: 'ERROR:Network timeout' }]);
    const extractor = new LlmExperienceExtractor(llm);

    const snapshot = makeBuffer({ summary: 'Worked' });

    const result = await extractor.extract(snapshot);

    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]!.type).toBe('positive');
  });

  it('LLM 返回 experiences 数组为空 → 合法的空结果，不降级到 rule-based', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({ experiences: [] }),
      },
    ]);
    const extractor = new LlmExperienceExtractor(llm);

    const snapshot = makeBuffer({ summary: 'Done' });

    const result = await extractor.extract(snapshot);

    // 空数组是「本次任务没有满足准入判据的经验」，直接返回空；
    // 降级到 rule-based 会重新造出被提示词过滤掉的流水账
    expect(result.experiences).toHaveLength(0);
    expect(result.result.experiences_created).toBe(0);
    expect(result.result.negative_experiences).toBe(0);
  });

  it('LLM 返回的 confidence 越界（1.5）→ 降级', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          experiences: [
            {
              description: 'Test',
              content: 'Test content',
              type: 'positive',
              confidence: 1.5,
              tags: [],
            },
          ],
        }),
      },
    ]);
    const extractor = new LlmExperienceExtractor(llm);

    const snapshot = makeBuffer({ summary: 'Done' });

    const result = await extractor.extract(snapshot);

    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]!.tags).toContain('auto-generated');
  });

  it('LLM 返回多条经验：2 positive + 1 negative → 全部解析', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          experiences: [
            {
              description: 'Use connection pooling',
              content: 'Connection pooling improves DB performance under load',
              type: 'positive',
              confidence: 0.9,
              tags: ['database', 'performance'],
            },
            {
              description: 'Cache API responses',
              content: 'Caching reduces latency for frequently accessed endpoints',
              type: 'positive',
              confidence: 0.8,
              tags: ['caching', 'api'],
            },
            {
              description: 'Avoid N+1 queries',
              content: 'N+1 query pattern causes significant slowdown; use eager loading instead',
              type: 'negative',
              confidence: 0.75,
              tags: ['database', 'performance'],
            },
          ],
        }),
      },
    ]);
    const extractor = new LlmExperienceExtractor(llm);

    const snapshot = makeBuffer({
      summary: 'Optimized database queries',
      decisions: [
        {
          point: 'Query strategy',
          options: ['eager loading', 'lazy loading'],
          chosen: 'eager loading',
          reason: 'avoid N+1',
        },
      ],
    });

    const result = await extractor.extract(snapshot);

    expect(result.experiences).toHaveLength(3);
    expect(result.experiences.filter((e) => e.type === 'positive')).toHaveLength(2);
    expect(result.experiences.filter((e) => e.type === 'negative')).toHaveLength(1);
    expect(result.result.experiences_created).toBe(2);
    expect(result.result.negative_experiences).toBe(1);
  });

  it('含 AgentContextSnapshot → prompt 中包含 thinking_trace', async () => {
    let capturedUserMessage = '';
    const llm: LlmClient = {
      async complete(input) {
        capturedUserMessage = input.messages.find((m) => m.role === 'user')?.content ?? '';
        return JSON.stringify({
          experiences: [
            {
              description: 'JWT more reliable',
              content: 'Token-based auth',
              type: 'positive',
              confidence: 0.8,
              tags: ['auth'],
            },
          ],
        });
      },
    };

    const extractor = new LlmExperienceExtractor(llm);
    const snapshot = makeBuffer({ summary: 'Done' });
    const ctx = makeAgentContext();

    await extractor.extract(snapshot, ctx);

    expect(capturedUserMessage).toContain('token-based auth is more reliable');
    expect(capturedUserMessage).toContain('## Agent Context');
  });

  it('无 AgentContextSnapshot → prompt 不含 thinking_trace 部分', async () => {
    let capturedUserMessage = '';
    const llm: LlmClient = {
      async complete(input) {
        capturedUserMessage = input.messages.find((m) => m.role === 'user')?.content ?? '';
        return JSON.stringify({
          experiences: [
            {
              description: 'Test',
              content: 'Content',
              type: 'positive',
              confidence: 0.5,
              tags: [],
            },
          ],
        });
      },
    };

    const extractor = new LlmExperienceExtractor(llm);
    const snapshot = makeBuffer({ summary: 'Done' });

    await extractor.extract(snapshot);

    expect(capturedUserMessage).not.toContain('## Agent Context');
  });

  it('LLM 返回缺少 description 字段 → 降级', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          experiences: [
            {
              content: 'Content without description',
              type: 'positive',
              confidence: 0.8,
              tags: [],
            },
          ],
        }),
      },
    ]);
    const extractor = new LlmExperienceExtractor(llm);

    const snapshot = makeBuffer({ summary: 'Done' });

    const result = await extractor.extract(snapshot);

    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]!.tags).toContain('auto-generated');
  });

  it('LLM 返回缺少 type 字段 → 降级', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          experiences: [
            {
              description: 'Test',
              content: 'Content',
              type: 'invalid_type',
              confidence: 0.8,
              tags: [],
            },
          ],
        }),
      },
    ]);
    const extractor = new LlmExperienceExtractor(llm);

    const snapshot = makeBuffer({ summary: 'Done' });

    const result = await extractor.extract(snapshot);

    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]!.tags).toContain('auto-generated');
  });

  it('多次调用使用按序响应', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          experiences: [
            {
              description: 'First call',
              content: 'Content A',
              type: 'positive',
              confidence: 0.8,
              tags: [],
            },
          ],
        }),
      },
      {
        response: JSON.stringify({
          experiences: [
            {
              description: 'Second call',
              content: 'Content B',
              type: 'positive',
              confidence: 0.9,
              tags: [],
            },
          ],
        }),
      },
    ]);
    const extractor = new LlmExperienceExtractor(llm);

    const snapshotA = makeBuffer({ summary: 'Task A' });
    const snapshotB = makeBuffer({ summary: 'Task B' });

    const resultA = await extractor.extract(snapshotA);
    const resultB = await extractor.extract(snapshotB);

    expect(resultA.experiences[0]!.description).toBe('First call');
    expect(resultB.experiences[0]!.description).toBe('Second call');
  });
});
