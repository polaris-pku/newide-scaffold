/**
 * R4-01 生产读取接线的真实回归：`run.getSnapshot` 权威读取必须拿到 Journal 事实。
 *
 * 复审报告（`docs/reports/role-driver-phase4-rereview-2026-11-15.md`）证明的缺陷是：
 * 终态 writer / `persistTerminal` 已经会读 Journal 补齐派工事实，但**生产权威快照读取**
 * （`NewideBackendService.getRunSnapshot`，`run.getSnapshot` 与 CLI 的读取口）没有——
 * 于是同一个 Run 的 `summary.json.dispatch_summary.by_status` 是 `{succeeded:1}`，公开快照
 * 却是 `{unknown:1}`。已有投影器测试手动传 `journal_records`，因此没有覆盖这个缺口。
 *
 * 本文件不再手工传参：它跑**真实的 service 权威路径**——
 *   SQLite（真实磁盘文件）+ 真实 `TaskProcessor` + 真实 `TaskExecutionLoop`（`execute_agent`
 *   里是真实 `RoleAutonomyEngine` + fake driver）+ 真实 `RunDispatchJournal` +
 *   真实 `FileRunTerminalOutputWriter`，最后用公开的 `service.getRunSnapshot` 读取。
 *
 * 场景构造（与复审探针一致，但不手工补快照、不手工补事件）：
 * 1. 引擎正常派工一次并 settled(succeeded) 落 Journal；
 * 2. 只把 `agent.dispatch_settled` 这一条**投影事件**拦掉（模拟事件写盘失败，Journal 已 durable）；
 *    于是 SQLite/timeline 只有 accepted/started，缺 settled；
 * 3. Run 由 TaskProcessor 正常完成，终态 writer 正常执行；
 * 4. 断言终态文件摘要、公开快照、Journal RPC 三处 `by_status` 一致为 `{succeeded:1}`；
 * 5. 重新打开同一 SQLite（空内存 registry）再读，结果一致；
 * 6. driver 调用次数不增加、Journal 行数与 SQLite 事件不因读取而增加（读取不补执行、不改终态）。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core';
import { buildExecutionBrief } from '../../src/driver';
import type { DriverPrompt, DriverRunResult, DriverRuntimeHandle } from '../../src/driver';
import {
  FileRunEvidenceStore,
  RunDispatchJournal,
  SqliteCoordinationStore,
} from '../../src/persistence';
import { TaskExecutionLoop, TaskProcessor } from '../../src/coordination';
import type {
  TaskExecutionLoopExecutors,
  TaskStageExecutionContext,
} from '../../src/coordination';
import type { AgentExecutionResult } from '../../src/protocol/agent-execution';
import type { BufferRepository, MemoryRepository } from '../../src/memory';
import { RoleBudget } from '../../src/app/role-autonomy-budget';
import { RoleAutonomyEngine } from '../../src/app/role-autonomy-engine';
import type {
  RoleDispatchObservation,
  RoleFinishDecision,
  RoleLoopOptions,
  RoleLoopOutcome,
} from '../../src/app/role-autonomy-contract';
import { ROLE_DISPATCH_EVENT } from '../../src/app/run-dispatch-events';
import { emitStageEvent } from '../../src/app/stage-event-emitter';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { InMemoryRunRegistry } from '../../src/app/run-registry';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import { FileRunRequestStore } from '../../src/app/run-request-store';
import { NoopDriverStreamAuditWriter } from '../../src/app/driver-stream-audit-writer';
import { emptyTokenUsageSummary } from '../../src/telemetry';

const ROLE_ID = 'role_backend_engineer';
const FROZEN_AT = '2026-11-13T10:00:00.000Z';
const FROZEN_CLOCK = (): Date => new Date(FROZEN_AT);
const CHANGESET_REF = 'artifact_changeset_authority';
const CHANGESET_SHA = 'd'.repeat(64);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10 })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitFor(predicate: () => boolean, label: string, attempts = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition was never met: ${label}`);
}

function driverResult(): DriverRunResult {
  return {
    driver_run_result_id: 'drr_authority_succeeded',
    session_id: 'session_1',
    status: 'succeeded',
    response: 'settled work',
    artifacts: [],
    transcript_ref: {
      artifact_id: 'artifact_transcript',
      type: 'transcript',
      uri: 'file:///tmp/transcript.json',
      producer_id: 'driver_test',
      created_at: FROZEN_AT,
      schema_version: SCHEMA_VERSION,
    },
    tool_events: [],
    diagnostics: { driver_id: 'driver_test', duration_ms: 5, notes: [] },
    created_at: FROZEN_AT,
    schema_version: SCHEMA_VERSION,
  };
}

interface FakeDriver {
  handle: DriverRuntimeHandle;
  calls: () => number;
}

/** 真实 driver 句柄形状的最小替身：只数调用次数，返回一次成功结果。 */
function makeFakeDriver(): FakeDriver {
  let calls = 0;
  const handle = {
    driver_id: 'driver_test',
    session_id: 'session_1',
    capabilities: { supports_session_load: false },
    interrupt: async () => undefined,
    sendPrompt: async (_input: DriverPrompt) => {
      calls += 1;
      return driverResult();
    },
  } as unknown as DriverRuntimeHandle;
  return { handle, calls: () => calls };
}

function completedOutcome(dispatches: RoleDispatchObservation[]): RoleLoopOutcome {
  return {
    status: 'completed',
    finish: {
      status: 'completed',
      summary: 'done',
      evidence_refs: [],
      unresolved: [],
      role_reflection: '',
      response_only: false,
      verification: [],
      accepted_at: FROZEN_AT,
    },
    response: 'done',
    dispatches,
    usage: { input_tokens: 1, output_tokens: 1, usage_missing: false, role_rounds: 1 },
    zero_dispatch: dispatches.length === 0,
    plan: undefined,
    unresolved_dispatches: [],
  };
}

/**
 * 让 role 在自定义 loop 里显式派一次工（与生产 role loop 的 dispatch 工具同一条路径：
 * 预算检查 → `options.dispatch.run`（真实 Journal 写屏障 + 真实 driver 调用）→ 记账）。
 */
async function dispatchOnce(options: RoleLoopOptions): Promise<RoleDispatchObservation> {
  const built = buildExecutionBrief({
    identity: {
      dispatch_id: 'dsp_authority_1',
      run_id: options.context.run_id,
      task_id: options.context.task_id,
      role_id: options.context.role_id,
      sequence: 1,
      accepted_at: FROZEN_AT,
    },
    request: { kind: 'execute', instruction: 'do the work' },
  });
  options.budget.assertDispatchAllowed();
  const snapshot = options.budget.snapshot();
  const observation = await options.dispatch.run({
    brief: built.brief,
    brief_sha256: built.brief_sha256,
    budget_before: {
      dispatches_left: Math.max(
        0,
        options.budget.frozen.limits.max_dispatches - snapshot.consumed.dispatches,
      ),
      role_tokens_left: options.budget.frozen.limits.role_token_budget,
      deadline_at: options.budget.frozen.deadline_at,
    },
  });
  options.budget.recordDispatch();
  return observation;
}

/** 真实 role 引擎 + 自定义 loop：一次派工、写 finish、返回 completed。 */
function makeEngine(input: { runsRoot: string; driver: FakeDriver }): RoleAutonomyEngine {
  return new RoleAutonomyEngine({
    runs_root: input.runsRoot,
    llm: { completeWithTools: async () => ({ content: null, tool_calls: undefined }) },
    repository: {} as MemoryRepository,
    buffer_repository: {} as BufferRepository,
    driver_for: () => input.driver.handle,
    create_budget: (budgetInput) => new RoleBudget(budgetInput),
    create_finish_validator: () => ({
      validate: async (): Promise<RoleFinishDecision> => ({ accepted: false, gaps: [] }),
    }),
    run_loop: async (options) => {
      const observation = await dispatchOnce(options);
      await options.journal.appendFinish({
        actor: 'role',
        status: 'completed',
        reason: 'done',
        evidence_refs: [],
        summary: 'done',
      });
      return completedOutcome([observation]);
    },
    clock: FROZEN_CLOCK,
  });
}

/**
 * 与生产 stage executor 同构的 `execute_agent`：真实引擎、真实事件出口、真实 typed 终止映射。
 *
 * 唯一注入：`settled` 这一条低频投影事件被**拦掉**——等价于「Journal 已 durable，事件写盘
 * 失败/进程在事件落盘前被杀」。accepted/started 照常进入 SQLite 时间线。
 */
function makeExecutors(engine: RoleAutonomyEngine): TaskExecutionLoopExecutors {
  return {
    select_agent: {
      execute: async () => ({ winner_agent_id: ROLE_ID, evidence: { winner_agent_id: ROLE_ID } }),
    },
    execute_agent: {
      execute: async (
        context: TaskStageExecutionContext<'execute_agent'>,
      ): Promise<AgentExecutionResult> => {
        await engine.run({
          task_id: context.task_id,
          run_id: context.run_id,
          role_id: ROLE_ID,
          instruction: context.task_request.spec,
          workspace_path: context.workspace_path,
          emit_event: (event) => {
            if (event.type === ROLE_DISPATCH_EVENT.settled) return;
            emitStageEvent(context, event.type, event.subject_id, event.payload);
          },
        });
        return {
          changeset_ref: CHANGESET_REF,
          expected_sha256: CHANGESET_SHA,
          agent_id: ROLE_ID,
          session_id: 'session_1',
          evidence: { status: 'completed' },
        };
      },
    },
    council: {
      execute: async () => {
        throw new Error('solo run must not reach the Council stage');
      },
    },
    gate: { execute: async () => ({ evidence: { status: 'skipped' } }) },
    deliver: {
      execute: async (context) => ({
        final_output: {
          artifact_ref: context.cursor_input.changeset_ref,
          sha256: context.cursor_input.expected_sha256,
          workspace_path: path.join(context.workspace_path, 'result.ts'),
        },
        evidence: { files_written: ['result.ts'] },
      }),
    },
  };
}

/**
 * 按生产位置参数装配服务（第 26 个参数才是 Dispatch Journal 读取用的 runs root）。
 *
 * `FileRunTerminalOutputWriter` 的 driver 计费腿刮取被换成空摘要，避免测试去读本机
 * `~/.claude`；其余全部是生产默认实现。
 */
function buildService(input: {
  runsRoot: string;
  store: SqliteCoordinationStore;
  processor: TaskProcessor;
  loop: TaskExecutionLoop;
  registry: InMemoryRunRegistry;
}): NewideBackendService {
  return new NewideBackendService(
    undefined,
    input.registry,
    new FileRunAuditWriter(input.runsRoot),
    new FileRunTerminalOutputWriter(input.runsRoot, undefined, async () =>
      emptyTokenUsageSummary(),
    ),
    new FileRunRequestStore(input.runsRoot),
    input.processor,
    undefined,
    undefined,
    undefined,
    undefined,
    new NoopDriverStreamAuditWriter(),
    input.loop,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    input.runsRoot,
  );
}

interface JournalSnapshot {
  lines: number;
  settled: number;
  status: string;
}

/** 只读（peek）数 Journal 行；读取侧不该新增任何行。 */
async function readJournalSnapshot(
  runsRoot: string,
  runId: string,
  taskId: string,
): Promise<JournalSnapshot> {
  const journal = await RunDispatchJournal.peek({
    runDir: path.join(runsRoot, runId),
    identity: { run_id: runId, task_id: taskId, role_id: ROLE_ID },
  });
  const read = await journal.read();
  return {
    lines: read.lines.length,
    settled: read.lines.filter((line) => line.event === 'settled').length,
    status: read.status,
  };
}

function runEventTypes(processor: TaskProcessor, taskId: string, runId: string): string[] {
  return processor
    .listTaskEvents(taskId)
    .filter((event) => event.run_id === runId)
    .map((event) => event.type);
}

describe('生产 run.getSnapshot 权威读取接入 Journal 事实（R4-01）', () => {
  it('SQLite 缺 settled 事件时，终态文件 / 公开快照 / Journal 摘要一致，且重启读取不变、不补执行', async () => {
    const runsRoot = await makeTempDir('newide-authority-snapshot-');
    const workspace = await makeTempDir('newide-authority-snapshot-ws-');
    const dbPath = path.join(runsRoot, 'coordination.sqlite');
    const store = new SqliteCoordinationStore(dbPath);
    const processor = new TaskProcessor(store, { runsRoot });
    const driver = makeFakeDriver();
    const engine = makeEngine({ runsRoot, driver });
    const loop = new TaskExecutionLoop({
      processor,
      evidence_store: new FileRunEvidenceStore({ root: runsRoot }),
      executors: makeExecutors(engine),
    });
    const serviceBefore = buildService({
      runsRoot,
      store,
      processor,
      loop,
      registry: new InMemoryRunRegistry(),
    });

    let taskId = '';
    let runId = '';
    try {
      const created = await serviceBefore.createTask({
        spec: 'authority snapshot reads journal facts',
        role_id: ROLE_ID,
        completion_criteria: ['dispatch settles from the journal'],
        workspace_path: workspace,
        mode: 'single_agent',
      });
      taskId = created.current_run?.task_id ?? '';
      runId = created.current_run?.run_id ?? '';
      expect(runId).not.toBe('');
      expect(taskId).not.toBe('');

      // 判据：持久 Run 已到 completed **且**终态 writer 已落盘（终态状态写在游标推进里，
      // 产物写在随后的 finalize 里——只等前者会抢跑）。
      await waitFor(
        () =>
          processor.getRunSnapshot(runId)?.status === 'completed' &&
          existsSync(path.join(runsRoot, runId, 'summary.json')),
        'run terminal with its artifacts on disk',
      );
      expect(driver.calls()).toBe(1);

      // ── 场景本身要钉死：SQLite 有 accepted/started，缺 settled；Journal 有 settled ──
      const eventTypes = runEventTypes(processor, taskId, runId);
      expect(eventTypes.filter((type) => type === ROLE_DISPATCH_EVENT.accepted)).toHaveLength(1);
      expect(eventTypes.filter((type) => type === ROLE_DISPATCH_EVENT.started)).toHaveLength(1);
      expect(eventTypes).not.toContain(ROLE_DISPATCH_EVENT.settled);
      const journalBefore = await readJournalSnapshot(runsRoot, runId, taskId);
      expect(journalBefore.status).toBe('ok');
      expect(journalBefore.settled).toBe(1);

      // 纯事件投影（不传事实）仍然是 unknown：这正是修复前公开快照的样子，
      // 说明下面的 succeeded 只能来自读取接线，而不是 SQLite 被补写了事件。
      expect(processor.getRunSnapshot(runId)?.dispatch_summary?.by_status).toEqual({
        unknown: 1,
      });

      // ── 终态 writer 的文件摘要：Journal 事实已并入 ──
      const summary = JSON.parse(
        await readFile(path.join(runsRoot, runId, 'summary.json'), 'utf8'),
      ) as Record<string, unknown>;
      const summaryDispatch = summary['dispatch_summary'] as
        | { total: number; by_status: Record<string, number> }
        | undefined;
      expect(summaryDispatch?.total).toBe(1);
      expect(summaryDispatch?.by_status).toEqual({ succeeded: 1 });
      const frontendSnapshot = JSON.parse(
        await readFile(path.join(runsRoot, runId, 'frontend-snapshot.json'), 'utf8'),
      ) as { dispatch_summary?: { by_status: Record<string, number> } };
      expect(frontendSnapshot.dispatch_summary?.by_status).toEqual({ succeeded: 1 });

      // ── 公开权威快照：必须与文件摘要同源 ──
      const snapshot = await serviceBefore.getRunSnapshot(runId);
      expect(snapshot.status).toBe('completed');
      expect(snapshot.dispatch_summary?.total).toBe(1);
      expect(snapshot.dispatch_summary?.by_status).toEqual({ succeeded: 1 });
      expect(snapshot.dispatch_summary?.by_status).toEqual(summaryDispatch?.by_status);

      // ── Journal RPC 摘要同一口径 ──
      const journalPage = await serviceBefore.getRunDispatchJournal({ run_id: runId });
      expect(journalPage.state).toBe('ok');
      expect(journalPage.summary?.by_status).toEqual({ succeeded: 1 });

      // ── 读取不补执行、不改终态：driver 次数、Journal 行、SQLite 事件都不增 ──
      const callsAfterFirstRead = driver.calls();
      expect(callsAfterFirstRead).toBe(1);
      const journalAfterFirstRead = await readJournalSnapshot(runsRoot, runId, taskId);
      expect(journalAfterFirstRead).toEqual(journalBefore);
      expect(runEventTypes(processor, taskId, runId)).toEqual(eventTypes);

      // 重复读取不放大：同一份事实是幂等合并的。
      const again = await serviceBefore.getRunSnapshot(runId);
      expect(again.dispatch_summary).toEqual(snapshot.dispatch_summary);

      // ── 重启：关闭服务与 SQLite，重新打开同一文件，registry 为空 ──
      await serviceBefore.close().catch(() => undefined);
      store.close();
      const storeAfter = new SqliteCoordinationStore(dbPath);
      const processorAfter = new TaskProcessor(storeAfter, { runsRoot });
      const serviceAfter = buildService({
        runsRoot,
        store: storeAfter,
        processor: processorAfter,
        loop,
        registry: new InMemoryRunRegistry(),
      });
      try {
        // 持久状态确实还是 completed（读取没有把终态改掉）。
        expect(processorAfter.getRunSnapshot(runId)?.status).toBe('completed');
        // 空 registry + 新 SQLite 连接：只能来自持久层 + Journal 事实。
        const restarted = await serviceAfter.getRunSnapshot(runId);
        expect(restarted.status).toBe('completed');
        expect(restarted.dispatch_summary).toEqual(snapshot.dispatch_summary);
        expect(restarted.dispatch_summary?.by_status).toEqual({ succeeded: 1 });

        // 重启后的读取同样不补执行、不新增行/事件。
        expect(driver.calls()).toBe(callsAfterFirstRead);
        expect(await readJournalSnapshot(runsRoot, runId, taskId)).toEqual(journalBefore);
        expect(runEventTypes(processorAfter, taskId, runId)).toEqual(eventTypes);

        const restartedJournal = await serviceAfter.getRunDispatchJournal({ run_id: runId });
        expect(restartedJournal.summary?.by_status).toEqual(
          restarted.dispatch_summary?.by_status,
        );
      } finally {
        await serviceAfter.close().catch(() => undefined);
        try {
          storeAfter.close();
        } catch {
          // 清理尽力而为。
        }
      }
    } finally {
      await serviceBefore.close().catch(() => undefined);
      try {
        store.close();
      } catch {
        // 清理尽力而为。
      }
    }
  }, 30_000);
});
