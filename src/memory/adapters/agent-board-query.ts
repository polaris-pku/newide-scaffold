/**
 * AgentBoardQuery 适配器 — MemoryRepository 上的只读 Facade
 *
 * 委托 MemoryRepository 读取实体，组装对外 DTO（剔除 embedding、
 * linked_negative_exp），并在 getAgent 内计算派生指标。
 * 实现 Port 见 ports/agent-board-query.ts。
 */
import type { ExperienceRecord, SkillRecord } from '../schemas';
import { calculateDerivedMetrics } from '../schemas';
import type { MemoryRepository } from '../ports/memory-repository';
import type {
  AgentBoardAgentView,
  AgentBoardListItem,
  AgentBoardQuery,
  ExperienceView,
  SkillView,
} from '../ports/agent-board-query';

export function toSkillView(s: SkillRecord): SkillView {
  return {
    id: s.id,
    description: s.description,
    content: s.content,
    version: s.version,
    review_status: s.review_status,
    sub_skills: s.sub_skills,
    tags: s.tags,
    promoted_from: s.promoted_from,
    promoted_at: s.promoted_at,
    agent_id: s.agent_id,
    origin_agent_id: s.origin_agent_id,
    imported_by: s.imported_by,
    linked_negative_exp: s.linked_negative_exp,
    market_status: s.market_status,
    reviewed_by: s.reviewed_by,
    reviewed_at: s.reviewed_at,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

export function toExperienceView(e: ExperienceRecord): ExperienceView {
  return {
    id: e.id,
    description: e.description,
    content: e.content,
    confidence: e.confidence,
    tags: e.tags,
    agent_id: e.agent_id,
    promoted_to: e.promoted_to,
    assumptions: e.assumptions,
    confidence_history: e.confidence_history,
    referenced_count: e.referenced_count,
    last_referenced_at: e.last_referenced_at,
    source_task_id: e.source_task_id,
    source_driver: e.source_driver,
    source_user_rating: e.source_user_rating,
    type: e.type,
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}

export class RepositoryAgentBoardQuery implements AgentBoardQuery {
  constructor(private readonly repository: MemoryRepository) {}

  async listAgents(): Promise<AgentBoardListItem[]> {
    const ids = await this.repository.listAgentIds();
    const handles = await Promise.all(ids.map((id) => this.repository.getAgent(id)));
    return handles.map((h) => ({
      role_id: h.role_id,
      name: h.name,
      status: h.status,
      tags: h.tags,
      skill_count: h.skill_count,
      experience_count: h.experience_count,
      persona_summary: h.persona.summary,
    }));
  }

  async getAgent(role_id: string): Promise<AgentBoardAgentView> {
    const [handle, rawMetrics] = await Promise.all([
      this.repository.getAgent(role_id),
      this.repository.getMetrics(role_id),
    ]);
    const derived = calculateDerivedMetrics(rawMetrics);
    return {
      role_id: handle.role_id,
      name: handle.name,
      status: handle.status,
      tags: handle.tags,
      skill_count: handle.skill_count,
      experience_count: handle.experience_count,
      persona: handle.persona,
      metrics: { raw: rawMetrics, derived },
      created_at: handle.created_at,
    };
  }

  async listSkills(role_id: string): Promise<SkillView[]> {
    const skills = await this.repository.listSkills(role_id);
    return skills.map(toSkillView);
  }

  async listExperiences(role_id: string): Promise<ExperienceView[]> {
    const experiences = await this.repository.listExperiences(role_id);
    return experiences.map(toExperienceView);
  }
}
