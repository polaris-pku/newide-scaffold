/**
 * Metrics 采集与退休信号评估测试
 *
 * 验证：
 *   1. recordBid 只递增 tasks_bid
 *   2. recordTaskOutcome 递增 won/completed/对应 outcome 计数器 + 时间戳
 *   3. first_task_at 只写入一次
 *   4. evaluateRetirementSignals 的决策矩阵（keep / warn / retire）
 */
import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import {
  recordBid,
  recordTaskOutcome,
  evaluateRetirementSignals,
} from '../services/metrics';
import type { AgentMetrics } from '../schemas';

const ROLE = 'role_metrics';

async function repo(): Promise<InMemoryRepository> {
  const r = new InMemoryRepository();
  await r.initializeAgent({ role_id: ROLE, name: 'Metrics', tags: [] });
  return r;
}

function metrics(overrides: Partial<AgentMetrics> = {}): AgentMetrics {
  return {
    role_id: ROLE,
    total_tasks: 0,
    tasks_bid: 0,
    tasks_won: 0,
    tasks_completed: 0,
    tasks_succeeded: 0,
    tasks_partial: 0,
    tasks_failed: 0,
    skill_count: 0,
    experience_count: 0,
    imported_skill_count: 0,
    promoted_skill_count: 0,
    avg_confidence: 0,
    token_cost_total: 0,
    persona_version: 1,
    ...overrides,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('recordBid', () => {
  it('只递增 tasks_bid，不影响其他字段', async () => {
    const r = await repo();
    await recordBid(r, ROLE);
    await recordBid(r, ROLE);
    const m = await r.getMetrics(ROLE);
    expect(m.tasks_bid).toBe(2);
    expect(m.total_tasks).toBe(0);
    expect(m.tasks_won).toBe(0);
    expect(m.tasks_completed).toBe(0);
  });
});

describe('recordTaskOutcome', () => {
  it('succeeded → won/completed/succeeded 递增并写入时间戳', async () => {
    const r = await repo();
    await recordTaskOutcome(r, ROLE, 'succeeded');
    const m = await r.getMetrics(ROLE);
    expect(m.total_tasks).toBe(1);
    expect(m.tasks_won).toBe(1);
    expect(m.tasks_completed).toBe(1);
    expect(m.tasks_succeeded).toBe(1);
    expect(m.tasks_partial).toBe(0);
    expect(m.tasks_failed).toBe(0);
    expect(m.last_task_at).toBeTruthy();
    expect(m.last_won_at).toBeTruthy();
    expect(m.first_task_at).toBe(m.last_task_at);
  });

  it('partial → tasks_partial++，succeeded/failed 不变', async () => {
    const r = await repo();
    await recordTaskOutcome(r, ROLE, 'partial');
    const m = await r.getMetrics(ROLE);
    expect(m.tasks_completed).toBe(1);
    expect(m.tasks_partial).toBe(1);
    expect(m.tasks_succeeded).toBe(0);
    expect(m.tasks_failed).toBe(0);
  });

  it('failed → tasks_failed++', async () => {
    const r = await repo();
    await recordTaskOutcome(r, ROLE, 'failed');
    const m = await r.getMetrics(ROLE);
    expect(m.tasks_completed).toBe(1);
    expect(m.tasks_failed).toBe(1);
    expect(m.tasks_succeeded).toBe(0);
  });

  it('first_task_at 只写入一次，last_task_at 每次更新', async () => {
    const r = await repo();
    await recordTaskOutcome(r, ROLE, 'succeeded');
    const first = (await r.getMetrics(ROLE)).first_task_at;
    const firstLast = (await r.getMetrics(ROLE)).last_task_at;
    // 等一小段时间，让 last_task_at 能区分
    await new Promise((resolve) => setTimeout(resolve, 2));
    await recordTaskOutcome(r, ROLE, 'failed');
    const m = await r.getMetrics(ROLE);
    expect(m.first_task_at).toBe(first);
    expect(m.tasks_failed).toBe(1);
    expect(m.last_task_at).not.toBe(firstLast);
  });
});

describe('evaluateRetirementSignals', () => {
  const now = Date.parse('2026-08-13T00:00:00Z');

  it('新 Agent（任务数不足）→ keep', () => {
    const signals = evaluateRetirementSignals(metrics(), now);
    expect(signals.recommended_action).toBe('keep');
  });

  it('严重滞留（>90 天未中标）→ retire', () => {
    const m = metrics({
      total_tasks: 10,
      tasks_won: 5,
      tasks_completed: 5,
      tasks_succeeded: 5,
      last_won_at: new Date(now - 100 * DAY_MS).toISOString(),
    });
    const signals = evaluateRetirementSignals(m, now);
    expect(signals.critical_staleness).toBe(true);
    expect(signals.recommended_action).toBe('retire');
  });

  it('滞留 + 低成功率 → retire', () => {
    const m = metrics({
      total_tasks: 25,
      tasks_won: 12,
      tasks_completed: 12,
      tasks_succeeded: 2,
      last_won_at: new Date(now - 40 * DAY_MS).toISOString(),
    });
    const signals = evaluateRetirementSignals(m, now);
    expect(signals.stale_bids).toBe(true);
    expect(signals.low_success_rate).toBe(true);
    expect(signals.recommended_action).toBe('retire');
  });

  it('仅滞留未伴低成功率 → warn（非 retire）', () => {
    const m = metrics({
      total_tasks: 25,
      tasks_won: 12,
      tasks_completed: 12,
      tasks_succeeded: 10,
      last_won_at: new Date(now - 40 * DAY_MS).toISOString(),
    });
    const signals = evaluateRetirementSignals(m, now);
    expect(signals.stale_bids).toBe(true);
    expect(signals.low_success_rate).toBe(false);
    expect(signals.recommended_action).toBe('warn');
  });

  it('健康活跃 Agent → keep', () => {
    const m = metrics({
      total_tasks: 10,
      tasks_won: 10,
      tasks_completed: 10,
      tasks_succeeded: 9,
      last_task_at: new Date(now - 60_000).toISOString(),
      last_won_at: new Date(now - 60_000).toISOString(),
    });
    const signals = evaluateRetirementSignals(m, now);
    expect(signals.stale_bids).toBe(false);
    expect(signals.low_success_rate).toBe(false);
    expect(signals.recommended_action).toBe('keep');
  });
});
