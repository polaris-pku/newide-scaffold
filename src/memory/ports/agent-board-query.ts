/**
 * AgentBoardQuery 端口 — AgentBoard 与 BFF 的唯一只读入口
 *
 * 定义 4 个只读查询方法 + 对外 DTO 类型。
 * 只读、不写；不替代 AgentManager.submitTask 等写/执行路径。
 * 实现见 adapters/agent-board-query.ts。
 */
import type { AgentMetrics, DerivedMetrics, PersonaDef } from '../schemas';

/** Board 列表卡片 DTO — 轻量摘要，不含 metrics / persona 全文 */
export interface AgentBoardListItem {
  role_id: string;
  name: string;
  status: string;
  tags: string[] | undefined;
  skill_count: number;
  experience_count: number;
  persona_summary: string;
}

/** Board 详情 DTO — 含完整 persona + metrics（raw + derived） */
export interface AgentBoardAgentView {
  role_id: string;
  name: string;
  status: string;
  tags: string[] | undefined;
  skill_count: number;
  experience_count: number;
  persona: PersonaDef;
  metrics: {
    raw: AgentMetrics;
    derived: DerivedMetrics;
  };
  created_at: string;
}

/** Skill 对外视图 — 剔除 description_embedding */
export interface SkillView {
  id: string;
  description: string;
  content: string;
  version: string;
  review_status: string;
  sub_skills: string[] | undefined;
  tags: string[];
  promoted_from: string | undefined;
  promoted_at: string;
  agent_id: string;
  origin_agent_id: string | undefined;
  imported_by: string[] | undefined;
  linked_negative_exp: string[] | undefined;
  market_status: string | undefined;
  reviewed_by: string | undefined;
  reviewed_at: string | undefined;
  created_at: string;
  updated_at: string;
}

/** Experience 对外视图 — 剔除 description_embedding 与 linked_negative_exp */
export interface ExperienceView {
  id: string;
  description: string;
  content: string;
  confidence: number;
  tags: string[];
  agent_id: string;
  promoted_to: string | undefined;
  assumptions: string[] | undefined;
  confidence_history: Array<{ value: number; updated_at: string; reason: string }>;
  referenced_count: number;
  last_referenced_at: string | undefined;
  source_task_id: string;
  source_driver: string;
  source_user_rating: string | undefined;
  type: string;
  created_at: string;
  updated_at: string;
}

/**
 * AgentBoardQuery — AgentBoard 与 BFF 的唯一读入口
 *
 * 方法签名与 DTO 映射见 Spec §6.7.4。
 */
export interface AgentBoardQuery {
  /** Board 卡片列表（轻量摘要） */
  listAgents(): Promise<AgentBoardListItem[]>;

  /** Agent 详情页：头部 + 画像 Tab + 指标 Tab 一次拿齐 */
  getAgent(role_id: string): Promise<AgentBoardAgentView>;

  /** 按需加载技能列表（剔除 description_embedding） */
  listSkills(role_id: string): Promise<SkillView[]>;

  /** 按需加载经验列表（剔除 description_embedding 与 linked_negative_exp） */
  listExperiences(role_id: string): Promise<ExperienceView[]>;
}
