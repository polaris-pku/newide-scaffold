/**
 * Replay-time trajectory diagnostics tests.
 *
 * 覆盖分析器对 SWE-EVO council 失败模式的自动判定：mailbox 路由卡死
 * （message.unacked）、最终报告六字段损坏（final_report.malformed）、
 * 计划未物化（materialization.missing）、上下文爆掉（context.high_usage），
 * 以及健康 run 不产生 error/warning finding。
 */
import { describe, expect, it } from 'vitest';
import { analyzeTrajectory, checkSixFieldReport } from '../../src/trace/analysis';
import type { TrajectorySpanRecord } from '../../src/trace/types';

const T0 = '2026-08-16T10:00:00.000Z';
const T1 = '2026-08-16T10:00:00.100Z';
const T2 = '2026-08-16T10:00:00.250Z';
const T3 = '2026-08-16T10:00:01.000Z';

function record(
  spanId: string,
  phase: TrajectorySpanRecord['phase'],
  kind: TrajectorySpanRecord['kind'],
  sequence: number,
  created_at: string,
  extra: Partial<TrajectorySpanRecord> = {},
): TrajectorySpanRecord {
  return {
    span_id: spanId,
    kind,
    phase,
    sequence,
    created_at,
    schema_version: 'v0',
    run_id: 'run_test',
    ...extra,
  };
}

/** task.assigned sent+acked; driver.requested sent+acked; driver ok; worktree; done. */
function healthyFixture(): TrajectorySpanRecord[] {
  return [
    record('task', 'start', 'task.run', 1, T0),
    record('msg_1', 'point', 'agent.message', 2, T1, {
      payload: {
        message_id: 'm_assigned',
        message_type: 'task.assigned',
        from_agent_id: 'coordinator',
        to_agent_id: 'agent_a',
        requires_ack: true,
      },
    }),
    record('msg_2', 'point', 'agent.message', 3, T2, {
      payload: { message_id: 'm_assigned', message_type: 'task.assigned', acked_by: 'agent_a' },
    }),
    record('msg_3', 'point', 'agent.message', 4, T1, {
      payload: {
        message_id: 'm_driver',
        message_type: 'driver.requested',
        from_agent_id: 'coordinator',
        to_agent_id: 'agent_a',
        requires_ack: true,
      },
    }),
    record('msg_4', 'point', 'agent.message', 5, T2, {
      payload: { message_id: 'm_driver', message_type: 'driver.requested', acked_by: 'agent_a' },
    }),
    record('drv', 'start', 'driver.run', 6, T1),
    record('drv', 'end', 'driver.run', 7, T3, { status: 'ok', duration_ms: 750 }),
    record('wt', 'point', 'worktree', 8, T3, {
      status: 'ok',
      payload: { files_written: 2, changed_files: ['a.ts', 'b.ts'] },
    }),
    record('art', 'point', 'artifact', 9, T3, { status: 'ok' }),
    record('task', 'end', 'task.run', 10, T3, { status: 'ok' }),
  ];
}

describe('analyzeTrajectory — message flow', () => {
  it('healthy run: all mailbox messages acked, no error findings', () => {
    const diag = analyzeTrajectory(healthyFixture());
    expect(diag.messages).toHaveLength(2);
    expect(diag.messages.every((message) => message.status === 'acked')).toBe(true);
    expect(diag.messages[0]!.wait_ms).toBe(150);
    expect(diag.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    expect(diag.findings.filter((f) => f.severity === 'warning')).toHaveLength(0);
  });

  it('detects a never-acked required message as a mailbox deadlock (message.unacked)', () => {
    const fixture = healthyFixture();
    // Drop the driver.requested ack record: flow ends while the message waits.
    const records = fixture.filter((r) => r.span_id !== 'msg_4');
    const diag = analyzeTrajectory(records);
    const driverMessage = diag.messages.find(
      (message) => message.message_type === 'driver.requested',
    );
    expect(driverMessage?.status).toBe('waiting');
    expect(driverMessage?.requires_ack).toBe(true);
    const finding = diag.findings.find((f) => f.code === 'message.unacked');
    expect(finding?.severity).toBe('error');
    expect(finding?.summary).toContain('driver.requested');
    expect(finding?.summary).toContain('coordinator → agent_a');
  });

  it('keeps non-required waiting messages as info findings only', () => {
    const records = healthyFixture().concat([
      record('msg_note', 'point', 'agent.message', 11, T1, {
        payload: {
          message_id: 'm_note',
          message_type: 'notice',
          from_agent_id: 'agent_a',
          to_agent_id: 'agent_b',
        },
      }),
    ]);
    const diag = analyzeTrajectory(records);
    const finding = diag.findings.find((f) => f.code === 'message.unanswered');
    expect(finding?.severity).toBe('info');
    expect(diag.findings.some((f) => f.code === 'message.unacked')).toBe(false);
  });

  it('matches acks by type+recipient when sent records predate message_id augmentation', () => {
    // Older trajectory files carry the event id instead of the mailbox message
    // id on the sent record; the ack still carries the real message_id.
    const records = healthyFixture().map((r) =>
      r.span_id === 'msg_3' && r.payload !== undefined
        ? { ...r, payload: { ...r.payload, message_id: undefined } }
        : r,
    );
    const diag = analyzeTrajectory(records);
    const driverMessage = diag.messages.find(
      (message) => message.message_type === 'driver.requested',
    );
    expect(driverMessage?.status).toBe('acked');
    expect(driverMessage?.acked_by).toBe('agent_a');
    expect(diag.findings.some((f) => f.code === 'message.unacked')).toBe(false);
  });
});

describe('analyzeTrajectory — final report schema', () => {
  it('flags artifacts-as-object (not array) as final_report.malformed', () => {
    const fixture = healthyFixture().concat([
      record('turn', 'start', 'agent.turn', 11, T2, { agent_id: 'agent_a' }),
      record('turn', 'end', 'agent.turn', 12, T3, {
        agent_id: 'agent_a',
        status: 'ok',
        payload: {
          output: {
            content: JSON.stringify({
              artifacts: {
                modified: ['a.ts'],
                created: [],
                per_pr: {},
                deferred: [],
                untouched: [],
              },
              summary: 'done',
              decisions: ['x'],
              blockers: [],
              referenced_experiences: [],
              assumptions: [],
            }),
          },
        },
      }),
    ]);
    const diag = analyzeTrajectory(fixture);
    const finding = diag.findings.find((f) => f.code === 'final_report.malformed');
    expect(finding?.severity).toBe('error');
    expect(finding?.summary).toContain('artifacts must be an array');
    expect(diag.finalReport.found).toBe(true);
    expect(diag.finalReport.violations.length).toBeGreaterThan(0);
  });

  it('accepts a well-formed six-field report', () => {
    const report = checkSixFieldReport(
      JSON.stringify({
        artifacts: [{ type: 'file', path: 'a.ts', summary: 'impl' }],
        summary: 'done',
        decisions: ['x'],
        blockers: [],
        referenced_experiences: [],
        assumptions: [],
      }),
    );
    expect(report.violations).toEqual([]);
    expect(report.parsed?.artifacts).toHaveLength(1);
  });

  it('does not flag plain prose final messages (not a structured report)', () => {
    const fixture = healthyFixture().concat([
      record('turn', 'start', 'agent.turn', 11, T2, { agent_id: 'agent_a' }),
      record('turn', 'end', 'agent.turn', 12, T3, {
        agent_id: 'agent_a',
        status: 'ok',
        payload: { output: { content: 'Task completed. [done]' } },
      }),
    ]);
    const diag = analyzeTrajectory(fixture);
    expect(diag.finalReport.found).toBe(true);
    expect(diag.findings.some((f) => f.code === 'final_report.malformed')).toBe(false);
  });
});

describe('analyzeTrajectory — materialization', () => {
  it('warns when the run ends ok but nothing was materialized or delivered', () => {
    const fixture = healthyFixture().filter((r) => r.span_id !== 'wt' && r.span_id !== 'art');
    const diag = analyzeTrajectory(fixture);
    const finding = diag.findings.find((f) => f.code === 'materialization.missing');
    expect(finding?.severity).toBe('warning');
  });

  it('does not warn when worktree files were written', () => {
    const diag = analyzeTrajectory(healthyFixture());
    expect(diag.findings.some((f) => f.code === 'materialization.missing')).toBe(false);
  });

  it('does not warn when the run itself failed (no ok completion to contradict)', () => {
    const fixture = healthyFixture().filter((r) => r.span_id !== 'wt' && r.span_id !== 'art');
    const end = fixture.find((r) => r.span_id === 'task' && r.phase === 'end')!;
    end.status = 'error';
    const diag = analyzeTrajectory(fixture);
    expect(diag.findings.some((f) => f.code === 'materialization.missing')).toBe(false);
  });
});

describe('analyzeTrajectory — context usage', () => {
  it('alarms when any LLM round exceeds the 70% threshold', () => {
    const fixture = healthyFixture().concat([
      record('llm_1', 'point', 'agent.llm', 11, T1, {
        agent_id: 'agent_a',
        payload: { round: 1, context_pct: 40, context_size: 51_200, context_limit: 128_000 },
      }),
      record('llm_2', 'point', 'agent.llm', 12, T2, {
        agent_id: 'agent_a',
        payload: { round: 2, context_pct: 86, context_size: 110_000, context_limit: 128_000 },
      }),
    ]);
    const diag = analyzeTrajectory(fixture);
    expect(diag.usagePoints).toHaveLength(2);
    const finding = diag.findings.find((f) => f.code === 'context.high_usage');
    expect(finding?.severity).toBe('warning');
    expect(finding?.summary).toContain('rounds [2]');
    expect(finding?.summary).toContain('86%');
  });

  it('derives context_pct from size/limit when pct is absent', () => {
    const records = [
      record('llm_1', 'point', 'agent.llm', 1, T1, {
        payload: { round: 1, context_size: 96_000, context_limit: 128_000 },
      }),
    ];
    const diag = analyzeTrajectory(records);
    expect(diag.usagePoints[0]!.context_pct).toBeCloseTo(75);
    expect(diag.findings.some((f) => f.code === 'context.high_usage')).toBe(true);
  });
});

describe('analyzeTrajectory — stages', () => {
  it('groups spans by kind and flags failed stages', () => {
    const fixture = healthyFixture().concat([
      record('gate', 'start', 'gate.eval', 11, T1, { parent_span_id: 'task' }),
      record('gate', 'end', 'gate.eval', 12, T2, { status: 'error' }),
    ]);
    const diag = analyzeTrajectory(fixture);
    const gateStage = diag.stages.find((stage) => stage.name === 'gate.eval');
    expect(gateStage?.failedCount).toBe(1);
    expect(diag.stageTimeline.some((item) => item.status === 'failed')).toBe(true);
  });
});
