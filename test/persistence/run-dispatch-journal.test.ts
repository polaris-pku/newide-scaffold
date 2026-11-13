/**
 * `RunDispatchJournal` 的行为测试：真实临时目录 + 可注入故障 I/O。
 *
 * 覆盖（阶段 1 / JRN-01/03/04/05、EVD-03/05）：
 * - 正常写序 accepted→dispatched→evidence→settled，read/fold 结果与 evidence ref hash；
 * - evidence 受控读取：未登记/穿越/超大/hash 失配/分页/幂等/冲突；
 * - 折叠：accepted-only=not_executed、dispatched-only=unknown、settled 不重发、语义 dedupe、
 *   冲突 fail closed、sequence 回退/跳号、entry_id dedupe/冲突、retry_of 取证链；
 * - 末尾半写修复（保留原字节与 hash、repair 行、修后可重复读取、中间坏行 fail closed）；
 * - 故障注入：accepted/dispatched/settled/evidence 写失败时状态可解释，不产生幽灵 settled；
 * - 实例内修改串行化与 close 生命周期：在途 append/evidence/repair 期间 close 不释放锁、
 *   B 拿不到写锁；同实例并发同 sequence 恰好一个成功；多个 close 共享同一关闭 Promise；
 *   close 前已准入的排队请求执行完、closing 后新请求明确拒绝；失败操作不毒化队列；
 * - legacy 无 journal 不创建文件；单写者锁；durability 降级不抛业务错误。
 *
 * 断言真实文件内容、fold 结果、稳定错误码与 I/O 调用次数，而不是只测 schema parse。
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DispatchJournalLine,
  DispatchRecord,
  EvidenceRef,
  ExecutionBrief,
  ExecutionEvidence,
} from '../../src/driver';
import {
  buildExecutionBrief,
  buildExecutionEvidence,
  DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
  DispatchAcceptedJournalEntrySchema,
  DispatchDispatchedJournalEntrySchema,
  DispatchReconciledJournalEntrySchema,
  DispatchSettledJournalEntrySchema,
  hashExecutionBrief,
  hashExecutionEvidence,
  JournalRepairEntrySchema,
} from '../../src/driver';
import type { DispatchJournalIo } from '../../src/persistence/run-dispatch-journal';
import {
  createNodeDispatchJournalIo,
  DISPATCH_JOURNAL_RECLAIM_GATE_DIR,
  foldDispatchJournalLines,
  JournalCorruptionError,
  RunDispatchJournal,
  RunDispatchJournalError,
} from '../../src/persistence/run-dispatch-journal';

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────

const IDENTITY = { run_id: 'run_1', task_id: 'task_1', role_id: 'role_1' };
const BUDGET = {
  dispatches_left: 11,
  role_tokens_left: 100_000,
  deadline_at: '2026-11-13T15:00:00.000Z',
};
const ACCEPTED_AT = '2026-11-13T13:00:00.000Z';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeRunDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'newide-dispatch-journal-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function openJournal(
  runDir: string,
  options: { io?: DispatchJournalIo; maxEvidenceBytes?: number } = {},
): Promise<RunDispatchJournal> {
  return RunDispatchJournal.open({
    runDir,
    identity: IDENTITY,
    ...(options.io !== undefined ? { io: options.io } : {}),
    ...(options.maxEvidenceBytes !== undefined
      ? { maxEvidenceBytes: options.maxEvidenceBytes }
      : {}),
  });
}

interface BriefOverrides {
  retry_of?: string;
  reconciliation_ref?: EvidenceRef;
}

function makeBrief(
  dispatchId: string,
  sequence: number,
  overrides: BriefOverrides = {},
): ExecutionBrief {
  return buildExecutionBrief({
    identity: {
      dispatch_id: dispatchId,
      run_id: IDENTITY.run_id,
      task_id: IDENTITY.task_id,
      role_id: IDENTITY.role_id,
      sequence,
      accepted_at: ACCEPTED_AT,
    },
    request: {
      kind: 'execute',
      instruction: `execute ${dispatchId}`,
      ...(overrides.retry_of !== undefined ? { retry_of: overrides.retry_of } : {}),
      ...(overrides.reconciliation_ref !== undefined
        ? { reconciliation_ref: overrides.reconciliation_ref }
        : {}),
    },
  }).brief;
}

type EvidenceStatus = 'succeeded' | 'failed' | 'unknown';

function makeEvidence(dispatchId: string, status: EvidenceStatus = 'succeeded'): ExecutionEvidence {
  if (status === 'succeeded') {
    return buildExecutionEvidence({
      dispatch_id: dispatchId,
      observation: {
        transport: { evidence: 'execution_unconfirmed' },
        result: { status: 'succeeded', response: 'done' },
      },
    });
  }
  if (status === 'failed') {
    return buildExecutionEvidence({
      dispatch_id: dispatchId,
      observation: {
        transport: { evidence: 'execution_unconfirmed' },
        result: { status: 'failed' },
        error: { code: 'E_FAIL', message: 'boom', retryable: false },
      },
    });
  }
  return buildExecutionEvidence({
    dispatch_id: dispatchId,
    observation: { transport: { evidence: 'execution_unconfirmed' } },
  });
}

async function appendAccepted(
  journal: RunDispatchJournal,
  dispatchId: string,
  sequence: number,
  overrides: BriefOverrides = {},
): Promise<ExecutionBrief> {
  const brief = makeBrief(dispatchId, sequence, overrides);
  await journal.appendAccepted({
    brief,
    brief_sha256: hashExecutionBrief(brief),
    budget_before: BUDGET,
  });
  return brief;
}

interface FullDispatch {
  brief: ExecutionBrief;
  evidence: ExecutionEvidence;
  ref: { ref: EvidenceRef; sha256: string };
}

async function appendFullDispatch(
  journal: RunDispatchJournal,
  dispatchId: string,
  sequence: number,
): Promise<FullDispatch> {
  const brief = await appendAccepted(journal, dispatchId, sequence);
  await journal.appendDispatched({
    dispatch_id: dispatchId,
    adp_exchange_id: `exchange_${dispatchId}`,
  });
  const evidence = makeEvidence(dispatchId);
  const ref = await journal.appendEvidence({ dispatch_id: dispatchId, evidence });
  // ref.sha256 与 settled 的 evidence_sha256 同源（canonical JSON），集成方可以直接复用。
  expect(ref.sha256).toBe(hashExecutionEvidence(evidence));
  await journal.appendSettled({
    dispatch_id: dispatchId,
    status: 'succeeded',
    evidence,
    evidence_sha256: ref.sha256,
    violations: [],
  });
  return { brief, evidence, ref };
}

function journalFilePath(runDir: string): string {
  return path.join(runDir, 'journal', 'dispatches.jsonl');
}

function lockDirPath(runDir: string): string {
  return path.join(runDir, 'journal', '.writer.lock');
}

function gateDirPath(runDir: string): string {
  return path.join(runDir, 'journal', DISPATCH_JOURNAL_RECLAIM_GATE_DIR);
}

function lockOwnerPath(runDir: string): string {
  return path.join(lockDirPath(runDir), 'owner.json');
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

/** 一次性放行信号（确定性并发测试用，不 sleep）。 */
function createDeferred(): Deferred {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve: () => resolve?.() };
}

interface LockOwnerFixture {
  pid: number;
  token: string;
  created_at: string;
  run_id: string;
}

async function readLockOwner(runDir: string): Promise<LockOwnerFixture> {
  return JSON.parse(await readFile(lockOwnerPath(runDir), 'utf8')) as LockOwnerFixture;
}

async function createStaleLock(
  runDir: string,
  options: { pid?: number; token?: string } = {},
): Promise<LockOwnerFixture> {
  const owner: LockOwnerFixture = {
    pid: options.pid ?? 999_999,
    token: options.token ?? 'stale-token',
    created_at: ACCEPTED_AT,
    run_id: IDENTITY.run_id,
  };
  await mkdir(lockDirPath(runDir), { recursive: true });
  await writeFile(lockOwnerPath(runDir), JSON.stringify(owner), 'utf8');
  return owner;
}

/** 去掉 journal 文件末尾换行（模拟「完整 JSON 行但没写换行」）。 */
async function stripTrailingNewline(filePath: string): Promise<string> {
  const text = await readFile(filePath, 'utf8');
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text;
  await writeFile(filePath, stripped, 'utf8');
  return stripped;
}

async function readJournalLines(runDir: string): Promise<unknown[]> {
  const text = await readFile(journalFilePath(runDir), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof RunDispatchJournalError ? error.code : `not-a-journal-error:${String(error)}`;
  }
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`injected ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

interface FaultOptions {
  method: keyof DispatchJournalIo;
  occurrence: number;
  mode?: 'before' | 'after';
  code?: string;
}

interface FaultyIo {
  io: DispatchJournalIo;
  calls: string[];
}

/** 计数 wrapper：指定方法的第 N 次调用抛错（可在真实写入前/后抛）。 */
function createFaultyIo(options: FaultOptions): FaultyIo {
  const base = createNodeDispatchJournalIo();
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const hit = (method: string): boolean => {
    calls.push(method);
    const count = (counts.get(method) ?? 0) + 1;
    counts.set(method, count);
    return options.method === method && options.occurrence === count;
  };
  const fail = (): never => {
    throw errnoError(options.code ?? 'EIO');
  };
  const io: DispatchJournalIo = {
    async readFile(filePath) {
      if (hit('readFile')) fail();
      return base.readFile(filePath);
    },
    async writeFileExclusive(filePath, data) {
      if (hit('writeFileExclusive')) fail();
      return base.writeFileExclusive(filePath, data);
    },
    async appendLineWithFsync(filePath, line) {
      const shouldFail = hit('appendLineWithFsync');
      if (shouldFail && (options.mode ?? 'before') === 'before') fail();
      await base.appendLineWithFsync(filePath, line);
      if (shouldFail) fail();
    },
    async appendLineTerminator(filePath) {
      const shouldFail = hit('appendLineTerminator');
      if (shouldFail && (options.mode ?? 'before') === 'before') fail();
      await base.appendLineTerminator(filePath);
      if (shouldFail) fail();
    },
    async mkdir(dirPath) {
      if (hit('mkdir')) fail();
      return base.mkdir(dirPath);
    },
    async mkdirExclusive(dirPath) {
      if (hit('mkdirExclusive')) fail();
      return base.mkdirExclusive(dirPath);
    },
    async rmdir(dirPath) {
      if (hit('rmdir')) fail();
      return base.rmdir(dirPath);
    },
    async readdir(dirPath) {
      if (hit('readdir')) fail();
      return base.readdir(dirPath);
    },
    async stat(filePath) {
      if (hit('stat')) fail();
      return base.stat(filePath);
    },
    async rename(fromPath, toPath) {
      if (hit('rename')) fail();
      return base.rename(fromPath, toPath);
    },
    async unlink(filePath) {
      if (hit('unlink')) fail();
      return base.unlink(filePath);
    },
    async syncDirectory(dirPath) {
      if (hit('syncDirectory')) fail();
      return base.syncDirectory(dirPath);
    },
    async realpath(filePath) {
      if (hit('realpath')) fail();
      return base.realpath(filePath);
    },
  };
  return { io, calls };
}

// 手工构造 journal 行（用于损坏/冲突/修复路径的确定性输入）。
function makeAcceptedLine(
  dispatchId: string,
  sequence: number,
  brief: ExecutionBrief,
  entryId = `entry_accepted_${dispatchId}`,
  identity: { run_id: string; task_id: string; role_id: string } = IDENTITY,
): DispatchJournalLine {
  return DispatchAcceptedJournalEntrySchema.parse({
    schema_version: DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
    entry_id: entryId,
    dispatch_id: dispatchId,
    run_id: identity.run_id,
    task_id: identity.task_id,
    role_id: identity.role_id,
    sequence,
    at: brief.accepted_at,
    event: 'accepted',
    brief,
    brief_sha256: hashExecutionBrief(brief),
    budget_before: BUDGET,
  });
}

function makeDispatchedLine(
  dispatchId: string,
  sequence: number,
  entryId = `entry_dispatched_${dispatchId}`,
): DispatchJournalLine {
  return DispatchDispatchedJournalEntrySchema.parse({
    schema_version: DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
    entry_id: entryId,
    dispatch_id: dispatchId,
    run_id: IDENTITY.run_id,
    task_id: IDENTITY.task_id,
    role_id: IDENTITY.role_id,
    sequence,
    at: ACCEPTED_AT,
    event: 'dispatched',
    adp_exchange_id: `exchange_${dispatchId}`,
  });
}

function makeSettledLine(
  dispatchId: string,
  sequence: number,
  evidence: ExecutionEvidence,
  entryId = `entry_settled_${dispatchId}`,
): DispatchJournalLine {
  return DispatchSettledJournalEntrySchema.parse({
    schema_version: DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
    entry_id: entryId,
    dispatch_id: dispatchId,
    run_id: IDENTITY.run_id,
    task_id: IDENTITY.task_id,
    role_id: IDENTITY.role_id,
    sequence,
    at: ACCEPTED_AT,
    event: 'settled',
    status: evidence.status,
    evidence,
    evidence_sha256: hashExecutionEvidence(evidence),
    violations: [],
  });
}

function makeReconciledLine(
  dispatchId: string,
  sequence: number,
  status: 'succeeded' | 'failed' | 'unknown',
  entryId = `entry_reconciled_${dispatchId}`,
  reason = `reconciled ${status}`,
): DispatchJournalLine {
  return DispatchReconciledJournalEntrySchema.parse({
    schema_version: DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
    entry_id: entryId,
    dispatch_id: dispatchId,
    run_id: IDENTITY.run_id,
    task_id: IDENTITY.task_id,
    role_id: IDENTITY.role_id,
    sequence,
    at: ACCEPTED_AT,
    event: 'reconciled',
    status,
    reason,
  });
}

function errorCodeOf(error: unknown): string | undefined {
  return error instanceof RunDispatchJournalError ? error.code : undefined;
}

// ─────────────────────────────────────────────────────────────
// 正常写序
// ─────────────────────────────────────────────────────────────

describe('RunDispatchJournal: 正常写序与折叠', () => {
  it('accepted→dispatched→evidence→settled 落盘后 read/fold 正确', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    const dispatchId = 'dsp_happy';
    const { evidence, ref } = await appendFullDispatch(journal, dispatchId, 1);

    const snapshot = await journal.read();
    expect(snapshot.kind).toBe('journal');
    expect(snapshot.status).toBe('ok');
    // evidence 是侧车文件，不是 journal 行：accepted / dispatched / settled 三行。
    expect(snapshot.lines).toHaveLength(3);
    expect(snapshot.entries.map((entry) => entry.event)).toEqual([
      'accepted',
      'dispatched',
      'settled',
    ]);

    // 落盘事实：3 行 JSONL，每行一个完整 schema 行。
    const rawLines = await readJournalLines(runDir);
    expect(rawLines).toHaveLength(3);
    expect(rawLines.map((line) => (line as { event: string }).event)).toEqual([
      'accepted',
      'dispatched',
      'settled',
    ]);

    // evidence 侧车：路径/文件字节/hash 一致；侧车 hash 与 settled 的 evidence_sha256 同源。
    expect(ref.ref.path).toBe(`journal/evidence/${dispatchId}.json`);
    expect(ref.sha256).toBe(ref.ref.sha256);
    expect(ref.sha256).toBe(hashExecutionEvidence(evidence));
    const sidecarPath = path.join(runDir, 'journal', 'evidence', `${dispatchId}.json`);
    const sidecarBytes = await readFile(sidecarPath);
    expect(sha256(sidecarBytes)).toBe(ref.sha256);
    expect(JSON.parse(sidecarBytes.toString('utf8'))).toEqual(evidence);

    const fold = await journal.fold();
    expect(fold.records).toHaveLength(1);
    const record = fold.records[0] as DispatchRecord;
    expect(record.dispatch_id).toBe(dispatchId);
    expect(record.phase).toBe('settled');
    expect(record.status).toBe('succeeded');
    expect(record.sequence).toBe(1);
    expect(record.brief_sha256).toBe(hashExecutionBrief(record.brief));
    expect(record.evidence_sha256).toBe(hashExecutionEvidence(evidence));
    expect(record.evidence).toEqual(evidence);
    expect(typeof record.dispatched_at).toBe('string');
    expect(record.adp_exchange_id).toBe(`exchange_${dispatchId}`);
    expect(record.violations).toEqual([]);

    await expect(journal.getDispatchRecord(dispatchId)).resolves.toEqual(record);
    await expect(journal.getDispatchRecord('dsp_missing')).resolves.toBeUndefined();
    await expect(journal.findDispatchIdByExchange(`exchange_${dispatchId}`)).resolves.toBe(dispatchId);
    await expect(journal.findDispatchIdByExchange('exchange_missing')).resolves.toBeUndefined();

    await journal.close();
  });

  it('accepted-only 折叠为 not_executed，dispatched-only 折叠为 unknown', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    await appendAccepted(journal, 'dsp_accepted', 1);
    await appendAccepted(journal, 'dsp_dispatched', 2);
    await journal.appendDispatched({ dispatch_id: 'dsp_dispatched' });

    const fold = await journal.fold();
    expect(fold.records).toHaveLength(2);
    expect(fold.byDispatchId.get('dsp_accepted')).toMatchObject({
      phase: 'accepted',
      status: 'not_executed',
    });
    expect(fold.byDispatchId.get('dsp_accepted')?.dispatched_at).toBeUndefined();
    expect(fold.byDispatchId.get('dsp_dispatched')).toMatchObject({
      phase: 'dispatched',
      status: 'unknown',
    });
    // 未 settled 的 dispatch 不能重发（journal 仍只有 accepted+dispatched 两行）。
    expect(fold.records.every((record) => record.settled_at === undefined)).toBe(true);

    await journal.close();
  });

  it('重复 settled 语义幂等（忽略 entry_id/at），不重复计数', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    const dispatchId = 'dsp_dup_settled';
    await appendAccepted(journal, dispatchId, 1);
    await journal.appendDispatched({ dispatch_id: dispatchId });
    const evidence = makeEvidence(dispatchId);
    const settledInput = {
      dispatch_id: dispatchId,
      status: 'succeeded' as const,
      evidence,
      evidence_sha256: hashExecutionEvidence(evidence),
      violations: [],
    };
    await journal.appendSettled(settledInput);
    const lineCountAfterFirst = (await journal.read()).lines.length;

    // 新 entry_id + 新 at，但语义相同 → 幂等成功且不追加。
    await journal.appendSettled({
      ...settledInput,
      entry_id: 'entry_settled_retry',
      at: '2026-11-13T13:05:00.000Z',
    });
    expect((await journal.read()).lines.length).toBe(lineCountAfterFirst);
    expect((await journal.fold()).records[0]?.phase).toBe('settled');

    // 冲突 settled（不同 evidence/status）→ fail closed。
    const failedEvidence = makeEvidence(dispatchId, 'failed');
    expect(
      await rejectionCode(
        journal.appendSettled({
          dispatch_id: dispatchId,
          status: 'failed',
          evidence: failedEvidence,
          evidence_sha256: hashExecutionEvidence(failedEvidence),
          violations: [],
        }),
      ),
    ).toBe('journal_conflict');

    await journal.close();
  });

  it('fold 对冲突 settled / 重复 entry_id 不同内容 fail closed', async () => {
    const brief = makeBrief('dsp_fold', 1);
    const accepted = makeAcceptedLine('dsp_fold', 1, brief);
    const dispatched = makeDispatchedLine('dsp_fold', 1);
    const succeeded = makeSettledLine('dsp_fold', 1, makeEvidence('dsp_fold', 'succeeded'));
    const failed = makeSettledLine(
      'dsp_fold',
      1,
      makeEvidence('dsp_fold', 'failed'),
      'entry_settled_conflict',
    );

    expect(() => foldDispatchJournalLines([accepted, dispatched, succeeded, failed], IDENTITY)).toThrow(
      JournalCorruptionError,
    );
    try {
      foldDispatchJournalLines([accepted, dispatched, succeeded, failed], IDENTITY);
    } catch (error) {
      expect(errorCodeOf(error)).toBe('journal_conflict');
    }

    // 同 entry_id 同内容 dedupe（at 不同也视为同一次写重试）。
    const duplicate = { ...accepted, at: '2026-11-13T13:09:00.000Z' } as DispatchJournalLine;
    const deduped = foldDispatchJournalLines([accepted, duplicate], IDENTITY);
    expect(deduped.records).toHaveLength(1);
    expect(deduped.entry_count).toBe(1);

    // 同 entry_id 不同内容 conflict。
    const reused = makeAcceptedLine('dsp_fold_other', 1, makeBrief('dsp_fold_other', 1));
    expect(() =>
      foldDispatchJournalLines([accepted, { ...reused, entry_id: accepted.entry_id }], IDENTITY),
    ).toThrow(JournalCorruptionError);
  });

  it('settled 先于 dispatched / sequence 回退在 fold 中 fail closed', async () => {
    const brief = makeBrief('dsp_early', 1);
    const accepted = makeAcceptedLine('dsp_early', 1, brief);
    const settled = makeSettledLine('dsp_early', 1, makeEvidence('dsp_early'));

    expect(() => foldDispatchJournalLines([accepted, settled], IDENTITY)).toThrow(
      JournalCorruptionError,
    );
    try {
      foldDispatchJournalLines([accepted, settled], IDENTITY);
    } catch (error) {
      expect(errorCodeOf(error)).toBe('journal_corrupt');
    }

    // accepted sequence 跳号（1 后直接 3）。
    const second = makeAcceptedLine('dsp_gap', 3, makeBrief('dsp_gap', 3));
    try {
      foldDispatchJournalLines([accepted, second], IDENTITY);
      throw new Error('expected sequence regression');
    } catch (error) {
      expect(errorCodeOf(error)).toBe('journal_sequence_regression');
    }

    // 身份不符。
    const foreignBrief = buildExecutionBrief({
      identity: {
        dispatch_id: 'dsp_foreign',
        run_id: 'run_other',
        task_id: IDENTITY.task_id,
        role_id: IDENTITY.role_id,
        sequence: 1,
        accepted_at: ACCEPTED_AT,
      },
      request: { kind: 'execute', instruction: 'foreign' },
    }).brief;
    const foreign = makeAcceptedLine('dsp_foreign', 1, foreignBrief, undefined, {
      run_id: 'run_other',
      task_id: IDENTITY.task_id,
      role_id: IDENTITY.role_id,
    });
    try {
      foldDispatchJournalLines([foreign], IDENTITY);
      throw new Error('expected identity mismatch');
    } catch (error) {
      expect(errorCodeOf(error)).toBe('journal_identity_mismatch');
    }
  });

  it('重复 settled 按语义 hash dedupe（忽略 entry_id/at），不重复计数', () => {
    const brief = makeBrief('dsp_settled_dedupe', 1);
    const accepted = makeAcceptedLine('dsp_settled_dedupe', 1, brief);
    const dispatched = makeDispatchedLine('dsp_settled_dedupe', 1);
    const evidence = makeEvidence('dsp_settled_dedupe');
    const first = makeSettledLine('dsp_settled_dedupe', 1, evidence, 'entry_settled_a');
    const second = {
      ...makeSettledLine('dsp_settled_dedupe', 1, evidence, 'entry_settled_b'),
      at: '2026-11-13T13:30:00.000Z',
    } as DispatchJournalLine;
    const fold = foldDispatchJournalLines([accepted, dispatched, first, second], IDENTITY);
    expect(fold.records).toHaveLength(1);
    expect(fold.records[0]).toMatchObject({ phase: 'settled', status: 'succeeded' });
  });

  it('reconciled：unknown→可信升级一次，两个可信 status 冲突', () => {
    const brief = makeBrief('dsp_recon', 1);
    const accepted = makeAcceptedLine('dsp_recon', 1, brief);
    const dispatched = makeDispatchedLine('dsp_recon', 1);
    const upgraded = foldDispatchJournalLines(
      [accepted, dispatched, makeReconciledLine('dsp_recon', 1, 'succeeded')],
      IDENTITY,
    );
    expect(upgraded.records[0]).toMatchObject({ phase: 'dispatched', status: 'succeeded' });
    expect(upgraded.records[0]?.reconciled?.status).toBe('succeeded');

    // 同语义重复（不同 entry_id/at）dedupe。
    const duplicate = {
      ...makeReconciledLine('dsp_recon', 1, 'succeeded', 'entry_reconciled_dup'),
      at: '2026-11-13T13:30:00.000Z',
    } as DispatchJournalLine;
    const deduped = foldDispatchJournalLines(
      [accepted, dispatched, makeReconciledLine('dsp_recon', 1, 'succeeded'), duplicate],
      IDENTITY,
    );
    expect(deduped.records[0]?.status).toBe('succeeded');

    // 两个不同的可信 status 冲突。
    try {
      foldDispatchJournalLines(
        [
          accepted,
          dispatched,
          makeReconciledLine('dsp_recon', 1, 'succeeded'),
          makeReconciledLine('dsp_recon', 1, 'failed', 'entry_reconciled_conflict'),
        ],
        IDENTITY,
      );
      throw new Error('expected reconciled conflict');
    } catch (error) {
      expect(errorCodeOf(error)).toBe('journal_conflict');
    }
  });

  it('迟到 reconciled 只写 record.reconciled，不改已 settled 的 status', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    const dispatchId = 'dsp_late_reconciled';
    await appendFullDispatch(journal, dispatchId, 1);

    await journal.appendReconciled({
      dispatch_id: dispatchId,
      status: 'failed',
      reason: 'late ADP receipt says failed',
    });
    const record = (await journal.fold()).records[0] as DispatchRecord;
    expect(record.phase).toBe('settled');
    expect(record.status).toBe('succeeded');
    expect(record.reconciled).toMatchObject({
      status: 'failed',
      reason: 'late ADP receipt says failed',
    });

    // 两个不同的可信 reconciled status 冲突。
    expect(
      await rejectionCode(
        journal.appendReconciled({ dispatch_id: dispatchId, status: 'succeeded', reason: 'other' }),
      ),
    ).toBe('journal_conflict');
    await journal.close();
  });

  it('init/finish/repair 控制行不伪造 dispatch', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    await journal.appendInit({
      autonomy: true,
      evidence_only: true,
      buffer_v2: true,
      max_dispatches: 12,
      max_role_rounds: 40,
      role_token_budget: 120_000,
      deadline_at: '2026-11-13T15:00:00.000Z',
    });
    await journal.appendFinish({
      actor: 'role',
      status: 'completed',
      reason: 'done',
      evidence_refs: [],
    });
    const fold = await journal.fold();
    expect(fold.records).toEqual([]);
    expect(fold.init?.event).toBe('init');
    expect(fold.finish?.status).toBe('completed');
    expect((await journal.read()).entries).toEqual([]);
    await journal.close();
  });
});

// ─────────────────────────────────────────────────────────────
// append 校验
// ─────────────────────────────────────────────────────────────

describe('RunDispatchJournal: append 校验', () => {
  it('拒绝重复 dispatch、sequence 回退/跳号、身份与 hash 不符', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    const brief = await appendAccepted(journal, 'dsp_seq', 1);

    expect(
      await rejectionCode(
        journal.appendAccepted({
          brief,
          brief_sha256: hashExecutionBrief(brief),
          budget_before: BUDGET,
        }),
      ),
    ).toBe('journal_duplicate_dispatch');

    const skip = makeBrief('dsp_skip', 3);
    expect(
      await rejectionCode(
        journal.appendAccepted({
          brief: skip,
          brief_sha256: hashExecutionBrief(skip),
          budget_before: BUDGET,
        }),
      ),
    ).toBe('journal_sequence_regression');

    const foreign = makeBrief('dsp_foreign', 2);
    const foreignRun = { ...foreign, run_id: 'run_other' };
    expect(
      await rejectionCode(
        journal.appendAccepted({
          brief: foreignRun,
          brief_sha256: hashExecutionBrief(foreignRun),
          budget_before: BUDGET,
        }),
      ),
    ).toBe('journal_identity_mismatch');

    const next = makeBrief('dsp_hash', 2);
    expect(
      await rejectionCode(
        journal.appendAccepted({
          brief: next,
          brief_sha256: 'f'.repeat(64),
          budget_before: BUDGET,
        }),
      ),
    ).toBe('journal_hash_mismatch');

    // 失败都不留下行。
    expect((await journal.read()).lines).toHaveLength(1);
    await journal.close();
  });

  it('同 entry_id 写重试幂等 dedupe 成功，不追加第二行', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    const brief = makeBrief('dsp_entry', 1);
    const input = {
      brief,
      brief_sha256: hashExecutionBrief(brief),
      budget_before: BUDGET,
      entry_id: 'entry_accepted_retry',
    };
    await journal.appendAccepted(input);
    await journal.appendAccepted(input);
    expect((await journal.read()).lines).toHaveLength(1);
    expect((await journal.fold()).records).toHaveLength(1);

    // 同 entry_id 不同内容 → conflict。
    const other = makeBrief('dsp_entry_other', 2);
    expect(
      await rejectionCode(
        journal.appendAccepted({
          brief: other,
          brief_sha256: hashExecutionBrief(other),
          budget_before: BUDGET,
          entry_id: 'entry_accepted_retry',
        }),
      ),
    ).toBe('journal_conflict');
    await journal.close();
  });

  it('appendDispatched / appendSettled / appendEvidence 对未知或乱序 dispatch 拒绝', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    expect(await rejectionCode(journal.appendDispatched({ dispatch_id: 'dsp_none' }))).toBe(
      'journal_unknown_dispatch',
    );

    await appendAccepted(journal, 'dsp_order', 1);
    const evidence = makeEvidence('dsp_order');
    expect(
      await rejectionCode(journal.appendSettled({
        dispatch_id: 'dsp_order',
        status: 'succeeded',
        evidence,
        evidence_sha256: hashExecutionEvidence(evidence),
        violations: [],
      })),
    ).toBe('journal_conflict');
    expect(await rejectionCode(journal.appendEvidence({ dispatch_id: 'dsp_order', evidence }))).toBe(
      'journal_conflict',
    );

    await journal.appendDispatched({ dispatch_id: 'dsp_order' });
    await journal.appendDispatched({ dispatch_id: 'dsp_order', entry_id: 'entry_disp_retry' });
    expect((await journal.read()).lines).toHaveLength(2);
    await journal.close();
  });
});

// ─────────────────────────────────────────────────────────────
// retry_of 取证链
// ─────────────────────────────────────────────────────────────

describe('RunDispatchJournal: retry_of 取证链', () => {
  it('拒绝未知/已成功目标；unknown 目标必须带已登记 reconciliation_ref', async () => {
    const runDir = await makeRunDir();
    let journal = await openJournal(runDir);
    await appendFullDispatch(journal, 'dsp_done', 1);
    await appendAccepted(journal, 'dsp_unknown', 2);
    await journal.appendDispatched({ dispatch_id: 'dsp_unknown' });

    const unknown = (await journal.fold()).byDispatchId.get('dsp_unknown');
    expect(unknown?.status).toBe('unknown');

    // 未知目标。
    const missing = makeBrief('dsp_retry_missing', 3, { retry_of: 'dsp_does_not_exist' });
    expect(
      await rejectionCode(
        journal.appendAccepted({
          brief: missing,
          brief_sha256: hashExecutionBrief(missing),
          budget_before: BUDGET,
        }),
      ),
    ).toBe('journal_retry_not_allowed');

    // unknown 目标但没带 reconciliation_ref。
    const noEvidence = makeBrief('dsp_retry_no_evidence', 3, { retry_of: 'dsp_unknown' });
    expect(
      await rejectionCode(
        journal.appendAccepted({
          brief: noEvidence,
          brief_sha256: hashExecutionBrief(noEvidence),
          budget_before: BUDGET,
        }),
      ),
    ).toBe('journal_retry_without_evidence');

    // 带了未登记的 ref 仍然拒绝。
    const unregisteredRef: EvidenceRef = { path: 'journal/evidence/nope.json', sha256: 'a'.repeat(64) };
    const unregistered = makeBrief('dsp_retry_unregistered', 3, {
      retry_of: 'dsp_unknown',
      reconciliation_ref: unregisteredRef,
    });
    expect(
      await rejectionCode(
        journal.appendAccepted({
          brief: unregistered,
          brief_sha256: hashExecutionBrief(unregistered),
          budget_before: BUDGET,
        }),
      ),
    ).toBe('journal_retry_without_evidence');

    // 显式登记后可重派。
    await journal.registerEvidenceRef(unregisteredRef);
    await journal.appendAccepted({
      brief: unregistered,
      brief_sha256: hashExecutionBrief(unregistered),
      budget_before: BUDGET,
    });

    // 已成功的 dispatch 不可重派。
    const succeededRetry = makeBrief('dsp_retry_done', 4, { retry_of: 'dsp_done' });
    expect(
      await rejectionCode(
        journal.appendAccepted({
          brief: succeededRetry,
          brief_sha256: hashExecutionBrief(succeededRetry),
          budget_before: BUDGET,
        }),
      ),
    ).toBe('journal_retry_not_allowed');

    await journal.close();
    journal = await openJournal(runDir);

    // 新进程（内存 registry 为空）：settled dispatch 的 evidence 侧车是折叠派生的已登记 ref。
    const doneEvidencePath = path.join(runDir, 'journal', 'evidence', 'dsp_done.json');
    const doneEvidenceRef: EvidenceRef = {
      path: 'journal/evidence/dsp_done.json',
      sha256: sha256(await readFile(doneEvidencePath)),
    };
    const derived = makeBrief('dsp_retry_derived', 4, {
      retry_of: 'dsp_unknown',
      reconciliation_ref: doneEvidenceRef,
    });
    await journal.appendAccepted({
      brief: derived,
      brief_sha256: hashExecutionBrief(derived),
      budget_before: BUDGET,
    });
    await journal.close();
  });
});

// ─────────────────────────────────────────────────────────────
// evidence 受控 ref
// ─────────────────────────────────────────────────────────────

describe('RunDispatchJournal: evidence 受控 ref', () => {
  it('readEvidence 校验 hash、支持分页且拒绝未登记/穿越/超大', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    const dispatchId = 'dsp_evidence';
    const { evidence, ref } = await appendFullDispatch(journal, dispatchId, 1);

    const full = await journal.readEvidence(ref.ref);
    const fileText = await readFile(
      path.join(runDir, 'journal', 'evidence', `${dispatchId}.json`),
      'utf8',
    );
    expect(full.text).toBe(fileText);
    expect(full.sha256).toBe(ref.sha256);
    // 侧车字节是 canonical JSON：readEvidence 的 sha256 与 settled 的 evidence_sha256 同源。
    expect(full.sha256).toBe(hashExecutionEvidence(evidence));
    expect(full.total_bytes).toBe(Buffer.byteLength(fileText));
    expect(full.truncated).toBe(false);

    const page = await journal.readEvidence(ref.ref, { offset: 3, limit: 7 });
    expect(page.text).toBe(fileText.slice(3, 10));
    expect(page.offset).toBe(3);
    expect(page.limit).toBe(7);
    expect(page.truncated).toBe(true);

    // 未登记路径。
    expect(
      await rejectionCode(
        journal.readEvidence({ path: 'journal/evidence/unregistered.json', sha256: ref.sha256 }),
      ),
    ).toBe('evidence_ref_not_registered');

    // 路径穿越 / 绝对路径 / file:// 一律拒绝。
    expect(
      await rejectionCode(journal.readEvidence({ path: '../outside.json', sha256: ref.sha256 })),
    ).toBe('evidence_path_unsafe');
    expect(
      await rejectionCode(journal.readEvidence({ path: '/etc/passwd', sha256: ref.sha256 })),
    ).toBe('evidence_path_unsafe');
    expect(
      await rejectionCode(journal.readEvidence({ path: 'file:///etc/passwd', sha256: ref.sha256 })),
    ).toBe('evidence_path_unsafe');

    // 受控 ref 不可重定义：同路径不同 sha 的显式登记被拒（否则可绕过 settled 身份绑定）。
    const wrongRef: EvidenceRef = { path: ref.ref.path, sha256: 'b'.repeat(64) };
    expect(await rejectionCode(journal.registerEvidenceRef(wrongRef))).toBe('evidence_ref_conflict');
    // 未登记的 sha 仍然读不到。
    expect(await rejectionCode(journal.readEvidence(wrongRef))).toBe('evidence_ref_not_registered');

    await journal.close();
  });

  it('evidence 侧车超大时拒绝读取；同内容幂等、不同内容冲突', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir, { maxEvidenceBytes: 64 });
    const dispatchId = 'dsp_large';
    await appendAccepted(journal, dispatchId, 1);
    await journal.appendDispatched({ dispatch_id: dispatchId });
    const evidence = makeEvidence(dispatchId);
    const first = await journal.appendEvidence({ dispatch_id: dispatchId, evidence });
    const second = await journal.appendEvidence({ dispatch_id: dispatchId, evidence });
    expect(second).toEqual(first);

    const files = await readdir(path.join(runDir, 'journal', 'evidence'));
    expect(files).toEqual([`${dispatchId}.json`]);

    expect(await rejectionCode(journal.readEvidence(first.ref))).toBe('evidence_too_large');

    const conflicting = makeEvidence(dispatchId, 'failed');
    expect(
      await rejectionCode(journal.appendEvidence({ dispatch_id: dispatchId, evidence: conflicting })),
    ).toBe('journal_evidence_conflict');

    await journal.close();
  });
});

// ─────────────────────────────────────────────────────────────
// evidence 派生 ref 绑定 settled 的 evidence_sha256（FIX 4 回归）
// ─────────────────────────────────────────────────────────────

describe('RunDispatchJournal: evidence 派生 ref 绑定 evidence_sha256', () => {
  it('重开后派生侧车 ref 仍可读；篡改文件/换 hash 均被拒', async () => {
    const runDir = await makeRunDir();
    let journal = await openJournal(runDir);
    const dispatchId = 'dsp_ref_binding';
    const { evidence, ref } = await appendFullDispatch(journal, dispatchId, 1);
    const derivedPath = `journal/evidence/${dispatchId}.json`;
    expect(ref.ref.path).toBe(derivedPath);
    expect(ref.sha256).toBe(hashExecutionEvidence(evidence));
    await journal.close();

    // 新进程（内存 registry 为空）：派生路径绑定 settled 的 evidence_sha256。
    journal = await openJournal(runDir);
    await expect(
      journal.readEvidence({ path: derivedPath, sha256: ref.sha256 }),
    ).resolves.toMatchObject({ sha256: ref.sha256 });

    // 篡改侧车文件：原 ref 仍登记，但字节 hash 失配 → 拒绝。
    const sidecar = path.join(runDir, 'journal', 'evidence', `${dispatchId}.json`);
    const tampered = Buffer.from('{"tampered":true}', 'utf8');
    await writeFile(sidecar, tampered);
    expect(
      await rejectionCode(journal.readEvidence({ path: derivedPath, sha256: ref.sha256 })),
    ).toBe('evidence_hash_mismatch');
    // 篡改内容 + 它的新 hash：未登记 → 拒绝（不存在「任意 sha」旁路）。
    expect(
      await rejectionCode(journal.readEvidence({ path: derivedPath, sha256: sha256(tampered) })),
    ).toBe('evidence_ref_not_registered');
    // 原内容 + 未登记 hash → 拒绝。
    expect(
      await rejectionCode(journal.readEvidence({ path: derivedPath, sha256: 'c'.repeat(64) })),
    ).toBe('evidence_ref_not_registered');
    // 显式重定义同一路径的 sha 也被拒（对照折叠派生结果）。
    expect(
      await rejectionCode(journal.registerEvidenceRef({ path: derivedPath, sha256: 'c'.repeat(64) })),
    ).toBe('evidence_ref_conflict');
    await journal.close();
  });

  it('retry_of unknown 的 reconciliation_ref 必须与派生 ref 的 path+sha 同源', async () => {
    const runDir = await makeRunDir();
    let journal = await openJournal(runDir);
    const settled = await appendFullDispatch(journal, 'dsp_ref_done', 1);
    await appendAccepted(journal, 'dsp_ref_unknown', 2);
    await journal.appendDispatched({ dispatch_id: 'dsp_ref_unknown' });
    await journal.close();

    journal = await openJournal(runDir);
    const derivedRef: EvidenceRef = { path: settled.ref.ref.path, sha256: settled.ref.sha256 };
    const allowed = makeBrief('dsp_ref_retry_ok', 3, {
      retry_of: 'dsp_ref_unknown',
      reconciliation_ref: derivedRef,
    });
    await journal.appendAccepted({
      brief: allowed,
      brief_sha256: hashExecutionBrief(allowed),
      budget_before: BUDGET,
    });

    // 同一路径 + 错误 sha：path+sha 双向登记，拒绝。
    const wrongSha = makeBrief('dsp_ref_retry_bad', 4, {
      retry_of: 'dsp_ref_unknown',
      reconciliation_ref: { path: derivedRef.path, sha256: 'd'.repeat(64) },
    });
    expect(
      await rejectionCode(
        journal.appendAccepted({
          brief: wrongSha,
          brief_sha256: hashExecutionBrief(wrongSha),
          budget_before: BUDGET,
        }),
      ),
    ).toBe('journal_retry_without_evidence');
    await journal.close();
  });
});

// ─────────────────────────────────────────────────────────────
// 半写修复
// ─────────────────────────────────────────────────────────────

describe('RunDispatchJournal: 半写尾部修复', () => {
  it('末尾半截 JSON 可修复：保留原字节/hash，修后可重复读取且历史完整', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    await appendAccepted(journal, 'dsp_tail', 1);
    const partial = '{"schema_version":"newide.dispatch_journal_entry.v1","event":"acc';
    await appendFile(journalFilePath(runDir), partial, 'utf8');

    const damaged = await journal.read();
    expect(damaged.status).toBe('repairable_tail');
    expect(damaged.discarded_tail?.text).toBe(partial);
    expect(damaged.discarded_tail?.sha256).toBe(sha256(partial));
    expect(damaged.discarded_tail?.byte_length).toBe(Buffer.byteLength(partial));
    expect(await rejectionCode(journal.fold())).toBe('journal_corrupt');

    // 坏尾未修复时禁止盲追加。
    expect(await rejectionCode(appendAccepted(journal, 'dsp_after_tail', 2))).toBe(
      'journal_repair_required',
    );

    const repaired = await journal.repairTail();
    expect(repaired).toBeDefined();
    expect(repaired?.discarded_tail_sha256).toBe(sha256(partial));

    // 侧车原样保留残缺字节（不覆盖、不丢字节）。
    const sidecarPath = path.join(runDir, 'journal', 'repair', path.basename(repaired!.discarded_tail_ref.path));
    const sidecarBytes = await readFile(sidecarPath);
    expect(sha256(sidecarBytes)).toBe(sha256(partial));
    expect(sidecarBytes.toString('utf8')).toBe(partial);

    // repair 控制行落盘，坏行被紧邻 repair 跳过。
    const after = await journal.read();
    expect(after.status).toBe('ok');
    expect(after.repairs).toHaveLength(1);
    expect(after.repairs[0]?.discarded_tail_sha256).toBe(sha256(partial));
    expect(after.problems.some((problem) => problem.code === 'skipped_repaired_line')).toBe(true);
    expect(after.lines.some((line) => line.event === 'repair')).toBe(true);

    // 修后 read 两次确定性一致；历史记录完整。
    expect(await journal.read()).toEqual(await journal.read());
    const fold = await journal.fold();
    expect(fold.records).toHaveLength(1);
    expect(fold.records[0]?.dispatch_id).toBe('dsp_tail');

    // 修复后可继续追加，sequence 连续。
    await appendAccepted(journal, 'dsp_after_tail', 2);
    expect((await journal.fold()).records).toHaveLength(2);

    // 再修一次是 no-op。
    await expect(journal.repairTail()).resolves.toBeUndefined();
    await journal.close();
  });

  it('截断最后一行（无换行）可修复，前序完整行保留', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    await appendAccepted(journal, 'dsp_keep', 1);
    await appendAccepted(journal, 'dsp_truncated', 2);

    const filePath = journalFilePath(runDir);
    const text = await readFile(filePath, 'utf8');
    const truncated = text.slice(0, text.length - 20);
    await writeFile(filePath, truncated, 'utf8');

    const damaged = await journal.read();
    expect(damaged.status).toBe('repairable_tail');
    expect(await rejectionCode(journal.fold())).toBe('journal_corrupt');

    await journal.repairTail();
    const fold = await journal.fold();
    expect(fold.records).toHaveLength(1);
    expect(fold.records[0]?.dispatch_id).toBe('dsp_keep');

    // 被丢弃的 accepted 行没有落盘，可以重新以 sequence 2 追加。
    await appendAccepted(journal, 'dsp_truncated', 2);
    expect((await journal.fold()).records).toHaveLength(2);
    await journal.close();
  });

  it('中间坏行 fail closed：read=corrupt、fold 抛错、repairTail 不动文件', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    await appendAccepted(journal, 'dsp_mid_a', 1);
    await appendAccepted(journal, 'dsp_mid_b', 2);

    const filePath = journalFilePath(runDir);
    const goodLines = (await readFile(filePath, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    const corrupted = `${goodLines[0]}\n{"garbage":true}\n${goodLines[1]}\n`;
    await writeFile(filePath, corrupted, 'utf8');
    const before = await readFile(filePath);

    const snapshot = await journal.read();
    expect(snapshot.status).toBe('corrupt');
    expect(snapshot.problems.some((problem) => problem.code === 'corrupt_line')).toBe(true);
    expect(await rejectionCode(journal.fold())).toBe('journal_corrupt');
    expect(await rejectionCode(journal.repairTail())).toBe('journal_corrupt');
    expect(await rejectionCode(appendAccepted(journal, 'dsp_mid_c', 3))).toBe('journal_corrupt');

    // 中间损坏一个字节都不许动。
    expect(await readFile(filePath)).toEqual(before);
    await journal.close();
  });

  it('repair 行 hash 与坏行不匹配 = corrupt；匹配且侧车正确才跳过', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    await appendAccepted(journal, 'dsp_repair_a', 1);
    const goodLine = (await readFile(journalFilePath(runDir), 'utf8')).trim();
    const badLine = '{"half":';
    const sidecarDir = path.join(runDir, 'journal', 'repair');
    await mkdir(sidecarDir, { recursive: true });
    const sidecarName = 'manual.tail';
    await writeFile(path.join(sidecarDir, sidecarName), badLine, 'utf8');

    const repairLine = (hashValue: string, withRef: boolean): DispatchJournalLine =>
      JournalRepairEntrySchema.parse({
        schema_version: DISPATCH_JOURNAL_ENTRY_SCHEMA_VERSION,
        entry_id: `entry_repair_${hashValue.slice(0, 6)}_${withRef ? 'ref' : 'noref'}`,
        run_id: IDENTITY.run_id,
        task_id: IDENTITY.task_id,
        role_id: IDENTITY.role_id,
        at: ACCEPTED_AT,
        event: 'repair',
        discarded_tail_sha256: hashValue,
        ...(withRef ? { discarded_tail_ref: { path: `journal/repair/${sidecarName}`, sha256: hashValue } } : {}),
        reason: 'manual repair fixture',
      });

    // hash 不匹配 → corrupt。
    await writeFile(
      journalFilePath(runDir),
      `${goodLine}\n${badLine}\n${JSON.stringify(repairLine('c'.repeat(64), false))}\n`,
      'utf8',
    );
    expect((await journal.read()).status).toBe('corrupt');

    // hash 匹配 + 侧车正确 → 跳过坏行，journal 可读。
    await writeFile(
      journalFilePath(runDir),
      `${goodLine}\n${badLine}\n${JSON.stringify(repairLine(sha256(badLine), true))}\n`,
      'utf8',
    );
    const ok = await journal.read();
    expect(ok.status).toBe('ok');
    expect(ok.lines.filter((line) => line.event !== 'repair')).toHaveLength(1);
    expect((await journal.fold()).records).toHaveLength(1);
    await journal.close();
  });

  it('最后一行合法 JSON 但没有换行时仍视为完整行', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    await appendAccepted(journal, 'dsp_no_newline', 1);
    const filePath = journalFilePath(runDir);
    const text = await readFile(filePath, 'utf8');
    await writeFile(filePath, text.trimEnd(), 'utf8');

    const snapshot = await journal.read();
    expect(snapshot.status).toBe('ok');
    expect((await journal.fold()).records).toHaveLength(1);
    await journal.close();
  });
});

// ─────────────────────────────────────────────────────────────
// 完整末行缺换行（FIX 3 回归）
// ─────────────────────────────────────────────────────────────

describe('RunDispatchJournal: 完整末行缺换行时先补齐再追加', () => {
  it('accepted 完整行无换行 → 重开 append dispatched 不拼接，原行字节保留', async () => {
    const runDir = await makeRunDir();
    let journal = await openJournal(runDir);
    await appendAccepted(journal, 'dsp_no_newline_a', 1);
    await journal.close();

    const filePath = journalFilePath(runDir);
    const originalLine = await stripTrailingNewline(filePath);
    expect(originalLine.endsWith('}')).toBe(true);

    journal = await openJournal(runDir);
    expect((await journal.read()).status).toBe('ok');
    await journal.appendDispatched({ dispatch_id: 'dsp_no_newline_a' });

    const lines = (await readFile(filePath, 'utf8')).split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    // 原 accepted 行字节逐字保留，新行独立一行（不是与上一行拼接）。
    expect(lines[0]).toBe(originalLine);
    const fold = await journal.fold();
    expect(fold.records).toHaveLength(1);
    expect(fold.records[0]).toMatchObject({ phase: 'dispatched', status: 'unknown' });
    await journal.close();
  });

  it('dispatched 完整行无换行 → 重开 append evidence/settled 不拼接，折叠 settled', async () => {
    const runDir = await makeRunDir();
    let journal = await openJournal(runDir);
    await appendAccepted(journal, 'dsp_no_newline_d', 1);
    await journal.appendDispatched({ dispatch_id: 'dsp_no_newline_d' });
    await journal.close();

    const filePath = journalFilePath(runDir);
    const strippedText = await stripTrailingNewline(filePath);
    const originalLines = strippedText.split('\n');
    expect(originalLines).toHaveLength(2);
    expect(originalLines[1]).toContain('"event":"dispatched"');

    journal = await openJournal(runDir);
    expect((await journal.read()).status).toBe('ok');
    const evidence = makeEvidence('dsp_no_newline_d');
    const ref = await journal.appendEvidence({ dispatch_id: 'dsp_no_newline_d', evidence });
    await journal.appendSettled({
      dispatch_id: 'dsp_no_newline_d',
      status: 'succeeded',
      evidence,
      evidence_sha256: ref.sha256,
      violations: [],
    });

    const lines = (await readFile(filePath, 'utf8')).split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    // 原有 accepted / dispatched 两行字节逐字保留，settled 独立成行。
    expect(lines.slice(0, 2)).toEqual(originalLines);
    const fold = await journal.fold();
    expect(fold.records[0]).toMatchObject({ phase: 'settled', status: 'succeeded' });
    await journal.close();
  });

  it('settled 完整行无换行 → append 下一个 dispatch accepted（sequence 2）', async () => {
    const runDir = await makeRunDir();
    let journal = await openJournal(runDir);
    await appendFullDispatch(journal, 'dsp_no_newline_settled', 1);
    await journal.close();
    await stripTrailingNewline(journalFilePath(runDir));

    journal = await openJournal(runDir);
    await appendAccepted(journal, 'dsp_no_newline_next', 2);
    const fold = await journal.fold();
    expect(fold.records).toHaveLength(2);
    expect(fold.byDispatchId.get('dsp_no_newline_settled')).toMatchObject({
      phase: 'settled',
      status: 'succeeded',
    });
    expect(fold.byDispatchId.get('dsp_no_newline_next')).toMatchObject({ phase: 'accepted' });
    await journal.close();
  });

  it('真半截 JSON 仍走 repairable_tail/repairTail，不被补换行掩盖', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    await appendAccepted(journal, 'dsp_no_newline_half', 1);
    const partial = '{"schema_version":"newide.dispatch_journal_entry.v1"';
    await appendFile(journalFilePath(runDir), partial, 'utf8');

    expect((await journal.read()).status).toBe('repairable_tail');
    expect(await rejectionCode(appendAccepted(journal, 'dsp_no_newline_half_2', 2))).toBe(
      'journal_repair_required',
    );
    const repaired = await journal.repairTail();
    expect(repaired?.discarded_tail_sha256).toBe(sha256(partial));
    expect((await journal.read()).status).toBe('ok');
    await journal.close();
  });

  it('appendLineTerminator 首次调用失败：append 拒绝且不写新行，重试成功', async () => {
    const runDir = await makeRunDir();
    let journal = await openJournal(runDir);
    await appendAccepted(journal, 'dsp_terminator_fault', 1);
    await journal.close();
    await stripTrailingNewline(journalFilePath(runDir));
    const before = await readFile(journalFilePath(runDir));

    const faulty = createFaultyIo({ method: 'appendLineTerminator', occurrence: 1 });
    journal = await openJournal(runDir, { io: faulty.io });
    await expect(journal.appendDispatched({ dispatch_id: 'dsp_terminator_fault' })).rejects.toThrow(
      /injected EIO/,
    );
    // 换行没写成：文件一个字节都不多，新行也没有落盘。
    expect(await readFile(journalFilePath(runDir))).toEqual(before);

    // 重试（第 2 次 terminator 调用）成功。
    await journal.appendDispatched({ dispatch_id: 'dsp_terminator_fault' });
    expect((await journal.fold()).records[0]).toMatchObject({
      phase: 'dispatched',
      status: 'unknown',
    });
    await journal.close();
  });
});

// ─────────────────────────────────────────────────────────────
// 故障注入
// ─────────────────────────────────────────────────────────────

describe('RunDispatchJournal: 故障注入 I/O', () => {
  it('accepted 写入失败不产生半截记录，写重试（同 entry_id）幂等', async () => {
    const runDir = await makeRunDir();
    const faulty = createFaultyIo({ method: 'appendLineWithFsync', occurrence: 1 });
    const journal = await openJournal(runDir, { io: faulty.io });
    const brief = makeBrief('dsp_fault_accepted', 1);
    const input = {
      brief,
      brief_sha256: hashExecutionBrief(brief),
      budget_before: BUDGET,
      entry_id: 'entry_fault_accepted',
    };

    await expect(journal.appendAccepted(input)).rejects.toThrow(/injected EIO/);
    expect((await journal.read()).kind).toBe('legacy');
    expect(await stat(journalFilePath(runDir)).catch(() => undefined)).toBeUndefined();

    // 重试（同 entry_id，故障只注入第 1 次调用）。
    await journal.appendAccepted(input);
    expect((await journal.fold()).records).toHaveLength(1);
    await journal.close();
  });

  it('accepted 写入后 fsync 失败：调用方看到错误，但重试按 entry_id 幂等', async () => {
    const runDir = await makeRunDir();
    const faulty = createFaultyIo({
      method: 'appendLineWithFsync',
      occurrence: 1,
      mode: 'after',
    });
    const journal = await openJournal(runDir, { io: faulty.io });
    const brief = makeBrief('dsp_fsync_fail', 1);
    const input = {
      brief,
      brief_sha256: hashExecutionBrief(brief),
      budget_before: BUDGET,
      entry_id: 'entry_fsync_fail',
    };
    await expect(journal.appendAccepted(input)).rejects.toThrow(/injected EIO/);
    // 行已经落盘，但调用方认为失败；重试必须幂等而不是重复写入。
    await journal.appendAccepted(input);
    expect((await journal.read()).lines).toHaveLength(1);
    await journal.close();
  });

  it('dispatched 写失败时 fold 保持 accepted/not_executed，重试成功', async () => {
    const runDir = await makeRunDir();
    const faulty = createFaultyIo({ method: 'appendLineWithFsync', occurrence: 2 });
    const journal = await openJournal(runDir, { io: faulty.io });
    await appendAccepted(journal, 'dsp_fault_dispatched', 1);

    await expect(journal.appendDispatched({ dispatch_id: 'dsp_fault_dispatched' })).rejects.toThrow(
      /injected EIO/,
    );
    expect((await journal.fold()).records[0]).toMatchObject({
      phase: 'accepted',
      status: 'not_executed',
    });

    await journal.appendDispatched({ dispatch_id: 'dsp_fault_dispatched' });
    expect((await journal.fold()).records[0]).toMatchObject({ phase: 'dispatched', status: 'unknown' });
    await journal.close();
  });

  it('settled 写失败不产生幽灵 settled，重试后恰好一条 settled', async () => {
    const runDir = await makeRunDir();
    // 调用序：appendAccepted=1、appendDispatched=2、appendSettled=3。
    const faulty = createFaultyIo({ method: 'appendLineWithFsync', occurrence: 3 });
    const journal = await openJournal(runDir, { io: faulty.io });
    await appendAccepted(journal, 'dsp_fault_settled', 1);
    await journal.appendDispatched({ dispatch_id: 'dsp_fault_settled' });
    const evidence = makeEvidence('dsp_fault_settled');
    await journal.appendEvidence({ dispatch_id: 'dsp_fault_settled', evidence });

    const settledInput = {
      dispatch_id: 'dsp_fault_settled',
      status: 'succeeded' as const,
      evidence,
      evidence_sha256: hashExecutionEvidence(evidence),
      violations: [],
      entry_id: 'entry_fault_settled',
    };
    await expect(journal.appendSettled(settledInput)).rejects.toThrow(/injected EIO/);
    // 失败前没有 settled 行：状态必须是 unknown，而不是伪造成功。
    const failedFold = await journal.fold();
    expect(failedFold.records[0]).toMatchObject({ phase: 'dispatched', status: 'unknown' });
    expect(failedFold.records[0]?.evidence).toBeUndefined();

    await journal.appendSettled(settledInput);
    const fold = await journal.fold();
    expect(fold.records[0]).toMatchObject({ phase: 'settled', status: 'succeeded' });
    expect(fold.records.filter((record) => record.settled_at !== undefined)).toHaveLength(1);
    await journal.close();
  });

  it('evidence 写失败会清理临时文件，重试成功且不覆盖', async () => {
    const runDir = await makeRunDir();
    // 调用序：open 的 owner tmp 写=1；appendEvidence 的临时文件写=2。
    const faulty = createFaultyIo({ method: 'writeFileExclusive', occurrence: 2 });
    const journal = await openJournal(runDir, { io: faulty.io });
    await appendAccepted(journal, 'dsp_fault_evidence', 1);
    await journal.appendDispatched({ dispatch_id: 'dsp_fault_evidence' });
    const evidence = makeEvidence('dsp_fault_evidence');

    await expect(journal.appendEvidence({ dispatch_id: 'dsp_fault_evidence', evidence })).rejects.toThrow(
      /injected EIO/,
    );
    const evidenceDir = path.join(runDir, 'journal', 'evidence');
    const afterFailure = await readdir(evidenceDir).catch(() => [] as string[]);
    expect(afterFailure.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(afterFailure).toEqual([]);

    const ref = await journal.appendEvidence({ dispatch_id: 'dsp_fault_evidence', evidence });
    expect(await readdir(evidenceDir)).toEqual([`${ref.ref.path.split('/').pop()}`]);
    await journal.close();
  });

  it('rename 失败不留下目标文件，重试后 hash 一致', async () => {
    const runDir = await makeRunDir();
    // 调用序：open 的 owner.json rename=1；appendEvidence 的 temp→目标 rename=2。
    const faulty = createFaultyIo({ method: 'rename', occurrence: 2 });
    const journal = await openJournal(runDir, { io: faulty.io });
    await appendAccepted(journal, 'dsp_fault_rename', 1);
    await journal.appendDispatched({ dispatch_id: 'dsp_fault_rename' });
    const evidence = makeEvidence('dsp_fault_rename');
    await expect(journal.appendEvidence({ dispatch_id: 'dsp_fault_rename', evidence })).rejects.toThrow(
      /injected EIO/,
    );
    expect(await readdir(path.join(runDir, 'journal', 'evidence'))).toEqual([]);

    const ref = await journal.appendEvidence({ dispatch_id: 'dsp_fault_rename', evidence });
    const bytes = await readFile(path.join(runDir, 'journal', 'evidence', 'dsp_fault_rename.json'));
    expect(sha256(bytes)).toBe(ref.sha256);
    await journal.close();
  });

  it('目录 fsync 不可用时 durability=best_effort 且不抛业务错误', async () => {
    const runDir = await makeRunDir();
    const faulty = createFaultyIo({ method: 'syncDirectory', occurrence: 1 });
    const journal = await openJournal(runDir, { io: faulty.io });
    expect(journal.currentDurability).toMatchObject({
      mode: 'best_effort',
      directory_sync: false,
    });
    expect(journal.currentDurability.notes.length).toBeGreaterThan(0);

    // evidence 写仍成功（目录 fsync 失败不升级为业务错误）。
    const dispatchId = 'dsp_best_effort';
    await appendFullDispatch(journal, dispatchId, 1);
    const snapshot = await journal.read();
    expect(snapshot.durability.mode).toBe('best_effort');
    expect(snapshot.durability.directory_sync).toBe(false);
    await journal.close();
  });

  it('默认 Node IO 的 durability 自洽（Windows 上目录 fsync 失败降级）', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    const { ref } = await appendFullDispatch(journal, 'dsp_default_io', 1);
    const durability = journal.currentDurability;
    if (durability.mode === 'best_effort') {
      expect(durability.directory_sync).toBe(false);
      expect(durability.notes.length).toBeGreaterThan(0);
    } else {
      expect(durability.directory_sync).toBe(true);
    }
    expect(await journal.readEvidence(ref.ref)).toMatchObject({ sha256: ref.sha256 });
    await journal.close();
  });
});

// ─────────────────────────────────────────────────────────────
// legacy 与单写者锁（目录 + owner.json + token + 回收闸门）
// ─────────────────────────────────────────────────────────────

/**
 * 可暂停 IO：在第一次 `mkdirExclusive(<gateDir>)` 时发出信号并等待放行
 * （确定性并发交错测试用，不 sleep）。`pause:'before'` = 尚未创建闸门，`'after'` = 已持有闸门。
 */
function createGatePauseIo(options: {
  pause: 'before' | 'after';
  onGate: () => void;
  release: Promise<void>;
}): DispatchJournalIo {
  const base = createNodeDispatchJournalIo();
  let paused = false;
  return {
    readFile: (filePath) => base.readFile(filePath),
    writeFileExclusive: (filePath, data) => base.writeFileExclusive(filePath, data),
    appendLineWithFsync: (filePath, line) => base.appendLineWithFsync(filePath, line),
    appendLineTerminator: (filePath) => base.appendLineTerminator(filePath),
    mkdir: (dirPath) => base.mkdir(dirPath),
    mkdirExclusive: async (dirPath) => {
      if (!paused && dirPath.endsWith(DISPATCH_JOURNAL_RECLAIM_GATE_DIR)) {
        paused = true;
        if (options.pause === 'before') {
          options.onGate();
          await options.release;
          return base.mkdirExclusive(dirPath);
        }
        await base.mkdirExclusive(dirPath);
        options.onGate();
        await options.release;
        return;
      }
      return base.mkdirExclusive(dirPath);
    },
    rmdir: (dirPath) => base.rmdir(dirPath),
    readdir: (dirPath) => base.readdir(dirPath),
    stat: (filePath) => base.stat(filePath),
    rename: (fromPath, toPath) => base.rename(fromPath, toPath),
    unlink: (filePath) => base.unlink(filePath),
    syncDirectory: (dirPath) => base.syncDirectory(dirPath),
    realpath: (filePath) => base.realpath(filePath),
  };
}

function replacementOwner(token: string): string {
  return JSON.stringify({
    pid: process.pid,
    token,
    created_at: ACCEPTED_AT,
    run_id: IDENTITY.run_id,
  });
}

describe('RunDispatchJournal: legacy 与单写者锁', () => {
  it('无 journal 文件时 read/fold 按 legacy 处理且不创建文件', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    const snapshot = await journal.read();
    expect(snapshot).toMatchObject({ kind: 'legacy', status: 'absent', lines: [], entries: [] });
    expect(await journal.fold()).toMatchObject({ records: [] });
    expect(await journal.getDispatchRecord('dsp_anything')).toBeUndefined();
    expect(await stat(journalFilePath(runDir)).catch(() => undefined)).toBeUndefined();
    await journal.close();
  });

  it('锁是目录且 owner.json 含 pid/token；第二个 writer 失败，close 后可重开', async () => {
    const runDir = await makeRunDir();
    const first = await openJournal(runDir);
    expect((await stat(lockDirPath(runDir))).isDirectory()).toBe(true);
    const owner = await readLockOwner(runDir);
    expect(owner.pid).toBe(process.pid);
    expect(owner.token.length).toBeGreaterThan(0);
    expect(owner.run_id).toBe(IDENTITY.run_id);

    // 同进程第二个 writer 也拒绝（活锁由 pid 存活判定）。
    expect(await rejectionCode(openJournal(runDir))).toBe('journal_locked');

    await first.close();
    expect(await stat(lockDirPath(runDir)).catch(() => undefined)).toBeUndefined();
    const second = await openJournal(runDir);
    await appendAccepted(second, 'dsp_after_reopen', 1);
    await second.close();
  });

  it('owner.json 缺失/空/损坏/字段不全：拒绝并保留锁目录，不回收', async () => {
    const cases: Array<{ name: string; content: string | undefined }> = [
      { name: 'missing', content: undefined },
      { name: 'empty', content: '' },
      { name: 'corrupt-json', content: '{not-json' },
      { name: 'missing-token', content: JSON.stringify({ pid: 1, created_at: ACCEPTED_AT }) },
      { name: 'missing-pid', content: JSON.stringify({ token: 'tok', created_at: ACCEPTED_AT }) },
      { name: 'negative-pid', content: JSON.stringify({ pid: -1, token: 'tok' }) },
      { name: 'blank-token', content: JSON.stringify({ pid: 1, token: '' }) },
    ];
    for (const testCase of cases) {
      const runDir = await makeRunDir();
      await mkdir(lockDirPath(runDir), { recursive: true });
      if (testCase.content !== undefined) {
        await writeFile(lockOwnerPath(runDir), testCase.content, 'utf8');
      }
      expect(await rejectionCode(openJournal(runDir))).toBe('journal_locked');
      // 锁目录与 owner 原样保留；没有回收闸门，也没有任何锁目录外的临时残留。
      const lockEntries = await readdir(lockDirPath(runDir));
      expect(lockEntries.sort()).toEqual(testCase.content === undefined ? [] : ['owner.json']);
      if (testCase.content !== undefined) {
        expect(await readFile(lockOwnerPath(runDir), 'utf8')).toBe(testCase.content);
      }
      expect(await stat(gateDirPath(runDir)).catch(() => undefined)).toBeUndefined();
      expect((await readdir(path.join(runDir, 'journal'))).sort()).toEqual(['.writer.lock']);
    }
  });

  it('B→A→B→C 交错：闸门串行化后成功 open 恰好 1 个，A 的锁不被偷走', async () => {
    const runDir = await makeRunDir();
    const stale = await createStaleLock(runDir, { pid: 999_999, token: 'stale-token' });
    const reachedGate = createDeferred();
    const releaseB = createDeferred();
    const bIo = createGatePauseIo({
      pause: 'before',
      onGate: reachedGate.resolve,
      release: releaseB.promise,
    });

    const bResult = RunDispatchJournal.open({ runDir, identity: IDENTITY, io: bIo }).then(
      () => 'opened' as const,
      (error: unknown) => errorCodeOf(error),
    );
    // B 已读到 S 是死锁，正停在「拿回收闸门」之前。
    await reachedGate.promise;

    // A 用普通 IO 完整跑完：拿闸门 → 重读 S 仍死 → 删 S → 释放闸门 → 重新竞争拿到锁。
    const a = await RunDispatchJournal.open({ runDir, identity: IDENTITY });
    const ownerA = await readLockOwner(runDir);
    expect(ownerA.pid).toBe(process.pid);
    expect(ownerA.token).not.toBe(stale.token);

    // 放行 B：B 拿到闸门后重读 owner → A 活着 → journal_locked，且没有移动/删除 A 的锁。
    releaseB.resolve();
    expect(await bResult).toBe('journal_locked');
    expect(await readLockOwner(runDir)).toEqual(ownerA);

    // C 看到 A 的活锁 → journal_locked。
    const cResult = await openJournal(runDir).then(
      () => 'opened' as const,
      (error: unknown) => errorCodeOf(error),
    );
    expect(cResult).toBe('journal_locked');

    // 成功 open 的实例恰好 1 个（A），且只有它能写。
    expect([bResult, cResult]).not.toContain('opened');
    await appendAccepted(a, 'dsp_gate_winner', 1);
    expect((await a.fold()).records).toHaveLength(1);

    // 闸门已释放；锁目录里仍是 A 的 owner；无墓碑/临时目录残留。
    expect(await stat(gateDirPath(runDir)).catch(() => undefined)).toBeUndefined();
    expect(await readLockOwner(runDir)).toEqual(ownerA);
    expect((await readdir(path.join(runDir, 'journal'))).sort()).toEqual([
      '.writer.lock',
      'dispatches.jsonl',
    ]);
    await a.close();
  });

  it('close 遇到被替换 owner：不删锁；第三者仍被活锁拒绝', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    const replacement = replacementOwner('other-lock-token');
    await writeFile(lockOwnerPath(runDir), replacement, 'utf8');

    await journal.close();
    // token 不匹配：锁目录与 owner 原样保留（close 绝不移动活锁路径）。
    expect(await readFile(lockOwnerPath(runDir), 'utf8')).toBe(replacement);
    expect((await stat(lockDirPath(runDir))).isDirectory()).toBe(true);
    expect(await stat(gateDirPath(runDir)).catch(() => undefined)).toBeUndefined();

    // 第三个 writer 仍然被活锁挡住，且不会产生新锁。
    expect(await rejectionCode(openJournal(runDir))).toBe('journal_locked');
    expect(await readFile(lockOwnerPath(runDir), 'utf8')).toBe(replacement);
  });

  it('close 持有回收闸门时 C 被闸门挡住；释放后锁原样保留、无新建/删除', async () => {
    const runDir = await makeRunDir();
    const reachedGate = createDeferred();
    const releaseClose = createDeferred();
    const aIo = createGatePauseIo({
      pause: 'after',
      onGate: reachedGate.resolve,
      release: releaseClose.promise,
    });
    const a = await openJournal(runDir, { io: aIo });
    const replacement = replacementOwner('other-lock-token');
    await writeFile(lockOwnerPath(runDir), replacement, 'utf8');

    const closePromise = a.close();
    // close 已持有回收闸门（pause:'after'）。
    await reachedGate.promise;
    expect((await stat(gateDirPath(runDir))).isDirectory()).toBe(true);
    // C 看到闸门 → journal_locked，且没有创建/替换任何锁。
    expect(await rejectionCode(openJournal(runDir))).toBe('journal_locked');
    expect(await readFile(lockOwnerPath(runDir), 'utf8')).toBe(replacement);

    releaseClose.resolve();
    await closePromise;
    // 所有权不符 → close 不删锁；闸门已释放。
    expect(await readFile(lockOwnerPath(runDir), 'utf8')).toBe(replacement);
    expect((await stat(lockDirPath(runDir))).isDirectory()).toBe(true);
    expect(await stat(gateDirPath(runDir)).catch(() => undefined)).toBeUndefined();
  });

  it('所有权丢失后 append 拒绝 journal_lock_lost，journal 不新增字节', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    await writeFile(lockOwnerPath(runDir), replacementOwner('other-lock-token'), 'utf8');

    expect(await rejectionCode(appendAccepted(journal, 'dsp_lost', 1))).toBe('journal_lock_lost');
    expect(await stat(journalFilePath(runDir)).catch(() => undefined)).toBeUndefined();

    // 所有权已判定丢失：后续写继续拒绝（journal_not_open），不会出现幽灵写入。
    const second = await rejectionCode(appendAccepted(journal, 'dsp_lost_2', 1));
    expect(['journal_not_open', 'journal_lock_lost']).toContain(second);
    await journal.close();
  });

  it('遗留回收闸门：fail closed、保留闸门、不创建锁目录', async () => {
    const runDir = await makeRunDir();
    await mkdir(gateDirPath(runDir), { recursive: true });

    const error = await openJournal(runDir).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(errorCodeOf(error)).toBe('journal_locked');
    expect(String(error)).toContain(DISPATCH_JOURNAL_RECLAIM_GATE_DIR);
    expect(String(error)).toMatch(/remove that directory manually/);
    // 闸门绝不自动回收；也没有创建锁目录。
    expect((await stat(gateDirPath(runDir))).isDirectory()).toBe(true);
    expect(await stat(lockDirPath(runDir)).catch(() => undefined)).toBeUndefined();
    expect((await readdir(path.join(runDir, 'journal'))).sort()).toEqual([
      DISPATCH_JOURNAL_RECLAIM_GATE_DIR,
    ]);
  });

  it('崩溃遗留完整 owner（pid 已死）被回收：删除后重建，pid/token 换新', async () => {
    const runDir = await makeRunDir();
    const stale = await createStaleLock(runDir, { pid: 999_999, token: 'stale-token' });
    const journal = await openJournal(runDir);
    const owner = await readLockOwner(runDir);
    expect(owner.pid).toBe(process.pid);
    expect(owner.token).not.toBe(stale.token);
    // 回收完成后闸门已释放，没有墓碑残留。
    expect(await stat(gateDirPath(runDir)).catch(() => undefined)).toBeUndefined();
    await appendAccepted(journal, 'dsp_reclaimed', 1);
    await journal.close();
  });

  it('close 释放锁且重复 close 幂等；close 后 append 拒绝；无锁/闸门残留', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);
    await appendAccepted(journal, 'dsp_closed_append', 1);
    await journal.close();
    await expect(journal.close()).resolves.toBeUndefined();
    expect(await stat(lockDirPath(runDir)).catch(() => undefined)).toBeUndefined();
    expect(await stat(gateDirPath(runDir)).catch(() => undefined)).toBeUndefined();
    expect((await readdir(path.join(runDir, 'journal'))).sort()).toEqual(['dispatches.jsonl']);
    expect(await rejectionCode(appendAccepted(journal, 'dsp_closed', 2))).toBe('journal_not_open');
  });
});

// ─────────────────────────────────────────────────────────────
// 实例内修改串行化与 close 生命周期（复审修复）
// ─────────────────────────────────────────────────────────────

/**
 * 可暂停 IO：指定方法的**第一次**匹配调用在执行前暂停，发出信号并等待放行。
 * 用于确定性复现「修改操作在途 / close 并发 / 同实例并发追加」，不依赖 sleep 或定时碰运气。
 */
function createPauseIo(options: {
  method: keyof DispatchJournalIo;
  match: (target: string) => boolean;
  onPause: () => void;
  release: Promise<void>;
}): DispatchJournalIo {
  const base = createNodeDispatchJournalIo();
  let paused = false;
  const maybePause = async (method: keyof DispatchJournalIo, target: string): Promise<void> => {
    if (paused || method !== options.method) return;
    if (!options.match(target)) return;
    paused = true;
    options.onPause();
    await options.release;
  };
  return {
    async readFile(filePath) {
      await maybePause('readFile', filePath);
      return base.readFile(filePath);
    },
    async writeFileExclusive(filePath, data) {
      await maybePause('writeFileExclusive', filePath);
      return base.writeFileExclusive(filePath, data);
    },
    async appendLineWithFsync(filePath, line) {
      await maybePause('appendLineWithFsync', filePath);
      return base.appendLineWithFsync(filePath, line);
    },
    async appendLineTerminator(filePath) {
      await maybePause('appendLineTerminator', filePath);
      return base.appendLineTerminator(filePath);
    },
    async mkdir(dirPath) {
      await maybePause('mkdir', dirPath);
      return base.mkdir(dirPath);
    },
    async mkdirExclusive(dirPath) {
      await maybePause('mkdirExclusive', dirPath);
      return base.mkdirExclusive(dirPath);
    },
    async rmdir(dirPath) {
      await maybePause('rmdir', dirPath);
      return base.rmdir(dirPath);
    },
    async readdir(dirPath) {
      await maybePause('readdir', dirPath);
      return base.readdir(dirPath);
    },
    async stat(filePath) {
      await maybePause('stat', filePath);
      return base.stat(filePath);
    },
    async rename(fromPath, toPath) {
      await maybePause('rename', fromPath);
      return base.rename(fromPath, toPath);
    },
    async unlink(filePath) {
      await maybePause('unlink', filePath);
      return base.unlink(filePath);
    },
    async syncDirectory(dirPath) {
      await maybePause('syncDirectory', dirPath);
      return base.syncDirectory(dirPath);
    },
    async realpath(filePath) {
      await maybePause('realpath', filePath);
      return base.realpath(filePath);
    },
  };
}

const isJournalFile = (filePath: string): boolean =>
  path.basename(filePath) === 'dispatches.jsonl';

describe('RunDispatchJournal: 修改串行化与 close 生命周期', () => {
  it('A 在途 append 期间 close 不释放锁；B 拿不到锁，A 完成后 close 才完成，fold 正常', async () => {
    const runDir = await makeRunDir();
    const appendStarted = createDeferred();
    const releaseAppend = createDeferred();
    const aIo = createPauseIo({
      method: 'appendLineWithFsync',
      match: isJournalFile,
      onPause: appendStarted.resolve,
      release: releaseAppend.promise,
    });
    const journalA = await openJournal(runDir, { io: aIo });

    const appendA = appendAccepted(journalA, 'dsp_inflight', 1);
    // A 已完成「读状态 + 校验」，正停在真正 append 之前。
    await appendStarted.promise;

    let closeSettled = false;
    const closePromise = journalA.close().then(() => {
      closeSettled = true;
    });

    // 修复前 B 会在这里拿到锁并写 sequence=1；修复后 A 的修改未落地，锁不可被抢。
    expect(await rejectionCode(openJournal(runDir))).toBe('journal_locked');
    expect(closeSettled).toBe(false);
    expect((await stat(lockDirPath(runDir))).isDirectory()).toBe(true);

    releaseAppend.resolve();
    await appendA;
    await closePromise;
    expect(closeSettled).toBe(true);
    expect(await stat(lockDirPath(runDir)).catch(() => undefined)).toBeUndefined();

    // B 现在可以打开并接着写 sequence=2；journal 无重复 sequence，fold 正常。
    const journalB = await openJournal(runDir);
    await appendAccepted(journalB, 'dsp_after_close', 2);
    const fold = await journalB.fold();
    expect(fold.records.map((record) => [record.dispatch_id, record.sequence])).toEqual([
      ['dsp_inflight', 1],
      ['dsp_after_close', 2],
    ]);
    expect(await readJournalLines(runDir)).toHaveLength(2);
    await journalB.close();

    // close 完成后旧实例不再写 journal。
    expect(await rejectionCode(appendAccepted(journalA, 'dsp_old_writer', 3))).toBe(
      'journal_not_open',
    );
    // 侧车写入同样被拒绝（旧实例的锁已释放，不能有第二次写入）。
    expect(
      await rejectionCode(
        journalA.appendEvidence({
          dispatch_id: 'dsp_inflight',
          evidence: makeEvidence('dsp_inflight'),
        }),
      ),
    ).toBe('journal_not_open');
    expect(await readJournalLines(runDir)).toHaveLength(2);
  });

  it('同实例两个 dispatch 并发提交相同 sequence：恰好一个成功，另一个明确拒绝，文件无冲突记录', async () => {
    const runDir = await makeRunDir();
    const journal = await openJournal(runDir);

    // 两个请求在同一 tick 内入队（都不 await）：修复前会读到同一旧快照、写出两条 sequence=1。
    const first = appendAccepted(journal, 'dsp_first', 1);
    const second = appendAccepted(journal, 'dsp_second', 1);
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    const secondResult = results[1];
    if (secondResult.status === 'rejected') {
      expect(errorCodeOf(secondResult.reason)).toBe('journal_sequence_regression');
    }

    // 文件里恰好一条 accepted 行，无冲突 sequence；重开后仍可 fold。
    expect(await readJournalLines(runDir)).toHaveLength(1);
    expect((await journal.fold()).records.map((record) => record.dispatch_id)).toEqual([
      'dsp_first',
    ]);
    await journal.close();

    const reopened = await openJournal(runDir);
    const folded = await reopened.fold();
    expect(folded.records).toHaveLength(1);
    expect(folded.records[0]?.dispatch_id).toBe('dsp_first');
    await reopened.close();
  });

  it('close 等待已准入的排队修改；并发 close 共享同一 Promise；closing 期间新修改明确拒绝', async () => {
    const runDir = await makeRunDir();
    const appendStarted = createDeferred();
    const releaseAppend = createDeferred();
    const io = createPauseIo({
      method: 'appendLineWithFsync',
      match: isJournalFile,
      onPause: appendStarted.resolve,
      release: releaseAppend.promise,
    });
    const journal = await openJournal(runDir, { io });

    const inFlight = appendAccepted(journal, 'dsp_inflight', 1);
    await appendStarted.promise;
    // 已准入但尚未开始执行：close 前接收的请求必须执行完，不能静默丢弃。
    const queued = appendAccepted(journal, 'dsp_queued', 2);

    const close1 = journal.close();
    const close2 = journal.close();
    // 并发 close 返回同一个关闭 Promise（都等实际关闭完成，不提前返回）。
    expect(close2).toBe(close1);
    // closing 期间到达的新请求立即拒绝，不排队等待。
    expect(await rejectionCode(appendAccepted(journal, 'dsp_after_closing', 3))).toBe(
      'journal_not_open',
    );
    // 在途修改尚未结束：锁仍在 close 手里。
    expect((await stat(lockDirPath(runDir))).isDirectory()).toBe(true);

    releaseAppend.resolve();
    await inFlight;
    await queued;
    await Promise.all([close1, close2]);
    expect(await stat(lockDirPath(runDir)).catch(() => undefined)).toBeUndefined();
    expect(await rejectionCode(appendAccepted(journal, 'dsp_closed', 3))).toBe('journal_not_open');
    expect(await readJournalLines(runDir)).toHaveLength(2);

    const reopened = await openJournal(runDir);
    expect((await reopened.fold()).records).toHaveLength(2);
    await reopened.close();
  });

  it('修改失败不毒化队列、不吞原始错误；后续操作按磁盘真实状态继续', async () => {
    const runDir = await makeRunDir();
    const faulty = createFaultyIo({
      method: 'appendLineWithFsync',
      occurrence: 1,
      mode: 'before',
      code: 'EIO',
    });
    const journal = await openJournal(runDir, { io: faulty.io });

    const firstError = await appendAccepted(journal, 'dsp_failed', 1).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as NodeJS.ErrnoException).code).toBe('EIO');
    // 失败没有留下半条记录（fail closed 的半写状态不会被追加掩盖）。
    expect(await stat(journalFilePath(runDir)).catch(() => undefined)).toBeUndefined();

    // 队列没有挂死：后续 append 重新读取磁盘真实状态（仍是空账本）并按 sequence 1 成功。
    await appendAccepted(journal, 'dsp_after_failure', 1);
    expect((await journal.fold()).records.map((record) => record.dispatch_id)).toEqual([
      'dsp_after_failure',
    ]);
    // close 也不会被失败的操作卡住。
    await journal.close();
    expect(await rejectionCode(appendAccepted(journal, 'dsp_closed', 2))).toBe('journal_not_open');
  });

  it('evidence 侧车写入在途时 close 不提前释放锁', async () => {
    const runDir = await makeRunDir();
    const renameStarted = createDeferred();
    const releaseRename = createDeferred();
    const io = createPauseIo({
      method: 'rename',
      match: (fromPath) => fromPath.endsWith('.tmp') && fromPath.includes('evidence'),
      onPause: renameStarted.resolve,
      release: releaseRename.promise,
    });
    const journal = await openJournal(runDir, { io });
    await appendAccepted(journal, 'dsp_evidence', 1);
    await journal.appendDispatched({
      dispatch_id: 'dsp_evidence',
      adp_exchange_id: 'exchange_evidence',
    });
    const evidence = makeEvidence('dsp_evidence');

    const pendingEvidence = journal.appendEvidence({
      dispatch_id: 'dsp_evidence',
      evidence,
    });
    // 临时文件已写完，正停在 rename（侧车落地之前）。
    await renameStarted.promise;

    const closePromise = journal.close();
    expect(await rejectionCode(openJournal(runDir))).toBe('journal_locked');
    expect((await stat(lockDirPath(runDir))).isDirectory()).toBe(true);

    releaseRename.resolve();
    const ref = await pendingEvidence;
    await closePromise;
    expect(await stat(lockDirPath(runDir)).catch(() => undefined)).toBeUndefined();

    // 侧车已完整落地，hash 与返回的 ref 同源；close 后旧实例不能再写。
    const sidecar = await readFile(path.join(runDir, 'journal', 'evidence', 'dsp_evidence.json'));
    expect(sha256(sidecar)).toBe(ref.sha256);
    expect(await rejectionCode(appendAccepted(journal, 'dsp_after_close', 2))).toBe(
      'journal_not_open',
    );
  });

  it('repairTail 在途时 close 不提前释放锁；修复完成后 journal 可重新打开并 fold', async () => {
    const runDir = await makeRunDir();
    const setup = await openJournal(runDir);
    await appendAccepted(setup, 'dsp_repair', 1);
    await setup.close();

    // 人工制造可修复尾部（完整行 + 半截 JSON）。
    const filePath = journalFilePath(runDir);
    await appendFile(filePath, '{"event":"accepted","half', 'utf8');
    const beforeRepair = await readFile(filePath);

    const sidecarStarted = createDeferred();
    const releaseSidecar = createDeferred();
    const io = createPauseIo({
      method: 'writeFileExclusive',
      match: (target) => target.endsWith('.tail'),
      onPause: sidecarStarted.resolve,
      release: releaseSidecar.promise,
    });
    const journal = await openJournal(runDir, { io });

    const repair = journal.repairTail();
    await sidecarStarted.promise;
    const closePromise = journal.close();
    expect(await rejectionCode(openJournal(runDir))).toBe('journal_locked');

    releaseSidecar.resolve();
    const result = await repair;
    await closePromise;
    expect(result?.discarded_tail_bytes).toBeGreaterThan(0);
    expect(await stat(lockDirPath(runDir)).catch(() => undefined)).toBeUndefined();

    // 原始残缺字节仍按前缀保留；重新打开后可正常 fold。
    const afterRepair = await readFile(filePath);
    expect(afterRepair.subarray(0, beforeRepair.byteLength)).toEqual(beforeRepair);
    const reopened = await openJournal(runDir);
    expect((await reopened.fold()).records).toHaveLength(1);
    await reopened.close();
  });

  it('registerEvidenceRefs 的内部嵌套调用与 close 并发：不死锁，关闭等待注册完成', async () => {
    const runDir = await makeRunDir();
    const setup = await openJournal(runDir);
    await appendAccepted(setup, 'dsp_register', 1);
    await setup.close();

    const firstBytes = Buffer.from('registered evidence one', 'utf8');
    const secondBytes = Buffer.from('registered evidence two', 'utf8');
    await mkdir(path.join(runDir, 'evidence'), { recursive: true });
    await writeFile(path.join(runDir, 'evidence', 'reg_1.json'), firstBytes);
    await writeFile(path.join(runDir, 'evidence', 'reg_2.json'), secondBytes);
    const refs: EvidenceRef[] = [
      { path: 'evidence/reg_1.json', sha256: sha256(firstBytes) },
      { path: 'evidence/reg_2.json', sha256: sha256(secondBytes) },
    ];

    const foldStarted = createDeferred();
    const releaseFold = createDeferred();
    const io = createPauseIo({
      method: 'readFile',
      match: isJournalFile,
      onPause: foldStarted.resolve,
      release: releaseFold.promise,
    });
    const journal = await openJournal(runDir, { io });

    // 外层一个队列操作，内部逐个调用不排队的实现：不会「等自己」而死锁。
    const registration = journal.registerEvidenceRefs(refs);
    await foldStarted.promise;
    let closeSettled = false;
    const closePromise = journal.close().then(() => {
      closeSettled = true;
    });
    expect(closeSettled).toBe(false);

    releaseFold.resolve();
    await registration;
    await closePromise;

    // 两个 ref 都完成登记且可受控读取（嵌套实现没有漏掉第二个）。
    for (const ref of refs) {
      const page = await journal.readEvidence(ref);
      expect(page.sha256).toBe(ref.sha256);
    }
    expect(await stat(lockDirPath(runDir)).catch(() => undefined)).toBeUndefined();
    const reopened = await openJournal(runDir);
    expect((await reopened.fold()).records).toHaveLength(1);
    await reopened.close();
  });
});
