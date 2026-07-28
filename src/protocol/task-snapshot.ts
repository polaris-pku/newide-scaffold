import { z } from 'zod';
import { TASK_STATUSES } from '../core';

const recordSchema = z.record(z.string(), z.unknown());

export const taskRunSummarySchema = z
  .object({
    run_id: z.string().min(1),
    task_id: z.string().min(1),
    status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
    mode: z.enum(['single_agent', 'council']),
    restartable: z.boolean(),
    session_id: z.string().min(1).optional(),
    started_at: z.string().min(1).optional(),
    completed_at: z.string().min(1).optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string(),
        details: recordSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const marketSelectionEvidenceSchema = z
  .object({
    winner_agent_id: z.string().min(1),
    winner_bid_id: z.string().min(1),
    ledger_ref: z.string().min(1),
    audit_ref: z.string().min(1),
    policy_version: z.string().min(1),
    seed: z.string().min(1),
  })
  .strict();

export const councilResultEvidenceSchema = z
  .object({
    quality: z.enum(['verified', 'best_effort']),
    final_artifact_ref: z.string().min(1),
    final_artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    warnings: z.array(z.string()),
    unmet_criteria: z.array(z.string()),
    verification_refs: z.array(z.string().min(1)),
    decision_record_ref: z.string().min(1),
  })
  .strict();

const taskSchema = z
  .object({
    task_id: z.string().min(1),
    parent_id: z.string().min(1).optional(),
    status: z.enum(TASK_STATUSES),
    owner_agent_id: z.string().min(1).optional(),
    role_id: z.string().min(1).optional(),
    risk_level: z.enum(['low', 'medium', 'high', 'critical']),
    spec: z.string().min(1),
    completion_criteria: z.array(z.string().min(1)),
    affected_paths: z.array(z.string()),
    budget: z
      .object({
        max_tokens: z.number().int().positive().optional(),
        max_wall_clock_seconds: z.number().int().positive().optional(),
        max_tool_calls: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    schema_version: z.string().min(1),
  })
  .strict();

const councilEvidenceSchema = z
  .object({
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    decision_id: z.string().min(1).optional(),
    verdict: z.enum(['select', 'needs_human', 'request_revision', 'reject']).optional(),
    result: councilResultEvidenceSchema.optional(),
  })
  .strict();

const finalOutputSchema = z
  .object({
    artifact_refs: z.array(z.string().min(1)),
    files_written: z.array(z.string()),
    changed_files: z.array(z.string()),
    response: z.string().optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

const WAITING_STATUSES = new Set([
  'waiting_help',
  'waiting_input',
  'pending_gate',
  'pending_council',
  'blocked',
]);

export const taskSnapshotSchema = z
  .object({
    contract_version: z.literal('task-snapshot.v0'),
    schema_version: z.string().min(1),
    revision: z.number().int().nonnegative(),
    task: taskSchema,
    current_run: taskRunSummarySchema.optional(),
    run_history: z.array(taskRunSummarySchema),
    market: marketSelectionEvidenceSchema.optional(),
    council: councilEvidenceSchema.optional(),
    waiting_reason: z.string().min(1).optional(),
    warnings: z.array(z.string()),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string(),
        details: recordSchema.optional(),
      })
      .strict()
      .optional(),
    final_output: finalOutputSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const runs = [...snapshot.run_history, ...(snapshot.current_run ? [snapshot.current_run] : [])];
    const seenRunIds = new Set<string>();
    for (const run of runs) {
      if (run.task_id !== snapshot.task.task_id) {
        context.addIssue({
          code: 'custom',
          path: ['run_history'],
          message: `run ${run.run_id} belongs to another task`,
        });
      }
      if (seenRunIds.has(run.run_id)) {
        context.addIssue({
          code: 'custom',
          path: ['run_history'],
          message: `duplicate run_id: ${run.run_id}`,
        });
      }
      seenRunIds.add(run.run_id);
    }
    if (snapshot.current_run && snapshot.current_run.status !== 'running') {
      context.addIssue({
        code: 'custom',
        path: ['current_run', 'status'],
        message: 'current_run must be running',
      });
    }
    if (WAITING_STATUSES.has(snapshot.task.status) && !snapshot.waiting_reason) {
      context.addIssue({
        code: 'custom',
        path: ['waiting_reason'],
        message: `waiting_reason is required for ${snapshot.task.status}`,
      });
    }
    for (const warning of snapshot.council?.result?.warnings ?? []) {
      if (snapshot.warnings.includes(warning)) continue;
      context.addIssue({
        code: 'custom',
        path: ['warnings'],
        message: 'CouncilResult warnings must be preserved',
      });
    }
    const finalArtifactRef = snapshot.council?.result?.final_artifact_ref;
    if (
      finalArtifactRef &&
      snapshot.final_output &&
      !snapshot.final_output.artifact_refs.includes(finalArtifactRef)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['final_output', 'artifact_refs'],
        message: 'Council final artifact must be present in final_output',
      });
    }
  });

export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
export type TaskRunSummary = z.infer<typeof taskRunSummarySchema>;
export type MarketSelectionEvidence = z.infer<typeof marketSelectionEvidenceSchema>;
