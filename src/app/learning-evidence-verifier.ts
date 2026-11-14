/**
 * learning-evidence-verifier — 离线学习输入的受控证据核验（runs root 侧实现）
 *
 * 阶段 3 审核复现过：Buffer v2 里声明的 `host_observed_passed` 与 Journal/evidence 引用
 * 可以完全不存在，消费者仍把它当最高来源档落库。这个文件把 Buffer v2 的**引用**拿回事实源
 * 核对，结论交给 memory 侧的 `learning-input-grade` 参与来源分级：
 *
 *   1. 只认 Buffer 契约里的固定 Journal 路径（`journal/dispatches.jsonl`），run 目录必须在
 *      runs root 之内；不允许按 Buffer 提供的任意路径读本地文件；
 *   2. 前缀边界必须正好落在最后一个 finish 行；用写入端同一个 `hashJournalPrefixLines`
 *      重算前缀 hash（之后追加的 role_round/reconciled 行不影响它）；
 *   3. 用受控折叠重建派工摘要，和 Buffer 声称的 dispatch 集合、状态、evidence ref、检查计数
 *      逐项比对；再用 `RunDispatchJournal.readEvidence` 核验每个 evidence 侧车的存在与 hash
 *      （path + sha256 双绑、realpath 必须在 run 目录内）；
 *   4. 结果只有 `verified` / `missing` / `mismatch`。缺失（用户删了 Run/证据文件）与内容
 *      失配（hash/边界/计数不一致）都**不会**被当作 host_observed，调用方会降级并记录诊断。
 *
 * 暂时性存储故障（连接/超时等瞬时 I/O）直接抛出原始错误，由既有交付重试/死信生命周期
 * 处理——不能把一次抖动写成低置信度经验，也不能把它和内容损坏混为一谈。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DispatchJournalLine, DispatchRecord } from '../driver';
import type {
  BufferDispatchSummary,
  BufferRoleStatus,
  BufferSnapshotV2,
} from '../memory';
import type {
  LearningEvidenceVerifier,
  LearningInputEvidenceVerification,
} from '../memory/ports/learning-evidence-verifier';
import {
  foldDispatchJournalLines,
  RunDispatchJournal,
  RunDispatchJournalError,
} from '../persistence';
import {
  dispatchSummaryFromRecord,
  hashJournalPrefixLines,
} from './role-learning-input';

/** Buffer v2 契约允许的唯一 Journal 相对路径（与写入端一致）。 */
const JOURNAL_PREFIX_PATH = 'journal/dispatches.jsonl';
/** run_id 会当目录名使用：只允许安全段字符，杜绝 `..` 之类路径穿越。 */
const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/;

export interface RunJournalLearningEvidenceVerifierOptions {
  /** Run 目录根（生产为 `<stateRoot>/runs`）。 */
  runs_root: string;
}

export class RunJournalLearningEvidenceVerifier implements LearningEvidenceVerifier {
  constructor(private readonly options: RunJournalLearningEvidenceVerifierOptions) {}

  async verify(snapshot: BufferSnapshotV2): Promise<LearningInputEvidenceVerification> {
    const journalRef = snapshot.journal_ref;
    if (journalRef.path !== JOURNAL_PREFIX_PATH) {
      return mismatch(
        `Buffer v2 journal_ref.path ${journalRef.path} is not the contract path ${JOURNAL_PREFIX_PATH}; ` +
          'refusing to read an arbitrary local file.',
      );
    }
    if (!SAFE_RUN_ID.test(journalRef.run_id)) {
      return mismatch(
        `Buffer v2 journal_ref.run_id ${journalRef.run_id} is not a safe run-directory segment.`,
      );
    }

    const runsRoot = path.resolve(this.options.runs_root);
    const runDir = path.join(runsRoot, journalRef.run_id);
    let realRoot: string;
    let realRunDir: string;
    try {
      realRoot = await fs.realpath(runsRoot);
      realRunDir = await fs.realpath(runDir);
    } catch (error) {
      if (isMissingPath(error)) {
        return missing(
          `Run directory for ${journalRef.run_id} is gone; the Buffer v2 journal/evidence ` +
            'references can no longer be verified.',
        );
      }
      throw error;
    }
    const relative = path.relative(realRoot, realRunDir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return mismatch(
        `Run directory for ${journalRef.run_id} resolves outside the runs root; refusing to read it.`,
      );
    }

    let journal: RunDispatchJournal;
    try {
      // 只读打开：不取写锁、不创建文件。identity 先用占位 role；read() 不校验它，真正的
      // identity 从前缀行里取（Buffer v2 不保存 role_id，而 Journal 每行都带）。
      journal = await RunDispatchJournal.peek({
        runDir,
        identity: {
          run_id: journalRef.run_id,
          task_id: snapshot.source_task_id,
          role_id: 'learning-input-verifier',
        },
      });
    } catch (error) {
      if (isMissingPath(error)) {
        return missing(`Journal for run ${journalRef.run_id} is no longer readable.`);
      }
      throw error;
    }

    const read = await journal.read();
    if (read.kind !== 'journal' || read.status === 'absent') {
      return missing(
        `Run ${journalRef.run_id} has no dispatch journal; the Buffer v2 execution facts cannot be verified.`,
      );
    }
    if (read.status === 'corrupt') {
      return mismatch(
        `Dispatch journal for run ${journalRef.run_id} is corrupt: ${read.problems
          .map((problem) => `${problem.code}${problem.line !== undefined ? `@${String(problem.line)}` : ''}`)
          .join(', ')}`,
      );
    }

    const prefix = read.lines.slice(0, journalRef.lines);
    if (prefix.length < journalRef.lines) {
      return missing(
        `Dispatch journal for run ${journalRef.run_id} has only ${String(read.lines.length)} readable ` +
          `line(s); the frozen prefix requires ${String(journalRef.lines)}.`,
      );
    }
    const finishIndex = read.lines.map((line) => line.event).lastIndexOf('finish');
    if (finishIndex < 0) {
      return mismatch(`Dispatch journal for run ${journalRef.run_id} has no finish line.`);
    }
    if (finishIndex + 1 !== journalRef.lines) {
      return mismatch(
        `Buffer v2 prefix boundary is ${String(journalRef.lines)} line(s), but the Journal finish ` +
          `boundary is ${String(finishIndex + 1)}; the prefix is not the accepted finish boundary.`,
      );
    }

    const identity = identityOf(prefix);
    if (identity === undefined) {
      return mismatch(`Dispatch journal for run ${journalRef.run_id} has an empty prefix.`);
    }
    if (identity.run_id !== journalRef.run_id) {
      return mismatch(
        `Dispatch journal identity run_id=${identity.run_id} does not match Buffer v2 journal_ref.run_id=${journalRef.run_id}.`,
      );
    }
    if (identity.task_id !== snapshot.source_task_id) {
      return mismatch(
        `Dispatch journal identity task_id=${identity.task_id} does not match Buffer v2 source_task_id=${snapshot.source_task_id}.`,
      );
    }

    const actualHash = hashJournalPrefixLines(prefix);
    if (actualHash !== journalRef.sha256) {
      return mismatch(
        `Buffer v2 journal prefix sha256 ${journalRef.sha256} does not match the Journal content ` +
          `(${actualHash}); the frozen prefix was altered or the boundary moved.`,
      );
    }

    let fold;
    try {
      fold = foldDispatchJournalLines(prefix, identity);
    } catch (error) {
      if (error instanceof RunDispatchJournalError) {
        return mismatch(`Dispatch journal prefix failed controlled folding: ${error.code}: ${error.message}`);
      }
      throw error;
    }
    if (fold.finish === undefined) {
      return mismatch(`Dispatch journal prefix for run ${journalRef.run_id} has no finish control entry.`);
    }

    const rebuilt = fold.records.map(dispatchSummaryFromRecord);
    const mismatchReason = compareDispatches(snapshot.dispatches, rebuilt);
    if (mismatchReason !== undefined) {
      return mismatch(mismatchReason);
    }

    // evidence 侧车：受控读取（已登记 ref + 安全路径 + 全量 sha256），不用 Buffer 提供的
    // 任意路径。显式登记的 ref 来自**刚核验过的前缀折叠记录**（settled 的 evidence_sha256），
    // 不是 Buffer 自报；因此即使 Journal 在 finish 之后有半写尾巴，前缀里的证据仍可核验。
    for (const record of fold.records) {
      const ref = evidenceRefOf(record);
      if (ref === undefined) continue;
      try {
        await journal.registerEvidenceRef(ref);
        const page = await journal.readEvidence(ref);
        if (page.sha256 !== ref.sha256) {
          return mismatch(
            `Evidence ${ref.path} for dispatch ${record.dispatch_id} has sha256 ${page.sha256}, ` +
              `which does not match the recorded ref ${ref.sha256}.`,
          );
        }
      } catch (error) {
        if (error instanceof RunDispatchJournalError) {
          if (error.code === 'evidence_missing' || error.code === 'evidence_path_unsafe') {
            return missing(
              `Evidence ${ref.path} for dispatch ${record.dispatch_id} can no longer be read ` +
                `(${error.code}); the Buffer v2 host-observed checks are unverified.`,
            );
          }
          return mismatch(
            `Evidence ${ref.path} for dispatch ${record.dispatch_id} failed controlled reading: ` +
              `${error.code}: ${error.message}`,
          );
        }
        if (isMissingPath(error)) {
          return missing(
            `Evidence ${ref.path} for dispatch ${record.dispatch_id} is gone; the Buffer v2 ` +
              'host-observed checks are unverified.',
          );
        }
        throw error;
      }
    }

    return {
      status: 'verified',
      warnings:
        read.status === 'repairable_tail'
          ? [
              'Dispatch journal has a half-written tail; the frozen finish prefix was verified ' +
                'independently of it.',
            ]
          : [],
      dispatches: rebuilt,
      finish_status: roleStatusOf(fold.finish.status),
    };
  }
}

// ─────────────────────────────────────────────────────────────
//  纯辅助
// ─────────────────────────────────────────────────────────────

function missing(message: string): LearningInputEvidenceVerification {
  return { status: 'missing', warnings: [message] };
}

function mismatch(message: string): LearningInputEvidenceVerification {
  return { status: 'mismatch', warnings: [message] };
}

function identityOf(
  lines: readonly DispatchJournalLine[],
): { run_id: string; task_id: string; role_id: string } | undefined {
  const first = lines[0];
  if (first === undefined) return undefined;
  return { run_id: first.run_id, task_id: first.task_id, role_id: first.role_id };
}

function roleStatusOf(status: string): BufferRoleStatus {
  if (status === 'completed') return 'completed';
  if (status === 'blocked') return 'blocked';
  return 'failed';
}

/** 一条 Journal 记录需要核验的 evidence ref（与写入端摘要的 evidence_ref 同源）。 */
function evidenceRefOf(record: DispatchRecord): { path: string; sha256: string } | undefined {
  if (record.evidence_sha256 === undefined) return undefined;
  return {
    path: `journal/evidence/${record.dispatch_id}.json`,
    sha256: record.evidence_sha256,
  };
}

/**
 * Buffer 声称的派工摘要 vs Journal/evidence 重建的摘要。
 *
 * 任何一项不一致都返回可读原因：派工集合不是「Buffer 说的那份事实」，后续分级不得把它
 * 当成 host_observed。driver 身份也一起比——换 driver 不改变记忆归属，但会改变来源标签。
 */
function compareDispatches(
  claimed: readonly BufferDispatchSummary[],
  rebuilt: readonly BufferDispatchSummary[],
): string | undefined {
  if (claimed.length !== rebuilt.length) {
    return (
      `Buffer v2 claims ${String(claimed.length)} dispatch(es), but the verified Journal prefix ` +
      `contains ${String(rebuilt.length)}.`
    );
  }
  const claimedById = new Map(claimed.map((dispatch) => [dispatch.dispatch_id, dispatch] as const));
  for (const actual of rebuilt) {
    const summary = claimedById.get(actual.dispatch_id);
    if (summary === undefined) {
      return `Buffer v2 is missing dispatch ${actual.dispatch_id}, which the verified Journal records.`;
    }
    if (summary.kind !== actual.kind) {
      return `Buffer v2 dispatch ${actual.dispatch_id} kind=${summary.kind} does not match Journal kind=${actual.kind}.`;
    }
    if (summary.status !== actual.status) {
      return `Buffer v2 dispatch ${actual.dispatch_id} status=${summary.status} does not match Journal status=${actual.status}.`;
    }
    if (summary.driver_id !== actual.driver_id) {
      return `Buffer v2 dispatch ${actual.dispatch_id} driver_id=${summary.driver_id ?? '(none)'} does not match evidence driver_id=${actual.driver_id ?? '(none)'}.`;
    }
    const claimedRef = summary.evidence_ref;
    const actualRef = actual.evidence_ref;
    if (claimedRef?.path !== actualRef?.path || claimedRef?.sha256 !== actualRef?.sha256) {
      return (
        `Buffer v2 dispatch ${actual.dispatch_id} evidence_ref does not match the Journal settled ` +
        'evidence ref (path and sha256 must both match).'
      );
    }
    const checkKeys = [
      'host_observed_passed',
      'host_observed_failed',
      'driver_reported',
      'missing',
    ] as const;
    for (const key of checkKeys) {
      if (summary.checks[key] !== actual.checks[key]) {
        return (
          `Buffer v2 dispatch ${actual.dispatch_id} checks.${key}=${String(summary.checks[key])} ` +
          `does not match the count rebuilt from evidence (${String(actual.checks[key])}).`
        );
      }
    }
  }
  return undefined;
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
