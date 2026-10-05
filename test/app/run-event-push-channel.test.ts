/**
 * 推流通道的分流（§7.6 决策 B，2026-10-03 拍板）。
 *
 * `run.event`（`run.subscribe`）与 `task.subscribe` 是前端实时看运行的两条通道。它们此前
 * **逐条转发每一个 registry 追加**，包括 driver 的流式片段——实测一个 council run 的片段
 * 可达 1.6 万条、`audit.jsonl` 8.9 MB。现在片段不发，状态类照发。
 *
 * 本文件守四件事：
 * 1. **状态类仍然发**：分流不是「把 driver 事件全砍掉」，「在跑哪个 turn / 哪个工具」必须完整；
 * 2. **片段不发**：两条通道都不发；
 * 3. **审计仍然全量**：过滤只作用于推流，`audit.jsonl` 一条都不能少——否则这不是分流，
 *    是丢信息；
 * 4. **水位仍在**：`after_sequence` 断线重连不受分流影响。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import type { CoordinatorRunRequest } from '../../src/coordinator/coordinator-runner';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { InMemoryRunRegistry, type AppRunEvent } from '../../src/app/run-registry';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import { FileRunRequestStore } from '../../src/app/run-request-store';
import { NoopDriverStreamAuditWriter } from '../../src/app/driver-stream-audit-writer';
import { isStreamFragment } from '../../src/app/driver-stream-projection';
import type { DriverStreamEvent } from '../../src/driver/contract';

const RUN_ID = 'run_push_channel';
const TASK_ID = 'task_push_channel';
const IDENTITY = { run_id: RUN_ID, task_id: TASK_ID };

function driverEvent(eventType: string, payload: unknown, sequence: number): DriverStreamEvent {
  return {
    schema_version: 'driver-event.v1',
    event_type: eventType,
    task_id: TASK_ID,
    run_id: RUN_ID,
    role_id: 'role_a',
    session_id: 'session_push',
    sequence,
    created_at: '2026-10-03T00:00:00.000Z',
    payload,
  };
}

function chunk(text: string, sequence: number): DriverStreamEvent {
  return driverEvent(
    'agent_thought_chunk',
    { sessionId: 'session_push', update: { sessionUpdate: 'agent_thought_chunk', content: text } },
    sequence,
  );
}

/** 一条状态类 + 两条片段：分流后前端该看到 1 条，审计该看到 3 条。 */
const EVENTS: DriverStreamEvent[] = [
  driverEvent('driver.turn_started', { prompt_length: 1 }, 1),
  chunk('思考 1', 2),
  chunk('思考 2', 3),
];

async function waitFor(predicate: () => boolean, label: string, attempts = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition was never met: ${label}`);
}

interface PushFixture {
  service: NewideBackendService;
  runsRoot: string;
  /** 放行 runner 桩去发 driver 事件：先订阅、后发，才能验到「实时推流」而不是只有重放。 */
  release: () => void;
  /** 让 runner 返回终态结果——要在用例里读落盘产物时用（helper 的 finally 也会调，重复调用无副作用）。 */
  finish: () => void;
}

async function withService(run: (fixture: PushFixture) => Promise<void>): Promise<void> {
  const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'run-push-channel-'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finish!: (result: IntegrationV0Result) => void;
  const runnerResult = new Promise<IntegrationV0Result>((resolve) => {
    finish = resolve;
  });
  const service = new NewideBackendService(
    {
      run: async (request: CoordinatorRunRequest) => {
        request.onRunCreated?.(IDENTITY);
        await gate;
        for (const event of EVENTS) request.onDriverEvent?.(event);
        return runnerResult;
      },
    },
    new InMemoryRunRegistry(),
    new FileRunAuditWriter(runsRoot),
    new FileRunTerminalOutputWriter(runsRoot),
    new FileRunRequestStore(runsRoot),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new NoopDriverStreamAuditWriter(),
  );
  try {
    await service.createRun({
      prompt: 'push channel',
      workspace_path: process.cwd(),
      task_id: TASK_ID,
    });
    await run({ service, runsRoot, release, finish: () => finish(completedResult()) });
  } finally {
    finish(completedResult());
    await waitFor(() => service.getSnapshot(RUN_ID).status === 'completed', 'run terminal');
    await rm(runsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
      () => undefined,
    );
  }
}

async function auditTypes(runsRoot: string): Promise<string[]> {
  const raw = await readFile(path.join(runsRoot, RUN_ID, 'audit.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

describe('推流通道（决策 B）', () => {
  it('sends state-class driver events and holds back the fragments on run.subscribe', async () => {
    await withService(async ({ service, release }) => {
      const live: AppRunEvent[] = [];
      const unsubscribe = service.subscribe(RUN_ID, (event) => live.push(event));
      release();
      await waitFor(() => live.some((event) => event.type === 'driver.turn_started'), 'first push');

      const types = live.map((event) => event.type);
      // 状态类照发：「在跑哪个 turn / 哪个工具」在订阅通道上必须完整。
      expect(types).toContain('driver.turn_started');
      // 片段不发。
      expect(types).not.toContain('driver.agent_thought_chunk');
      expect(types.filter((type) => type.endsWith('_chunk'))).toEqual([]);
      unsubscribe();
    });
  }, 20_000);

  it('holds back the fragments on task.subscribe too, and only there', async () => {
    await withService(async ({ service, release }) => {
      const pushed: AppRunEvent[] = [];
      const subscription = await service.subscribeTask(TASK_ID, (event) => pushed.push(event));
      release();
      await waitFor(
        () => pushed.some((event) => event.type === 'driver.turn_started'),
        'first task push',
      );

      const types = pushed.map((event) => event.type);
      expect(types).toContain('driver.turn_started');
      expect(types.filter((type) => type.endsWith('_chunk'))).toEqual([]);
      // 快照 timeline 与推流走**同一条判据**：片段有它自己的有界保留（存活期折叠要用），
      // 但不在状态 timeline 上——否则每个重 run 的 timeline.json / result.json 又会到 13–18 MB。
      const retained = service.getSnapshot(RUN_ID).events.map((event) => event.type);
      expect(retained).toContain('driver.turn_started');
      expect(retained).not.toContain('driver.agent_thought_chunk');
      subscription.unsubscribe();
    });
  }, 20_000);

  it('keeps audit.jsonl complete — filtering must never mean losing information', async () => {
    await withService(async ({ service, runsRoot, release }) => {
      const live: AppRunEvent[] = [];
      const unsubscribe = service.subscribe(RUN_ID, (event) => live.push(event));
      release();
      await waitFor(() => live.length > 0, 'push observed');

      // 审计文件是**无保留上限**的那份完整记录，片段必须一条不少地落在上面。
      const types = await waitForAudit(runsRoot);
      expect(types).toContain('driver.turn_started');
      expect(types).toContain('driver.agent_thought_chunk');
      expect(types.filter((type) => type === 'driver.agent_thought_chunk')).toHaveLength(2);
      unsubscribe();
    });
  }, 20_000);

  it('keeps fragments out of the terminal artifacts too (the 13–18 MB regression guard)', async () => {
    await withService(async ({ service, release, finish, runsRoot }) => {
      const live: AppRunEvent[] = [];
      const unsubscribe = service.subscribe(RUN_ID, (event) => live.push(event));
      release();
      await waitFor(() => live.length > 0, 'push observed');
      unsubscribe();

      // 终态产物是从 registry 快照投出来的：片段留在快照 timeline 里的话，
      // `timeline.json` / `frontend-snapshot.json` / `result.json` 会各自被撑到十几 MB（实测）。
      finish();
      await waitFor(() => service.getSnapshot(RUN_ID).status === 'completed', 'run terminal');

      const timeline = JSON.parse(
        await readFile(path.join(runsRoot, RUN_ID, 'timeline.json'), 'utf8'),
      ) as Array<{ type: string }>;
      expect(timeline.map((event) => event.type)).toContain('driver.turn_started');
      expect(timeline.filter((event) => event.type.endsWith('_chunk'))).toEqual([]);

      const result = JSON.parse(
        await readFile(path.join(runsRoot, RUN_ID, 'result.json'), 'utf8'),
      ) as { timeline: Array<{ type: string }> };
      expect(result.timeline.map((event) => event.type)).toContain('driver.turn_started');
      expect(result.timeline.filter((event) => event.type.endsWith('_chunk'))).toEqual([]);
    });
  }, 20_000);

  it('still honours the after_sequence watermark', async () => {
    await withService(async ({ service, release }) => {
      const all: AppRunEvent[] = [];
      const unsubscribe = service.subscribe(RUN_ID, (event) => all.push(event));
      release();
      await waitFor(() => all.some((event) => event.type === 'driver.turn_started'), 'first push');
      unsubscribe();

      const turnStarted = all.find((event) => event.type === 'driver.turn_started');
      expect(turnStarted).toBeDefined();
      const resumed: AppRunEvent[] = [];
      const stop = service.subscribe(
        RUN_ID,
        (event) => resumed.push(event),
        turnStarted?.sequence,
      );
      // 水位之后的推流内容里没有新的状态类事件，所以补不到东西——而不是补一堆片段。
      expect(resumed.map((event) => event.type)).not.toContain('driver.agent_thought_chunk');
      stop();
    });
  }, 20_000);

  it('classifies every driver type through one table (drift guard)', () => {
    expect(isStreamFragment('driver.turn_started')).toBe(false);
    expect(isStreamFragment('driver.tool_completed')).toBe(false);
    expect(isStreamFragment('driver.phase')).toBe(false);
    expect(isStreamFragment('driver.agent_thought_chunk')).toBe(true);
    expect(isStreamFragment('driver.stderr')).toBe(true);
    expect(isStreamFragment('driver.session_update_unknown')).toBe(true);
    // 非 driver 事件一律不算片段（表外类型走 coordination 默认通道）。
    expect(isStreamFragment('handler.started')).toBe(false);
    expect(isStreamFragment('proxy.llm_usage_recorded')).toBe(false);
  });
});

/** 审文件是异步追加的（fire-and-forget），等片段都写进去再读。 */
async function waitForAudit(runsRoot: string): Promise<string[]> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const types = await auditTypes(runsRoot).catch(() => [] as string[]);
    if (types.filter((type) => type === 'driver.agent_thought_chunk').length >= 2) return types;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return auditTypes(runsRoot);
}

function completedResult(): IntegrationV0Result {
  return {
    run_id: RUN_ID,
    task_id: TASK_ID,
    summary: { status: 'completed' },
    frontend_snapshot: {
      snapshot_type: 'coordinator.frontend_run_snapshot.v0',
      schema_version: 'v0',
      generated_at: '2026-07-11T08:00:00.000Z',
      run_id: RUN_ID,
      task_id: TASK_ID,
      current: { stage: 'delivery', task_status: 'completed', active_node_code: 'N18' },
      run: {
        run_id: RUN_ID,
        task_id: TASK_ID,
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
      mailbox: { thread_id: RUN_ID, message_refs: [], messages: [] },
      market: {
        winner_agent_id: 'role_a',
        winner_bid_id: 'bid_1',
        ledger_ref: 'file:///market/ledger.json',
        audit_ref: 'file:///market/audit.json',
        policy_version: 'market-v0',
        seed: RUN_ID,
      },
      links: {} as never,
    },
  } as unknown as IntegrationV0Result;
}
