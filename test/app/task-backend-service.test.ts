import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CoordinatorRunRequest } from '../../src/coordinator/coordinator-runner';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import {
  NewideBackendService,
  TaskAlreadyRunningError,
  TaskNotBlockedError,
  TaskNotFoundError,
} from '../../src/app/newide-backend-service';
import { InMemoryRunRegistry, type AppRunEvent } from '../../src/app/run-registry';
import { FileRunRequestStore } from '../../src/app/run-request-store';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import {
  TaskExecutionLoop,
  TaskProcessor,
  type TaskExecutionLoopExecutors,
} from '../../src/coordination';
import {
  FileRunEvidenceStore,
  SqliteCoordinationStore,
  type TaskCursorInput,
} from '../../src/persistence';
import {
  FileRunEventConsumptionSink,
  FileRunTelemetryJsonlSink,
  recordProxyLlmUsage,
  resetLlmUsageDropCounters,
  snapshotLlmUsageDropCounters,
} from '../../src/telemetry';

describe('NewideBackendService Task-first view', () => {
  it('creates a durable task and immediately exposes the same running snapshot', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'task-service-live-'));
    const requestStore = new FileRunRequestStore(runsRoot);
    let received: CoordinatorRunRequest | undefined;
    const service = serviceWith(requestStore, new InMemoryRunRegistry(), async (request) => {
      received = request;
      request.onRunCreated?.({ run_id: 'run_live', task_id: 'task_live' });
      return new Promise<IntegrationV0Result>(() => undefined);
    });

    try {
      const created = await service.createTask({
        spec: 'Implement task.get',
        role_id: 'role_backend_engineer',
        risk_level: 'medium',
        affected_paths: ['src/app/**'],
        completion_criteria: ['task.get returns the same TaskSnapshot'],
        budget: { max_tool_calls: 20 },
        workspace_path: process.cwd(),
      });

      expect(created).toMatchObject({
        contract_version: 'task-snapshot.v0',
        task: {
          task_id: 'task_live',
          status: 'running',
          spec: 'Implement task.get',
          role_id: 'role_backend_engineer',
          risk_level: 'medium',
          affected_paths: ['src/app/**'],
          completion_criteria: ['task.get returns the same TaskSnapshot'],
          budget: { max_tool_calls: 20 },
        },
        current_run: { run_id: 'run_live', status: 'running', restartable: false },
      });
      expect(received?.task_request).toEqual({
        spec: 'Implement task.get',
        role_id: 'role_backend_engineer',
        risk_level: 'medium',
        affected_paths: ['src/app/**'],
        completion_criteria: ['task.get returns the same TaskSnapshot'],
        budget: { max_tool_calls: 20 },
      });
      await expect(service.getTask('task_live')).resolves.toEqual(created);
      await expect(service.listTasks()).resolves.toEqual({ tasks: [created] });
      await expect(service.startCouncil('task_live')).rejects.toBeInstanceOf(
        TaskAlreadyRunningError,
      );
      await expect(requestStore.load('run_live')).resolves.toMatchObject({
        task_id: 'task_live',
        task_request: received?.task_request,
      });
      await expect(service.getTask('task_missing')).rejects.toBeInstanceOf(TaskNotFoundError);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('cancels the current run through the Task boundary', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'task-service-cancel-'));
    const requestStore = new FileRunRequestStore(runsRoot);
    let signal: AbortSignal | undefined;
    const service = serviceWith(requestStore, new InMemoryRunRegistry(), async (request) => {
      signal = request.signal;
      request.onRunCreated?.({ run_id: 'run_cancel', task_id: 'task_cancel' });
      return new Promise<IntegrationV0Result>(() => undefined);
    });

    try {
      await service.createTask({
        spec: 'Cancel me',
        completion_criteria: ['Cancellation is durable'],
        workspace_path: process.cwd(),
      });

      const cancelled = await service.cancelTask('task_cancel');
      expect(signal?.aborted).toBe(true);
      expect(cancelled.task.status).toBe('cancelled');
      expect(cancelled.current_run).toBeUndefined();
      expect(cancelled.run_history).toEqual([
        expect.objectContaining({ run_id: 'run_cancel', status: 'cancelled' }),
      ]);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('reconstructs a completed task after backend restart', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'task-service-history-'));
    const requestStore = new FileRunRequestStore(runsRoot);
    await requestStore.save({
      run_id: 'run_done',
      task_id: 'task_done',
      prompt: 'Durable task',
      workspace_path: process.cwd(),
      mode: 'single_agent',
      task_request: {
        spec: 'Durable task',
        completion_criteria: ['Result survives restart'],
      },
    });
    await writeFile(
      path.join(runsRoot, 'run_done', 'frontend-snapshot.json'),
      JSON.stringify({
        schema_version: 'v0',
        run_id: 'run_done',
        task_id: 'task_done',
        mode: 'single_agent',
        status: 'completed',
        current: { stage: 'delivery', active_node_code: 'N18' },
        run: {
          run_id: 'run_done',
          task_id: 'task_done',
          status: 'completed',
          mode: 'single_agent',
          session_id: 'session_done',
          event_ids: [],
          started_at: '2026-07-19T01:00:00.000Z',
          completed_at: '2026-07-19T01:01:00.000Z',
        },
        timeline: [],
        agent_runs: [],
        artifacts: [{ artifact_id: 'artifact_done' }],
        gates: [],
        errors: [],
        final_output: {
          status: 'completed',
          artifact_refs: ['artifact_done'],
          files_written: ['/workspace/result.ts'],
          changed_files: ['result.ts'],
          response: 'Done.',
          session_id: 'session_done',
        },
      }),
      'utf-8',
    );
    let councilRequest: CoordinatorRunRequest | undefined;
    const service = serviceWith(requestStore, new InMemoryRunRegistry(), async (request) => {
      councilRequest = request;
      request.onRunCreated?.({
        run_id: 'run_council',
        task_id: request.task_id ?? 'wrong_task',
      });
      return new Promise<IntegrationV0Result>(() => undefined);
    });

    try {
      const snapshot = await service.getTask('task_done');
      expect(snapshot).toMatchObject({
        task: { task_id: 'task_done', status: 'completed', spec: 'Durable task' },
        run_history: [{ run_id: 'run_done', status: 'completed', session_id: 'session_done' }],
        final_output: {
          artifact_refs: ['artifact_done'],
          files_written: ['/workspace/result.ts'],
          changed_files: ['result.ts'],
          response: 'Done.',
        },
      });
      await expect(service.resumeTask('task_done')).rejects.toBeInstanceOf(TaskNotBlockedError);

      const taskEvents: AppRunEvent[] = [];
      const subscription = await service.subscribeTask('task_done', (event) =>
        taskEvents.push(event),
      );
      expect(subscription.snapshot.task.status).toBe('completed');
      const council = await service.startCouncil('task_done');
      expect(council.task.task_id).toBe('task_done');
      expect(council.task.status).toBe('running');
      expect(council.current_run).toMatchObject({
        run_id: 'run_council',
        task_id: 'task_done',
        mode: 'council',
        status: 'running',
      });
      expect(council.run_history).toEqual([
        expect.objectContaining({ run_id: 'run_done', status: 'completed' }),
      ]);
      expect(councilRequest).toMatchObject({
        task_id: 'task_done',
        mode: 'council',
        workspace_path: process.cwd(),
        task_request: {
          spec: 'Durable task',
          completion_criteria: ['Result survives restart'],
        },
      });
      await expect(requestStore.load('run_council')).resolves.toMatchObject({
        task_id: 'task_done',
        mode: 'council',
      });
      await expect(service.listTasks()).resolves.toMatchObject({
        tasks: [{ task: { task_id: 'task_done' } }],
      });
      expect(taskEvents).toEqual([
        expect.objectContaining({
          run_id: 'run_council',
          task_id: 'task_done',
          type: 'run.started',
        }),
      ]);
      subscription.unsubscribe();
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
  it('attributes task-loop LLM usage to stages and lands it in the run summary', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'task-service-usage-'));
    const store = new SqliteCoordinationStore(':memory:');
    const processor = new TaskProcessor(store);
    const stages: string[] = [];
    const loop = new TaskExecutionLoop({
      processor,
      evidence_store: new FileRunEvidenceStore({ root: runsRoot }),
      executors: taskLoopExecutors((cursor) => {
        stages.push(cursor);
      }),
    });
    const service = new NewideBackendService(
      undefined,
      new InMemoryRunRegistry(),
      new FileRunAuditWriter(runsRoot),
      new FileRunTerminalOutputWriter(runsRoot),
      new FileRunRequestStore(runsRoot),
      processor,
      undefined, // mailboxService
      undefined, // mailboxRecovery
      undefined, // closeRuntime
      undefined, // bMemoryService
      undefined, // driverStreamAuditWriter
      loop,
      undefined, // systemStatusService
      undefined, // mailboxDeliveryWorker
      undefined, // participantSessionProvisioner
      undefined, // artifactContentReader
      new FileRunEventConsumptionSink(runsRoot),
      new FileRunTelemetryJsonlSink(runsRoot),
    );

    resetLlmUsageDropCounters();
    try {
      const created = await service.createTask({
        spec: 'Attribute token usage',
        role_id: 'role_backend_engineer',
        completion_criteria: ['Usage is visible per stage'],
        workspace_path: process.cwd(),
        mode: 'single_agent',
      });
      const runId = created.current_run?.run_id ?? '';
      await waitForTerminalTask(service, created.task.task_id);
      // 终态事件早于 finalize 落盘，读盘前必须等 terminalRuns 全部落定。
      await service.close();

      expect(stages).toEqual(['select_agent', 'execute_agent', 'gate', 'deliver']);
      // 接线之前这三处全是静默丢弃；不再增长才算真正接上了账本。
      expect(snapshotLlmUsageDropCounters()).toMatchObject({
        dropped_no_ledger: 0,
        dropped_no_case_id: 0,
      });

      const audit = await readFile(path.join(runsRoot, runId, 'audit.jsonl'), 'utf8');
      const usageEvents = audit
        .split('\n')
        .filter((line) => line.includes('proxy.llm_usage_recorded'))
        .map((line) => JSON.parse(line) as { payload: { stage_cursor?: string } });
      expect(usageEvents.map((event) => event.payload.stage_cursor)).toEqual([
        'execute_agent',
        'gate',
      ]);

      // summary 的 token 口径来自 timeline 上的用量事件，接线之后它自己就亮了。
      const summary = JSON.parse(
        await readFile(path.join(runsRoot, runId, 'summary.json'), 'utf8'),
      ) as { token_usage?: { total_tokens?: number; call_count?: number } };
      expect(summary.token_usage).toMatchObject({ total_tokens: 220, call_count: 2 });

      // 同一批记录还要按 run 落观测文件：telemetry.jsonl 记的是「这个 run 收到了哪些
      // telemetry 记录」，与事件流是两条腿，落点不同（见 FileRunTelemetryJsonlSink）。
      const telemetryRecords = (
        await readFile(path.join(runsRoot, runId, 'telemetry.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event_type: string; run_id?: string });
      expect(telemetryRecords.map((record) => record.event_type)).toEqual([
        'proxy.llm_usage_recorded',
        'proxy.llm_usage_recorded',
      ]);
      // 落盘按 run 分目录，行里缺 run_id 就是坏行，所以漏斗负责补齐。
      expect(telemetryRecords.every((record) => record.run_id === runId)).toBe(true);
    } finally {
      await rm(runsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

function taskLoopExecutors(
  onStage: (cursor: TaskCursorInput['cursor']) => void,
): TaskExecutionLoopExecutors {
  return {
    select_agent: {
      execute: async () => {
        onStage('select_agent');
        return { winner_agent_id: 'agent_a', evidence: { winner_agent_id: 'agent_a' } };
      },
    },
    execute_agent: {
      execute: async () => {
        onStage('execute_agent');
        await recordFakeUsage();
        return {
          changeset_ref: 'artifact_primary_changeset',
          expected_sha256: 'd'.repeat(64),
          agent_id: 'agent_a',
          session_id: 'session_primary',
          evidence: { response: 'implementation complete' },
        };
      },
    },
    council: {
      execute: async () => {
        throw new Error('single_agent run must not reach the Council stage');
      },
    },
    gate: {
      execute: async () => {
        onStage('gate');
        await recordFakeUsage();
        return { evidence: { status: 'skipped' } };
      },
    },
    deliver: {
      execute: async (context) => {
        onStage('deliver');
        return {
          final_output: {
            artifact_ref: context.cursor_input.changeset_ref,
            sha256: context.cursor_input.expected_sha256,
            workspace_path: '/workspace/result.ts',
          },
          evidence: { files_written: ['result.ts'] },
        };
      },
    },
  };
}

/**
 * 刻意不带 sink / case_id：生产里这两样由 executeTaskAuthorityRun 的账本作用域补全，
 * 所以测试断言的是「新主路径确实有作用域」，不是「测试自己传了参数」。
 */
function recordFakeUsage(): Promise<void> {
  return recordProxyLlmUsage({ input_tokens: 100, output_tokens: 10, model: 'fake-model' });
}

/**
 * 等到 run 走到终态。
 *
 * `subscribeTask` 先注册监听器再读快照，两者之间没有窗口：完成事件要么进回调，要么
 * 已经反映在返回的快照里。所以这里既不轮询也不赌时序。
 */
async function waitForTerminalTask(
  service: NewideBackendService,
  taskId: string,
): Promise<void> {
  let resolveTerminal!: () => void;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const subscription = await service.subscribeTask(taskId, (event) => {
    if (event.type === 'run.completed' || event.type === 'run.failed') resolveTerminal();
  });
  if (subscription.snapshot.task.status !== 'running') resolveTerminal();
  await terminal;
  subscription.unsubscribe();
}

function serviceWith(
  requestStore: FileRunRequestStore,
  registry: InMemoryRunRegistry,
  run: (request: CoordinatorRunRequest) => Promise<IntegrationV0Result>,
): NewideBackendService {
  return new NewideBackendService(
    { run },
    registry,
    {
      initialize: async () => undefined,
      append: async () => undefined,
      flush: async () => undefined,
    },
    { finalize: async () => undefined },
    requestStore,
  );
}
