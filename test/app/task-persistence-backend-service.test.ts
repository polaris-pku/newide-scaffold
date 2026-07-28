import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { InMemoryRunRegistry } from '../../src/app/run-registry';
import type { AppRunEvent } from '../../src/app/run-registry';
import { FileRunRequestStore } from '../../src/app/run-request-store';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { TaskProcessor } from '../../src/app/task-processor';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import type {
  CoordinatorRunner,
  CoordinatorRunRequest,
} from '../../src/coordinator/coordinator-runner';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import { SqliteCoordinationStore } from '../../src/persistence';

describe('NewideBackendService SQLite lifecycle', () => {
  it('persists a Council override on the active Run without starting another Run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-service-override-'));
    const runsRoot = path.join(root, 'runs');
    const requestStore = new FileRunRequestStore(runsRoot);
    const store = new SqliteCoordinationStore(path.join(root, 'coordination.sqlite'));
    let runnerCalls = 0;
    const service = createService(new TaskProcessor(store), requestStore, runsRoot, {
      run: async (request) => {
        runnerCalls += 1;
        request.onRunCreated?.({ run_id: 'run_override_live', task_id: 'task_override_live' });
        return new Promise<IntegrationV0Result>(() => undefined);
      },
    });

    try {
      const created = await service.createTask({
        spec: 'Escalate the active task to Council',
        completion_criteria: ['The same Run observes a persistent Council override'],
        workspace_path: root,
      });
      const overridden = await service.startCouncil(created.task.task_id);

      expect(overridden.current_run?.run_id).toBe('run_override_live');
      expect(runnerCalls).toBe(1);
      expect(store.getTaskAggregate(created.task.task_id)?.runtime_state.diagnostics).toMatchObject({
        council_override: true,
      });
      expect(
        store
          .listEvents(created.task.task_id)
          .filter((event) => event.event_type === 'task.council_override_set'),
      ).toHaveLength(1);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('queries the same completed Task and Run after reconstructing the backend service', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-service-sqlite-'));
    const runsRoot = path.join(root, 'runs');
    const databasePath = path.join(root, 'coordination.sqlite');
    const requestStore = new FileRunRequestStore(runsRoot);
    const firstStore = new SqliteCoordinationStore(databasePath);
    const firstProcessor = new TaskProcessor(firstStore);
    const service = createService(firstProcessor, requestStore, runsRoot, completedRunner());

    try {
      const created = await service.createTask({
        spec: 'Persist the backend lifecycle',
        completion_criteria: ['A restarted backend returns the same TaskSnapshot'],
        workspace_path: root,
      });
      await service.waitForTerminal(created.current_run!.run_id);
      const completed = await service.getTask(created.task.task_id);
      expect(completed).toMatchObject({
        task: { status: 'completed' },
        run_history: [{ status: 'completed' }],
        market: { winner_agent_id: 'role_ts_engineer' },
        final_output: { artifact_refs: ['artifact_persisted'] },
      });
      const persisted = firstStore.getTaskAggregate(created.task.task_id);
      expect(persisted).toMatchObject({
        task: {
          status: 'completed',
          final_output: {
            artifact_ref: expect.stringMatching(/^file:/),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
        runtime_state: { resume_cursor: 'done' },
      });
      expect(persisted?.runtime_state).not.toHaveProperty('current_run_id');
      firstStore.close();

      const reopenedStore = new SqliteCoordinationStore(databasePath);
      const restarted = createService(new TaskProcessor(reopenedStore), requestStore, runsRoot, {
        run: async () => {
          throw new Error('Restart query must not execute a new run');
        },
      });
      try {
        await expect(restarted.getTask(created.task.task_id)).resolves.toEqual(completed);
        expect(restarted.getRunSnapshot(completed.run_history[0]!.run_id)).toMatchObject({
          status: 'completed',
          final_output: { artifact_refs: ['artifact_persisted'] },
        });
        const firstEventId = reopenedStore.getTaskAggregate(created.task.task_id)?.events[0]
          ?.event_id;
        expect(firstEventId).toBeDefined();
        const subscription = await restarted.subscribeTask(
          created.task.task_id,
          () => undefined,
          firstEventId,
        );
        expect(subscription.replay_events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ event_id: 'event_market_persisted' }),
            expect.objectContaining({ type: 'run.completed' }),
          ]),
        );
        subscription.unsubscribe();
      } finally {
        reopenedStore.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resumes a blocked Task as a new Run with the persisted A session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-service-resume-'));
    const runsRoot = path.join(root, 'runs');
    const databasePath = path.join(root, 'coordination.sqlite');
    const workspacePath = await realpath(root);
    const requestStore = new FileRunRequestStore(runsRoot);
    const seedStore = new SqliteCoordinationStore(databasePath);
    const seedProcessor = new TaskProcessor(seedStore);
    seedProcessor.beginRun({
      task_id: 'task_resume',
      run_id: 'run_interrupted',
      task_request: {
        spec: 'Resume the interrupted task',
        completion_criteria: ['The resumed Run completes under the same Task'],
      },
      workspace_path: workspacePath,
      mode: 'single_agent',
      session_id: 'session_resume',
    });
    seedProcessor.recordRunEvent('run_interrupted', {
      event_id: 'event_agent_interrupted',
      event_type: 'agent.execution_completed',
      subject_id: 'role_ts_engineer@agent_1',
      task_id: 'task_resume',
      run_id: 'run_interrupted',
      payload: {
        agent_id: 'role_ts_engineer@agent_1',
        session_id: 'session_resume',
        artifact_refs: ['artifact_partial'],
      },
      created_at: '2026-07-19T04:30:00.000Z',
      schema_version: 'v0',
    });
    seedStore.close();

    const reopenedStore = new SqliteCoordinationStore(databasePath);
    const processor = new TaskProcessor(reopenedStore);
    processor.recoverInterruptedTasks();
    const checkpoint = reopenedStore.getLatestCheckpoint('task_resume');
    let resumedRequest: CoordinatorRunRequest | undefined;
    let runnerCalls = 0;
    const service = createService(processor, requestStore, runsRoot, {
      run: async (request) => {
        runnerCalls += 1;
        resumedRequest = request;
        request.onRunCreated?.({ run_id: 'run_resumed', task_id: request.task_id ?? 'wrong_task' });
        return completedResult(request.prompt, {
          run_id: 'run_resumed',
          task_id: 'task_resume',
          session_id: request.session_id ?? 'missing_session',
        });
      },
    });

    try {
      await expect(service.getTask('task_resume')).resolves.toMatchObject({
        task: { status: 'blocked' },
        run_history: [{ run_id: 'run_interrupted', status: 'interrupted' }],
      });
      expect(runnerCalls).toBe(0);

      await service.resumeTask('task_resume');
      await service.waitForTerminal('run_resumed');

      expect(resumedRequest).toMatchObject({
        task_id: 'task_resume',
        mode: 'single_agent',
        session_id: 'session_resume',
        workspace_path: workspacePath,
        task_request: {
          spec: 'Resume the interrupted task',
          completion_criteria: ['The resumed Run completes under the same Task'],
        },
      });
      await expect(service.getTask('task_resume')).resolves.toMatchObject({
        task: { task_id: 'task_resume', status: 'completed' },
        run_history: [
          {
            run_id: 'run_resumed',
            status: 'completed',
            session_id: 'session_resume',
          },
          {
            run_id: 'run_interrupted',
            status: 'interrupted',
            session_id: 'session_resume',
          },
        ],
      });
      expect(reopenedStore.getTaskAggregate('task_resume')).toMatchObject({
        runs: [
          { run_id: 'run_resumed', restarted_from_run_id: 'run_interrupted' },
          { run_id: 'run_interrupted', status: 'interrupted' },
        ],
        runtime_state: {
          diagnostics: {
            resume_checkpoint_id: checkpoint?.checkpoint_id,
            requested_resume_cursor: 'gate',
          },
        },
      });
    } finally {
      reopenedStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps legacy file Tasks readable and adopts their next Council run into SQLite', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-service-legacy-'));
    const runsRoot = path.join(root, 'runs');
    const requestStore = new FileRunRequestStore(runsRoot);
    const legacy = new NewideBackendService(
      completedRunner(),
      new InMemoryRunRegistry(),
      new FileRunAuditWriter(runsRoot),
      new FileRunTerminalOutputWriter(runsRoot),
      requestStore,
    );

    try {
      const created = await legacy.createTask({
        spec: 'Persist the backend lifecycle',
        completion_criteria: ['A restarted backend returns the same TaskSnapshot'],
        workspace_path: root,
      });
      await legacy.waitForTerminal(created.current_run!.run_id);

      const store = new SqliteCoordinationStore(path.join(root, 'new-coordination.sqlite'));
      const service = createService(new TaskProcessor(store), requestStore, runsRoot, {
        run: async (request) => {
          request.onRunCreated?.({
            run_id: 'run_legacy_council',
            task_id: request.task_id ?? 'wrong_task',
          });
          return new Promise<IntegrationV0Result>(() => undefined);
        },
      });
      try {
        await expect(service.getTask(created.task.task_id)).resolves.toMatchObject({
          task: { status: 'completed' },
        });
        const taskEvents: AppRunEvent[] = [];
        const subscription = await service.subscribeTask(created.task.task_id, (event) =>
          taskEvents.push(event),
        );
        const council = await service.startCouncil(created.task.task_id);
        expect(council).toMatchObject({
          task: { task_id: created.task.task_id, status: 'running' },
          current_run: { run_id: 'run_legacy_council', mode: 'council' },
          run_history: [],
        });
        expect(store.getTaskAggregate(created.task.task_id)).toBeDefined();
        const started = taskEvents.find((event) => event.type === 'run.started');
        expect(started).toBeDefined();
        expect(
          store
            .getTaskAggregate(created.task.task_id)
            ?.events.some((event) => event.event_id === started?.event_id),
        ).toBe(true);
        subscription.unsubscribe();
      } finally {
        store.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restarts a legacy file Run with SQLite enabled without creating an invalid Run foreign key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-service-legacy-restart-'));
    const runsRoot = path.join(root, 'runs');
    const requestStore = new FileRunRequestStore(runsRoot);
    await requestStore.save({
      run_id: 'run_legacy_only',
      task_id: 'task_legacy_only',
      prompt: 'Restart a legacy file run',
      workspace_path: root,
      mode: 'single_agent',
      session_id: 'session_legacy',
      task_request: {
        spec: 'Restart a legacy file run',
        completion_criteria: ['The SQLite service accepts the new Run'],
      },
    });
    const store = new SqliteCoordinationStore(path.join(root, 'coordination.sqlite'));
    const service = createService(new TaskProcessor(store), requestStore, runsRoot, {
      run: async (request) => {
        request.onRunCreated?.({
          run_id: 'run_after_legacy',
          task_id: 'task_after_legacy',
        });
        return new Promise<IntegrationV0Result>(() => undefined);
      },
    });

    try {
      await expect(service.restartRun('run_legacy_only')).resolves.toMatchObject({
        run_id: 'run_after_legacy',
        restarted_from_run_id: 'run_legacy_only',
      });
      expect(
        store.getTaskAggregate('task_after_legacy')?.runs[0]?.restarted_from_run_id,
      ).toBeUndefined();
      await expect(requestStore.load('run_after_legacy')).resolves.toMatchObject({
        restarted_from_run_id: 'run_legacy_only',
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createService(
  processor: TaskProcessor,
  requestStore: FileRunRequestStore,
  runsRoot: string,
  runner: CoordinatorRunner,
): NewideBackendService {
  return new NewideBackendService(
    runner,
    new InMemoryRunRegistry(),
    new FileRunAuditWriter(runsRoot),
    new FileRunTerminalOutputWriter(runsRoot),
    requestStore,
    processor,
  );
}

function completedRunner(): CoordinatorRunner {
  return {
    run: async (request) => {
      request.onEvent?.({
        event_id: 'event_task_persisted',
        event_type: 'task.created',
        subject_id: 'task_persisted',
        task_id: 'task_persisted',
        payload: { spec: request.prompt },
        created_at: '2026-07-19T04:00:00.000Z',
        schema_version: 'v0',
      });
      request.onRunCreated?.({ run_id: 'run_persisted', task_id: 'task_persisted' });
      request.onEvent?.({
        event_id: 'event_market_persisted',
        event_type: 'market.selected',
        subject_id: 'role_ts_engineer',
        run_id: 'run_persisted',
        task_id: 'task_persisted',
        payload: {
          winner_agent_id: 'role_ts_engineer',
          winner_bid_id: 'bid_persisted',
          ledger_ref: 'file:///market/ledger.json',
          audit_ref: 'file:///market/audit.json',
          policy_version: 'market-v0',
          seed: 'run_persisted',
        },
        created_at: '2026-07-19T04:00:01.000Z',
        schema_version: 'v0',
      });
      return completedResult(request.prompt);
    },
  };
}

function completedResult(
  spec: string,
  identity: { run_id: string; task_id: string; session_id: string } = {
    run_id: 'run_persisted',
    task_id: 'task_persisted',
    session_id: 'session_persisted',
  },
): IntegrationV0Result {
  return {
    run_id: identity.run_id,
    task_id: identity.task_id,
    summary: { status: 'completed' },
    frontend_snapshot: {
      snapshot_type: 'coordinator.frontend_run_snapshot.v0',
      schema_version: 'v0',
      generated_at: '2026-07-19T04:01:00.000Z',
      run_id: identity.run_id,
      task_id: identity.task_id,
      task: {
        task_id: identity.task_id,
        status: 'completed',
        spec,
        completion_criteria: ['A restarted backend returns the same TaskSnapshot'],
        risk_level: 'low',
        affected_paths: [],
        created_at: '2026-07-19T04:00:00.000Z',
        updated_at: '2026-07-19T04:01:00.000Z',
        schema_version: 'v0',
      },
      current: { stage: 'delivery', task_status: 'completed', active_node_code: 'N18' },
      run: {
        run_id: identity.run_id,
        task_id: identity.task_id,
        status: 'completed',
        mode: 'single_agent',
        driver_id: 'fake-driver',
        session_id: identity.session_id,
        created_at: '2026-07-19T04:00:00.000Z',
      },
      flow: { active_node_code: 'N18', node_statuses: [] },
      timeline: [],
      delivery_report: {
        worktree_path: '/workspace',
        files_written: ['/workspace/result.ts'],
        changed_files: ['result.ts'],
        artifacts_materialized: 1,
        outcome: 'completed_files',
        session_id: identity.session_id,
        tool_events: [],
        driver_diagnostics: { driver_id: 'fake-driver', duration_ms: 1 },
      },
      artifacts: [{ artifact_id: 'artifact_persisted' } as never],
      checkpoint: {} as never,
      mailbox: { thread_id: identity.run_id, message_refs: [], messages: [] },
      market: {
        winner_agent_id: 'role_ts_engineer',
        winner_bid_id: 'bid_persisted',
        ledger_ref: 'file:///market/ledger.json',
        audit_ref: 'file:///market/audit.json',
        policy_version: 'market-v0',
        seed: 'run_persisted',
      },
      links: {} as never,
    },
  } as IntegrationV0Result;
}
