import type { AgentProjection } from '../market';
import type {
  SelectAgentResult,
} from '../coordinator/handlers/select-agent-handler';

export type MarketSelectionMode = 'auction' | 'fixed';
export type MarketSelectionScope = 'primary' | 'council_seat';

export interface MarketEventContext {
  selection_scope: MarketSelectionScope;
  selection_mode: MarketSelectionMode;
  seat?: 'proposer' | 'reviewer' | 'synthesizer';
  seat_index?: number;
}

export function marketAuctionStartedPayload(input: {
  context: MarketEventContext;
  auction_id: string;
  task_description: string;
  requirement_profile: Record<string, unknown>;
  candidates: readonly AgentProjection[];
}): Record<string, unknown> {
  return {
    auction_id: input.auction_id,
    ...input.context,
    task_description: input.task_description,
    requirement_profile: input.requirement_profile,
    candidates: input.candidates.map(projectCandidate),
  };
}

export function marketAuctionCompletedPayload(input: {
  context: MarketEventContext;
  result: SelectAgentResult;
}): Record<string, unknown> {
  const auditProbabilities = Array.isArray(input.result.audit.probabilities)
    ? input.result.audit.probabilities
    : [];
  const probabilities = new Map(
    auditProbabilities.map((item) => [item.bid_id, item.probability]),
  );
  const auctionId =
    input.result.auction_id || input.result.audit.audit_id || input.result.ledger.ledger_id;
  return {
    auction_id: auctionId,
    ...input.context,
    policy_version: input.result.ledger.policy_version,
    seed: input.result.ledger.seed,
    tau: input.result.audit.tau,
    bids: input.result.ledger.bids.map((bid) => ({
      bid_id: bid.bid_id,
      role_id: bid.agent_id,
      final_score: bid.final_score,
      score_breakdown: bid.score_breakdown,
      probability: probabilities.get(bid.bid_id) ?? 0,
      estimated_time_seconds: bid.estimated_time_seconds,
      strategy_summary: bid.strategy_summary,
    })),
    winner_role_id: input.result.winner_agent_id,
    winner_bid_id: input.result.winner_bid_id,
    winner_probability:
      auditProbabilities.find(
        (item) => item.bid_id === input.result.winner_bid_id,
      )?.probability ?? 0,
    ledger_ref: input.result.ledger_ref,
    audit_ref: input.result.audit_ref,
  };
}

function projectCandidate(candidate: AgentProjection): Record<string, unknown> {
  return {
    role_id: candidate.agent_id,
    persona_ref: candidate.persona_ref,
    persona_keywords: candidate.persona_keywords.slice(0, 12),
    skills: candidate.skills.slice(0, 12).map((skill) => ({
      name: skill.name,
      tags: skill.tags.slice(0, 8),
    })),
    experiences: candidate.experiences.slice(0, 8).map((experience) => ({
      name: experience.name,
      type: experience.type,
      confidence: experience.confidence,
      tags: experience.tags.slice(0, 8),
    })),
    metrics: { ...candidate.metrics_ref },
    load: { ...candidate.load_state },
  };
}
