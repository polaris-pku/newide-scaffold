/**
 * `withLiveObservation` 这一层的服务级验证。
 *
 * 这是本轮补上的**覆盖缺口**：P1 的 `usage`、P4 的 `activity`、以及本轮 `activity.agents[].driver`
 * 都挂在这一个私有组装点上，此前只有 typecheck 与投影单测兜着——而「投影对」不等于「接上了」。
 * 造一个**真的停在进行中**的 run（executor 挂在一个 deferred 上）就能在飞行中读一次快照。
 *
 * 两条路径都测，因为它们的基座不同：
 * - **legacy**：没有 processor，基座是 registry 投影；
 * - **task-loop**：基座是**持久快照**（生产环境走的就是这条），于是顺带钉住 P5 × B6 的交互
 *   ——driver 状态类事件现在同时存在于 SQLite timeline 与存活期 registry，两条通道对同一个
 *   `event_id` 必须给出同一个 `sequence`，且 timeline 里不能出现重复事件。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import type { CoordinatorRunRequest } from '../../src/coordinator/coordinator-runner';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { InMemoryRunRegistry } from '../../src/app/run-registry';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import { FileRunRequestStore } from '../../src/app/run-request-store';
import { NoopDriverStreamAuditWriter } from '../../src/app/driver-stream-audit-writer';
import {
  TaskExecutionLoop,
  TaskProcessor,
  type TaskExecutionLoopExecutors,
} from '../../src/coordination';
import { FileRunEvidenceStore, SqliteCoordinationStore } from '../../src/persistence';
import {
  FileRunEventConsumptionSink,
  FileRunTelemetryJsonlSink,
  beginAgentActivity,
  endAgentActivity,
  recordProxyLlmUsage,
  resetAgentActivities,
} from '../../src/telemetry';
import type { DriverStreamEvent } from '../../src/driver/contract';

const ROLE = 'role_backend_engineer';

function driverStreamEvent(
  eventType: string,
  payload: unknown,
  sequence: number,
  identity: { run_id: string; task_id: string },
): DriverStreamEvent {
  return {
    schema_version: 'driver-event.v1',
    event_type: eventType,
    task_id: identity.task_id,
    run_id: identity.run_id,
    role_id: ROLE,
    session_id: 'session_live',
    sequence,
    created_at: '2026-10-03T00:00:00.000Z',
    payload,
  };
}

function toolCall(identity: { run_id: string; task_id: string }): DriverStreamEvent {
  return driverStreamEvent(
    'tool_call',
    {
      sessionId: 'session_live',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_live',
        title: 'Edit src/a.ts',
        kind: 'edit',
        _meta: { claudeCode: { toolName: 'Edit' } },
      },
    },
    1,
    identity,
  );
}

async function waitFor(predicate: () => boolean, label: string, attempts = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition was never met: ${label}`);
}

describe('withLiveObservation —— legacy 路径的实时组装', () => {
  it('attaches usage and both halves of activity to a live snapshot', async () => {
    resetAgentActivities();
    let finish: ((result: IntegrationV0Result) => void) | undefined;
    const runnerResult = new Promise<IntegrationV0Result>((resolve) => {
      finish = resolve;
    });
    const identity = { run_id: 'run_live_legacy', task_id: 'task_live_legacy' };
    let emitted = false;
    const service = new NewideBackendService({
      run: async (request: CoordinatorRunRequest) => {
        request.onRunCreated?.(identity);
        request.onDriverEvent?.(driverStreamEvent('driver.turn_started', { prompt_length: 1 }, 0, identity));
        request.onDriverEvent?.(toolCall(identity));
        // proxy 用量只写存活期 registry（不落 SQLite），所以 `usage` 这一块只有
        // 「本进程持有该 run」时才补得上——这正是要验的组装点。
        await request.telemetry?.emit({
          telemetry_id: 'telemetry_live',
          event_type: 'proxy.llm_usage_recorded',
          owner: 'B-owned-observed',
          subject_id: 'llm_call_live',
          run_id: identity.run_id,
          task_id: identity.task_id,
          payload: { input_tokens: 100, output_tokens: 10 },
          created_at: '2026-10-03T00:00:01.000Z',
          schema_version: 'v0',
        });
        emitted = true;
        return runnerResult;
      },
    });

    try {
      await service.createRun({
        prompt: 'live legacy observation',
        workspace_path: process.cwd(),
        task_id: identity.task_id,
      });
      await waitFor(() => emitted, 'driver events emitted');
      beginAgentActivity({
        run_id: identity.run_id,
        role_id: ROLE,
        kind: 'invoking_driver',
        tool_name: 'invoke_driver',
      });

      const snapshot = service.getRunSnapshot(identity.run_id);

      expect(snapshot.activity?.agents[0]).toMatchObject({
        role_id: ROLE,
        state: 'delegating',
        driver: {
          state: 'tool_running',
          tool_call_id: 'tc_live',
          tool_name: 'Edit',
          tool_kind: 'edit',
          tool_title: 'Edit src/a.ts',
        },
      });
      // `usage` 与 `activity` 挂在同一个组装点上，所以这里顺带证明那个点真的被执行了。
      expect(snapshot.usage?.billed?.by_source.proxy).toMatchObject({
        total_tokens: 110,
        call_count: 1,
      });
    } finally {
      endAgentActivity({ run_id: identity.run_id, role_id: ROLE });
      resetAgentActivities();
      finish?.(completedResult(identity.run_id, identity.task_id));
      await waitFor(
        () => service.getSnapshot(identity.run_id).status === 'completed',
        'legacy run terminal',
      );
    }
  }, 20_000);

  it('leaves usage and activity absent when there is nothing to report', async () => {
    resetAgentActivities();
    let finish: ((result: IntegrationV0Result) => void) | undefined;
    const runnerResult = new Promise<IntegrationV0Result>((resolve) => {
      finish = resolve;
    });
    const identity = { run_id: 'run_live_bare', task_id: 'task_live_bare' };
    const service = new NewideBackendService({
      run: async (request: CoordinatorRunRequest) => {
        request.onRunCreated?.(identity);
        return runnerResult;
      },
    });

    try {
      await service.createRun({
        prompt: 'nothing observed yet',
        workspace_path: process.cwd(),
        task_id: identity.task_id,
      });

      const snapshot = service.getRunSnapshot(identity.run_id);

      // 没有在飞状态就整个字段缺席——不编一个空闲，也不编 0。
      expect(snapshot.activity).toBeUndefined();
      expect(snapshot.usage).toBeUndefined();
    } finally {
      finish?.(completedResult(identity.run_id, identity.task_id));
      await waitFor(
        () => service.getSnapshot(identity.run_id).status === 'completed',
        'bare run terminal',
      );
    }
  }, 20_000);
});

describe('withLiveObservation —— task-loop 路径（持久快照 + 存活期观察）', () => {
  it('folds driver state from the live stream and keeps one sequence per event id', async () => {
    resetAgentActivities();
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'run-live-observation-'));
    const store = new SqliteCoordinationStore(path.join(runsRoot, 'coordination.sqlite'));
    const processor = new TaskProcessor(store);
    let releaseStage!: () => void;
    const stageGate = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    let entered: { run_id: string; task_id: string } | undefined;
    let emitted = false;

    const executors: TaskExecutionLoopExecutors = {
      select_agent: {
        execute: async () => ({
          winner_agent_id: ROLE,
          evidence: { winner_agent_id: ROLE },
        }),
      },
      execute_agent: {
        execute: async (context) => {
          const identity = { run_id: context.run_id, task_id: context.task_id };
          entered = identity;
          context.on_driver_event?.(driverStreamEvent('driver.turn_started', { prompt_length: 1 }, 0, identity));
          context.on_driver_event?.(toolCall(identity));
          await recordProxyLlmUsage({ input_tokens: 100, output_tokens: 10, model: 'fake-model' });
          emitted = true;
          await stageGate;
          return {
            changeset_ref: 'artifact_primary_changeset',
            expected_sha256: 'd'.repeat(64),
            agent_id: ROLE,
            session_id: 'session_primary',
            evidence: { response: 'done' },
          };
        },
      },
      council: {
        execute: async () => {
          throw new Error('single_agent run must not reach the Council stage');
        },
      },
      gate: { execute: async () => ({ evidence: { status: 'skipped' } }) },
      deliver: {
        execute: async (context) => ({
          final_output: {
            artifact_ref: context.cursor_input.changeset_ref,
            sha256: context.cursor_input.expected_sha256,
            workspace_path: '/workspace/result.ts',
          },
          evidence: { files_written: ['result.ts'] },
        }),
      },
    };

    const loop = new TaskExecutionLoop({
      processor,
      evidence_store: new FileRunEvidenceStore({ root: runsRoot }),
      executors,
    });
    const service = new NewideBackendService(
      undefined,
      new InMemoryRunRegistry(),
      new FileRunAuditWriter(runsRoot),
      new FileRunTerminalOutputWriter(runsRoot),
      new FileRunRequestStore(runsRoot),
      processor,
      undefined,
      undefined,
      undefined,
      undefined,
      new NoopDriverStreamAuditWriter(),
      loop,
      undefined,
      undefined,
      undefined,
      undefined,
      new FileRunEventConsumptionSink(runsRoot),
      new FileRunTelemetryJsonlSink(runsRoot),
    );

    try {
      const created = await service.createTask({
        spec: 'live observation over the durable path',
        role_id: ROLE,
        completion_criteria: ['usage and activity are attached'],
        workspace_path: process.cwd(),
        mode: 'single_agent',
      });
      const runId = created.current_run?.run_id ?? '';
      await waitFor(() => emitted && entered !== undefined, 'execute_agent reached its driver call');
      beginAgentActivity({
        run_id: runId,
        role_id: ROLE,
        kind: 'invoking_driver',
        tool_name: 'invoke_driver',
      });

      const snapshot = service.getRunSnapshot(runId);

      // ① 基座是持久快照（生产环境如此），但在飞状态与用量由这一层补挂。
      expect(snapshot.status).toBe('running');
      expect(snapshot.activity?.agents[0]).toMatchObject({
        role_id: ROLE,
        state: 'delegating',
        driver: { state: 'tool_running', tool_name: 'Edit' },
      });
      expect(snapshot.usage?.billed?.by_source.proxy).toMatchObject({
        total_tokens: 110,
        call_count: 1,
      });
      // 而且必须说清「还差哪条腿」：driver 计费腿要等收尾刮 session JSONL 才出生，所以运行中
      // 只可能有 proxy 腿。实测一次真实 run 里缺的那条是总量的 96%。
      expect(snapshot.usage?.billed?.pending_sources).toEqual(['claude_session_jsonl']);

      // ② P5 × B6：driver 事件现在同时存在于 SQLite timeline 与存活期 registry，
      // 两条通道对同一个 `event_id` 必须是同一个 `sequence`（对齐模块存在的理由）。
      const live = service.getSnapshot(runId);
      const liveSequence = new Map(live.events.map((event) => [event.event_id, event.sequence]));
      const ids = snapshot.timeline.map((event) => event.event_id);
      expect(new Set(ids).size).toBe(ids.length);
      const driverTimeline = snapshot.timeline.filter((event) =>
        event.type.startsWith('driver.'),
      );
      // 持久 timeline 里确实带着 driver 状态类事件（P5 的产出），否则下面的断言是空转。
      expect(driverTimeline.map((event) => event.type)).toEqual(
        expect.arrayContaining(['driver.turn_started', 'driver.tool_started']),
      );
      for (const event of driverTimeline) {
        expect(liveSequence.get(event.event_id)).toBe(event.sequence);
      }
    } finally {
      endAgentActivity({ run_id: entered?.run_id ?? '', role_id: ROLE });
      resetAgentActivities();
      releaseStage();
      await waitFor(
        () => processor.getRunSnapshot(entered?.run_id ?? '')?.status !== 'running',
        'task-loop run terminal',
      );
      await service.close().catch(() => undefined);
      try {
        store.close();
      } catch {
        // 清理尽力而为。
      }
      await rm(runsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
        () => undefined,
      );
    }
  }, 20_000);
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
        winner_agent_id: ROLE,
        winner_bid_id: 'bid_1',
        ledger_ref: 'file:///market/ledger.json',
        audit_ref: 'file:///market/audit.json',
        policy_version: 'market-v0',
        seed: runId,
      },
      links: {} as never,
    },
  // 测试替身刻意只给服务真正读到的那些字段；完整类型断言不是这里要验的东西。
  } as unknown as IntegrationV0Result;
}
