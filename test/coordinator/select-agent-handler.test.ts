import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SelectAgentHandler } from '../../src/coordinator/handlers/select-agent-handler';
import {
  FileMarketEvidenceStore,
  type AgentProjection,
  type AgentProjectionSource,
} from '../../src/market';

const created = new Set<string>();
const FIXED_NOW = '2026-07-18T00:00:00.000Z';

afterEach(async () => {
  await Promise.all([...created].map((entry) => fs.rm(entry, { recursive: true, force: true })));
  created.clear();
});

describe('SelectAgentHandler', () => {
  it('selects from B projections and persists complete ledger and audit evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-market-evidence-'));
    created.add(root);
    const projectionSource = new CapturingProjectionSource(candidates());
    const handler = new SelectAgentHandler({
      projectionSource,
      evidenceStore: new FileMarketEvidenceStore({ root }),
      now: () => FIXED_NOW,
    });

    const result = await handler.execute({
      task_id: 'task_market_handler',
      task_description: 'Implement and test a TypeScript backend service.',
      bootstrap_agent_ids: ['role_ts_engineer'],
      seed: 'run_market_handler',
    });

    expect(projectionSource.input).toMatchObject({
      task: {
        task_id: 'task_market_handler',
        spec: 'Implement and test a TypeScript backend service.',
      },
      options: { bootstrap_agent_ids: ['role_ts_engineer'] },
    });
    expect(result).toMatchObject({
      winner_agent_id: expect.any(String),
      ledger_ref: expect.stringMatching(/^file:/),
      audit_ref: expect.stringMatching(/^file:/),
    });
    const ledger = JSON.parse(await fs.readFile(fileURLToPath(result.ledger_ref), 'utf8'));
    const audit = JSON.parse(await fs.readFile(fileURLToPath(result.audit_ref), 'utf8'));
    expect(ledger).toMatchObject({
      seed: 'run_market_handler',
      policy_version: 'market-v0',
      winner_agent_id: result.winner_agent_id,
      bids: [{ agent_id: 'agent_alpha' }, { agent_id: 'agent_beta' }],
    });
    expect(audit).toMatchObject({
      seed: 'run_market_handler',
      ledger_id: ledger.ledger_id,
      winner_agent_id: result.winner_agent_id,
      bid_ids: ledger.bids.map((bid: { bid_id: string }) => bid.bid_id),
    });
    expect(result.market_task.requirement_profile).toEqual({
      persona_keywords: ['implement', 'and', 'test', 'a', 'typescript', 'backend', 'service'],
      preferred_skill_tags: ['implement', 'and', 'test', 'a', 'typescript', 'backend', 'service'],
      preferred_experience_tags: [
        'implement',
        'and',
        'test',
        'a',
        'typescript',
        'backend',
        'service',
      ],
    });
  });

  it('does not persist partial evidence when B has no eligible candidates', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-market-empty-'));
    created.add(root);
    const handler = new SelectAgentHandler({
      projectionSource: new CapturingProjectionSource([]),
      evidenceStore: new FileMarketEvidenceStore({ root }),
      now: () => FIXED_NOW,
    });

    await expect(
      handler.execute({
        task_id: 'task_market_empty',
        task_description: 'Implement a backend.',
        bootstrap_agent_ids: ['role_ts_engineer'],
        seed: 'run_market_empty',
      }),
    ).rejects.toMatchObject({ code: 'MARKET_NO_CANDIDATES' });
    expect(await fs.readdir(root)).toEqual([]);
  });
});

class CapturingProjectionSource implements AgentProjectionSource {
  input?: {
    task: { task_id?: string; spec: string };
    options?: { bootstrap_agent_ids?: string[] };
  };

  constructor(private readonly projections: AgentProjection[]) {}

  async projectCandidates(
    task: { task_id?: string; spec: string },
    options?: { bootstrap_agent_ids?: string[] },
  ): Promise<AgentProjection[]> {
    this.input = { task, ...(options ? { options } : {}) };
    return this.projections;
  }
}

function candidates(): AgentProjection[] {
  return [candidate('agent_alpha', ['typescript', 'backend'], 0.9), candidate('agent_beta', ['frontend'], 0.6)];
}

function candidate(agentId: string, keywords: string[], confidence: number): AgentProjection {
  return {
    agent_id: agentId,
    persona_ref: `persona://${agentId}/v1`,
    persona_keywords: keywords,
    skills: [{ name: 'TypeScript delivery', tags: keywords }],
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
    load_state: { active_task_count: 0, days_since_last_task: 1 },
  };
}
