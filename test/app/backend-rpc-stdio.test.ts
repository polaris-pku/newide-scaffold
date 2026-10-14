import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProductionBackendService,
  parseDriverEnv,
  ProductionAgentToolCallingClient,
  readAuctionEnabled,
  readCouncilAuctionEnabled,
  readCouncilProposerCount,
  readTelemetryJsonlEnabled,
  resolveProductionLlmRuntime,
  startBackendRpcServer,
} from '../../src/app/backend-rpc-stdio';
import type { NewideBackendService } from '../../src/app/newide-backend-service';
import type { AppRunEvent } from '../../src/app/run-registry';
import { TaskProcessor } from '../../src/coordination';
import {
  FileBufferRepository,
  FileMemoryDeliveryRepository,
  InMemoryBufferRepository,
  InMemoryMemoryDeliveryRepository,
  InMemoryRepository,
  type LlmClient,
  type ToolCallingClient,
} from '../../src/memory';
import { SqliteCoordinationStore } from '../../src/persistence';
import { listAgentActivities } from '../../src/telemetry';
import type { BackendBRuntime } from '../../src/app/production-b-runtime';
import {
  BMemoryMaintenanceRunner,
  FileBMemoryMaintenanceEvidenceStore,
} from '../../src/app/b-memory-maintenance-runner';
import { writeFakeAcpRunnerBuild } from '../fixtures/fake-acp-runner-build';

describe('readAuctionEnabled', () => {
  it('defaults to true when unset', () => {
    expect(readAuctionEnabled(undefined)).toBe(true);
    expect(readAuctionEnabled('')).toBe(true);
    expect(readAuctionEnabled('  ')).toBe(true);
  });

  it('parses disable and enable values', () => {
    expect(readAuctionEnabled('0')).toBe(false);
    expect(readAuctionEnabled('false')).toBe(false);
    expect(readAuctionEnabled('FALSE')).toBe(false);
    expect(readAuctionEnabled('1')).toBe(true);
    expect(readAuctionEnabled('true')).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(() => readAuctionEnabled('maybe')).toThrow('NEWIDE_AUCTION_ENABLED');
  });
});

describe('readTelemetryJsonlEnabled', () => {
  it('defaults to on', () => {
    expect(readTelemetryJsonlEnabled(undefined)).toBe(true);
    expect(readTelemetryJsonlEnabled('')).toBe(true);
  });

  it('parses the off switch', () => {
    expect(readTelemetryJsonlEnabled('0')).toBe(false);
    expect(readTelemetryJsonlEnabled('false')).toBe(false);
    expect(readTelemetryJsonlEnabled('FALSE')).toBe(false);
    expect(readTelemetryJsonlEnabled('1')).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(() => readTelemetryJsonlEnabled('maybe')).toThrow('NEWIDE_TELEMETRY_JSONL');
  });
});

describe('Council auction configuration', () => {
  it('keeps dynamic Council selection opt-in and parses proposer count', () => {
    expect(readCouncilAuctionEnabled(undefined)).toBe(false);
    expect(readCouncilAuctionEnabled('1')).toBe(true);
    expect(readCouncilAuctionEnabled('false')).toBe(false);
    expect(readCouncilProposerCount(undefined)).toBe(2);
    expect(readCouncilProposerCount('3')).toBe(3);
    expect(() => readCouncilAuctionEnabled('maybe')).toThrow('NEWIDE_COUNCIL_AUCTION_ENABLED');
    expect(() => readCouncilProposerCount('1')).toThrow('NEWIDE_COUNCIL_PROPOSERS');
  });
});

describe('resolveProductionLlmRuntime', () => {
  it('reuses ACP MiniMax settings through the OpenAI-compatible endpoint', () => {
    expect(
      resolveProductionLlmRuntime(
        {},
        {
          ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'acp-token',
          ANTHROPIC_MODEL: 'MiniMax-M3',
        },
      ),
    ).toEqual({
      baseUrl: 'https://api.minimax.io',
      apiKey: 'acp-token',
      model: 'MiniMax-M3',
    });
  });

  it('keeps an explicit local OpenAI-compatible configuration authoritative', () => {
    expect(
      resolveProductionLlmRuntime(
        {
          OPENAI_BASE_URL: 'https://local.example/v1',
          OPENAI_API_KEY: 'local-token',
          NEWIDE_AGENT_LLM_MODEL: 'local-model',
        },
        {
          ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'acp-token',
          ANTHROPIC_MODEL: 'MiniMax-M3',
        },
      ),
    ).toEqual({
      baseUrl: 'https://local.example',
      apiKey: 'local-token',
      model: 'local-model',
    });
  });

  it('does not let an inherited Anthropic environment override ACP configuration', () => {
    expect(
      resolveProductionLlmRuntime(
        {
          ANTHROPIC_BASE_URL: 'https://stale.example/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'stale-token',
          ANTHROPIC_MODEL: 'stale-model',
        },
        {
          ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'acp-token',
          ANTHROPIC_MODEL: 'MiniMax-M3',
        },
      ),
    ).toEqual({
      baseUrl: 'https://api.minimax.io',
      apiKey: 'acp-token',
      model: 'MiniMax-M3',
    });
  });
});

describe('ProductionAgentToolCallingClient', () => {
  it('retries one malformed MiniMax function-arguments response', async () => {
    const completeWithTools = vi
      .fn<
        ToolCallingClient['completeWithTools']
      >()
      .mockRejectedValueOnce(
        new Error('invalid params, invalid function arguments json string (2013)'),
      )
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: 'call_driver',
            type: 'function',
            function: { name: 'invoke_driver', arguments: '{}' },
          },
        ],
      });
    const client = new ProductionAgentToolCallingClient({ completeWithTools });

    await expect(
      client.completeWithTools({
        messages: [{ role: 'user', content: 'delegate' }],
        tools: [
          {
            type: 'function',
            function: { name: 'invoke_driver', description: 'run', parameters: { type: 'object' } },
          },
        ],
      }),
    ).resolves.toMatchObject({ tool_calls: [{ function: { name: 'invoke_driver' } }] });
    expect(completeWithTools).toHaveBeenCalledTimes(2);
  });

  it('falls back to the real Driver after repeated malformed MiniMax tool arguments', async () => {
    const completeWithTools = vi
      .fn<ToolCallingClient['completeWithTools']>()
      .mockRejectedValue(new Error('invalid params, invalid function arguments json string (2013)'));
    const client = new ProductionAgentToolCallingClient({ completeWithTools });

    await expect(
      client.completeWithTools({
        messages: [{ role: 'user', content: 'Task: Review the submitted plan.' }],
        tools: [
          {
            type: 'function',
            function: { name: 'invoke_driver', description: 'Run the real Driver', parameters: {} },
          },
        ],
      }),
    ).resolves.toMatchObject({
      tool_calls: [
        {
          function: {
            name: 'invoke_driver',
            arguments: JSON.stringify({ instruction: 'Review the submitted plan.' }),
          },
        },
      ],
    });
    expect(completeWithTools).toHaveBeenCalledTimes(2);
  });

  it('forces one real Driver tool call after two text-only responses', async () => {
    const completeWithTools = vi
      .fn<ToolCallingClient['completeWithTools']>()
      .mockResolvedValueOnce({ content: 'I will handle it.', tool_calls: undefined })
      .mockResolvedValueOnce({ content: 'Still text only.', tool_calls: undefined });
    const client = new ProductionAgentToolCallingClient({ completeWithTools });

    const result = await client.completeWithTools({
      messages: [{ role: 'user', content: 'Task: Implement the requested file.' }],
      tools: [
        {
          type: 'function',
          function: { name: 'invoke_driver', description: 'run', parameters: { type: 'object' } },
        },
      ],
    });

    expect(result.tool_calls).toMatchObject([
      {
        function: {
          name: 'invoke_driver',
          arguments: JSON.stringify({ instruction: 'Implement the requested file.' }),
        },
      },
    ]);
    expect(completeWithTools).toHaveBeenCalledTimes(2);
  });
});

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
      writeFakeAcpRunnerBuild(root);

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
      writeFakeAcpRunnerBuild(root);

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
      writeFakeAcpRunnerBuild(root);
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

  it('starts even when an Agent has an unreadable pending Buffer report', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'newide-corrupt-buffer-startup-'));
    const agentStateRoot = path.join(root, 'agent-state');
    const repository = new InMemoryRepository();
    const bufferRepository = new FileBufferRepository({ agentStateRoot });
    const deliveryRepository = new FileMemoryDeliveryRepository({ agentStateRoot });
    await repository.initializeAgent({ role_id: 'role_ts_engineer', name: 'TypeScript Engineer' });
    await bufferRepository.ensureAgent('role_ts_engineer');
    await deliveryRepository.ensureAgent('role_ts_engineer');
    await bufferRepository.saveBufferSnapshot('role_ts_engineer', {
      task_id: 'task_corrupt_startup',
      task_description: 'A task whose report file got corrupted on disk.',
      driver_return: {
        summary: 'Completed.',
        artifacts: [],
        decisions: [],
        blockers: [],
        referenced_experiences: [],
        assumptions: [],
      },
      source_task_id: 'task_corrupt_startup',
      source_driver: 'acp-external',
      received_at: new Date().toISOString(),
      retry_count: 0,
      extraction_status: 'pending',
    });
    // 上一次进程留下了半截报告：这条读不出来，但它是唯一坏的，不该连坐启动
    writeFileSync(
      path.join(agentStateRoot, 'role_ts_engineer', 'buffer', 'pending', 'report_1.json'),
      '{ not json',
      'utf8',
    );
    const bRuntime: BackendBRuntime = {
      repository,
      bufferRepository,
      deliveryRepository,
      app_state_root: root,
      market_agent_ids: ['role_ts_engineer'],
      embedding_info: { provider: 'test fixture', readiness: 'host_managed' },
      close: async () => undefined,
    };

    try {
      writeFileSync(path.join(root, 'package.json'), '{"scripts":{"driver:run":"exit 0"}}');
      writeFakeAcpRunnerBuild(root);

      // readiness 照常通过：坏记录是运维要修的事实，不是后端起不来的理由
      const service = await createProductionBackendService(
        { ACP_DRIVER_RUNNER_DIR: root, NEWIDE_COORDINATION_DB: ':memory:' },
        { bRuntime, agentLlm: invokeDriverLlm() },
      );

      // 但故障本身留在维护证据里，能看出是哪条 Buffer、为什么
      await expect(service.listMemoryMaintenance('role_ts_engineer')).resolves.toEqual([
        expect.objectContaining({
          kind: 'context_delivery',
          status: 'failed',
          role_id: 'role_ts_engineer',
          buffer_seq: 1,
          error: expect.stringContaining('Unreadable buffer report'),
        }),
      ]);

      await service.close();
    } finally {
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
      writeFakeAcpRunnerBuild(root);
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
      writeFakeAcpRunnerBuild(root);

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
      writeFakeAcpRunnerBuild(runnerDir);
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
        `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const response = input.prompt.includes('Review the isolated proposal inputs') ? JSON.stringify({ reviews: [...new Set(input.prompt.match(/proposal_[a-z0-9-]+/g) || [])].map(id => ({ proposal_id: id, verdict: 'approve', reason: 'Reviewed staged evidence.', unmet_criteria: [], evidence_refs: [] })) }) : 'Fake ACP completed the request.';
  const councilRole = String(input.workspace_path || '').replaceAll('\\\\', '/').includes('.newide/council');
  const artifact = { artifact_id: 'artifact_fake_acp', type: councilRole ? 'diff' : 'driver_result', uri: 'artifact://fake/result', producer_id: 'claude-fake', task_id: input.task_id, ...(councilRole ? { content: { kind: 'text', content_ref: 'data:text/plain,COUNCIL_FINAL%0A', target_path: 'council-output.txt', media_type: 'text/plain' } } : {}), created_at, schema_version: input.schema_version };
  if (input.prompt.includes('Review the isolated proposal inputs') && !reviewerFailed && input.workspace_path) {
    writeFileSync(join(input.workspace_path, 'reviews.json'), response);
  }
  process.stdout.write(JSON.stringify({ driver_run_result_id: 'driver_result_fake_acp', session_id: 'session_fake_acp', status: reviewerFailed ? 'failed' : 'succeeded', response: reviewerFailed ? '' : response, artifacts: reviewerFailed ? [] : [artifact], transcript_ref: { ...artifact, artifact_id: 'transcript_fake_acp', type: 'transcript' }, tool_events: [], diagnostics: { driver_id: 'claude-fake', duration_ms: 1, notes: ['fake ACP process'] }, ...(reviewerFailed ? { error: { code: 'FAKE_REVIEW_FAILURE', message: 'controlled failure', retryable: false } } : {}), created_at, schema_version: input.schema_version }));
});
`,
      );
      writeFakeAcpRunnerBuild(runnerDir, { importFromRunnerRoot: 'fake-driver.mjs' });

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
      const externalSnapshot = service.getRunSnapshot(created.run_id);
      expect(externalSnapshot.delivery_report).toMatchObject({
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
          diagnostics: expect.objectContaining({
            context_pack_persisted: true,
            driver_id: 'claude-fake',
          }),
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
      // 议会阶段一度是面板的盲区：席位执行拿 `${run_id}_${phaseId}` 当**执行身份**
      // （相位之间要隔离信箱幂等键与 driver 记账），而在飞状态被写进了那个 key——面板按
      // run id 读，于是整段议会（一次 run 里最长的一段）看不见，尽管 199 条 driver 事件
      // 一条不少地流着。这里在下游按住不变量：**一个 run 的在飞状态只许挂在它自己的 run id 上**。
      const observedActivityKeys = new Set<string>();
      const activityPoll = setInterval(() => {
        for (const activity of listAgentActivities()) {
          observedActivityKeys.add(`${activity.run_id}|${activity.role_id}|${activity.kind}`);
        }
      }, 10);
      const councilSnapshot = await waitForTerminal(service, councilCreated.run_id);
      clearInterval(activityPoll);
      expect(observedActivityKeys.size).toBeGreaterThan(0);
      expect(
        [...observedActivityKeys].every((key) => key.startsWith(`${councilCreated.run_id}|`)),
      ).toBe(true);
      unsubscribe();
      expect(councilSnapshot.status).toBe('completed');
      const externalCouncilSnapshot = service.getRunSnapshot(councilCreated.run_id);
      expect(externalCouncilSnapshot.council).toMatchObject({
        phase: 'completed',
        subject: 'Exercise production council composition.',
        strategy: 'classic',
        artifact_mode: 'implementation',
      });
      expect(externalCouncilSnapshot.council?.auctions).toHaveLength(1);
      expect(externalCouncilSnapshot.council?.auctions?.[0]).toMatchObject({
        selection_scope: 'primary',
        selection_mode: 'auction',
        status: 'completed',
        winner_role_id: 'role_ts_engineer',
      });
      expect(externalCouncilSnapshot.council?.participants).toHaveLength(4);
      expect(
        externalCouncilSnapshot.council?.participants?.map(
          (participant) => participant.agent_id,
        ),
      ).toEqual([
        'role_fullstack_engineer',
        'role_ts_engineer',
        'role_ts_engineer',
        'role_fullstack_engineer',
      ]);
      const councilEventTypes = councilSnapshot.events.map((event) => event.type);
      expect(councilEventTypes).toContain('market.selected');
      expect(councilEventTypes).toContain('market.auction.started');
      expect(councilEventTypes).toContain('market.auction.completed');
      expect(councilEventTypes).toContain('council.participants.selected');
      expect(councilEventTypes.filter((type) => type === 'council.phase.started')).toHaveLength(3);
      expect(
        councilEventTypes.filter((type) => type === 'council.proposal.completed'),
      ).toHaveLength(2);
      expect(councilEventTypes.filter((type) => type === 'council.review.completed')).toHaveLength(
        1,
      );
      expect(
        councilEventTypes.filter((type) => type === 'council.synthesis.completed'),
      ).toHaveLength(1);
      expect(councilEventTypes.filter((type) => type === 'gate.result')).toHaveLength(0);
      expect(councilEventTypes.indexOf('council.completed')).toBeLessThan(
        councilEventTypes.indexOf('artifact.selected'),
      );
      expect(councilEventTypes.indexOf('artifact.selected')).toBeLessThan(
        councilEventTypes.indexOf('worktree.materialized'),
      );
      expect(externalCouncilSnapshot.delivery_report?.files_written.length).toBeGreaterThan(0);
      const councilResult = externalCouncilSnapshot.council?.result;
      const deliveredCouncilFile = readFileSync(path.join(workspaceDir, 'council-output.txt'));
      expect(councilResult).toMatchObject({
        quality: 'best_effort',
        final_artifact_ref: 'artifact_fake_acp',
        final_artifact_sha256: createHash('sha256').update(deliveredCouncilFile).digest('hex'),
        decision_record_ref: expect.stringMatching(/^council_decision_/),
      });
      const readableArtifact = await service.getArtifactContent(
        councilCreated.run_id,
        'artifact_fake_acp',
      );
      expect(readableArtifact).toMatchObject({
        artifact_id: 'artifact_fake_acp',
        target_path: 'council-output.txt',
        content: 'COUNCIL_FINAL\n',
        truncated: false,
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
        'worktree.materialized',
      ];
      const expectedOrder = [
        'council.completed',
        'artifact.selected',
        'worktree.materialized',
      ];
      const postCouncilSequence = (types: string[]) =>
        types.slice(types.indexOf('council.completed')).filter((type) => keyTypes.includes(type));
      expect(postCouncilSequence(notifications.map((event) => event.type))).toEqual(expectedOrder);
      expect(postCouncilSequence(audit.map((event) => event.type))).toEqual(expectedOrder);
      expect(postCouncilSequence(councilEventTypes)).toEqual(expectedOrder);
      expect(
        readFileSync(path.join(runnerDir, 'invocations.log'), 'utf8').trim().split('\n'),
      ).toHaveLength(7);
      expect(readFileSync(path.join(runnerDir, 'b-env.log'), 'utf8').trim().split('\n')).toEqual(
        Array.from({ length: 7 }, () => 'absent'),
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
      // 审者交付不出 reviews.json 就等于这次没有评审。议会不再降级出一个没被评审过的
      // 结果（旧行为会伪造 needs_revision 并照常完成），而是让这次 run 直接失败，
      // 并把原因写进终止错误里。
      const failedRunSnapshot = service.getRunSnapshot(failedCouncilCreated.run_id);
      expect(failedRunSnapshot.status).toBe('failed');
      expect(failedRunSnapshot.errors.map((error) => error.message).join('\n')).toContain(
        'produced no reviews.json at the workspace root',
      );
      expect(failedNotifications.map((event) => event.type)).toEqual(
        expect.arrayContaining(['council.role.failed', 'council.failed', 'run.failed']),
      );
      expect(failedSnapshot.events.map((event) => event.type)).not.toContain('council.completed');
      expect(failedSnapshot.events.map((event) => event.type)).not.toContain(
        'worktree.materialized',
      );
      const failedAudit = readFileSync(
        path.join('.newide', 'runs', failedCouncilCreated.run_id, 'audit.jsonl'),
        'utf8',
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AppRunEvent);
      expect(failedAudit.map((event) => event.type)).toEqual(
        expect.arrayContaining(['council.role.failed', 'council.failed', 'run.failed']),
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
    writeFakeAcpRunnerBuild(runnerDir);
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
    writeFakeAcpRunnerBuild(runnerDir);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/app/backend-rpc-entry.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ACP_DRIVER_RUNNER_DIR: runnerDir,
        // Unreachable host: embedded PGlite fallback is disabled by an explicit URL,
        // so the PostgreSQL readiness gate fails and stdio must stay closed.
        NEWIDE_B_DATABASE_URL: 'postgresql://nobody:wrong@127.0.0.1:1/newide',
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
    expect(stderr).toContain('PostgreSQL B memory storage readiness check failed');
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
    deliveryRepository: new InMemoryMemoryDeliveryRepository(),
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

/** ACP 探针模块桩：写进 runner 检出里，让真实 `AcpDriverProbeService` 有东西可跑。 */
function writeAcpProbeModule(runnerDir: string, agentIds: readonly string[]): void {
  const moduleDir = path.join(runnerDir, 'dist', 'src', 'driver-adapter');
  mkdirSync(moduleDir, { recursive: true });
  const rows = agentIds.map((agentId) =>
    [
      '{',
      `  agentId: ${JSON.stringify(agentId)},`,
      `  displayName: ${JSON.stringify(`${agentId} CLI`)},`,
      // 启动命令与参数刻意塞进假凭据与绝对路径：它们绝不能出现在 RPC 响应里
      "  launch: { command: 'npx', args: ['-y', 'some-agent', '--token=sk-should-not-leak'] },",
      "  provenance: 'npx-on-demand',",
      "  connectionType: 'acp',",
      "  initialize: { protocolVersion: 1, authMethods: 0 },",
      "  probedAt: '2026-10-14T00:00:00.000Z',",
      '}',
    ].join('\n'),
  );
  writeFileSync(
    path.join(moduleDir, 'probe.js'),
    `export async function probeAgents() { return [\n${rows.join(',\n')}\n]; }\n` +
      `export async function probeAgent(id) { return (await probeAgents()).find((row) => row.agentId === id) ?? null; }\n`,
  );
}

/**
 * 自动发现在**真实装配**里的样子。
 *
 * 这一层最需要端到端验证，因为它的错误形态是「装好了但列表里没有」或「列表里有但一执行就炸」，
 * 单看模块测试看不出来。这里用假的 ACP 探针模块跑真实 `AcpDriverProbeService`（真实 spawn），
 * 于是「探测成功 → 自动 profile 落盘 → registry 注册 → 出现在 driver.getConfig 与
 * system.capabilities」整条链路都被覆盖。
 *
 * 每个用例把 cwd 换成一个临时项目根：生产的 projectRoot 就是 cwd，不换的话自动 profile 会写进
 * 本仓检出（`.agent/`），污染后续测试。
 */
describe('driver auto-discovery in the production assembly', () => {
  const originalCwd = process.cwd();
  const roots: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  function makeProjectRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'newide-discovery-root-'));
    roots.push(root);
    writeFileSync(path.join(root, 'package.json'), '{"name":"newide-bcd","version":"0.1.0"}');
    return root;
  }

  function makeRunnerDir(withProbe: boolean, agentIds: readonly string[] = ['gemini']): string {
    const runnerDir = mkdtempSync(path.join(os.tmpdir(), 'newide-discovery-runner-'));
    roots.push(runnerDir);
    writeFileSync(
      path.join(runnerDir, 'package.json'),
      JSON.stringify({ name: 'acp-external-runner', version: '9.9.9', scripts: { 'driver:run': 'exit 0' } }),
    );
    writeFakeAcpRunnerBuild(runnerDir);
    if (withProbe) writeAcpProbeModule(runnerDir, agentIds);
    return runnerDir;
  }

  async function startBackend(root: string, runnerDir: string): Promise<NewideBackendService> {
    process.chdir(root);
    return createProductionBackendService(
      {
        ACP_DRIVER_RUNNER_DIR: runnerDir,
        NEWIDE_STATE_ROOT: path.join(root, '.newide'),
        NEWIDE_COORDINATION_DB: ':memory:',
      },
      { bRuntime: createInMemoryBRuntime() },
    );
  }

  it('adds a probe-reachable agent to getConfig and system.capabilities', async () => {
    const root = makeProjectRoot();
    const runnerDir = makeRunnerDir(true);
    const service = await startBackend(root, runnerDir);

    try {
      const snapshot = await service.driverRouting!.getSnapshot();
      const discovered = snapshot.drivers.filter((driver) =>
        driver.driver_id.startsWith('discovered:'),
      );

      expect(discovered).toHaveLength(1);
      expect(discovered[0]).toMatchObject({
        agent: 'gemini',
        display_name: 'gemini CLI',
        selectable: true,
        status: 'degraded',
      });
      // 探测到的 driver 与手工那个（内置 acp-external）并列，默认 driver 不变
      expect(snapshot.default_driver).toBe('acp-external');

      // system.capabilities 与 driver.getConfig 同源：同一个 driver 在两边都出现
      const statuses = service.getSystemReadiness().components.map((item) => item.component_id);
      expect(statuses).toContain(`driver:${discovered[0]!.driver_id}`);
      const limitations = service
        .getSystemCapabilities()
        .capabilities.find((item) => item.capability_id === 'driver.execute')?.limitations;
      expect(limitations?.some((line) => line.includes('ACP 探测通过'))).toBe(true);

      // 探测细节不穿过 RPC 边界：启动命令、参数、凭据值、runner 绝对路径都不出现
      const serialized = JSON.stringify([snapshot, service.getSystemReadiness(), service.getSystemCapabilities()]);
      expect(serialized).not.toContain('npx');
      expect(serialized).not.toContain('sk-should-not-leak');
      expect(serialized).not.toContain(runnerDir);
    } finally {
      await service.close();
    }
  });

  it('lets the discovered driver be chosen as a role driver', async () => {
    const root = makeProjectRoot();
    const service = await startBackend(root, makeRunnerDir(true));

    try {
      const before = await service.driverRouting!.getSnapshot();
      const discoveredId = before.drivers.find((driver) =>
        driver.driver_id.startsWith('discovered:'),
      )!.driver_id;

      const after = await service.driverRouting!.updateRouting({
        expected_revision: before.revision,
        default_driver: before.default_driver,
        roles: { role_ts_engineer: discoveredId },
      });

      expect(after.roles.find((role) => role.role_id === 'role_ts_engineer')?.driver_id).toBe(
        discoveredId,
      );
    } finally {
      await service.close();
    }
  });

  it('starts and keeps serving when the ACP probe is unavailable', async () => {
    const root = makeProjectRoot();
    // runner 没有构建探针模块：探测整体不可用，但后端必须照常起来
    const service = await startBackend(root, makeRunnerDir(false));

    try {
      const snapshot = await service.driverRouting!.getSnapshot();

      expect(snapshot.drivers.map((driver) => driver.driver_id)).toEqual(['acp-external']);
      expect(snapshot.drivers[0]?.selectable).toBe(true);
      // 什么都没发现时不在项目里留下一个空文件
      expect(existsSync(path.join(root, '.agent', 'drivers.detected.local.yaml'))).toBe(false);
      // 探测失败的结论仍然落在 state 里，便于归因
      expect(
        JSON.parse(readFileSync(path.join(root, '.newide', 'driver-discovery.json'), 'utf8'))
          .probe_status,
      ).toBe('unavailable');
    } finally {
      await service.close();
    }
  });

  it('remembers a discovered driver across a restart without re-probing', async () => {
    const root = makeProjectRoot();
    const runnerDir = makeRunnerDir(true);
    const first = await startBackend(root, runnerDir);
    const discoveredId = (await first.driverRouting!.getSnapshot()).drivers.find((driver) =>
      driver.driver_id.startsWith('discovered:'),
    )!.driver_id;
    await first.close();

    // 重启：同一个项目根，但 runner 侧已经拿不到探针了
    const second = await startBackend(root, makeRunnerDir(false));

    try {
      const snapshot = await second.driverRouting!.getSnapshot();
      // 上一轮的发现结果从 profile 文件里读回来，因而仍在列表里（本轮未再发现 → 不可选择）
      expect(snapshot.drivers.map((driver) => driver.driver_id)).toContain(discoveredId);
      expect(
        snapshot.drivers.find((driver) => driver.driver_id === discoveredId),
      ).toMatchObject({ selectable: false, reason_code: 'DRIVER_DISCOVERY_STALE' });
    } finally {
      await second.close();
    }
  });
});
