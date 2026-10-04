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
    /**
     * 真正烧掉的计费流量，按来源拆。
     *
     * **来源随 run 的生命周期变**：在跑的 run 只有 `proxy` 腿（driver 侧计费不进事件流）；
     * 已收尾的 run 从用量账本取，于是 `claude_session_jsonl` 腿也在。同一个 run 的这两个
     * 阶段报的是不同的腿集合，但**收尾之后**无论本进程还持不持有它，报的都是账本那一份
     * ——否则前端的数字会随后端重启而变。
     */
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
 *
 * `run` 是单个 run 的持久用量。它存在的理由不是「粒度更细」，而是**进程重启后仍然读得到**：
 * 在这之前单个 run 的用量只在存活期内存里，重启即消失。同一份数据也是 `run.getSnapshot`
 * 的 `usage.billed` 在收尾之后的来源，两者必须报同一个数。
 */
export const runUsageHistorySchema = z
  .object({
    scope: z.enum(['task', 'system', 'role', 'run']),
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

/**
 * driver 侧的在飞状态：这个席位**此刻**在驱动哪个 turn / 哪个工具。
 *
 * 从存活期事件流折出来（`src/app/run-driver-activity.ts`），所以它和 agent 半边一样是
 * **本进程持有该 run 时**才有的观察——进程重启后 driver 状态的持久记录在 `timeline` 上
 * （§7.4），不在这个字段里。
 *
 * `state` 三个值都有真实生产者，且都是**观测到的**（不是补出来的）：
 * `turn_running` ← `driver.turn_started`；`tool_running` ← `driver.tool_started` /
 * `driver.tool_progress`；`disconnected` ← `driver.disconnected`（实测它不是正常收尾：
 * 24 个含 `disconnect` 的 run 没有一个同时有 turn 事件）。
 *
 * `turn_completed` / `turn_failed` **不映射成状态**，它们让这个字段消失：那一轮 invoke
 * 已经结束，结局（`stop_reason` / `reason`）本来就在事件流里，在状态里再说一遍只是同一件
 * 事说两遍。所以字段缺席 = 此刻没有在跑的 driver 调用，而不是「driver 空闲」。
 *
 * `since` 是当前状态的起点；`last_event_at` 是**任意** driver 事件的最近时间（含 chunk），
 * `stale` 只看后者——片段一直在流就说明 driver 活着，哪怕它在同一个工具上待了很久。
 */
export const runDriverActivitySchema = z
  .object({
    state: z.enum(['turn_running', 'tool_running', 'disconnected']),
    since: z.string().min(1),
    last_event_at: z.string().min(1),
    /** 很久没有任何 driver 事件：可能卡住了，而不是「还在想」。 */
    stale: z.boolean(),
    /**
     * 工具身份与标题，**刻意只有这四个**：`raw_input` / `raw_output` / `content` /
     * `locations` 不进契约（§4.2 的 D3——隐私与体积，不是技术限制）。要全文按需拉取。
     */
    tool_call_id: z.string().min(1).optional(),
    /** 只在 `_meta.claudeCode.toolName` 存在时有值（ACP 把 `_meta` 声明在顶层，真实环境可能取不到）。 */
    tool_name: z.string().min(1).optional(),
    tool_kind: z.string().min(1).optional(),
    tool_title: z.string().min(1).optional(),
  })
  .strict();

/**
 * 在飞运行态：此刻**真正在动**的 agent 席位，每个席位带上它自己的 driver 半边。
 *
 * **与 §4.2 草案的偏差，都需要知情：**
 *
 * 1. **草案里 `activity` 是单数对象，这里是列表。** council 一次会并发多个席位，而状态点
 *    是按 `(run_id, role_id)` 索引的——单数对象只能挑一个席位报，等于随机丢掉另外三个。
 *    所以每个元素自带 `role_id`。
 * 2. **`state` 只声明了两个值。** 草案列了 6 个（`idle` / `thinking` / `tool_call` /
 *    `delegating` / `waiting_human` / `unknown`），其余四个目前**没有写入点**。按草案自己
 *    的原则（「不要设计永远不出现的枚举值」），有生产者了再加。
 * 3. **driver 半边挂在每个席位内部**（`agents[].driver`），而不是平铺成第二级列表。理由：
 *    driver 事件本来就被 facade 盖上调用它的 `role_id`，所以「哪个席位的 driver」是事实而
 *    不是推断；挂进席位也让 `subject: 'agent'` 继续成立（这个块讲的就是 agent）。
 *
 * **缺席语义**：`activity` 整个字段缺失 = 此刻没有覆盖到的在飞状态；`agents[].driver`
 * 缺失 = 这个席位此刻没有在跑的 driver 调用。**不给 `idle`**：进程活着但不在状态点里，
 * 与「状态点漏了」从这一份数据上分不出来，报 `idle` 是在替读者下结论。
 */
export const runActivityEntrySchema = z
  .object({
    role_id: z.string().min(1),
    state: z.enum(['thinking', 'delegating']),
    since: z.string().min(1),
    /** 同一 `(run, role)` 内单调递增；前端据此丢弃过期更新。 */
    seq: z.number().int().positive(),
    /** 停在这个状态太久：进程可能已经卡住，而不是「还在想」。 */
    stale: z.boolean(),
    round: z.number().int().nonnegative().optional(),
    /**
     * **agent 循环自己**在调的工具。`delegating` 时是 `invoke_driver`——注意它与下面
     * `driver.tool_name` 不是一回事：那个是 driver 子进程内部在跑的工具名。
     * 取不到时缺席，不编。
     */
    tool_name: z.string().min(1).optional(),
    /**
     * 这个席位此刻在驱动的 turn / 工具；没有在跑的 driver 调用时缺席。
     *
     * **父子一致性**：只在 `state === 'delegating'` 时出现。这不只是约定——投影是按这个
     * 判据挂的（见 `run-activity-projection.ts`），所以 agent 一回到自主思考，它整组消失，
     * 不会把上一次的工具名残留下来。
     */
    driver: runDriverActivitySchema.optional(),
  })
  .strict();

export const runActivitySchema = z
  .object({
    /** 目前只有 `agent` 有生产者；`driver` 见上面的说明。 */
    subject: z.literal('agent'),
    agents: z.array(runActivityEntrySchema),
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
    /** 只有本进程持有的 run 才有——在飞状态是内存里的，重启即失。 */
    activity: runActivitySchema.optional(),
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
export type RunActivity = z.infer<typeof runActivitySchema>;
export type RunActivityEntry = z.infer<typeof runActivityEntrySchema>;
export type RunDriverActivity = z.infer<typeof runDriverActivitySchema>;
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
