/**
 * adp-status-mapping.test — 驱动结局 → ADP status 证据化映射的单测(issue #149)。
 * 钉死 DoD 第 3、4 条:启动失败/确定失败/成功/取消/结果未知五类结局的区分,
 * 以及 unknown 永不自动重跑的语义前提。
 */
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, nowTimestamp } from '../core';
import type { DriverRunResult, DriverRunStatus } from './contract';
import type { AdpInvocationEvidence } from './adp-invocation-state';
import { mapAdpOutcome } from './adp-status-mapping';

function execution(
  status: DriverRunStatus,
  error?: { code: string; message: string; retryable: boolean },
): DriverRunResult {
  return {
    driver_run_result_id: 'driver_result_test',
    session_id: 'session-test',
    status,
    response: 'done',
    artifacts: [],
    transcript_ref: {
      artifact_id: 'artifact-test',
      type: 'transcript',
      uri: 'artifact://transcript/test',
      producer_id: 'driver-test',
      task_id: 'task-1',
      metadata: {},
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    },
    tool_events: [],
    diagnostics: { driver_id: 'driver-test', duration_ms: 5, notes: [] },
    ...(error ? { error } : {}),
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function evidence(overrides: Partial<AdpInvocationEvidence> = {}): AdpInvocationEvidence {
  return {
    dispatched: true,
    effects_observed: false,
    result_received: true,
    cancel_requested: false,
    ...overrides,
  };
}

describe('mapAdpOutcome · 确定结局', () => {
  it('succeeded → succeeded 且 error 必须为 null', () => {
    const mapped = mapAdpOutcome({ kind: 'result', evidence: evidence(), execution: execution('succeeded') });
    expect(mapped.status).toBe('succeeded');
    expect(mapped.error).toBeNull();
  });

  it('业务 failed → failed,error 携带业务码,retryable 仅作提示', () => {
    const mapped = mapAdpOutcome({
      kind: 'result',
      evidence: evidence(),
      execution: execution('failed', { code: 'BUSINESS_BOOM', message: 'boom', retryable: true }),
    });
    expect(mapped.status).toBe('failed');
    expect(mapped.error).toMatchObject({ code: 'BUSINESS_BOOM', retryable: true });
  });

  it('驱动确认 cancelled → cancelled', () => {
    const mapped = mapAdpOutcome({ kind: 'result', evidence: evidence(), execution: execution('cancelled') });
    expect(mapped.status).toBe('cancelled');
  });
});

describe('mapAdpOutcome · 启动失败(明确证据未执行)', () => {
  it('dispatch 前抛错 → failed(DRIVER_START_FAILED),retryable 提示 true', () => {
    const mapped = mapAdpOutcome({
      kind: 'thrown',
      evidence: evidence({ dispatched: false, result_received: false }),
      error: new Error('spawn ENOENT'),
    });
    expect(mapped.status).toBe('failed');
    expect(mapped.error).toMatchObject({ code: 'DRIVER_START_FAILED', retryable: true });
  });

  it('transport 报出 not_executed(spawn 失败)即 使已 dispatch → failed', () => {
    const mapped = mapAdpOutcome({
      kind: 'result',
      evidence: evidence({ transport_evidence: 'not_executed' }),
      execution: execution('failed', {
        code: 'DRIVER_START_FAILED',
        message: 'failed to start',
        retryable: true,
      }),
    });
    expect(mapped.status).toBe('failed');
    expect(mapped.error?.code).toBe('DRIVER_START_FAILED');
  });

  it('dispatch 前被取消 → cancelled(取消生效,明确未执行)', () => {
    const mapped = mapAdpOutcome({
      kind: 'thrown',
      evidence: evidence({ dispatched: false, result_received: false, cancel_requested: true }),
      error: new Error('driver.cancel'),
    });
    expect(mapped.status).toBe('cancelled');
  });
});

describe('mapAdpOutcome · 结果未知(副作用不明)', () => {
  it.each([
    ['DRIVER_OUTCOME_UNKNOWN', 'connection dropped'],
    ['EXTERNAL_DRIVER_TRANSPORT_ERROR', 'timed out'],
    ['DRIVER_RUNTIME_INVOKER_ERROR', 'malformed result'],
  ])('dispatch 后的 %s → unknown 且 retryable 恒 false', (code, message) => {
    const mapped = mapAdpOutcome({
      kind: 'result',
      evidence: evidence(),
      execution: execution('failed', { code, message, retryable: true }),
    });
    expect(mapped.status).toBe('unknown');
    expect(mapped.error).toMatchObject({ code: 'DRIVER_OUTCOME_UNKNOWN', retryable: false });
  });

  it('dispatch 后抛错(断连/超时)→ unknown', () => {
    const mapped = mapAdpOutcome({
      kind: 'thrown',
      evidence: evidence({ result_received: false }),
      error: new Error('transport disconnected'),
    });
    expect(mapped.status).toBe('unknown');
  });

  it('取消发生在副作用活动后且结局不明 → unknown', () => {
    const mapped = mapAdpOutcome({
      kind: 'thrown',
      evidence: evidence({
        result_received: false,
        cancel_requested: true,
        effects_observed: true,
      }),
      error: new Error('aborted'),
    });
    expect(mapped.status).toBe('unknown');
  });

  it('interrupted 且已观察到副作用 → unknown', () => {
    const mapped = mapAdpOutcome({
      kind: 'result',
      evidence: evidence({ effects_observed: true }),
      execution: execution('interrupted'),
    });
    expect(mapped.status).toBe('unknown');
  });
});

describe('mapAdpOutcome · 取消与 interrupted 的适配', () => {
  it('取消发生在 dispatch 后但无副作用活动 → cancelled', () => {
    const mapped = mapAdpOutcome({
      kind: 'thrown',
      evidence: evidence({ result_received: false, cancel_requested: true }),
      error: new Error('aborted'),
    });
    expect(mapped.status).toBe('cancelled');
  });

  it('interrupted 且无副作用活动 → cancelled(能证明未完成)', () => {
    const mapped = mapAdpOutcome({
      kind: 'result',
      evidence: evidence({ effects_observed: false }),
      execution: execution('interrupted'),
    });
    expect(mapped.status).toBe('cancelled');
  });
});
