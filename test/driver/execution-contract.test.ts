/**
 * 执行契约（阶段 1）单元/契约测试：
 * - DIS-01 kind 与只读语义；
 * - DIS-02 宿主身份不可伪造、非法 brief 拒绝、hash 可重算；
 * - DIS-03 Session fresh/reuse 的归属与确认校验；
 * - EVD-01 五态 evidence / unknown 与 not_executed 的区分；
 * - EVD-02 runner 退出码不得冒充检查退出码、driver 自述只是 driver_reported；
 * - EVD-04 workspace coverage 如实、usage 缺失记 missing 不填 0。
 */
import { describe, expect, it } from 'vitest';
import {
  buildExecutionBrief,
  buildExecutionEvidence,
  canonicalJsonStringify,
  DispatchAcceptedJournalEntrySchema,
  driverReportedCheck,
  ExecutionBriefSchema,
  ExecutionContractViolation,
  ExecutionEvidenceSchema,
  hashExecutionBrief,
  hostObservedCheck,
  normalizeDriverUsage,
  normalizeReadOnlyForKind,
  verifyExecutionBrief,
  type BuildExecutionEvidenceInput,
  type DriverAttemptObservation,
  type ExecutionKind,
} from '../../src/driver/execution-contract';

const IDENTITY = {
  dispatch_id: 'dsp_0001',
  task_id: 'task_0001',
  run_id: 'run_0001',
  role_id: 'role_impl',
  sequence: 1,
  accepted_at: '2026-11-13T05:00:00.000Z',
};

function build(
  request: Record<string, unknown>,
  overrides: Partial<typeof IDENTITY> = {},
  confirmedSessions: Parameters<typeof buildExecutionBrief>[0]['confirmed_sessions'] = [],
) {
  return buildExecutionBrief({
    identity: { ...IDENTITY, ...overrides },
    request,
    confirmed_sessions: confirmedSessions,
  });
}

function makeEvidence(observation: DriverAttemptObservation, dispatchId = 'dsp_0001') {
  const input: BuildExecutionEvidenceInput = {
    dispatch_id: dispatchId,
    observation,
    evidence_id: 'evd_0001',
  };
  return buildExecutionEvidence(input);
}

describe('DIS-01 kind 与只读约束', () => {
  it('只接受 investigate / execute / verify 三种 kind', () => {
    for (const kind of ['investigate', 'execute', 'verify'] as const) {
      expect(() => build({ kind, instruction: 'x' })).not.toThrow();
    }
    expect(() => build({ kind: 'plan', instruction: 'x' })).toThrow();
  });

  it('investigate 强制只读；role 显式 read_only:false 被拒绝而不是悄悄改写', () => {
    expect(normalizeReadOnlyForKind('investigate', undefined)).toBe(true);
    expect(() => normalizeReadOnlyForKind('investigate', false)).toThrow(
      ExecutionContractViolation,
    );
    expect(() => build({ kind: 'investigate', instruction: 'x', read_only: false })).toThrow(
      /read-only/i,
    );
    expect(build({ kind: 'investigate', instruction: 'x' }).brief.read_only).toBe(true);
  });

  it('execute 必然是写；声明只读被拒绝', () => {
    expect(normalizeReadOnlyForKind('execute', undefined)).toBe(false);
    expect(() => build({ kind: 'execute', instruction: 'x', read_only: true })).toThrow(
      /read-only/i,
    );
  });

  it('verify 缺省只读；写测试缓存必须显式 read_only:false', () => {
    expect(normalizeReadOnlyForKind('verify', undefined)).toBe(true);
    expect(build({ kind: 'verify', instruction: 'run tests' }).brief.read_only).toBe(true);
    expect(
      build({ kind: 'verify', instruction: 'run tests', read_only: false }).brief.read_only,
    ).toBe(false);
  });
});

describe('DIS-02 宿主身份不可伪造 / brief 校验', () => {
  it.each([
    'dispatch_id',
    'task_id',
    'run_id',
    'role_id',
    'sequence',
    'accepted_at',
    'brief_sha256',
    'budget_before',
  ])('role 请求带宿主身份键 %s 时拒绝', (key) => {
    const request = { kind: 'execute', instruction: 'x', [key]: key === 'sequence' ? 9 : 'forged' };
    let error: unknown;
    try {
      build(request);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ExecutionContractViolation);
    expect((error as ExecutionContractViolation).code).toBe('role_supplied_host_identity');
  });

  it('宿主身份只来自宿主：role 无法覆盖 dispatch/run/role/sequence', () => {
    const { brief } = build({ kind: 'execute', instruction: '实现修复' });
    expect(brief.dispatch_id).toBe(IDENTITY.dispatch_id);
    expect(brief.run_id).toBe(IDENTITY.run_id);
    expect(brief.task_id).toBe(IDENTITY.task_id);
    expect(brief.role_id).toBe(IDENTITY.role_id);
    expect(brief.sequence).toBe(1);
    expect(brief.accepted_at).toBe(IDENTITY.accepted_at);
  });

  it('空 instruction、超长 instruction、未知键都拒绝', () => {
    expect(() => build({ kind: 'execute', instruction: '   ' })).toThrow(/brief request/i);
    expect(() => build({ kind: 'execute', instruction: 'x'.repeat(24_001) })).toThrow();
    expect(() => build({ kind: 'execute', instruction: 'x', surprise: true })).toThrow();
  });

  it('brief hash 可重算；重算不一致时 fail closed', () => {
    const first = build({ kind: 'execute', instruction: 'x' });
    const second = build({ kind: 'execute', instruction: 'x' });
    expect(first.brief_sha256).toBe(second.brief_sha256);
    expect(first.brief_sha256).toBe(hashExecutionBrief(first.brief));
    verifyExecutionBrief(first.brief, first.brief_sha256);
    expect(() => verifyExecutionBrief(first.brief, 'a'.repeat(64))).toThrow(/hash mismatch/i);
  });

  it('canonical JSON 与键序无关，所以 hash 稳定', () => {
    expect(canonicalJsonStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      canonicalJsonStringify({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
  });
});

describe('DIS-03 Session fresh/reuse 的宿主确认', () => {
  it('默认 fresh，且 fresh 不允许夹带 session_id', () => {
    expect(build({ kind: 'execute', instruction: 'x' }).brief.session).toEqual({ mode: 'fresh' });
    expect(() =>
      build({ kind: 'execute', instruction: 'x', session: { mode: 'fresh', session_id: 's_1' } }),
    ).toThrow();
  });

  it('reuse 必须带 session_id', () => {
    expect(() => build({ kind: 'execute', instruction: 'x', session: { mode: 'reuse' } })).toThrow();
  });

  it('未确认 / 跨 role / 跨 Run 的 Session 一律拒绝', () => {
    const request = {
      kind: 'execute' as const,
      instruction: 'x',
      session: { mode: 'reuse' as const, session_id: 'sess_1' },
    };
    for (const sessions of [
      [],
      [{ session_id: 'sess_1', run_id: 'run_0001', role_id: 'role_other' }],
      [{ session_id: 'sess_1', run_id: 'run_other', role_id: 'role_impl' }],
      [{ session_id: 'sess_other', run_id: 'run_0001', role_id: 'role_impl' }],
    ]) {
      let error: unknown;
      try {
        build(request, {}, sessions);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ExecutionContractViolation);
      expect((error as ExecutionContractViolation).code).toBe('session_reuse_unconfirmed');
    }
  });

  it('本 role/run 已确认的 Session 才允许 reuse', () => {
    const built = build(
      { kind: 'execute', instruction: 'x', session: { mode: 'reuse', session_id: 'sess_1' } },
      {},
      [{ session_id: 'sess_1', run_id: 'run_0001', role_id: 'role_impl' }],
    );
    expect(built.brief.session).toEqual({ mode: 'reuse', session_id: 'sess_1' });
  });
});

describe('EVD-01 evidence 五态与 unknown 边界', () => {
  it('transport=execution_unconfirmed 且无结果 → unknown（不是 failed、不是未执行）', () => {
    const evidence = makeEvidence({ transport: { evidence: 'execution_unconfirmed' } });
    expect(evidence.status).toBe('unknown');
    expect(evidence.transport).toEqual({
      evidence: 'execution_unconfirmed',
      result_received: false,
    });
  });

  it('transport=not_executed 是明确证据 → failed，而不是 unknown', () => {
    const evidence = makeEvidence({ transport: { evidence: 'not_executed' } });
    expect(evidence.status).toBe('failed');
    expect(evidence.transport.evidence).toBe('not_executed');
    expect(evidence.transport.result_received).toBe(false);
    expect(evidence.error?.code).toBe('DRIVER_FAILED_WITHOUT_ERROR');
  });

  it('succeeded 必须收到结果；unknown 允许「已收到结果但结局不明」', () => {
    const succeeded = makeEvidence({
      transport: { evidence: 'execution_unconfirmed', result_received: true },
      result: { status: 'succeeded' },
    });
    expect(succeeded.status).toBe('succeeded');
    expect(succeeded.transport.result_received).toBe(true);

    // 真实 ADP：driver 返回 failed + EXTERNAL_DRIVER_TRANSPORT_ERROR → status=unknown，
    // 但 DriverRunResult 确实已收到：unknown + true + execution_unconfirmed 合法。
    const unknownReceived = makeEvidence({
      transport: { evidence: 'execution_unconfirmed' },
      result: { status: 'failed' },
      adp_receipt: { status: 'unknown', result_received: true },
    });
    expect(unknownReceived.status).toBe('unknown');
    expect(unknownReceived.transport).toEqual({
      evidence: 'execution_unconfirmed',
      result_received: true,
    });
    // unknown 的副作用不确定语义不变：不是 failed，也不能据此自动重放。
    expect(unknownReceived.status).not.toBe('failed');
  });

  it('unknown + not_executed 仍是矛盾组合（未执行不可能有结果）', () => {
    expect(() =>
      ExecutionEvidenceSchema.parse({
        ...makeEvidence({ transport: { evidence: 'execution_unconfirmed' } }),
        status: 'unknown',
        transport: { evidence: 'not_executed', result_received: false },
      }),
    ).toThrow(/not_executed/i);
  });

  it('拒绝 not_executed + result_received 的矛盾组合', () => {
    expect(() =>
      ExecutionEvidenceSchema.parse({
        ...makeEvidence({ transport: { evidence: 'execution_unconfirmed' } }),
        transport: { evidence: 'not_executed', result_received: true },
      }),
    ).toThrow();
  });
});

describe('EVD-02 runner 退出码与 driver 自述的证据等级', () => {
  it('runner exit 0 + 无命令结果不得标检查通过', () => {
    const evidence = makeEvidence({
      transport: { evidence: 'execution_unconfirmed', runner_exit_code: 0 },
      result: { status: 'succeeded', response: 'all tests passed' },
    });
    expect(evidence.checks).toEqual([]);
    expect(evidence.transport.runner_exit_code).toBe(0);
    // runner 退码只出现在 transport，不在任何 check 里。
    expect(JSON.stringify(evidence.checks)).not.toContain('exit_code');
  });

  it('driver 回复的「通过」只算 driver_reported，且缺原始观察时 observation=missing', () => {
    const check = driverReportedCheck({ command: 'pnpm test' });
    expect(check.provenance).toBe('driver_reported');
    expect(check.observation).toBe('missing');
    expect(check.exit_code).toBeUndefined();
  });

  it('host 没有取回退码/原始输出时不能伪造 host_observed', () => {
    expect(() => hostObservedCheck({ command: 'pnpm test' })).toThrow();
    const observed = hostObservedCheck({
      command: 'pnpm test',
      exit_code: 0,
      stdout_ref: { path: 'journal/evidence/dsp_0001.out', sha256: 'b'.repeat(64) },
    });
    expect(observed.provenance).toBe('host_observed');
    expect(observed.observation).toBe('complete');
  });

  it('failed evidence 必须带 error；succeeded 不得带 error', () => {
    const succeeded = makeEvidence({
      transport: { evidence: 'execution_unconfirmed', result_received: true },
      result: { status: 'succeeded' },
    });
    expect(() =>
      ExecutionEvidenceSchema.parse({
        ...succeeded,
        error: { code: 'X', message: 'x', retryable: false },
      }),
    ).toThrow(/must not carry an error/i);
  });
});

describe('EVD-04 workspace coverage 与 usage missing 语义', () => {
  it('usage 缺失记 missing + source none，不填 0', () => {
    const usage = normalizeDriverUsage(undefined);
    expect(usage).toEqual({ missing: true, source: 'none' });
    expect(JSON.stringify(usage)).not.toContain('0');
    const evidence = makeEvidence({
      transport: { evidence: 'execution_unconfirmed' },
      usage: null,
    });
    expect(evidence.usage.missing).toBe(true);
    expect(evidence.usage.input_tokens).toBeUndefined();
  });

  it('usage 有值时来源正确；非法数字按缺失丢弃而不是伪造数字', () => {
    expect(normalizeDriverUsage({ input_tokens: 12, output_tokens: 7 })).toEqual({
      input_tokens: 12,
      output_tokens: 7,
      missing: false,
      source: 'driver_result',
    });
    expect(
      normalizeDriverUsage({ input_tokens: -1, output_tokens: 2.5, total_tokens: Number.NaN }),
    ).toEqual({ missing: true, source: 'none' });
  });

  it('workspace_delta 只接受如实的三档 coverage', () => {
    const evidence = makeEvidence({
      transport: { evidence: 'execution_unconfirmed' },
      workspace_delta: { changed_paths: ['src/a.ts'], coverage: 'partial' },
    });
    expect(evidence.workspace_delta?.coverage).toBe('partial');
    expect(() =>
      ExecutionEvidenceSchema.parse({
        ...evidence,
        workspace_delta: { changed_paths: [], coverage: 'isolated' },
      }),
    ).toThrow();
  });
});

describe('Journal 行 schema 的最小闭环（与 persistence 共用）', () => {
  it('accepted 行接受宿主构造的 brief，并拒绝被篡改的 brief hash', () => {
    const { brief, brief_sha256 } = build({ kind: 'execute', instruction: 'x' });
    const line = {
      schema_version: 'newide.dispatch_journal_entry.v1',
      event: 'accepted',
      entry_id: 'entry_1',
      dispatch_id: brief.dispatch_id,
      run_id: brief.run_id,
      task_id: brief.task_id,
      role_id: brief.role_id,
      sequence: brief.sequence,
      at: brief.accepted_at,
      brief,
      brief_sha256,
      budget_before: {
        dispatches_left: 11,
        role_tokens_left: 120_000,
        deadline_at: '2026-11-13T05:45:00.000Z',
      },
    };
    expect(() => DispatchAcceptedJournalEntrySchema.parse(line)).not.toThrow();
    expect(() =>
      DispatchAcceptedJournalEntrySchema.parse({ ...line, brief_sha256: 'c'.repeat(64) }),
    ).toThrow(/brief_sha256/i);
  });

  it('brief schema 拒绝 identity 与 brief 内容不一致的 kind 组合（investigate 非只读）', () => {
    const { brief } = build({ kind: 'investigate', instruction: 'x' });
    expect(() => ExecutionBriefSchema.parse({ ...brief, read_only: false })).toThrow(/read-only/i);
  });
});

describe('kind 类型导出可用', () => {
  it('ExecutionKind 覆盖三种意图', () => {
    const kinds: ExecutionKind[] = ['investigate', 'execute', 'verify'];
    expect(kinds).toHaveLength(3);
  });
});

describe('transport.result_received 与 transport.evidence 正交（审核修复 #5）', () => {
  it('启动失败：failed / result_received=false / not_executed（不得被非 unknown 状态改成 true）', () => {
    const evidence = makeEvidence({
      transport: { evidence: 'not_executed' },
      adp_receipt: { status: 'failed', result_received: false },
      error: { code: 'DRIVER_START_FAILED', message: 'spawn failed', retryable: false },
    });
    expect(evidence.status).toBe('failed');
    expect(evidence.transport).toEqual({
      evidence: 'not_executed',
      result_received: false,
    });
  });

  it('执行结果已收到：succeeded / result_received=true / execution_unconfirmed', () => {
    const evidence = makeEvidence({
      transport: { evidence: 'execution_unconfirmed' },
      result: { status: 'succeeded', response: 'done' },
    });
    expect(evidence.status).toBe('succeeded');
    expect(evidence.transport).toMatchObject({
      evidence: 'execution_unconfirmed',
      result_received: true,
    });
  });

  it('无可信结果：unknown / result_received=false / execution_unconfirmed', () => {
    const evidence = makeEvidence({
      transport: { evidence: 'execution_unconfirmed' },
      adp_receipt: { status: 'unknown', result_received: false },
    });
    expect(evidence.status).toBe('unknown');
    expect(evidence.transport).toMatchObject({
      evidence: 'execution_unconfirmed',
      result_received: false,
    });
  });

  it('取消（明确未执行）与超时（结果不明）分别保留两字段真实含义', () => {
    const cancelled = makeEvidence({
      transport: { evidence: 'not_executed' },
      adp_receipt: { status: 'cancelled', result_received: false },
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.transport).toMatchObject({
      evidence: 'not_executed',
      result_received: false,
    });

    const timedOut = makeEvidence({
      transport: { evidence: 'execution_unconfirmed', signal: 'SIGTERM' },
      adp_receipt: { status: 'unknown', result_received: false },
    });
    expect(timedOut.status).toBe('unknown');
    expect(timedOut.transport).toMatchObject({
      evidence: 'execution_unconfirmed',
      result_received: false,
    });
  });

  it.each([
    [
      'receipt succeeded 却没有收到结果',
      {
        transport: { evidence: 'execution_unconfirmed' as const },
        adp_receipt: { status: 'succeeded' as const, result_received: false },
      },
    ],
    [
      '本地 result 与 not_executed 矛盾',
      {
        transport: { evidence: 'not_executed' as const },
        result: { status: 'succeeded' as const },
      },
    ],
    [
      'failed 无结果却只有未确认 transport',
      {
        transport: { evidence: 'execution_unconfirmed' as const },
        adp_receipt: { status: 'failed' as const, result_received: false },
      },
    ],
    [
      'missing 标记与已收到结果矛盾',
      {
        transport: { evidence: 'execution_unconfirmed' as const },
        result: { status: 'succeeded' as const },
        adp_receipt: {
          status: 'unknown' as const,
          result_received: true,
          result_received_missing: true,
        },
      },
    ],
  ])('矛盾输入 %s → fail closed（evidence_inconsistent）', (_label, observation) => {
    expect(() => makeEvidence(observation)).toThrow(/evidence|contradict|requires|claim|cannot/i);
  });

  it('旧数据缺少 result_received 事实 → 显式 missing，不凭空声称收到/未收到', () => {
    const legacy = makeEvidence({
      transport: { evidence: 'execution_unconfirmed' },
      adp_receipt: {
        status: 'unknown',
        result_received: false,
        result_received_missing: true,
      },
    });
    expect(legacy.status).toBe('unknown');
    expect(legacy.transport).toEqual({
      evidence: 'execution_unconfirmed',
      result_received: false,
      result_received_missing: true,
    });
  });

  it('status_override 只能把成功降级，且 receipt/result 原始事实不被改写', () => {
    const observation = {
      transport: { evidence: 'execution_unconfirmed' as const, result_received: true },
      result: { status: 'succeeded' as const },
      adp_receipt: { status: 'succeeded' as const, result_received: true },
      status_override: {
        status: 'failed' as const,
        reason: 'read_only_changed',
        error: { code: 'READ_ONLY_VIOLATION', message: 'changed files', retryable: false },
      },
    };
    const before = structuredClone(observation);
    const evidence = makeEvidence(observation);
    expect(evidence.status).toBe('failed');
    expect(evidence.error?.code).toBe('READ_ONLY_VIOLATION');
    expect(observation).toEqual(before);
    expect(() =>
      makeEvidence({
        transport: { evidence: 'execution_unconfirmed' as const, result_received: false },
        status_override: { status: 'failed' as const, reason: 'x' },
      }),
    ).toThrow(/requires an error/i);
  });
});
