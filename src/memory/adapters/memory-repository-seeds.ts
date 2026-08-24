/**
 * MemoryRepository 共享种子数据与资格过滤
 *
 * InMemoryRepository 与 PgMemoryRepository 共用，保证初始化与检索过滤行为一致。
 */
import { nowTimestamp } from '../../core';
import type {
  AgentHandle,
  AgentMetrics,
  CreateAgentSpec,
  ExperienceRecord,
  PersonaDef,
  SkillRecord,
} from '../schemas';

export const DEFAULT_MIN_EXPERIENCE_CONFIDENCE = 0.2;
export const DEFAULT_MIN_SIMILARITY = 0.5;

export function createSeedPersona(role_id: string, persona_seed?: string): PersonaDef {
  const generated_at = nowTimestamp();
  return {
    role_id,
    version: 1,
    summary: persona_seed ?? `Seed persona for ${role_id}`,
    skills_overview: 'No skills yet.',
    experience_coverage: 'No experiences yet.',
    recent_performance: 'Awaiting first task.',
    notes: 'Initialized by MemoryRepository.',
    generated_at,
  };
}

export function createSeedMetrics(role_id: string): AgentMetrics {
  return {
    role_id,
    total_tasks: 0,
    tasks_bid: 0,
    tasks_won: 0,
    tasks_completed: 0,
    tasks_succeeded: 0,
    tasks_partial: 0,
    tasks_failed: 0,
    skill_count: 0,
    experience_count: 0,
    imported_skill_count: 0,
    promoted_skill_count: 0,
    avg_confidence: 0,
    token_cost_total: 0,
    persona_version: 1,
  };
}

export function createSeedHandle(
  spec: CreateAgentSpec,
  persona: PersonaDef,
  metrics: AgentMetrics,
): AgentHandle {
  return {
    role_id: spec.role_id,
    name: spec.name,
    persona,
    skill_count: 0,
    experience_count: 0,
    status: 'created',
    created_at: nowTimestamp(),
    tags: spec.tags,
    owned_skills: [],
    owned_exps: [],
    metric: metrics,
  };
}

export function isEligibleSkill(skill: SkillRecord): boolean {
  return skill.review_status === 'approved' && skill.market_status !== 'superseded';
}

/**
 * 技能市场资格（Spec §3.2 / §7.7）。
 *
 * 市场池（__market__）内可被检索/引入的技能 = 已审核通过 且 未被 superseded 淘汰。
 * 注意：retired_unique（稀缺遗产）同样在市场中，且应获得更高推荐优先级。
 */
export function isMarketEligibleSkill(skill: SkillRecord): boolean {
  return skill.review_status === 'approved' && skill.market_status !== 'superseded';
}

export function isEligibleExperience(
  experience: ExperienceRecord,
  min_confidence: number,
): boolean {
  return (
    experience.type === 'positive' &&
    !experience.promoted_to &&
    experience.confidence >= min_confidence
  );
}
