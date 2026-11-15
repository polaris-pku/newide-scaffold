/**
 * 派工 Journal / evidence 的对外只读契约（阶段 4，`run.*` namespace）。
 *
 * 这两组 schema 是**事实投影**的读取形状，不是新的账本：
 * - Journal 页只给每行的事实元数据（event / dispatch_id / kind / status / at + 行号），
 *   摘要按 `dispatch_id` 去重后计数；**绝不内联** brief.instruction / summary / reflection /
 *   transcript 这类正文，正文只能按 evidence ref 分页读取。
 * - evidence 页是受控 ref 的分页字节（path + sha256 绑定），由
 *   `RunDispatchJournal.readEvidence` 校验后返回；这里只描述读到的形状。
 *
 * 兼容语义与 `RD-REG-03` 一致：旧 Run 没有 Journal 时 `state='absent'`（不是错误），
 * 缺的字段一律缺席而不是填 0。
 */
import { z } from 'zod';

/** Journal 行分页默认条数（`run.getDispatchJournal`）。 */
export const RUN_DISPATCH_JOURNAL_DEFAULT_LIMIT = 50;
/** Journal 行分页上限：一次最多 200 行，避免把整份事实源塞进一帧 RPC。 */
export const RUN_DISPATCH_JOURNAL_MAX_LIMIT = 200;
/** evidence 单页字节上限，与 `RunDispatchJournal` 的 `readEvidence` 默认页上限同值。 */
export const RUN_DISPATCH_EVIDENCE_MAX_PAGE_BYTES = 64 * 1024;

/**
 * 一行 Journal 的事实元数据。
 *
 * `line` 是该行在 `journal/dispatches.jsonl` 里的**物理行号**（1 起，含被 repair 跳过的
 * 坏行占位），分页游标 `after_line` 也用它，因此重复读同一水位不会漂移。
 */
export const runDispatchJournalLineSchema = z
  .object({
    line: z.number().int().positive(),
    event: z.string().min(1),
    at: z.string().min(1),
    dispatch_id: z.string().min(1).optional(),
    /** `accepted` 行的派工种类（investigate/execute/verify）；control 行没有。 */
    kind: z.string().min(1).optional(),
    /** `settled` / `reconciled` 行的可对账状态；其余行没有。 */
    status: z.string().min(1).optional(),
  })
  .strict();

/**
 * 折叠后的派工摘要（`state='ok'` 时才可能给出）。
 *
 * 计数口径与 Journal 折叠一致：按 `dispatch_id` 去重，同一派工的重复写重试不重复计数；
 * `unknown` 与只读违规如实计数，不用成功状态掩盖。
 */
export const runDispatchJournalSummarySchema = z
  .object({
    total_dispatches: z.number().int().nonnegative(),
    by_status: z.record(z.string(), z.number().int().nonnegative()),
    /** 未收束的 `unknown` 派工 id（恢复/交付必须显式可见）。 */
    unknown_dispatch_ids: z.array(z.string().min(1)),
    /**
     * 原始 settled 状态为 `unknown`、经可信 reconciled 收束的派工 id（阶段 4 修复 R4-02）。
     *
     * `by_status` 按**有效状态**计数，所以这些 id 不会出现在 `unknown_dispatch_ids` 里；
     * 但 Journal 原始 settled 行/事件仍保留 `unknown`，此字段让两者可解释、可核对。
     */
    reconciled_dispatch_ids: z.array(z.string().min(1)).optional(),
    /** 只读违规总条数（跨派工累计；种类在 `kinds`）。 */
    violation_count: z.number().int().nonnegative(),
    /** 按派工种类计数（investigate/execute/verify）。 */
    kinds: z.record(z.string(), z.number().int().nonnegative()),
    /** Journal 的 finish 控制行；没有收尾时缺席。 */
    finish: z
      .object({
        status: z.string().min(1),
        actor: z.string().min(1),
        at: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const runDispatchJournalProblemSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    line: z.number().int().positive().optional(),
  })
  .strict();

/**
 * `run.getDispatchJournal` 的结果：一页 Journal 事实 + 读取状态 + 折叠摘要。
 *
 * `state` 是聚合结论而不是异常：`absent`（旧 Run 没有 Journal，仍可读）、
 * `repairable_tail`（末尾半写，可修复但不在读取时修）、`corrupt`（fail closed，
 * 但仍返回已解析行与 problems，便于前端展示与人工修复）。
 */
export const runDispatchJournalPageSchema = z
  .object({
    run_id: z.string().min(1),
    state: z.enum(['ok', 'absent', 'repairable_tail', 'corrupt']),
    durability: z
      .object({
        mode: z.enum(['fsync', 'best_effort']),
        directory_sync: z.boolean(),
        notes: z.array(z.string()),
      })
      .strict(),
    /** 本 Journal 可读的总行数（不含被 repair 跳过/半写的坏行）。 */
    total_lines: z.number().int().nonnegative(),
    lines: z.array(runDispatchJournalLineSchema),
    has_more: z.boolean(),
    /** 下一页游标（物理行号）；没有更多行为 null。 */
    next_after_line: z.number().int().positive().nullable(),
    summary: runDispatchJournalSummarySchema.optional(),
    problems: z.array(runDispatchJournalProblemSchema),
  })
  .strict();

/**
 * `run.getDispatchEvidence` 的结果：受控 evidence 侧车的一页。
 *
 * `offset` / `limit` 是**字节**口径（不是字符数）；`next_offset` 在没有更多内容时为 null。
 */
export const runDispatchEvidencePageSchema = z
  .object({
    run_id: z.string().min(1),
    dispatch_id: z.string().min(1),
    /** 受控 ref 的相对路径（相对 run 目录），例如 `journal/evidence/dsp_1.json`。 */
    path: z.string().min(1),
    sha256: z.string().min(1),
    total_bytes: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    truncated: z.boolean(),
    content: z.string(),
    next_offset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type RunDispatchJournalLine = z.infer<typeof runDispatchJournalLineSchema>;
export type RunDispatchJournalSummary = z.infer<typeof runDispatchJournalSummarySchema>;
export type RunDispatchJournalProblem = z.infer<typeof runDispatchJournalProblemSchema>;
export type RunDispatchJournalPage = z.infer<typeof runDispatchJournalPageSchema>;
export type RunDispatchEvidencePage = z.infer<typeof runDispatchEvidencePageSchema>;

export interface GetRunDispatchJournalInput {
  run_id: string;
  /** 分页水位：只回 `line > after_line` 的行；默认 0。 */
  after_line?: number;
  /** 单页行数；默认 {@link RUN_DISPATCH_JOURNAL_DEFAULT_LIMIT}，上限 {@link RUN_DISPATCH_JOURNAL_MAX_LIMIT}。 */
  limit?: number;
}

export interface GetRunDispatchEvidenceInput {
  run_id: string;
  dispatch_id: string;
  /** 字节偏移；默认 0。 */
  offset?: number;
  /** 单页字节数；默认并由服务端夹到 {@link RUN_DISPATCH_EVIDENCE_MAX_PAGE_BYTES}。 */
  limit?: number;
}
