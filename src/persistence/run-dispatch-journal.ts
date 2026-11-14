/**
 * Run Dispatch Journal：单 Run 派工事实源（append-only JSONL）+ evidence 侧车/受控 ref。
 *
 * 职责与核心逻辑：
 * - 布局固定：`<runDir>/journal/dispatches.jsonl`（一行一条不可变事件）、
 *   `<runDir>/journal/evidence/<dispatch_id>.json`（不可变大证据）、
 *   `<runDir>/journal/repair/<...>.tail`（半写修复时保留的原始残缺字节）。
 *   本文件只做文件 I/O 与 Journal 语义校验；schema 单一来源是
 *   `src/driver/execution-contract.ts`（本模块从 `../driver` barrel 取 schema/纯函数/类型）。
 * - 单 Run 单写者：锁是 `journal/.writer.lock/` **目录**（`mkdirExclusive` 的原子性即互斥），
 *   目录内 `owner.json` 用「tmp wx + fsync + rename」原子写入 `{pid, token, created_at, run_id}`。
 *   回收/释放一律在固定闸门目录 `journal/.writer.lock.reclaim/` 内串行：闸门用 `mkdirExclusive`
 *   原子获得，存在即 fail closed（绝不自动回收）；持闸门后**重新读 owner** 确认仍是死 pid 才删除
 *   陈旧锁目录，然后释放闸门重新竞争。**绝不移动活锁路径**（不存在 rename→校验→还原的窗口）。
 *   每次写路径开始都重读 owner 校验 `token+pid`，不符即 `journal_lock_lost` 且不再写。
 * - 所有写都真实 fsync：每行 UTF-8 JSON 单次 append 后 fsync；完整末行缺换行时先 durable 补
 *   `'\n'` 再写新行；evidence 走「临时文件 fsync → rename → 目录 fsync」。Windows 上目录 fsync
 *   不可用时**不抛业务错误**，而是把 `durability` 降级为
 *   `{mode:'best_effort', directory_sync:false, notes:[...]}`。
 *   因此本模块不宣称断电级持久性，只承诺「单文件 fsync + 身份/hash/对账修复中断窗口」。
 * - 写入顺序（RD-JRN-03）：accepted durable → dispatched durable → driver → evidence durable →
 *   settled durable。任何一次 append 之前都会重读并折叠 journal；坏尾未修复时拒绝追加
 *   （`journal_repair_required`），journal 损坏时 fail closed（`JournalCorruptionError`），
 *   绝不「在坏尾后盲追加」。
 * - 折叠（RD-JRN-04）：按 `entry_id` 去重（同 id 同内容 dedupe、不同内容 conflict）；settled /
 *   reconciled 按语义 hash 去重（忽略 `entry_id`/`at`）；冲突即 `journal_conflict`；settled 必须
 *   先有 dispatched；sequence/身份/hash 不一致 fail closed。派生 `DispatchRecord`：accepted 无
 *   dispatched = `not_executed`，dispatched 无 settled = `unknown`（可信 reconciled 可覆盖 status），
 *   settled = settled.status，迟到 reconciled 只写 `record.reconciled` 不改已发出的终态。
 * - 半写修复（RD-JRN-05）：只容忍末尾一行残缺；修复前把原始字节**原样**写入 repair 侧车并
 *   fsync，再追加 repair 控制行（`discarded_tail_sha256` + `discarded_tail_ref`）；读取时只有
 *   「紧邻 repair 且 sha256 匹配」的坏行才被跳过。中间坏行、无 repair 的坏行、hash 冲突都算损坏。
 * - evidence 受控 ref（RD-EVD-08）：`readEvidence` 只接受已登记 ref（本进程写过的 + 折叠中
 *   settled/reconciled 出现过的 + 显式 `registerEvidenceRef` 的），且必须 path + sha256 **双向**
 *   登记；派生侧车路径绑定 settled 的 `evidence_sha256`，同路径重定义 sha 即
 *   `evidence_ref_conflict`。路径必须是安全相对路径且 realpath 解析后仍在 runDir 内，限大小、
 *   分页、全量校验 sha256。不实现 Agent 工具（阶段 2）。
 * - legacy（RD-JRN-07）：没有 journal 文件时 `read()` 返回 `kind:'legacy'`，不创建文件、不伪造
 *   dispatch 记录；`fold()` 返回空记录集。
 *
 * 不读写生产默认路径、不调用 driver：journal 损坏时本模块只负责拒绝，由上层决定不派工。
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createId } from '../core';
import type {
  AcceptedAppendInput,
  DispatchedAppendInput,
  DispatchJournalEntry,
  DispatchJournalLine,
  DispatchJournalPort,
  DispatchRecord,
  DispatchRecordStatus,
  EvidenceAppendInput,
  EvidenceArtifactRef,
  EvidenceRef,
  ExecutionBrief,
  ExecutionEvidence,
  ForeignRetryAnchor,
  JournalControlEntry,
  JournalFinishEntry,
  JournalInitEntry,
  JournalRepairEntry,
  JournalViolation,
  JournalVerificationClaim,
  ReconciledAppendInput,
  SettledAppendInput,
} from '../driver';
import {
  canonicalJsonStringify,
  DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
  DISPATCH_RECORD_SCHEMA_VERSION,
  DispatchAcceptedJournalEntrySchema,
  DispatchDispatchedJournalEntrySchema,
  DispatchJournalLineSchema,
  DispatchReconciledJournalEntrySchema,
  DispatchRecordSchema,
  DispatchSettledJournalEntrySchema,
  EvidenceRefSchema,
  ExecutionBriefSchema,
  ExecutionEvidenceSchema,
  hashExecutionBrief,
  hashExecutionEvidence,
  isControlJournalEntry,
  isDispatchJournalEntry,
  isSafeRelativeRefPath,
  JournalFinishEntrySchema,
  JournalInitEntrySchema,
  JournalRepairEntrySchema,
  JournalRoleRoundEntrySchema,
  sha256Hex,
} from '../driver';

// ─────────────────────────────────────────────────────────────
// 布局常量与默认上限
// ─────────────────────────────────────────────────────────────

/** Journal 子目录（相对 runDir）。 */
export const DISPATCH_JOURNAL_DIR = 'journal';
/** Journal 文件名（相对 journal 目录）。 */
export const DISPATCH_JOURNAL_FILE = 'dispatches.jsonl';
/** evidence 侧车目录（相对 journal 目录）。 */
export const DISPATCH_EVIDENCE_DIR = 'evidence';
/** repair 侧车目录（相对 journal 目录）。 */
export const DISPATCH_REPAIR_DIR = 'repair';
/** 单写者锁目录名（相对 journal 目录）；锁是**目录**，`mkdir` 的原子性即互斥。 */
export const DISPATCH_JOURNAL_WRITER_LOCK_FILE = '.writer.lock';
/** 回收闸门目录名（相对 journal 目录）：回收/释放必须在闸门内串行，闸门本身绝不自动回收。 */
export const DISPATCH_JOURNAL_RECLAIM_GATE_DIR = '.writer.lock.reclaim';
/** 锁目录内的 owner 记录文件名（tmp wx + rename 原子写入）。 */
const LOCK_OWNER_FILE_NAME = 'owner.json';

/** evidence 全量大小上限（默认 16 MiB）：超过即拒绝，不把大文件读进内存。 */
export const DEFAULT_MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
/** `readEvidence` 单页字节上限（默认 64 KiB）。 */
export const DEFAULT_MAX_EVIDENCE_PAGE_BYTES = 64 * 1024;

/** 锁获取/回收最多尝试次数（闸门串行化后，竞争失败者重试有界）。 */
const LOCK_RECLAIM_ATTEMPTS = 5;
/** dispatch_id 要当文件名用：只允许安全段字符。 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
/** 严格 UTF-8：坏字节直接判为非法行，避免 replacement char 被 JSON 当成合法字符串。 */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const NEWLINE_BYTE = 0x0a;

// ─────────────────────────────────────────────────────────────
// 稳定错误
// ─────────────────────────────────────────────────────────────

/** 本模块所有稳定错误码；调用方据此决定「拒绝派工 / 修复 / 重试」，不解析文案。 */
export type RunDispatchJournalErrorCode =
  | 'journal_locked'
  | 'journal_lock_failed'
  | 'journal_lock_lost'
  | 'journal_not_open'
  | 'journal_duplicate_dispatch'
  | 'journal_sequence_regression'
  | 'journal_retry_not_allowed'
  | 'journal_retry_without_evidence'
  | 'journal_repair_required'
  | 'journal_unknown_dispatch'
  | 'journal_invalid_entry'
  | 'journal_evidence_conflict'
  | 'journal_corrupt'
  | 'journal_conflict'
  | 'journal_hash_mismatch'
  | 'journal_identity_mismatch'
  | 'evidence_ref_not_registered'
  | 'evidence_ref_conflict'
  | 'evidence_ref_invalid'
  | 'evidence_path_unsafe'
  | 'evidence_missing'
  | 'evidence_too_large'
  | 'evidence_hash_mismatch';

/** Journal 语义损坏的稳定码；`JournalCorruptionError` 只用这些。 */
export type JournalCorruptionCode =
  | 'journal_corrupt'
  | 'journal_conflict'
  | 'journal_sequence_regression'
  | 'journal_hash_mismatch'
  | 'journal_identity_mismatch';

/** 一般拒绝（调用方用错 / 状态不允许 / 锁冲突）。 */
export class RunDispatchJournalError extends Error {
  readonly code: RunDispatchJournalErrorCode;
  readonly details: unknown;

  constructor(code: RunDispatchJournalErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'RunDispatchJournalError';
    this.code = code;
    this.details = details;
  }
}

/** Journal 内容损坏：读取/折叠 fail closed，调用方不得继续派工。 */
export class JournalCorruptionError extends RunDispatchJournalError {
  constructor(code: JournalCorruptionCode, message: string, details?: unknown) {
    super(code, message, details);
    this.name = 'JournalCorruptionError';
  }
}

// ─────────────────────────────────────────────────────────────
// 可注入文件 I/O（测试用故障注入 wrapper 在指定调用序号抛错）
// ─────────────────────────────────────────────────────────────

export interface DispatchJournalFileStat {
  size: number;
  mtimeMs: number;
}

/**
 * Journal 需要的最小文件 I/O 面。默认实现见 {@link createNodeDispatchJournalIo}；
 * 测试用 wrapper 计数/注入失败即可覆盖每个持久化边界。
 */
export interface DispatchJournalIo {
  /** 读整个文件；不存在时抛 `ENOENT`（调用方用 `stat` 先判存在）。 */
  readFile(filePath: string): Promise<Uint8Array>;
  /** `wx` 独占写 + fsync + close：已存在抛 `EEXIST`，绝不覆盖。 */
  writeFileExclusive(filePath: string, data: Uint8Array): Promise<void>;
  /** 追加 `line + '\n'`（UTF-8），**单次 write 后 fsync**；`line` 为空串即只追加换行。 */
  appendLineWithFsync(filePath: string, line: string): Promise<void>;
  /** 追加恰好一个 `'\n'` 并 fsync（补齐「完整行缺末尾换行」，见 appendLine）。 */
  appendLineTerminator(filePath: string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
  /** **非递归** mkdir：已存在抛 `EEXIST`（锁目录的原子创建）。 */
  mkdirExclusive(dirPath: string): Promise<void>;
  /** 删除空目录；非空时抛错（锁目录清理由调用方先 unlink 目录内文件）。 */
  rmdir(dirPath: string): Promise<void>;
  readdir(dirPath: string): Promise<string[]>;
  /** 不存在返回 `undefined`（不抛 `ENOENT`）。 */
  stat(filePath: string): Promise<DispatchJournalFileStat | undefined>;
  rename(fromPath: string, toPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  /** 目录 fsync；Windows 上通常抛 `EPERM`，由调用方降级为 best_effort。 */
  syncDirectory(dirPath: string): Promise<void>;
  realpath(filePath: string): Promise<string>;
}

/** Node 默认实现；测试可整体替换。 */
export function createNodeDispatchJournalIo(): DispatchJournalIo {
  return {
    async readFile(filePath) {
      return fs.readFile(filePath);
    },
    async writeFileExclusive(filePath, data) {
      const handle = await fs.open(filePath, 'wx');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async appendLineWithFsync(filePath, line) {
      const handle = await fs.open(filePath, 'a');
      try {
        await handle.writeFile(`${line}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async appendLineTerminator(filePath) {
      const handle = await fs.open(filePath, 'a');
      try {
        await handle.writeFile('\n', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async mkdir(dirPath) {
      await fs.mkdir(dirPath, { recursive: true });
    },
    async mkdirExclusive(dirPath) {
      // 非递归：父目录必须已存在；已存在抛 EEXIST，是锁目录的原子创建原语。
      await fs.mkdir(dirPath);
    },
    async rmdir(dirPath) {
      await fs.rmdir(dirPath);
    },
    async readdir(dirPath) {
      try {
        return await fs.readdir(dirPath);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return [];
        throw error;
      }
    },
    async stat(filePath) {
      try {
        const stat = await fs.stat(filePath);
        return { size: stat.size, mtimeMs: stat.mtimeMs };
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return undefined;
        throw error;
      }
    },
    async rename(fromPath, toPath) {
      await fs.rename(fromPath, toPath);
    },
    async unlink(filePath) {
      await fs.unlink(filePath);
    },
    async syncDirectory(dirPath) {
      const handle = await fs.open(dirPath, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async realpath(filePath) {
      return fs.realpath(filePath);
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 身份、选项、读取结果
// ─────────────────────────────────────────────────────────────

/** Journal 身份：单 Run 单 role 的派工事实源。 */
export interface RunDispatchJournalIdentity {
  run_id: string;
  task_id: string;
  role_id: string;
}

/** 目录 fsync 能力；`best_effort` 表示目录项耐久性未证明，不得宣称断电级持久性。 */
export interface DispatchJournalDurability {
  mode: 'fsync' | 'best_effort';
  directory_sync: boolean;
  notes: string[];
}

export interface RunDispatchJournalOptions {
  /** run 目录（= `.newide/runs/<run_id>` 语义）；测试传临时目录。 */
  runDir: string;
  identity: RunDispatchJournalIdentity;
  io?: DispatchJournalIo;
  /** evidence 全量大小上限；默认 {@link DEFAULT_MAX_EVIDENCE_BYTES}。 */
  maxEvidenceBytes?: number;
  /** `readEvidence` 单页上限；默认 {@link DEFAULT_MAX_EVIDENCE_PAGE_BYTES}。 */
  maxEvidencePageBytes?: number;
}

export type DispatchJournalReadStatus = 'absent' | 'ok' | 'repairable_tail' | 'corrupt';

/** 读取时发现的问题（诊断用；不代表 `status`，`status` 是聚合结论）。 */
export interface DispatchJournalProblem {
  code: string;
  message: string;
  line?: number;
}

/** 末尾半写残缺的原始字节（尚未修复时）。 */
export interface DispatchJournalDiscardedTail {
  bytes: Uint8Array;
  text: string;
  sha256: string;
  byte_length: number;
  /** 文件在残缺行之后是否已带换行（决定修复时是否还需补一个换行）。 */
  terminated: boolean;
  line_number: number;
}

export interface DispatchJournalReadResult {
  kind: 'legacy' | 'journal';
  status: DispatchJournalReadStatus;
  /** 成功解析且未被 repair 跳过的行（含 control 行）。 */
  lines: DispatchJournalLine[];
  /** 派工事件行（accepted/dispatched/settled/reconciled），不含 control。 */
  entries: DispatchJournalEntry[];
  /** init/finish/repair 控制行。 */
  controls: JournalControlEntry[];
  repairs: JournalRepairEntry[];
  discarded_tail?: DispatchJournalDiscardedTail;
  problems: DispatchJournalProblem[];
  durability: DispatchJournalDurability;
}

export interface DispatchJournalFoldIdentity {
  run_id: string;
  task_id: string;
  role_id: string;
}

export interface DispatchJournalFoldResult {
  records: DispatchRecord[];
  byDispatchId: Map<string, DispatchRecord>;
  init: JournalInitEntry | undefined;
  finish: JournalFinishEntry | undefined;
  repairs: JournalRepairEntry[];
  /** 按 `entry_id` 去重后的行数。 */
  entry_count: number;
}

export interface DispatchJournalEvidencePage {
  text: string;
  offset: number;
  limit: number;
  total_bytes: number;
  truncated: boolean;
  sha256: string;
}

export interface ReadDispatchEvidenceOptions {
  offset?: number;
  limit?: number;
}

export interface DispatchJournalRepairResult {
  discarded_tail_sha256: string;
  discarded_tail_ref: EvidenceRef;
  discarded_tail_bytes: number;
  repair_entry: JournalRepairEntry;
}

export interface JournalInitAppendInput {
  autonomy: boolean;
  evidence_only: boolean;
  buffer_v2: boolean;
  max_dispatches: number;
  max_role_rounds: number;
  role_token_budget: number;
  deadline_at: string;
  /** 阶段 2 加法扩展：冻结引擎、工具授权、routing 引用与单 dispatch 超时。 */
  engine?: 'legacy' | 'role_autonomy';
  engine_version?: string;
  tool_allowlist?: string[];
  routing?: { driver_id?: string; profile_id?: string };
  dispatch_timeout_ms?: number;
  /** TaskBudget.max_tool_calls 映射后的任务级工具调用上限。 */
  max_tool_calls?: number;
  entry_id?: string;
  at?: string;
}

export interface JournalFinishAppendInput {
  actor: 'role' | 'host' | 'user';
  status: 'completed' | 'blocked' | 'failed' | 'cancelled' | 'interrupted';
  reason: string;
  evidence_refs: EvidenceRef[];
  /** 阶段 2 role finish 事实（加法扩展）。 */
  summary?: string;
  unresolved?: string[];
  role_reflection?: string;
  response_only?: boolean;
  zero_dispatch?: boolean;
  /** role 对任务要求满足情况的显式陈述（阶段 2 精简后的唯一写入形状）。 */
  verification?: JournalVerificationClaim[];
  entry_id?: string;
  at?: string;
}

/** 单回合预算消费事实（阶段 2 新增 control 行）；恢复时据此还原已消费回合与 token。 */
export interface RoleRoundAppendInput {
  round: number;
  input_tokens?: number;
  output_tokens?: number;
  usage_missing: boolean;
  /** 本回合执行的环境工具调用数（用于恢复任务级 tool-call 预算）。 */
  tool_calls?: number;
  entry_id?: string;
  at?: string;
}

// ─────────────────────────────────────────────────────────────
// 纯函数：折叠
// ─────────────────────────────────────────────────────────────

interface DispatchJournalGroup {
  accepted: DispatchAcceptedJournalEntryLike | undefined;
  dispatched: DispatchDispatchedJournalEntryLike | undefined;
  settled: DispatchSettledJournalEntryLike | undefined;
  reconciled: DispatchReconciledJournalEntryLike | undefined;
}

type DispatchAcceptedJournalEntryLike = Extract<DispatchJournalLine, { event: 'accepted' }>;
type DispatchDispatchedJournalEntryLike = Extract<DispatchJournalLine, { event: 'dispatched' }>;
type DispatchSettledJournalEntryLike = Extract<DispatchJournalLine, { event: 'settled' }>;
type DispatchReconciledJournalEntryLike = Extract<DispatchJournalLine, { event: 'reconciled' }>;

/**
 * 折叠 journal 行 → `DispatchRecord[]`（纯函数，无 I/O）。
 *
 * 规则（RD-JRN-04）：
 * - 按 `entry_id` 去重：同 id 同内容 dedupe，同 id 不同内容 `journal_conflict`；
 * - accepted 的 sequence 必须是 1..N 连续（回退/跳号 `journal_sequence_regression`）；
 * - 派工事件必须出现在自己的 accepted 之后；settled 必须先有 dispatched；
 * - 同一 dispatch 的 settled 按语义 hash（status+evidence_sha256+violations，忽略
 *   `entry_id`/`at`）dedupe，冲突 `journal_conflict`；
 * - reconciled 同样语义 dedupe；无 settled 时允许 unknown→可信 status 的升级；两个不同的可信
 *   status 冲突；
 * - brief/evidence hash 与内容不一致 fail closed（`journal_hash_mismatch`）；
 * - 任何一行的身份与 journal 身份不符 fail closed（`journal_identity_mismatch`）。
 */
export function foldDispatchJournalLines(
  lines: readonly DispatchJournalLine[],
  identity: DispatchJournalFoldIdentity,
): DispatchJournalFoldResult {
  // 1) 身份 + entry_id 去重
  // entry_id 标识「同一次写」：内容除 `at` 外一致即视为同一次写重试（与 append 的幂等语义一致）。
  const seenEntryIds = new Map<string, string>();
  const deduped: DispatchJournalLine[] = [];
  for (const line of lines) {
    assertLineIdentity(line, identity);
    const canonical = canonicalWithoutAt(line);
    const previous = seenEntryIds.get(line.entry_id);
    if (previous !== undefined) {
      if (previous !== canonical) {
        throw new JournalCorruptionError(
          'journal_conflict',
          `journal entry_id ${line.entry_id} was reused by two different lines`,
        );
      }
      continue;
    }
    seenEntryIds.set(line.entry_id, canonical);
    deduped.push(line);
  }

  // 2) 分组 + 序列/阶段校验
  const groups = new Map<string, DispatchJournalGroup>();
  const acceptedOrder: string[] = [];
  const repairs: JournalRepairEntry[] = [];
  let init: JournalInitEntry | undefined;
  let finish: JournalFinishEntry | undefined;

  for (const line of deduped) {
    if (isControlJournalEntry(line)) {
      if (line.event === 'repair') {
        repairs.push(line);
      } else if (line.event === 'init') {
        if (init !== undefined && canonicalWithoutAt(init) !== canonicalWithoutAt(line)) {
          throw new JournalCorruptionError(
            'journal_conflict',
            'journal has conflicting init entries',
          );
        }
        init ??= line;
      } else if (line.event === 'finish') {
        if (finish !== undefined && canonicalWithoutAt(finish) !== canonicalWithoutAt(line)) {
          throw new JournalCorruptionError(
            'journal_conflict',
            'journal has conflicting finish entries',
          );
        }
        finish ??= line;
      }
      // role_round 是预算消费事实，不参与 dispatch 折叠；由恢复逻辑直接读原始行。
      continue;
    }

    let group = groups.get(line.dispatch_id);
    if (group === undefined) {
      group = {
        accepted: undefined,
        dispatched: undefined,
        settled: undefined,
        reconciled: undefined,
      };
      groups.set(line.dispatch_id, group);
    }

    if (line.event === 'accepted') {
      if (group.accepted !== undefined) {
        throw new JournalCorruptionError(
          'journal_conflict',
          `dispatch ${line.dispatch_id} has more than one accepted entry`,
        );
      }
      if (line.sequence !== acceptedOrder.length + 1) {
        throw new JournalCorruptionError(
          'journal_sequence_regression',
          `accepted sequence ${line.sequence} does not continue at ${acceptedOrder.length + 1}`,
        );
      }
      if (hashExecutionBrief(line.brief) !== line.brief_sha256) {
        throw new JournalCorruptionError(
          'journal_hash_mismatch',
          `accepted brief_sha256 does not match brief content for dispatch ${line.dispatch_id}`,
        );
      }
      group.accepted = line;
      acceptedOrder.push(line.dispatch_id);
      continue;
    }

    const accepted = group.accepted;
    if (accepted === undefined) {
      throw new JournalCorruptionError(
        'journal_corrupt',
        `journal ${line.event} for dispatch ${line.dispatch_id} appears before accepted`,
      );
    }
    if (line.sequence !== accepted.sequence) {
      throw new JournalCorruptionError(
        'journal_sequence_regression',
        `journal ${line.event} sequence ${line.sequence} does not match accepted sequence ${accepted.sequence}`,
      );
    }

    if (line.event === 'dispatched') {
      if (group.settled !== undefined) {
        throw new JournalCorruptionError(
          'journal_corrupt',
          `journal dispatched for dispatch ${line.dispatch_id} appears after settled`,
        );
      }
      if (group.dispatched !== undefined) {
        if (dispatchedSemantic(group.dispatched) !== dispatchedSemantic(line)) {
          throw new JournalCorruptionError(
            'journal_conflict',
            `dispatch ${line.dispatch_id} has conflicting dispatched entries`,
          );
        }
        continue;
      }
      group.dispatched = line;
      continue;
    }

    if (line.event === 'settled') {
      if (group.dispatched === undefined) {
        throw new JournalCorruptionError(
          'journal_corrupt',
          `journal settled for dispatch ${line.dispatch_id} appears before dispatched`,
        );
      }
      if (hashExecutionEvidence(line.evidence) !== line.evidence_sha256) {
        throw new JournalCorruptionError(
          'journal_hash_mismatch',
          `settled evidence_sha256 does not match evidence content for dispatch ${line.dispatch_id}`,
        );
      }
      if (group.settled !== undefined) {
        if (settledSemantic(group.settled) !== settledSemantic(line)) {
          throw new JournalCorruptionError(
            'journal_conflict',
            `dispatch ${line.dispatch_id} has conflicting settled entries`,
          );
        }
        continue;
      }
      group.settled = line;
      continue;
    }

    // reconciled：语义 dedupe；unknown→可信升级；两个不同的可信 status 冲突。
    const previous = group.reconciled;
    if (previous !== undefined) {
      if (reconciledSemantic(previous) === reconciledSemantic(line)) continue;
      const previousTrusted = isTrustedReconciledStatus(previous.status);
      const nextTrusted = isTrustedReconciledStatus(line.status);
      if (previousTrusted && nextTrusted && previous.status !== line.status) {
        throw new JournalCorruptionError(
          'journal_conflict',
          `dispatch ${line.dispatch_id} has conflicting reconciled statuses`,
        );
      }
      if (!previousTrusted && nextTrusted) group.reconciled = line;
      continue;
    }
    group.reconciled = line;
  }

  // 3) 派生 DispatchRecord（除 init/finish/repair 外不伪造 dispatch）
  const records: DispatchRecord[] = [];
  const byDispatchId = new Map<string, DispatchRecord>();
  for (const dispatchId of acceptedOrder) {
    const group = groups.get(dispatchId);
    if (group === undefined || group.accepted === undefined) continue;
    const record = buildDispatchRecord(group);
    records.push(record);
    byDispatchId.set(record.dispatch_id, record);
  }

  return {
    records,
    byDispatchId,
    init,
    finish,
    repairs,
    entry_count: deduped.length,
  };
}

function buildDispatchRecord(group: DispatchJournalGroup): DispatchRecord {
  const accepted = group.accepted;
  if (accepted === undefined) {
    throw new JournalCorruptionError(
      'journal_corrupt',
      'dispatch record requires an accepted entry',
    );
  }

  let phase: 'accepted' | 'dispatched' | 'settled' = 'accepted';
  let status: DispatchRecordStatus = 'not_executed';
  let evidence: ExecutionEvidence | undefined;
  let evidenceSha256: string | undefined;
  let violations: JournalViolation[] = [];
  let settledAt: string | undefined;

  if (group.settled !== undefined) {
    phase = 'settled';
    status = group.settled.status;
    evidence = group.settled.evidence;
    evidenceSha256 = group.settled.evidence_sha256;
    violations = [...group.settled.violations];
    settledAt = group.settled.at;
  } else if (group.dispatched !== undefined) {
    phase = 'dispatched';
    status = 'unknown';
    // 可信 reconciled 可以覆盖 unknown（unknown→succeeded/failed 的一次升级）。
    const reconciled = group.reconciled;
    if (reconciled !== undefined && reconciled.status !== 'unknown') status = reconciled.status;
  } else if (group.reconciled !== undefined) {
    // 没有 dispatched 行，但 ADP/transport receipt 已证明交付：回执优先于本地猜测，
    // 不得再判 not_executed（契约 RD-JRN-04）。
    status = group.reconciled.status;
  }

  const recordInput: Record<string, unknown> = {
    schema_version: DISPATCH_RECORD_SCHEMA_VERSION,
    dispatch_id: accepted.dispatch_id,
    run_id: accepted.run_id,
    task_id: accepted.task_id,
    role_id: accepted.role_id,
    sequence: accepted.sequence,
    phase,
    status,
    brief: accepted.brief,
    brief_sha256: accepted.brief_sha256,
    violations,
    accepted_at: accepted.at,
  };
  if (evidence !== undefined) recordInput.evidence = evidence;
  if (evidenceSha256 !== undefined) recordInput.evidence_sha256 = evidenceSha256;
  if (group.dispatched !== undefined) {
    recordInput.dispatched_at = group.dispatched.at;
    if (group.dispatched.adp_exchange_id !== undefined) {
      recordInput.adp_exchange_id = group.dispatched.adp_exchange_id;
    }
    if (group.dispatched.session_id !== undefined) {
      recordInput.session_id = group.dispatched.session_id;
    }
  }
  if (settledAt !== undefined) recordInput.settled_at = settledAt;
  if (group.reconciled !== undefined) {
    const reconciled: Record<string, unknown> = {
      status: group.reconciled.status,
      reason: group.reconciled.reason,
      at: group.reconciled.at,
    };
    if (group.reconciled.evidence_ref !== undefined) {
      reconciled.evidence_ref = group.reconciled.evidence_ref;
    }
    recordInput.reconciled = reconciled;
  }

  return DispatchRecordSchema.parse(recordInput);
}

function assertLineIdentity(
  line: DispatchJournalLine,
  identity: DispatchJournalFoldIdentity,
): void {
  if (
    line.run_id !== identity.run_id ||
    line.task_id !== identity.task_id ||
    line.role_id !== identity.role_id
  ) {
    throw new JournalCorruptionError(
      'journal_identity_mismatch',
      `journal line ${line.entry_id} does not belong to run ${identity.run_id} / task ${identity.task_id} / role ${identity.role_id}`,
    );
  }
}

function canonicalWithoutAt(value: object): string {
  const { at: _at, ...rest } = value as Record<string, unknown>;
  return canonicalJsonStringify(rest);
}

function dispatchedSemantic(entry: DispatchDispatchedJournalEntryLike): string {
  return canonicalJsonStringify({
    adp_exchange_id: entry.adp_exchange_id ?? null,
    session_id: entry.session_id ?? null,
  });
}

function settledSemantic(entry: {
  status: string;
  evidence_sha256: string;
  violations: readonly JournalViolation[];
}): string {
  return canonicalJsonStringify({
    status: entry.status,
    evidence_sha256: entry.evidence_sha256,
    violations: [...entry.violations].sort(),
  });
}

function reconciledSemantic(entry: DispatchReconciledJournalEntryLike): string {
  return canonicalJsonStringify({
    status: entry.status,
    reason: entry.reason,
    evidence_ref: entry.evidence_ref ?? null,
    evidence_sha256: entry.evidence_sha256 ?? null,
  });
}

function isTrustedReconciledStatus(status: 'succeeded' | 'failed' | 'unknown'): boolean {
  return status !== 'unknown';
}

function emptyFoldResult(): DispatchJournalFoldResult {
  return {
    records: [],
    byDispatchId: new Map(),
    init: undefined,
    finish: undefined,
    repairs: [],
    entry_count: 0,
  };
}

// ─────────────────────────────────────────────────────────────
// RunDispatchJournal
// ─────────────────────────────────────────────────────────────

/** Journal 实例生命周期：`open` → `closing` → `closed`，只前进、不回退。 */
type JournalLifecycle = 'open' | 'closing' | 'closed';

/**
 * 单 Run 单写者的 dispatch journal。用法：
 *
 * ```ts
 * const journal = await RunDispatchJournal.open({ runDir, identity });
 * await journal.appendAccepted({ brief, brief_sha256, budget_before });
 * await journal.appendDispatched({ dispatch_id });
 * const evidenceRef = await journal.appendEvidence({ dispatch_id, evidence });
 * await journal.appendSettled({ dispatch_id, status, evidence, evidence_sha256, violations });
 * await journal.close();
 * ```
 *
 * 所有 append 在写之前都会重读并折叠 journal（单写者，代价可接受），因此坏尾/损坏会被
 * 当场拒绝，而不是被追加掩盖。
 *
 * **实例内串行化与生命周期（复审修复）**：所有修改入口（`append*`、`appendEvidence`、
 * `repairTail`、`registerEvidenceRef(s)`）都经 {@link enqueueMutation} 排队，临界区覆盖
 * 「读状态 → 校验 → 改文件/侧车 → fsync → 更新内部状态」整段，因此同实例不会出现两个
 * append 读同一旧快照、各自通过 sequence 校验后写出相同 sequence 的竞争。
 *
 * `close()` **同步**进入 `closing`：此后到达的修改请求立即 `journal_not_open`；已准入的
 * 请求（无论已在执行还是仍在排队）全部执行完才释放写锁，随后进入 `closed`（旧实例不再写
 * journal 或侧车）。并发 `close()` 共享同一个关闭 Promise，都等实际关闭完成。因此
 * 「A 在途 append → A.close() 释放锁 → B 拿到锁 → A 的旧写入才落地」这个双写者窗口被消除：
 * 锁在 A 的修改真正结束前不会被释放。
 */
export class RunDispatchJournal implements DispatchJournalPort {
  private readonly io: DispatchJournalIo;
  private readonly runDir: string;
  private readonly realRunDir: string;
  private readonly identity: RunDispatchJournalIdentity;
  private readonly maxEvidenceBytes: number;
  private readonly maxEvidencePageBytes: number;
  private readonly registeredRefs = new Map<string, Set<string>>();
  /** engine 注入的祖先 dispatch 锚点（只读元数据，不参与折叠）。 */
  private foreignRetryAnchors: readonly ForeignRetryAnchor[] = [];
  private durability: DispatchJournalDurability = {
    mode: 'fsync',
    directory_sync: true,
    notes: [],
  };
  private lockHeld = false;
  private lockToken: string | undefined;
  /** `close()` 一开始（同步）就进入 `closing`；排空修改队列、释放锁后进入 `closed`。 */
  private lifecycle: JournalLifecycle = 'open';
  /**
   * 修改操作串行队列的尾。只承载已通过准入（close 之前调用）的操作，且**永不 reject**：
   * 每个操作的结果只回传给自己的调用方，单个失败不会毒化后续操作。
   */
  private mutationTail: Promise<void> = Promise.resolve();
  /** 并发 `close()` 共享同一个关闭 Promise：都等实际关闭完成，不提前返回。 */
  private closePromise: Promise<void> | undefined;
  private journalFileExists = false;

  private constructor(
    io: DispatchJournalIo,
    runDir: string,
    realRunDir: string,
    identity: RunDispatchJournalIdentity,
    maxEvidenceBytes: number,
    maxEvidencePageBytes: number,
  ) {
    this.io = io;
    this.runDir = runDir;
    this.realRunDir = realRunDir;
    this.identity = identity;
    this.maxEvidenceBytes = maxEvidenceBytes;
    this.maxEvidencePageBytes = maxEvidencePageBytes;
  }

  /**
   * 只读打开：**不取写锁、不创建目录/文件**。用于阶段 2 引擎选路/恢复时读取冻结记录；
   * 调用方对 `ENOENT`（run 目录/日志不存在）应视为「无冻结记录」。
   */
  static async peek(
    options: Pick<RunDispatchJournalOptions, 'runDir' | 'identity' | 'io'>,
  ): Promise<RunDispatchJournal> {
    const io = options.io ?? createNodeDispatchJournalIo();
    const identity = normalizeIdentity(options.identity);
    const runDir = path.resolve(options.runDir);
    const realRunDir = await io.realpath(runDir);
    const journal = new RunDispatchJournal(
      io,
      runDir,
      realRunDir,
      identity,
      DEFAULT_MAX_EVIDENCE_BYTES,
      DEFAULT_MAX_EVIDENCE_PAGE_BYTES,
    );
    journal.journalFileExists = (await io.stat(journal.journalFilePath)) !== undefined;
    return journal;
  }

  /** 打开 journal 并取得独占写锁；已有活锁时抛 `journal_locked`。 */
  static async open(options: RunDispatchJournalOptions): Promise<RunDispatchJournal> {
    const io = options.io ?? createNodeDispatchJournalIo();
    const identity = normalizeIdentity(options.identity);
    const runDir = path.resolve(options.runDir);
    await io.mkdir(path.join(runDir, DISPATCH_JOURNAL_DIR));
    const realRunDir = await io.realpath(runDir);
    const maxEvidenceBytes = options.maxEvidenceBytes ?? DEFAULT_MAX_EVIDENCE_BYTES;
    const maxEvidencePageBytes = options.maxEvidencePageBytes ?? DEFAULT_MAX_EVIDENCE_PAGE_BYTES;
    if (!Number.isInteger(maxEvidenceBytes) || maxEvidenceBytes <= 0) {
      throw new RunDispatchJournalError(
        'journal_invalid_entry',
        'maxEvidenceBytes must be a positive integer',
      );
    }
    if (!Number.isInteger(maxEvidencePageBytes) || maxEvidencePageBytes <= 0) {
      throw new RunDispatchJournalError(
        'journal_invalid_entry',
        'maxEvidencePageBytes must be a positive integer',
      );
    }
    const journal = new RunDispatchJournal(
      io,
      runDir,
      realRunDir,
      identity,
      maxEvidenceBytes,
      maxEvidencePageBytes,
    );
    await journal.acquireWriterLock();
    journal.journalFileExists = (await io.stat(journal.journalFilePath)) !== undefined;
    return journal;
  }

  get runDirPath(): string {
    return this.runDir;
  }

  get journalDir(): string {
    return path.join(this.runDir, DISPATCH_JOURNAL_DIR);
  }

  get journalFilePath(): string {
    return path.join(this.journalDir, DISPATCH_JOURNAL_FILE);
  }

  get evidenceDir(): string {
    return path.join(this.journalDir, DISPATCH_EVIDENCE_DIR);
  }

  get repairDir(): string {
    return path.join(this.journalDir, DISPATCH_REPAIR_DIR);
  }

  /** 当前 durability 快照（目录 fsync 失败后降级为 best_effort）。 */
  get currentDurability(): DispatchJournalDurability {
    return this.snapshotDurability();
  }

  /**
   * 开始关闭并返回关闭完成的 Promise；幂等，并发调用共享同一个 Promise。
   *
   * `closing` 同步生效：之后到达的修改请求立即被拒绝；已准入的修改（执行中或排队中）全部
   * 结束后才释放锁。释放协议与之前一致：绝不移动活锁路径，先拿回收闸门（闸门忙 → 原样保留
   * 锁、不抛错），**持闸门后重新读 owner**，只有 `token` + `pid` 都是自己的才删除自己的锁
   * 目录；否则原样保留（所有权已丢失/新持有者），最后释放闸门。
   */
  close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  /**
   * 实际关闭：`closing`（同步，见 {@link close}）→ 等待修改队列排空 → 释放写锁 → `closed`。
   *
   * 队列中已准入的操作各自把成功/失败回传给自己的调用方，close 不吞掉也不重抛它们；
   * 释放锁失败（闸门忙）按既有语义保留锁、不抛错。close 正常完成时 lock 已不再持有，
   * 生命周期为 `closed`，旧实例后续任何修改都会被拒绝。
   */
  private async performClose(): Promise<void> {
    this.lifecycle = 'closing';
    await this.mutationTail;
    try {
      await this.releaseWriterLock();
    } finally {
      this.lifecycle = 'closed';
    }
  }

  /** 释放写锁（原 close 的锁释放部分）；所有权不符或闸门忙时原样保留锁，不抛错。 */
  private async releaseWriterLock(): Promise<void> {
    if (!this.lockHeld) return;
    const token = this.lockToken;
    this.lockHeld = false;
    this.lockToken = undefined;

    try {
      await this.acquireReclaimGate();
    } catch {
      // 闸门忙或创建失败：保留锁原样，不抛错（下次 open 会因闸门/活锁 fail closed）。
      return;
    }
    try {
      const owner = parseLockOwner(await this.readOwnerBytes(this.lockFilePath()));
      if (owner !== undefined && owner.pid === process.pid && owner.token === token) {
        await this.removeLockDirectoryQuietly(this.lockFilePath());
      }
      // 所有权不符（新持有者/被替换）：原样保留，绝不删除别人的锁。
    } finally {
      await this.releaseReclaimGate();
    }
  }

  /**
   * 修改操作的准入 + 串行化：**同步**检查生命周期并把操作挂到队列尾。
   *
   * - `closing`/`closed` 期间到达的请求立即 `journal_not_open`，绝不排队等待；
   * - close 之前已准入的请求（包括尚未开始执行的）是关闭的一部分：全部执行完才释放锁，
   *   不会静默丢弃；
   * - 队列尾只保留兑现，单个操作失败不影响后续操作；原始错误只回传给该调用方；
   * - 每个操作的临界区都重新读取真实持久化状态（`loadForAppend`），因此前一个失败后，
   *   后续操作按磁盘现状成功或明确 fail closed，不会沿用陈旧内存快照。
   */
  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lifecycle !== 'open') {
      return Promise.reject(
        new RunDispatchJournalError(
          'journal_not_open',
          this.lifecycle === 'closing'
            ? 'dispatch journal is closing; mutation was rejected before it started'
            : 'dispatch journal is closed',
        ),
      );
    }
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ── 读 ─────────────────────────────────────────────────────

  /**
   * 读取并分类 journal。不创建文件、不修复、不抛损坏错误（损坏通过 `status`/`problems`
   * 表达，由 `fold()` 决定 fail closed）。
   */
  async read(): Promise<DispatchJournalReadResult> {
    const stat = await this.io.stat(this.journalFilePath);
    if (stat === undefined) {
      return {
        kind: 'legacy',
        status: 'absent',
        lines: [],
        entries: [],
        controls: [],
        repairs: [],
        problems: [],
        durability: this.snapshotDurability(),
      };
    }

    const bytes = await this.io.readFile(this.journalFilePath);
    const { lines: rawLines, terminated } = splitRawLines(bytes);
    const lines: DispatchJournalLine[] = [];
    const repairs: JournalRepairEntry[] = [];
    const problems: DispatchJournalProblem[] = [];
    let corrupt = false;
    let repairable: DispatchJournalDiscardedTail | undefined;

    for (let index = 0; index < rawLines.length; index += 1) {
      const raw = rawLines[index];
      if (raw === undefined) continue;
      const lineNumber = index + 1;
      const line = parseJournalLine(raw);
      if (line !== undefined) {
        lines.push(line);
        if (line.event === 'repair') repairs.push(line);
        continue;
      }

      const isLast = index === rawLines.length - 1;
      const nextRaw = index + 1 < rawLines.length ? rawLines[index + 1] : undefined;
      let skipped = false;
      if (nextRaw !== undefined) {
        const nextLine = parseJournalLine(nextRaw);
        if (nextLine !== undefined && nextLine.event === 'repair') {
          const rawHash = sha256Hex(raw);
          if (nextLine.discarded_tail_sha256 !== rawHash) {
            corrupt = true;
            problems.push({
              code: 'journal_repair_hash_mismatch',
              message: 'bad journal line is followed by a repair entry whose hash does not match',
              line: lineNumber,
            });
          } else if (!(await this.repairSidecarMatches(nextLine))) {
            corrupt = true;
            problems.push({
              code: 'journal_repair_sidecar_mismatch',
              message: 'repair sidecar is missing or does not match the discarded tail hash',
              line: lineNumber,
            });
          } else {
            skipped = true;
            problems.push({
              code: 'skipped_repaired_line',
              message: 'skipped half-written line preserved by the following repair entry',
              line: lineNumber,
            });
          }
        }
      }
      if (skipped) continue;

      if (isLast) {
        repairable = {
          bytes: raw,
          text: decodeUtf8Lossy(raw),
          sha256: sha256Hex(raw),
          byte_length: raw.byteLength,
          terminated,
          line_number: lineNumber,
        };
        problems.push({
          code: 'repairable_tail',
          message: 'journal ends with a half-written line that can be repaired',
          line: lineNumber,
        });
        continue;
      }

      corrupt = true;
      problems.push({
        code: 'corrupt_line',
        message: 'journal line is not a valid dispatch journal entry',
        line: lineNumber,
      });
    }

    const status: DispatchJournalReadStatus = corrupt
      ? 'corrupt'
      : repairable !== undefined
        ? 'repairable_tail'
        : 'ok';

    return {
      kind: 'journal',
      status,
      lines,
      entries: lines.filter(isDispatchJournalEntry),
      controls: lines.filter(isControlJournalEntry),
      repairs,
      ...(repairable !== undefined ? { discarded_tail: repairable } : {}),
      problems,
      durability: this.snapshotDurability(),
    };
  }

  /**
   * 折叠当前 journal。损坏或可修复尾部都 fail closed（`JournalCorruptionError`）：
   * 调用方据此不派工、不成功 finish，先修复或走 legacy 只读路径。
   */
  async fold(): Promise<DispatchJournalFoldResult> {
    const snapshot = await this.read();
    if (snapshot.kind === 'legacy') return emptyFoldResult();
    if (snapshot.status === 'repairable_tail') {
      throw new JournalCorruptionError(
        'journal_corrupt',
        'journal has a half-written tail; call repairTail() before folding',
        { discarded_tail_sha256: snapshot.discarded_tail?.sha256 },
      );
    }
    if (snapshot.status === 'corrupt') {
      throw new JournalCorruptionError('journal_corrupt', 'journal is corrupt', {
        problems: snapshot.problems,
      });
    }
    return foldDispatchJournalLines(snapshot.lines, this.identity);
  }

  /** 修复末尾半写：原字节写侧车（不覆盖、不丢字节）→ 终止坏行 → 追加 repair 行。 */
  async repairTail(
    options: { reason?: string } = {},
  ): Promise<DispatchJournalRepairResult | undefined> {
    return this.enqueueMutation(() => this.repairTailNow(options));
  }

  private async repairTailNow(options: {
    reason?: string;
  }): Promise<DispatchJournalRepairResult | undefined> {
    await this.assertLockOwnership();
    const snapshot = await this.read();
    if (snapshot.kind === 'legacy' || snapshot.status === 'ok') return undefined;
    if (snapshot.status === 'corrupt') {
      throw new JournalCorruptionError(
        'journal_corrupt',
        'journal has non-repairable corruption; repairTail refuses to touch it',
        { problems: snapshot.problems },
      );
    }
    const tail = snapshot.discarded_tail;
    if (tail === undefined) {
      throw new JournalCorruptionError('journal_corrupt', 'repairable tail is missing its bytes');
    }

    // 1) 原始残缺字节原样落侧车（wx：绝不覆盖既有历史）。
    const relativeRefPath = this.nextRepairRefPath(tail.sha256);
    const sidecarPath = path.resolve(this.runDir, relativeRefPath);
    await this.io.mkdir(path.dirname(sidecarPath));
    await this.io.writeFileExclusive(sidecarPath, tail.bytes);
    const writtenBytes = await this.io.readFile(sidecarPath);
    if (sha256Hex(writtenBytes) !== tail.sha256) {
      throw new RunDispatchJournalError(
        'journal_hash_mismatch',
        'repair sidecar bytes do not match the discarded tail hash',
      );
    }
    await this.trySyncDirectory(path.dirname(sidecarPath));

    // 2) 坏行若还没有换行，先 durable 补一个换行让它成为独立行（失败也不丢侧车）。
    if (!tail.terminated) {
      await this.io.appendLineTerminator(this.journalFilePath);
      this.journalFileExists = true;
    }

    // 3) 追加 repair 控制行。
    const repairEntry = JournalRepairEntrySchema.parse({
      schema_version: DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
      entry_id: createId('jrn'),
      run_id: this.identity.run_id,
      task_id: this.identity.task_id,
      role_id: this.identity.role_id,
      at: new Date().toISOString(),
      event: 'repair',
      discarded_tail_sha256: tail.sha256,
      discarded_tail_ref: { path: relativeRefPath, sha256: tail.sha256 },
      reason: options.reason ?? 'repairing half-written journal tail',
    });
    await this.appendLine(repairEntry);

    const after = await this.read();
    if (after.status !== 'ok') {
      throw new JournalCorruptionError(
        'journal_corrupt',
        'journal is still not readable after repairing the tail',
        { problems: after.problems },
      );
    }

    return {
      discarded_tail_sha256: tail.sha256,
      discarded_tail_ref: { path: relativeRefPath, sha256: tail.sha256 },
      discarded_tail_bytes: tail.byte_length,
      repair_entry: repairEntry,
    };
  }

  // ── append（DispatchJournalPort） ──────────────────────────

  /** `accepted`：校验身份/sequence/hash/retry_of 后 durable 追加。 */
  async appendAccepted(input: AcceptedAppendInput): Promise<void> {
    return this.enqueueMutation(() => this.appendAcceptedNow(input));
  }

  private async appendAcceptedNow(input: AcceptedAppendInput): Promise<void> {
    const { snapshot, fold } = await this.loadForAppend();
    const brief = parseBrief(input.brief);
    const briefSha256 = verifyBriefSha256(brief, input.brief_sha256);
    assertBriefIdentity(brief, this.identity);
    if (input.at !== undefined && input.at !== brief.accepted_at) {
      throw new RunDispatchJournalError(
        'journal_invalid_entry',
        'accepted entry at must equal brief.accepted_at',
      );
    }
    const at = brief.accepted_at;
    const entryId = input.entry_id ?? createId('jrn');
    const line = DispatchAcceptedJournalEntrySchema.parse({
      schema_version: DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
      entry_id: entryId,
      dispatch_id: brief.dispatch_id,
      run_id: brief.run_id,
      task_id: brief.task_id,
      role_id: brief.role_id,
      sequence: brief.sequence,
      at,
      event: 'accepted',
      brief,
      brief_sha256: briefSha256,
      budget_before: input.budget_before,
    });

    if (dedupeByEntryId(snapshot, line)) return;

    if (fold.byDispatchId.has(brief.dispatch_id)) {
      throw new RunDispatchJournalError(
        'journal_duplicate_dispatch',
        `dispatch ${brief.dispatch_id} already has journal records; replay is not allowed`,
      );
    }
    const expectedSequence = fold.records.length + 1;
    if (brief.sequence !== expectedSequence) {
      throw new RunDispatchJournalError(
        'journal_sequence_regression',
        `dispatch sequence ${brief.sequence} must continue at ${expectedSequence}`,
      );
    }
    if (brief.retry_of !== undefined) {
      this.assertRetryAllowed(fold, brief);
    }

    await this.appendLine(line);
  }

  /** `dispatched`：driver 调用前的 durable 标记；同一 dispatch 只能一次。 */
  async appendDispatched(input: DispatchedAppendInput): Promise<void> {
    return this.enqueueMutation(() => this.appendDispatchedNow(input));
  }

  private async appendDispatchedNow(input: DispatchedAppendInput): Promise<void> {
    const { snapshot, fold } = await this.loadForAppend();
    const record = this.requireRecord(fold, input.dispatch_id);
    const at = input.at ?? new Date().toISOString();
    const entryId = input.entry_id ?? createId('jrn');
    const lineInput: Record<string, unknown> = {
      schema_version: DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
      entry_id: entryId,
      dispatch_id: record.dispatch_id,
      run_id: record.run_id,
      task_id: record.task_id,
      role_id: record.role_id,
      sequence: record.sequence,
      at,
      event: 'dispatched',
    };
    if (input.adp_exchange_id !== undefined) lineInput.adp_exchange_id = input.adp_exchange_id;
    if (input.session_id !== undefined) lineInput.session_id = input.session_id;
    const line = DispatchDispatchedJournalEntrySchema.parse(lineInput);

    if (dedupeByEntryId(snapshot, line)) return;

    if (record.phase === 'settled') {
      throw new RunDispatchJournalError(
        'journal_conflict',
        `dispatch ${record.dispatch_id} is already settled; dispatched cannot be appended`,
      );
    }
    if (record.phase === 'dispatched') {
      if (dispatchedSemanticFromRecord(record) === dispatchedSemantic(line)) return;
      throw new RunDispatchJournalError(
        'journal_conflict',
        `dispatch ${record.dispatch_id} already has a different dispatched entry`,
      );
    }

    await this.appendLine(line);
  }

  /**
   * evidence 侧车：临时文件 fsync → rename → 目录 fsync；同 dispatch 同 hash 幂等，
   * 不同 hash 即 `journal_evidence_conflict`（不可变）。
   *
   * 侧车写入的是 **canonical JSON 字节**（递归按键排序），因此
   * `ref.sha256 === hashExecutionEvidence(evidence)`：调用方可以把 `appendEvidence` 返回的
   * `ref.sha256` 直接作为 `appendSettled({ evidence_sha256 })`，两个 hash 同源，不需要再区分
   * 「文件字节 hash」与「canonical hash」。读取/幂等比较仍按文件字节 hash（不变）。
   */
  async appendEvidence(input: EvidenceAppendInput): Promise<EvidenceArtifactRef> {
    return this.enqueueMutation(() => this.appendEvidenceNow(input));
  }

  private async appendEvidenceNow(input: EvidenceAppendInput): Promise<EvidenceArtifactRef> {
    const { fold } = await this.loadForAppend();
    const record = this.requireRecord(fold, input.dispatch_id);
    const evidence = parseEvidence(input.evidence);
    if (evidence.dispatch_id !== input.dispatch_id) {
      throw new RunDispatchJournalError(
        'journal_identity_mismatch',
        `evidence dispatch_id ${evidence.dispatch_id} does not match ${input.dispatch_id}`,
      );
    }
    const segment = assertSafePathSegment(input.dispatch_id, 'dispatch_id');
    const relativePath = `${DISPATCH_JOURNAL_DIR}/${DISPATCH_EVIDENCE_DIR}/${segment}.json`;
    const target = path.join(this.evidenceDir, `${segment}.json`);
    // canonical 字节：ref.sha256 必须与 settled 的 evidence_sha256 同源（都等于
    // hashExecutionEvidence），否则正常 dispatch 会在 settled 阶段被 hash 校验拒绝。
    const canonical = canonicalJsonStringify(evidence);
    const data = Buffer.from(canonical, 'utf8');
    const fileSha256 = sha256Hex(data);
    const evidenceSha256 = hashExecutionEvidence(evidence);
    if (fileSha256 !== evidenceSha256) {
      throw new RunDispatchJournalError(
        'journal_hash_mismatch',
        'evidence sidecar bytes are not same-source with hashExecutionEvidence',
        { file_sha256: fileSha256, evidence_sha256: evidenceSha256 },
      );
    }
    const ref: EvidenceRef = { path: relativePath, sha256: fileSha256 };

    const existing = await this.readFileIfExists(target);
    if (existing !== undefined) {
      if (sha256Hex(existing) !== fileSha256) {
        throw new RunDispatchJournalError(
          'journal_evidence_conflict',
          `evidence sidecar for dispatch ${input.dispatch_id} already exists with different content`,
        );
      }
      this.rememberEvidenceRef(ref);
      return { ref, sha256: fileSha256 };
    }

    // 显式登记过同一路径的不同 sha：写入前就拒绝，避免「文件写了但登记冲突」的半完成状态。
    const registeredShas = this.registeredRefs.get(relativePath);
    if (registeredShas !== undefined && !registeredShas.has(fileSha256)) {
      throw new RunDispatchJournalError(
        'evidence_ref_conflict',
        `evidence ref path ${relativePath} is already registered with a different sha256`,
      );
    }

    if (record.phase === 'accepted') {
      throw new RunDispatchJournalError(
        'journal_conflict',
        `dispatch ${record.dispatch_id} has no dispatched entry; evidence cannot be written yet`,
      );
    }

    await this.io.mkdir(this.evidenceDir);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.io.writeFileExclusive(temporary, data);
      await this.io.rename(temporary, target);
    } catch (error) {
      try {
        await this.io.unlink(temporary);
      } catch {
        // 临时文件清理失败不影响主错误。
      }
      // I/O 失败原样抛出：调用方据此停止派工；不伪装成「内容冲突」。
      throw error;
    }
    await this.trySyncDirectory(this.evidenceDir);
    this.rememberEvidenceRef(ref);
    return { ref, sha256: fileSha256 };
  }

  /** `settled`：必须已有 dispatched；同一 dispatch 的语义重复幂等，冲突 fail closed。 */
  async appendSettled(input: SettledAppendInput): Promise<void> {
    return this.enqueueMutation(() => this.appendSettledNow(input));
  }

  private async appendSettledNow(input: SettledAppendInput): Promise<void> {
    const { snapshot, fold } = await this.loadForAppend();
    const evidence = parseEvidence(input.evidence);
    if (evidence.dispatch_id !== input.dispatch_id) {
      throw new RunDispatchJournalError(
        'journal_identity_mismatch',
        `evidence dispatch_id ${evidence.dispatch_id} does not match ${input.dispatch_id}`,
      );
    }
    const evidenceSha256 = verifyEvidenceSha256(evidence, input.evidence_sha256);
    if (input.status !== evidence.status) {
      throw new RunDispatchJournalError(
        'journal_conflict',
        `settled status ${input.status} must equal evidence.status ${evidence.status}`,
      );
    }
    const record = this.requireRecord(fold, input.dispatch_id);
    const at = input.at ?? new Date().toISOString();
    const entryId = input.entry_id ?? createId('jrn');
    const line = DispatchSettledJournalEntrySchema.parse({
      schema_version: DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
      entry_id: entryId,
      dispatch_id: record.dispatch_id,
      run_id: record.run_id,
      task_id: record.task_id,
      role_id: record.role_id,
      sequence: record.sequence,
      at,
      event: 'settled',
      status: input.status,
      evidence,
      evidence_sha256: evidenceSha256,
      violations: [...input.violations],
    });

    if (record.phase === 'settled') {
      if (settledSemanticFromRecord(record) === settledSemantic(line)) return;
      throw new RunDispatchJournalError(
        'journal_conflict',
        `dispatch ${record.dispatch_id} already has a conflicting settled entry`,
      );
    }
    if (record.phase !== 'dispatched') {
      throw new RunDispatchJournalError(
        'journal_conflict',
        `dispatch ${record.dispatch_id} has no dispatched entry; settled cannot be appended`,
      );
    }
    if (dedupeByEntryId(snapshot, line)) return;

    await this.appendLine(line);
  }

  /** `reconciled`：迟到/对账结果；不改已 settled 的终态，只记录。 */
  async appendReconciled(input: ReconciledAppendInput): Promise<void> {
    return this.enqueueMutation(() => this.appendReconciledNow(input));
  }

  private async appendReconciledNow(input: ReconciledAppendInput): Promise<void> {
    const { snapshot, fold } = await this.loadForAppend();
    const record = this.requireRecord(fold, input.dispatch_id);
    let evidence: ExecutionEvidence | undefined;
    let evidenceSha256: string | undefined;
    if (input.evidence !== undefined) {
      evidence = parseEvidence(input.evidence);
      if (evidence.dispatch_id !== input.dispatch_id) {
        throw new RunDispatchJournalError(
          'journal_identity_mismatch',
          `reconciled evidence dispatch_id ${evidence.dispatch_id} does not match ${input.dispatch_id}`,
        );
      }
      if (input.evidence_sha256 === undefined) {
        throw new RunDispatchJournalError(
          'journal_invalid_entry',
          'reconciled evidence requires evidence_sha256',
        );
      }
      evidenceSha256 = verifyEvidenceSha256(evidence, input.evidence_sha256);
      if (input.status !== evidence.status) {
        throw new RunDispatchJournalError(
          'journal_conflict',
          `reconciled status ${input.status} must equal evidence.status ${evidence.status}`,
        );
      }
    } else if (input.evidence_sha256 !== undefined) {
      throw new RunDispatchJournalError(
        'journal_invalid_entry',
        'reconciled evidence_sha256 requires evidence',
      );
    }

    const at = input.at ?? new Date().toISOString();
    const entryId = input.entry_id ?? createId('jrn');
    const lineInput: Record<string, unknown> = {
      schema_version: DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
      entry_id: entryId,
      dispatch_id: record.dispatch_id,
      run_id: record.run_id,
      task_id: record.task_id,
      role_id: record.role_id,
      sequence: record.sequence,
      at,
      event: 'reconciled',
      status: input.status,
      reason: input.reason,
    };
    if (input.evidence_ref !== undefined) lineInput.evidence_ref = input.evidence_ref;
    if (evidence !== undefined) lineInput.evidence = evidence;
    if (evidenceSha256 !== undefined) lineInput.evidence_sha256 = evidenceSha256;
    const line = DispatchReconciledJournalEntrySchema.parse(lineInput);

    if (dedupeByEntryId(snapshot, line)) return;
    if (record.reconciled !== undefined) {
      const previous = record.reconciled;
      const previousTrusted = previous.status !== 'unknown';
      const nextTrusted = input.status !== 'unknown';
      if (previousTrusted && nextTrusted && previous.status !== input.status) {
        throw new RunDispatchJournalError(
          'journal_conflict',
          `dispatch ${record.dispatch_id} already has a conflicting reconciled status`,
        );
      }
      // 同状态（或 unknown→可信 的升级之外）的重复 reconciled 是幂等写重试。
      if (previous.status === input.status || (previousTrusted && !nextTrusted)) return;
    }

    await this.appendLine(line);
  }

  /** `init`：冻结配置与预算；同内容幂等，冲突 fail closed。 */
  async appendInit(input: JournalInitAppendInput): Promise<void> {
    return this.enqueueMutation(() => this.appendInitNow(input));
  }

  private async appendInitNow(input: JournalInitAppendInput): Promise<void> {
    const { snapshot } = await this.loadForAppend();
    const at = input.at ?? new Date().toISOString();
    const line = JournalInitEntrySchema.parse({
      schema_version: DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
      entry_id: input.entry_id ?? createId('jrn'),
      run_id: this.identity.run_id,
      task_id: this.identity.task_id,
      role_id: this.identity.role_id,
      at,
      event: 'init',
      autonomy: input.autonomy,
      evidence_only: input.evidence_only,
      buffer_v2: input.buffer_v2,
      max_dispatches: input.max_dispatches,
      max_role_rounds: input.max_role_rounds,
      role_token_budget: input.role_token_budget,
      deadline_at: input.deadline_at,
      ...(input.engine !== undefined ? { engine: input.engine } : {}),
      ...(input.engine_version !== undefined ? { engine_version: input.engine_version } : {}),
      ...(input.tool_allowlist !== undefined ? { tool_allowlist: input.tool_allowlist } : {}),
      ...(input.routing !== undefined ? { routing: input.routing } : {}),
      ...(input.dispatch_timeout_ms !== undefined
        ? { dispatch_timeout_ms: input.dispatch_timeout_ms }
        : {}),
      ...(input.max_tool_calls !== undefined ? { max_tool_calls: input.max_tool_calls } : {}),
    });
    if (dedupeByEntryId(snapshot, line)) return;
    const existing = snapshot.lines.find((entry) => entry.event === 'init');
    if (existing !== undefined) {
      if (canonicalWithoutAt(existing) === canonicalWithoutAt(line)) return;
      throw new RunDispatchJournalError(
        'journal_conflict',
        'journal already has a different init entry',
      );
    }
    await this.appendLine(line);
  }

  /** `finish`：终态控制行；同内容幂等，冲突 fail closed。 */
  async appendFinish(input: JournalFinishAppendInput): Promise<void> {
    return this.enqueueMutation(() => this.appendFinishNow(input));
  }

  private async appendFinishNow(input: JournalFinishAppendInput): Promise<void> {
    const { snapshot } = await this.loadForAppend();
    const at = input.at ?? new Date().toISOString();
    const line = JournalFinishEntrySchema.parse({
      schema_version: DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
      entry_id: input.entry_id ?? createId('jrn'),
      run_id: this.identity.run_id,
      task_id: this.identity.task_id,
      role_id: this.identity.role_id,
      at,
      event: 'finish',
      actor: input.actor,
      status: input.status,
      reason: input.reason,
      evidence_refs: input.evidence_refs,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.unresolved !== undefined ? { unresolved: input.unresolved } : {}),
      ...(input.role_reflection !== undefined ? { role_reflection: input.role_reflection } : {}),
      ...(input.response_only !== undefined ? { response_only: input.response_only } : {}),
      ...(input.zero_dispatch !== undefined ? { zero_dispatch: input.zero_dispatch } : {}),
      ...(input.verification !== undefined ? { verification: input.verification } : {}),
    });
    if (dedupeByEntryId(snapshot, line)) return;
    const existing = snapshot.lines.find((entry) => entry.event === 'finish');
    if (existing !== undefined) {
      if (canonicalWithoutAt(existing) === canonicalWithoutAt(line)) return;
      throw new RunDispatchJournalError(
        'journal_conflict',
        'journal already has a different finish entry',
      );
    }
    await this.appendLine(line);
  }

  /**
   * `role_round`：单回合预算消费事实（阶段 2）。恢复时据此还原已消费回合与 token，
   * 不靠 restart 清零；`usage_missing` 为 true 时 token 字段不写，绝不填 0 冒充已知。
   */
  async appendRoleRound(input: RoleRoundAppendInput): Promise<void> {
    return this.enqueueMutation(() => this.appendRoleRoundNow(input));
  }

  private async appendRoleRoundNow(input: RoleRoundAppendInput): Promise<void> {
    const { snapshot } = await this.loadForAppend();
    const at = input.at ?? new Date().toISOString();
    const line = JournalRoleRoundEntrySchema.parse({
      schema_version: DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
      entry_id: input.entry_id ?? createId('jrn'),
      run_id: this.identity.run_id,
      task_id: this.identity.task_id,
      role_id: this.identity.role_id,
      at,
      event: 'role_round',
      round: input.round,
      usage_missing: input.usage_missing,
      ...(input.input_tokens !== undefined ? { input_tokens: input.input_tokens } : {}),
      ...(input.output_tokens !== undefined ? { output_tokens: input.output_tokens } : {}),
      ...(input.tool_calls !== undefined ? { tool_calls: input.tool_calls } : {}),
    });
    if (dedupeByEntryId(snapshot, line)) return;
    await this.appendLine(line);
  }

  // ── 受控 evidence ref ─────────────────────────────────────

  /**
   * 显式登记一个受控 ref（不校验文件是否存在；读取时校验字节 hash）。
   *
   * 同一路径已登记过**不同** sha256 时拒绝（`evidence_ref_conflict`）——包括折叠派生出来的
   * settled 侧车路径，否则「登记」会被用来把任意内容洗成受控 ref，绕过 evidence 身份绑定。
   * 同 sha 重复登记是 no-op。因为要对照折叠结果，这个入口是异步的。
   */
  async registerEvidenceRef(ref: EvidenceRef): Promise<void> {
    const parsed = parseEvidenceRef(ref);
    return this.enqueueMutation(() => this.registerEvidenceRefNow(parsed));
  }

  async registerEvidenceRefs(refs: readonly EvidenceRef[]): Promise<void> {
    // 先全部解析（同步、无 I/O），再作为**一个**队列操作执行：内部逐个调用不排队的
    // `registerEvidenceRefNow`，因此不会出现「外层排队等内层排队」的死锁。
    const parsed = refs.map((ref) => parseEvidenceRef(ref));
    return this.enqueueMutation(async () => {
      for (const ref of parsed) await this.registerEvidenceRefNow(ref);
    });
  }

  private async registerEvidenceRefNow(parsed: EvidenceRef): Promise<void> {
    const registry = this.collectRegisteredEvidenceRefs(await this.tryFoldForEvidence());
    addRefToRegistry(registry, parsed);
    this.rememberEvidenceRef(parsed);
  }

  /**
   * 跨 Run 重试锚点：由 engine 从祖先 Journal 读出并经受控 evidence 校验后注入。
   * 只影响 `retry_of` 对**祖先 dispatch** 的校验，不伪造任何执行事实、不写 Journal。
   */
  setForeignRetryAnchors(anchors: readonly ForeignRetryAnchor[]): void {
    this.foreignRetryAnchors = anchors.filter((anchor) =>
      SAFE_PATH_SEGMENT.test(anchor.dispatch_id),
    );
  }

  /**
   * 受控读取 evidence：只接受已登记 ref；安全相对路径 + realpath 仍在 runDir 内；
   * 限大小、全量校验 sha256、按 offset/limit 分页。
   */
  async readEvidence(
    ref: EvidenceRef,
    options: ReadDispatchEvidenceOptions = {},
  ): Promise<DispatchJournalEvidencePage> {
    const parsedRef = parseEvidenceRef(ref);
    const offset = normalizePageNumber(options.offset ?? 0, 'offset', 0);
    const requestedLimit = normalizePageNumber(
      options.limit ?? this.maxEvidencePageBytes,
      'limit',
      1,
    );
    const limit = Math.min(requestedLimit, this.maxEvidencePageBytes);

    const registry = this.collectRegisteredEvidenceRefs(await this.tryFoldForEvidence());
    const registeredShas = registry.get(parsedRef.path);
    // path + sha 必须**双向**登记：派生侧车路径绑定 settled 的 evidence_sha256，不存在任意 sha 通道。
    if (registeredShas === undefined || !registeredShas.has(parsedRef.sha256)) {
      throw new RunDispatchJournalError(
        'evidence_ref_not_registered',
        `evidence ref ${parsedRef.path} is not registered with sha256 ${parsedRef.sha256} for this run`,
      );
    }

    const target = path.resolve(this.runDir, parsedRef.path);
    if (!isPathInside(this.runDir, target) || !isPathInside(this.realRunDir, target)) {
      throw new RunDispatchJournalError(
        'evidence_path_unsafe',
        `evidence ref ${parsedRef.path} escapes the run directory`,
      );
    }
    const stat = await this.io.stat(target);
    if (stat === undefined) {
      throw new RunDispatchJournalError(
        'evidence_missing',
        `evidence file ${parsedRef.path} does not exist`,
      );
    }
    if (stat.size > this.maxEvidenceBytes) {
      throw new RunDispatchJournalError(
        'evidence_too_large',
        `evidence file ${parsedRef.path} is ${stat.size} bytes, limit is ${this.maxEvidenceBytes}`,
      );
    }
    let realTarget: string;
    try {
      realTarget = await this.io.realpath(target);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new RunDispatchJournalError(
          'evidence_missing',
          `evidence file ${parsedRef.path} does not exist`,
        );
      }
      throw error;
    }
    if (!isPathInside(this.realRunDir, realTarget)) {
      throw new RunDispatchJournalError(
        'evidence_path_unsafe',
        `evidence ref ${parsedRef.path} resolves outside the run directory`,
      );
    }

    const bytes = await this.io.readFile(realTarget);
    const fileSha256 = sha256Hex(bytes);
    if (fileSha256 !== parsedRef.sha256) {
      throw new RunDispatchJournalError(
        'evidence_hash_mismatch',
        `evidence file ${parsedRef.path} sha256 does not match the registered ref`,
      );
    }
    const pageStart = Math.min(offset, bytes.byteLength);
    const pageEnd = Math.min(pageStart + limit, bytes.byteLength);
    const pageBytes = bytes.subarray(pageStart, pageEnd);
    return {
      text: Buffer.from(pageBytes).toString('utf8'),
      offset,
      limit,
      total_bytes: bytes.byteLength,
      truncated: pageEnd < bytes.byteLength,
      sha256: fileSha256,
    };
  }

  /** ADP reconciler 用：按 exchange id 找 dispatch_id（折叠结果，损坏时 fail closed）。 */
  async findDispatchIdByExchange(adpExchangeId: string): Promise<string | undefined> {
    const fold = await this.fold();
    for (const record of fold.records) {
      if (record.adp_exchange_id === adpExchangeId) return record.dispatch_id;
    }
    return undefined;
  }

  /** ADP reconciler / role 循环用：取折叠后的 dispatch 记录。 */
  async getDispatchRecord(dispatchId: string): Promise<DispatchRecord | undefined> {
    const fold = await this.fold();
    return fold.byDispatchId.get(dispatchId);
  }

  // ── 内部：写入 ────────────────────────────────────────────

  /** 每次 append 前先验所有权、再重读 + 折叠；锁丢失/坏尾/损坏在这里拒绝。 */
  private async loadForAppend(): Promise<{
    snapshot: DispatchJournalReadResult;
    fold: DispatchJournalFoldResult;
  }> {
    await this.assertLockOwnership();
    const snapshot = await this.read();
    if (snapshot.status === 'repairable_tail') {
      throw new RunDispatchJournalError(
        'journal_repair_required',
        'journal has a half-written tail; run repairTail() before appending',
        { discarded_tail_sha256: snapshot.discarded_tail?.sha256 },
      );
    }
    if (snapshot.status === 'corrupt') {
      throw new JournalCorruptionError(
        'journal_corrupt',
        'journal is corrupt; refusing to append',
        {
          problems: snapshot.problems,
        },
      );
    }
    const fold =
      snapshot.kind === 'legacy'
        ? emptyFoldResult()
        : foldDispatchJournalLines(snapshot.lines, this.identity);
    return { snapshot, fold };
  }

  /**
   * 单行 append：schema 校验 → 补齐末尾换行 → 一次 append + fsync。
   *
   * 若 journal 文件已存在、非空且末字节不是 `\n`（例如上次只写了完整 JSON 行但没写换行，
   * 或被外部工具裁掉），先用 {@link DispatchJournalIo.appendLineTerminator} durable 追加**恰好
   * 一个**换行，再写新行；换行写失败时**在新行落盘之前**抛错。完整末行不丢、不修复——真正的
   * 半截 JSON 仍由 `read()` 判 `repairable_tail` 并走 `repairTail()`。
   */
  private async appendLine(line: DispatchJournalLine): Promise<void> {
    await this.assertLockOwnership();
    let parsed: DispatchJournalLine;
    try {
      parsed = DispatchJournalLineSchema.parse(line);
    } catch (error) {
      throw new RunDispatchJournalError(
        'journal_invalid_entry',
        'journal line failed schema validation',
        error,
      );
    }
    await this.ensureTrailingNewlineBeforeAppend();
    await this.io.appendLineWithFsync(this.journalFilePath, JSON.stringify(parsed));
    if (!this.journalFileExists) {
      this.journalFileExists = true;
      await this.trySyncDirectory(this.journalDir);
    }
  }

  /** 完整行缺末尾换行时先补齐；写失败直接抛错，绝不继续写新行。 */
  private async ensureTrailingNewlineBeforeAppend(): Promise<void> {
    const stat = await this.io.stat(this.journalFilePath);
    if (stat === undefined || stat.size === 0) return;
    const bytes = await this.io.readFile(this.journalFilePath);
    if (bytes.at(-1) === NEWLINE_BYTE) return;
    await this.io.appendLineTerminator(this.journalFilePath);
    this.journalFileExists = true;
  }

  private requireRecord(fold: DispatchJournalFoldResult, dispatchId: string): DispatchRecord {
    const record = fold.byDispatchId.get(dispatchId);
    if (record === undefined) {
      throw new RunDispatchJournalError(
        'journal_unknown_dispatch',
        `dispatch ${dispatchId} has no accepted journal entry`,
      );
    }
    return record;
  }

  /** retry_of：被引用 dispatch 必须存在、未 succeeded；unknown 必须带已登记的对账 ref。 */
  private assertRetryAllowed(fold: DispatchJournalFoldResult, brief: ExecutionBrief): void {
    const retryOf = brief.retry_of;
    if (retryOf === undefined) return;
    const target = fold.byDispatchId.get(retryOf);
    if (target === undefined) {
      const anchor = this.foreignRetryAnchors.find(
        (candidate) => candidate.dispatch_id === retryOf,
      );
      if (anchor === undefined) {
        throw new RunDispatchJournalError(
          'journal_retry_not_allowed',
          `retry_of ${retryOf} does not reference an existing dispatch`,
        );
      }
      this.assertForeignRetryAllowed(anchor, brief);
      return;
    }
    if (target.status === 'succeeded') {
      throw new RunDispatchJournalError(
        'journal_retry_not_allowed',
        `retry_of ${retryOf} already succeeded; it must not be retried`,
      );
    }
    if (target.status === 'unknown') {
      const reconciliationRef = brief.reconciliation_ref;
      if (reconciliationRef === undefined) {
        throw new RunDispatchJournalError(
          'journal_retry_without_evidence',
          `retrying unknown dispatch ${retryOf} requires reconciliation_ref evidence`,
        );
      }
      const registry = this.collectRegisteredEvidenceRefs(fold);
      const shas = registry.get(reconciliationRef.path);
      // 与 readEvidence 同一 registry：path + sha 双向登记，不存在任意 sha 旁路。
      if (shas === undefined || !shas.has(reconciliationRef.sha256)) {
        throw new RunDispatchJournalError(
          'journal_retry_without_evidence',
          `reconciliation_ref ${reconciliationRef.path} is not registered evidence`,
        );
      }
    }
  }

  /** 跨 Run 重试：祖先 unknown 必须带在祖先 Journal 中可验证的 reconciliation_ref。 */
  private assertForeignRetryAllowed(anchor: ForeignRetryAnchor, brief: ExecutionBrief): void {
    if (anchor.status === 'succeeded') {
      throw new RunDispatchJournalError(
        'journal_retry_not_allowed',
        `retry_of ${anchor.dispatch_id} already succeeded; it must not be retried`,
      );
    }
    if (anchor.status !== 'unknown') return;
    const reconciliationRef = brief.reconciliation_ref;
    if (reconciliationRef === undefined) {
      throw new RunDispatchJournalError(
        'journal_retry_without_evidence',
        `retrying unknown dispatch ${anchor.dispatch_id} requires reconciliation_ref evidence`,
      );
    }
    const registered = anchor.evidence_refs.some(
      (ref) => ref.path === reconciliationRef.path && ref.sha256 === reconciliationRef.sha256,
    );
    if (!registered) {
      throw new RunDispatchJournalError(
        'journal_retry_without_evidence',
        `reconciliation_ref ${reconciliationRef.path} is not verified evidence of ancestor dispatch ${anchor.dispatch_id}`,
      );
    }
  }

  /**
   * 登记一个 (path, sha256) 对；同路径已登记不同 sha 时抛 `evidence_ref_conflict`。
   * 这是「受控 ref 不可重定义」的唯一入口，显式登记与折叠派生都走它。
   */
  private rememberEvidenceRef(ref: EvidenceRef): void {
    addRefToRegistry(this.registeredRefs, ref);
  }

  /**
   * 已登记 ref 集合：本进程写过的/显式登记的 + 折叠中 settled evidence 与 reconciled 出现过的
   * ref。settled dispatch 的 evidence 侧车路径按 dispatch_id 可派生，但**必须绑定 settled 的
   * `evidence_sha256`**（canonical JSON 字节 hash），不存在「任意 sha 都算登记」的旁路。
   */
  private collectRegisteredEvidenceRefs(
    fold: DispatchJournalFoldResult | undefined,
  ): Map<string, Set<string>> {
    const registry = new Map<string, Set<string>>();
    for (const [refPath, shas] of this.registeredRefs) registry.set(refPath, new Set(shas));
    if (fold === undefined) return registry;
    for (const record of fold.records) {
      if (record.evidence !== undefined) {
        addEvidenceRefsToRegistry(registry, record.evidence);
        if (record.evidence_sha256 !== undefined && SAFE_PATH_SEGMENT.test(record.dispatch_id)) {
          addRefToRegistry(registry, {
            path: `${DISPATCH_JOURNAL_DIR}/${DISPATCH_EVIDENCE_DIR}/${record.dispatch_id}.json`,
            sha256: record.evidence_sha256,
          });
        }
      }
      if (record.reconciled?.evidence_ref !== undefined) {
        addRefToRegistry(registry, record.reconciled.evidence_ref);
      }
    }
    return registry;
  }

  /** evidence 读取时若 journal 损坏：显式登记的 ref 仍可读，派生 ref 不再可信。 */
  private async tryFoldForEvidence(): Promise<DispatchJournalFoldResult | undefined> {
    try {
      return await this.fold();
    } catch (error) {
      if (error instanceof JournalCorruptionError) return undefined;
      throw error;
    }
  }

  private async repairSidecarMatches(entry: JournalRepairEntry): Promise<boolean> {
    const ref = entry.discarded_tail_ref;
    if (ref === undefined) return true;
    if (ref.sha256 !== entry.discarded_tail_sha256) return false;
    if (!isSafeRelativeRefPath(ref.path)) return false;
    const target = path.resolve(this.runDir, ref.path);
    if (!isPathInside(this.runDir, target)) return false;
    try {
      const bytes = await this.io.readFile(target);
      return sha256Hex(bytes) === ref.sha256;
    } catch {
      return false;
    }
  }

  private nextRepairRefPath(discardedSha256: string): string {
    const stamp = new Date().toISOString().replace(/[^A-Za-z0-9_-]/g, '-');
    const unique = randomUUID().slice(0, 8);
    return `${DISPATCH_JOURNAL_DIR}/${DISPATCH_REPAIR_DIR}/${stamp}-${discardedSha256.slice(0, 12)}-${unique}.tail`;
  }

  // ── 内部：锁与 durability ─────────────────────────────────

  private lockFilePath(): string {
    return path.join(this.journalDir, DISPATCH_JOURNAL_WRITER_LOCK_FILE);
  }

  private lockOwnerFilePath(lockDir: string): string {
    return path.join(lockDir, LOCK_OWNER_FILE_NAME);
  }

  private reclaimGateDirPath(): string {
    return path.join(this.journalDir, DISPATCH_JOURNAL_RECLAIM_GATE_DIR);
  }

  /**
   * 目录锁获取协议（RD-JRN-01 单写者，gate 串行化版）：
   *
   * 1. 固定回收闸门 `<journalDir>/.writer.lock.reclaim/` 存在 → `journal_locked` fail closed
   *    （附手动恢复指引）；**绝不自动回收闸门**；
   * 2. `mkdirExclusive(lockDir)` —— 非递归 mkdir 的原子性即互斥；只有成功创建者才原子写
   *    owner.json（tmp `wx` + fsync + rename，`{pid, token, created_at, run_id}`）；
   * 3. EEXIST 时读 owner：**缺失/空/损坏/字段不全一律 `journal_locked` 且不回收**——覆盖
   *    「目录已建但 owner 尚未写完」的初始化窗口，宁可人工介入也不误删活锁；
   * 4. pid 存活 → `journal_locked`；pid 已死 → 先 `mkdirExclusive(gateDir)` 拿回收闸门
   *    （EEXIST → fail closed，不等待），**持闸门后重新读 owner**：仍缺失/损坏或 pid 变活 →
   *    `journal_locked`（两个目录原样保留）；仍死 → readdir+unlink+rmdir 删除陈旧锁目录，
   *    释放闸门后回到循环重新竞争 `mkdirExclusive`。**绝不移动活锁路径**，因此不存在
   *    「移动→校验→还原」的双写窗口。
   */
  private async acquireWriterLock(): Promise<void> {
    const lockDir = this.lockFilePath();
    const token = randomUUID();
    for (let attempt = 0; attempt < LOCK_RECLAIM_ATTEMPTS; attempt += 1) {
      await this.assertReclaimGateAbsent();
      try {
        await this.io.mkdirExclusive(lockDir);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) {
          throw new RunDispatchJournalError(
            'journal_lock_failed',
            'failed to create the dispatch journal writer lock directory',
            error,
          );
        }
        await this.reclaimStaleLockUnderGate(lockDir);
        // 回收成功也必须回到循环重新竞争 mkdirExclusive，不能假设锁已到手。
        continue;
      }

      // 并发回收者可能刚好在 mkdir 之后创建闸门：不继续，删掉自己刚建的空锁目录。
      if (await this.reclaimGateExists()) {
        await this.removeLockDirectoryQuietly(lockDir);
        throw new RunDispatchJournalError(
          'journal_locked',
          reclaimGateRecoveryMessage(this.reclaimGateDirPath()),
        );
      }

      // 本进程刚创建锁目录：原子写 owner；失败则清掉这个「无主」锁目录再报错。
      try {
        await this.writeLockOwner(lockDir, {
          pid: process.pid,
          token,
          created_at: new Date().toISOString(),
          run_id: this.identity.run_id,
        });
      } catch (error) {
        await this.removeLockDirectoryQuietly(lockDir);
        throw new RunDispatchJournalError(
          'journal_lock_failed',
          'failed to commit the dispatch journal writer lock owner',
          error,
        );
      }
      this.lockHeld = true;
      this.lockToken = token;
      return;
    }
    throw new RunDispatchJournalError(
      'journal_locked',
      'could not acquire the dispatch journal writer lock',
    );
  }

  /** EEXIST 分支：判活锁 / 判不可回收 / 在回收闸门内删除死锁。 */
  private async reclaimStaleLockUnderGate(lockDir: string): Promise<void> {
    const owner = parseLockOwner(await this.readOwnerBytes(lockDir));
    if (owner === undefined) {
      // 目录存在但 owner 未提交（或损坏）：不回收，避免把「正在初始化」的活锁误判为残留。
      throw new RunDispatchJournalError(
        'journal_locked',
        'dispatch journal writer lock exists but its owner is not committed; refusing to reclaim',
      );
    }
    if (owner.pid > 0 && isProcessAlive(owner.pid)) {
      throw new RunDispatchJournalError(
        'journal_locked',
        `dispatch journal for run ${this.identity.run_id} is already open by pid ${owner.pid}`,
      );
    }

    await this.acquireReclaimGate();
    try {
      // 持闸门后必须重新读：判死与拿到闸门之间可能已有新持有者。
      const current = parseLockOwner(await this.readOwnerBytes(lockDir));
      if (current === undefined) {
        throw new RunDispatchJournalError(
          'journal_locked',
          'dispatch journal writer lock owner changed under the reclaim gate; refusing to reclaim',
        );
      }
      if (current.pid > 0 && isProcessAlive(current.pid)) {
        throw new RunDispatchJournalError(
          'journal_locked',
          `dispatch journal for run ${this.identity.run_id} is already open by pid ${current.pid}`,
        );
      }
      await this.removeStaleLockDirectory(lockDir);
    } finally {
      await this.releaseReclaimGate();
    }
  }

  /** 拿回收闸门：EEXIST → fail closed（绝不等待/回收闸门本身）。 */
  private async acquireReclaimGate(): Promise<void> {
    const gateDir = this.reclaimGateDirPath();
    try {
      await this.io.mkdirExclusive(gateDir);
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        throw new RunDispatchJournalError('journal_locked', reclaimGateRecoveryMessage(gateDir));
      }
      throw new RunDispatchJournalError(
        'journal_lock_failed',
        'failed to create the dispatch journal reclaim gate',
        error,
      );
    }
  }

  /** 释放回收闸门；失败就留着（下次 open 会 fail closed，绝不自动回收）。 */
  private async releaseReclaimGate(): Promise<void> {
    try {
      await this.io.rmdir(this.reclaimGateDirPath());
    } catch {
      // 释放失败：保留闸门，让下一次 open 以 journal_locked 暴露出来。
    }
  }

  private async reclaimGateExists(): Promise<boolean> {
    return (await this.io.stat(this.reclaimGateDirPath())) !== undefined;
  }

  private async assertReclaimGateAbsent(): Promise<void> {
    if (await this.reclaimGateExists()) {
      throw new RunDispatchJournalError(
        'journal_locked',
        reclaimGateRecoveryMessage(this.reclaimGateDirPath()),
      );
    }
  }

  /**
   * 写路径的所有权守卫：每次写之前重读 owner.json，要求 `token + pid` 都是自己的。
   * 不满足即认为锁已丢失（被替换/被回收/被删除），置 `lockHeld=false` 并抛 `journal_lock_lost`，
   * 绝不继续写。普通读文件即可——合法回收只可能发生在本进程 pid 已死时。
   */
  private async assertLockOwnership(): Promise<void> {
    if (this.lifecycle === 'closed' || !this.lockHeld) {
      throw new RunDispatchJournalError('journal_not_open', 'dispatch journal is not open');
    }
    const owner = parseLockOwner(await this.readOwnerBytes(this.lockFilePath()));
    if (owner === undefined || owner.pid !== process.pid || owner.token !== this.lockToken) {
      this.lockHeld = false;
      this.lockToken = undefined;
      throw new RunDispatchJournalError(
        'journal_lock_lost',
        'dispatch journal writer lock ownership was lost; refusing to write',
      );
    }
  }

  private async writeLockOwner(lockDir: string, owner: LockOwnerRecord): Promise<void> {
    const target = this.lockOwnerFilePath(lockDir);
    const temporary = path.join(lockDir, `${LOCK_OWNER_FILE_NAME}.${randomUUID()}.tmp`);
    try {
      await this.io.writeFileExclusive(temporary, Buffer.from(JSON.stringify(owner), 'utf8'));
      await this.io.rename(temporary, target);
    } catch (error) {
      try {
        await this.io.unlink(temporary);
      } catch {
        // 清理失败不影响主错误。
      }
      throw error;
    }
    await this.trySyncDirectory(lockDir);
  }

  /** 读锁目录的 owner 字节；不可读（含目录已被删除）返回 undefined。 */
  private async readOwnerBytes(lockDir: string): Promise<Uint8Array | undefined> {
    try {
      return await this.io.readFile(this.lockOwnerFilePath(lockDir));
    } catch {
      return undefined;
    }
  }

  /**
   * 删除陈旧锁目录（readdir + unlink + rmdir）：ENOENT 视为已删除；其他真实错误 →
   * `journal_lock_failed`（回收失败必须让调用方知道锁状态未收敛）。
   */
  private async removeStaleLockDirectory(lockDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await this.io.readdir(lockDir);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw new RunDispatchJournalError(
        'journal_lock_failed',
        'failed to list the stale dispatch journal writer lock directory',
        error,
      );
    }
    for (const entry of entries) {
      try {
        await this.io.unlink(path.join(lockDir, entry));
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue;
        throw new RunDispatchJournalError(
          'journal_lock_failed',
          'failed to remove a file from the stale dispatch journal writer lock directory',
          error,
        );
      }
    }
    try {
      await this.io.rmdir(lockDir);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        throw new RunDispatchJournalError(
          'journal_lock_failed',
          'failed to remove the stale dispatch journal writer lock directory',
          error,
        );
      }
    }
  }

  /** 删除锁目录（尽力而为，不抛业务错误）：close / 自己刚创建又决定放弃的锁。 */
  private async removeLockDirectoryQuietly(lockDir: string): Promise<void> {
    try {
      const entries = await this.io.readdir(lockDir);
      for (const entry of entries) {
        try {
          await this.io.unlink(path.join(lockDir, entry));
        } catch {
          // 单个文件删除失败：继续尝试删除其余文件。
        }
      }
      await this.io.rmdir(lockDir);
    } catch {
      // 清理失败时留下锁目录，不影响调用方主流程。
    }
  }

  /** 目录 fsync 失败只降级 durability，不抛业务错误（RD-JRN-06）。 */
  private async trySyncDirectory(dirPath: string): Promise<boolean> {
    try {
      await this.io.syncDirectory(dirPath);
      return true;
    } catch (error) {
      this.markBestEffortDurability(
        `directory fsync unavailable for ${path.basename(dirPath)}: ${describeErrorCode(error)}`,
      );
      return false;
    }
  }

  private markBestEffortDurability(note: string): void {
    if (this.durability.mode === 'best_effort') {
      if (!this.durability.notes.includes(note)) this.durability.notes.push(note);
      return;
    }
    this.durability = { mode: 'best_effort', directory_sync: false, notes: [note] };
  }

  private snapshotDurability(): DispatchJournalDurability {
    return {
      mode: this.durability.mode,
      directory_sync: this.durability.directory_sync,
      notes: [...this.durability.notes],
    };
  }

  private async readFileIfExists(filePath: string): Promise<Uint8Array | undefined> {
    const stat = await this.io.stat(filePath);
    if (stat === undefined) return undefined;
    return this.io.readFile(filePath);
  }
}

// ─────────────────────────────────────────────────────────────
// 纯函数辅助
// ─────────────────────────────────────────────────────────────

/** 按字节切行：保留原始字节（hash 要对原始字节算），并报告文件是否以换行结尾。 */
function splitRawLines(bytes: Uint8Array): { lines: Uint8Array[]; terminated: boolean } {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== NEWLINE_BYTE) continue;
    lines.push(bytes.subarray(start, index));
    start = index + 1;
  }
  const terminated = bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === NEWLINE_BYTE;
  if (!terminated) lines.push(bytes.subarray(start));
  return { lines, terminated };
}

function parseJournalLine(raw: Uint8Array): DispatchJournalLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(UTF8_DECODER.decode(raw));
  } catch {
    return undefined;
  }
  const result = DispatchJournalLineSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function decodeUtf8Lossy(raw: Uint8Array): string {
  return Buffer.from(raw).toString('utf8');
}

function normalizeIdentity(identity: RunDispatchJournalIdentity): RunDispatchJournalIdentity {
  for (const key of ['run_id', 'task_id', 'role_id'] as const) {
    const value = identity[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new RunDispatchJournalError(
        'journal_invalid_entry',
        `dispatch journal identity requires a non-empty ${key}`,
      );
    }
  }
  return { run_id: identity.run_id, task_id: identity.task_id, role_id: identity.role_id };
}

function parseBrief(brief: ExecutionBrief): ExecutionBrief {
  try {
    return ExecutionBriefSchema.parse(brief);
  } catch (error) {
    throw new RunDispatchJournalError(
      'journal_invalid_entry',
      'execution brief failed schema validation',
      error,
    );
  }
}

function verifyBriefSha256(brief: ExecutionBrief, expected: string): string {
  const actual = hashExecutionBrief(brief);
  if (actual !== expected) {
    throw new RunDispatchJournalError(
      'journal_hash_mismatch',
      `brief_sha256 does not match brief content for dispatch ${brief.dispatch_id}`,
    );
  }
  return actual;
}

function assertBriefIdentity(brief: ExecutionBrief, identity: RunDispatchJournalIdentity): void {
  if (
    brief.run_id !== identity.run_id ||
    brief.task_id !== identity.task_id ||
    brief.role_id !== identity.role_id
  ) {
    throw new RunDispatchJournalError(
      'journal_identity_mismatch',
      `brief identity does not match this journal (run ${identity.run_id}, task ${identity.task_id}, role ${identity.role_id})`,
    );
  }
}

function parseEvidence(evidence: ExecutionEvidence): ExecutionEvidence {
  try {
    return ExecutionEvidenceSchema.parse(evidence);
  } catch (error) {
    throw new RunDispatchJournalError(
      'journal_invalid_entry',
      'execution evidence failed schema validation',
      error,
    );
  }
}

function verifyEvidenceSha256(evidence: ExecutionEvidence, expected: string): string {
  const actual = hashExecutionEvidence(evidence);
  if (actual !== expected) {
    throw new RunDispatchJournalError(
      'journal_hash_mismatch',
      `evidence_sha256 does not match evidence content for dispatch ${evidence.dispatch_id}`,
    );
  }
  return actual;
}

function parseEvidenceRef(ref: EvidenceRef): EvidenceRef {
  if (typeof ref.path !== 'string' || !isSafeRelativeRefPath(ref.path)) {
    throw new RunDispatchJournalError(
      'evidence_path_unsafe',
      'evidence ref path must be a safe relative path inside the run directory',
    );
  }
  const result = EvidenceRefSchema.safeParse(ref);
  if (!result.success) {
    throw new RunDispatchJournalError(
      'evidence_ref_invalid',
      'evidence ref must be {path, sha256} with a 64-char lowercase hex sha256',
      result.error,
    );
  }
  return result.data;
}

function assertSafePathSegment(value: string, label: string): string {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new RunDispatchJournalError(
      'journal_invalid_entry',
      `${label} is not a safe path segment: ${value}`,
    );
  }
  return value;
}

/** 同 entry_id 写重试视为幂等：内容除 `at` 外完全一致即 dedupe 成功。 */
function dedupeByEntryId(
  snapshot: DispatchJournalReadResult,
  candidate: DispatchJournalLine,
): boolean {
  const existing = snapshot.lines.find((line) => line.entry_id === candidate.entry_id);
  if (existing === undefined) return false;
  if (canonicalWithoutAt(existing) === canonicalWithoutAt(candidate)) return true;
  throw new RunDispatchJournalError(
    'journal_conflict',
    `journal entry_id ${candidate.entry_id} was already used by a different line`,
  );
}

function dispatchedSemanticFromRecord(record: DispatchRecord): string {
  return canonicalJsonStringify({
    adp_exchange_id: record.adp_exchange_id ?? null,
    session_id: record.session_id ?? null,
  });
}

function settledSemanticFromRecord(record: DispatchRecord): string {
  return settledSemantic({
    status: record.status,
    evidence_sha256: record.evidence_sha256 ?? '',
    violations: record.violations,
  });
}

function addEvidenceRefsToRegistry(
  registry: Map<string, Set<string>>,
  evidence: ExecutionEvidence,
): void {
  for (const artifact of evidence.artifacts) addRefToRegistry(registry, artifact.ref);
  if (evidence.transcript_ref !== undefined) addRefToRegistry(registry, evidence.transcript_ref);
  if (evidence.tool_events_ref !== undefined) addRefToRegistry(registry, evidence.tool_events_ref);
  if (evidence.transport.stderr_ref !== undefined) {
    addRefToRegistry(registry, evidence.transport.stderr_ref);
  }
  for (const check of evidence.checks) {
    if (check.stdout_ref !== undefined) addRefToRegistry(registry, check.stdout_ref);
    if (check.stderr_ref !== undefined) addRefToRegistry(registry, check.stderr_ref);
  }
}

/**
 * 受控 ref 注册表的唯一写入点：path 已登记不同 sha 即 `evidence_ref_conflict`（fail closed），
 * 同 sha 重复登记 no-op。禁止「任意 sha」语义，否则登记会被用来绕过 evidence 身份绑定。
 */
function addRefToRegistry(registry: Map<string, Set<string>>, ref: EvidenceRef): void {
  const existing = registry.get(ref.path);
  if (existing === undefined) {
    registry.set(ref.path, new Set([ref.sha256]));
    return;
  }
  if (existing.has(ref.sha256)) return;
  throw new RunDispatchJournalError(
    'evidence_ref_conflict',
    `evidence ref path ${ref.path} is already registered with a different sha256`,
  );
}

/** 锁目录 owner 记录（写入 owner.json）。 */
interface LockOwnerRecord {
  pid: number;
  token: string;
  created_at: string;
  run_id: string;
}

/**
 * 解析锁 owner：`pid` 必须是正整数、`token` 必须是非空字符串，否则视为「owner 未提交/损坏」。
 * 返回 undefined 时调用方必须拒绝回收（不能把初始化中的活锁当残留）。
 */
function parseLockOwner(bytes: Uint8Array | undefined): { pid: number; token: string } | undefined {
  if (bytes === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const pid = Reflect.get(parsed, 'pid');
  const token = Reflect.get(parsed, 'token');
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof token !== 'string' || token.length === 0) return undefined;
  return { pid, token };
}

function normalizePageNumber(value: number, label: string, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RunDispatchJournalError(
      'journal_invalid_entry',
      `evidence page ${label} must be an integer >= ${minimum}`,
    );
  }
  return value;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function isErrno(error: unknown, code: string): boolean {
  if (error === null || typeof error !== 'object') return false;
  return Reflect.get(error, 'code') === code;
}

/**
 * 回收闸门 fail closed 时的稳定文案：点名闸门路径并给出手动恢复步骤
 * （闸门可能来自崩溃的回收者，本模块绝不自动回收它）。
 */
function reclaimGateRecoveryMessage(gateDir: string): string {
  return (
    `dispatch journal reclaim gate exists at ${gateDir}; a previous reclaim may have crashed. ` +
    'Verify that no writer is active, then remove that directory manually and retry.'
  );
}

function describeErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = Reflect.get(error, 'code');
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

/**
 * 持有者进程是否还活着：`ESRCH` = 已死；`EPERM` = 存在但无权发信号（活着）。
 * 只有 ESRCH 才算死，避免把别的用户的活进程误判成崩溃残留。
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
}
