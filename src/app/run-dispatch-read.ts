/**
 * run-dispatch-read — 对外只读的派工 Journal / evidence 分页读取（阶段 4）。
 *
 * 职责与核心逻辑：
 * - **只读**：用 `RunDispatchJournal.peek` 打开（不取写锁、不建目录/文件、不修复坏尾），
 *   通过 `read()` / `readEvidence()` 取事实；不派工、不改终态、不写任何文件。对 journal 的
 *   唯一「写」动作是进程内 `registerEvidenceRef`（受控 ref 登记，不落盘）。
 * - **身份从事实源读**：run_id 只作安全目录段校验；Journal 的真实 run/task/role 身份取自
 *   首行（每行都带三元身份），折叠时用同一身份 fail closed。
 * - **不内联正文**：行投影只给 event/dispatch_id/kind/status/at 与**物理行号**；正文只能按
 *   受控 evidence ref（path + sha256 双绑）分页读取，由 `readEvidence` 做 realpath/大小/hash
 *   校验。缺 journal（旧 Run）返回 `absent`，不是错误。
 * - **损坏不抛到 RPC**：`read()` 已经把损坏表达为 `state` + `problems`；折叠失败时 `summary`
 *   缺席。只有「请求了本 Run 未登记的 evidence」才抛稳定错误，由 RPC 层映射错误码。
 * - **恢复/终态读取**：`readRunDispatchFacts` 用同一 `peek + fold` 给 projector / terminal
 *   writer 提供只读 Journal 事实（阶段 4 修复 R4-01），缺失/损坏/半写一律降级为 `undefined`，
 *   不写盘、不派工、不改终态。
 *
 * 边界：本模块不依赖 `NewideBackendService`，也不判断 run 是否存在于协调库——那是应用
 * service 的职责（它先抛 `RunNotFoundError`，再调这里）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DispatchJournalLine, DispatchRecord, EvidenceRef } from '../driver';
import { hashExecutionEvidence } from '../driver';
import type {
  DispatchJournalDurability,
  DispatchJournalReadResult,
  RunDispatchJournal,
} from '../persistence';
import {
  DISPATCH_EVIDENCE_DIR,
  DISPATCH_JOURNAL_DIR,
  foldDispatchJournalLines,
  RunDispatchJournal as RunDispatchJournalImpl,
  RunDispatchJournalError,
} from '../persistence';
import type {
  GetRunDispatchEvidenceInput,
  GetRunDispatchJournalInput,
  RunDispatchEvidencePage,
  RunDispatchJournalLine,
  RunDispatchJournalPage,
  RunDispatchJournalSummary,
} from '../protocol/run-dispatch-read';
import {
  RUN_DISPATCH_EVIDENCE_MAX_PAGE_BYTES,
  RUN_DISPATCH_JOURNAL_DEFAULT_LIMIT,
  RUN_DISPATCH_JOURNAL_MAX_LIMIT,
} from '../protocol/run-dispatch-read';
import { effectiveDispatchRecordStatus } from './role-autonomy-contract';

/** run_id / dispatch_id 会当目录名/文件名使用：只允许安全段字符，杜绝路径穿越。 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
/** 只读实例的占位身份；真实身份由 `read()` 的首行提供（`peek` 不校验它）。 */
const READ_IDENTITY_ROLE = 'run-dispatch-read';

/** 本模块的稳定错误码；RPC 层据此映射 INVALID_PARAMS / PAYLOAD_REF_UNAVAILABLE。 */
export type RunDispatchReadErrorCode =
  | 'unsafe_run_id'
  | 'unsafe_dispatch_id'
  | 'unsafe_run_path'
  | 'invalid_page'
  | 'dispatch_not_in_journal'
  | 'dispatch_evidence_not_registered'
  | 'dispatch_evidence_unavailable';

export class RunDispatchReadError extends Error {
  readonly details: unknown;

  constructor(
    readonly code: RunDispatchReadErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'RunDispatchReadError';
    this.details = details;
  }
}

/**
 * 读一页 Journal 事实。
 *
 * `after_line` 是**物理行号**水位（只回 `line > after_line`），因此被 repair 跳过的坏行不会
 * 让游标错位；`limit` 默认 50、上限 200（RPC 层已先校验，这里再夹一层防直接调用越界）。
 */
export async function readRunDispatchJournalPage(
  runsRoot: string,
  input: GetRunDispatchJournalInput,
): Promise<RunDispatchJournalPage> {
  assertSafeSegment(input.run_id, 'run_id');
  const afterLine = normalizeAfterLine(input.after_line);
  const limit = Math.min(
    normalizeLimit(input.limit, RUN_DISPATCH_JOURNAL_DEFAULT_LIMIT),
    RUN_DISPATCH_JOURNAL_MAX_LIMIT,
  );

  const journal = await peekJournal(runsRoot, input.run_id);
  if (journal === undefined) {
    return {
      run_id: input.run_id,
      state: 'absent',
      durability: unobservedDurability('run directory is not readable; there is no journal to read'),
      total_lines: 0,
      lines: [],
      has_more: false,
      next_after_line: null,
      problems: [],
    };
  }

  const read = await journal.read();
  const allLines = projectJournalLines(read);
  const candidates = allLines.filter((line) => line.line > afterLine);
  const lines = candidates.slice(0, limit);
  const hasMore = candidates.length > lines.length;
  const lastLine = lines.at(-1);
  // 摘要只在 Journal 整体可解析时给：损坏/半写状态下对「部分行」折叠出的计数会替读者
  // 编一个不完整的派工集合，宁可让 summary 缺席（state/problems 已说明原因）。
  const summary = read.status === 'ok' ? summarizeJournal(read) : undefined;

  return {
    run_id: input.run_id,
    // read() 对 legacy（没有 journal 文件）返回 status='absent'，与契约的 state 同义。
    state: read.status,
    durability: read.durability,
    total_lines: allLines.length,
    lines,
    has_more: hasMore,
    next_after_line: hasMore && lastLine !== undefined ? lastLine.line : null,
    ...(summary !== undefined ? { summary } : {}),
    problems: read.problems.map((problem) => ({
      code: problem.code,
      message: problem.message,
      ...(problem.line !== undefined ? { line: problem.line } : {}),
    })),
  };
}

/**
 * 读一页受控 evidence。
 *
 * ref **只从本 Run Journal 行派生**（settled 的 `evidence_sha256` 绑定侧车路径，或 reconciled
 * 显式 `evidence_ref`），绝不接受调用方给的路径；随后交给 `readEvidence` 做受控读取。
 */
export async function readRunDispatchEvidencePage(
  runsRoot: string,
  input: GetRunDispatchEvidenceInput,
): Promise<RunDispatchEvidencePage> {
  assertSafeSegment(input.run_id, 'run_id');
  assertSafeSegment(input.dispatch_id, 'dispatch_id');
  const offset = normalizeOffset(input.offset);
  const limit = normalizeLimit(input.limit, RUN_DISPATCH_EVIDENCE_MAX_PAGE_BYTES);

  const journal = await peekJournal(runsRoot, input.run_id);
  if (journal === undefined) {
    throw new RunDispatchReadError(
      'dispatch_evidence_not_registered',
      `Run ${input.run_id} has no readable dispatch journal; no evidence ref is registered for it`,
    );
  }
  const read = await journal.read();
  const ref = evidenceRefForDispatch(read, input.dispatch_id);

  try {
    await journal.registerEvidenceRef(ref);
    const page = await journal.readEvidence(ref, {
      offset,
      limit: Math.min(limit, RUN_DISPATCH_EVIDENCE_MAX_PAGE_BYTES),
    });
    const pageStart = Math.min(page.offset, page.total_bytes);
    const pageEnd = Math.min(pageStart + page.limit, page.total_bytes);
    return {
      run_id: input.run_id,
      dispatch_id: input.dispatch_id,
      path: ref.path,
      sha256: page.sha256,
      total_bytes: page.total_bytes,
      offset: page.offset,
      limit: page.limit,
      truncated: page.truncated,
      content: page.text,
      next_offset: page.truncated ? pageEnd : null,
    };
  } catch (error) {
    if (error instanceof RunDispatchJournalError) {
      throw new RunDispatchReadError(
        'dispatch_evidence_unavailable',
        `Evidence for dispatch ${input.dispatch_id} could not be read: ${error.code}`,
        { code: error.code, dispatch_id: input.dispatch_id },
      );
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────
// 投影事实读取（恢复/终态边界用）
// ─────────────────────────────────────────────────────────────

/**
 * 读本 Run 的 Journal 折叠记录，供恢复/终态投影补齐缺失的低频事件事实（阶段 4 修复 R4-01）。
 *
 * 只读：`peek` 不取写锁、不建目录/文件、不修坏尾。**全程降级不抛错**：没有 Journal
 * （legacy Run）、半写尾、损坏、身份不符或 I/O 失败一律返回 `undefined`，让调用方退回纯
 * 事件投影——补投影失败只该少一块可见事实，不该把已完成的 Run 报成失败。返回的数组顺序
 * 就是 accepted 顺序（Journal 折叠语义）。
 */
export async function readRunDispatchFacts(
  runsRoot: string,
  runId: string,
): Promise<readonly DispatchRecord[] | undefined> {
  try {
    assertSafeSegment(runId, 'run_id');
    const journal = await peekJournal(runsRoot, runId);
    if (journal === undefined) return undefined;
    const read = await journal.read();
    // repairable_tail / corrupt 都 fail closed：从半份事实里补投影会编出错误的计数。
    if (read.kind !== 'journal' || read.status !== 'ok') return undefined;
    const first = read.lines[0];
    if (first === undefined) return undefined;
    return foldDispatchJournalLines(read.lines, {
      run_id: first.run_id,
      task_id: first.task_id,
      role_id: first.role_id,
    }).records;
  } catch (error) {
    if (error instanceof RunDispatchJournalError) return undefined;
    process.stderr.write(
      `[dispatch-read] journal facts for run ${runId} were not projected: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────
// 内部：打开 / 投影 / 折叠
// ─────────────────────────────────────────────────────────────

/** 只读打开 Journal；run 目录不存在或解析到 runs root 之外时分别返回 absent / 稳定错误。 */
async function peekJournal(
  runsRoot: string,
  runId: string,
): Promise<RunDispatchJournal | undefined> {
  const root = path.resolve(runsRoot);
  const runDir = path.join(root, runId);
  let realRoot: string;
  let realRunDir: string;
  try {
    realRoot = await fs.realpath(root);
    realRunDir = await fs.realpath(runDir);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
  if (!isPathInside(realRoot, realRunDir)) {
    throw new RunDispatchReadError(
      'unsafe_run_path',
      `Run directory for ${runId} resolves outside the runs root; refusing to read it`,
    );
  }
  try {
    return await RunDispatchJournalImpl.peek({
      runDir,
      identity: { run_id: runId, task_id: runId, role_id: READ_IDENTITY_ROLE },
    });
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

/**
 * 行投影：只给事实元数据，并还原**物理行号**。
 *
 * `read()` 返回的 `lines` 已剔除被 repair 跳过的坏行/损坏行，所以要按 `problems` 里的物理
 * 行号补洞，分页游标才与文件行号一致。
 */
function projectJournalLines(read: DispatchJournalReadResult): RunDispatchJournalLine[] {
  const holeLines = new Set<number>();
  for (const problem of read.problems) {
    if (problem.line !== undefined) holeLines.add(problem.line);
  }
  const projected: RunDispatchJournalLine[] = [];
  let physicalLine = 0;
  for (const line of read.lines) {
    physicalLine += 1;
    while (holeLines.has(physicalLine)) physicalLine += 1;
    projected.push(projectJournalLine(line, physicalLine));
  }
  return projected;
}

function projectJournalLine(line: DispatchJournalLine, physicalLine: number): RunDispatchJournalLine {
  const base = { line: physicalLine, event: line.event, at: line.at };
  switch (line.event) {
    case 'accepted':
      return { ...base, dispatch_id: line.dispatch_id, kind: line.brief.kind };
    case 'dispatched':
      return { ...base, dispatch_id: line.dispatch_id };
    case 'settled':
    case 'reconciled':
      return { ...base, dispatch_id: line.dispatch_id, status: line.status };
    default:
      // init / finish / role_round / repair：control 行不属于某个 dispatch。
      return base;
  }
}

/** 折叠摘要；折叠失败（repairable_tail / corrupt / 身份不符）时缺席，不编数字。 */
function summarizeJournal(read: DispatchJournalReadResult): RunDispatchJournalSummary | undefined {
  const first = read.lines[0];
  if (first === undefined) return undefined;
  let fold;
  try {
    fold = foldDispatchJournalLines(read.lines, {
      run_id: first.run_id,
      task_id: first.task_id,
      role_id: first.role_id,
    });
  } catch (error) {
    if (error instanceof RunDispatchJournalError) return undefined;
    throw error;
  }

  const byStatus: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  const unknownDispatchIds: string[] = [];
  const reconciledDispatchIds: string[] = [];
  let violationCount = 0;
  for (const record of fold.records) {
    // 对外摘要采用**有效状态**（原始 settled + 可信 reconciled）；原始 settled 行仍是
    // unknown，`by_status` 不会出现两个互相矛盾的计数（阶段 4 修复 R4-02）。
    const effective = effectiveDispatchRecordStatus(record);
    byStatus[effective] = (byStatus[effective] ?? 0) + 1;
    kinds[record.brief.kind] = (kinds[record.brief.kind] ?? 0) + 1;
    if (effective === 'unknown') unknownDispatchIds.push(record.dispatch_id);
    if (record.status === 'unknown' && effective !== 'unknown') {
      reconciledDispatchIds.push(record.dispatch_id);
    }
    violationCount += record.violations.length;
  }
  return {
    total_dispatches: fold.records.length,
    by_status: byStatus,
    unknown_dispatch_ids: unknownDispatchIds,
    ...(reconciledDispatchIds.length > 0
      ? { reconciled_dispatch_ids: reconciledDispatchIds }
      : {}),
    violation_count: violationCount,
    kinds,
    ...(fold.finish !== undefined
      ? { finish: { status: fold.finish.status, actor: fold.finish.actor, at: fold.finish.at } }
      : {}),
  };
}

/**
 * 为某个 dispatch 找它**已登记**的 evidence ref。
 *
 * 优先级：settled 的不可变侧车（path 由 dispatch_id 派生、sha256 来自 settled 行，并先用
 * `hashExecutionEvidence` 复核行内 evidence 与 sha 同源）→ reconciled 显式 evidence_ref。
 * 找不到就抛「未登记」；行内 hash 失配说明 Journal 本身被改坏，按不可用处理。
 */
function evidenceRefForDispatch(
  read: DispatchJournalReadResult,
  dispatchId: string,
): EvidenceRef {
  let sawDispatch = false;
  let hashMismatch = false;
  const candidates: EvidenceRef[] = [];
  for (const line of read.lines) {
    if (!('dispatch_id' in line) || line.dispatch_id !== dispatchId) continue;
    sawDispatch = true;
    if (line.event === 'settled') {
      const sidecarPath = `${DISPATCH_JOURNAL_DIR}/${DISPATCH_EVIDENCE_DIR}/${dispatchId}.json`;
      if (hashExecutionEvidence(line.evidence) !== line.evidence_sha256) {
        hashMismatch = true;
        continue;
      }
      candidates.push({ path: sidecarPath, sha256: line.evidence_sha256 });
    } else if (line.event === 'reconciled' && line.evidence_ref !== undefined) {
      candidates.push(line.evidence_ref);
    }
  }
  if (candidates.length > 0) return candidates[0]!;
  if (hashMismatch) {
    throw new RunDispatchReadError(
      'dispatch_evidence_unavailable',
      `Journal settled evidence hash for dispatch ${dispatchId} does not match its content`,
      { dispatch_id: dispatchId },
    );
  }
  throw new RunDispatchReadError(
    sawDispatch ? 'dispatch_evidence_not_registered' : 'dispatch_not_in_journal',
    sawDispatch
      ? `Dispatch ${dispatchId} has no registered evidence ref in this run journal`
      : `Dispatch ${dispatchId} does not appear in this run journal`,
    { dispatch_id: dispatchId },
  );
}

// ─────────────────────────────────────────────────────────────
// 内部：参数与语义辅助
// ─────────────────────────────────────────────────────────────

function assertSafeSegment(value: string, label: 'run_id' | 'dispatch_id'): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new RunDispatchReadError(
      label === 'run_id' ? 'unsafe_run_id' : 'unsafe_dispatch_id',
      `${label} is not a safe path segment: ${value}`,
    );
  }
}

function normalizeAfterLine(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new RunDispatchReadError('invalid_page', 'after_line must be an integer >= 0');
  }
  return value;
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new RunDispatchReadError('invalid_page', 'offset must be an integer >= 0');
  }
  return value;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new RunDispatchReadError('invalid_page', 'limit must be a positive integer');
  }
  return value;
}

function unobservedDurability(note: string): DispatchJournalDurability {
  return { mode: 'best_effort', directory_sync: false, notes: [note] };
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
