/**
 * 阶段 3 审核修复（问题 2）的行为测试：离线学习必须核验 Journal/evidence 引用。
 *
 * 用真实 RunDispatchJournal（临时 runs root）+ 真实 BufferRepository + 真实提取器 +
 * 真实 Context Delivery processor 覆盖：
 * - 有效前缀/evidence 正常消费（host_observed 上限、落库、归档、ack）；
 * - Journal 缺失、evidence 缺失、前缀 hash 失配、Buffer 计数与真实证据不一致时明确降级并留诊断；
 * - Journal 在 finish 之后追加合法行不影响已冻结前缀；
 * - 手动提取入口（extractBuffer）与 Context Delivery 走同一套提取器核验规则；
 * - 证据核验暂时不可用按既有重试生命周期处理，重试成功不会重复写经验。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildExecutionBrief,
  buildExecutionEvidence,
  hashExecutionBrief,
  type ExecutionCheck,
} from '../../src/driver';
import { RunDispatchJournal } from '../../src/persistence';
import {
  BUFFER_SNAPSHOT_V2_SCHEMA_VERSION,
  DefaultContextDeliveryProcessor,
  InMemoryBufferRepository,
  InMemoryMemoryDeliveryRepository,
  InMemoryRepository,
  RuleBasedExperienceExtractor,
  buildContextDeliveryItem,
  contextDeliverySourceFields,
  createAgentMemoryScope,
  extractBuffer,
  type BufferDispatchSummary,
  type BufferSnapshotV2,
} from '../../src/memory';
import {
  buildJournalPrefixRef,
  dispatchSummaryFromRecord,
} from '../../src/app/role-learning-input';
import { RunJournalLearningEvidenceVerifier } from '../../src/app/learning-evidence-verifier';

const ROLE = 'role_evidence_verify';
const TASK = 'task_evidence_verify';
const NOW = '2026-11-14T00:00:00.000Z';
const BUDGET_BEFORE = {
  dispatches_left: 11,
  role_tokens_left: 120_000,
  deadline_at: '2027-11-14T00:45:00.000Z',
};

const temporaryRoots: string[] = [];
let runCounter = 0;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-learning-evidence-'));
  temporaryRoots.push(root);
  return root;
}

function hostObservedPassChecks(): ExecutionCheck[] {
  return [{ exit_code: 0, provenance: 'host_observed', observation: 'complete' }];
}

interface BuiltRun {
  runId: string;
  runDir: string;
  snapshot: BufferSnapshotV2;
  evidencePath?: string;
}

/**
 * 构造一条真实的 Run Journal（可选一次完整派工 + finish），并按写入端规则生成 Buffer v2
 * 引用/摘要。Journal 在返回前关闭；追加行测试通过 `afterSnapshot` 在关闭前追加。
 */
async function buildRun(input: {
  runsRoot: string;
  checks?: readonly ExecutionCheck[];
  withDispatch?: boolean;
  finishStatus?: 'completed' | 'blocked' | 'failed';
  afterSnapshot?: (journal: RunDispatchJournal) => Promise<void>;
}): Promise<BuiltRun> {
  runCounter += 1;
  const runId = `run_evidence_${String(runCounter)}`;
  const runDir = path.join(input.runsRoot, runId);
  await fs.mkdir(runDir, { recursive: true });
  const journal = await RunDispatchJournal.open({
    runDir,
    identity: { run_id: runId, task_id: TASK, role_id: ROLE },
  });
  let evidencePath: string | undefined;
  try {
    if (input.withDispatch !== false) {
      const dispatchId = 'dsp_verify_1';
      const brief = buildExecutionBrief({
        identity: {
          dispatch_id: dispatchId,
          run_id: runId,
          task_id: TASK,
          role_id: ROLE,
          sequence: 1,
          accepted_at: NOW,
        },
        request: { kind: 'verify', instruction: 'run the check' },
      }).brief;
      await journal.appendAccepted({
        brief,
        brief_sha256: hashExecutionBrief(brief),
        budget_before: BUDGET_BEFORE,
      });
      await journal.appendDispatched({ dispatch_id: dispatchId });
      const evidence = buildExecutionEvidence({
        dispatch_id: dispatchId,
        observation: {
          transport: { evidence: 'execution_unconfirmed' },
          result: { status: 'succeeded', response: 'ok' },
          checks: [...(input.checks ?? [])],
        },
      });
      const ref = await journal.appendEvidence({ dispatch_id: dispatchId, evidence });
      await journal.appendSettled({
        dispatch_id: dispatchId,
        status: 'succeeded',
        evidence,
        evidence_sha256: ref.sha256,
        violations: [],
      });
      evidencePath = path.join(runDir, ref.ref.path);
    }
    const finishStatus = input.finishStatus ?? 'completed';
    await journal.appendFinish({
      actor: 'role',
      status: finishStatus,
      reason: 'finished',
      evidence_refs: [],
      summary: finishStatus === 'completed' ? 'finished the task' : `task ${finishStatus}`,
      unresolved: [],
      role_reflection: 'ran the controlled checks',
      verification: [],
    });

    const read = await journal.read();
    const journalRef = buildJournalPrefixRef(read, runId);
    const fold = await journal.fold();
    const dispatches: BufferDispatchSummary[] = fold.records.map(dispatchSummaryFromRecord);
    const snapshot: BufferSnapshotV2 = {
      schema_version: BUFFER_SNAPSHOT_V2_SCHEMA_VERSION,
      buffer_version: 2,
      task_id: TASK,
      task_description: 'verify evidence references offline',
      source_task_id: TASK,
      journal_ref: journalRef,
      dispatches,
      role_reflection: {
        status: finishStatus,
        summary: finishStatus === 'completed' ? 'finished the task' : `task ${finishStatus}`,
        reflection: 'ran the controlled checks',
        unresolved: [],
        verification: [],
        memory_used: [],
      },
      source_drivers: input.withDispatch === false ? [] : ['driver_verify'],
      received_at: NOW,
      retry_count: 0,
      extraction_status: 'pending',
    };
    if (input.afterSnapshot) await input.afterSnapshot(journal);
    return { runId, runDir, snapshot, ...(evidencePath !== undefined ? { evidencePath } : {}) };
  } finally {
    await journal.close();
  }
}

function verifier(runsRoot: string): RunJournalLearningEvidenceVerifier {
  return new RunJournalLearningEvidenceVerifier({ runs_root: runsRoot });
}

interface DeliveryHarness {
  repository: InMemoryRepository;
  bufferRepository: InMemoryBufferRepository;
  deliveryRepository: InMemoryMemoryDeliveryRepository;
  processor: DefaultContextDeliveryProcessor;
  bufferSeq: number;
}

async function deliveryHarness(
  snapshot: BufferSnapshotV2,
  extractor: RuleBasedExperienceExtractor,
): Promise<DeliveryHarness> {
  const repository = new InMemoryRepository();
  await repository.initializeAgent({ role_id: ROLE, name: ROLE });
  const bufferRepository = new InMemoryBufferRepository();
  const deliveryRepository = new InMemoryMemoryDeliveryRepository();
  const saved = await bufferRepository.saveBufferSnapshot(ROLE, snapshot);
  const item = buildContextDeliveryItem({
    role_id: ROLE,
    task_id: TASK,
    buffer_seq: saved.seq,
    ...contextDeliverySourceFields(snapshot),
  });
  await deliveryRepository.submitContextDelivery(item);
  const processor = new DefaultContextDeliveryProcessor({
    deliveryRepository,
    bufferRepository,
    extractor,
    scopeFactory: (roleId) => createAgentMemoryScope(repository, bufferRepository, roleId),
    now: () => NOW,
  });
  return { repository, bufferRepository, deliveryRepository, processor, bufferSeq: saved.seq };
}

async function claimNext(
  harness: DeliveryHarness,
  now: string = NOW,
  owner = 'worker_1',
): Promise<{ item: Parameters<DefaultContextDeliveryProcessor['process']>[0] }> {
  const claimed = await harness.deliveryRepository.claimNextDelivery({
    channel: 'context',
    role_id: ROLE,
    owner,
    lease_ms: 60_000,
    now,
  });
  if (claimed?.channel !== 'context') throw new Error('context delivery was not claimable');
  return claimed;
}

// ─────────────────────────────────────────────────────────────
//  有效证据：正常消费
// ─────────────────────────────────────────────────────────────

describe('离线学习核验有效 Journal/evidence', () => {
  it('有效引用正常消费：host_observed 上限、经验落库、Buffer 归档、交付 ack', async () => {
    const runsRoot = await makeRoot();
    const run = await buildRun({ runsRoot, checks: hostObservedPassChecks() });
    const harness = await deliveryHarness(
      run.snapshot,
      new RuleBasedExperienceExtractor({ evidence: verifier(runsRoot) }),
    );
    const claimed = await claimNext(harness);
    const outcome = await harness.processor.process(claimed.item, { worker_id: 'worker_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.experiences_created).toBe(1);
    expect(outcome.warnings.join(' ')).not.toContain('not trusted');
    const experiences = await harness.repository.listExperiences(ROLE);
    expect(experiences).toHaveLength(1);
    expect(experiences[0]?.confidence).toBe(0.55);
    expect((await harness.bufferRepository.getStoredBuffer(ROLE, harness.bufferSeq))?.location).toBe(
      'processed',
    );
    const delivery = await harness.deliveryRepository.getContextDelivery(
      ROLE,
      claimed.item.delivery_id,
    );
    expect(delivery?.status).toBe('processed');
  });

  it('finish 之后追加的合法行不影响已冻结的有效前缀', async () => {
    const runsRoot = await makeRoot();
    const run = await buildRun({
      runsRoot,
      checks: hostObservedPassChecks(),
      afterSnapshot: async (journal) => {
        await journal.appendRoleRound({ round: 1, usage_missing: true });
      },
    });
    const verified = await verifier(runsRoot).verify(run.snapshot);
    expect(verified.status).toBe('verified');
    expect(verified.dispatches?.[0]?.checks.host_observed_passed).toBe(1);
  });

  it('零派工 Run 的前缀同样可核验，结束状态取自已接受的 finish', async () => {
    const runsRoot = await makeRoot();
    const run = await buildRun({ runsRoot, withDispatch: false, finishStatus: 'blocked' });
    const verified = await verifier(runsRoot).verify(run.snapshot);
    expect(verified.status).toBe('verified');
    expect(verified.dispatches).toEqual([]);
    expect(verified.finish_status).toBe('blocked');
    const output = await new RuleBasedExperienceExtractor({
      evidence: verifier(runsRoot),
    }).extract(run.snapshot);
    const negative = output.experiences.find((experience) => experience.type === 'negative');
    expect(negative?.confidence).toBeLessThanOrEqual(0.5);
  });
});

// ─────────────────────────────────────────────────────────────
//  缺失/失配：降级 + 诊断
// ─────────────────────────────────────────────────────────────

describe('离线学习核验缺失/失配引用', () => {
  it('Journal/Run 目录缺失：明确降级为 role_declared 并留诊断', async () => {
    const runsRoot = await makeRoot();
    const run = await buildRun({ runsRoot, checks: hostObservedPassChecks() });
    await fs.rm(run.runDir, { recursive: true, force: true });
    const verified = await verifier(runsRoot).verify(run.snapshot);
    expect(verified.status).toBe('missing');
    expect(verified.warnings.join(' ')).toContain('can no longer be verified');

    const harness = await deliveryHarness(
      run.snapshot,
      new RuleBasedExperienceExtractor({ evidence: verifier(runsRoot) }),
    );
    const claimed = await claimNext(harness);
    const outcome = await harness.processor.process(claimed.item, { worker_id: 'worker_1' });
    expect(outcome.status).toBe('completed');
    expect(outcome.warnings.join(' ')).toContain('missing');
    const experiences = await harness.repository.listExperiences(ROLE);
    expect(experiences[0]?.confidence).toBeLessThanOrEqual(0.35);
  });

  it('evidence 侧车缺失：受控读取判为 missing，不保留 host_observed 等级', async () => {
    const runsRoot = await makeRoot();
    const run = await buildRun({ runsRoot, checks: hostObservedPassChecks() });
    if (run.evidencePath === undefined) throw new Error('fixture did not write evidence');
    await fs.rm(run.evidencePath, { force: true });

    const verified = await verifier(runsRoot).verify(run.snapshot);
    expect(verified.status).toBe('missing');
    expect(verified.warnings.join(' ')).toContain('evidence');

    const output = await new RuleBasedExperienceExtractor({
      evidence: verifier(runsRoot),
    }).extract(run.snapshot);
    expect(output.experiences[0]?.confidence).toBeLessThanOrEqual(0.35);
    expect((output.warnings ?? []).join(' ')).toContain('not trusted');
  });

  it('前缀 hash 失配：判为 mismatch 并降级', async () => {
    const runsRoot = await makeRoot();
    const run = await buildRun({ runsRoot, checks: hostObservedPassChecks() });
    const tampered: BufferSnapshotV2 = {
      ...run.snapshot,
      journal_ref: { ...run.snapshot.journal_ref, sha256: 'b'.repeat(64) },
    };
    const verified = await verifier(runsRoot).verify(tampered);
    expect(verified.status).toBe('mismatch');
    expect(verified.warnings.join(' ')).toContain('sha256');

    const harness = await deliveryHarness(
      tampered,
      new RuleBasedExperienceExtractor({ evidence: verifier(runsRoot) }),
    );
    const claimed = await claimNext(harness);
    const outcome = await harness.processor.process(claimed.item, { worker_id: 'worker_1' });
    expect(outcome.status).toBe('completed');
    expect(outcome.warnings.join(' ')).toContain('mismatch');
    expect((await harness.repository.listExperiences(ROLE))[0]?.confidence).toBeLessThanOrEqual(
      0.35,
    );
  });

  it('Buffer 摘要计数与真实证据不一致：不能获得未核实的 host_observed 等级', async () => {
    const runsRoot = await makeRoot();
    // 真实 evidence 没有任何检查；Buffer 却声称一次 host_observed 通过。
    const run = await buildRun({ runsRoot });
    const claimed: BufferSnapshotV2 = {
      ...run.snapshot,
      dispatches: run.snapshot.dispatches.map((dispatch) => ({
        ...dispatch,
        checks: { ...dispatch.checks, host_observed_passed: 1 },
      })),
      role_reflection: {
        ...run.snapshot.role_reflection,
        verification: [
          { requirement: 'checks pass', outcome: 'passed', dispatch_ids: ['dsp_verify_1'] },
        ],
      },
    };
    const verified = await verifier(runsRoot).verify(claimed);
    expect(verified.status).toBe('mismatch');
    expect(verified.warnings.join(' ')).toContain('host_observed_passed');

    const harness = await deliveryHarness(
      claimed,
      new RuleBasedExperienceExtractor({ evidence: verifier(runsRoot) }),
    );
    const item = await claimNext(harness);
    const outcome = await harness.processor.process(item.item, { worker_id: 'worker_1' });
    expect(outcome.status).toBe('completed');
    expect(outcome.warnings.join(' ')).toContain('mismatch');
    const experience = (await harness.repository.listExperiences(ROLE))[0];
    expect(experience?.confidence).toBeLessThanOrEqual(0.35);
    expect(experience?.confidence_history[0]?.reason).not.toContain('host_observed');
  });

  it('手动提取入口（extractBuffer）与 Context Delivery 共用同一核验规则', async () => {
    const runsRoot = await makeRoot();
    const run = await buildRun({ runsRoot });
    const tampered: BufferSnapshotV2 = {
      ...run.snapshot,
      journal_ref: { ...run.snapshot.journal_ref, sha256: 'c'.repeat(64) },
    };
    const repository = new InMemoryRepository();
    await repository.initializeAgent({ role_id: ROLE, name: ROLE });
    const bufferRepository = new InMemoryBufferRepository();
    const saved = await bufferRepository.saveBufferSnapshot(ROLE, tampered);
    const scope = createAgentMemoryScope(repository, bufferRepository, ROLE);
    const extraction = await extractBuffer(
      scope,
      saved.seq,
      new RuleBasedExperienceExtractor({ evidence: verifier(runsRoot) }),
    );
    expect((extraction.warnings ?? []).join(' ')).toContain('mismatch');
    expect(extraction.experiences[0]?.confidence).toBeLessThanOrEqual(0.35);
  });
});

// ─────────────────────────────────────────────────────────────
//  重试：暂时不可用 vs 内容损坏
// ─────────────────────────────────────────────────────────────

describe('证据核验失败的既有生命周期', () => {
  it('暂时不可用按可重试失败退回队列；重试成功后只写一份经验并归档/ack', async () => {
    const runsRoot = await makeRoot();
    const run = await buildRun({ runsRoot, checks: hostObservedPassChecks() });
    const real = verifier(runsRoot);
    let firstCall = true;
    const flaky = {
      verify: async (snapshot: BufferSnapshotV2) => {
        if (firstCall) {
          firstCall = false;
          throw Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' });
        }
        return real.verify(snapshot);
      },
    };
    const harness = await deliveryHarness(
      run.snapshot,
      new RuleBasedExperienceExtractor({ evidence: flaky }),
    );
    const claimed = await claimNext(harness);
    const first = await harness.processor.process(claimed.item, { worker_id: 'worker_1' });
    expect(first.status).toBe('retried');
    expect(first.failure).toMatchObject({ retryable: true });
    expect(await harness.repository.listExperiences(ROLE)).toHaveLength(0);

    const claimedAgain = await claimNext(harness, '2026-11-14T00:00:10.000Z', 'worker_2');
    const second = await harness.processor.process(claimedAgain.item, { worker_id: 'worker_2' });
    expect(second.status).toBe('completed');
    expect(second.experiences_created).toBe(1);
    expect(await harness.repository.listExperiences(ROLE)).toHaveLength(1);
    expect((await harness.bufferRepository.getStoredBuffer(ROLE, harness.bufferSeq))?.location).toBe(
      'processed',
    );
    const delivery = await harness.deliveryRepository.getContextDelivery(
      ROLE,
      claimed.item.delivery_id,
    );
    expect(delivery?.status).toBe('processed');
  });
});
