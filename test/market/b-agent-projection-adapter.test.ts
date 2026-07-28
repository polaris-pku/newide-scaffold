import { describe, expect, it, vi } from 'vitest';
import type {
  AgentBoardAgentView,
  AgentBoardListItem,
  AgentBoardQuery,
  ExperienceView,
  SkillView,
} from '../../src/memory/ports/agent-board-query';
import type { AgentCompetitionQuery } from '../../src/memory/ports/agent-competition-query';
import { BAgentProjectionAdapter } from '../../src/market';

const NOW = Date.parse('2026-07-18T00:00:00.000Z');

describe('BAgentProjectionAdapter', () => {
  it('maps participating B agents through the public board query', async () => {
    const competitionQuery = competition([
      claim('agent_beta'),
      claim('agent_alpha'),
      claim('agent_busy', true),
    ]);
    const boardQuery = board();
    const ensureAgent = vi.fn(async () => undefined);
    const adapter = new BAgentProjectionAdapter({
      competitionQuery,
      boardQuery,
      ensureAgent,
      now: () => NOW,
    });

    const projections = await adapter.projectCandidates(
      {
        task_id: 'task_projection',
        spec: 'Implement a TypeScript backend.',
      },
      { bootstrap_agent_ids: ['agent_alpha', 'agent_beta'] },
    );

    expect(ensureAgent).toHaveBeenNthCalledWith(1, 'agent_alpha');
    expect(ensureAgent).toHaveBeenNthCalledWith(2, 'agent_beta');
    expect(projections.map((projection) => projection.agent_id)).toEqual([
      'agent_alpha',
      'agent_beta',
    ]);
    expect(projections[0]).toMatchObject({
      agent_id: 'agent_alpha',
      persona_ref: 'persona://agent_alpha/v2',
      persona_keywords: expect.arrayContaining(['backend', 'typescript', 'reliability']),
      skills: [{ name: 'TypeScript delivery', tags: ['typescript', 'testing'] }],
      experiences: [
        {
          name: 'Backend incident recovery',
          type: 'positive',
          confidence: 0.8,
          tags: ['backend', 'reliability'],
        },
      ],
      metrics_ref: {
        total_tasks: 10,
        tasks_completed: 8,
        tasks_succeeded: 7,
        skill_count: 1,
        experience_count: 1,
        avg_confidence: 0.8,
      },
      load_state: { active_task_count: 0, days_since_last_task: 1 },
    });
    expect(boardQuery.getAgent).not.toHaveBeenCalledWith('agent_busy');
  });

  it('returns no candidates when every participant is currently busy', async () => {
    const adapter = new BAgentProjectionAdapter({
      competitionQuery: competition([claim('agent_busy', true)]),
      boardQuery: board(),
      now: () => NOW,
    });

    await expect(
      adapter.projectCandidates({ task_id: 'task_busy', spec: 'Do work.' }),
    ).resolves.toEqual([]);
  });

  it('projects and bootstraps only agents in the explicit candidate allowlist', async () => {
    const competitionQuery = competition([
      claim('role_ts_engineer'),
      claim('proposer_a'),
      claim('reviewer'),
      claim('unknown_role'),
    ]);
    const boardQuery = board();
    const ensureAgent = vi.fn(async () => undefined);
    const adapter = new BAgentProjectionAdapter({
      competitionQuery,
      boardQuery,
      ensureAgent,
      allowedAgentIds: ['role_ts_engineer'],
      now: () => NOW,
    });

    const projections = await adapter.projectCandidates(
      { task_id: 'task_allowlist', spec: 'Implement a TypeScript backend.' },
      { bootstrap_agent_ids: ['reviewer', 'role_ts_engineer', 'unknown_role'] },
    );

    expect(ensureAgent).toHaveBeenCalledTimes(1);
    expect(ensureAgent).toHaveBeenCalledWith('role_ts_engineer');
    expect(projections.map((projection) => projection.agent_id)).toEqual([
      'role_ts_engineer',
    ]);
    expect(boardQuery.getAgent).not.toHaveBeenCalledWith('proposer_a');
    expect(boardQuery.getAgent).not.toHaveBeenCalledWith('reviewer');
    expect(boardQuery.getAgent).not.toHaveBeenCalledWith('unknown_role');
  });

  it('short-circuits an explicitly empty candidate allowlist', async () => {
    const collectCompetitionClaims = vi.fn();
    const boardQuery = board();
    const ensureAgent = vi.fn(async () => undefined);
    const adapter = new BAgentProjectionAdapter({
      competitionQuery: { collectCompetitionClaims },
      boardQuery,
      ensureAgent,
      allowedAgentIds: [],
      now: () => NOW,
    });

    await expect(
      adapter.projectCandidates(
        { task_id: 'task_empty_allowlist', spec: 'Do work.' },
        { bootstrap_agent_ids: ['role_ts_engineer'] },
      ),
    ).resolves.toEqual([]);

    expect(ensureAgent).not.toHaveBeenCalled();
    expect(collectCompetitionClaims).not.toHaveBeenCalled();
    expect(boardQuery.getAgent).not.toHaveBeenCalled();
    expect(boardQuery.listSkills).not.toHaveBeenCalled();
    expect(boardQuery.listExperiences).not.toHaveBeenCalled();
  });

  it('requires the B ensure hook when bootstrap candidates are requested', async () => {
    const adapter = new BAgentProjectionAdapter({
      competitionQuery: competition([]),
      boardQuery: board(),
      now: () => NOW,
    });

    await expect(
      adapter.projectCandidates(
        { task_id: 'task_bootstrap', spec: 'Do work.' },
        { bootstrap_agent_ids: ['role_ts_engineer'] },
      ),
    ).rejects.toThrow('B Agent ensure hook is required for bootstrap candidates');
  });

  it('rejects a B experience type that cannot satisfy the Market contract', async () => {
    const boardQuery = board();
    boardQuery.listExperiences = vi.fn(async (roleId) => [
      { ...experience(roleId), type: 'neutral' },
    ]);
    const adapter = new BAgentProjectionAdapter({
      competitionQuery: competition([claim('agent_alpha')]),
      boardQuery,
      now: () => NOW,
    });

    await expect(
      adapter.projectCandidates({ task_id: 'task_invalid', spec: 'Do work.' }),
    ).rejects.toThrow('Unsupported B experience type: neutral');
  });
});

function competition(
  claims: Array<ReturnType<typeof claim>>,
): AgentCompetitionQuery {
  return {
    async collectCompetitionClaims(task) {
      return {
        correlation_id: 'corr_projection',
        task_id: task.task_id ?? 'task_generated',
        claims,
        summary: {
          total: claims.length,
          participated: claims.length,
          busy_participated: claims.filter((item) => item.availability.busy).length,
          declined: 0,
          unavailable: 0,
          timed_out: 0,
          errored: 0,
        },
        started_at: '2026-07-18T00:00:00.000Z',
        completed_at: '2026-07-18T00:00:01.000Z',
      };
    },
  };
}

function claim(roleId: string, busy = false) {
  return {
    role_id: roleId,
    decision: 'participate' as const,
    confidence: 0.8,
    rationale: 'relevant',
    availability: {
      agent_status: 'idle' as const,
      loop_state: 'idle' as const,
      ...(busy ? { busy: true } : {}),
    },
    generated_at: '2026-07-18T00:00:00.000Z',
  };
}

function board(): AgentBoardQuery & {
  getAgent: ReturnType<typeof vi.fn>;
} {
  const query = {
    listAgents: vi.fn(async (): Promise<AgentBoardListItem[]> => []),
    getAgent: vi.fn(async (roleId: string): Promise<AgentBoardAgentView> => agentView(roleId)),
    listSkills: vi.fn(async (roleId: string): Promise<SkillView[]> => [skill(roleId)]),
    listExperiences: vi.fn(async (roleId: string): Promise<ExperienceView[]> => [
      experience(roleId),
    ]),
  };
  return query;
}

function agentView(roleId: string): AgentBoardAgentView {
  return {
    role_id: roleId,
    name: roleId,
    status: 'idle',
    tags: ['backend'],
    skill_count: 1,
    experience_count: 1,
    persona: {
      role_id: roleId,
      version: 2,
      summary: 'TypeScript backend engineer',
      skills_overview: 'Testing and reliability',
      experience_coverage: 'Backend services',
      recent_performance: 'Stable delivery',
      notes: '',
      generated_at: '2026-07-17T00:00:00.000Z',
    },
    metrics: {
      raw: {
        role_id: roleId,
        total_tasks: 10,
        tasks_bid: 4,
        tasks_won: 3,
        tasks_completed: 8,
        tasks_succeeded: 7,
        tasks_partial: 1,
        tasks_failed: 0,
        skill_count: 1,
        experience_count: 1,
        imported_skill_count: 0,
        promoted_skill_count: 1,
        avg_confidence: 0.8,
        token_cost_total: 100,
        first_task_at: '2026-07-01T00:00:00.000Z',
        last_task_at: '2026-07-17T00:00:00.000Z',
        last_won_at: '2026-07-16T00:00:00.000Z',
        persona_version: 2,
      },
      derived: {
        success_rate: 0.875,
        bid_win_rate: 0.75,
        experience_density: 0.1,
        skill_density: 1,
        activity_score: 0.93,
      },
    },
    created_at: '2026-07-01T00:00:00.000Z',
  };
}

function skill(roleId: string): SkillView {
  return {
    id: `skill_${roleId}`,
    description: 'TypeScript delivery',
    content: 'Implement and test TypeScript services.',
    version: '1.0.0',
    review_status: 'approved',
    sub_skills: undefined,
    tags: ['typescript', 'testing'],
    promoted_from: undefined,
    promoted_at: '2026-07-10T00:00:00.000Z',
    agent_id: roleId,
    imported_by: undefined,
    linked_negative_exp: undefined,
    market_status: 'active',
    reviewed_by: undefined,
    reviewed_at: undefined,
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  };
}

function experience(roleId: string): ExperienceView {
  return {
    id: `experience_${roleId}`,
    description: 'Backend incident recovery',
    content: 'Recovered a backend service safely.',
    confidence: 0.8,
    tags: ['backend', 'reliability'],
    agent_id: roleId,
    promoted_to: undefined,
    assumptions: undefined,
    confidence_history: [],
    referenced_count: 2,
    last_referenced_at: '2026-07-17T00:00:00.000Z',
    source_task_id: 'task_source',
    source_driver: 'claude',
    source_user_rating: 'resolved',
    type: 'positive',
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
  };
}
