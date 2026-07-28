import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { InMemoryRunRegistry, type AppRunEvent } from '../../src/app/run-registry';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import { FileRunRequestStore } from '../../src/app/run-request-store';
import type { TaskProcessor } from '../../src/app/task-processor';
import { IntegrationV0CoordinatorRunner } from '../../src/coordinator/coordinator-runner';
import { runSnapshotSchema } from '../../src/protocol/run-snapshot';

describe('NewideBackendService', () => {
  it('publishes incremental driver events before the runner completes', async () => {
    let finish: ((result: IntegrationV0Result) => void) | undefined;
    const runnerResult = new Promise<IntegrationV0Result>((resolve) => {
      finish = resolve;
    });
    const service = new NewideBackendService({
      run: async (request) => {
        request.onRunCreated?.({ run_id: 'run_stream', task_id: 'task_stream' });
        request.onDriverEvent?.({
          schema_version: 'driver-event.v1',
          event_type: 'agent_message_chunk',
          task_id: 'task_stream',
          run_id: 'run_stream',
          session_id: 'session_stream',
          sequence: 1,
          created_at: '2026-07-20T00:00:01.000Z',
          payload: { text: 'working' },
        });
        return runnerResult;
      },
    });

    await service.createRun({ prompt: 'Stream progress', workspace_path: process.cwd() });

    expect(service.getSnapshot('run_stream')).toMatchObject({
      status: 'running',
      events: [
        { type: 'run.started' },
        {
          type: 'driver.stream_event',
          source: 'driver',
          payload: {
            driver_event_type: 'agent_message_chunk',
            session_id: 'session_stream',
            event_sequence: 1,
            event_payload: { text: 'working' },
          },
        },
      ],
    });

    finish?.(completedResult('run_stream', 'task_stream'));
    await viWaitFor(() => service.getSnapshot('run_stream').status === 'completed');
  });

  it('returns real ids before the runner completes and records telemetry', async () => {
    let receivedRequest: Parameters<IntegrationV0CoordinatorRunner['run']>[0] | undefined;
    let finish: ((result: IntegrationV0Result) => void) | undefined;
    const runnerResult = new Promise<IntegrationV0Result>((resolve) => {
      finish = resolve;
    });
    const service = new NewideBackendService({
      run: async (request) => {
        receivedRequest = request;
        request.onRunCreated?.({ run_id: 'run_1', task_id: 'task_1' });
        await request.telemetry?.emit({
          telemetry_id: 'telemetry_1',
          event_type: 'driver.run_result',
          owner: 'B-owned-observed',
          subject_id: 'driver_result_1',
          run_id: 'run_1',
          task_id: 'task_1',
          payload: { status: 'succeeded' },
          created_at: '2026-07-11T08:00:00.000Z',
          schema_version: 'v0',
        });
        return runnerResult;
      },
    });

    await expect(
      service.createRun({
        prompt: 'Build RPC',
        workspace_path: process.cwd(),
        session_id: 'session_existing',
      }),
    ).resolves.toEqual({
      run_id: 'run_1',
      task_id: 'task_1',
      status: 'running',
    });
    expect(receivedRequest).toMatchObject({
      workspace_path: process.cwd(),
      session_id: 'session_existing',
    });
    expect(service.getSnapshot('run_1')).toMatchObject({
      status: 'running',
      events: [
        { sequence: 1, type: 'run.started' },
        { sequence: 2, type: 'driver.run_result', payload: { status: 'succeeded' } },
      ],
    });

    finish?.(completedResult('run_1', 'task_1'));
    await viWaitFor(() => service.getSnapshot('run_1').status === 'completed');
    expect(service.getSnapshot('run_1')).toMatchObject({
      status: 'completed',
      snapshot: { run_id: 'run_1', task_id: 'task_1' },
      events: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3, type: 'run.completed' }],
    });
    expect(service.getRunSnapshot('run_1').market).toEqual({
      winner_agent_id: 'role_ts_engineer',
      winner_bid_id: 'bid_1',
      ledger_ref: 'file:///market/ledger.json',
      audit_ref: 'file:///market/audit.json',
      policy_version: 'market-v0',
      seed: 'run_1',
    });
  });

  it('does not publish completed state before terminal outputs are durable', async () => {
    let finishRunner: ((result: IntegrationV0Result) => void) | undefined;
    let finishTerminal: (() => void) | undefined;
    const runnerResult = new Promise<IntegrationV0Result>((resolve) => {
      finishRunner = resolve;
    });
    let markTerminalStarted!: () => void;
    const terminalStarted = new Promise<void>((resolve) => {
      markTerminalStarted = resolve;
    });
    const terminalFinished = new Promise<void>((resolve) => {
      finishTerminal = resolve;
    });
    const service = new NewideBackendService(
      {
        run: async (request) => {
          request.onRunCreated?.({ run_id: 'run_durable', task_id: 'task_durable' });
          return runnerResult;
        },
      },
      new InMemoryRunRegistry(),
      {
        initialize: async () => undefined,
        append: async () => undefined,
        flush: async () => undefined,
      },
      {
        finalize: async () => {
          markTerminalStarted();
          await terminalFinished;
        },
      },
    );

    await service.createRun({ prompt: 'Wait for durable output' });
    const seen: string[] = [];
    service.subscribe('run_durable', (event) => seen.push(event.type));
    finishRunner?.(completedResult('run_durable', 'task_durable'));
    await terminalStarted;
    expect(service.getSnapshot('run_durable').status).toBe('running');
    expect(seen).not.toContain('run.completed');

    finishTerminal?.();
    await service.waitForTerminal('run_durable');
    expect(service.getSnapshot('run_durable').status).toBe('completed');
    expect(seen.filter((type) => type === 'run.completed')).toHaveLength(1);
  });

  it('gives an in-flight completion exclusive terminal ownership over cancellation', async () => {
    let finishRunner: ((result: IntegrationV0Result) => void) | undefined;
    let finishTerminal!: () => void;
    let finalizeCalls = 0;
    const runnerResult = new Promise<IntegrationV0Result>((resolve) => {
      finishRunner = resolve;
    });
    let markTerminalStarted!: () => void;
    const terminalStarted = new Promise<void>((resolve) => {
      markTerminalStarted = resolve;
    });
    const terminalFinished = new Promise<void>((resolve) => {
      finishTerminal = resolve;
    });
    const service = new NewideBackendService(
      {
        run: async (request) => {
          request.onRunCreated?.({ run_id: 'run_race', task_id: 'task_race' });
          return runnerResult;
        },
      },
      new InMemoryRunRegistry(),
      {
        initialize: async () => undefined,
        append: async () => undefined,
        flush: async () => undefined,
      },
      {
        finalize: async () => {
          finalizeCalls += 1;
          markTerminalStarted();
          await terminalFinished;
        },
      },
    );

    await service.createRun({ prompt: 'Resolve completion and cancel race' });
    finishRunner?.(completedResult('run_race', 'task_race'));
    await terminalStarted;
    const cancellation = service.cancelRun('run_race');
    expect(finalizeCalls).toBe(1);

    finishTerminal();
    await service.waitForTerminal('run_race');
    await expect(cancellation).rejects.toThrow('Run run_race already reached completed');
    const snapshot = service.getSnapshot('run_race');
    expect(snapshot.status).toBe('completed');
    expect(snapshot.events.filter((event) => event.type.startsWith('run.'))).toHaveLength(2);
    expect(snapshot.events.some((event) => event.type === 'run.cancelled')).toBe(false);
  });

  it('keeps a durable completed result when terminal audit append fails', async () => {
    let durableStatus: string | undefined;
    const service = new NewideBackendService(
      {
        run: async (request) => {
          request.onRunCreated?.({ run_id: 'run_audit_failed', task_id: 'task_audit_failed' });
          return completedResult('run_audit_failed', 'task_audit_failed');
        },
      },
      new InMemoryRunRegistry(),
      {
        initialize: async () => undefined,
        append: async (event) => {
          if (event.type === 'run.completed') throw new Error('audit unavailable');
        },
        flush: async () => undefined,
      },
      {
        finalize: async (snapshot) => {
          durableStatus = snapshot.status;
        },
      },
    );

    const created = await service.createRun({ prompt: 'Keep durable terminal result' });
    await service.waitForTerminal(created.run_id);
    await Promise.resolve();

    expect(durableStatus).toBe('completed');
    const snapshot = service.getSnapshot(created.run_id);
    expect(snapshot.status).toBe('completed');
    expect(snapshot.events.some((event) => event.type === 'run.completed')).toBe(true);
  });

  it('rejects cancellation when its terminal output cannot be persisted', async () => {
    const service = new NewideBackendService(
      {
        run: async (request) => {
          request.onRunCreated?.({ run_id: 'run_cancel_persist', task_id: 'task_cancel_persist' });
          await new Promise((_, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
              once: true,
            });
          });
          throw new Error('unreachable');
        },
      },
      new InMemoryRunRegistry(),
      {
        initialize: async () => undefined,
        append: async () => undefined,
        flush: async () => undefined,
      },
      { finalize: async () => Promise.reject(new Error('cancel output unavailable')) },
    );

    await service.createRun({ prompt: 'Cancel with unavailable storage' });
    await expect(service.cancelRun('run_cancel_persist')).rejects.toThrow(
      'cancel output unavailable',
    );
    expect(service.getSnapshot('run_cancel_persist')).toMatchObject({
      status: 'failed',
      error: { code: 'TERMINAL_OUTPUT_FAILED', message: 'cancel output unavailable' },
    });
  });

  it('publishes one persistence failure and keeps the background promise observed', async () => {
    let finalizeCalls = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const service = new NewideBackendService(
      {
        run: async (request) => {
          request.onRunCreated?.({ run_id: 'run_persist_failed', task_id: 'task_persist_failed' });
          return completedResult('run_persist_failed', 'task_persist_failed');
        },
      },
      new InMemoryRunRegistry(),
      {
        initialize: async () => undefined,
        append: async () => undefined,
        flush: async () => undefined,
      },
      {
        finalize: async () => {
          finalizeCalls += 1;
          throw new Error('disk unavailable');
        },
      },
    );

    try {
      const created = await service.createRun({ prompt: 'Expose persistence failure' });
      await expect(service.waitForTerminal(created.run_id)).rejects.toThrow('disk unavailable');
      const snapshot = service.getSnapshot(created.run_id);
      expect(snapshot).toMatchObject({
        status: 'failed',
        error: { code: 'TERMINAL_OUTPUT_FAILED', message: 'disk unavailable' },
      });
      expect(snapshot.events.filter((event) => event.type === 'run.completed')).toHaveLength(0);
      expect(snapshot.events.filter((event) => event.type === 'run.failed')).toHaveLength(1);
      expect(finalizeCalls).toBe(1);
      await Promise.resolve();
      expect(unhandled).toEqual([]);
      expect(
        (service as unknown as { terminalRuns: Map<string, Promise<void>> }).terminalRuns.size,
      ).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('records runner exceptions after identity as failed runs', async () => {
    const service = new NewideBackendService({
      run: async (request) => {
        request.onRunCreated?.({ run_id: 'run_failed', task_id: 'task_failed' });
        throw new Error('driver process exited');
      },
    });

    await service.createRun({ prompt: 'Fail safely', mode: 'council' });
    await viWaitFor(() => service.getSnapshot('run_failed').status === 'failed');
    expect(service.getSnapshot('run_failed')).toMatchObject({
      mode: 'council',
      error: { code: 'RUNNER_FAILED', message: 'driver process exited' },
    });
  });

  it('projects coordinator domain events without duplicating event-store telemetry', async () => {
    const service = new NewideBackendService({
      run: async (request) => {
        request.onEvent?.({
          event_id: 'event_task_created',
          event_type: 'task.created',
          subject_id: 'task_domain',
          task_id: 'task_domain',
          payload: { spec: 'Project events' },
          created_at: '2026-07-11T08:00:00.000Z',
          schema_version: 'v0',
        });
        request.onRunCreated?.({ run_id: 'run_domain', task_id: 'task_domain' });
        request.onEvent?.({
          event_id: 'event_artifact',
          event_type: 'artifact.registered',
          subject_id: 'artifact_1',
          run_id: 'run_domain',
          task_id: 'task_domain',
          payload: { type: 'patch' },
          created_at: '2026-07-11T08:00:01.000Z',
          schema_version: 'v0',
        });
        await request.telemetry?.emit({
          telemetry_id: 'telemetry_duplicate',
          event_type: 'task.created',
          owner: 'C-owned-observed',
          subject_id: 'task_domain',
          run_id: 'run_domain',
          task_id: 'task_domain',
          payload: { spec: 'Project events' },
          source: { kind: 'event_store', event_id: 'event_task_created' },
          created_at: '2026-07-11T08:00:00.000Z',
          schema_version: 'v0',
        });
        return new Promise<IntegrationV0Result>(() => undefined);
      },
    });

    await service.createRun({ prompt: 'Project events' });

    expect(service.getSnapshot('run_domain').events).toMatchObject([
      { event_id: 'event_task_created', type: 'task.created', source: 'coordinator' },
      { type: 'run.started', source: 'coordinator' },
      { event_id: 'event_artifact', type: 'artifact.registered', source: 'coordinator' },
    ]);
  });

  it('cancels the runner without replacing cancelled state with failure', async () => {
    let receivedSignal: AbortSignal | undefined;
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'backend-service-'));
    const service = new NewideBackendService(
      {
        run: async (request) => {
          receivedSignal = request.signal;
          request.onRunCreated?.({ run_id: 'run_cancelled', task_id: 'task_cancelled' });
          await new Promise((_, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
              once: true,
            });
          });
          throw new Error('unreachable');
        },
      },
      new InMemoryRunRegistry(),
      new FileRunAuditWriter(runsRoot),
      new FileRunTerminalOutputWriter(runsRoot),
    );

    try {
      await service.createRun({ prompt: 'Cancel safely' });
      await expect(service.cancelRun('run_cancelled')).resolves.toEqual({ cancelled: true });
      expect(receivedSignal?.aborted).toBe(true);
      await viWaitFor(() => service.getSnapshot('run_cancelled').status === 'cancelled');
      expect(service.getSnapshot('run_cancelled')).toMatchObject({
        status: 'cancelled',
        events: [{ type: 'run.started' }, { type: 'run.cancelled' }],
      });
      expect(service.getRunSnapshot('run_cancelled')).toMatchObject({
        status: 'cancelled',
        timeline: [{ type: 'run.started' }, { type: 'run.cancelled' }],
        agent_runs: [],
        artifacts: [],
        gates: [],
        errors: [],
        final_output: { status: 'cancelled' },
      });
      const audit = (await readFile(path.join(runsRoot, 'run_cancelled', 'audit.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(audit.map((event) => event.type)).toEqual(['run.started', 'run.cancelled']);
      await expect(
        readJson(path.join(runsRoot, 'run_cancelled', 'result.json')),
      ).resolves.toMatchObject({
        run_id: 'run_cancelled',
        task_id: 'task_cancelled',
        status: 'cancelled',
      });
      await expect(
        readJson(path.join(runsRoot, 'run_cancelled', 'frontend-snapshot.json')),
      ).resolves.toMatchObject({ status: 'cancelled' });
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('waits for active runners before closing runtime resources', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'backend-service-close-'));
    let runnerStopped = false;
    let runtimeCloseCount = 0;
    const service = new NewideBackendService(
      {
        run: async (request) => {
          request.onRunCreated?.({ run_id: 'run_close', task_id: 'task_close' });
          await new Promise((_, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => {
                runnerStopped = true;
                reject(request.signal?.reason);
              },
              { once: true },
            );
          });
          throw new Error('unreachable');
        },
      },
      new InMemoryRunRegistry(),
      new FileRunAuditWriter(runsRoot),
      new FileRunTerminalOutputWriter(runsRoot),
      new FileRunRequestStore(runsRoot),
      undefined,
      undefined,
      Promise.resolve(),
      async () => {
        expect(runnerStopped).toBe(true);
        runtimeCloseCount += 1;
      },
    );

    try {
      await service.createRun({ prompt: 'Close safely' });
      await Promise.all([service.close(), service.close()]);

      expect(service.getSnapshot('run_close')).toMatchObject({ status: 'cancelled' });
      expect(runtimeCloseCount).toBe(1);
      await expect(service.createRun({ prompt: 'Too late' })).rejects.toThrow(
        'Backend service is closing',
      );
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('aborts a pending start and rejects delayed identity after close begins', async () => {
    const registry = new InMemoryRunRegistry();
    let reportIdentity!: () => void;
    let runnerSignal: AbortSignal | undefined;
    let runtimeClosed = false;
    let beginRunCalls = 0;
    const taskProcessor = {
      beginRun: () => {
        beginRunCalls += 1;
      },
    } as unknown as TaskProcessor;
    const service = new NewideBackendService(
      {
        run: (request) => {
          runnerSignal = request.signal;
          return new Promise<IntegrationV0Result>((resolve, reject) => {
            reportIdentity = () => {
              try {
                request.onRunCreated?.({
                  run_id: 'run_delayed_identity',
                  task_id: 'task_delayed_identity',
                });
                resolve(completedResult('run_delayed_identity', 'task_delayed_identity'));
              } catch (error) {
                reject(error);
              }
            };
          });
        },
      },
      registry,
      undefined,
      undefined,
      undefined,
      taskProcessor,
      undefined,
      Promise.resolve(),
      async () => {
        runtimeClosed = true;
      },
    );

    const creating = service.createRun({ prompt: 'Delay identity until shutdown' });
    const closing = service.close();
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();

    expect(runnerSignal?.aborted).toBe(true);
    expect(closeSettled).toBe(false);
    expect(runtimeClosed).toBe(false);

    reportIdentity();

    await expect(creating).rejects.toThrow('Backend service is closing');
    await closing;
    expect(runtimeClosed).toBe(true);
    expect(registry.listSnapshots()).toEqual([]);
    expect(beginRunCalls).toBe(0);
  });

  it('waits for mailbox recovery before runtime close and aggregates both failures', async () => {
    const order: string[] = [];
    const recoveryFailure = new Error('mailbox recovery failed');
    const runtimeFailure = new Error('runtime close failed');
    let rejectRecovery!: (error: Error) => void;
    const mailboxRecovery = new Promise<void>((_resolve, reject) => {
      rejectRecovery = reject;
    }).then(
      () => order.push('mailbox recovery settled'),
      (error: unknown) => {
        order.push('mailbox recovery settled');
        throw error;
      },
    );
    const service = new NewideBackendService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mailboxRecovery,
      async () => {
        order.push('runtime closed');
        throw runtimeFailure;
      },
    );

    const closing = service.close();
    await Promise.resolve();
    expect(order).toEqual([]);

    rejectRecovery(recoveryFailure);

    let failure: unknown;
    try {
      await closing;
    } catch (error) {
      failure = error;
    }
    expect(order).toEqual(['mailbox recovery settled', 'runtime closed']);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([recoveryFailure, runtimeFailure]);
  });

  it('projects a real council run into snapshot and append-only audit events', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'backend-integration-events-'));
    const auditWriter = new FileRunAuditWriter(path.join(tempRoot, 'runs'));
    const service = new NewideBackendService(
      new IntegrationV0CoordinatorRunner({
        worktreePath: path.join(tempRoot, 'worktrees'),
        runsRoot: path.join(tempRoot, 'runs'),
      }),
      new InMemoryRunRegistry(),
      auditWriter,
      new FileRunTerminalOutputWriter(path.join(tempRoot, 'runs')),
    );
    try {
      const created = await service.createRun({
        prompt: 'Project the real Council event flow',
        mode: 'council',
      });
      await service.waitForTerminal(created.run_id);
      await auditWriter.flush(created.run_id);

      const types = service.getSnapshot(created.run_id).events.map((event) => event.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'task.created',
          'run.created',
          'driver.session_started',
          'driver.run_result',
          'artifact.registered',
          'gate.result',
          'council.started',
          'council.decision',
          'council.completed',
          'checkpoint.saved',
          'run.completed',
        ]),
      );
      expect(types.filter((type) => type === 'run.completed')).toHaveLength(1);

      const externalSnapshot = service.getRunSnapshot(created.run_id);
      expect(externalSnapshot).toMatchObject({
        mode: 'council',
        status: 'completed',
        council: {
          enabled: true,
          status: 'completed',
          verdict: 'select',
          can_create_merge_authorization: false,
        },
        final_output: { status: 'completed' },
      });
      expect(externalSnapshot.artifacts.length).toBeGreaterThan(0);
      expect(externalSnapshot.gates.length).toBeGreaterThan(0);
      expect(externalSnapshot.checkpoint).toBeDefined();
      expect(service.getSnapshot(created.run_id).snapshot?.links.result_path).toBe(
        path.join(tempRoot, 'runs', created.run_id, 'result.json'),
      );
      expect(runSnapshotSchema.parse(externalSnapshot)).toEqual(externalSnapshot);

      const audit = (
        await readFile(path.join(tempRoot, 'runs', created.run_id, 'audit.jsonl'), 'utf-8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(audit.map((event) => event.type)).toEqual(types);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves a gate failure across events, audit, snapshot, and terminal output', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'backend-gate-failure-'));
    const runsRoot = path.join(tempRoot, 'runs');
    const auditWriter = new FileRunAuditWriter(runsRoot);
    const service = new NewideBackendService(
      new IntegrationV0CoordinatorRunner({
        worktreePath: path.join(tempRoot, 'worktrees'),
        runsRoot,
        hookEngine: {
          handleEvent: async () => ({
            hook_point: 'task.completed',
            matched: true,
            gate_requests: [],
            gate_results: [
              {
                gate_result_id: 'gate_result_denied',
                gate_id: 'policy-gate',
                gate_point: 'task.completed',
                request_id: 'gate_request_denied',
                subject_id: 'task_under_review',
                decision: 'deny',
                reason: 'policy rejected the artifact',
                required_actions: ['fix-policy'],
                target_state: 'blocked',
                created_at: '2026-07-11T08:00:00.000Z',
                schema_version: 'v0',
              },
            ],
            final_decision: 'deny',
            created_at: '2026-07-11T08:00:00.000Z',
            schema_version: 'v0',
          }),
        },
      }),
      new InMemoryRunRegistry(),
      auditWriter,
      new FileRunTerminalOutputWriter(runsRoot),
    );

    try {
      const created = await service.createRun({ prompt: 'Reject this artifact' });
      const notifications: AppRunEvent[] = [];
      service.subscribe(created.run_id, (event) => notifications.push(event));
      await service.waitForTerminal(created.run_id);
      await auditWriter.flush(created.run_id);

      const snapshot = service.getRunSnapshot(created.run_id);
      expect(snapshot.errors).toEqual([
        expect.objectContaining({
          code: 'GATE_DENIED',
          details: expect.objectContaining({ phase: 'gate' }),
        }),
      ]);
      expect(snapshot.checkpoint).toBeDefined();
      expect(snapshot.final_output?.files_written).toEqual([]);

      const events = service.getSnapshot(created.run_id).events;
      expect(events.filter((event) => event.type === 'gate.result')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'worktree.materialized')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'run.failed', payload: { code: 'GATE_DENIED' } });
      expect(notifications.at(-1)?.payload).toEqual({
        code: snapshot.errors[0]!.code,
        message: snapshot.errors[0]!.message,
        details: snapshot.errors[0]!.details,
      });

      const audit = (await readFile(path.join(runsRoot, created.run_id, 'audit.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(audit.at(-1)).toMatchObject({
        type: 'run.failed',
        payload: { code: 'GATE_DENIED', details: { phase: 'gate' } },
      });
      await expect(
        readJson(path.join(runsRoot, created.run_id, 'frontend-snapshot.json')),
      ).resolves.toMatchObject({ checkpoint: {}, final_output: { files_written: [] } });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not met');
}

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

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}
