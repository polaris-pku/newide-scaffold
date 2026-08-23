import {
  MarketAuctionEngine,
  type AgentProjection,
  type AgentProjectionSource,
  type BidLedger,
  type MarketAudit,
  type MarketEvidenceStore,
  type MarketTaskSpecification,
} from '../../market';
import { createId } from '../../core';

export interface SelectAgentHandlerOptions {
  projectionSource: AgentProjectionSource;
  evidenceStore: MarketEvidenceStore;
  policyVersion?: string;
  tau?: number;
  now?: () => string;
}

export interface SelectAgentInput {
  task_id: string;
  task_description: string;
  bootstrap_agent_ids: string[];
  seed: string;
}

export interface SelectAgentResult {
  auction_id: string;
  winner_agent_id: string;
  winner_bid_id: string;
  ledger_ref: string;
  audit_ref: string;
  ledger: BidLedger;
  audit: MarketAudit;
  market_task: MarketTaskSpecification;
}

export interface SelectAgentExecutionOptions {
  onCandidatesCollected?: (input: {
    auction_id: string;
    market_task: MarketTaskSpecification;
    candidates: readonly AgentProjection[];
  }) => void | Promise<void>;
}

export class SelectAgentHandler {
  constructor(private readonly options: SelectAgentHandlerOptions) {}

  async execute(
    input: SelectAgentInput,
    executionOptions: SelectAgentExecutionOptions = {},
  ): Promise<SelectAgentResult> {
    const auctionId = createId('market_auction');
    const marketTask = buildMarketTask(input.task_id, input.task_description);
    const candidates = await this.options.projectionSource.projectCandidates(
      { task_id: input.task_id, spec: input.task_description },
      { bootstrap_agent_ids: input.bootstrap_agent_ids },
    );
    await executionOptions.onCandidatesCollected?.({
      auction_id: auctionId,
      market_task: marketTask,
      candidates,
    });
    const auction = new MarketAuctionEngine({
      policy: {
        policy_version: this.options.policyVersion ?? 'market-v0',
        seed: input.seed,
        tau: this.options.tau ?? 0.5,
      },
      ...(this.options.now ? { now: this.options.now } : {}),
    }).run({ agents: candidates, task: marketTask });
    const refs = await this.options.evidenceStore.persist({
      ledger: auction.ledger,
      audit: auction.audit,
    });
    return {
      auction_id: auctionId,
      winner_agent_id: auction.winner_agent_id,
      winner_bid_id: auction.winner_bid_id,
      ...refs,
      ledger: auction.ledger,
      audit: auction.audit,
      market_task: marketTask,
    };
  }
}

function buildMarketTask(taskId: string, taskDescription: string): MarketTaskSpecification {
  const keywords = uniqueKeywords(taskDescription);
  return {
    task_id: taskId,
    task_description: taskDescription,
    requirement_profile: {
      persona_keywords: keywords,
      preferred_skill_tags: keywords,
      preferred_experience_tags: keywords,
    },
    context: { urgency: 0.5, exploration_level: 0.3 },
  };
}

function uniqueKeywords(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    ),
  ];
}
