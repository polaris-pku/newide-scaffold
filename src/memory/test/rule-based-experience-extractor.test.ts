import { describe, it, expect } from 'vitest';
import { RuleBasedExperienceExtractor } from '../adapters/rule-based-experience-extractor';
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
    thinking_trace: 'Thought: login token was expired',
    planning_trace: 'Step 1: check token',
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

describe('RuleBasedExperienceExtractor', () => {
  it('extract with decisions + assumptions produces positive experience containing decisions', async () => {
    const snapshot = makeBuffer({
      summary: 'Resolved by refreshing token',
      decisions: [
        {
          point: 'Auth fix strategy',
          options: ['refresh token', 'reset password'],
          chosen: 'refresh token',
          reason: 'Less disruptive to user',
        },
      ],
      assumptions: [
        { assumption: 'Token expiry is the root cause', risk_if_wrong: 'May need deeper debug' },
      ],
    });

    const extractor = new RuleBasedExperienceExtractor();
    const result = await extractor.extract(snapshot);

    expect(result.experiences).toHaveLength(1);
    const exp = result.experiences.at(0)!;
    expect(exp.type).toBe('positive');
    expect(exp.content).toContain('Auth fix strategy');
    expect(exp.content).toContain('refresh token');
    expect(exp.content).toContain('Token expiry is the root cause');
    expect(exp.description).toBe('Resolved by refreshing token');
    expect(result.result.experiences_created).toBe(1);
    expect(result.result.negative_experiences).toBe(0);
  });

  it('extract with unresolved blockers produces additional negative experience', async () => {
    const snapshot = makeBuffer({
      summary: 'Partial fix',
      decisions: [{ point: 'Approach', options: ['A', 'B'], chosen: 'A', reason: 'faster' }],
      blockers: [
        {
          blocker: 'DB connection timeout',
          attempts: ['increase pool size', 'add retry logic'],
          resolution: '',
          resolved: false,
        },
      ],
    });

    const extractor = new RuleBasedExperienceExtractor();
    const result = await extractor.extract(snapshot);

    expect(result.experiences).toHaveLength(2);
    const negative = result.experiences.find((e) => e.type === 'negative')!;
    expect(negative.content).toContain('DB connection timeout');
    expect(negative.content).toContain('increase pool size');
    expect(negative.tags).toContain('blocker');
    expect(result.result.negative_experiences).toBe(1);
  });

  it('extract with all blockers resolved produces only positive experience', async () => {
    const snapshot = makeBuffer({
      summary: 'All done',
      decisions: [],
      blockers: [
        {
          blocker: 'Build failure',
          attempts: ['fix lint'],
          resolution: 'ran format:fix',
          resolved: true,
        },
      ],
    });

    const extractor = new RuleBasedExperienceExtractor();
    const result = await extractor.extract(snapshot);

    expect(result.experiences).toHaveLength(1);
    expect(result.experiences.at(0)!.type).toBe('positive');
    expect(result.result.negative_experiences).toBe(0);
  });

  it('extract with empty DriverReturn produces minimal positive with auto-generated tag', async () => {
    const snapshot = makeBuffer();
    const extractor = new RuleBasedExperienceExtractor();
    const result = await extractor.extract(snapshot);

    expect(result.experiences).toHaveLength(1);
    const exp = result.experiences.at(0)!;
    expect(exp.type).toBe('positive');
    expect(exp.tags).toEqual(['auto-generated']);
    expect(exp.content).toContain('Fix login bug');
    expect(exp.confidence).toBe(0.5);
  });

  it('extract without AgentContextSnapshot works and excludes thinking_trace', async () => {
    const snapshot = makeBuffer({
      summary: 'Done',
      decisions: [{ point: 'Method', options: ['X'], chosen: 'X', reason: 'only option' }],
    });

    const extractor = new RuleBasedExperienceExtractor();
    const result = await extractor.extract(snapshot);

    expect(result.experiences).toHaveLength(1);
    expect(result.experiences.at(0)!.content).not.toContain('Thinking trace');
    expect(result.experiences.at(0)!.content).toContain('Method');
  });

  it('extract with AgentContextSnapshot includes thinking_trace in content', async () => {
    const snapshot = makeBuffer({
      summary: 'Done',
      decisions: [{ point: 'Method', options: ['X'], chosen: 'X', reason: 'only option' }],
    });
    const ctx = makeAgentContext();

    const extractor = new RuleBasedExperienceExtractor();
    const result = await extractor.extract(snapshot, ctx);

    expect(result.experiences.at(0)!.content).toContain('login token was expired');
  });

  it('没有上下文快照也不产出归属：候选经验不含 agent_id，source_task_id 只作溯源', async () => {
    const snapshot = makeBuffer({
      summary: 'Done',
      decisions: [{ point: 'Method', options: ['X'], chosen: 'X', reason: 'only option' }],
    });

    const extractor = new RuleBasedExperienceExtractor();
    const result = await extractor.extract(snapshot);

    // 归属只有 Buffer 所属 Agent（memory.role_id）说得准，提取器拿不到它。候选经验里
    // **没有** agent_id 字段——既不会写成空串，也不可能拿 source_task_id 顶替（把经验挂到
    // 一个根本不是 Agent 的 id 上）；最终 ExperienceRecord.agent_id 由持久化层按 role_id 补齐。
    const candidate = result.experiences.at(0)!;
    expect('agent_id' in candidate).toBe(false);
    // 任务溯源字段照旧保留
    expect(snapshot.source_task_id).toBe('task_001');
    expect(candidate.source_task_id).toBe('task_001');
  });
});

describe('confidence calculation', () => {
  it('fully_effective referenced experience yields high confidence', async () => {
    const snapshot = makeBuffer({
      summary: 'Worked perfectly',
      decisions: [{ point: 'P', options: ['A'], chosen: 'A', reason: 'r' }],
      referenced_experiences: [
        { experience_id: 'exp_1', applied: true, effectiveness: 'fully_effective', note: 'great' },
      ],
    });

    const extractor = new RuleBasedExperienceExtractor();
    const result = await extractor.extract(snapshot);

    expect(result.experiences.at(0)!.confidence).toBeCloseTo(0.97, 2);
  });

  it('ineffective referenced experience yields low confidence', async () => {
    const snapshot = makeBuffer({
      summary: 'Struggled',
      decisions: [{ point: 'P', options: ['A'], chosen: 'A', reason: 'r' }],
      referenced_experiences: [
        { experience_id: 'exp_2', applied: true, effectiveness: 'ineffective', note: 'bad' },
      ],
    });

    const extractor = new RuleBasedExperienceExtractor();
    const result = await extractor.extract(snapshot);

    expect(result.experiences.at(0)!.confidence).toBeCloseTo(0.2, 2);
  });

  it('unresolved blockers reduce confidence', async () => {
    const snapshot = makeBuffer({
      summary: 'Partial',
      decisions: [{ point: 'P', options: ['A'], chosen: 'A', reason: 'r' }],
      referenced_experiences: [
        { experience_id: 'exp_3', applied: true, effectiveness: 'fully_effective', note: '' },
      ],
      blockers: [
        { blocker: 'X', attempts: ['try'], resolution: '', resolved: false },
        { blocker: 'Y', attempts: ['try2'], resolution: '', resolved: false },
      ],
    });

    const extractor = new RuleBasedExperienceExtractor();
    const result = await extractor.extract(snapshot);

    // 0.97 - 0.2 = 0.77
    expect(result.experiences.at(0)!.confidence).toBeCloseTo(0.77, 2);
  });

  it('no referenced experiences returns base confidence 0.5', async () => {
    const snapshot = makeBuffer({
      summary: 'Done',
      decisions: [{ point: 'P', options: ['A'], chosen: 'A', reason: 'r' }],
    });

    const extractor = new RuleBasedExperienceExtractor();
    const result = await extractor.extract(snapshot);

    expect(result.experiences.at(0)!.confidence).toBe(0.5);
  });
});
