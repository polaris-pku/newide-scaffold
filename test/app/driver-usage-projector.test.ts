import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mergeTaskDriverUsage,
  preferDriverUsage,
  projectTaskDriverUsage,
  TaskDriverUsageAccumulator,
  type TaskDriverUsage,
} from '../../src/app/driver-usage-projector';

describe('projectTaskDriverUsage', () => {
  it('deduplicates cumulative Session updates and aggregates continuation Runs', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'newide-driver-usage-'));
    await writeUsage(runsRoot, 'run_sender', [
      usage('task_usage', 'session_a', 'role_a', 100, 0.01, '2026-08-14T00:00:01Z'),
      usage('task_usage', 'session_a', 'role_a', 140, 0.02, '2026-08-14T00:00:02Z'),
    ]);
    await writeUsage(runsRoot, 'run_continuation', [
      usage('task_usage', 'session_b', 'role_b', 60, 0.03, '2026-08-14T00:00:03Z'),
      usage('another_task', 'session_other', 'role_other', 999, 9, '2026-08-14T00:00:04Z'),
    ]);

    await expect(projectTaskDriverUsage(runsRoot, 'task_usage')).resolves.toEqual({
      available: true,
      source: 'driver_stream_usage_update',
      metric: 'context_tokens_used',
      context_tokens_used: 200,
      reported_costs: [{ amount: 0.05, currency: 'USD' }],
      sessions: [
        {
          session_id: 'session_a',
          role_id: 'role_a',
          context_tokens_used: 140,
          context_window_size: 200_000,
          reported_cost: { amount: 0.02, currency: 'USD' },
          complete: true,
        },
        {
          session_id: 'session_b',
          role_id: 'role_b',
          context_tokens_used: 60,
          context_window_size: 200_000,
          reported_cost: { amount: 0.03, currency: 'USD' },
          complete: true,
        },
      ],
      complete: true,
    });
  });

  it('marks every session from a truncated audit file incomplete', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'newide-driver-usage-'));
    await writeUsage(
      runsRoot,
      'run_truncated',
      [
        usage('task_trunc', 'session_a', 'role_a', 100, undefined, '2026-08-14T00:00:01Z'),
        { task_id: 'task_trunc', recorded_at: '2026-08-14T00:00:02Z', truncated: true },
      ],
      false,
    );

    const projected = await projectTaskDriverUsage(runsRoot, 'task_trunc');
    expect(projected.complete).toBe(false);
    expect(projected.sessions).toEqual([
      {
        session_id: 'session_a',
        role_id: 'role_a',
        context_tokens_used: 100,
        context_window_size: 200_000,
        complete: false,
      },
    ]);
  });
});

describe('TaskDriverUsageAccumulator', () => {
  it('folds stream events with the same cumulative-collapse semantics', () => {
    const accumulator = new TaskDriverUsageAccumulator();
    accumulator.observe(usageEvent('session_a', 'role_a', 100, 0.01), '2026-08-14T00:00:01Z');
    accumulator.observe(usageEvent('session_a', 'role_a', 140, 0.02), '2026-08-14T00:00:02Z');
    accumulator.observe(usageEvent('session_b', 'role_b', 60), '2026-08-14T00:00:03Z');

    expect(accumulator.finalize()).toMatchObject({
      available: true,
      context_tokens_used: 200,
      reported_costs: [{ amount: 0.02, currency: 'USD' }],
      complete: true,
      sessions: [
        { session_id: 'session_a', context_tokens_used: 140, complete: true },
        { session_id: 'session_b', context_tokens_used: 60, complete: true },
      ],
    });
  });
});

describe('mergeTaskDriverUsage / preferDriverUsage', () => {
  it('heals a truncated file scan with the in-process accumulator and reports complete', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'newide-driver-usage-'));
    await writeUsage(
      runsRoot,
      'run_truncated',
      [
        usage('task_merge', 'session_a', 'role_a', 100, undefined, '2026-08-14T00:00:01Z'),
        { task_id: 'task_merge', recorded_at: '2026-08-14T00:00:02Z', truncated: true },
      ],
      false,
    );
    const fileScanned = await projectTaskDriverUsage(runsRoot, 'task_merge');
    const accumulator = new TaskDriverUsageAccumulator();
    accumulator.observe(usageEvent('session_a', 'role_a', 140), '2026-08-14T00:00:02Z');
    accumulator.observe(usageEvent('session_c', 'role_c', 20), '2026-08-14T00:00:03Z');

    const merged = mergeTaskDriverUsage(fileScanned, accumulator.finalize());
    expect(merged.complete).toBe(true);
    expect(merged.context_tokens_used).toBe(160);
    expect(merged.sessions).toMatchObject([
      { session_id: 'session_a', context_tokens_used: 140, complete: true },
      { session_id: 'session_c', context_tokens_used: 20, complete: true },
    ]);
  });

  it('keeps incomplete merged results flagged when only a truncated file is available', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'newide-driver-usage-'));
    await writeUsage(
      runsRoot,
      'run_truncated',
      [
        usage('task_merge', 'session_a', 'role_a', 100, undefined, '2026-08-14T00:00:01Z'),
        { task_id: 'task_merge', recorded_at: '2026-08-14T00:00:02Z', truncated: true },
      ],
      false,
    );
    const merged = mergeTaskDriverUsage(await projectTaskDriverUsage(runsRoot, 'task_merge'));
    expect(merged.complete).toBe(false);
    expect(merged.sessions[0]?.complete).toBe(false);
  });

  it('prefers a complete observation over a larger incomplete one', () => {
    const complete: TaskDriverUsage = {
      available: true,
      source: 'driver_stream_usage_update',
      metric: 'context_tokens_used',
      context_tokens_used: 100,
      reported_costs: [],
      sessions: [],
      complete: true,
    };
    const incomplete: TaskDriverUsage = {
      available: true,
      source: 'driver_stream_usage_update',
      metric: 'context_tokens_used',
      context_tokens_used: 999,
      reported_costs: [],
      sessions: [],
      complete: false,
    };
    expect(preferDriverUsage(incomplete, complete)).toBe(complete);
    expect(preferDriverUsage(complete, incomplete)).toBe(complete);
    // 双方同样完整（或都没有标记，按老数据算完整）时才比大小。
    expect(preferDriverUsage(complete, { ...incomplete, complete: true })).toMatchObject({
      context_tokens_used: 999,
    });
    expect(preferDriverUsage({ context_tokens_used: 50 }, complete)).toBe(complete);
  });
});

async function writeUsage(
  runsRoot: string,
  runId: string,
  records: Record<string, unknown>[],
  trailingNewline = true,
): Promise<void> {
  const runDir = path.join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join('\n');
  await writeFile(
    path.join(runDir, 'driver-stream.jsonl'),
    trailingNewline ? `${body}\n` : body,
    'utf8',
  );
}

function usage(
  taskId: string,
  sessionId: string,
  roleId: string,
  used: number,
  cost: number | undefined,
  recordedAt: string,
): Record<string, unknown> {
  return {
    task_id: taskId,
    recorded_at: recordedAt,
    event: {
      event_type: 'usage_update',
      session_id: sessionId,
      role_id: roleId,
      payload: {
        sessionId,
        update: {
          used,
          size: 200_000,
          ...(cost !== undefined ? { cost: { amount: cost, currency: 'USD' } } : {}),
        },
      },
    },
  };
}

function usageEvent(
  sessionId: string,
  roleId: string,
  used: number,
  cost?: number,
): Parameters<TaskDriverUsageAccumulator['observe']>[0] {
  return {
    schema_version: 'driver-event.v1',
    event_type: 'usage_update',
    session_id: sessionId,
    role_id: roleId,
    payload: {
      sessionId,
      update: {
        used,
        size: 200_000,
        ...(cost !== undefined ? { cost: { amount: cost, currency: 'USD' } } : {}),
      },
    },
  };
}
