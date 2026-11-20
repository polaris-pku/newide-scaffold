/**
 * Role loop 与工具测试共用的内存夹具。
 * 记录真实调用顺序与写入参数，支持证据读取、派工结果及写屏障故障；不替代真实 Journal 集成测试。
 * 各测试保留自身预算/LLM 脚本，避免将不同的预算行为塞进同一个替身。
 */
import type {
  DispatchRecord,
  EvidenceRef,
  ExecutionBrief,
  ExecutionEvidence,
  ExecutionStatus,
} from '../../src/driver';
import {
  buildExecutionEvidence,
  DispatchJournalBarrierError,
  DispatchRecordSchema,
  hashExecutionBrief,
  hashExecutionEvidence,
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
import { RunDispatchJournalError } from '../../src/persistence';
import type {
  RoleDispatchInput,
  RoleDispatchObservation,
  RoleDispatchPort,
  RoleFinishDecision,
  RoleFinishRecord,
  RoleFinishValidatorInput,
  RoleFinishValidatorPort,
  RoleJournalPort,
  RoleMemoryPort,
  RoleMemoryQueryInput,
  RoleMemoryQueryResult,
  RoleMemoryRecall,
  RoleMemoryRecallInput,
} from '../../src/app/role-autonomy-contract';

const roleTestClock = (): Date => new Date('2026-11-13T20:00:00.000Z');

export class FakeJournal implements RoleJournalPort {
  records: DispatchRecord[] = [];
  readonly roleRounds: RoleRoundAppendInput[] = [];
  readonly finishInputs: JournalFinishAppendInput[] = [];
  readonly evidenceFiles = new Map<string, { text: string; sha256: string }>();
  init: JournalInitAppendInput | undefined;
  failAppendFinish: Error | undefined;

  async read(): Promise<DispatchJournalReadResult> {
    return {
      kind: 'journal',
      status: 'ok',
      lines: [],
      entries: [],
      controls: [],
      repairs: [],
      problems: [],
      durability: { mode: 'fsync', directory_sync: true, notes: [] },
    };
  }

  async fold(): Promise<DispatchJournalFoldResult> {
    return {
      records: this.records,
      byDispatchId: new Map(this.records.map((record) => [record.dispatch_id, record])),
      init: undefined,
      finish: undefined,
      repairs: [],
      entry_count: this.records.length,
    };
  }

  async appendInit(input: JournalInitAppendInput): Promise<void> {
    this.init = input;
  }

  async appendFinish(input: JournalFinishAppendInput): Promise<void> {
    if (this.failAppendFinish !== undefined) throw this.failAppendFinish;
    this.finishInputs.push(input);
  }

  async appendRoleRound(input: RoleRoundAppendInput): Promise<void> {
    this.roleRounds.push(input);
  }

  async registerEvidenceRef(ref: EvidenceRef): Promise<void> {
    const existing = this.evidenceFiles.get(ref.path);
    if (existing !== undefined && existing.sha256 !== ref.sha256) {
      throw new RunDispatchJournalError('evidence_ref_conflict', 'conflicting sha');
    }
  }

  async readEvidence(
    ref: EvidenceRef,
    options: ReadDispatchEvidenceOptions = {},
  ): Promise<DispatchJournalEvidencePage> {
    const file = this.evidenceFiles.get(ref.path);
    if (file === undefined) {
      throw new RunDispatchJournalError('evidence_ref_not_registered', 'evidence not registered');
    }
    if (file.sha256 !== ref.sha256) {
      throw new RunDispatchJournalError('evidence_hash_mismatch', 'evidence hash mismatch');
    }
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 4_096;
    return {
      text: file.text.slice(offset, offset + limit),
      offset,
      limit,
      total_bytes: file.text.length,
      truncated: offset + limit < file.text.length,
      sha256: file.sha256,
    };
  }

  async getDispatchRecord(dispatchId: string): Promise<DispatchRecord | undefined> {
    return this.records.find((record) => record.dispatch_id === dispatchId);
  }
}

export class FakeMemory implements RoleMemoryPort {
  readonly recallCalls: RoleMemoryRecallInput[] = [];
  readonly queryCalls: RoleMemoryQueryInput[] = [];
  recallText = 'RECALLED: use the existing helper';
  failQuery = false;

  async recall(input: RoleMemoryRecallInput): Promise<RoleMemoryRecall> {
    this.recallCalls.push(input);
    return { text: this.recallText };
  }

  async query(input: RoleMemoryQueryInput): Promise<RoleMemoryQueryResult> {
    this.queryCalls.push(input);
    if (this.failQuery) throw new Error('memory backend down');
    return { text: `memory:${input.query}`, count: 1 };
  }
}

export type BarrierStage = 'accepted' | 'dispatched' | 'evidence' | 'settled';

function makeEvidence(dispatchId: string, status: ExecutionStatus): ExecutionEvidence {
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

function makeRecord(
  brief: ExecutionBrief,
  status: ExecutionStatus,
  evidence: ExecutionEvidence,
  evidenceSha256: string,
): DispatchRecord {
  return DispatchRecordSchema.parse({
    schema_version: 'newide.dispatch_record.v1',
    dispatch_id: brief.dispatch_id,
    run_id: brief.run_id,
    task_id: brief.task_id,
    role_id: brief.role_id,
    sequence: brief.sequence,
    phase: 'settled',
    status,
    brief,
    brief_sha256: hashExecutionBrief(brief),
    evidence,
    evidence_sha256: evidenceSha256,
    violations: [],
    accepted_at: brief.accepted_at,
    dispatched_at: brief.accepted_at,
    settled_at: brief.accepted_at,
  });
}

export class FakeDispatchPort implements RoleDispatchPort {
  readonly calls: RoleDispatchInput[] = [];
  readonly statuses: ExecutionStatus[];
  readonly barrierStages: BarrierStage[];
  maxActive = 0;
  private active = 0;

  constructor(
    private readonly journal: FakeJournal,
    statuses: ExecutionStatus[] = [],
    barrierStages: BarrierStage[] = [],
  ) {
    this.statuses = [...statuses];
    this.barrierStages = [...barrierStages];
  }

  async run(input: RoleDispatchInput): Promise<RoleDispatchObservation> {
    this.calls.push(input);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      // accepted/dispatched 已 durable、Driver 尚未开始：阶段 1 的准入释放点。
      input.on_dispatched?.();
      // 让「并行执行」在这里暴露：串行时 maxActive 恒为 1。
      await Promise.resolve();
      const barrierStage = this.barrierStages.shift();
      if (barrierStage !== undefined) {
        const driverInvoked = barrierStage === 'evidence' || barrierStage === 'settled';
        throw new DispatchJournalBarrierError(
          barrierStage,
          input.brief.dispatch_id,
          driverInvoked,
          driverInvoked ? 'unknown' : 'not_executed',
        );
      }
      const status = this.statuses.shift() ?? 'succeeded';
      const evidence = makeEvidence(input.brief.dispatch_id, status);
      const evidenceSha256 = hashExecutionEvidence(evidence);
      const ref: EvidenceRef = {
        path: `journal/evidence/${input.brief.dispatch_id}.json`,
        sha256: evidenceSha256,
      };
      this.journal.evidenceFiles.set(ref.path, {
        text: JSON.stringify(evidence),
        sha256: evidenceSha256,
      });
      this.journal.records.push(makeRecord(input.brief, status, evidence, evidenceSha256));
      return {
        dispatch_id: input.brief.dispatch_id,
        status,
        evidence,
        evidence_ref: ref,
        evidence_sha256: evidenceSha256,
        violations: [],
        attempts: 1,
      };
    } finally {
      this.active -= 1;
    }
  }
}

function makeFinishRecord(input: RoleFinishValidatorInput): RoleFinishRecord {
  return {
    status: input.request.status,
    summary: input.request.summary,
    evidence_refs: input.request.evidence_refs,
    unresolved: input.request.unresolved,
    role_reflection: input.request.role_reflection,
    response_only: input.request.response_only ?? false,
    verification: (input.request.verification ?? []).map((claim) => ({
      ...claim,
      dispatch_ids: [...claim.dispatch_ids],
      evidence_refs: [...claim.evidence_refs],
    })),
    accepted_at: (input.now ?? roleTestClock()).toISOString(),
  };
}

export class FakeFinishValidator implements RoleFinishValidatorPort {
  readonly inputs: RoleFinishValidatorInput[] = [];
  private readonly decisions: RoleFinishDecision[];

  constructor(decisions: RoleFinishDecision[] = []) {
    this.decisions = [...decisions];
  }

  async validate(input: RoleFinishValidatorInput): Promise<RoleFinishDecision> {
    this.inputs.push(input);
    const scripted = this.decisions.shift();
    if (scripted !== undefined) return scripted;
    return { accepted: true, record: makeFinishRecord(input) };
  }
}
