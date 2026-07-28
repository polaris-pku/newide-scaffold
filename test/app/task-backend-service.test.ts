import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
});

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
