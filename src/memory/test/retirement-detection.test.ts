/**
 * 三重门控退休检测（week3 RFC §8.2 触发机制）测试
 *
 * 覆盖：
 *   1. 健康 Agent → keep，只跑统计层
 *   2. 完整三层管线：统计 retire → Persona 漂移确认 → LLM 最终仲裁 → retire + suggested_reason
 *   3. 层间冷却门控：冷却期内第二层被跳过
 *   4. computePersonaDrift 纯函数（已存漂移 / 探索期抑制 / 陈旧 Persona + 低交付）
 *   5. LLM 不可用 → 回退到统计层结论，不阻断扫描
 *   6. 第二层不降级：统计 warn + 无漂移 → 保持 warn
 *   7. scanAll：跳过 retired/draining，单个失败容错
 *   8. 非法目标：未知 Agent / 已退休 Agent 抛错
 */
import { describe, expect, it } from 'vitest';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { MockLlmClient } from '../adapters/mock-llm-client';
import {
  LlmRetirementEvaluator,
  PersonaDriftEvaluator,
  RetirementDetector,
  StatisticalRetirementEvaluator,
  computePersonaDrift,
  type RetirementEvaluator,
} from '../services/retirement-detection';
import type { AgentMetrics, PersonaDef } from '../schemas';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 固定"现在"，保证 days_since_last_won / persona 年龄确定性 */
const NOW_MS = Date.parse('2026-08-01T00:00:00.000Z');

describe('RetirementDetector 三重门控', () => {
  it('健康 Agent → keep，只跑统计层', async () => {
    const repository = await repositoryWith('role_healthy', healthyMetrics('role_healthy'));
    const detector = new RetirementDetector(repository, { now: () => NOW_MS });

    const result = await detector.scan('role_healthy');

    expect(result.action).toBe('keep');
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]).toMatchObject({ layer: 'statistical', action: 'keep' });
  });

  it('完整三层管线：统计 → 漂移确认 → LLM 仲裁 → retire + suggested_reason', async () => {
    const roleId = 'role_drift';
    const repository = await repositoryWith(roleId, staleMetrics(roleId));
    const mockLlm = new MockLlmClient([
      {
        response: JSON.stringify({
          recommended_action: 'retire',
          confidence: 0.8,
          reasoning: 'Market equivalents exist for most skills.',
          market_replaceability: 0.8,
          experience_recoverability: 0.6,
        }),
      },
    ]);
    const detector = new RetirementDetector(repository, {
      now: () => NOW_MS,
      llm: new LlmRetirementEvaluator(mockLlm),
    });

    const result = await detector.scan(roleId);

    expect(result.action).toBe('retire');
    expect(result.layers.map((layer) => layer.layer)).toEqual([
      'statistical',
      'persona_drift',
      'llm',
    ]);
    expect(result.suggested_reason).toBe('persona_drift');
    expect(result.layers[2]).toMatchObject({
      layer: 'llm',
      action: 'retire',
      market_replaceability: 0.8,
    });
    // 扫描状态持久化：漂移分 + 三层时间戳写回 metrics
    const after = await repository.getMetrics(roleId);
    expect(after.persona_drift).toBeCloseTo(0.6, 5);
    expect(after.last_retirement_scan_at).toBeDefined();
    expect(after.last_persona_drift_eval_at).toBeDefined();
    expect(after.last_llm_eval_at).toBeDefined();
  });

  it('层间冷却门控：冷却期内第二层被跳过，冷却期后恢复', async () => {
    const roleId = 'role_cooldown';
    const repository = await repositoryWith(roleId, staleMetrics(roleId));
    let currentNow = NOW_MS;
    const detector = new RetirementDetector(repository, {
      now: () => currentNow,
      layer2CooldownMs: 7 * DAY_MS,
    });

    // T0：无冷却历史 → 漂移层真实评估
    const first = await detector.scan(roleId);
    expect(first.layers.find((layer) => layer.layer === 'persona_drift')?.skipped).toBeUndefined();

    // T0 + 1 天（冷却期内）→ 漂移层被跳过（沿用第一层结论）
    currentNow = NOW_MS + 1 * DAY_MS;
    const second = await detector.scan(roleId);
    const secondDrift = second.layers.find((layer) => layer.layer === 'persona_drift');
    expect(secondDrift?.skipped).toBe(true);
    expect(secondDrift?.reasons.join(' ')).toContain('cooldown');
    // 冷却期跳过不改变最终结论（统计层 retire 依旧成立）
    expect(second.action).toBe('retire');

    // T0 + 8 天（冷却期后）→ 漂移层恢复评估
    currentNow = NOW_MS + 8 * DAY_MS;
    const third = await detector.scan(roleId);
    expect(third.layers.find((layer) => layer.layer === 'persona_drift')?.skipped).toBeUndefined();
  });

  it('computePersonaDrift 纯函数：已存漂移优先 / 探索期抑制 / 陈旧判定', () => {
    const persona = stalePersona('x');
    // 已持久化的 persona_drift 直接采用
    expect(computePersonaDrift(staleMetrics('x', { persona_drift: 0.9 }), persona, NOW_MS)).toBe(0.9);
    // 探索期（total_tasks < 20）不判漂移
    expect(
      computePersonaDrift(staleMetrics('x', { total_tasks: 10 }), persona, NOW_MS),
    ).toBe(0);
    // 无 stable_since 且 Persona 新鲜 → 无漂移
    const noStableSince = staleMetrics('x');
    delete noStableSince.persona_stable_since;
    expect(computePersonaDrift(noStableSince, freshPersona('x'), NOW_MS)).toBe(0);
    // 无 stable_since 但 Persona 陈旧（generated_at）+ 低交付 → 漂移 0.6
    expect(computePersonaDrift(noStableSince, persona, NOW_MS)).toBeCloseTo(0.6, 5);
  });

  it('LLM 不可用 → 回退到统计层结论，不阻断扫描', async () => {
    const roleId = 'role_fallback';
    const repository = await repositoryWith(roleId, staleMetrics(roleId));
    const mockLlm = new MockLlmClient([{ response: 'ERROR: provider down' }]);
    const detector = new RetirementDetector(repository, {
      now: () => NOW_MS,
      llm: new LlmRetirementEvaluator(mockLlm),
    });

    const result = await detector.scan(roleId);

    expect(result.action).toBe('retire'); // 回退到统计层 retire
    expect(result.layers[2]).toMatchObject({ layer: 'llm', action: 'retire', confidence: 0.4 });
    expect(result.layers[2]!.reasons[0]).toContain('unavailable');
  });

  it('第二层不降级：统计 warn + 无漂移 → 保持 warn', async () => {
    const roleId = 'role_warn';
    const repository = await repositoryWith(roleId, warnMetrics(roleId));
    const detector = new RetirementDetector(repository, { now: () => NOW_MS });

    const result = await detector.scan(roleId);

    expect(result.action).toBe('warn');
    expect(result.layers).toHaveLength(2);
    expect(result.layers[1]).toMatchObject({ layer: 'persona_drift', action: 'keep' });
    expect(result.layers[1]!.reasons.join(' ')).toContain('No persona drift');
  });

  it('scanAll：跳过 retired/draining，单个失败容错', async () => {
    const repository = await repositoryWith(
      'role_active',
      healthyMetrics('role_active'),
      'role_retired',
      staleMetrics('role_retired'),
      'role_draining',
      staleMetrics('role_draining'),
      'role_boom',
      healthyMetrics('role_boom'),
    );
    await repository.updateAgentStatus('role_retired', 'retired');
    await repository.updateAgentStatus('role_draining', 'draining');

    const throwingStatistical: RetirementEvaluator = {
      layer: 'statistical',
      evaluate: async (input) => {
        if (input.role_id === 'role_boom') throw new Error('boom');
        return { action: 'keep', confidence: 0.9, reasons: ['ok'] };
      },
    };
    const detector = new RetirementDetector(repository, {
      now: () => NOW_MS,
      statistical: throwingStatistical,
    });

    const results = await detector.scanAll();
    const roleIds = results.map((result) => result.role_id);

    expect(roleIds).toContain('role_active');
    expect(roleIds).not.toContain('role_retired');
    expect(roleIds).not.toContain('role_draining');
    const boom = results.find((result) => result.role_id === 'role_boom');
    expect(boom?.error).toBe('boom');
    expect(boom?.action).toBe('keep');
  });

  it('非法目标：未知 Agent / 已退休 Agent 抛错', async () => {
    const repository = await repositoryWith('role_ok', healthyMetrics('role_ok'));
    const detector = new RetirementDetector(repository, { now: () => NOW_MS });

    await expect(detector.scan('role_missing')).rejects.toThrow('Agent not found');
    await repository.updateAgentStatus('role_ok', 'retired');
    await expect(detector.scan('role_ok')).rejects.toThrow('not scannable');
  });
});

describe('三层评估器独立行为', () => {
  it('StatisticalRetirementEvaluator 直接基于信号', async () => {
    const input = baseInput('x', staleMetrics('x'));
    const evaluator = new StatisticalRetirementEvaluator(() => NOW_MS);
    const evaluation = await evaluator.evaluate(input);
    expect(evaluation.action).toBe('retire');
    expect(evaluation.confidence).toBe(0.7);
  });

  it('PersonaDriftEvaluator 在探索期返回 keep', async () => {
    const input = baseInput('x', staleMetrics('x', { total_tasks: 10 }));
    const evaluator = new PersonaDriftEvaluator(() => NOW_MS);
    const evaluation = await evaluator.evaluate(input);
    expect(evaluation.action).toBe('keep');
    expect(evaluation.persona_drift).toBe(0);
  });
});

// ═══════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════

function baseInput(roleId: string, metrics: AgentMetrics) {
  return {
    role_id: roleId,
    metrics,
    persona: stalePersona(roleId),
    signals: {
      days_since_last_won: 100,
      stale_bids: true,
      critical_staleness: true,
      low_success_rate: true,
      inactive: true,
      recommended_action: 'retire' as const,
    },
    skills: [],
    experiences: [],
    market_skills: [],
  };
}

async function repositoryWith(
  ...roles: Array<string | AgentMetrics>
): Promise<InMemoryRepository> {
  const repository = new InMemoryRepository(new HashEmbeddingProvider(32));
  for (let index = 0; index < roles.length; index += 2) {
    const roleId = roles[index] as string;
    const metrics = roles[index + 1] as AgentMetrics;
    await repository.initializeAgent({ role_id: roleId, name: roleId, tags: [] });
    await repository.updateMetrics(roleId, () => metrics);
  }
  return repository;
}

function healthyMetrics(roleId: string): AgentMetrics {
  return {
    role_id: roleId,
    total_tasks: 5,
    tasks_bid: 5,
    tasks_won: 5,
    tasks_completed: 5,
    tasks_succeeded: 5,
    tasks_partial: 0,
    tasks_failed: 0,
    skill_count: 2,
    experience_count: 4,
    imported_skill_count: 0,
    promoted_skill_count: 1,
    avg_confidence: 0.8,
    token_cost_total: 10,
    persona_version: 1,
    last_won_at: new Date(NOW_MS - 1 * DAY_MS).toISOString(),
    last_task_at: new Date(NOW_MS - 1 * DAY_MS).toISOString(),
  };
}

function warnMetrics(roleId: string): AgentMetrics {
  return {
    ...healthyMetrics(roleId),
    total_tasks: 5,
    tasks_won: 3,
    last_won_at: new Date(NOW_MS - 40 * DAY_MS).toISOString(),
    last_task_at: new Date(NOW_MS - 40 * DAY_MS).toISOString(),
  };
}

function staleMetrics(roleId: string, overrides: Partial<AgentMetrics> = {}): AgentMetrics {
  return {
    role_id: roleId,
    total_tasks: 25,
    tasks_bid: 25,
    tasks_won: 10,
    tasks_completed: 25,
    tasks_succeeded: 5,
    tasks_partial: 5,
    tasks_failed: 15,
    skill_count: 3,
    experience_count: 8,
    imported_skill_count: 0,
    promoted_skill_count: 2,
    avg_confidence: 0.6,
    token_cost_total: 100,
    persona_version: 3,
    last_won_at: new Date(NOW_MS - 100 * DAY_MS).toISOString(),
    last_task_at: new Date(NOW_MS - 100 * DAY_MS).toISOString(),
    persona_stable_since: new Date(NOW_MS - 100 * DAY_MS).toISOString(),
    ...overrides,
  };
}

function stalePersona(roleId: string): PersonaDef {
  return {
    role_id: roleId,
    version: 3,
    summary: 'TypeScript service expert.',
    skills_overview: 'Strong in TypeScript services.',
    experience_coverage: '8 experiences.',
    recent_performance: 'Declining delivery.',
    notes: '',
    generated_at: new Date(NOW_MS - 100 * DAY_MS).toISOString(),
  };
}

function freshPersona(roleId: string): PersonaDef {
  return {
    role_id: roleId,
    version: 2,
    summary: 'TypeScript service expert.',
    skills_overview: 'Strong in TypeScript services.',
    experience_coverage: '8 experiences.',
    recent_performance: 'Consistent delivery.',
    notes: '',
    generated_at: new Date(NOW_MS - 1 * DAY_MS).toISOString(),
  };
}
