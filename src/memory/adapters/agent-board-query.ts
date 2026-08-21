/**
 * AgentBoardQuery 适配器 — MemoryRepository 上的只读 Facade
 *
 * 委托 MemoryRepository 读取实体，组装对外 DTO（剔除 embedding、
 * linked_negative_exp），并在 getAgent 内计算派生指标。
 * 实现 Port 见 ports/agent-board-query.ts。
 */
import type { AgentStatus, ExperienceRecord, SkillRecord } from '../schemas';
import { calculateDerivedMetrics } from '../schemas';
import type { MemoryRepository } from '../ports/memory-repository';
import type {
  AgentBoardAgentView,
  AgentBoardListItem,
  AgentBoardQuery,
  ExperienceListFilter,
  ExperienceView,
  SkillListFilter,
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

  async listAgents(status?: AgentStatus): Promise<AgentBoardListItem[]> {
    const ids = await this.repository.listAgentIds();
    const handles = await Promise.all(ids.map((id) => this.repository.getAgent(id)));
    return handles
      .filter((h) => status === undefined || h.status === status)
      .map((h) => ({
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

  async listSkills(role_id: string, filter?: SkillListFilter): Promise<SkillView[]> {
    const skills = await this.repository.listSkills(role_id);
    return applyPagination(
      skills.filter((skill) => matchesSkillFilter(skill, filter)).map(toSkillView),
      filter,
    );
  }

  async listExperiences(
    role_id: string,
    filter?: ExperienceListFilter,
  ): Promise<ExperienceView[]> {
    const experiences = await this.repository.listExperiences(role_id);
    return applyPagination(
      experiences.filter((experience) => matchesExperienceFilter(experience, filter)).map(toExperienceView),
      filter,
    );
  }
}

/** Skill 过滤：审核状态 / 标签 / 关键词（description + content 不区分大小写包含） */
function matchesSkillFilter(skill: SkillRecord, filter: SkillListFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.review_status !== undefined && skill.review_status !== filter.review_status) {
    return false;
  }
  if (filter.tag !== undefined && !skill.tags.includes(filter.tag)) {
    return false;
  }
  if (filter.keyword !== undefined) {
    const needle = filter.keyword.toLowerCase();
    const haystack = `${skill.description}\n${skill.content}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** Experience 过滤：类型 / 置信度区间 / 标签 / 关键词 */
function matchesExperienceFilter(
  experience: ExperienceRecord,
  filter: ExperienceListFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.type !== undefined && experience.type !== filter.type) {
    return false;
  }
  if (filter.confidence_min !== undefined && experience.confidence < filter.confidence_min) {
    return false;
  }
  if (filter.confidence_max !== undefined && experience.confidence > filter.confidence_max) {
    return false;
  }
  if (filter.tag !== undefined && !experience.tags.includes(filter.tag)) {
    return false;
  }
  if (filter.keyword !== undefined) {
    const needle = filter.keyword.toLowerCase();
    const haystack = `${experience.description}\n${experience.content}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** 分页：offset 默认 0，limit 默认不限 */
function applyPagination<T>(items: T[], filter: { offset?: number; limit?: number } | undefined): T[] {
  if (!filter || (filter.offset === undefined && filter.limit === undefined)) {
    return items;
  }
  const offset = filter.offset ?? 0;
  const end = filter.limit !== undefined ? offset + filter.limit : undefined;
  return items.slice(offset, end);
}
