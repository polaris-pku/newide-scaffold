import type { HookSettings } from './config';

// ──────────────────────────────────────────────
// HookPoint — all RFC-defined event names organized by namespace
// Reference: 方向D.1 Hooks RFC §4
// ──────────────────────────────────────────────

/** agent.* namespace — Agent runtime events (RFC §4.2) */
export type AgentHookPoint =
  | 'agent.pre_tool_use'
  | 'agent.post_tool_use'
  | 'agent.post_tool_use_fail'
  | 'agent.message_send'
  | 'agent.message_recv'
  | 'agent.checkpoint'
  | 'agent.session_start'
  | 'agent.session_end'
  | 'agent.experience_extracted'
  | 'agent.skill_promoted'
  | 'agent.respawn'
  | 'agent.respawned';

/** task.* namespace — Task lifecycle events (RFC §4.3) */
export type TaskHookPoint =
  | 'task.created'
  | 'task.claimed'
  | 'task.checkpoint_resume'
  | 'task.started'
  | 'task.progress'
  | 'task.completed'
  | 'task.failed'
  | 'task.escalated'
  | 'task.delegated'
  | 'task.before_merge';

/** council.* namespace — Council review events (RFC §4.4) */
export type CouncilHookPoint =
  | 'council.started'
  | 'council.context_packaged'
  | 'council.profile_snapshot_saved'
  | 'council.extraction_completed'
  | 'council.proposal'
  | 'council.proposal_deadline'
  | 'council.review'
  | 'council.diff_ready'
  | 'council.review_round_end'
  | 'council.decision'
  | 'council.completed';

/** lifecycle.* namespace — IDE project lifecycle events (RFC §4.5) */
export type LifecycleHookPoint =
  | 'lifecycle.project_open'
  | 'lifecycle.build_start'
  | 'lifecycle.build_end'
  | 'lifecycle.human_gate';

/** system.* namespace — System-level monitoring events (RFC §4.6) */
export type SystemHookPoint =
  | 'system.heartbeat'
  | 'system.budget_exceeded'
  | 'system.timeout'
  | 'system.agent_crash'
  | 'system.config_change'
  | 'system.worktree_create';

/** Union of all RFC-defined hook points across all five namespaces */
export type HookPoint =
  | AgentHookPoint
  | TaskHookPoint
  | CouncilHookPoint
  | LifecycleHookPoint
  | SystemHookPoint;

// ──────────────────────────────────────────────
// Phase 1 — events exposed in this milestone
// ──────────────────────────────────────────────

/** Hook events enabled in Phase 1 mock flow */
export const PHASE_1_HOOK_POINTS: HookPoint[] = [
  'task.created',
  'task.claimed',
  'task.started',
  'task.completed',
  'task.failed',
  'task.checkpoint_resume',
  'task.before_merge',
  'agent.message_send',
  'agent.message_recv',
  'agent.checkpoint',
  'system.timeout',
  'system.budget_exceeded',
  'lifecycle.human_gate',
  'council.decision'
];

/** Complete set of all RFC-defined hook points for runtime validation */
export const ALL_HOOK_POINTS: HookPoint[] = [
  // agent.* (RFC §4.2)
  'agent.pre_tool_use',
  'agent.post_tool_use',
  'agent.post_tool_use_fail',
  'agent.message_send',
  'agent.message_recv',
  'agent.checkpoint',
  'agent.session_start',
  'agent.session_end',
  'agent.experience_extracted',
  'agent.skill_promoted',
  'agent.respawn',
  'agent.respawned',
  // task.* (RFC §4.3)
  'task.created',
  'task.claimed',
  'task.checkpoint_resume',
  'task.started',
  'task.progress',
  'task.completed',
  'task.failed',
  'task.escalated',
  'task.delegated',
  'task.before_merge',
  // council.* (RFC §4.4)
  'council.started',
  'council.context_packaged',
  'council.profile_snapshot_saved',
  'council.extraction_completed',
  'council.proposal',
  'council.proposal_deadline',
  'council.review',
  'council.diff_ready',
  'council.review_round_end',
  'council.decision',
  'council.completed',
  // lifecycle.* (RFC §4.5)
  'lifecycle.project_open',
  'lifecycle.build_start',
  'lifecycle.build_end',
  'lifecycle.human_gate',
  // system.* (RFC §4.6)
  'system.heartbeat',
  'system.budget_exceeded',
  'system.timeout',
  'system.agent_crash',
  'system.config_change',
  'system.worktree_create',
];

// ──────────────────────────────────────────────
// Default values
// ──────────────────────────────────────────────

/** Default hook protocol version */
export const DEFAULT_HOOK_VERSION = 'hook-0.1' as const;

/** Default priority for hook binding entries */
export const DEFAULT_PRIORITY = 50;

/** Default timeout for gate execution in seconds */
export const DEFAULT_TIMEOUT = 30;

/** Default retry threshold for gate definitions */
export const DEFAULT_RETRY_THRESHOLD = 3;

/** Default hook engine global settings */
export const DEFAULT_HOOK_SETTINGS: HookSettings = {
  fail_fast: false,
  default_timeout: DEFAULT_TIMEOUT,
  parallel: false,
  output_format: 'json',
  emergency_env_var: 'AGENT_EMERGENCY_SKIP',
};
