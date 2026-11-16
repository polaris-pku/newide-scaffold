/**
 * `run.getDispatchJournal` / `run.getDispatchEvidence` 读取层的真实 Journal 测试。
 *
 * 用**真实 `RunDispatchJournal`** 在临时目录里构造事实源（accepted→dispatched→evidence→
 * settled、unknown、reconciled、not_executed、finish），不用 mock：
 * - 分页：物理行号水位、limit 上限、has_more/next_after_line；
 * - 摘要：按 dispatch_id 去重计数、by_status/kinds/unknown/violation_count/finish；
 * - 损坏语义：repairable_tail / corrupt 仍返回已解析行 + problems，summary 缺席；
 * - legacy/absent：没有 Journal 不是错误，且读取不创建文件；
 * - 受控 evidence：只认本 Run Journal 派生的 ref，sha/偏移/分页/未登记/hash 失配；
 * - 只读：读前后 journal/evidence 字节与 mtime 不变，不创建 `.writer.lock`、不修坏尾。
 *
 * 读取层不依赖 driver，因此「读」本身不可能触发派工；用例断言的是文件系统副作用与
 * 稳定错误码，而不是只断言 schema 形状。
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionBrief, ExecutionEvidence } from '../../src/driver';
import {
  buildExecutionBrief,
  buildExecutionEvidence,
  hashExecutionBrief,
  hashExecutionEvidence,
  type DriverRunResult,
} from '../../src/driver';
import { RunDispatchJournal } from '../../src/persistence';
import { reconcileLateDriverResult } from '../../src/app/role-autonomy-engine';
import {
  readRunDispatchEvidencePage,
  readRunDispatchJournalPage,
} from '../../src/app/run-dispatch-read';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { InMemoryRunRegistry, RunNotFoundError } from '../../src/app/run-registry';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import { FileRunRequestStore } from '../../src/app/run-request-store';
import { NoopDriverStreamAuditWriter } from '../../src/app/driver-stream-audit-writer';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';

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
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createRunsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'newide-dispatch-read-'));
  temporaryDirectories.push(root);
  return root;
}

function makeBrief(dispatchId: string, sequence: number, kind: ExecutionBrief['kind']): ExecutionBrief {
  return buildExecutionBrief({
    identity: {
      dispatch_id: dispatchId,
      run_id: IDENTITY.run_id,
      task_id: IDENTITY.task_id,
      role_id: IDENTITY.role_id,
      sequence,
      accepted_at: ACCEPTED_AT,
    },
    request: { kind, instruction: `do ${dispatchId}` },
  }).brief;
}

function makeEvidence(dispatchId: string, status: 'succeeded' | 'failed'): ExecutionEvidence {
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
    observation: {
      transport: { evidence: 'execution_unconfirmed' },
      // 长 response_excerpt 会让 evidence 侧车分多页，用来验证 offset/limit。
      result: { status: 'succeeded', response: 'x'.repeat(1_500) },
    },
  });
}

/** 迟到回执里的 Driver 结果（只有对账映射需要的字段，不依赖真实 driver）。 */
function lateDriverResult(): DriverRunResult {
  return {
    driver_run_result_id: 'drr_late_succeeded',
    session_id: 'session_1',
    status: 'succeeded',
    response: 'late ok',
    artifacts: [],
    transcript_ref: {
      artifact_id: 'artifact_transcript',
      type: 'transcript',
      uri: 'file:///tmp/transcript.json',
      producer_id: 'driver_test',
      created_at: ACCEPTED_AT,
      schema_version: 'v0',
    },
    tool_events: [],
    diagnostics: { driver_id: 'driver_test', duration_ms: 5, notes: [] },
    created_at: ACCEPTED_AT,
    schema_version: 'v0',
  };
}

interface FixtureEvidence {
  dispatch_id: string;
  evidence: ExecutionEvidence;
  sha256: string;
}

interface JournalFixture {
  runsRoot: string;
  runDir: string;
  journalPath: string;
  evidence: FixtureEvidence;
}

/**
 * 一份覆盖四种派工状态的真实 Journal：
 * - dsp_ok：settled succeeded（带一条只读违规）；
 * - dsp_unknown：dispatched 无 settled → unknown；
 * - dsp_reconciled：dispatched + 迟到 reconciled failed → failed；
 * - dsp_accepted：只有 accepted → not_executed；
 * 末尾一条 finish。
 */
async function writeJournalFixture(runsRoot: string): Promise<JournalFixture> {
  const runDir = path.join(runsRoot, IDENTITY.run_id);
  await mkdir(runDir, { recursive: true });
  const journal = await RunDispatchJournal.open({ runDir, identity: IDENTITY });
  const appendAccepted = async (
    dispatchId: string,
    sequence: number,
    kind: ExecutionBrief['kind'],
  ): Promise<void> => {
    const brief = makeBrief(dispatchId, sequence, kind);
    await journal.appendAccepted({
      brief,
      brief_sha256: hashExecutionBrief(brief),
      budget_before: BUDGET,
    });
  };

  await appendAccepted('dsp_ok', 1, 'execute');
  await journal.appendDispatched({ dispatch_id: 'dsp_ok', adp_exchange_id: 'exchange_ok' });
  const evidence = makeEvidence('dsp_ok', 'succeeded');
  const ref = await journal.appendEvidence({ dispatch_id: 'dsp_ok', evidence });
  await journal.appendSettled({
    dispatch_id: 'dsp_ok',
    status: 'succeeded',
    evidence,
    evidence_sha256: ref.sha256,
    violations: ['read_only_changed'],
  });

  await appendAccepted('dsp_unknown', 2, 'investigate');
  await journal.appendDispatched({ dispatch_id: 'dsp_unknown' });

  await appendAccepted('dsp_reconciled', 3, 'verify');
  await journal.appendDispatched({ dispatch_id: 'dsp_reconciled' });
  await journal.appendReconciled({
    dispatch_id: 'dsp_reconciled',
    status: 'failed',
    reason: 'late receipt confirmed failure',
  });

  await appendAccepted('dsp_accepted', 4, 'execute');
  await journal.appendFinish({
    actor: 'host',
    status: 'completed',
    reason: 'role finished',
    evidence_refs: [],
  });
  await journal.close();

  return {
    runsRoot,
    runDir,
    journalPath: path.join(runDir, 'journal', 'dispatches.jsonl'),
    evidence: { dispatch_id: 'dsp_ok', evidence, sha256: hashExecutionEvidence(evidence) },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 终止 fake runner 所需的最小完成结果（与生产终态形状一致，不依赖 driver）。 */
function completedResult(runId: string, taskId: string): IntegrationV0Result {
  return {
    run_id: runId,
    task_id: taskId,
    summary: { status: 'completed' },
    frontend_snapshot: {
      snapshot_type: 'coordinator.frontend_run_snapshot.v0',
      schema_version: 'v0',
      generated_at: '2026-11-14T00:00:00.000Z',
      run_id: runId,
      task_id: taskId,
      current: { stage: 'delivery', task_status: 'completed', active_node_code: 'N18' },
      run: {
        run_id: runId,
        task_id: taskId,
        status: 'completed',
        mode: 'single_agent',
        driver_id: 'mock-driver',
        session_id: 'session_1',
        created_at: '2026-11-14T00:00:00.000Z',
      },
      flow: { active_node_code: 'N18', node_statuses: [] },
      timeline: [],
      delivery_report: {
        worktree_path: '.newide/worktrees/task_1',
        files_written: [],
        changed_files: [],
        artifacts_materialized: 0,
        outcome: 'completed_response',
        response: 'Completed.',
        session_id: 'session_1',
        tool_events: [],
        driver_diagnostics: { driver_id: 'mock-driver', duration_ms: 1 },
      },
      artifacts: [],
      checkpoint: {} as never,
      mailbox: { thread_id: runId, message_refs: [], messages: [] },
      market: {
        winner_agent_id: 'role_ts_engineer',
        winner_bid_id: 'bid_1',
        ledger_ref: 'file:///market/ledger.json',
        audit_ref: 'file:///market/audit.json',
        policy_version: 'market-v0',
        seed: runId,
      },
      links: {} as never,
    },
  } as IntegrationV0Result;
}

describe('readRunDispatchJournalPage', () => {
  it('projects fact metadata and folds a deduplicated dispatch summary', async () => {
    const runsRoot = await createRunsRoot();
    await writeJournalFixture(runsRoot);

    const page = await readRunDispatchJournalPage(runsRoot, { run_id: IDENTITY.run_id });

    expect(page.state).toBe('ok');
    expect(page.total_lines).toBe(10);
    expect(page.has_more).toBe(false);
    expect(page.next_after_line).toBeNull();
    expect(page.lines.map((line) => line.event)).toEqual([
      'accepted',
      'dispatched',
      'settled',
      'accepted',
      'dispatched',
      'accepted',
      'dispatched',
      'reconciled',
      'accepted',
      'finish',
    ]);
    expect(page.lines.map((line) => line.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // 行只投影事实元数据：kind 来自 accepted 的 brief，status 来自 settled/reconciled。
    expect(page.lines[0]).toMatchObject({
      line: 1,
      event: 'accepted',
      dispatch_id: 'dsp_ok',
      kind: 'execute',
    });
    expect(page.lines[2]).toMatchObject({ event: 'settled', dispatch_id: 'dsp_ok', status: 'succeeded' });
    expect(page.lines[7]).toMatchObject({ event: 'reconciled', status: 'failed' });

    expect(page.summary).toMatchObject({
      total_dispatches: 4,
      by_status: { succeeded: 1, unknown: 1, failed: 1, not_executed: 1 },
      unknown_dispatch_ids: ['dsp_unknown'],
      violation_count: 1,
      kinds: { execute: 2, investigate: 1, verify: 1 },
      finish: { status: 'completed', actor: 'host' },
    });
    // finish.at 是写入时的时间戳，不假设具体值，只断言存在且是 ISO 串。
    expect(typeof page.summary?.finish?.at).toBe('string');
    expect(Number.isNaN(Date.parse(page.summary?.finish?.at ?? ''))).toBe(false);
  });

  it('never inlines brief instruction or evidence content into journal lines', async () => {
    const runsRoot = await createRunsRoot();
    await writeJournalFixture(runsRoot);

    const page = await readRunDispatchJournalPage(runsRoot, { run_id: IDENTITY.run_id });

    // 行投影里没有 brief/instruction/evidence 原文；正文只能按 evidence ref 分页读取。
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('do dsp_ok');
    expect(serialized).not.toContain('x'.repeat(1_500));
    expect(page.lines.every((line) => !('brief' in line) && !('evidence' in line))).toBe(true);
  });

  it('pages by physical line cursor and reports has_more / next_after_line', async () => {
    const runsRoot = await createRunsRoot();
    await writeJournalFixture(runsRoot);

    const first = await readRunDispatchJournalPage(runsRoot, {
      run_id: IDENTITY.run_id,
      limit: 3,
    });
    expect(first.lines.map((line) => line.line)).toEqual([1, 2, 3]);
    expect(first.has_more).toBe(true);
    expect(first.next_after_line).toBe(3);

    const second = await readRunDispatchJournalPage(runsRoot, {
      run_id: IDENTITY.run_id,
      after_line: first.next_after_line ?? 0,
      limit: 3,
    });
    expect(second.lines.map((line) => line.line)).toEqual([4, 5, 6]);

    // 逐页拼起来就是全量，且 after_line 水位不会重复/丢行。
    const seen: number[] = [];
    let after = 0;
    for (;;) {
      const page = await readRunDispatchJournalPage(runsRoot, {
        run_id: IDENTITY.run_id,
        after_line: after,
        limit: 4,
      });
      seen.push(...page.lines.map((line) => line.line));
      if (!page.has_more) break;
      after = page.next_after_line ?? after;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('returns repairable_tail with parsed lines and problems, and no summary', async () => {
    const runsRoot = await createRunsRoot();
    const fixture = await writeJournalFixture(runsRoot);
    // 模拟进程在写 settled 行时被杀：末尾半截 JSON，无换行。
    await appendFile(fixture.journalPath, '{"event":"settled",', 'utf8');

    const page = await readRunDispatchJournalPage(runsRoot, { run_id: IDENTITY.run_id });

    expect(page.state).toBe('repairable_tail');
    expect(page.total_lines).toBe(10);
    expect(page.problems).toContainEqual(
      expect.objectContaining({ code: 'repairable_tail', line: 11 }),
    );
    // 折叠 fail closed，摘要缺席而不是编一个少一条的计数。
    expect(page).not.toHaveProperty('summary');
  });

  it('keeps readable lines and problems for a corrupt journal instead of throwing', async () => {
    const runsRoot = await createRunsRoot();
    const fixture = await writeJournalFixture(runsRoot);
    // 把中间一行换成坏 JSON（不是末尾半写，所以是 corrupt 而不是 repairable_tail）。
    const lines = (await readFile(fixture.journalPath, 'utf8')).split('\n');
    lines[2] = '{"not":"a journal entry"}';
    await writeFile(fixture.journalPath, lines.join('\n'), 'utf8');

    const page = await readRunDispatchJournalPage(runsRoot, { run_id: IDENTITY.run_id });

    expect(page.state).toBe('corrupt');
    expect(page.problems.some((problem) => problem.code === 'corrupt_line')).toBe(true);
    // 已解析的行仍然返回；物理行号补洞后不重叠、不漂移。
    expect(page.lines.length).toBeGreaterThan(0);
    const lineNumbers = page.lines.map((line) => line.line);
    expect(new Set(lineNumbers).size).toBe(lineNumbers.length);
    expect(lineNumbers).not.toContain(3);
    expect(lineNumbers).toContain(4);
    expect(page).not.toHaveProperty('summary');
  });

  it('treats a missing Journal as absent without creating files (legacy Run)', async () => {
    const runsRoot = await createRunsRoot();
    await mkdir(path.join(runsRoot, IDENTITY.run_id), { recursive: true });

    const page = await readRunDispatchJournalPage(runsRoot, { run_id: IDENTITY.run_id });

    expect(page).toMatchObject({
      run_id: IDENTITY.run_id,
      state: 'absent',
      total_lines: 0,
      lines: [],
      has_more: false,
      next_after_line: null,
      problems: [],
    });
    // 只读：没有 journal 目录/文件被创建出来。
    await expect(readdir(path.join(runsRoot, IDENTITY.run_id))).resolves.toEqual([]);

    const missingRun = await readRunDispatchJournalPage(runsRoot, { run_id: 'run_missing' });
    expect(missingRun.state).toBe('absent');
    expect(missingRun.durability.mode).toBe('best_effort');
  });

  it('rejects unsafe run ids before touching the filesystem', async () => {
    const runsRoot = await createRunsRoot();
    await expect(
      readRunDispatchJournalPage(runsRoot, { run_id: '../escape' }),
    ).rejects.toMatchObject({ code: 'unsafe_run_id' });
  });

  it('does not write, lock, or repair anything while reading', async () => {
    const runsRoot = await createRunsRoot();
    const fixture = await writeJournalFixture(runsRoot);
    const journalBefore = await readFile(fixture.journalPath);
    const journalStatBefore = await stat(fixture.journalPath);
    const evidencePath = path.join(fixture.runDir, 'journal', 'evidence', 'dsp_ok.json');
    const evidenceBefore = await readFile(evidencePath);

    await readRunDispatchJournalPage(runsRoot, { run_id: IDENTITY.run_id });
    await readRunDispatchEvidencePage(runsRoot, {
      run_id: IDENTITY.run_id,
      dispatch_id: 'dsp_ok',
    });

    expect(await readFile(fixture.journalPath)).toEqual(journalBefore);
    expect(await readFile(evidencePath)).toEqual(evidenceBefore);
    expect((await stat(fixture.journalPath)).mtimeMs).toBe(journalStatBefore.mtimeMs);
    // peek 不取写锁：journal 目录里只有 dispatches.jsonl 与 evidence/，没有锁/修复闸门。
    const journalEntries = await readdir(path.join(fixture.runDir, 'journal'));
    expect(journalEntries.sort()).toEqual(['dispatches.jsonl', 'evidence']);
    expect(journalEntries).not.toContain('.writer.lock');
  });

  it('R4-02: counts a reconciled unknown by its effective status while the raw settled line stays unknown', async () => {
    const runsRoot = await createRunsRoot();
    const runDir = path.join(runsRoot, IDENTITY.run_id);
    await mkdir(runDir, { recursive: true });
    const journal = await RunDispatchJournal.open({ runDir, identity: IDENTITY });
    const brief = makeBrief('dsp_late', 1, 'execute');
    await journal.appendAccepted({
      brief,
      brief_sha256: hashExecutionBrief(brief),
      budget_before: BUDGET,
    });
    await journal.appendDispatched({ dispatch_id: 'dsp_late' });
    // 超时/取消场景：settled 落 unknown（结局不明），随后真实迟到回执对账为 succeeded。
    const unknownEvidence = buildExecutionEvidence({
      dispatch_id: 'dsp_late',
      observation: { transport: { evidence: 'execution_unconfirmed' } },
    });
    const sidecar = await journal.appendEvidence({
      dispatch_id: 'dsp_late',
      evidence: unknownEvidence,
    });
    await journal.appendSettled({
      dispatch_id: 'dsp_late',
      status: 'unknown',
      evidence: unknownEvidence,
      evidence_sha256: sidecar.sha256,
      violations: [],
    });
    await expect(
      reconcileLateDriverResult(journal, 'dsp_late', lateDriverResult()),
    ).resolves.toBe('succeeded');
    const record = await journal.getDispatchRecord('dsp_late');
    // 原始记录/行仍保留 unknown：对账只新增 reconciled，不改写历史事实。
    expect(record?.status).toBe('unknown');
    await journal.close();

    const page = await readRunDispatchJournalPage(runsRoot, { run_id: IDENTITY.run_id });
    expect(page.summary).toMatchObject({
      total_dispatches: 1,
      // 对外摘要按有效状态计数：unknown 经可信 reconciled 收束成 succeeded。
      by_status: { succeeded: 1 },
      unknown_dispatch_ids: [],
      reconciled_dispatch_ids: ['dsp_late'],
    });
    // Journal 原始行如实保留：settled=unknown，reconciled=succeeded。
    expect(page.lines.filter((line) => line.event === 'settled')).toEqual([
      expect.objectContaining({ dispatch_id: 'dsp_late', status: 'unknown' }),
    ]);
    expect(page.lines.filter((line) => line.event === 'reconciled')).toEqual([
      expect.objectContaining({ dispatch_id: 'dsp_late', status: 'succeeded' }),
    ]);
    // 重复读取不放大计数（同一事实解释是幂等的）。
    const repeated = await readRunDispatchJournalPage(runsRoot, { run_id: IDENTITY.run_id });
    expect(repeated.summary).toEqual(page.summary);
  });
});

describe('readRunDispatchEvidencePage', () => {
  it('reads the settled evidence sidecar with hash binding and byte pagination', async () => {
    const runsRoot = await createRunsRoot();
    const fixture = await writeJournalFixture(runsRoot);

    const page = await readRunDispatchEvidencePage(runsRoot, {
      run_id: IDENTITY.run_id,
      dispatch_id: 'dsp_ok',
    });
    expect(page).toMatchObject({
      run_id: IDENTITY.run_id,
      dispatch_id: 'dsp_ok',
      path: 'journal/evidence/dsp_ok.json',
      sha256: fixture.evidence.sha256,
      offset: 0,
      truncated: false,
      next_offset: null,
    });
    expect(page.total_bytes).toBeGreaterThan(1_500);
    expect(page.limit).toBe(64 * 1024);
    expect(JSON.parse(page.content)).toMatchObject({ dispatch_id: 'dsp_ok', status: 'succeeded' });
    // 全量内容的 sha256 必须与 ref 绑定（受控读取校验后的值）。
    expect(sha256(page.content)).toBe(fixture.evidence.sha256);

    const first = await readRunDispatchEvidencePage(runsRoot, {
      run_id: IDENTITY.run_id,
      dispatch_id: 'dsp_ok',
      limit: 512,
    });
    expect(first.truncated).toBe(true);
    expect(first.limit).toBe(512);
    expect(first.next_offset).toBe(512);

    // 按 next_offset 逐页读到底：拼回来必须等于整份 canonical JSON，offset 严格推进。
    const chunks: string[] = [first.content];
    let next = first.next_offset;
    let pages = 1;
    while (next !== null) {
      const page = await readRunDispatchEvidencePage(runsRoot, {
        run_id: IDENTITY.run_id,
        dispatch_id: 'dsp_ok',
        offset: next,
        limit: 512,
      });
      expect(page.offset).toBe(next);
      chunks.push(page.content);
      pages += 1;
      next = page.next_offset;
    }
    expect(pages).toBeGreaterThan(1);
    expect(JSON.parse(chunks.join(''))).toMatchObject({
      dispatch_id: 'dsp_ok',
      status: 'succeeded',
    });
  });

  it('rejects dispatches without a registered evidence ref', async () => {
    const runsRoot = await createRunsRoot();
    await writeJournalFixture(runsRoot);

    // dispatched 但无 settled：没有可读的不可变认可内容。
    await expect(
      readRunDispatchEvidencePage(runsRoot, {
        run_id: IDENTITY.run_id,
        dispatch_id: 'dsp_unknown',
      }),
    ).rejects.toMatchObject({ code: 'dispatch_evidence_not_registered' });

    await expect(
      readRunDispatchEvidencePage(runsRoot, {
        run_id: IDENTITY.run_id,
        dispatch_id: 'dsp_missing',
      }),
    ).rejects.toMatchObject({ code: 'dispatch_not_in_journal' });

    await expect(
      readRunDispatchEvidencePage(runsRoot, {
        run_id: IDENTITY.run_id,
        dispatch_id: '../etc/passwd',
      }),
    ).rejects.toMatchObject({ code: 'unsafe_dispatch_id' });
  });

  it('reports a hash-mismatched sidecar as unavailable instead of returning bytes', async () => {
    const runsRoot = await createRunsRoot();
    const fixture = await writeJournalFixture(runsRoot);
    await writeFile(
      path.join(fixture.runDir, 'journal', 'evidence', 'dsp_ok.json'),
      '{"tampered":true}',
      'utf8',
    );

    await expect(
      readRunDispatchEvidencePage(runsRoot, {
        run_id: IDENTITY.run_id,
        dispatch_id: 'dsp_ok',
      }),
    ).rejects.toMatchObject({ code: 'dispatch_evidence_unavailable' });
  });

  it('rejects an unsafe run id', async () => {
    const runsRoot = await createRunsRoot();
    await expect(
      readRunDispatchEvidencePage(runsRoot, {
        run_id: '..\\escape',
        dispatch_id: 'dsp_ok',
      }),
    ).rejects.toMatchObject({ code: 'unsafe_run_id' });
  });
});

describe('NewideBackendService dispatch reads', () => {
  it('rejects unknown runs before reading the journal or invoking the runner', async () => {
    let runnerCalls = 0;
    const service = new NewideBackendService({
      run: async () => {
        runnerCalls += 1;
        throw new Error('runner must not start for a read-only journal query');
      },
    });

    await expect(service.getRunDispatchJournal({ run_id: 'run_missing' })).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
    await expect(
      service.getRunDispatchEvidence({ run_id: 'run_missing', dispatch_id: 'dsp_1' }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
    expect(runnerCalls).toBe(0);
  });

  it('reads a real journal through the service with the injected runs root while the run is open', async () => {
    const runsRoot = await createRunsRoot();
    let finish: (result: IntegrationV0Result) => void = () => undefined;
    const terminal = new Promise<IntegrationV0Result>((resolve) => {
      finish = resolve;
    });
    // 位置参数按生产构造点对齐：第 26 个才是 runs root（typecheck 会守住位置类型）。
    const service = new NewideBackendService(
      {
        run: async (request) => {
          request.onRunCreated?.({ run_id: 'run_live', task_id: 'task_live' });
          return terminal;
        },
      },
      new InMemoryRunRegistry(),
      new FileRunAuditWriter(runsRoot),
      new FileRunTerminalOutputWriter(runsRoot),
      new FileRunRequestStore(runsRoot),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new NoopDriverStreamAuditWriter(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runsRoot,
    );

    await expect(
      service.createRun({ prompt: 'dispatch read', workspace_path: process.cwd() }),
    ).resolves.toEqual({ run_id: 'run_live', task_id: 'task_live', status: 'running' });

    // 真实写一份 Journal 到注入的 runs root（模拟 role 引擎派工事实）。
    const identity = { run_id: 'run_live', task_id: 'task_live', role_id: 'role_live' };
    const runDir = path.join(runsRoot, 'run_live');
    const journal = await RunDispatchJournal.open({ runDir, identity });
    const brief = buildExecutionBrief({
      identity: {
        dispatch_id: 'dsp_live',
        ...identity,
        sequence: 1,
        accepted_at: ACCEPTED_AT,
      },
      request: { kind: 'execute', instruction: 'do the live dispatch' },
    }).brief;
    await journal.appendAccepted({
      brief,
      brief_sha256: hashExecutionBrief(brief),
      budget_before: BUDGET,
    });
    await journal.appendDispatched({ dispatch_id: 'dsp_live' });
    const evidence = makeEvidence('dsp_live', 'succeeded');
    const ref = await journal.appendEvidence({ dispatch_id: 'dsp_live', evidence });
    await journal.appendSettled({
      dispatch_id: 'dsp_live',
      status: 'succeeded',
      evidence,
      evidence_sha256: ref.sha256,
      violations: [],
    });
    await journal.close();

    // 运行中的 run 仍可读快照（新读取口不改变既有 run.* 行为）。
    expect((await service.getRunSnapshot('run_live')).status).toBe('running');

    const page = await service.getRunDispatchJournal({ run_id: 'run_live' });
    expect(page.state).toBe('ok');
    expect(page.summary).toMatchObject({ total_dispatches: 1, by_status: { succeeded: 1 } });
    expect(page.lines.map((line) => line.event)).toEqual([
      'accepted',
      'dispatched',
      'settled',
    ]);

    const evidencePage = await service.getRunDispatchEvidence({
      run_id: 'run_live',
      dispatch_id: 'dsp_live',
    });
    expect(evidencePage).toMatchObject({
      path: 'journal/evidence/dsp_live.json',
      sha256: ref.sha256,
    });

    finish(completedResult('run_live', 'task_live'));
    await service.waitForTerminal('run_live');
  });
});
