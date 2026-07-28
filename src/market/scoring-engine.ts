import type { AgentProjection, MarketTaskSpecification, ScoreBreakdown } from './models';
import { ScoreBreakdownSchema } from './models';

export class ScoringEngine {
  calculateScore(agent: AgentProjection, task: MarketTaskSpecification): ScoreBreakdown {
    const relevanceBreakdown = {
      persona_match: keywordCoverage(
        task.requirement_profile.persona_keywords,
        agent.persona_keywords,
      ),
      skill_match: keywordCoverage(
        task.requirement_profile.preferred_skill_tags,
        agent.skills.flatMap((skill) => [skill.name, ...skill.tags]),
      ),
      experience_match: experienceMatch(agent, task),
    };
    const relevance = clamp(
      0.4 * relevanceBreakdown.persona_match +
        0.3 * relevanceBreakdown.skill_match +
        0.3 * relevanceBreakdown.experience_match,
    );

    const qualityBreakdown = {
      success_rate: successRate(agent),
      avg_confidence: clamp(agent.metrics_ref.avg_confidence),
      experience_density: density(
        agent.metrics_ref.experience_count,
        agent.metrics_ref.total_tasks,
      ),
      skill_density: density(
        agent.metrics_ref.skill_count,
        agent.metrics_ref.experience_count,
      ),
    };
    const quality = clamp(
      0.5 * qualityBreakdown.success_rate +
        0.3 * qualityBreakdown.avg_confidence +
        0.1 * qualityBreakdown.experience_density +
        0.1 * qualityBreakdown.skill_density,
    );
    const capacity = clamp(1 - Math.min(1, agent.load_state.active_task_count / 3));
    const freshness = clamp(1 / (1 + agent.load_state.days_since_last_task / 14));
    const bonus = agent.metrics_ref.total_tasks < 5 ? 0.15 : 0;
    const finalScore = clamp(
      0.4 * relevance + 0.3 * quality + 0.15 * capacity + 0.15 * freshness + bonus,
    );

    return ScoreBreakdownSchema.parse({
      relevance,
      relevance_breakdown: relevanceBreakdown,
      quality,
      quality_breakdown: qualityBreakdown,
      capacity,
      freshness,
      bonus,
      final_score: finalScore,
    });
  }
}

function keywordCoverage(required: readonly string[], offered: readonly string[]): number {
  if (required.length === 0) return 0.5;
  const normalizedOffered = new Set(offered.flatMap(tokenize));
  const matched = required.filter((value) =>
    tokenize(value).some((token) => normalizedOffered.has(token)),
  ).length;
  return clamp(matched / required.length);
}

function experienceMatch(agent: AgentProjection, task: MarketTaskSpecification): number {
  const positive = agent.experiences.filter((experience) => experience.type === 'positive');
  if (positive.length === 0) return agent.experiences.length === 0 ? 0.5 : 0;
  const required = task.requirement_profile.preferred_experience_tags;
  if (required.length === 0) {
    return clamp(
      positive.reduce((sum, experience) => sum + experience.confidence, 0) / positive.length,
    );
  }
  const matches = required.map((requirement) => {
    const requirementTokens = tokenize(requirement);
    return positive.reduce((best, experience) => {
      const offered = new Set([experience.name, ...experience.tags].flatMap(tokenize));
      return requirementTokens.some((token) => offered.has(token))
        ? Math.max(best, experience.confidence)
        : best;
    }, 0);
  });
  return clamp(matches.reduce((sum, value) => sum + value, 0) / matches.length);
}

function successRate(agent: AgentProjection): number {
  const { total_tasks, tasks_completed, tasks_succeeded } = agent.metrics_ref;
  if (total_tasks < 3 || tasks_completed === 0) return 0.5;
  return clamp(tasks_succeeded / tasks_completed);
}

function density(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return clamp(numerator / denominator);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
