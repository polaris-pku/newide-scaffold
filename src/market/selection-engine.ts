import { createHash } from 'node:crypto';
import { SCHEMA_VERSION } from '../core';
import {
  AgentProjectionSchema,
  BidLedgerSchema,
  BidSchema,
  MarketAuditSchema,
  MarketPolicySchema,
  MarketTaskSpecificationSchema,
  type AgentProjection,
  type Bid,
  type MarketAuctionResult,
  type MarketPolicy,
  type MarketTaskSpecification,
  type ScoreBreakdown,
} from './models';
import { ScoringEngine } from './scoring-engine';

export class MarketNoCandidatesError extends Error {
  readonly code = 'MARKET_NO_CANDIDATES';

  constructor() {
    super('AgentMarket received no candidates');
    this.name = 'MarketNoCandidatesError';
  }
}

export interface MarketAuctionEngineOptions {
  policy: MarketPolicy;
  now?: () => string;
}

export class MarketAuctionEngine {
  private readonly policy: MarketPolicy;
  private readonly now: () => string;
  private readonly scoring = new ScoringEngine();

  constructor(options: MarketAuctionEngineOptions) {
    this.policy = MarketPolicySchema.parse(options.policy);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  run(input: {
    agents: AgentProjection[];
    task: MarketTaskSpecification;
  }): MarketAuctionResult {
    const task = MarketTaskSpecificationSchema.parse(input.task);
    const agents = AgentProjectionSchema.array()
      .parse(input.agents)
      .sort((left, right) => left.agent_id.localeCompare(right.agent_id));
    if (agents.length === 0) throw new MarketNoCandidatesError();
    assertUniqueAgents(agents);

    const createdAt = this.now();
    const scoreBreakdowns: Record<string, ScoreBreakdown> = {};
    const bids = agents.map((agent) => {
      const breakdown = this.scoring.calculateScore(agent, task);
      scoreBreakdowns[agent.agent_id] = breakdown;
      return createBid(agent, task, breakdown, createdAt, this.policy.policy_version);
    });
    const probabilities = softmax(bids, this.policy.tau);
    const winnerIndex = selectIndex(
      probabilities.map((item) => item.probability),
      seededRandom(`${this.policy.seed}\0${task.task_id}`),
    );
    const winnerBid = bids[winnerIndex]!;
    const ledgerId = stableId('ledger', [task.task_id, this.policy.policy_version, this.policy.seed]);
    const ledger = BidLedgerSchema.parse({
      ledger_id: ledgerId,
      task_id: task.task_id,
      policy_version: this.policy.policy_version,
      seed: this.policy.seed,
      bids,
      winner_bid_id: winnerBid.bid_id,
      winner_agent_id: winnerBid.agent_id,
      created_at: createdAt,
      schema_version: SCHEMA_VERSION,
    });
    const audit = MarketAuditSchema.parse({
      audit_id: stableId('market_audit', [ledgerId, winnerBid.bid_id]),
      task_id: task.task_id,
      policy_version: this.policy.policy_version,
      seed: this.policy.seed,
      tau: this.policy.tau,
      selection_mode: 'seeded_softmax',
      ledger_id: ledgerId,
      bid_ids: bids.map((bid) => bid.bid_id),
      winner_bid_id: winnerBid.bid_id,
      winner_agent_id: winnerBid.agent_id,
      probabilities,
      created_at: createdAt,
      schema_version: SCHEMA_VERSION,
    });

    return {
      winner_agent_id: winnerBid.agent_id,
      winner_bid_id: winnerBid.bid_id,
      ledger,
      audit,
      score_breakdowns: scoreBreakdowns,
    };
  }
}

function createBid(
  agent: AgentProjection,
  task: MarketTaskSpecification,
  breakdown: ScoreBreakdown,
  createdAt: string,
  policyVersion: string,
): Bid {
  return BidSchema.parse({
    bid_id: stableId('bid', [task.task_id, agent.agent_id, policyVersion]),
    task_id: task.task_id,
    agent_id: agent.agent_id,
    score_breakdown: breakdown,
    final_score: breakdown.final_score,
    estimated_time_seconds: estimateTime(agent, task),
    strategy_summary: strategy(agent, task),
    created_at: createdAt,
    schema_version: SCHEMA_VERSION,
  });
}

function estimateTime(agent: AgentProjection, task: MarketTaskSpecification): number {
  const baseSeconds = 3600;
  const urgencyFactor = 1 - task.context.urgency;
  const loadFactor = 1 + agent.load_state.active_task_count * 0.2;
  const experienceFactor = 1 - agent.metrics_ref.avg_confidence * 0.2;
  const estimate = baseSeconds * urgencyFactor * loadFactor * experienceFactor;
  return Math.max(1, Number.isFinite(estimate) ? Math.round(estimate) : baseSeconds);
}

function strategy(agent: AgentProjection, task: MarketTaskSpecification): string {
  const parts: string[] = [];
  const skills = agent.skills.slice(0, 2).map((skill) => skill.name);
  const experiences = agent.experiences.slice(0, 2).map((experience) => experience.name);
  if (skills.length > 0) parts.push(`leverage ${skills.join(', ')}`);
  if (experiences.length > 0) parts.push(`apply experience in ${experiences.join(', ')}`);
  if (task.context.exploration_level > 0.7) parts.push('explore new approaches');
  return parts.join(' + ') || 'standard execution';
}

function softmax(bids: readonly Bid[], tau: number) {
  if (bids.length === 1) {
    return [{ bid_id: bids[0]!.bid_id, agent_id: bids[0]!.agent_id, probability: 1 }];
  }
  const logits = bids.map((bid) => bid.final_score / tau);
  const maxLogit = Math.max(...logits);
  const weights = logits.map((logit) => Math.exp(logit - maxLogit));
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('AgentMarket softmax produced an invalid probability total');
  }
  return bids.map((bid, index) => ({
    bid_id: bid.bid_id,
    agent_id: bid.agent_id,
    probability: weights[index]! / total,
  }));
}

function selectIndex(probabilities: readonly number[], random: number): number {
  if (probabilities.length === 1) return 0;
  let cumulative = 0;
  for (let index = 0; index < probabilities.length; index += 1) {
    cumulative += probabilities[index]!;
    if (random < cumulative) return index;
  }
  return probabilities.length - 1;
}

function seededRandom(seed: string): number {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  state += 0x6d2b79f5;
  let value = state;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function stableId(prefix: string, values: readonly string[]): string {
  return `${prefix}_${createHash('sha256').update(values.join('\0')).digest('hex').slice(0, 24)}`;
}

function assertUniqueAgents(agents: readonly AgentProjection[]): void {
  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.agent_id)) {
      throw new Error(`Duplicate market agent_id: ${agent.agent_id}`);
    }
    seen.add(agent.agent_id);
  }
}
