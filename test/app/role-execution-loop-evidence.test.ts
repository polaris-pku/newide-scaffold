/**
 * 阶段 2 finish 证据校验与持久化测试（矩阵 FIN-02 / FIN-03 / FIN-05 与 JRN 相关项）。
 *
 * 完成语义已收缩（RD-FIN-03 修订），本文件按新契约组织：
 * - 宿主**不再**从自由文本 `completion_criteria` 推导检查义务，不解析命令/argv、不拆子句、
 *   不比较检查范围，也不比较 requirement 文本；语义验收是 role 的责任，role 用
 *   `verification[]` 逐条陈述 `passed` / `failed` / `not_run`。
 * - 宿主只核验**事实**：受控 evidence ref 的登记/路径/sha256（走 `journal.readEvidence`），
 *   以及 `passed` claim 引用的派工是否真实存在、是否有 `host_observed + complete + exit 0`
 *   且 `workspace_sha256` 等于 finish 时最终工作区指纹的检查证据；Driver 自述、
 *   partial 观察、非零退出、旧指纹都不算通过。`failed` / `not_run` 不要求证据。
 * - `completed` 的安全约束也在这里：未决 `unknown` dispatch（显式 retry 可信收束后可解）、
 *   只读违规（含恢复链祖先）、取消/预算、`response_only` 冲突。
 * - `persistRoleFinish` 是 finish 的唯一生产落盘点，本文件与 loop 走同一入口：幂等写、
 *   写失败转 `journal_write_failed`、finish 行含 verification 且不写已退役的 checks。
 * - journal 读失败（fold/evidence）映射成 gap，不把底层异常抛给 role。
 *
 * 全部使用真实 `createRoleFinishValidator()` + 真实 `RunDispatchJournal`；fake journal
 * 只用于故障注入。已退役的「命令义务/子句/target_paths/argv 等价/要求抽取」语义不再测试。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DispatchRecord,
  EvidenceArtifactRef,
  EvidenceRef,
  ExecutionCheck,
  ExecutionEvidence,
  JournalViolation,
} from '../../src/driver';
import {
  buildExecutionBrief,
  buildExecutionEvidence,
  DISPATCH_RECORD_SCHEMA_VERSION,
  driverReportedCheck,
  hashExecutionBrief,
  hashExecutionEvidence,
  hostObservedCheck,
} from '../../src/driver';
import type {
  DispatchJournalEvidencePage,
  DispatchJournalFoldResult,
  DispatchJournalReadResult,
  JournalFinishAppendInput,
  JournalInitAppendInput,
  ReadDispatchEvidenceOptions,
  RoleRoundAppendInput,
} from '../../src/persistence';
import { RunDispatchJournal } from '../../src/persistence';
import type {
  RoleBudgetConsumption,
  RoleBudgetLimits,
  RoleFinishDecision,
  RoleFinishRecord,
  RoleFinishValidatorInput,
  RoleJournalPort,
  RoleLoopContextInput,
  RoleVerificationClaim,
} from '../../src/app/role-autonomy-contract';
import {
  ROLE_BUDGET_DEFAULTS,
  RoleTerminationError,
} from '../../src/app/role-autonomy-contract';
import { emptyRoleBudgetConsumption, RoleBudget } from '../../src/app/role-autonomy-budget';
import { createRoleFinishValidator, persistRoleFinish } from '../../src/app/role-autonomy-finish';

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────

const IDENTITY = { run_id: 'run_evidence', task_id: 'task_evidence', role_id: 'role_evidence' };
const START_MS = Date.parse('2026-11-13T12:00:00.000Z');
const ACCEPTED_AT = '2026-11-13T12:00:00.000Z';
const NOW = new Date('2026-11-13T12:10:00.000Z');
const FROZEN_DEADLINE_AT = '2026-11-13T12:45:00.000Z';
const BUDGET_BEFORE = {
  dispatches_left: 11,
  role_tokens_left: 100_000,
  deadline_at: FROZEN_DEADLINE_AT,
};
const HOST_CHECK = 'pnpm test';

const temporaryDirectories: string[] = [];
const openJournals: RunDispatchJournal[] = [];

afterEach(async () => {
  await Promise.all(
    openJournals.splice(0).map((journal) => journal.close().catch(() => undefined)),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function openJournal(): Promise<{ journal: RunDispatchJournal; runDir: string }> {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'newide-role-finish-'));
  temporaryDirectories.push(runDir);
  const journal = await RunDispatchJournal.open({ runDir, identity: IDENTITY });
  openJournals.push(journal);
  return { journal, runDir };
}

function emptyRead(): DispatchJournalReadResult {
  return {
    kind: 'legacy',
    status: 'absent',
    lines: [],
    entries: [],
    controls: [],
    repairs: [],
    problems: [],
    durability: { mode: 'fsync', directory_sync: true, notes: [] },
  };
}

function emptyFold(): DispatchJournalFoldResult {
  return {
    records: [],
    byDispatchId: new Map(),
    init: undefined,
    finish: undefined,
    repairs: [],
    entry_count: 0,
  };
}

interface FakeJournalOptions {
  fold?: () => Promise<DispatchJournalFoldResult>;
  readEvidence?: (
    ref: EvidenceRef,
    options?: ReadDispatchEvidenceOptions,
  ) => Promise<DispatchJournalEvidencePage>;
  appendFinish?: (input: JournalFinishAppendInput) => Promise<void>;
}

interface FakeJournal extends RoleJournalPort {
  finishes: JournalFinishAppendInput[];
}

/** 故障注入用：只实现 finish 校验/持久化读到的能力，不冒充真实 journal 存储。 */
function createFakeJournal(options: FakeJournalOptions = {}): FakeJournal {
  const finishes: JournalFinishAppendInput[] = [];
  return {
    finishes,
    read: async () => emptyRead(),
    fold: options.fold ?? (async () => emptyFold()),
    appendInit: async (_input: JournalInitAppendInput) => undefined,
    appendFinish: async (input: JournalFinishAppendInput) => {
      finishes.push(input);
      await options.appendFinish?.(input);
    },
    appendRoleRound: async (_input: RoleRoundAppendInput) => undefined,
    registerEvidenceRef: async (_ref: EvidenceRef) => undefined,
    readEvidence:
      options.readEvidence ??
      (async () => {
        throw new Error('fake journal does not serve evidence');
      }),
    getDispatchRecord: async (_dispatchId: string) => undefined,
  };
}

function makeBudget(
  overrides: Partial<RoleBudgetLimits> = {},
  consumed?: RoleBudgetConsumption,
): RoleBudget {
  const limits: RoleBudgetLimits = { ...ROLE_BUDGET_DEFAULTS, ...overrides };
  return new RoleBudget({
    frozen: {
      limits,
      deadline_at: new Date(START_MS + limits.wall_clock_seconds * 1_000).toISOString(),
    },
    consumed: consumed ?? emptyRoleBudgetConsumption(),
    journal: createFakeJournal(),
  });
}

function makeContext(overrides: Partial<RoleLoopContextInput> = {}): RoleLoopContextInput {
  return {
    task_id: IDENTITY.task_id,
    run_id: IDENTITY.run_id,
    role_id: IDENTITY.role_id,
    instruction: 'do the task',
    response_only_allowed: false,
    ...overrides,
  };
}

interface ValidateOptions {
  journal: RoleJournalPort;
  request?: Partial<RoleFinishValidatorInput['request']>;
  context?: Partial<RoleLoopContextInput>;
  budget?: RoleBudget;
  cancelled?: boolean;
  current_workspace_sha256?: string;
  inherited_records?: RoleFinishValidatorInput['inherited_records'];
  now?: Date;
}

async function validate(options: ValidateOptions): Promise<RoleFinishDecision> {
  const request: RoleFinishValidatorInput['request'] = {
    status: 'completed',
    summary: 'done',
    evidence_refs: [],
    unresolved: [],
    role_reflection: '',
    ...(options.request ?? {}),
  };
  return createRoleFinishValidator().validate({
    request,
    journal: options.journal,
    context: makeContext(options.context ?? {}),
    budget: options.budget ?? makeBudget(),
    dispatches: [],
    cancelled: options.cancelled ?? false,
    ...(options.current_workspace_sha256 !== undefined
      ? { current_workspace_sha256: options.current_workspace_sha256 }
      : {}),
    ...(options.inherited_records !== undefined
      ? { inherited_records: options.inherited_records }
      : {}),
    now: options.now ?? NOW,
  });
}

function gapCodes(decision: RoleFinishDecision): string[] {
  return (decision.gaps ?? []).map((entry) => entry.code);
}

function gapDetail(
  decision: RoleFinishDecision,
  code: string,
): Record<string, unknown> | undefined {
  return decision.gaps?.find((entry) => entry.code === code)?.detail;
}

/** verification claim 的规范形状：passed 的派工/证据引用默认空。 */
function verificationClaim(
  overrides: Partial<RoleVerificationClaim> = {},
): RoleVerificationClaim {
  return {
    requirement: 'the task requirement is satisfied',
    outcome: 'passed',
    dispatch_ids: [],
    evidence_refs: [],
    ...overrides,
  };
}

function makeRecord(overrides: Partial<RoleFinishRecord> = {}): RoleFinishRecord {
  return {
    status: 'completed',
    summary: 'done',
    evidence_refs: [],
    unresolved: [],
    role_reflection: '',
    response_only: false,
    verification: [],
    accepted_at: NOW.toISOString(),
    ...overrides,
  };
}

function expectTermination(error: unknown, code: string, actor: string): void {
  expect(error).toBeInstanceOf(RoleTerminationError);
  const termination = (error as RoleTerminationError).termination;
  expect(termination.code).toBe(code);
  expect(termination.actor).toBe(actor);
}

interface AppendAcceptedOptions {
  retryOf?: string;
  reconciliationRef?: EvidenceRef;
  kind?: 'investigate' | 'execute' | 'verify';
}

async function appendAcceptedDispatch(
  journal: RunDispatchJournal,
  dispatchId: string,
  sequence: number,
  options: AppendAcceptedOptions = {},
): Promise<void> {
  const brief = buildExecutionBrief({
    identity: {
      dispatch_id: dispatchId,
      run_id: IDENTITY.run_id,
      task_id: IDENTITY.task_id,
      role_id: IDENTITY.role_id,
      sequence,
      accepted_at: ACCEPTED_AT,
    },
    request: {
      kind: options.kind ?? 'execute',
      instruction: `run ${dispatchId}`,
      ...(options.retryOf !== undefined ? { retry_of: options.retryOf } : {}),
      ...(options.reconciliationRef !== undefined
        ? { reconciliation_ref: options.reconciliationRef }
        : {}),
    },
  }).brief;
  await journal.appendAccepted({
    brief,
    brief_sha256: hashExecutionBrief(brief),
    budget_before: BUDGET_BEFORE,
  });
}

interface AppendSettledOptions {
  status?: 'succeeded' | 'failed';
  checks?: readonly ExecutionCheck[];
  violations?: readonly JournalViolation[];
}

async function appendSettledDispatch(
  journal: RunDispatchJournal,
  dispatchId: string,
  options: AppendSettledOptions = {},
): Promise<{ evidence: ExecutionEvidence; ref: EvidenceArtifactRef }> {
  const status = options.status ?? 'succeeded';
  const evidence = buildExecutionEvidence({
    dispatch_id: dispatchId,
    observation: {
      transport: { evidence: 'execution_unconfirmed' },
      ...(status === 'succeeded'
        ? { result: { status: 'succeeded' as const, response: 'ok' } }
        : {
            result: { status: 'failed' as const },
            error: { code: 'E_FAIL', message: 'boom', retryable: false },
          }),
      ...(options.checks !== undefined ? { checks: options.checks } : {}),
    },
  });
  const ref = await journal.appendEvidence({ dispatch_id: dispatchId, evidence });
  await journal.appendSettled({
    dispatch_id: dispatchId,
    status,
    evidence,
    evidence_sha256: ref.sha256,
    violations: options.violations ?? [],
  });
  return { evidence, ref };
}

/** 追加一个完整成功派工（accepted → dispatched → evidence → settled，无检查）。 */
async function appendFullDispatch(
  journal: RunDispatchJournal,
  dispatchId = 'dispatch_1',
  sequence = 1,
): Promise<EvidenceArtifactRef> {
  await appendAcceptedDispatch(journal, dispatchId, sequence);
  await journal.appendDispatched({ dispatch_id: dispatchId });
  const { ref } = await appendSettledDispatch(journal, dispatchId);
  return ref;
}

/** 追加一个已 settled 且证据里带 host 检查的 verify 派工（verification passed 的真实来源）。 */
async function appendCheckDispatch(
  journal: RunDispatchJournal,
  checks: readonly ExecutionCheck[],
  dispatchId = 'dispatch_checks',
  sequence = 1,
): Promise<void> {
  await appendAcceptedDispatch(journal, dispatchId, sequence, { kind: 'verify' });
  await journal.appendDispatched({ dispatch_id: dispatchId });
  await appendSettledDispatch(journal, dispatchId, { checks });
}

/** 恢复链祖先 Run 的既成派工事实（只读；不写入当前 Run 的 journal）。 */
function ancestorRecord(input: {
  dispatchId: string;
  checks?: readonly ExecutionCheck[];
  violations?: readonly JournalViolation[];
}): DispatchRecord {
  const dispatchId = input.dispatchId;
  const brief = buildExecutionBrief({
    identity: {
      dispatch_id: dispatchId,
      run_id: 'ancestor_run',
      task_id: IDENTITY.task_id,
      role_id: IDENTITY.role_id,
      sequence: 1,
      accepted_at: ACCEPTED_AT,
    },
    request: { kind: 'investigate', instruction: 'ancestor work' },
  }).brief;
  const evidence = buildExecutionEvidence({
    dispatch_id: dispatchId,
    observation: {
      transport: { evidence: 'execution_unconfirmed' },
      result: { status: 'succeeded' as const, response: 'ok' },
      ...(input.checks !== undefined ? { checks: input.checks } : {}),
    },
  });
  return {
    schema_version: DISPATCH_RECORD_SCHEMA_VERSION,
    dispatch_id: dispatchId,
    run_id: 'ancestor_run',
    task_id: IDENTITY.task_id,
    role_id: IDENTITY.role_id,
    sequence: 1,
    phase: 'settled',
    status: 'succeeded',
    brief,
    brief_sha256: hashExecutionBrief(brief),
    evidence,
    evidence_sha256: hashExecutionEvidence(evidence),
    violations: [...(input.violations ?? [])],
    accepted_at: ACCEPTED_AT,
    settled_at: ACCEPTED_AT,
  };
}

// ─────────────────────────────────────────────────────────────
// finish 引用校验（真实 journal 受控读取面）
// ─────────────────────────────────────────────────────────────

describe('finish 引用校验', () => {
  it('本 Run 登记的 settled evidence 可通过；未登记/坏 hash/篡改侧车/file:// 被拒并给 gap', async () => {
    const { journal, runDir } = await openJournal();
    const ref = await appendFullDispatch(journal);

    const accepted = await validate({ journal, request: { evidence_refs: [ref.ref] } });
    expect(accepted.accepted).toBe(true);
    expect(accepted.record).toEqual({
      status: 'completed',
      summary: 'done',
      evidence_refs: [ref.ref],
      unresolved: [],
      role_reflection: '',
      response_only: false,
      verification: [],
      accepted_at: NOW.toISOString(),
    });

    const unregistered = await validate({
      journal,
      request: { evidence_refs: [{ path: 'journal/evidence/other.json', sha256: ref.ref.sha256 }] },
    });
    expect(unregistered.accepted).toBe(false);
    expect(gapCodes(unregistered)).toContain('evidence_ref_not_registered');

    const wrongHash = await validate({
      journal,
      request: { evidence_refs: [{ ...ref.ref, sha256: 'b'.repeat(64) }] },
    });
    expect(wrongHash.accepted).toBe(false);
    expect(gapCodes(wrongHash)).toContain('evidence_ref_not_registered');

    const unsafe = await validate({
      journal,
      request: {
        evidence_refs: [{ path: 'file:///etc/passwd', sha256: ref.ref.sha256 } as EvidenceRef],
      },
    });
    expect(gapCodes(unsafe)).toContain('evidence_ref_not_registered');

    // 篡改侧车内容：登记的是原 hash → evidence_hash_mismatch（不是「未登记」）。
    await writeFile(path.join(runDir, ref.ref.path), '{"tampered":true}', 'utf8');
    const tampered = await validate({ journal, request: { evidence_refs: [ref.ref] } });
    expect(tampered.accepted).toBe(false);
    expect(gapCodes(tampered)).toContain('evidence_hash_mismatch');
  });

  it('顶层与 verification claim 的 evidence_refs 都走登记/hash 校验（failed/not_run 亦然）', async () => {
    const { journal, runDir } = await openJournal();
    const artifact = await appendFullDispatch(journal);
    const failedClaim = verificationClaim({
      requirement: 'manually inspected the fix',
      outcome: 'failed',
      evidence_refs: [artifact.ref],
    });

    const accepted = await validate({ journal, request: { verification: [failedClaim] } });
    expect(accepted.accepted).toBe(true);
    expect(accepted.record?.verification).toEqual([failedClaim]);

    const unregistered = await validate({
      journal,
      request: {
        verification: [
          verificationClaim({
            requirement: 'not verified',
            outcome: 'not_run',
            evidence_refs: [{ path: 'journal/evidence/never.json', sha256: 'c'.repeat(64) }],
          }),
        ],
      },
    });
    expect(unregistered.accepted).toBe(false);
    expect(gapCodes(unregistered)).toContain('evidence_ref_not_registered');

    // 篡改 claim 引用的侧车：同样按 hash 校验拒绝。
    await writeFile(path.join(runDir, artifact.ref.path), '{"tampered":true}', 'utf8');
    const tampered = await validate({ journal, request: { verification: [failedClaim] } });
    expect(tampered.accepted).toBe(false);
    expect(gapCodes(tampered)).toContain('evidence_hash_mismatch');
  });

  it('blocked/failed finish 同样不得引用未登记证据', async () => {
    const { journal } = await openJournal();
    const decision = await validate({
      journal,
      request: {
        status: 'blocked',
        evidence_refs: [{ path: 'journal/evidence/missing.json', sha256: 'd'.repeat(64) }],
      },
    });
    expect(decision.accepted).toBe(false);
    expect(gapCodes(decision)).toContain('evidence_ref_not_registered');
  });
});

// ─────────────────────────────────────────────────────────────
// 完成语义收缩：宿主不再推导检查义务
// ─────────────────────────────────────────────────────────────

describe('完成语义收缩', () => {
  it('completed 可以没有 verification claim；completion_criteria 文本不再自动构成检查义务', async () => {
    const { journal } = await openJournal();
    const decision = await validate({
      journal,
      context: {
        completion_criteria: ['pnpm test passes', 'pnpm lint passes'],
      },
    });
    expect(decision.accepted).toBe(true);
    expect(decision.record?.verification).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// verification 事实校验（passed 必须能被宿主观察到）
// ─────────────────────────────────────────────────────────────

describe('verification 事实校验', () => {
  const FINAL_SHA = 'a'.repeat(64);

  it('passed + 真实派工 + host_observed complete exit 0 + 最终指纹一致 → 接受并保留 claim', async () => {
    const { journal } = await openJournal();
    await appendCheckDispatch(journal, [
      hostObservedCheck({ command: HOST_CHECK, exit_code: 0, workspace_sha256: FINAL_SHA }),
    ]);
    const claim = verificationClaim({
      // requirement 是 role 的自由文本：宿主不要求与 completion_criteria 逐字对应。
      requirement: 'unit tests pass on the final workspace',
      dispatch_ids: ['dispatch_checks'],
    });

    const decision = await validate({
      journal,
      context: { completion_criteria: ['the change keeps the suite green'] },
      request: { verification: [claim] },
      current_workspace_sha256: FINAL_SHA,
    });

    expect(decision.accepted).toBe(true);
    expect(decision.record?.verification).toEqual([claim]);
  });

  it('passed 但 dispatch_ids 为空 → evidence_source_insufficient（verification_without_dispatch）', async () => {
    const { journal } = await openJournal();
    const decision = await validate({
      journal,
      request: { verification: [verificationClaim({ requirement: 'tests pass' })] },
      current_workspace_sha256: FINAL_SHA,
    });
    expect(decision.accepted).toBe(false);
    expect(gapCodes(decision)).toContain('evidence_source_insufficient');
    expect(gapDetail(decision, 'evidence_source_insufficient')).toMatchObject({
      reason: 'verification_without_dispatch',
    });
  });

  it('passed 引用 driver_reported 检查 → 拒绝（no_host_observed_check），role 可如实 blocked', async () => {
    const { journal } = await openJournal();
    await appendCheckDispatch(journal, [
      driverReportedCheck({
        command: HOST_CHECK,
        claimed_exit_code: 0,
        observation: 'complete',
      }),
    ]);
    const passed = verificationClaim({ dispatch_ids: ['dispatch_checks'] });

    const rejected = await validate({
      journal,
      request: { verification: [passed] },
      current_workspace_sha256: FINAL_SHA,
    });
    expect(rejected.accepted).toBe(false);
    expect(gapCodes(rejected)).toContain('evidence_source_insufficient');
    expect(gapDetail(rejected, 'evidence_source_insufficient')).toMatchObject({
      reason: 'no_host_observed_check',
    });

    const blocked = await validate({
      journal,
      request: {
        status: 'blocked',
        summary: 'cannot prove the check passed',
        verification: [
          verificationClaim({ requirement: 'tests pass', outcome: 'not_run' }),
        ],
      },
    });
    expect(blocked.accepted).toBe(true);
  });

  it('passed 引用非零退出的 host_observed 检查 → host_observed_check_failed', async () => {
    const { journal } = await openJournal();
    await appendCheckDispatch(journal, [
      hostObservedCheck({ command: HOST_CHECK, exit_code: 1, workspace_sha256: FINAL_SHA }),
    ]);
    const decision = await validate({
      journal,
      request: { verification: [verificationClaim({ dispatch_ids: ['dispatch_checks'] })] },
      current_workspace_sha256: FINAL_SHA,
    });
    expect(decision.accepted).toBe(false);
    expect(gapCodes(decision)).toContain('evidence_source_insufficient');
    expect(gapDetail(decision, 'evidence_source_insufficient')).toMatchObject({
      reason: 'host_observed_check_failed',
      failing_checks: [{ command: HOST_CHECK, exit_code: 1 }],
    });
  });

  it('passed 引用 partial 观察 / 缺最终指纹的检查 → 不算通过', async () => {
    const { journal } = await openJournal();
    await appendCheckDispatch(journal, [
      hostObservedCheck({
        command: HOST_CHECK,
        exit_code: 0,
        observation: 'partial',
        workspace_sha256: FINAL_SHA,
      }),
    ]);
    const claim = verificationClaim({ dispatch_ids: ['dispatch_checks'] });

    const partial = await validate({
      journal,
      request: { verification: [claim] },
      current_workspace_sha256: FINAL_SHA,
    });
    expect(partial.accepted).toBe(false);
    expect(gapCodes(partial)).toContain('evidence_source_insufficient');
    expect(gapDetail(partial, 'evidence_source_insufficient')).toMatchObject({
      reason: 'no_passing_host_observed_check',
    });

    // finish 时算不出最终工作区指纹：无法证明检查适用于最终交付对象。
    const noFingerprint = await validate({ journal, request: { verification: [claim] } });
    expect(noFingerprint.accepted).toBe(false);
    expect(gapDetail(noFingerprint, 'evidence_source_insufficient')).toMatchObject({
      reason: 'final_workspace_fingerprint_unavailable',
    });
  });

  it('passed 引用旧工作区指纹的检查 → evidence_stale（check_evidence_stale）', async () => {
    const { journal } = await openJournal();
    await appendCheckDispatch(journal, [
      hostObservedCheck({
        command: HOST_CHECK,
        exit_code: 0,
        workspace_sha256: 'b'.repeat(64),
      }),
    ]);
    const decision = await validate({
      journal,
      request: { verification: [verificationClaim({ dispatch_ids: ['dispatch_checks'] })] },
      current_workspace_sha256: FINAL_SHA,
    });
    expect(decision.accepted).toBe(false);
    expect(gapCodes(decision)).toContain('evidence_stale');
    expect(gapDetail(decision, 'evidence_stale')).toMatchObject({
      reason: 'check_evidence_stale',
      stale_workspace_sha256: ['b'.repeat(64)],
      current_workspace_sha256: FINAL_SHA,
    });
  });

  it('passed 引用不存在或没有观察证据的 dispatch id → verification_dispatch_unobserved', async () => {
    const { journal } = await openJournal();

    const ghost = await validate({
      journal,
      request: {
        verification: [
          verificationClaim({ requirement: 'tests pass', dispatch_ids: ['dispatch_ghost'] }),
        ],
      },
      current_workspace_sha256: FINAL_SHA,
    });
    expect(ghost.accepted).toBe(false);
    expect(gapCodes(ghost)).toContain('evidence_source_insufficient');
    expect(gapDetail(ghost, 'evidence_source_insufficient')).toMatchObject({
      reason: 'verification_dispatch_unobserved',
      missing_dispatch_ids: ['dispatch_ghost'],
    });

    // 派工存在，但只有 accepted（没有 dispatched/evidence）：同样没有可观察检查。
    const acceptedOnly = await openJournal();
    await appendAcceptedDispatch(acceptedOnly.journal, 'dispatch_accepted', 1);
    const unobserved = await validate({
      journal: acceptedOnly.journal,
      request: {
        verification: [
          verificationClaim({ requirement: 'tests pass', dispatch_ids: ['dispatch_accepted'] }),
        ],
      },
      current_workspace_sha256: FINAL_SHA,
    });
    expect(unobserved.accepted).toBe(false);
    expect(gapDetail(unobserved, 'evidence_source_insufficient')).toMatchObject({
      reason: 'verification_dispatch_unobserved',
      missing_dispatch_ids: ['dispatch_accepted'],
    });
  });

  it('failed/not_run 不要求派工证据即可接受（宿主不替 role 判断语义）', async () => {
    const { journal } = await openJournal();
    const claims = [
      verificationClaim({ requirement: 'lint passes', outcome: 'failed' }),
      verificationClaim({ requirement: 'manual review done', outcome: 'not_run' }),
    ];
    const decision = await validate({ journal, request: { verification: claims } });
    expect(decision.accepted).toBe(true);
    expect(decision.record?.verification).toEqual(claims);
  });
});

// ─────────────────────────────────────────────────────────────
// 只读违规
// ─────────────────────────────────────────────────────────────

describe('只读违规', () => {
  it('拒绝 completed、允许 blocked；校验只读，不写 journal、不自动回滚副作用', async () => {
    const { journal, runDir } = await openJournal();
    await appendAcceptedDispatch(journal, 'dispatch_1', 1, { kind: 'investigate' });
    await journal.appendDispatched({ dispatch_id: 'dispatch_1' });
    await appendSettledDispatch(journal, 'dispatch_1', {
      status: 'failed',
      violations: ['read_only_changed'],
    });

    const journalPath = path.join(runDir, 'journal', 'dispatches.jsonl');
    const before = await readFile(journalPath, 'utf8');
    const completed = await validate({ journal, request: { status: 'completed' } });
    expect(completed.accepted).toBe(false);
    expect(gapCodes(completed)).toContain('read_only_violation');
    expect(
      completed.gaps?.find((entry) => entry.code === 'read_only_violation')?.detail,
    ).toMatchObject({ dispatch_ids: ['dispatch_1'] });
    // 校验不写 journal、也不「回滚」已发生的副作用：字节完全不变。
    expect(await readFile(journalPath, 'utf8')).toBe(before);

    const blocked = await validate({ journal, request: { status: 'blocked' } });
    expect(blocked.accepted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 恢复链祖先事实
// ─────────────────────────────────────────────────────────────

describe('恢复链祖先事实', () => {
  it('祖先只读违规使恢复 Run 的 completed 被拒绝，blocked 仍可收束', async () => {
    const { journal } = await openJournal();
    const inherited = [
      ancestorRecord({ dispatchId: 'dsp_ancestor', violations: ['read_only_changed'] }),
    ];

    const completed = await validate({ journal, inherited_records: inherited });
    expect(completed.accepted).toBe(false);
    expect(gapCodes(completed)).toContain('read_only_violation');

    const blocked = await validate({
      journal,
      request: { status: 'blocked', summary: 'ancestor violated read-only' },
      inherited_records: inherited,
    });
    expect(blocked.accepted).toBe(true);
  });

  it('祖先 verification passed 的检查证据同样按最终指纹判定适用性', async () => {
    const finalSha = 'f'.repeat(64);
    const staleSha = '0'.repeat(64);
    const claim = verificationClaim({
      requirement: 'ancestor verified requirement',
      dispatch_ids: ['dsp_ancestor'],
    });
    const { journal } = await openJournal();

    const valid = await validate({
      journal,
      request: { verification: [claim] },
      current_workspace_sha256: finalSha,
      inherited_records: [
        ancestorRecord({
          dispatchId: 'dsp_ancestor',
          checks: [
            hostObservedCheck({ command: HOST_CHECK, exit_code: 0, workspace_sha256: finalSha }),
          ],
        }),
      ],
    });
    expect(valid.accepted).toBe(true);
    expect(valid.record?.verification).toEqual([claim]);

    const stale = await validate({
      journal,
      request: { verification: [claim] },
      current_workspace_sha256: finalSha,
      inherited_records: [
        ancestorRecord({
          dispatchId: 'dsp_ancestor',
          checks: [
            hostObservedCheck({ command: HOST_CHECK, exit_code: 0, workspace_sha256: staleSha }),
          ],
        }),
      ],
    });
    expect(stale.accepted).toBe(false);
    expect(gapCodes(stale)).toContain('evidence_stale');
  });
});

// ─────────────────────────────────────────────────────────────
// 未决 dispatch 与显式重试收束
// ─────────────────────────────────────────────────────────────

describe('未决 dispatch 与重试收束', () => {
  it('dispatched 无 settled = unknown，拒绝 completed；retry_of + 可信 settled 后允许', async () => {
    const { journal } = await openJournal();
    await appendAcceptedDispatch(journal, 'dispatch_1', 1);
    await journal.appendDispatched({ dispatch_id: 'dispatch_1' });

    const unresolved = await validate({ journal, request: { status: 'completed' } });
    expect(unresolved.accepted).toBe(false);
    expect(gapCodes(unresolved)).toContain('unresolved_dispatch');
    expect(
      unresolved.gaps?.find((entry) => entry.code === 'unresolved_dispatch')?.detail,
    ).toMatchObject({ dispatch_ids: ['dispatch_1'] });

    // blocked 是 role 对 unknown 的合法收束。
    expect((await validate({ journal, request: { status: 'blocked' } })).accepted).toBe(true);

    // 显式重试：新 dispatch_id + retry_of + 已登记 reconciliation_ref（journal 强制要求）。
    const reconciliationRef: EvidenceRef = {
      path: 'journal/evidence/reconcile-1.json',
      sha256: 'c'.repeat(64),
    };
    await journal.registerEvidenceRef(reconciliationRef);
    await appendAcceptedDispatch(journal, 'dispatch_2', 2, {
      retryOf: 'dispatch_1',
      reconciliationRef,
    });
    await journal.appendDispatched({ dispatch_id: 'dispatch_2' });

    // 重试尚未 settled：unknown 仍未收束。
    const stillUnresolved = await validate({ journal, request: { status: 'completed' } });
    expect(gapCodes(stillUnresolved)).toContain('unresolved_dispatch');

    await appendSettledDispatch(journal, 'dispatch_2');
    const resolved = await validate({ journal, request: { status: 'completed' } });
    expect(resolved.accepted).toBe(true);
  });

  it('重试链传递收束：unknown → 重试（仍 unknown）→ 链尾可信 settled 后允许 completed', async () => {
    const { journal } = await openJournal();
    await appendAcceptedDispatch(journal, 'dispatch_1', 1);
    await journal.appendDispatched({ dispatch_id: 'dispatch_1' });

    const reconciliationRef1: EvidenceRef = {
      path: 'journal/evidence/reconcile-1.json',
      sha256: 'c'.repeat(64),
    };
    await journal.registerEvidenceRef(reconciliationRef1);
    await appendAcceptedDispatch(journal, 'dispatch_2', 2, {
      retryOf: 'dispatch_1',
      reconciliationRef: reconciliationRef1,
    });
    await journal.appendDispatched({ dispatch_id: 'dispatch_2' });

    const reconciliationRef2: EvidenceRef = {
      path: 'journal/evidence/reconcile-2.json',
      sha256: 'e'.repeat(64),
    };
    await journal.registerEvidenceRef(reconciliationRef2);
    await appendAcceptedDispatch(journal, 'dispatch_3', 3, {
      retryOf: 'dispatch_2',
      reconciliationRef: reconciliationRef2,
    });
    await journal.appendDispatched({ dispatch_id: 'dispatch_3' });

    // 链尾尚未 settled：整条 unknown 链仍未收束。
    const before = await validate({ journal, request: { status: 'completed' } });
    expect(before.accepted).toBe(false);
    expect(gapCodes(before)).toContain('unresolved_dispatch');

    await appendSettledDispatch(journal, 'dispatch_3');
    const after = await validate({ journal, request: { status: 'completed' } });
    expect(after.accepted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 取消与预算触限
// ─────────────────────────────────────────────────────────────

describe('取消与预算', () => {
  it('取消中拒绝 finish；token 越界/墙钟过期拒绝 completed，但不惩罚 blocked 收束', async () => {
    const { journal } = await openJournal();

    const cancelled = await validate({ journal, cancelled: true });
    expect(cancelled.accepted).toBe(false);
    expect(gapCodes(cancelled)).toContain('cancelled');

    const overTokens = makeBudget(
      { role_token_budget: 100 },
      { dispatches: 0, role_rounds: 0, tokens: 150, tool_calls: 0, tokens_missing: false },
    );
    const tokenGap = await validate({ journal, budget: overTokens });
    expect(tokenGap.accepted).toBe(false);
    expect(gapCodes(tokenGap)).toContain('budget_exhausted');

    // 墙钟按注入的 now 现算：deadline（2026-11-13T12:45Z）已过 → budget_exhausted。
    const wallClockGap = await validate({
      journal,
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(gapCodes(wallClockGap)).toContain('budget_exhausted');

    const blocked = await validate({
      journal,
      request: { status: 'blocked' },
      budget: overTokens,
    });
    expect(blocked.accepted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// response_only
// ─────────────────────────────────────────────────────────────

describe('response_only', () => {
  it('任务允许且零派工时支撑 completed；未允许/已有非只读派工时冲突', async () => {
    const { journal } = await openJournal();

    const accepted = await validate({
      journal,
      context: { response_only_allowed: true },
      request: { response_only: true, summary: 'answer only, no code change' },
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.record?.response_only).toBe(true);

    const notAllowed = await validate({ journal, request: { response_only: true } });
    expect(gapCodes(notAllowed)).toContain('response_only_conflict');

    // completion_criteria 文本不再向宿主注入检查义务：不再有「与 host 检查冲突」分支。
    const withCriteria = await validate({
      journal,
      context: {
        response_only_allowed: true,
        completion_criteria: ['pnpm test passes'],
      },
      request: { response_only: true },
    });
    expect(withCriteria.accepted).toBe(true);

    const writeJournal = await openJournal();
    await appendFullDispatch(writeJournal.journal, 'dispatch_w', 1);
    const conflict = await validate({
      journal: writeJournal.journal,
      context: { response_only_allowed: true },
      request: { response_only: true },
    });
    expect(conflict.accepted).toBe(false);
    expect(gapCodes(conflict)).toContain('response_only_conflict');
    expect(
      conflict.gaps?.find((entry) => entry.code === 'response_only_conflict')?.detail,
    ).toMatchObject({ dispatch_ids: ['dispatch_w'] });
  });
});

// ─────────────────────────────────────────────────────────────
// journal 故障转 gap（异常不外抛给 role）
// ─────────────────────────────────────────────────────────────

describe('journal 故障转 gap', () => {
  it('readEvidence 抛错 → journal_unavailable gap，不把异常抛给 role', async () => {
    const journal = createFakeJournal({
      readEvidence: async () => {
        throw new Error('evidence storage is gone');
      },
    });
    const decision = await validate({
      journal,
      request: {
        evidence_refs: [{ path: 'journal/evidence/x.json', sha256: 'a'.repeat(64) }],
      },
    });
    expect(decision.accepted).toBe(false);
    expect(gapCodes(decision)).toContain('journal_unavailable');
  });

  it('fold 抛错（journal 损坏/半写）→ journal_unavailable gap', async () => {
    const journal = createFakeJournal({
      fold: async () => {
        throw new Error('journal has a half-written tail');
      },
    });
    const decision = await validate({ journal });
    expect(decision.accepted).toBe(false);
    expect(gapCodes(decision)).toContain('journal_unavailable');
  });
});

// ─────────────────────────────────────────────────────────────
// finish 持久化（唯一生产落盘点 persistRoleFinish）
// ─────────────────────────────────────────────────────────────

describe('finish 持久化', () => {
  it('写 finish 控制行（actor=role、verification 落盘、无退役 checks），重复持久化幂等', async () => {
    const { journal } = await openJournal();
    const finalSha = 'a'.repeat(64);
    await appendCheckDispatch(journal, [
      hostObservedCheck({ command: HOST_CHECK, exit_code: 0, workspace_sha256: finalSha }),
    ]);
    const claim = verificationClaim({
      requirement: 'unit tests pass',
      dispatch_ids: ['dispatch_checks'],
      note: 'observed exit 0 on the final workspace',
    });
    const decision = await validate({
      journal,
      request: {
        verification: [claim],
        summary: 'done',
        role_reflection: 'reflected',
      },
      current_workspace_sha256: finalSha,
    });
    expect(decision.accepted).toBe(true);
    const record = decision.record;
    if (record === undefined) throw new Error('expected accepted finish record');

    await persistRoleFinish({ journal, record, zero_dispatch: false });
    const finish = (await journal.fold()).finish;
    expect(finish?.event).toBe('finish');
    expect(finish?.actor).toBe('role');
    expect(finish?.status).toBe('completed');
    expect(finish?.summary).toBe('done');
    expect(finish?.role_reflection).toBe('reflected');
    expect(finish?.zero_dispatch).toBe(false);
    expect(finish?.at).toBe(record.accepted_at);
    expect(finish?.verification).toEqual([claim]);
    // 已退役的「完成要求 → 宿主命令」映射不再写入。
    expect(finish).not.toHaveProperty('checks');

    // 同一记录重复持久化是幂等写重试。
    await expect(
      persistRoleFinish({ journal, record, zero_dispatch: false }),
    ).resolves.toBeUndefined();

    // finish 只接受一次：已写 finish 后再次校验直接给 finish_already_accepted。
    const again = await validate({ journal });
    expect(again.accepted).toBe(false);
    expect(gapCodes(again)).toContain('finish_already_accepted');
  });

  it('zero_dispatch 由调用方显式给出，persistRoleFinish 不再二次推断', async () => {
    const empty = await openJournal();
    await persistRoleFinish({ journal: empty.journal, record: makeRecord(), zero_dispatch: false });
    expect((await empty.journal.fold()).finish?.zero_dispatch).toBe(false);

    const withDispatch = await openJournal();
    await appendFullDispatch(withDispatch.journal, 'dispatch_1', 1);
    await persistRoleFinish({
      journal: withDispatch.journal,
      record: makeRecord(),
      zero_dispatch: true,
    });
    expect((await withDispatch.journal.fold()).finish?.zero_dispatch).toBe(true);
  });

  it('appendFinish 写失败 → journal_write_failed（host）；内容冲突不覆盖既有 finish', async () => {
    const writeFailure = createFakeJournal({
      appendFinish: async () => {
        throw new Error('io error');
      },
    });
    try {
      await persistRoleFinish({ journal: writeFailure, record: makeRecord(), zero_dispatch: true });
      expect.unreachable('finish write failure must terminate');
    } catch (error) {
      expectTermination(error, 'journal_write_failed', 'host');
    }

    // 真实 journal：第二份内容不同的 finish 被 fail closed，既有 finish 不被覆盖。
    const { journal } = await openJournal();
    const first = makeRecord({ summary: 'first' });
    await persistRoleFinish({ journal, record: first, zero_dispatch: true });
    try {
      await persistRoleFinish({
        journal,
        record: makeRecord({ summary: 'second' }),
        zero_dispatch: true,
      });
      expect.unreachable('conflicting finish must terminate');
    } catch (error) {
      expectTermination(error, 'journal_write_failed', 'host');
    }
    expect((await journal.fold()).finish?.summary).toBe('first');
  });
});
