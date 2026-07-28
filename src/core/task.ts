import type { AgentId, RoleId, SchemaVersion, TaskId, Timestamp } from './ids';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const TASK_STATUSES = [
  'created',
  'triaged',
  'ready',
  'claimed',
  'running',
  'waiting_help',
  'waiting_input',
  'pending_gate',
  'pending_council',
  'reviewing',
  'blocked',
  'escalated',
  'merging',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskBudget {
  max_tokens?: number;
  max_wall_clock_seconds?: number;
  max_tool_calls?: number;
}

export interface TaskCreateRequest {
  spec: string;
  role_id?: RoleId;
  parent_task_id?: TaskId;
  deps?: TaskId[];
  risk_level?: RiskLevel;
  affected_paths?: string[];
  completion_criteria: string[];
  budget?: TaskBudget;
}

export interface Task {
  task_id: TaskId;
  parent_id?: TaskId;
  status: TaskStatus;
  owner_agent_id?: AgentId;
  role_id?: RoleId;
  risk_level: RiskLevel;
  spec: string;
  completion_criteria: string[];
  affected_paths?: string[];
  budget?: TaskBudget;
  created_at: Timestamp;
  updated_at: Timestamp;
  schema_version: SchemaVersion;
}
