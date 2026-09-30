/**
 * driver usage 账本 sink 与服务接线的验证。
 *
 * 这里覆盖三层，缺一层都可能让「有记但没落盘」重演：
 *
 *   1. sink 自身：按 run 分文件、逐条同步追加、记录自描述（`metric` / `stream_sequence`）；
 *   2. 关闭与故障路径：Noop 不落任何东西，落盘失败只丢那一条而不抛出——观测埋点不该
 *      把一次磁盘抖动升级成 run 失败；
 *   3. 服务接线 + 病灶证伪：把事件流副本的上限压到很小，让 usage 观测落在截断之后，
 *      然后要求账本仍然齐全、`projectTaskDriverUsage` 仍然读出终值。这一条若失守，
 *      报表就退回实测过的 council 现场：5 段成本只剩 1 段。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import type { CoordinatorRunner } from '../../src/coordinator/coordinator-runner';
import type { DriverStreamEvent } from '../../src/driver/contract';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { InMemoryRunRegistry } from '../../src/app/run-registry';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import { FileRunRequestStore } from '../../src/app/run-request-store';
import { FileDriverStreamAuditWriter } from '../../src/app/driver-stream-audit-writer';
import { projectTaskDriverUsage } from '../../src/app/driver-usage-projector';
import {
  FileRunDriverUsageJsonlSink,
  NoopDriverUsageSink,
  type DriverUsageSink,
} from '../../src/app/driver-usage-jsonl-sink';
import type { DriverUsageRecord } from '../../src/app/driver-usage-projector';

function usageRecord(overrides: Partial<DriverUsageRecord> = {}): DriverUsageRecord {
  return {
    schema_version: 'newide.driver-usage-record.v1',
    recorded_at: '2026-09-29T16:14:28.000Z',
    run_id: 'run_ledger',
    task_id: 'task_ledger',
    stream_sequence: 7,
    session_id: 'session_a',
    role_id: 'role_fullstack_engineer',
    metric: 'context_tokens_used',
    context_tokens_used: 68_645,
    context_window_size: 200_000,
    reported_cost: { amount: 1.663, currency: 'USD' },
    ...overrides,
  };
}

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
  throw new Error(`driver usage 账本未在预算内写到位：${filePath}\n${raw}`);
}

async function waitFor(predicate: () => boolean, attempts = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not met');
}

describe('FileRunDriverUsageJsonlSink', () => {
  it('一个 run 一个文件，逐条追加并保留自描述字段', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'driver-usage-ledger-'));
    const sink = new FileRunDriverUsageJsonlSink(root);
    try {
      sink.emit(usageRecord({ session_id: 'session_a', context_tokens_used: 100 }));
      sink.emit(
        usageRecord({
          session_id: 'session_a',
          context_tokens_used: 68_645,
          stream_sequence: 8,
        }),
      );
      sink.emit(
        usageRecord({
          run_id: 'run_second',
          task_id: 'task_second',
          session_id: 'session_b',
          role_id: 'role_ts_engineer',
        }),
      );

      const first = await readLinesWhen(
        path.join(root, 'run_ledger', 'driver-usage.jsonl'),
        (lines) => lines.length >= 2,
      );
      const second = await readLinesWhen(
        path.join(root, 'run_second', 'driver-usage.jsonl'),
        (lines) => lines.length >= 1,
      );
      // 同一 session 的两次观测都留在盘上：折叠在读的一侧，写的一侧不裁决谁更重要。
      expect(first.map((line) => JSON.parse(line) as DriverUsageRecord)).toMatchObject([
        { context_tokens_used: 100, metric: 'context_tokens_used', stream_sequence: 7 },
        { context_tokens_used: 68_645, stream_sequence: 8 },
      ]);
      expect(second).toHaveLength(1);
      expect(JSON.parse(second[0]!)).toMatchObject({ run_id: 'run_second', session_id: 'session_b' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('空转 sink 不落任何东西，账本缺席不影响 run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'driver-usage-noop-'));
    try {
      const sink: DriverUsageSink = new NoopDriverUsageSink();
      expect(() => sink.emit(usageRecord())).not.toThrow();
      await expect(readFile(path.join(root, 'run_ledger', 'driver-usage.jsonl'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('落盘失败只丢记录并记住这个 run，不向上抛', async () => {
    // 把 root 指到一个普通文件上：建目录必然失败（ENOTDIR），模拟观测写不进去。
    const blockerDir = await mkdtemp(path.join(os.tmpdir(), 'driver-usage-blocked-'));
    const blocker = path.join(blockerDir, 'not-a-dir');
    await writeFile(blocker, '', 'utf-8');
    const sink = new FileRunDriverUsageJsonlSink(blocker);
    try {
      expect(() => sink.emit(usageRecord())).not.toThrow();
      // 第一条失败后该 run 被记住，后续不再重试：磁盘抖动不该被放大成每事件一次抛错。
      expect(() => sink.emit(usageRecord({ stream_sequence: 8 }))).not.toThrow();
    } finally {
      await rm(blockerDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 服务接线：真实 run 事件路径（runner 桩 → onDriverEvent → appendDriverStreamEvent）
// ---------------------------------------------------------------------------

function chunkEvent(sequence: number, text: string): DriverStreamEvent {
  return {
    schema_version: 'driver-event.v1',
    event_type: 'agent_message_chunk',
    session_id: 'session_impl',
    role_id: 'role_fullstack_engineer',
    sequence,
    created_at: '2026-09-29T16:14:20.000Z',
    payload: {
      sessionId: 'session_impl',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  };
}

function usageEvent(): DriverStreamEvent {
  return {
    schema_version: 'driver-event.v1',
    event_type: 'usage_update',
    session_id: 'session_impl',
    role_id: 'role_fullstack_engineer',
    sequence: 99,
    created_at: '2026-09-29T16:14:28.000Z',
    payload: {
      sessionId: 'session_impl',
      update: {
        used: 68_645,
        size: 200_000,
        cost: { amount: 1.663, currency: 'USD' },
      },
    },
  };
}

function runnerStub(events: DriverStreamEvent[]): {
  runner: CoordinatorRunner;
  finish: () => void;
} {
  let finish!: () => void;
  const runnerResult = new Promise<IntegrationV0Result>((resolve) => {
    finish = () => resolve(completedResult());
  });
  const runner: CoordinatorRunner = {
    run: async (request) => {
      request.onRunCreated?.({ run_id: 'run_wired', task_id: 'task_wired' });
      for (const event of events) request.onDriverEvent?.(event);
      return runnerResult;
    },
  };
  return { runner, finish: () => finish() };
}

describe('driver usage 账本的服务级接线', () => {
  it('副本被截断后账本仍然齐全，聚合读得到终值与成本', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'driver-usage-wiring-'));
    const runsRoot = path.join(tempRoot, 'runs');
    await mkdir(runsRoot, { recursive: true });
    // 上限压到 240 字节：文本块先把副本吃满，usage 观测一定落在 truncated 之后。
    const events = [
      chunkEvent(1, 'x'.repeat(160)),
      chunkEvent(2, 'y'.repeat(160)),
      chunkEvent(3, 'z'.repeat(160)),
      usageEvent(),
    ];
    const { runner, finish } = runnerStub(events);
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
      new FileDriverStreamAuditWriter(runsRoot, 240),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new FileRunDriverUsageJsonlSink(runsRoot),
    );

    try {
      await service.createRun({ prompt: 'ledger wiring', workspace_path: process.cwd() });

      const capped = await readLinesWhen(
        path.join(runsRoot, 'run_wired', 'driver-stream.jsonl'),
        (lines) => lines.some((line) => JSON.parse(line).truncated === true),
      );
      expect(
        capped.some(
          (line) => (JSON.parse(line) as { event?: { event_type?: string } }).event?.event_type ===
            'usage_update',
        ),
      ).toBe(false);

      const ledger = await readLinesWhen(
        path.join(runsRoot, 'run_wired', 'driver-usage.jsonl'),
        (lines) => lines.length >= 1,
      );
      expect(ledger).toHaveLength(1);
      expect(JSON.parse(ledger[0]!) as DriverUsageRecord).toMatchObject({
        schema_version: 'newide.driver-usage-record.v1',
        run_id: 'run_wired',
        task_id: 'task_wired',
        session_id: 'session_impl',
        role_id: 'role_fullstack_engineer',
        metric: 'context_tokens_used',
        context_tokens_used: 68_645,
        context_window_size: 200_000,
        reported_cost: { amount: 1.663, currency: 'USD' },
      });

      // 报表读的正是这一层：有账本就不碰副本，因此不会被保留上限砍掉的尾巴骗到。
      const projected = await projectTaskDriverUsage(runsRoot, 'task_wired');
      expect(projected).toMatchObject({
        available: true,
        metric: 'context_tokens_used',
        context_tokens_used: 68_645,
        reported_costs: [{ amount: 1.663, currency: 'USD' }],
        complete: true,
      });
      expect(projected.sessions).toHaveLength(1);
    } finally {
      finish();
      await waitFor(() => service.getSnapshot('run_wired')?.status === 'completed');
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function completedResult(): IntegrationV0Result {
  return {
    run_id: 'run_wired',
    task_id: 'task_wired',
    summary: { status: 'completed' },
    frontend_snapshot: {
      snapshot_type: 'coordinator.frontend_run_snapshot.v0',
      schema_version: 'v0',
      generated_at: '2026-09-29T16:14:30.000Z',
      run_id: 'run_wired',
      task_id: 'task_wired',
      current: { stage: 'delivery', task_status: 'completed', active_node_code: 'N18' },
      run: {
        run_id: 'run_wired',
        task_id: 'task_wired',
        status: 'completed',
        mode: 'single_agent',
        driver_id: 'mock-driver',
        session_id: 'session_impl',
        created_at: '2026-09-29T16:14:00.000Z',
      },
      flow: { active_node_code: 'N18', node_statuses: [] },
      timeline: [],
      delivery_report: {
        worktree_path: '.newide/worktrees/task_wired',
        files_written: [],
        changed_files: [],
        artifacts_materialized: 0,
        outcome: 'completed_response',
        response: 'Completed.',
        session_id: 'session_impl',
        tool_events: [],
        driver_diagnostics: { driver_id: 'mock-driver', duration_ms: 1 },
      },
      artifacts: [],
      checkpoint: {} as never,
      mailbox: { thread_id: 'run_wired', message_refs: [], messages: [] },
      market: {
        winner_agent_id: 'role_fullstack_engineer',
        winner_bid_id: 'bid_1',
        ledger_ref: 'file:///market/ledger.json',
        audit_ref: 'file:///market/audit.json',
        policy_version: 'market-v0',
        seed: 'run_wired',
      },
      links: {} as never,
    },
  } as IntegrationV0Result;
}
