/**
 * AgentMaintenanceScheduler 测试
 *
 * 验证：
 *   1. 退休检查：默认不自动退休只出报告；autoRetire 开启且置信度达标才退休，低于保底跳过
 *   2. 市场自学习：存活 Agent 扫描市场引入匹配技能
 *   3. runOnce 返回报告；start/stop 使用注入的调度/取消函数
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { nowTimestamp } from '../../src/core';
import { AgentMaintenanceScheduler } from '../../src/app/agent-maintenance-scheduler';
import {
  HashEmbeddingProvider,
  InMemoryRepository,
  MARKET_POOL_ROLE_ID,
} from '../../src/memory';
import type { RetireOptions, RetireResult, RetirementScanResult } from '../../src/memory';

const embedding = new HashEmbeddingProvider(64);

function scan(overrides: Partial<RetirementScanResult> = {}): RetirementScanResult {
  return {
    scan_id: 'scan_1',
    role_id: 'agent_a',
    scanned_at: nowTimestamp(),
    action: 'keep',
    confidence: 0.9,
    reasons: [],
    layers: [],
    ...overrides,
  };
}

function retiredResult(roleId: string, reason: RetireOptions['reason']): RetireResult {
  return {
    role_id: roleId,
    status: 'retired',
    retired_at: nowTimestamp(),
    retired_reason: reason ?? 'manual',
    asset_disposition: {
      skills_retained: 0,
      skills_discarded: 0,
      experiences_retained: 0,
      experiences_discarded: 0,
    },
  };
}

describe('AgentMaintenanceScheduler 退休检查', () => {
  it('默认不自动退休，只出报告', async () => {
    const retireAgent = vi.fn(async (roleId: string, options: RetireOptions) =>
      retiredResult(roleId, options.reason),
    );
    const scheduler = new AgentMaintenanceScheduler(
      {
        repository: new InMemoryRepository(embedding),
        embedding,
        retirement: {
          runRetirementScan: async () => [
            scan({ role_id: 'agent_a', action: 'retire', confidence: 0.8, suggested_reason: 'inactivity' }),
            scan({ role_id: 'agent_b', action: 'keep', confidence: 0.9 }),
          ],
          retireAgent,
        },
      },
      { autoRetire: false },
    );

    const report = await scheduler.runOnce();

    expect(report.retirement.scanned).toBe(2);
    expect(report.retirement.recommended_retire).toBe(1);
    expect(report.retirement.retired).toBe(0);
    expect(retireAgent).not.toHaveBeenCalled();
  });

  it('autoRetire 开启且置信度达标才退休，低于保底跳过', async () => {
    const retireAgent = vi.fn(async (roleId: string, options: RetireOptions) =>
      retiredResult(roleId, options.reason),
    );
    const scheduler = new AgentMaintenanceScheduler(
      {
        repository: new InMemoryRepository(embedding),
        embedding,
        retirement: {
          runRetirementScan: async () => [
            scan({ role_id: 'agent_high', action: 'retire', confidence: 0.8, suggested_reason: 'inactivity' }),
            scan({ role_id: 'agent_low', action: 'retire', confidence: 0.4, suggested_reason: 'inactivity' }),
          ],
          retireAgent,
        },
      },
      { autoRetire: true, retireConfidenceFloor: 0.5 },
    );

    const report = await scheduler.runOnce();

    expect(report.retirement.retired).toBe(1);
    expect(report.retirement.items.find((item) => item.role_id === 'agent_high')).toMatchObject({
      retired: true,
      status: 'retired',
    });
    expect(report.retirement.items.find((item) => item.role_id === 'agent_low')).toMatchObject({
      retired: false,
    });
    expect(retireAgent).toHaveBeenCalledWith('agent_high', expect.objectContaining({ reason: 'inactivity' }));
    expect(retireAgent).not.toHaveBeenCalledWith('agent_low', expect.anything());
  });
});

describe('AgentMaintenanceScheduler 市场自学习', () => {
  it('存活 Agent 扫描市场并引入匹配技能', async () => {
    const repository = new InMemoryRepository(embedding);
    await repository.initializeAgent({ role_id: 'learner', name: 'Learner', tags: ['typescript'] });
    await repository.savePersona('learner', {
      role_id: 'learner',
      version: 1,
      summary: 'typescript service expert',
      skills_overview: 'building typescript services',
      experience_coverage: 'api design',
      recent_performance: 'delivered services',
      notes: '',
      generated_at: nowTimestamp(),
    });
    await repository.ensureAgent(MARKET_POOL_ROLE_ID);
    await repository.saveSkill(MARKET_POOL_ROLE_ID, {
      id: randomUUID(),
      description: 'typescript service contract patterns',
      description_embedding: [],
      content: 'content',
      version: '1.0.0',
      review_status: 'approved',
      tags: ['typescript'],
      promoted_at: nowTimestamp(),
      agent_id: MARKET_POOL_ROLE_ID,
      market_status: 'available',
      created_at: nowTimestamp(),
      updated_at: nowTimestamp(),
    });

    const scheduler = new AgentMaintenanceScheduler(
      {
        repository,
        embedding,
        retirement: {
          runRetirementScan: async () => [],
          retireAgent: vi.fn(),
        },
      },
      {
        autoLearn: true,
        learning: {
          minPersonaSimilarity: 0,
          learnThreshold: 0.5,
          tagWeight: 0.5,
          personaWeight: 0.5,
          maxSkillsPerAgentPerCycle: 3,
        },
      },
    );

    const report = await scheduler.runOnce();

    expect(report.learning.scanned_agents).toBe(1);
    expect(report.learning.imported_skills_total).toBe(1);
  });

  it('缺省 embedding 时自学习阶段跳过（空报告）', async () => {
    const scheduler = new AgentMaintenanceScheduler(
      {
        repository: new InMemoryRepository(embedding),
        retirement: {
          runRetirementScan: async () => [],
          retireAgent: vi.fn(),
        },
      },
      { autoLearn: true },
    );

    const report = await scheduler.runOnce();
    expect(report.learning).toEqual({ scanned_agents: 0, imported_skills_total: 0, per_agent: [] });
  });
});

describe('AgentMaintenanceScheduler start/stop', () => {
  it('使用注入的调度/取消函数', async () => {
    const schedule = vi.fn((_handler: () => void, _ms: number) => 42 as unknown as ReturnType<typeof setInterval>);
    const cancel = vi.fn();
    const scheduler = new AgentMaintenanceScheduler(
      {
        repository: new InMemoryRepository(embedding),
        retirement: {
          runRetirementScan: async () => [],
          retireAgent: vi.fn(),
        },
      },
      { schedule, cancel, logger: () => {} },
    );

    scheduler.start(1000);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1000);

    scheduler.stop();
    expect(cancel).toHaveBeenCalledWith(42);
  });
});
