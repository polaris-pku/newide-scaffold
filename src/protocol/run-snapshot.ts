import { z } from 'zod';
import { TASK_STATUSES } from '../core';
import { runEventSchema } from './run-event';

const recordSchema = z.record(z.string(), z.unknown());
const taskStatusSchema = z.enum(TASK_STATUSES);

/**
 * stage 机的持久游标。
 *
 * 与 `src/persistence` 的 `TaskResumeCursor` 是同一个词表，但**协议层自带一份字面量**：
 * 前端契约不该依赖持久化层的类型（那边是存储实现，这边是对外承诺）。两处改动必须同步，
 * 漏改的表现是投影时 zod 拒绝整个快照，而不是静默少一个字段。
 */
export const runCursorSchema = z.enum([
  'select_agent',
  'execute_agent',
  'council',
  'gate',
  'deliver',
  'mailbox_wait',
  'done',
]);

const runOutcomeSchema = z
  .object({
    status: z.enum(['completed', 'verified', 'best_effort', 'failed', 'blocked', 'cancelled']),
    reason: z.string().min(1),
    criteria: z.array(
      z
        .object({
          criterion_id: z.string().min(1),
          description: z.string().min(1),
          status: z.enum(['satisfied', 'failed', 'unverified']),
          gate_result_refs: z.array(z.string()),
          audit_refs: z.array(z.string()),
        })
        .strict(),
    ),
    gate_result_refs: z.array(z.string()),
    artifact_refs: z.array(z.string()),
  })
  .strict();

export const councilOutcomeEvidenceSchema = z
  .object({
    role_failure_count: z.number().int().nonnegative().optional(),
    fallback_used: z.boolean().optional(),
    status: z.enum(['completed', 'needs_human', 'failed']),
    participant_role_ids: z.array(z.string().min(1)),
    selected_artifact_refs: z.array(z.string().min(1)),
    decision_summary: z.string(),
    quality: z.enum(['verified', 'best_effort']),
    unresolved_issues: z.array(z.string()),
    warnings: z.array(z.string()),
    audit_refs: z.array(z.string().min(1)),
  })
  .strict();

/**
 * 快照里的用量块。
 *
 * 三条口径**并排、互不相加**，所以这里刻意**不提供任何「总数」顶层字段**：任何单一
 * 数字都必然漏掉或重复计算某一条腿，前端一定拿它当结论。要让使用者显式相加并自行
 * 承担口径后果。每条都带 `metric` 自描述，读的人不看这个字段就会算错。
 */
export const runUsageTokensSchema = z
  .object({
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
    cache_creation_input_tokens: z.number().nonnegative(),
    cache_read_input_tokens: z.number().nonnegative(),
    total_input_tokens: z.number().nonnegative(),
    total_tokens: z.number().nonnegative(),
    call_count: z.number().int().nonnegative(),
  })
  .strict();

export const runUsageStageMetricsSchema = z
  .object({
    /** 字段名自带范围：这一桶**只覆盖 proxy 腿**，不是该 stage 的总消耗。 */
    metric: z.literal('proxy_billed_tokens'),
    events: z.number().int().nonnegative(),
    llm_calls: z.number().int().nonnegative(),
    total_tokens: z.number().nonnegative(),
    /**
     * 该 stage 的 span 合计耗时。**缺席表示拿不到耗时**（实时快照没有 latency 数据），
     * 不是「瞬间完成」——不编一个 0。
     */
    duration_ms: z.number().nonnegative().optional(),
  })
  .strict();

export const runUsageSessionSchema = z
  .object({
    session_id: z.string().min(1),
    role_id: z.string().min(1).optional(),
    context_tokens_used: z.number().nonnegative(),
    context_window_size: z.number().nonnegative().optional(),
    reported_cost: z
      .object({ amount: z.number().nonnegative(), currency: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export const runUsageSchema = z
  .object({
    /** 真正烧掉的计费流量，按来源拆。当前实时快照只填得上 `proxy` 腿。 */
    billed: z
      .object({
        metric: z.literal('billed_tokens'),
        by_source: z.record(z.string(), runUsageTokensSchema),
      })
      .strict()
      .optional(),
    /** driver 上下文占用快照；与 `billed` 不是同一个量，不可相加。 */
    context: z
      .object({
        metric: z.literal('context_tokens_used'),
        context_tokens_used: z.number().nonnegative(),
        /** 观测是否可能缺尾；缺信号时为 false，绝不冒充完整数据。 */
        complete: z.boolean(),
        sessions: z.array(runUsageSessionSchema),
      })
      .strict()
      .optional(),
    /** 按 stage 分桶的 proxy 腿用量；`unattributed` / `driver_stream` 是已有桶名。 */
    by_stage: z.record(z.string(), runUsageStageMetricsSchema).optional(),
  })
  .strict();

/**
 * 跨 run 的用量历史。
 *
 * `role` 从「不支持」变为支持，靠的不是 `summary`——它至今没有 proxy 腿的角色归属——
 * 而是用量账本在**写入时**就把 `role_id` 记在每一行上。`agent` 仍然不支持：它依赖
 * 从未被赋值的 `agent_id`。
 */
export const runUsageHistorySchema = z
  .object({
    scope: z.enum(['task', 'system', 'role']),
    scope_id: z.string().min(1).optional(),
    /** 统计时点。历史是重放出来的，必须让读的人知道它是哪一刻的快照。 */
    as_of: z.string().min(1),
    /** 在该作用域下找到的 run 数（含读不出用量的）。 */
    runs_counted: z.number().int().nonnegative(),
    /**
     * 命中但读不出用量的 run 数。
     *
     * 它们**不贡献 0**——「缺 ≠ 0」。这个数是 `complete` 为 false 的原因，摆出来而不是
     * 悄悄吞掉，读的人才知道总量偏低了多少个 run。
     */
    runs_without_usage: z.number().int().nonnegative(),
    /** 只有 `runs_counted > 0` 且没有任何一个 run 缺用量时才为 true。 */
    complete: z.boolean(),
    billed: z
      .object({
        totals: runUsageTokensSchema,
        by_source: z.record(z.string(), runUsageTokensSchema),
      })
      .strict(),
  })
  .strict();

export const runSnapshotSchema = z
  .object({
    contract_version: z.literal('frontend-workflow.v0.1').optional(),
    schema_version: z.string().min(1),
    run_id: z.string().min(1),
    task_id: z.string().min(1),
    mode: z.enum(['single_agent', 'council']),
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    quality: runOutcomeSchema.optional(),
    current: z
      .object({
        stage: z.enum(['executing', 'council', 'delivery', 'intervention']),
        active_node_code: z.string().min(1),
        task_status: z.string().min(1).optional(),
        /**
         * 真实持久游标。`stage` 只是它的粗粒度映射（4 值），会把
         * `select_agent` / `execute_agent` / `gate` 全压成 `executing`。
         *
         * 前端要显示「进行到哪一步」就用这个。保留 `stage` 是为了不打断既有消费方。
         * 与 `resume_cursor` 同义：运行中是当前所在游标，终态是最后停下的那个。
         */
        cursor: runCursorSchema.optional(),
        /**
         * 当前正在执行的 stage 调用的 invocation id。
         *
         * **缺席表示此刻没有 stage 调用在跑**（stage 之间、或 run 已终态）——不编一个空串。
         * 与 `cursor` 合起来才能判定「这个游标是正在跑还是刚跑完」。
         */
        invocation_id: z.string().min(1).optional(),
        /** 当前 stage 调用的开始时间；与 `invocation_id` 同生共死。 */
        stage_started_at: z.string().min(1).optional(),
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
        quality: runOutcomeSchema.optional(),
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
        council_run_id: z.string().min(1).optional(),
        phase: z
          .enum([
            'selecting',
            'proposal',
            'review',
            'synthesis',
            'implementation',
            'decision',
            'completed',
            'failed',
          ])
          .optional(),
        subject: z.string().min(1).optional(),
        strategy: z.string().min(1).optional(),
        artifact_mode: z.enum(['implementation', 'plan']).optional(),
        auctions: z.array(recordSchema).optional(),
        decision_id: z.string().optional(),
        verdict: z.string().optional(),
        decision_mode: z.string().optional(),
        selected_proposal_id: z.string().optional(),
        selected_artifact_refs: z.array(z.string()),
        required_next_actions: z.array(z.string()),
        blocked_by: z.array(z.string()),
        can_create_merge_authorization: z.boolean(),
        participants: z.array(recordSchema).optional(),
        proposals: z.array(recordSchema).optional(),
        reviews: z.array(recordSchema).optional(),
        synthesis: recordSchema.optional(),
        implementation: recordSchema.optional(),
        output: recordSchema.optional(),
        result: recordSchema.optional(),
        outcome: councilOutcomeEvidenceSchema.optional(),
        fatal_error: recordSchema.optional(),
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
        quality: runOutcomeSchema.optional(),
      })
      .strict()
      .optional(),
    usage: runUsageSchema.optional(),
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
export type RunUsage = z.infer<typeof runUsageSchema>;
export type RunUsageHistory = z.infer<typeof runUsageHistorySchema>;
export type RunUsageTokens = z.infer<typeof runUsageTokensSchema>;
export type RunUsageStageMetrics = z.infer<typeof runUsageStageMetricsSchema>;
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
