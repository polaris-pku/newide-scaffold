import { z } from 'zod';
import { SCHEMA_VERSION } from '../core';

const score = z.number().min(0).max(1);

export const AgentProjectionSchema = z.object({
  agent_id: z.string().min(1),
  persona_ref: z.string().min(1),
  persona_keywords: z.array(z.string()),
  skills: z.array(
    z.object({
      name: z.string().min(1),
      tags: z.array(z.string()),
    }),
  ),
  experiences: z.array(
    z.object({
      name: z.string().min(1),
      type: z.enum(['positive', 'negative']),
      confidence: score,
      tags: z.array(z.string()),
    }),
  ),
  metrics_ref: z.object({
    total_tasks: z.number().int().nonnegative(),
    tasks_completed: z.number().int().nonnegative(),
    tasks_succeeded: z.number().int().nonnegative(),
    skill_count: z.number().int().nonnegative(),
    experience_count: z.number().int().nonnegative(),
    avg_confidence: score,
  }),
  load_state: z.object({
    active_task_count: z.number().int().nonnegative(),
    days_since_last_task: z.number().nonnegative(),
  }),
});

export type AgentProjection = z.infer<typeof AgentProjectionSchema>;

export const MarketTaskSpecificationSchema = z.object({
  task_id: z.string().min(1),
  task_description: z.string().min(1),
  requirement_profile: z.object({
    persona_keywords: z.array(z.string()),
    preferred_skill_tags: z.array(z.string()),
    preferred_experience_tags: z.array(z.string()),
  }),
  context: z.object({
    urgency: score,
    exploration_level: score,
  }),
});

export type MarketTaskSpecification = z.infer<typeof MarketTaskSpecificationSchema>;

export const MarketPolicySchema = z.object({
  policy_version: z.string().min(1),
  seed: z.string().min(1),
  tau: z.number().min(0.3).max(1),
});

export type MarketPolicy = z.infer<typeof MarketPolicySchema>;

export const ScoreBreakdownSchema = z.object({
  relevance: score,
  relevance_breakdown: z.object({
    persona_match: score,
    skill_match: score,
    experience_match: score,
  }),
  quality: score,
  quality_breakdown: z.object({
    success_rate: score,
    avg_confidence: score,
    experience_density: score,
    skill_density: score,
  }),
  capacity: score,
  freshness: score,
  bonus: z.number().min(0).max(0.15),
  final_score: score,
});

export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const BidSchema = z.object({
  bid_id: z.string().min(1),
  task_id: z.string().min(1),
  agent_id: z.string().min(1),
  score_breakdown: ScoreBreakdownSchema,
  final_score: score,
  estimated_time_seconds: z.number().int().positive(),
  strategy_summary: z.string().min(1),
  created_at: z.iso.datetime(),
  schema_version: z.literal(SCHEMA_VERSION),
});

export type Bid = z.infer<typeof BidSchema>;

export const BidLedgerSchema = z.object({
  ledger_id: z.string().min(1),
  task_id: z.string().min(1),
  policy_version: z.string().min(1),
  seed: z.string().min(1),
  bids: z.array(BidSchema).min(1),
  winner_bid_id: z.string().min(1),
  winner_agent_id: z.string().min(1),
  created_at: z.iso.datetime(),
  schema_version: z.literal(SCHEMA_VERSION),
});

export type BidLedger = z.infer<typeof BidLedgerSchema>;

export const MarketAuditSchema = z.object({
  audit_id: z.string().min(1),
  task_id: z.string().min(1),
  policy_version: z.string().min(1),
  seed: z.string().min(1),
  tau: z.number().min(0.3).max(1),
  selection_mode: z.literal('seeded_softmax'),
  ledger_id: z.string().min(1),
  bid_ids: z.array(z.string().min(1)).min(1),
  winner_bid_id: z.string().min(1),
  winner_agent_id: z.string().min(1),
  probabilities: z.array(
    z.object({
      bid_id: z.string().min(1),
      agent_id: z.string().min(1),
      probability: score,
    }),
  ),
  created_at: z.iso.datetime(),
  schema_version: z.literal(SCHEMA_VERSION),
});

export type MarketAudit = z.infer<typeof MarketAuditSchema>;

export interface MarketAuctionResult {
  winner_agent_id: string;
  winner_bid_id: string;
  ledger: BidLedger;
  audit: MarketAudit;
  score_breakdowns: Record<string, ScoreBreakdown>;
}
