/**
 * driver 流事件的分流：状态类进协调事件流，片段类只留审计文件。
 *
 * 这一层此前不存在——driver 投影事件只进进程内 registry 与 `audit.jsonl`
 * / `driver-stream.jsonl`，**不进协调事件流**，于是进程重启后同一个 run 的持久
 * snapshot 里 driver 那一段整个消失。本文件钉住四件事：
 *
 *   1. **接线**：走真实的服务路径（阶段上下文 → `on_driver_event` → 投影 → 分流），
 *      状态类事件确实落进了 SQLite 事件表；
 *   2. **片段不进**：chunk 类事件一条都不落库——实测它们占 driver 流 98.4% 的行；
 *   3. **重启后仍在**：换一个新的 store + processor 读同一个库，driver 状态还在；
 *   4. **失败不外抛**：run 已终态后再来一条迟到事件，既不抛错也不落库。
 *
 * 归类事实只有 `NAMED_CASES` / `PASS_THROUGH_CASES` 两张表。它们同时驱动分类断言与
 * 真实 run 的事件注入，所以「测试说的分类」与「跑起来真的注入的分类」不可能是两回事。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { InMemoryRunRegistry } from '../../src/app/run-registry';
import { FileRunRequestStore } from '../../src/app/run-request-store';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import { NoopDriverStreamAuditWriter } from '../../src/app/driver-stream-audit-writer';
import {
  DRIVER_STREAM_CHANNELS,
  driverStreamChannel,
  projectDriverStreamLifecycleEvent,
  type DriverStreamChannel,
} from '../../src/app/driver-stream-projection';
import {
  TaskExecutionLoop,
  TaskProcessor,
  type TaskExecutionLoopExecutors,
} from '../../src/coordination';
import { FileRunEvidenceStore, SqliteCoordinationStore } from '../../src/persistence';
import { FileRunEventConsumptionSink, FileRunTelemetryJsonlSink } from '../../src/telemetry';
import type { DriverStreamEvent } from '../../src/driver/contract';

const TASK_SPEC = 'driver persistence';

function streamEvent(
  eventType: string,
  payload: unknown,
  sequence: number,
  identity: { run_id?: string; task_id?: string } = {},
): DriverStreamEvent {
  return {
    schema_version: 'driver-event.v1',
    event_type: eventType,
    ...(identity.task_id !== undefined ? { task_id: identity.task_id } : {}),
    ...(identity.run_id !== undefined ? { run_id: identity.run_id } : {}),
    session_id: 'session_driver_persistence',
    sequence,
    created_at: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

/** ACP 推送信封：`session/update` 的家。 */
function sessionUpdate(sessionUpdateName: string, update: Record<string, unknown>): unknown {
  return {
    sessionId: 'session_driver_persistence',
    update: { sessionUpdate: sessionUpdateName, ...update },
  };
}

interface DriverStreamCase {
  /** driver 侧输入的事件名（ACP 的 `session/update` 名，或 driver 自产名）。 */
  input: string;
  payload: unknown;
  /** 投影出来的领域事件类型。 */
  projected: string;
  channel: DriverStreamChannel;
}

/**
 * 每个「投影器能命名」的输入都在这里表态。新增一个投影分支而忘了在
 * `DRIVER_STREAM_CHANNELS` 里归类，本文件会红——这就是防漂移的机制。
 */
const NAMED_CASES: DriverStreamCase[] = [
  { input: 'driver.turn_started', payload: { prompt_length: 1 }, projected: 'driver.turn_started', channel: 'coordination' },
  { input: 'turn_started', payload: { prompt_length: 1 }, projected: 'driver.turn_started', channel: 'coordination' },
  { input: 'driver.turn_completed', payload: { stop_reason: 'end_turn' }, projected: 'driver.turn_completed', channel: 'coordination' },
  { input: 'turn_completed', payload: { update: { stopReason: 'end_turn' } }, projected: 'driver.turn_completed', channel: 'coordination' },
  { input: 'driver.turn_failed', payload: { error: 'boom' }, projected: 'driver.turn_failed', channel: 'coordination' },
  { input: 'turn_failed', payload: { update: { reason: 'boom' } }, projected: 'driver.turn_failed', channel: 'coordination' },
  { input: 'driver.interrupt_requested', payload: { reason: 'cancelled' }, projected: 'driver.interrupt_requested', channel: 'coordination' },
  { input: 'tool_call', payload: sessionUpdate('tool_call', { toolCallId: 'tc_1' }), projected: 'driver.tool_started', channel: 'coordination' },
  { input: 'tool_call_update', payload: sessionUpdate('tool_call_update', { toolCallId: 'tc_1', status: 'completed' }), projected: 'driver.tool_completed', channel: 'coordination' },
  { input: 'tool_call_update', payload: sessionUpdate('tool_call_update', { toolCallId: 'tc_1', status: 'failed' }), projected: 'driver.tool_failed', channel: 'coordination' },
  { input: 'tool_call_update', payload: sessionUpdate('tool_call_update', { toolCallId: 'tc_1', status: 'in_progress' }), projected: 'driver.tool_progress', channel: 'stream_only' },
  { input: 'agent_message_chunk', payload: sessionUpdate('agent_message_chunk', { content: 'x' }), projected: 'driver.agent_message_chunk', channel: 'stream_only' },
  { input: 'agent_thought_chunk', payload: sessionUpdate('agent_thought_chunk', { content: 'x' }), projected: 'driver.agent_thought_chunk', channel: 'stream_only' },
  { input: 'user_message_chunk', payload: sessionUpdate('user_message_chunk', { content: 'x' }), projected: 'driver.user_message_chunk', channel: 'stream_only' },
  { input: 'plan', payload: sessionUpdate('plan', { entries: [] }), projected: 'driver.plan_updated', channel: 'coordination' },
  { input: 'available_commands_update', payload: sessionUpdate('available_commands_update', { availableCommands: [] }), projected: 'driver.available_commands_updated', channel: 'coordination' },
  { input: 'current_mode_update', payload: sessionUpdate('current_mode_update', { currentModeId: 'plan' }), projected: 'driver.mode_changed', channel: 'coordination' },
  { input: 'config_option_update', payload: sessionUpdate('config_option_update', { configOptions: [] }), projected: 'driver.config_options_changed', channel: 'coordination' },
  { input: 'session_info_update', payload: sessionUpdate('session_info_update', { title: 't' }), projected: 'driver.session_info_changed', channel: 'coordination' },
  { input: 'usage_update', payload: sessionUpdate('usage_update', { used: 1, size: 2 }), projected: 'driver.usage_updated', channel: 'coordination' },
  { input: 'stderr', payload: 'boom', projected: 'driver.stderr', channel: 'stream_only' },
  { input: 'disconnect', payload: { code: 0, signal: null }, projected: 'driver.disconnected', channel: 'coordination' },
  { input: 'brand_new_update', payload: sessionUpdate('brand_new_update', { fancy: true }), projected: 'driver.session_update_unknown', channel: 'stream_only' },
];

/**
 * 走投影默认分支的输入：投影器原样透传 driver 自产的名字。实测生产者来自外部
 * ACP 仓的 `contract-runner`。
 */
const PASS_THROUGH_CASES: DriverStreamCase[] = [
  { input: 'driver.phase', payload: { phase: 'session' }, projected: 'driver.phase', channel: 'coordination' },
  { input: 'driver.turn_cancel_requested', payload: { reason: 'process_signal' }, projected: 'driver.turn_cancel_requested', channel: 'coordination' },
  { input: 'driver.turn_cancel_failed', payload: { error: 'x' }, projected: 'driver.turn_cancel_failed', channel: 'coordination' },
  { input: 'driver.event_collection_failed', payload: { error: 'x' }, projected: 'driver.event_collection_failed', channel: 'coordination' },
];

const ALL_CASES = [...NAMED_CASES, ...PASS_THROUGH_CASES];
const COORDINATION_CASES = ALL_CASES.filter((entry) => entry.channel === 'coordination');
const STREAM_ONLY_CASES = ALL_CASES.filter((entry) => entry.channel === 'stream_only');

function project(input: DriverStreamCase) {
  return projectDriverStreamLifecycleEvent(
    streamEvent(input.input, input.payload, 1, { run_id: 'run_1', task_id: 'task_1' }),
  );
}

interface Fixture {
  runsRoot: string;
  databasePath: string;
  store: SqliteCoordinationStore;
  processor: TaskProcessor;
  service: NewideBackendService;
  /** 阶段上下文里那个真实回调，供「迟到事件」用例在 run 终态后使用。 */
  lateEmitter: { current?: ((event: DriverStreamEvent) => void) | undefined };
  dispose: () => Promise<void>;
}

async function createFixture(options: { emitDriverEvents?: boolean } = {}): Promise<Fixture> {
  const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'driver-stream-persistence-'));
  const databasePath = path.join(runsRoot, 'coordination.sqlite');
  const store = new SqliteCoordinationStore(databasePath);
  const processor = new TaskProcessor(store);
  const lateEmitter: Fixture['lateEmitter'] = {};

  const executors: TaskExecutionLoopExecutors = {
    select_agent: {
      execute: async () => ({
        winner_agent_id: 'agent_a',
        evidence: { winner_agent_id: 'agent_a' },
      }),
    },
    execute_agent: {
      execute: async (context) => {
        if (options.emitDriverEvents) {
          lateEmitter.current = context.on_driver_event;
          // 注入**全部**输入（含片段类）而不只是挑几条：cursorAfterEvent 里任何一条
          // driver 名字意外地推进游标，这个 run 都走不到终态，用例当场变红。
          let sequence = 0;
          for (const entry of ALL_CASES) {
            sequence += 1;
            context.on_driver_event?.(streamEvent(entry.input, entry.payload, sequence));
          }
        }
        return {
          changeset_ref: 'artifact_primary_changeset',
          expected_sha256: 'd'.repeat(64),
          agent_id: 'agent_a',
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

  return {
    runsRoot,
    databasePath,
    store,
    processor,
    service,
    lateEmitter,
    dispose: async () => {
      await service.close().catch(() => undefined);
      try {
        store.close();
      } catch {
        // 已经关过就算了；清理是尽力而为。
      }
      // Windows 上 SQLite 的 -wal 句柄释放会比 close() 晚一拍，重试而不是当场失败。
      await rm(runsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
        () => undefined,
      );
    },
  };
}

/** 等 run 在协调层到达终态——迟到事件用例必须建立在「已经终态」之上。 */
async function waitForTerminalRun(processor: TaskProcessor, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (processor.getRunSnapshot(runId)?.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} never reached a terminal status`);
}

async function createRun(fixture: Fixture): Promise<{ taskId: string; runId: string }> {
  const created = await fixture.service.createTask({
    spec: TASK_SPEC,
    role_id: 'role_backend_engineer',
    completion_criteria: ['driver state is observable'],
    workspace_path: process.cwd(),
    mode: 'single_agent',
  });
  const runId = created.current_run?.run_id ?? '';
  await waitForTerminalRun(fixture.processor, runId);
  return { taskId: created.task.task_id, runId };
}

function persistedTypes(processor: TaskProcessor, taskId: string): string[] {
  return processor.listTaskEvents(taskId).map((event) => event.type);
}

describe('driver 流事件分流 —— 状态类进协调事件流', () => {
  it('状态类事件落库（run 仍能走完），片段类一条都不落库', async () => {
    const fixture = await createFixture({ emitDriverEvents: true });
    try {
      const { taskId } = await createRun(fixture);
      const types = persistedTypes(fixture.processor, taskId);

      // ① 全部状态类都在库里——包括 driver 自产的 `driver.*`（投影默认分支）。
      expect(COORDINATION_CASES.map((entry) => entry.projected).filter(
        (type) => !types.includes(type),
      )).toEqual([]);
      // ② 六类可合并片段一条都不许在库里。这是本轮最要紧的负向断言。
      expect(STREAM_ONLY_CASES.map((entry) => entry.projected).filter(
        (type) => types.includes(type),
      )).toEqual([]);
      expect(types.filter((type) => type.endsWith('_chunk'))).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  }, 20_000);

  it('换一个 store + processor 读同一个库，driver 状态仍然在 timeline 上', async () => {
    const fixture = await createFixture({ emitDriverEvents: true });
    try {
      const { taskId, runId } = await createRun(fixture);

      // 真正的「重启」：新开一个 store 读同一个库文件。
      const reopenedStore = new SqliteCoordinationStore(fixture.databasePath);
      const restarted = new TaskProcessor(reopenedStore);
      try {
        const restartedTypes = persistedTypes(restarted, taskId);
        expect(restartedTypes).toContain('driver.turn_started');
        expect(restartedTypes).toContain('driver.tool_completed');
        expect(restartedTypes).toContain('driver.phase');

        // 持久 snapshot 的 timeline 也带着它们——这正是本轮要让前端看到的东西。
        const timelineTypes = restarted.getRunSnapshot(runId)?.timeline.map((event) => event.type) ?? [];
        expect(timelineTypes).toContain('driver.turn_started');
        expect(timelineTypes).toContain('driver.tool_completed');
        expect(timelineTypes.filter((type) => type.endsWith('_chunk'))).toEqual([]);
      } finally {
        reopenedStore.close();
      }
    } finally {
      await fixture.dispose();
    }
  }, 20_000);

  it('run 终态后的迟到事件既不抛错也不落库', async () => {
    const fixture = await createFixture({ emitDriverEvents: true });
    try {
      const { taskId } = await createRun(fixture);

      const late = fixture.lateEmitter.current;
      expect(late).toBeTypeOf('function');
      // driver 的子进程 stderr 常常比阶段结束晚一拍，这条路径必须容得下。
      const straggler = { stop_reason: 'late_straggler' };
      expect(() =>
        late?.(streamEvent('driver.turn_completed', straggler, 99)),
      ).not.toThrow();

      // 迟到的那一条没有落库：记的是「这条 run 当时的 driver 状态」，事后补写会让
      // 终态快照随 straggler 到达时间而变。用载荷里的独有标记区分于同名的正常事件。
      const landed = fixture.processor
        .listTaskEvents(taskId)
        .filter((event) => event.payload.stop_reason === 'late_straggler');
      expect(landed).toEqual([]);
      expect(persistedTypes(fixture.processor, taskId)).toContain('driver.turn_started');
    } finally {
      await fixture.dispose();
    }
  }, 20_000);
});

describe('driver 投影类型的通道归类', () => {
  it.each(ALL_CASES)(
    '投影 $input → $projected 归 $channel',
    (entry) => {
      expect(project(entry)?.event_type).toBe(entry.projected);
      // 断言的是**真实导出**的那张表，不是测试自己抄的一份。
      expect(driverStreamChannel(entry.projected)).toBe(entry.channel);
    },
  );

  it('挂进表的类型没有一个是投影器产不出来的（表不能有陈旧条目）', () => {
    const produced = new Set(ALL_CASES.map((entry) => entry.projected));
    const stale = Object.keys(DRIVER_STREAM_CHANNELS).filter((type) => !produced.has(type));
    expect(stale).toEqual([]);
  });

  it('片段类恰好是那六个可合并类型', () => {
    const streamOnly = STREAM_ONLY_CASES.map((entry) => entry.projected).sort();
    expect(streamOnly).toEqual([
      'driver.agent_message_chunk',
      'driver.agent_thought_chunk',
      'driver.session_update_unknown',
      'driver.stderr',
      'driver.tool_progress',
      'driver.user_message_chunk',
    ]);
  });
});
