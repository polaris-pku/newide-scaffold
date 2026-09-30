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

describe('projectTaskDriverUsage 的账本优先', () => {
  it('同一个 run 有账本时不读被截断的副本，终值与成本由此找回', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'newide-driver-usage-'));
    // 复刻实测现场：副本只剩截断前的一个观测，真正的终值在账本里。
    await writeUsage(runsRoot, 'run_ledger', [
      usage('task_ledger', 'session_a', 'role_a', 100, undefined, '2026-08-14T00:00:01Z'),
      { task_id: 'task_ledger', recorded_at: '2026-08-14T00:00:02Z', truncated: true },
    ]);
    await writeLedger(runsRoot, 'run_ledger', [
      ledgerRecord({ session_id: 'session_a', used: 68_645, cost: 1.663 }),
    ]);

    await expect(projectTaskDriverUsage(runsRoot, 'task_ledger')).resolves.toMatchObject({
      context_tokens_used: 68_645,
      reported_costs: [{ amount: 1.663, currency: 'USD' }],
      complete: true,
      sessions: [
        {
          session_id: 'session_a',
          context_tokens_used: 68_645,
          reported_cost: { amount: 1.663, currency: 'USD' },
          complete: true,
        },
      ],
    });
  });

  it('账本里带 cost 即判终值，缺 cost 的如实标缺尾', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'newide-driver-usage-'));
    await writeLedger(runsRoot, 'run_cost', [
      ledgerRecord({ task: 'task_cost', session_id: 'session_done', used: 500, cost: 0.5 }),
      // 第 5 个角色的会话在进程被杀前没等到 cost：数字照收，完整性不冒充。
      ledgerRecord({ task: 'task_cost', session_id: 'session_killed', used: 400, sequence: 2 }),
    ]);

    const projected = await projectTaskDriverUsage(runsRoot, 'task_cost');
    expect(projected.complete).toBe(false);
    expect(projected.context_tokens_used).toBe(900);
    expect(projected.sessions).toMatchObject([
      { session_id: 'session_done', complete: true },
      { session_id: 'session_killed', complete: false },
    ]);
  });

  it('不认的 schema 与别的口径一律跳过，不折进 context_tokens_used', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'newide-driver-usage-'));
    await writeLedger(runsRoot, 'run_strict', [
      { ...ledgerRecord({ task: 'task_strict', session_id: 'session_ok', used: 10, cost: 0.1 }) },
      {
        ...ledgerRecord({ task: 'task_strict', session_id: 'session_other_metric', used: 999 }),
        metric: 'billed_tokens',
      },
      {
        ...ledgerRecord({ task: 'task_strict', session_id: 'session_other_schema', used: 999 }),
        schema_version: 'some-other-record.v9',
      },
      ledgerRecord({ task: 'task_other', session_id: 'session_other_task', used: 999 }),
    ]);

    const projected = await projectTaskDriverUsage(runsRoot, 'task_strict');
    expect(projected.sessions.map((session) => session.session_id)).toEqual(['session_ok']);
    expect(projected.context_tokens_used).toBe(10);
  });

  it('续 run 的账本与老 run 的副本可以混着折叠', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'newide-driver-usage-'));
    // 升级前跑的 run 只有副本；升级后的续 run 有账本。两条通道折叠进同一张表。
    await writeUsage(runsRoot, 'run_old', [
      usage('task_mixed', 'session_old', 'role_a', 120, 0.25, '2026-08-14T00:00:01Z'),
    ]);
    await writeLedger(runsRoot, 'run_new', [
      ledgerRecord({ task: 'task_mixed', session_id: 'session_new', used: 30, cost: 0.5 }),
    ]);

    const projected = await projectTaskDriverUsage(runsRoot, 'task_mixed');
    expect(projected).toMatchObject({
      context_tokens_used: 150,
      reported_costs: [{ amount: 0.75, currency: 'USD' }],
      complete: true,
    });
    expect(projected.sessions.map((session) => session.session_id)).toEqual([
      'session_new',
      'session_old',
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

/**
 * 写账本 `<runId>/driver-usage.jsonl`。`run_id` 由目录名盖章，与生产 sink 同规则：
 * 文件本就按 run 分目录，行内 run_id 与目录不一致只会让读的人困惑。
 */
async function writeLedger(
  runsRoot: string,
  runId: string,
  records: Record<string, unknown>[],
): Promise<void> {
  const runDir = path.join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  const body = records.map((record) => JSON.stringify({ ...record, run_id: runId })).join('\n');
  await writeFile(path.join(runDir, 'driver-usage.jsonl'), `${body}\n`, 'utf8');
}

function ledgerRecord(input: {
  task?: string;
  session_id: string;
  role?: string;
  used: number;
  cost?: number;
  sequence?: number;
  recordedAt?: string;
}): Record<string, unknown> {
  return {
    schema_version: 'newide.driver-usage-record.v1',
    recorded_at: input.recordedAt ?? '2026-08-14T00:00:05Z',
    task_id: input.task ?? 'task_ledger',
    stream_sequence: input.sequence ?? 1,
    session_id: input.session_id,
    ...(input.role ? { role_id: input.role } : {}),
    metric: 'context_tokens_used',
    context_tokens_used: input.used,
    context_window_size: 200_000,
    ...(input.cost !== undefined
      ? { reported_cost: { amount: input.cost, currency: 'USD' } }
      : {}),
  };
}
