import {
  MarketAuctionEngine,
  type AgentProjectionSource,
  type BidLedger,
  type MarketAudit,
  type MarketEvidenceStore,
  type MarketTaskSpecification,
} from '../../market';

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
  winner_agent_id: string;
  winner_bid_id: string;
  ledger_ref: string;
  audit_ref: string;
  ledger: BidLedger;
  audit: MarketAudit;
  market_task: MarketTaskSpecification;
}

export class SelectAgentHandler {
  constructor(private readonly options: SelectAgentHandlerOptions) {}

  async execute(input: SelectAgentInput): Promise<SelectAgentResult> {
    const marketTask = buildMarketTask(input.task_id, input.task_description);
    const candidates = await this.options.projectionSource.projectCandidates(
      { task_id: input.task_id, spec: input.task_description },
      { bootstrap_agent_ids: input.bootstrap_agent_ids },
    );
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
