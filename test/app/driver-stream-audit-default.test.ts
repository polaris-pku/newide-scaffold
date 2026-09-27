/**
 * driver-stream 落盘默认值的服务级生效验证。
 *
 * PR-1 把 NewideBackendService 的 driverStreamAuditWriter 默认值从 Noop 翻转为
 * FileDriverStreamAuditWriter，并给落盘加了保留上限。writer 自身的单测不覆盖
 * 「默认接线」这一层——这里驱动真实的 run 事件路径（runner 桩 → onDriverEvent →
 * appendDriverStreamEvent），验证两件事：
 *
 *   1. 不注入任何写入器时，事件流照样落到默认根目录的 driver-stream.jsonl；
 *   2. 注入小上限写入器时，服务路径上的截断与标记同样生效。
 *
 * 默认值若被翻回 Noop，第 1 例会当场变红。产物首行会打进测试日志，便于人工核对
 * 信封形状（schema_version / run_id / task_id / recorded_at / event）。
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import type { CoordinatorRunner } from '../../src/coordinator/coordinator-runner';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { InMemoryRunRegistry } from '../../src/app/run-registry';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import { FileRunRequestStore } from '../../src/app/run-request-store';
import { FileDriverStreamAuditWriter } from '../../src/app/driver-stream-audit-writer';
import type { DriverStreamEvent } from '../../src/driver/contract';

function streamEvent(runId: string, taskId: string, sequence: number, text: string): DriverStreamEvent {
  return {
    schema_version: 'driver-event.v1',
    event_type: 'agent_message_chunk',
    task_id: taskId,
    run_id: runId,
    session_id: 'session_audit',
    sequence,
    created_at: '2026-01-01T00:00:00.000Z',
    payload: {
      sessionId: 'session_audit',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  };
}

/** 落盘是 fire-and-forget：轮询等行数到位。 */
async function readLinesWhen(
  filePath: string,
  predicate: (lines: string[]) => boolean,
  attempts = 400,
): Promise<string[]> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const raw = await readFile(filePath, 'utf8').catch(() => undefined);
    if (raw !== undefined) {
      const lines = raw.split('\n').filter((line) => line.trim().length > 0);
      if (predicate(lines)) return lines;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  throw new Error(`driver-stream 未在预算内写到位：${filePath}\n${raw}`);
}

async function viWaitFor(predicate: () => boolean, attempts = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not met');
}

function runnerStub(
  runId: string,
  taskId: string,
  events: DriverStreamEvent[],
): { runner: CoordinatorRunner; finish: () => void; done: Promise<void> } {
  let finish!: () => void;
  let settle!: () => void;
  const runnerResult = new Promise<IntegrationV0Result>((resolve) => {
    finish = () => resolve(completedResult(runId, taskId));
  });
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const runner: CoordinatorRunner = {
    run: async (request) => {
      request.onRunCreated?.({ run_id: runId, task_id: taskId });
      for (const event of events) request.onDriverEvent?.(event);
      const result = await runnerResult;
      settle();
      return result;
    },
  };
  return {
    runner,
    finish: () => finish(),
    done,
  };
}

describe('driver-stream 落盘默认值的服务级生效', () => {
  it('不注入写入器时事件流照样落进默认根目录的 driver-stream.jsonl', async () => {
    const runId = `run_default_audit_${Date.now()}`;
    const taskId = 'task_default_audit';
    const events = [
      streamEvent(runId, taskId, 1, 'one'),
      streamEvent(runId, taskId, 2, 'two'),
      streamEvent(runId, taskId, 3, 'three'),
    ];
    const { runner, finish } = runnerStub(runId, taskId, events);
    // 关键：只传 runner，其余全走默认——默认值若翻回 Noop，下面的文件不会出现。
    const service = new NewideBackendService(runner);
    const auditPath = path.join('.newide', 'runs', runId, 'driver-stream.jsonl');

    try {
      await service.createRun({ prompt: 'default audit', workspace_path: process.cwd() });
      const lines = await readLinesWhen(auditPath, (written) => written.length >= 3);
      const envelopes = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(envelopes).toHaveLength(3);
      expect(envelopes[0]).toMatchObject({
        schema_version: 'driver-stream-audit.v1',
        run_id: runId,
        task_id: taskId,
      });
      expect(
        envelopes.map((envelope) => (envelope.event as DriverStreamEvent).sequence),
      ).toEqual([1, 2, 3]);
      // 产物首行打进日志：人工核对信封形状用。
      console.log('[driver-stream 默认落盘首行]', lines[0]);
    } finally {
      finish();
      await viWaitFor(() => service.getSnapshot(runId)?.status === 'completed');
      await rm(path.join('.newide', 'runs', runId), { recursive: true, force: true });
    }
  });

  it('注入小上限写入器时服务路径同样截断并留标记', async () => {
    const tempRoot = path.join(os.tmpdir(), `driver-stream-cap-${Date.now()}`);
    const runsRoot = path.join(tempRoot, 'runs');
    await mkdir(runsRoot, { recursive: true });
    const runId = 'run_cap';
    const taskId = 'task_cap';
    const events = [1, 2, 3, 4].map((sequence) =>
      streamEvent(runId, taskId, sequence, 'x'.repeat(200)),
    );
    const { runner, finish } = runnerStub(runId, taskId, events);
    const service = new NewideBackendService(
      runner,
      new InMemoryRunRegistry(),
      new FileRunAuditWriter(runsRoot),
      new FileRunTerminalOutputWriter(runsRoot),
      new FileRunRequestStore(runsRoot),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new FileDriverStreamAuditWriter(runsRoot, 260),
    );

    try {
      await service.createRun({ prompt: 'cap audit', workspace_path: process.cwd() });
      const lines = await readLinesWhen(path.join(runsRoot, runId, 'driver-stream.jsonl'), (written) =>
        written.some((line) => JSON.parse(line).truncated === true),
      );
      const markers = lines.filter((line) => (JSON.parse(line) as { truncated?: boolean }).truncated === true);
      expect(markers).toHaveLength(1);
      expect(lines.length).toBeLessThan(events.length + 1);
    } finally {
      finish();
      await viWaitFor(() => service.getSnapshot(runId)?.status === 'completed');
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function completedResult(runId: string, taskId: string): IntegrationV0Result {
  return {
    run_id: runId,
    task_id: taskId,
    summary: { status: 'completed' },
    frontend_snapshot: {
      snapshot_type: 'coordinator.frontend_run_snapshot.v0',
      schema_version: 'v0',
      generated_at: '2026-07-11T08:00:00.000Z',
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
        created_at: '2026-07-11T08:00:00.000Z',
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
