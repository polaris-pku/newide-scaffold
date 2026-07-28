import { z } from 'zod';
import { TASK_STATUSES } from '../core';
import { runEventSchema } from './run-event';

const recordSchema = z.record(z.string(), z.unknown());
const taskStatusSchema = z.enum(TASK_STATUSES);

export const runSnapshotSchema = z
  .object({
    contract_version: z.literal('frontend-workflow.v0.1').optional(),
    schema_version: z.string().min(1),
    run_id: z.string().min(1),
    task_id: z.string().min(1),
    mode: z.enum(['single_agent', 'council']),
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    current: z
      .object({
        stage: z.enum(['executing', 'council', 'delivery', 'intervention']),
        active_node_code: z.string().min(1),
        task_status: z.string().min(1).optional(),
      })
      .strict(),
    task: z
      .object({
        task_id: z.string().min(1),
        status: taskStatusSchema,
        spec: z.string().min(1),
        completion_criteria: z.array(z.string().min(1)),
        risk_level: z.enum(['low', 'medium', 'high', 'critical']),
        affected_paths: z.array(z.string()),
        role_id: z.string().min(1).optional(),
        budget: recordSchema.optional(),
        created_at: z.string().min(1),
        updated_at: z.string().min(1),
        schema_version: z.string().min(1),
      })
      .strict()
      .optional(),
    run: z
      .object({
        run_id: z.string().min(1),
        task_id: z.string().min(1),
        status: z.string().min(1),
        mode: z.enum(['single_agent', 'council']),
        session_id: z.string().min(1).optional(),
        event_ids: z.array(z.string().min(1)),
        started_at: z.string().min(1).optional(),
        completed_at: z.string().min(1).optional(),
        checkpoint_id: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    flow: z
      .object({
        active_node_code: z.string().min(1),
        node_statuses: z.array(recordSchema),
      })
      .strict()
      .optional(),
    delivery_report: z
      .object({
        worktree_path: z.string().min(1).optional(),
        files_written: z.array(z.string()),
        changed_files: z.array(z.string()).optional(),
        artifacts_materialized: z.number().int().nonnegative(),
        outcome: z.enum(['completed_files', 'completed_response', 'failed']).optional(),
        response: z.string().optional(),
        session_id: z.string().min(1).optional(),
        tool_events: z.array(recordSchema).optional(),
      })
      .strict()
      .optional(),
    links: recordSchema.optional(),
    timeline: z.array(runEventSchema),
    agent_runs: z.array(recordSchema),
    artifacts: z.array(recordSchema),
    gates: z.array(recordSchema),
    market: z
      .object({
        winner_agent_id: z.string().min(1),
        winner_bid_id: z.string().min(1),
        ledger_ref: z.string().min(1),
        audit_ref: z.string().min(1),
        policy_version: z.string().min(1),
        seed: z.string().min(1),
      })
      .strict()
      .optional(),
    council: z
      .object({
        enabled: z.literal(true),
        status: z.enum(['running', 'completed', 'failed', 'cancelled']),
        decision_id: z.string().optional(),
        verdict: z.string().optional(),
        decision_mode: z.string().optional(),
        selected_proposal_id: z.string().optional(),
        selected_artifact_refs: z.array(z.string()),
        required_next_actions: z.array(z.string()),
        blocked_by: z.array(z.string()),
        can_create_merge_authorization: z.boolean(),
        proposals: z.array(recordSchema).optional(),
        reviews: z.array(recordSchema).optional(),
        synthesis: recordSchema.optional(),
        output: recordSchema.optional(),
        result: recordSchema.optional(),
      })
      .strict()
      .optional(),
    checkpoint: recordSchema.optional(),
    errors: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          details: recordSchema.optional(),
        })
        .strict(),
    ),
    final_output: z
      .object({
        status: z.enum(['completed', 'failed', 'cancelled']),
        artifact_refs: z.array(z.string()),
        files_written: z.array(z.string()),
        changed_files: z.array(z.string()).optional(),
        outcome: z.enum(['completed_files', 'completed_response', 'failed']).optional(),
        response: z.string().optional(),
        session_id: z.string().min(1).optional(),
        tool_events: z.array(recordSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.contract_version !== 'frontend-workflow.v0.1') return;
    for (const field of ['task', 'run', 'flow', 'delivery_report', 'links'] as const) {
      if (snapshot[field] !== undefined) continue;
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} is required by frontend-workflow.v0.1`,
      });
    }
    if (snapshot.current.task_status === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['current', 'task_status'],
        message: 'task_status is required by frontend-workflow.v0.1',
      });
    }
    if (snapshot.task && snapshot.task.task_id !== snapshot.task_id) {
      context.addIssue({ code: 'custom', path: ['task', 'task_id'], message: 'task_id mismatch' });
    }
    if (
      snapshot.run &&
      (snapshot.run.run_id !== snapshot.run_id || snapshot.run.task_id !== snapshot.task_id)
    ) {
      context.addIssue({ code: 'custom', path: ['run'], message: 'run identity mismatch' });
    }
    if (snapshot.task && snapshot.current.task_status !== snapshot.task.status) {
      context.addIssue({
        code: 'custom',
        path: ['current', 'task_status'],
        message: 'task status mismatch',
      });
    }
  });

export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

export type FrontendWorkflowV01Snapshot = RunSnapshot & {
  contract_version: 'frontend-workflow.v0.1';
  current: RunSnapshot['current'] & { task_status: string };
  task: NonNullable<RunSnapshot['task']>;
  run: NonNullable<RunSnapshot['run']>;
  flow: NonNullable<RunSnapshot['flow']>;
  delivery_report: NonNullable<RunSnapshot['delivery_report']>;
  links: NonNullable<RunSnapshot['links']>;
};

export function isFrontendWorkflowV01Snapshot(
  snapshot: RunSnapshot,
): snapshot is FrontendWorkflowV01Snapshot {
  return snapshot.contract_version === 'frontend-workflow.v0.1';
}
