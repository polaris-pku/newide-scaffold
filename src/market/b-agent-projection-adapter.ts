import type { AgentTaskRequest } from '../memory/agent-types';
import type {
  AgentBoardAgentView,
  AgentBoardQuery,
  ExperienceView,
  SkillView,
} from '../memory/ports/agent-board-query';
import type { AgentCompetitionQuery } from '../memory/ports/agent-competition-query';
import { AgentProjectionSchema, type AgentProjection } from './models';

export interface AgentProjectionSource {
  projectCandidates(
    task: AgentTaskRequest,
    options?: AgentProjectionOptions,
  ): Promise<AgentProjection[]>;
}

export interface AgentProjectionOptions {
  bootstrap_agent_ids?: string[];
}

export interface BAgentProjectionAdapterOptions {
  competitionQuery: AgentCompetitionQuery;
  boardQuery: AgentBoardQuery;
  ensureAgent?: (agentId: string) => Promise<void>;
  allowedAgentIds?: readonly string[];
  now?: () => number;
}

export class BAgentProjectionAdapter implements AgentProjectionSource {
  private readonly now: () => number;
  private readonly allowedAgentIds: ReadonlySet<string> | undefined;

  constructor(private readonly options: BAgentProjectionAdapterOptions) {
    this.now = options.now ?? Date.now;
    this.allowedAgentIds = options.allowedAgentIds
      ? new Set(options.allowedAgentIds)
      : undefined;
  }

  async projectCandidates(
    task: AgentTaskRequest,
    projectionOptions?: AgentProjectionOptions,
  ): Promise<AgentProjection[]> {
    if (this.allowedAgentIds?.size === 0) return [];

    const bootstrapAgentIds = [...new Set(projectionOptions?.bootstrap_agent_ids ?? [])]
      .filter((agentId) => this.isAllowed(agentId))
      .sort();
    if (bootstrapAgentIds.length > 0 && !this.options.ensureAgent) {
      throw new Error('B Agent ensure hook is required for bootstrap candidates');
    }
    for (const agentId of bootstrapAgentIds) {
      await this.options.ensureAgent!(agentId);
    }
    const batch = await this.options.competitionQuery.collectCompetitionClaims(task);
    const eligible = batch.claims
      .filter(
        (claim) =>
          this.isAllowed(claim.role_id) &&
          claim.decision === 'participate' &&
          claim.availability.busy !== true,
      )
      .sort((left, right) => left.role_id.localeCompare(right.role_id));

    return Promise.all(
      eligible.map(async (claim) => {
        const [agent, skills, experiences] = await Promise.all([
          this.options.boardQuery.getAgent(claim.role_id),
          this.options.boardQuery.listSkills(claim.role_id),
          this.options.boardQuery.listExperiences(claim.role_id),
        ]);
        return toProjection(agent, skills, experiences, this.now());
      }),
    );
  }

  private isAllowed(agentId: string): boolean {
    return this.allowedAgentIds?.has(agentId) ?? true;
  }
}

function toProjection(
  agent: AgentBoardAgentView,
  skills: SkillView[],
  experiences: ExperienceView[],
  now: number,
): AgentProjection {
  return AgentProjectionSchema.parse({
    agent_id: agent.role_id,
    persona_ref: `persona://${agent.role_id}/v${agent.persona.version}`,
    persona_keywords: uniqueKeywords([
      ...(agent.tags ?? []),
      agent.persona.summary,
      agent.persona.skills_overview,
      agent.persona.experience_coverage,
      agent.persona.recent_performance,
    ]),
    skills: skills.map((skill) => ({
      name: skill.description,
      tags: skill.tags,
    })),
    experiences: experiences.map((experience) => ({
      name: experience.description,
      type: experienceType(experience),
      confidence: experience.confidence,
      tags: experience.tags,
    })),
    metrics_ref: {
      total_tasks: agent.metrics.raw.total_tasks,
      tasks_completed: agent.metrics.raw.tasks_completed,
      tasks_succeeded: agent.metrics.raw.tasks_succeeded,
      skill_count: agent.metrics.raw.skill_count,
      experience_count: agent.metrics.raw.experience_count,
      avg_confidence: agent.metrics.raw.avg_confidence,
    },
    load_state: {
      active_task_count: 0,
      days_since_last_task: daysSince(agent.metrics.raw.last_task_at, now),
    },
  });
}

function experienceType(experience: ExperienceView): 'positive' | 'negative' {
  if (experience.type === 'positive' || experience.type === 'negative') return experience.type;
  throw new Error(`Unsupported B experience type: ${experience.type}`);
}

function daysSince(lastTaskAt: string | undefined, now: number): number {
  if (!lastTaskAt) return 30;
  const timestamp = Date.parse(lastTaskAt);
  if (!Number.isFinite(timestamp)) return 30;
  return Math.max(0, (now - timestamp) / (24 * 60 * 60 * 1000));
}

function uniqueKeywords(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u))
        .filter(Boolean),
    ),
  ];
}
