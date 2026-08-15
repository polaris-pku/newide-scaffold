import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectTaskDriverUsage } from '../../src/app/driver-usage-projector';

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
        },
        {
          session_id: 'session_b',
          role_id: 'role_b',
          context_tokens_used: 60,
          context_window_size: 200_000,
          reported_cost: { amount: 0.03, currency: 'USD' },
        },
      ],
    });
  });
});

async function writeUsage(
  runsRoot: string,
  runId: string,
  records: Record<string, unknown>[],
): Promise<void> {
  const runDir = path.join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, 'driver-stream.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
}

function usage(
  taskId: string,
  sessionId: string,
  roleId: string,
  used: number,
  cost: number,
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
          cost: { amount: cost, currency: 'USD' },
        },
      },
    },
  };
}
