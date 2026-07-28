import { describe, expect, it } from 'vitest';
import {
  MarketAuctionEngine,
  ScoringEngine,
  type AgentProjection,
  type MarketTaskSpecification,
} from '../../src/market';

const FIXED_NOW = '2026-07-18T00:00:00.000Z';

describe('AgentMarket core', () => {
  it('records a reproducible winner, policy, seed, bids, and probabilities', () => {
    const first = auction('seed-42').run({ agents: agents(), task: task() });
    const second = auction('seed-42').run({ agents: agents().reverse(), task: task() });

    expect(second).toEqual(first);
    expect(first.ledger).toMatchObject({
      task_id: 'task_market_001',
      policy_version: 'market-v0',
      seed: 'seed-42',
      winner_agent_id: first.winner_agent_id,
      winner_bid_id: first.winner_bid_id,
      created_at: FIXED_NOW,
    });
    expect(first.ledger.bids).toHaveLength(3);
    expect(first.audit).toMatchObject({
      task_id: 'task_market_001',
      policy_version: 'market-v0',
      seed: 'seed-42',
      selection_mode: 'seeded_softmax',
      ledger_id: first.ledger.ledger_id,
      winner_agent_id: first.winner_agent_id,
      winner_bid_id: first.winner_bid_id,
      bid_ids: first.ledger.bids.map((bid) => bid.bid_id),
    });
    expect(first.audit.probabilities.reduce((sum, item) => sum + item.probability, 0)).toBeCloseTo(
      1,
    );
  });

  it('rejects an empty candidate set with a stable error code', () => {
    expect(() => auction('empty').run({ agents: [], task: task() })).toThrow(
      expect.objectContaining({ code: 'MARKET_NO_CANDIDATES' }),
    );
  });

  it('selects a single candidate without sampling ambiguity', () => {
    const result = auction('single').run({ agents: [agents()[0]!], task: task() });

    expect(result.winner_agent_id).toBe('agent_alpha');
    expect(result.audit.probabilities).toEqual([
      expect.objectContaining({ agent_id: 'agent_alpha', probability: 1 }),
    ]);
  });

  it('clamps an urgency-one time estimate to one second', () => {
    const urgentTask: MarketTaskSpecification = {
      ...task(),
      context: { urgency: 1, exploration_level: 0.2 },
    };
    const result = auction('urgent').run({ agents: [agents()[0]!], task: urgentTask });

    expect(result.ledger.bids[0]?.estimated_time_seconds).toBe(1);
  });

  it('keeps every score finite and inside the schema bounds', () => {
    const extreme: AgentProjection = {
      ...agents()[0]!,
      metrics_ref: {
        total_tasks: 1_000_000,
        tasks_completed: 0,
        tasks_succeeded: 1_000_000,
        skill_count: 1_000_000,
        experience_count: 0,
        avg_confidence: 1,
      },
      load_state: { active_task_count: 1_000_000, days_since_last_task: 1_000_000 },
    };

    const score = new ScoringEngine().calculateScore(extreme, task());
    expect(Object.values(score).filter((value): value is number => typeof value === 'number')).toSatisfy(
      (values: number[]) => values.every((value) => Number.isFinite(value)),
    );
    expect(score.final_score).toBeGreaterThanOrEqual(0);
    expect(score.final_score).toBeLessThanOrEqual(1);
  });

  it('rejects duplicate agent ids instead of producing an ambiguous winner', () => {
    expect(() =>
      auction('duplicates').run({ agents: [agents()[0]!, agents()[0]!], task: task() }),
    ).toThrow('Duplicate market agent_id: agent_alpha');
  });
});

function auction(seed: string): MarketAuctionEngine {
  return new MarketAuctionEngine({
    policy: { policy_version: 'market-v0', seed, tau: 0.5 },
    now: () => FIXED_NOW,
  });
}

function task(): MarketTaskSpecification {
  return {
    task_id: 'task_market_001',
    task_description: 'Implement and test a TypeScript backend service',
    requirement_profile: {
      persona_keywords: ['backend', 'typescript'],
      preferred_skill_tags: ['typescript', 'testing'],
      preferred_experience_tags: ['backend'],
    },
    context: { urgency: 0.6, exploration_level: 0.2 },
  };
}

function agents(): AgentProjection[] {
  return [
    agent('agent_alpha', ['backend', 'typescript'], 0.9, 1),
    agent('agent_beta', ['frontend', 'typescript'], 0.7, 0),
    agent('agent_gamma', ['research'], 0.5, 2),
  ];
}

function agent(
  agentId: string,
  keywords: string[],
  confidence: number,
  activeTasks: number,
): AgentProjection {
  return {
    agent_id: agentId,
    persona_ref: `persona://${agentId}/v1`,
    persona_keywords: keywords,
    skills: [
      { name: 'TypeScript implementation', tags: [...keywords, 'testing'] },
    ],
    experiences: [
      {
        name: 'Backend delivery',
        type: 'positive',
        confidence,
        tags: ['backend'],
      },
    ],
    metrics_ref: {
      total_tasks: 10,
      tasks_completed: 10,
      tasks_succeeded: Math.round(confidence * 10),
      skill_count: 1,
      experience_count: 1,
      avg_confidence: confidence,
    },
    load_state: { active_task_count: activeTasks, days_since_last_task: 1 },
  };
}
