import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  createProductionBackendService,
  parseDriverEnv,
  startBackendRpcServer,
} from '../../src/app/backend-rpc-stdio';
import type { NewideBackendService } from '../../src/app/newide-backend-service';
import type { AppRunEvent } from '../../src/app/run-registry';
import { TaskProcessor } from '../../src/app/task-processor';
import {
  InMemoryBufferRepository,
  InMemoryRepository,
  type LlmClient,
  type ToolCallingClient,
} from '../../src/memory';
import { SqliteCoordinationStore } from '../../src/persistence';
import type { BackendBRuntime } from '../../src/app/production-b-runtime';
import {
  BMemoryMaintenanceRunner,
  FileBMemoryMaintenanceEvidenceStore,
} from '../../src/app/b-memory-maintenance-runner';

describe('backend RPC stdio entrypoint', () => {
  it('fails fast when the configured ACP runner directory does not exist', async () => {
    const runnerDir = path.join(process.cwd(), '.newide', 'missing-acp-runner');

    await expect(
      createProductionBackendService(
        {
          ACP_DRIVER_RUNNER_DIR: runnerDir,
          ACP_AGENT_ID: 'claude',
        },
        { bRuntime: createInMemoryBRuntime() },
      ),
    ).rejects.toThrow(`ACP driver runner directory not found: ${runnerDir}`);
  });

  it('rejects a file and a package without the driver:run script as ACP runners', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'newide-acp-runner-'));
    const runnerFile = path.join(root, 'runner');
    writeFileSync(runnerFile, 'not a directory');
    await expect(
      createProductionBackendService(
        { ACP_DRIVER_RUNNER_DIR: runnerFile },
        { bRuntime: createInMemoryBRuntime() },
      ),
    ).rejects.toThrow(`ACP driver runner path is not a directory: ${runnerFile}`);

    writeFileSync(path.join(root, 'package.json'), '{"scripts":{}}');
    await expect(
      createProductionBackendService(
        { ACP_DRIVER_RUNNER_DIR: root },
        { bRuntime: createInMemoryBRuntime() },
      ),
    ).rejects.toThrow(`ACP driver runner has no driver:run script: ${root}`);
    writeFileSync(path.join(root, 'package.json'), '{"scripts":{"driver:run":"   "}}');
    await expect(
      createProductionBackendService(
        { ACP_DRIVER_RUNNER_DIR: root },
        { bRuntime: createInMemoryBRuntime() },
      ),
    ).rejects.toThrow(`ACP driver runner has no driver:run script: ${root}`);
    rmSync(root, { recursive: true });
  });

  it('accepts an explicitly injected in-memory B runtime without a database URL', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'newide-explicit-b-runtime-'));
    const close = vi.fn(async () => undefined);
    try {
      writeFileSync(path.join(root, 'package.json'), '{"scripts":{"driver:run":"exit 0"}}');

      const service = await createProductionBackendService(
        {
          ACP_DRIVER_RUNNER_DIR: root,
          NEWIDE_COORDINATION_DB: ':memory:',
        },
        { bRuntime: createInMemoryBRuntime(close), agentLlm: invokeDriverLlm() },
      );

      await service.close();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing', undefined],
    ['empty', []],
    ['blank', ['role_ts_engineer', ' ']],
    ['duplicate', ['role_ts_engineer', 'role_ts_engineer']],
  ])('rejects %s market_agent_ids from an injected B runtime', async (_label, marketAgentIds) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'newide-invalid-market-catalog-'));
    const close = vi.fn(async () => undefined);
    const runtime = {
      ...createInMemoryBRuntime(close),
      market_agent_ids: marketAgentIds,
    } as unknown as BackendBRuntime;
    try {
      writeFileSync(path.join(root, 'package.json'), '{"scripts":{"driver:run":"exit 0"}}');

      await expect(
        createProductionBackendService(
          { ACP_DRIVER_RUNNER_DIR: root, NEWIDE_COORDINATION_DB: ':memory:' },
          { bRuntime: runtime, agentLlm: invokeDriverLlm() },
        ),
      ).rejects.toThrow('Production B runtime must provide non-empty, unique market_agent_ids');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('waits for app-owned B maintenance to become idle before closing the B runtime', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'newide-b-maintenance-shutdown-'));
    const bRuntime = createInMemoryBRuntime(vi.fn(async () => undefined));
    const maintenance = new BMemoryMaintenanceRunner({
      repository: bRuntime.repository,
      bufferRepository: bRuntime.bufferRepository,
      llm: maintenanceLlm(),
      evidenceStore: new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'maintenance')),
    });
    let markWaitEntered!: () => void;
    const waitEntered = new Promise<void>((resolve) => {
      markWaitEntered = resolve;
    });
    let releaseIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    const waitForIdle = vi.spyOn(maintenance, 'waitForIdle').mockImplementation(async () => {
      markWaitEntered();
      await idle;
    });
    vi.spyOn(maintenance, 'replayPending').mockResolvedValue([]);

    try {
      writeFileSync(path.join(root, 'package.json'), '{"scripts":{"driver:run":"exit 0"}}');
      const service = await createProductionBackendService(
        { ACP_DRIVER_RUNNER_DIR: root, NEWIDE_COORDINATION_DB: ':memory:' },
        { bRuntime, memoryMaintenance: maintenance, agentLlm: invokeDriverLlm() },
      );

      const closing = service.close();
      await waitEntered;
      expect(bRuntime.close).not.toHaveBeenCalled();
      releaseIdle();
      await closing;

      expect(waitForIdle).toHaveBeenCalledOnce();
      expect(bRuntime.close).toHaveBeenCalledOnce();
    } finally {
      releaseIdle();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('waits for the injected B repository before returning a ready service', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'newide-delayed-b-runtime-'));
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    class DelayedRepository extends InMemoryRepository {
      override async listAgentIds(): Promise<string[]> {
        markEntered();
        await ready;
        return super.listAgentIds();
      }
    }
    try {
      writeFileSync(path.join(root, 'package.json'), '{"scripts":{"driver:run":"exit 0"}}');
      let settled = false;
      const servicePromise = createProductionBackendService(
        { ACP_DRIVER_RUNNER_DIR: root, NEWIDE_COORDINATION_DB: ':memory:' },
        {
          bRuntime: {
            repository: new DelayedRepository(),
            bufferRepository: new InMemoryBufferRepository(),
            app_state_root: path.join(root, '.newide'),
            market_agent_ids: ['role_fullstack_engineer', 'role_ts_engineer'],
            close: async () => undefined,
          },
          agentLlm: invokeDriverLlm(),
        },
      ).then((service) => {
        settled = true;
        return service;
      });

      await entered;
      expect(settled).toBe(false);
      release();
      const service = await servicePromise;
      await service.close();
    } finally {
      release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sanitizes a failure from the B Agent manager readiness check', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'newide-b-manager-failure-'));
    const secret = 'postgres://user:secret@localhost/newide';
    const close = vi.fn(async () => undefined);
    class FailingRepository extends InMemoryRepository {
      override async listAgentIds(): Promise<string[]> {
        throw new Error(`connection failed: ${secret}`);
      }
    }
    try {
      writeFileSync(path.join(root, 'package.json'), '{"scripts":{"driver:run":"exit 0"}}');

      let failure: unknown;
      try {
        await createProductionBackendService(
          { ACP_DRIVER_RUNNER_DIR: root, NEWIDE_COORDINATION_DB: ':memory:' },
          {
            bRuntime: {
              repository: new FailingRepository(),
              bufferRepository: new InMemoryBufferRepository(),
              app_state_root: path.join(root, '.newide'),
              market_agent_ids: ['role_fullstack_engineer', 'role_ts_engineer'],
              close,
            },
            agentLlm: invokeDriverLlm(),
          },
        );
      } catch (error) {
        failure = error;
      }

      expect(String(failure)).toContain('Production B Agent manager readiness check failed');
      expect(String(failure)).not.toContain(secret);
      expect(String(failure)).not.toContain('secret');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses only valid env assignments and preserves equals signs in values', () => {
    expect(
      parseDriverEnv('GOOD="quoted"\nTOKEN=a=b=c\nINVALID-KEY=no\n=no-key\n# comment'),
    ).toEqual({ GOOD: 'quoted', TOKEN: 'a=b=c' });
  });

  it('blocks a persisted active run when the production service starts', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'newide-startup-recovery-'));
    const runnerDir = path.join(root, 'runner');
    const databasePath = path.join(root, 'coordination.sqlite');
    const workspacePath = path.join(root, 'workspace');
    let service: Awaited<ReturnType<typeof createProductionBackendService>> | undefined;
    try {
      mkdirSync(runnerDir, { recursive: true });
      writeFileSync(path.join(runnerDir, 'package.json'), '{"scripts":{"driver:run":"exit 99"}}');
      const seedStore = new SqliteCoordinationStore(databasePath);
      const seedProcessor = new TaskProcessor(seedStore);
      seedProcessor.beginRun({
        task_id: 'task_interrupted',
        run_id: 'run_interrupted',
        task_request: {
          spec: 'Recover without automatically executing',
          completion_criteria: ['Task is blocked until explicit resume'],
        },
        workspace_path: workspacePath,
        mode: 'single_agent',
        session_id: 'session_interrupted',
      });
      seedStore.close();

      service = await createProductionBackendService(
        {
          ACP_DRIVER_RUNNER_DIR: runnerDir,
          NEWIDE_COORDINATION_DB: databasePath,
        },
        { bRuntime: createInMemoryBRuntime() },
      );

      await expect(service.getTask('task_interrupted')).resolves.toMatchObject({
        task: { status: 'blocked' },
        run_history: [
          {
            run_id: 'run_interrupted',
            status: 'interrupted',
            session_id: 'session_interrupted',
          },
        ],
        waiting_reason: 'The backend process ended before the active run reached a terminal state.',
      });
      const evidenceStore = new SqliteCoordinationStore(databasePath);
      expect(evidenceStore.getLatestCheckpoint('task_interrupted')).toMatchObject({
        run_id: 'run_interrupted',
        session_id: 'session_interrupted',
        trigger: 'blocked',
        validity_status: 'valid',
      });
      evidenceStore.close();
    } finally {
      await service?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('executes the production C-to-B-to-A chain through a real driver:run process', async () => {
    const runnerDir = mkdtempSync(path.join(os.tmpdir(), 'newide-fake-acp-'));
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'newide-fake-workspace-'));
    let created: { run_id: string; task_id: string } | undefined;
    let councilCreated: { run_id: string; task_id: string } | undefined;
    let failedCouncilCreated: { run_id: string; task_id: string } | undefined;
    let marketEvidenceDirectory: string | undefined;
    let service: Awaited<ReturnType<typeof createProductionBackendService>> | undefined;
    try {
      const bRuntime = createInMemoryBRuntime();
      await bRuntime.repository.initializeAgent({
        role_id: 'reviewer',
        name: 'Council Reviewer',
        tags: ['council_only'],
        persona_seed: 'Review Council proposals only.',
      });
      await bRuntime.bufferRepository.ensureAgent('reviewer');
      writeFileSync(
        path.join(runnerDir, 'package.json'),
        '{"scripts":{"driver:run":"node fake-driver.mjs"}}',
      );
      writeFileSync(
        path.join(runnerDir, '.env'),
        'NEWIDE_B_DATABASE_URL=postgres://should-not-reach-acp-child\n',
      );
      writeFileSync(
        path.join(runnerDir, 'fake-driver.mjs'),
        `import { appendFileSync, existsSync } from 'node:fs';
	let body='';
	process.stdin.on('data', chunk => body += chunk);
	process.stdin.on('end', () => {
	  const invocationLog = new URL('./invocations.log', import.meta.url);
	  appendFileSync(invocationLog, 'invoke\\n');
	  appendFileSync(new URL('./b-env.log', import.meta.url), Object.hasOwn(process.env, 'NEWIDE_B_DATABASE_URL') ? 'present\\n' : 'absent\\n');
	  const input = JSON.parse(body);
  appendFileSync(new URL('./prompts.log', import.meta.url), input.prompt + '\\n');
  const created_at = new Date().toISOString();
  const reviewerFailed = existsSync(new URL('./fail-reviewer', import.meta.url)) && input.prompt.includes('Review the isolated proposal inputs');
  const councilRole = String(input.workspace_path || '').includes('.newide/council');
  const artifact = { artifact_id: 'artifact_fake_acp', type: councilRole ? 'diff' : 'driver_result', uri: 'artifact://fake/result', producer_id: 'claude-fake', task_id: input.task_id, ...(councilRole ? { content: { kind: 'text', content_ref: 'data:text/plain,COUNCIL_FINAL%0A', target_path: 'council-output.txt', media_type: 'text/plain' } } : {}), created_at, schema_version: input.schema_version };
  process.stdout.write(JSON.stringify({ driver_run_result_id: 'driver_result_fake_acp', session_id: 'session_fake_acp', status: reviewerFailed ? 'failed' : 'succeeded', response: reviewerFailed ? '' : 'Fake ACP completed the request.', artifacts: reviewerFailed ? [] : [artifact], transcript_ref: { ...artifact, artifact_id: 'transcript_fake_acp', type: 'transcript' }, tool_events: [], diagnostics: { driver_id: 'claude-fake', duration_ms: 1, notes: ['fake ACP process'] }, ...(reviewerFailed ? { error: { code: 'FAKE_REVIEW_FAILURE', message: 'controlled failure', retryable: false } } : {}), created_at, schema_version: input.schema_version }));
});
`,
      );

      service = await createProductionBackendService(
        {
          ACP_DRIVER_RUNNER_DIR: runnerDir,
          NEWIDE_COORDINATION_DB: path.join(runnerDir, 'coordination.sqlite'),
        },
        {
          agentLlm: invokeDriverLlm(),
          memoryLlm: maintenanceLlm(),
          bRuntime,
        },
      );
      created = await service.createRun({
        prompt: 'Exercise production composition.',
        workspace_path: workspaceDir,
      });
      const snapshot = await waitForTerminal(service, created.run_id);

      expect(snapshot.status).toBe('completed');
      expect(snapshot.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'market.selected',
          'agent.execution_requested',
          'agent.execution_completed',
        ]),
      );
      const marketEvent = snapshot.events.find((event) => event.type === 'market.selected');
      expect(marketEvent).toMatchObject({
        payload: {
          winner_agent_id: 'role_ts_engineer',
          winner_bid_id: expect.stringMatching(/^bid_[a-f0-9]{24}$/),
          ledger_ref: expect.stringMatching(/^file:/),
          audit_ref: expect.stringMatching(/^file:/),
          policy_version: 'market-v0',
          seed: created.run_id,
        },
      });
      const ledgerRef = marketEvent?.payload.ledger_ref;
      const auditRef = marketEvent?.payload.audit_ref;
      expect(typeof ledgerRef).toBe('string');
      expect(typeof auditRef).toBe('string');
      if (typeof ledgerRef === 'string' && typeof auditRef === 'string') {
        const ledgerPath = fileURLToPath(ledgerRef);
        marketEvidenceDirectory = path.dirname(ledgerPath);
        expect(JSON.parse(readFileSync(ledgerPath, 'utf8'))).toMatchObject({
          policy_version: 'market-v0',
          seed: created.run_id,
          winner_agent_id: 'role_ts_engineer',
          bids: [expect.objectContaining({ agent_id: 'role_ts_engineer' })],
        });
        expect(JSON.parse(readFileSync(fileURLToPath(auditRef), 'utf8'))).toMatchObject({
          policy_version: 'market-v0',
          seed: created.run_id,
          winner_agent_id: 'role_ts_engineer',
        });
      }
      expect(snapshot.snapshot?.delivery_report.driver_diagnostics.driver_id).toBe('claude-fake');
      expect(snapshot.snapshot?.delivery_report.driver_diagnostics.driver_id).not.toBe(
        'mock-driver',
      );
      expect(snapshot.snapshot?.delivery_report).toMatchObject({
        outcome: 'completed_response',
        response: 'Fake ACP completed the request.',
        session_id: 'session_fake_acp',
        changed_files: [],
        tool_events: [],
      });
      expect(snapshot.events).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'agent.execution_completed' })]),
      );
      expect(
        snapshot.events.find((event) => event.type === 'agent.execution_completed'),
      ).toMatchObject({
        payload: {
          agent_id: 'role_ts_engineer',
          context_pack_ref: expect.stringMatching(/^context_pack_[a-f0-9]{24}$/),
          memory_buffer_ref: expect.stringMatching(/^role_ts_engineer:[1-9]\d*$/),
          driver_run_result_id: 'driver_result_fake_acp',
          session_id: 'session_fake_acp',
          artifact_refs: ['artifact_fake_acp'],
          transcript_ref: 'transcript_fake_acp',
          diagnostics: expect.objectContaining({ context_pack_persisted: true }),
        },
      });

      councilCreated = await service.createRun({
        prompt: 'Exercise production council composition.',
        mode: 'council',
        workspace_path: workspaceDir,
      });
      const notifications: AppRunEvent[] = [];
      const unsubscribe = service.subscribe(councilCreated.run_id, (event) =>
        notifications.push(event),
      );
      const councilSnapshot = await waitForTerminal(service, councilCreated.run_id);
      unsubscribe();
      expect(councilSnapshot.status).toBe('completed');
      const councilEventTypes = councilSnapshot.events.map((event) => event.type);
      expect(councilEventTypes).not.toContain('market.selected');
      expect(
        councilEventTypes.filter((type) => type === 'council.proposal.completed'),
      ).toHaveLength(2);
      expect(councilEventTypes.filter((type) => type === 'council.review.completed')).toHaveLength(
        1,
      );
      expect(
        councilEventTypes.filter((type) => type === 'council.synthesis.completed'),
      ).toHaveLength(1);
      expect(councilEventTypes.filter((type) => type === 'gate.result')).toHaveLength(2);
      expect(councilEventTypes.indexOf('council.completed')).toBeLessThan(
        councilEventTypes.indexOf('artifact.selected'),
      );
      expect(councilEventTypes.indexOf('artifact.selected')).toBeLessThan(
        councilEventTypes.lastIndexOf('gate.result'),
      );
      expect(councilEventTypes.lastIndexOf('gate.result')).toBeLessThan(
        councilEventTypes.indexOf('worktree.materialized'),
      );
      expect(councilSnapshot.snapshot?.delivery_report.files_written.length).toBeGreaterThan(0);
      const councilResult = councilSnapshot.snapshot?.council?.result;
      const deliveredCouncilFile = readFileSync(path.join(workspaceDir, 'council-output.txt'));
      expect(councilResult).toMatchObject({
        quality: 'best_effort',
        final_artifact_ref: 'artifact_fake_acp',
        final_artifact_sha256: createHash('sha256').update(deliveredCouncilFile).digest('hex'),
        decision_record_ref: expect.stringMatching(/^council_decision_/),
      });
      const audit = readFileSync(
        path.join('.newide', 'runs', councilCreated.run_id, 'audit.jsonl'),
        'utf8',
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AppRunEvent);
      const keyTypes = [
        'council.completed',
        'artifact.selected',
        'gate.result',
        'worktree.materialized',
      ];
      const expectedOrder = [
        'council.completed',
        'artifact.selected',
        'gate.result',
        'worktree.materialized',
      ];
      const postCouncilSequence = (types: string[]) =>
        types.slice(types.indexOf('council.completed')).filter((type) => keyTypes.includes(type));
      expect(postCouncilSequence(notifications.map((event) => event.type))).toEqual(expectedOrder);
      expect(postCouncilSequence(audit.map((event) => event.type))).toEqual(expectedOrder);
      expect(postCouncilSequence(councilEventTypes)).toEqual(expectedOrder);
      expect(
        readFileSync(path.join(runnerDir, 'invocations.log'), 'utf8').trim().split('\n'),
      ).toHaveLength(6);
      expect(readFileSync(path.join(runnerDir, 'b-env.log'), 'utf8').trim().split('\n')).toEqual(
        Array.from({ length: 6 }, () => 'absent'),
      );
      const driverPrompts = readFileSync(path.join(runnerDir, 'prompts.log'), 'utf8');
      expect(driverPrompts).toContain('Exercise production composition.');
      expect(driverPrompts).toContain('Produce proposal A for:');
      expect(driverPrompts).toContain('Review the isolated proposal inputs');
      expect(driverPrompts).toContain('Synthesis round 1');

      writeFileSync(path.join(runnerDir, 'fail-reviewer'), '1');
      failedCouncilCreated = await service.createRun({
        prompt: 'Exercise structured Council reviewer failure.',
        mode: 'council',
        workspace_path: workspaceDir,
      });
      const failedNotifications: AppRunEvent[] = [];
      const unsubscribeFailed = service.subscribe(failedCouncilCreated.run_id, (event) =>
        failedNotifications.push(event),
      );
      const failedSnapshot = await waitForTerminal(service, failedCouncilCreated.run_id);
      unsubscribeFailed();
      expect(service.getRunSnapshot(failedCouncilCreated.run_id)).toMatchObject({
        status: 'completed',
        council: {
          result: {
            quality: 'best_effort',
            warnings: expect.arrayContaining([
              'Council verification did not fully pass; delivering the best available artifact.',
            ]),
          },
        },
        errors: [],
      });
      expect(failedNotifications.map((event) => event.type)).toEqual(
        expect.arrayContaining(['council.failed', 'council.completed', 'run.completed']),
      );
      expect(failedSnapshot.events.map((event) => event.type)).toContain('council.completed');
      expect(failedSnapshot.events.map((event) => event.type)).toContain('worktree.materialized');
      const failedAudit = readFileSync(
        path.join('.newide', 'runs', failedCouncilCreated.run_id, 'audit.jsonl'),
        'utf8',
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AppRunEvent);
      expect(failedAudit.map((event) => event.type)).toEqual(
        expect.arrayContaining(['council.failed', 'council.completed', 'run.completed']),
      );
    } finally {
      await service?.close();
      rmSync(runnerDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
      if (marketEvidenceDirectory) {
        rmSync(marketEvidenceDirectory, { recursive: true, force: true });
      }
      if (created) {
        rmSync(path.join('.newide', 'runs', created.run_id), { recursive: true, force: true });
        rmSync(path.join('.newide', 'worktrees', created.task_id), {
          recursive: true,
          force: true,
        });
      }
      if (councilCreated) {
        rmSync(path.join('.newide', 'runs', councilCreated.run_id), {
          recursive: true,
          force: true,
        });
        rmSync(path.join('.newide', 'worktrees', councilCreated.task_id), {
          recursive: true,
          force: true,
        });
      }
      if (failedCouncilCreated) {
        rmSync(path.join('.newide', 'runs', failedCouncilCreated.run_id), {
          recursive: true,
          force: true,
        });
        rmSync(path.join('.newide', 'worktrees', failedCouncilCreated.task_id), {
          recursive: true,
          force: true,
        });
      }
    }
  }, 15_000);

  it('answers ping over a child fixture and exits on stdin EOF', async () => {
    const runnerDir = mkdtempSync(path.join(os.tmpdir(), 'newide-acp-runner-'));
    writeFileSync(path.join(runnerDir, 'package.json'), '{"scripts":{"driver:run":"exit 0"}}');
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/task-rpc-server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ACP_DRIVER_RUNNER_DIR: runnerDir,
        NEWIDE_COORDINATION_DB: path.join(runnerDir, 'coordination.sqlite'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout });
    const firstLine = once(lines, 'line');

    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"system.ping"}\n');
    expect(JSON.parse(String((await firstLine)[0]))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { status: 'ok', protocol_version: '0.1.0' },
    });

    child.stdin.end();
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
    rmSync(runnerDir, { recursive: true });
  }, 15_000);

  it('does not start stdio before the production B runtime is ready', async () => {
    const runnerDir = mkdtempSync(path.join(os.tmpdir(), 'newide-production-readiness-'));
    writeFileSync(path.join(runnerDir, 'package.json'), '{"scripts":{"driver:run":"exit 0"}}');
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/app/backend-rpc-stdio.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ACP_DRIVER_RUNNER_DIR: runnerDir,
        NEWIDE_B_DATABASE_URL: '   ',
        NEWIDE_COORDINATION_DB: path.join(runnerDir, 'coordination.sqlite'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));

    const [code] = await once(child, 'exit');

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('NEWIDE_B_DATABASE_URL is required for the production B runtime');
    rmSync(runnerDir, { recursive: true, force: true });
  }, 15_000);

  it('closes the service only once across explicit close and input EOF', async () => {
    const input = new PassThrough();
    const close = vi.fn(async () => undefined);
    const service = { close } as unknown as NewideBackendService;
    const server = startBackendRpcServer({ input, writeLine: () => undefined, service });

    const firstClose = server.close();
    input.end();
    await Promise.all([firstClose, server.close(), server.closed]);

    expect(close).toHaveBeenCalledOnce();
  });
});

async function waitForTerminal(
  service: Awaited<ReturnType<typeof createProductionBackendService>>,
  runId: string,
) {
  await service.waitForTerminal(runId);
  return service.getSnapshot(runId);
}

function createInMemoryBRuntime(close = async () => undefined): BackendBRuntime {
  return {
    repository: new InMemoryRepository(),
    bufferRepository: new InMemoryBufferRepository(),
    app_state_root: path.join(process.cwd(), '.newide'),
    market_agent_ids: ['role_fullstack_engineer', 'role_ts_engineer'],
    close,
  };
}

function invokeDriverLlm(): ToolCallingClient {
  let sequence = 0;
  return {
    async completeWithTools(input) {
      const lastMessage = input.messages.at(-1);
      if (lastMessage?.role === 'tool') {
        return { content: 'Task completed. [done]', tool_calls: undefined };
      }
      const userMessage = [...input.messages].reverse().find((message) => message.role === 'user');
      sequence += 1;
      return {
        content: null,
        tool_calls: [
          {
            id: `backend_tool_call_${String(sequence)}`,
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({
                instruction: userMessage?.content?.replace(/^Task:\s*/, '') ?? 'Execute task.',
              }),
            },
          },
        ],
      };
    },
  };
}

function maintenanceLlm(): LlmClient {
  return {
    async complete() {
      return JSON.stringify({
        experiences: [
          {
            description: 'Production composition evidence',
            content: 'The backend completed a task through B and A.',
            type: 'positive',
            confidence: 0.9,
            tags: ['acceptance'],
          },
        ],
      });
    },
  };
}
