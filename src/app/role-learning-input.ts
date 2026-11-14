/**
 * role-learning-input — 阶段 3 role 自主循环的 v2 学习输入（Buffer v2）落盘与在线登记
 *
 * 职责与核心逻辑：
 * - 从一次 role finish 的**既有事实**构造 Buffer v2：派工摘要（来自阶段 1 Journal 折叠
 *   记录）、可确定边界的 Journal 前缀引用与 hash、Role 反思（finish 的 summary/reflection/
 *   verification/unresolved）、记忆使用（宿主实际交付给 Role 的召回/查询结果）与来源 Driver
 *   集合。不伪造六字段报告、不伪造零派工的执行事实。
 * - 落盘走既有 BufferRepository.pending 队列；在线只登记一条 Context Delivery，不在本进程做
 *   经验提取（那是离线 Memory Maintenance 的事）。
 * - 幂等：同一次逻辑执行（同 run_id）恢复重跑时复用已经写下的 Buffer，不因重试再写一份
 *   （否则下游会双提取）。运行目录里的小 marker 只记 buffer_seq 指针；Buffer 本身才是权威。
 *
 * 边界：本文件不调用 LLM、不做经验提取/技能晋升/Persona 演化，也不写 Task/Run 终态。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nowTimestamp } from '../core';
import type { DispatchJournalLine, DispatchRecord } from '../driver';
import {
  BUFFER_SNAPSHOT_V2_SCHEMA_VERSION,
  isBufferSnapshotV2,
  type BufferDispatchSummary,
  type BufferJournalRef,
  type BufferMemoryUsedEntry,
  type BufferRepository,
  type BufferRoleVerification,
  type BufferSnapshotV2,
} from '../memory';
import type { DispatchJournalReadResult } from '../persistence';
import type { RoleLoopOutcome } from './role-autonomy-contract';

/** 在线学习输入登记的输入：只给稳定引用，不传 payload 副本。 */
export interface RoleLearningInputRegistration {
  task_id: string;
  run_id: string;
  role_id: string;
  buffer_seq: number;
  workspace_path?: string;
}

export interface RoleLearningInputDeps {
  /** 在线登记 Context Delivery（组合根注入）；缺省 = 未接线：Buffer 仍落盘，诊断里记 warning。 */
  register?: (input: RoleLearningInputRegistration) => Promise<void>;
}

export interface RoleLearningInputTask {
  task_id: string;
  run_id: string;
  role_id: string;
  /** 任务原始描述（Buffer v2.task_description） */
  task_description: string;
  workspace_path?: string;
}

export interface BuildRoleLearningInputInput {
  task: RoleLearningInputTask;
  outcome: RoleLoopOutcome;
  /** 本 Run 折叠后的派工记录（当前 Run 的 Journal 事实，不含祖先） */
  records: readonly DispatchRecord[];
  /** 本 Run 的 Journal 读取结果（用于取前缀边界与 hash） */
  journal_read: DispatchJournalReadResult;
  /** 宿主实际交付/检索给 Role 的记忆（host-observed；不是 Role 自述） */
  memory_used: readonly BufferMemoryUsedEntry[];
}

export interface RoleLearningInputWriteResult {
  buffer_version: 2;
  /** 复用/新分配的 buffer seq */
  buffer_seq: number;
  /** 本次是否真的新写了一条 Buffer（false = 恢复重跑复用已有那条） */
  created: boolean;
  journal_ref: BufferJournalRef;
  /** 在线登记失败的事实（不阻断任务，但必须可见） */
  registration_error?: string;
}

// ─────────────────────────────────────────────────────────────
//  Journal 前缀引用
// ─────────────────────────────────────────────────────────────

/**
 * 计算「到 finish 行为止」的 Journal 前缀引用与 hash。
 *
 * 前缀边界用**行数**而不是字节偏移：后续追加的 reconciled/role_round 行不会改变已登记的
 * 学习输入。hash 是解析行 canonical JSON 的拼接哈希（读取方用同一投影即可复核），
 * 不是原始文件字节哈希——原始字节还会被尾部修复等操作改写，行投影才是稳定事实。
 */
export function buildJournalPrefixRef(
  read: DispatchJournalReadResult,
  runId: string,
): BufferJournalRef {
  const finishIndex = read.lines.map((line) => line.event).lastIndexOf('finish');
  if (finishIndex < 0) {
    throw new Error('journal has no finish line; refusing to build a learning input prefix');
  }
  const prefix = read.lines.slice(0, finishIndex + 1);
  return {
    run_id: runId,
    path: 'journal/dispatches.jsonl',
    lines: prefix.length,
    sha256: hashJournalPrefixLines(prefix),
  };
}

/**
 * Journal 前缀 hash 的唯一算法（写入端与离线核验端共用）。
 *
 * 对解析后的行做 canonical JSON 投影再拼接；不能用原始文件字节哈希——尾部修复会改写
 * 字节，而「到 finish 为止的解析行」不随之后追加的行变化。
 */
export function hashJournalPrefixLines(lines: readonly DispatchJournalLine[]): string {
  const canonical = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ─────────────────────────────────────────────────────────────
//  构造
// ─────────────────────────────────────────────────────────────

/**
 * 派工摘要里的检查计数：四类互斥、合计等于真实观察到的检查条数。
 *
 * 只有 `provenance=host_observed + observation=complete + exit_code=0` 才算通过；
 * 数据不完整、退出码非 0 或缺失都落在「未证明通过」，driver 自报单独计一类。
 *
 * 写入端（本文件）与离线核验端（learning-evidence-verifier 重建摘要）共用这一处映射，
 * 保证「Buffer 里的计数」与「从证据重建的计数」按同一规则可比。
 */
export function summarizeChecks(
  evidence: DispatchRecord['evidence'],
): BufferDispatchSummary['checks'] {
  const counts = {
    host_observed_passed: 0,
    host_observed_failed: 0,
    driver_reported: 0,
    missing: 0,
  };
  for (const check of evidence?.checks ?? []) {
    if (check.observation === 'missing') {
      counts.missing += 1;
    } else if (check.provenance === 'driver_reported') {
      counts.driver_reported += 1;
    } else if (check.observation === 'complete' && check.exit_code === 0) {
      counts.host_observed_passed += 1;
    } else {
      counts.host_observed_failed += 1;
    }
  }
  return counts;
}

/**
 * 一条派工记录 → Buffer v2 派工摘要（写入端与离线核验端重建共用的唯一映射）。
 *
 * `evidence_ref` 用的是 run 目录相对路径 + settled evidence hash：离线核验端按同一路径
 * 走受控 evidence 读取，不按 Buffer 里任意字符串读本地文件。
 */
export function dispatchSummaryFromRecord(record: DispatchRecord): BufferDispatchSummary {
  const evidence = record.evidence;
  return {
    dispatch_id: record.dispatch_id,
    kind: record.brief.kind,
    status: record.status === 'not_executed' ? 'not_executed' : record.status,
    ...(evidence?.driver_id !== undefined ? { driver_id: evidence.driver_id } : {}),
    ...(record.evidence_sha256 !== undefined
      ? {
          evidence_ref: {
            path: `journal/evidence/${record.dispatch_id}.json`,
            sha256: record.evidence_sha256,
          },
        }
      : {}),
    checks: summarizeChecks(evidence),
  };
}

function toRoleVerification(outcome: RoleLoopOutcome): BufferRoleVerification[] {
  return outcome.finish.verification.map((claim) => ({
    requirement: claim.requirement,
    outcome: claim.outcome,
    dispatch_ids: [...claim.dispatch_ids],
    ...(claim.note !== undefined ? { note: claim.note } : {}),
  }));
}

/** 来源 Driver 集合：按派工顺序去重；零派工是空数组（不是 null：两者契约都允许，取更明确的 []）。 */
function collectSourceDrivers(summaries: readonly BufferDispatchSummary[]): string[] {
  const drivers: string[] = [];
  for (const summary of summaries) {
    if (summary.driver_id !== undefined && !drivers.includes(summary.driver_id)) {
      drivers.push(summary.driver_id);
    }
  }
  return drivers;
}

/**
 * 构造 Buffer v2 学习输入（纯函数）。
 *
 * Role 反思/记忆使用都按 dependent 输入记录；它们不会让「测试通过」变成宿主观察到的事实，
 * 也不会提高记忆的验证置信度（来源分级在离线提取器里按证据判定）。
 */
export function buildRoleLearningInput(input: BuildRoleLearningInputInput): BufferSnapshotV2 {
  const summaries = input.records.map(dispatchSummaryFromRecord);
  const sourceDrivers = collectSourceDrivers(summaries);
  const finish = input.outcome.finish;
  return {
    schema_version: BUFFER_SNAPSHOT_V2_SCHEMA_VERSION,
    buffer_version: 2,
    task_id: input.task.task_id,
    task_description: input.task.task_description,
    source_task_id: input.task.task_id,
    journal_ref: buildJournalPrefixRef(input.journal_read, input.task.run_id),
    dispatches: summaries,
    ...(input.outcome.plan !== undefined && input.outcome.plan.trim().length > 0
      ? { plan: input.outcome.plan }
      : {}),
    role_reflection: {
      // 结构化结束状态：直接取已接受的 finish.status，不从摘要文本推断；恢复路径同样经
      // role-autonomy-engine 的 resultFromRecoveredFinish 用 Journal finish 行构造这个字段。
      status: finish.status,
      summary: finish.summary,
      reflection: finish.role_reflection,
      unresolved: [...finish.unresolved],
      verification: toRoleVerification(input.outcome),
      memory_used: input.memory_used.map((entry) => ({ ...entry })),
    },
    source_drivers: sourceDrivers,
    // 兼容字段：恰好一个来源 driver 时才填；零派工/多来源不填，避免把集合压成一个身份。
    ...(sourceDrivers.length === 1 ? { source_driver: sourceDrivers[0]! } : {}),
    received_at: nowTimestamp(),
    retry_count: 0,
    extraction_status: 'pending',
  };
}

// ─────────────────────────────────────────────────────────────
//  落盘 + 在线登记
// ─────────────────────────────────────────────────────────────

/** 运行目录里的持久指针：只记 buffer_seq，便于恢复重跑时找回已写下的那条 Buffer。 */
interface LearningInputMarker {
  buffer_version: 2;
  buffer_seq: number;
  journal_ref_sha256: string;
}

function markerPath(runDir: string): string {
  return path.join(runDir, 'role-autonomy', 'learning-input.json');
}

async function readMarker(runDir: string): Promise<LearningInputMarker | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(markerPath(runDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<LearningInputMarker>;
  if (parsed.buffer_version !== 2 || typeof parsed.buffer_seq !== 'number') {
    throw new Error(`learning input marker at ${markerPath(runDir)} is unreadable`);
  }
  return {
    buffer_version: 2,
    buffer_seq: parsed.buffer_seq,
    journal_ref_sha256: String(parsed.journal_ref_sha256 ?? ''),
  };
}

async function writeMarker(runDir: string, marker: LearningInputMarker): Promise<void> {
  const target = markerPath(runDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(marker), 'utf8');
  await fs.rename(temporary, target);
}

/**
 * 找出本 Run 已经写下的 v2 Buffer：先看 marker 指针（能覆盖已被归档的 Buffer），
 * 没有指针时扫描 pending/dead_letter（覆盖「Buffer 写完、marker 还没写」的崩溃窗口）。
 * 两条路径都按 `journal_ref.run_id` 核对，绝不把别的 Run 的学习输入当成自己的。
 */
async function findExistingLearningInput(
  buffer_repository: BufferRepository,
  runDir: string,
  runId: string,
  role_id: string,
): Promise<number | undefined> {
  const marker = await readMarker(runDir);
  if (marker !== undefined) {
    const stored = await buffer_repository.getStoredBuffer(role_id, marker.buffer_seq);
    if (stored !== undefined) {
      const snapshot = stored.snapshot;
      if (isBufferSnapshotV2(snapshot) && snapshot.journal_ref.run_id === runId) {
        return marker.buffer_seq;
      }
    }
  }
  const seqs = [
    ...(await buffer_repository.listPendingBufferSeqs(role_id)),
    ...(await buffer_repository.listDeadLetterSeqs(role_id)),
  ];
  for (const seq of seqs) {
    const stored = await buffer_repository.getStoredBuffer(role_id, seq);
    if (stored === undefined) continue;
    const snapshot = stored.snapshot;
    if (isBufferSnapshotV2(snapshot) && snapshot.journal_ref.run_id === runId) {
      await writeMarker(runDir, {
        buffer_version: 2,
        buffer_seq: seq,
        journal_ref_sha256: snapshot.journal_ref.sha256,
      });
      return seq;
    }
  }
  return undefined;
}

export interface PersistRoleLearningInputInput {
  run_dir: string;
  role_id: string;
  task_id: string;
  run_id: string;
  workspace_path?: string;
  snapshot: BufferSnapshotV2;
  deps: RoleLearningInputDeps;
  buffer_repository: BufferRepository;
}

/**
 * 落盘 Buffer v2 并在线登记一条 Context Delivery（只登记，不提取）。
 *
 * - 同 role_id 归属：Buffer 写在 `role_id` 名下，更换 driver 不改变记忆归属。
 * - 恢复幂等：同 run_id 已有 v2 Buffer 时复用它的 seq，不重复写（下游不会双提取）。
 * - 登记失败不回滚 Buffer、也不阻断任务：错误作为 `registration_error` 交回调用方写进
 *   阶段证据/diagnostics（与既有 scheduleBuffer 的 best-effort 语义一致）。
 */
export async function persistRoleLearningInput(
  input: PersistRoleLearningInputInput,
): Promise<RoleLearningInputWriteResult> {
  const { snapshot, deps, buffer_repository, run_dir } = input;
  const existingSeq = await findExistingLearningInput(
    buffer_repository,
    run_dir,
    input.run_id,
    input.role_id,
  );
  let bufferSeq: number;
  let created = false;
  if (existingSeq === undefined) {
    const saved = await buffer_repository.saveBufferSnapshot(input.role_id, snapshot);
    bufferSeq = saved.seq;
    created = true;
    await writeMarker(run_dir, {
      buffer_version: 2,
      buffer_seq: bufferSeq,
      journal_ref_sha256: snapshot.journal_ref.sha256,
    });
  } else {
    bufferSeq = existingSeq;
  }

  let registrationError: string | undefined;
  if (deps.register === undefined) {
    registrationError =
      'No online Context Delivery registration port is wired; the learning input was stored but not handed downstream.';
  } else {
    try {
      await deps.register({
        task_id: input.task_id,
        run_id: input.run_id,
        role_id: input.role_id,
        buffer_seq: bufferSeq,
        ...(input.workspace_path !== undefined ? { workspace_path: input.workspace_path } : {}),
      });
    } catch (error) {
      registrationError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    buffer_version: 2,
    buffer_seq: bufferSeq,
    created,
    journal_ref: snapshot.journal_ref,
    ...(registrationError !== undefined ? { registration_error: registrationError } : {}),
  };
}

