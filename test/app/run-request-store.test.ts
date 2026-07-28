import { describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import type { TaskCreateRequest } from '../../src/core';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { InMemoryRunRegistry } from '../../src/app/run-registry';
import { FileRunRequestStore, RunRequestNotFoundError } from '../../src/app/run-request-store';

describe('FileRunRequestStore', () => {
  it('persists requests and reports terminal or interrupted history without faking running', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'run-request-store-'));
    const store = new FileRunRequestStore(runsRoot);
    try {
      await store.save({
        run_id: 'run_done',
        task_id: 'task_done',
        prompt: 'Finish the work',
        workspace_path: '/tmp/workspace-a',
        mode: 'single_agent',
        session_id: 'session_created_with',
        task_request: {
          spec: 'Finish the durable task',
          completion_criteria: ['Durable task is complete'],
          risk_level: 'medium',
        },
      });
      await writeFile(
        path.join(runsRoot, 'run_done', 'frontend-snapshot.json'),
        JSON.stringify({
          schema_version: 'v0',
          run_id: 'run_done',
          status: 'completed',
          task_id: 'task_done',
          mode: 'single_agent',
          current: { stage: 'delivery', active_node_code: 'N18' },
          run: {
            run_id: 'run_done',
            task_id: 'task_done',
            status: 'completed',
            mode: 'single_agent',
            session_id: 'session_terminal',
            event_ids: [],
            started_at: '2026-07-19T01:00:00.000Z',
            completed_at: '2026-07-19T01:01:00.000Z',
          },
          timeline: [],
          agent_runs: [],
          artifacts: [],
          gates: [],
          final_output: {
            status: 'completed',
            artifact_refs: [],
            files_written: [],
            session_id: 'session_terminal',
          },
          errors: [],
        }),
        'utf-8',
      );
      await store.save({
        run_id: 'run_interrupted',
        task_id: 'task_interrupted',
        prompt: 'Crashed midway',
        workspace_path: '/tmp/workspace-b',
        mode: 'council',
      });
      // 只有残留文件、没有 request.json 也没有终态快照的目录不可诚实描述，应被跳过。
      await mkdir(path.join(runsRoot, 'run_stray'), { recursive: true });

      const history = await store.listHistory();
      expect(history.map((entry) => [entry.run_id, entry.status, entry.restartable])).toEqual(
        expect.arrayContaining([
          ['run_done', 'completed', true],
          ['run_interrupted', 'interrupted', true],
        ]),
      );
      expect(history).toHaveLength(2);
      expect(history.find((entry) => entry.run_id === 'run_done')?.task_request).toEqual({
        spec: 'Finish the durable task',
        completion_criteria: ['Durable task is complete'],
        risk_level: 'medium',
      });
      await expect(store.readTerminalSessionId('run_done')).resolves.toBe('session_terminal');
      await expect(store.readTerminalSessionId('run_interrupted')).resolves.toBeUndefined();
      await expect(store.loadRunSnapshot('run_done')).resolves.toMatchObject({
        run_id: 'run_done',
        status: 'completed',
        run: {
          started_at: '2026-07-19T01:00:00.000Z',
          completed_at: '2026-07-19T01:01:00.000Z',
        },
      });
      await expect(store.loadRunSnapshot('run_interrupted')).resolves.toBeUndefined();
      await expect(store.load('run_missing')).rejects.toBeInstanceOf(RunRequestNotFoundError);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});

describe('NewideBackendService run history', () => {
  it('writes request.json on create and hides live runs from run.list', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'run-history-service-'));
    const requestStore = new FileRunRequestStore(runsRoot);
    let receivedTaskRequest: TaskCreateRequest | undefined;
    const service = new NewideBackendService(
      {
        run: async (request) => {
          receivedTaskRequest = request.task_request;
          request.onRunCreated?.({ run_id: 'run_live', task_id: 'task_live' });
          return new Promise<IntegrationV0Result>(() => undefined);
        },
      },
      new InMemoryRunRegistry(),
      {
        initialize: async () => undefined,
        append: async () => undefined,
        flush: async () => undefined,
      },
      { finalize: async () => undefined },
      requestStore,
    );

    try {
      await service.createRun({
        prompt: 'Persist me',
        workspace_path: process.cwd(),
        mode: 'council',
        project_id: 'project_1',
        client_task_id: 'client_task_1',
      });
      await requestPersisted(runsRoot, 'run_live');

      const persisted = await requestStore.load('run_live');
      expect(persisted).toMatchObject({
        run_id: 'run_live',
        task_id: 'task_live',
        prompt: 'Persist me',
        mode: 'council',
        project_id: 'project_1',
        client_task_id: 'client_task_1',
        schema_version: 'v0',
      });
      expect(persisted.task_request).toEqual({
        spec: 'Persist me',
        role_id: 'role_ts_engineer',
        risk_level: 'low',
        affected_paths: ['src/**'],
        completion_criteria: ['integration v0 flow completes successfully'],
      });
      expect(receivedTaskRequest).toEqual(persisted.task_request);
      expect(persisted.workspace_path).toBeTruthy();
      expect(persisted.created_at).toBeTruthy();

      // 运行中的 run 不出现在历史列表：它的真实状态由 run.getSnapshot 提供。
      const listed = await service.listRuns();
      expect(listed.runs.map((entry) => entry.run_id)).toEqual([]);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});

describe('NewideBackendService run restart', () => {
  it('restarts a persisted run as a new execution reusing the terminal session', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'run-restart-service-'));
    const requestStore = new FileRunRequestStore(runsRoot);
    const received: {
      prompt: string;
      mode: string;
      session_id?: string;
      task_request?: TaskCreateRequest;
    }[] = [];
    let nextRun = 1;
    const service = new NewideBackendService(
      {
        run: async (request) => {
          received.push({
            prompt: request.prompt,
            mode: request.mode,
            ...(request.session_id ? { session_id: request.session_id } : {}),
            ...(request.task_request ? { task_request: request.task_request } : {}),
          });
          const sequence = nextRun;
          nextRun += 1;
          request.onRunCreated?.({
            run_id: `run_${String(sequence)}`,
            task_id: `task_${String(sequence)}`,
          });
          return new Promise<IntegrationV0Result>(() => undefined);
        },
      },
      new InMemoryRunRegistry(),
      {
        initialize: async () => undefined,
        append: async () => undefined,
        flush: async () => undefined,
      },
      { finalize: async () => undefined },
      requestStore,
    );

    try {
      await service.createRun({
        prompt: 'Original task',
        workspace_path: process.cwd(),
        task_request: {
          spec: 'Original durable task definition',
          role_id: 'role_backend_engineer',
          risk_level: 'high',
          affected_paths: ['src/app/**'],
          completion_criteria: ['Original acceptance criterion remains unchanged'],
        },
      });
      await requestPersisted(runsRoot, 'run_1');
      // 模拟上个进程留下的终态快照：restart 必须复用其中的 session_id。
      await writeFile(
        path.join(runsRoot, 'run_1', 'frontend-snapshot.json'),
        JSON.stringify({
          status: 'completed',
          final_output: { status: 'completed', session_id: 'session_from_terminal' },
        }),
        'utf-8',
      );

      const restarted = await service.restartRun('run_1');
      expect(restarted).toEqual({
        run_id: 'run_2',
        task_id: 'task_2',
        restarted_from_run_id: 'run_1',
        status: 'running',
      });
      expect(received[1]).toEqual({
        prompt: 'Original task',
        mode: 'single_agent',
        session_id: 'session_from_terminal',
        task_request: {
          spec: 'Original durable task definition',
          role_id: 'role_backend_engineer',
          risk_level: 'high',
          affected_paths: ['src/app/**'],
          completion_criteria: ['Original acceptance criterion remains unchanged'],
        },
      });
      // 新 run 的 request.json 记录血缘；原 run 的 request.json 保持不变。
      await requestPersisted(runsRoot, 'run_2');
      await expect(requestStore.load('run_2')).resolves.toMatchObject({
        restarted_from_run_id: 'run_1',
        session_id: 'session_from_terminal',
      });
      await expect(requestStore.load('run_1')).resolves.not.toHaveProperty('restarted_from_run_id');
      await expect(service.restartRun('run_missing')).rejects.toBeInstanceOf(
        RunRequestNotFoundError,
      );
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});

async function requestPersisted(runsRoot: string, runId: string): Promise<void> {
  const requestPath = path.join(runsRoot, runId, 'request.json');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(requestPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`request.json was not persisted for ${runId}`);
}
