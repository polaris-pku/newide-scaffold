import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DriverRuntimeAgentExecutionFacade } from '../../src/app/driver-runtime-agent-execution-facade';
import { FileAgentExecutionEvidenceStore } from '../../src/app/agent-execution-evidence-store';
import type { BMemoryMaintenancePort } from '../../src/app/b-memory-maintenance-runner';
import { SCHEMA_VERSION, nowTimestamp, type ArtifactRef } from '../../src/core';
import {
  MockDriver,
  type DriverCapabilities,
  type DriverPrompt,
  type DriverRunResult,
  type DriverRuntimeHandle,
  type DriverStreamEventListener,
} from '../../src/driver';
import {
  InMemoryBufferRepository,
  InMemoryRepository,
  type ToolCallingClient,
} from '../../src/memory';
import type { ExperienceRecord, SkillRecord } from '../../src/memory/schemas';

describe('DriverRuntimeAgentExecutionFacade', () => {
  it('projects app-owned B maintenance evidence into execution diagnostics', async () => {
    const requests: Parameters<BMemoryMaintenancePort['scheduleBuffer']>[0][] = [];
    const memoryMaintenance: BMemoryMaintenancePort = {
      async scheduleBuffer(input) {
        requests.push(input);
        return {
          maintenance_ref: 'b_maintenance_test',
          kind: 'experience_extraction',
          status: 'scheduled',
          ...input,
          experiences: [],
          skills: [],
          warnings: [],
          created_at: '2026-07-21T00:00:00.000Z',
          completed_at: '2026-07-21T00:00:01.000Z',
          schema_version: SCHEMA_VERSION,
        };
      },
    };
    const { facade } = createFacade(
      new CapturingDriver('succeeded'),
      new InMemoryBufferRepository(),
      invokeDriverLlm(),
      new InMemoryRepository(),
      memoryMaintenance,
    );

    const result = await facade.runAgent(request('task_maintenance', 'proposer_a'));

    expect(requests).toEqual([
      {
        task_id: 'task_maintenance',
        run_id: 'run_task_maintenance',
        role_id: 'proposer_a',
        buffer_seq: 1,
      },
    ]);
    expect(result.diagnostics.memory_maintenance).toMatchObject({
      maintenance_ref: 'b_maintenance_test',
      status: 'scheduled',
    });
  });

  it('preserves a completed Agent execution when B maintenance scheduling fails', async () => {
    const memoryMaintenance: BMemoryMaintenancePort = {
      async scheduleBuffer() {
        throw new Error('maintenance evidence store unavailable');
      },
    };
    const { facade } = createFacade(
      new CapturingDriver('succeeded'),
      new InMemoryBufferRepository(),
      invokeDriverLlm(),
      new InMemoryRepository(),
      memoryMaintenance,
    );

    const result = await facade.runAgent(request('task_maintenance_failure', 'proposer_a'));

    expect(result.status).toBe('completed');
    expect(result.diagnostics.memory_maintenance).toMatchObject({
      maintenance_ref: expect.stringMatching(/^b_maintenance_/),
      kind: 'experience_extraction',
      status: 'failed',
      task_id: 'task_maintenance_failure',
      run_id: 'run_task_maintenance_failure',
      role_id: 'proposer_a',
      buffer_seq: 1,
      error: 'maintenance evidence store unavailable',
    });
  });

  it('runs the real driver through the public B runtime and preserves the execution result', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade, buffer } = createFacade(driver);

    const result = await facade.runAgent(request('task_001', 'proposer_a', process.cwd()));

    expect(driver.prompts).toHaveLength(1);
    expect(driver.prompts[0]).toMatchObject({
      task_id: 'task_001',
      run_id: 'run_task_001',
      workspace_path: process.cwd(),
      session_id: 'session_existing',
      schema_version: SCHEMA_VERSION,
    });
    expect(result).toMatchObject({
      agent_run_id: expect.stringMatching(/^agent_run_/),
      agent_id: 'proposer_a',
      role_id: 'proposer_a',
      context_pack_ref: expect.stringMatching(/^context_pack_[a-f0-9]{24}$/),
      driver_run_result_id: 'driver_result_001',
      artifact_refs: [createArtifact('artifact_output_001')],
      transcript_ref: createArtifact('artifact_transcript_001', 'transcript'),
      session_id: 'session_existing',
      response: 'Agent completed the requested change.',
      tool_events: [expect.objectContaining({ tool_event_id: 'tool_event_001' })],
      diagnostics: {
        driver_id: 'driver_001',
        driver_status: 'succeeded',
        context_policy: 'default',
        input_artifact_refs: [],
        buffer_seq: 1,
      },
      status: 'completed',
      memory_buffer_ref: 'proposer_a:1',
      schema_version: SCHEMA_VERSION,
    });
    expect(await buffer.getBufferMeta('proposer_a')).toMatchObject({
      pending_count: 1,
      total_processed: 0,
    });
  });

  it('preserves B-owned query_memory alongside the app-owned driver tool', async () => {
    const exposedTools: string[][] = [];
    const delegate = invokeDriverLlm();
    const llm: ToolCallingClient = {
      async completeWithTools(input) {
        exposedTools.push(input.tools.map((tool) => tool.function.name));
        return delegate.completeWithTools(input);
      },
    };
    const { facade } = createFacade(
      new CapturingDriver('succeeded'),
      new InMemoryBufferRepository(),
      llm,
    );

    await facade.runAgent(request('task_tool_surface', 'tool_surface_role'));

    expect(exposedTools[0]).toEqual(['query_memory', 'invoke_driver']);
  });

  it('registers and projects a market candidate without executing A', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(driver);

    await facade.ensureAgent('role_market_candidate');
    const batch = await facade.collectCompetitionClaims({
      task_id: 'task_market_claim',
      spec: 'Implement a backend service.',
    });

    expect(batch.claims).toEqual([
      expect.objectContaining({
        role_id: 'role_market_candidate',
        decision: 'participate',
      }),
    ]);
    expect(driver.prompts).toHaveLength(0);
  });

  it('tags streamed A events with the executing Council role', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(driver);
    const events: Array<{ role_id?: string; event_type: string }> = [];

    await facade.runAgent(request('task_stream_role', 'reviewer'), {
      onDriverEvent: (event) => events.push(event),
    });

    expect(events).toEqual([
      expect.objectContaining({ event_type: 'agent_message_chunk', role_id: 'reviewer' }),
    ]);
  });

  it('wakes a sleeping mailbox recipient without dispatching a Driver task', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(driver);

    await facade.wakeAgent({
      contract_version: 'agent-mailbox-wake.v1',
      message_id: 'message_wake',
      delivery_id: 'delivery_wake',
      thread_id: 'thread_wake',
      recipient_role_id: 'role_mailbox_recipient',
      schema_version: SCHEMA_VERSION,
    });

    const batch = await facade.collectCompetitionClaims({
      task_id: 'task_after_wake',
      spec: 'Confirm the recipient is loaded into the B runtime.',
    });
    expect(batch.claims).toEqual([expect.objectContaining({ role_id: 'role_mailbox_recipient' })]);
    expect(driver.prompts).toHaveLength(0);
  });

  it('resolves a relative workspace before crossing the B to A process boundary', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(driver);
    const relativeWorkspace = '.newide/council/run_relative/proposer_a';

    await facade.runAgent(request('task_relative_workspace', 'proposer_a', relativeWorkspace));

    expect(driver.prompts[0]?.workspace_path).toBe(path.resolve(relativeWorkspace));
  });

  it('persists a content-addressed context pack with real retrieval and buffer evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-b-evidence-'));
    try {
      const driver = new CapturingDriver('succeeded');
      const facade = new DriverRuntimeAgentExecutionFacade({
        driver,
        repository: new InMemoryRepository(),
        bufferRepository: new InMemoryBufferRepository(),
        llm: invokeDriverLlm(),
        evidenceStore: new FileAgentExecutionEvidenceStore({ root }),
      });

      const result = await facade.runAgent(request('task_evidence', 'implementer'));

      expect(result).toMatchObject({
        agent_id: 'implementer',
        context_pack_ref: expect.stringMatching(/^context_pack_[a-f0-9]{24}$/),
        memory_buffer_ref: 'implementer:1',
        diagnostics: {
          context_pack_persisted: true,
          context_pack_uri: expect.stringMatching(/^file:/),
          retrieval: { experiences: 0, skills: 0 },
        },
      });
      const files = await fs.readdir(root);
      expect(files).toEqual([`${result.context_pack_ref}.json`]);
      const persisted = JSON.parse(await fs.readFile(path.join(root, files[0]!), 'utf-8'));
      expect(persisted).toMatchObject({
        context_pack_id: result.context_pack_ref,
        task_id: 'task_evidence',
        agent_id: 'implementer',
        memory_buffer_ref: 'implementer:1',
        retrieval: { experiences: [], skills: [] },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('retrieves eligible memory before planning and injects it into A and ContextPack evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-b-retrieval-'));
    try {
      const roleId = 'implementer';
      const repository = new InMemoryRepository();
      await repository.initializeAgent({ role_id: roleId, name: roleId });
      const approvedSkill = createMemorySkill(roleId, {
        description: 'Runtime contract implementation skill',
        content: 'Keep runtime role identity stable across workspace paths.',
        tags: ['runtime'],
      });
      const pendingSkill = createMemorySkill(roleId, {
        description: 'Pending runtime skill',
        content: 'This pending skill must not reach A.',
        review_status: 'pending',
        tags: ['runtime'],
      });
      const eligibleExperience = createMemoryExperience(roleId, {
        description: 'Runtime retrieval experience',
        content: 'Retrieve approved memory before invoking the driver.',
        tags: ['runtime'],
      });
      const negativeExperience = createMemoryExperience(roleId, {
        description: 'Negative runtime experience',
        content: 'This negative experience must not reach A.',
        confidence: 0.9,
        type: 'negative',
        tags: ['runtime'],
      });
      const lowConfidenceExperience = createMemoryExperience(roleId, {
        description: 'Low confidence runtime experience',
        content: 'This low-confidence experience must not reach A.',
        confidence: 0.1,
        tags: ['runtime'],
      });
      await repository.saveSkill(roleId, approvedSkill);
      await repository.saveSkill(roleId, pendingSkill);
      await repository.saveExperience(roleId, eligibleExperience);
      await repository.saveExperience(roleId, negativeExperience);
      await repository.saveExperience(roleId, lowConfidenceExperience);

      const storedApprovedSkill = (await repository.listSkills(roleId)).find(
        (skill) => skill.id === approvedSkill.id,
      )!;
      const storedEligibleExperience = (await repository.listExperiences(roleId)).find(
        (experience) => experience.id === eligibleExperience.id,
      )!;
      const initialMessages: string[] = [];
      const llmSkillContext = 'Preserve this LLM-provided skill context.';
      const llmExperienceContext = 'Preserve this LLM-provided experience context.';
      const driver = new CapturingDriver('succeeded');
      const facade = new DriverRuntimeAgentExecutionFacade({
        driver,
        repository,
        bufferRepository: new InMemoryBufferRepository(),
        llm: invokeDriverWithContextLlm(
          {
            skills: [approvedSkill.content, llmSkillContext, llmSkillContext],
            experiences: [eligibleExperience.content, llmExperienceContext, llmExperienceContext],
          },
          initialMessages,
        ),
        evidenceStore: new FileAgentExecutionEvidenceStore({ root }),
      });

      const result = await facade.runAgent(request('task_retrieval', roleId));

      expect(initialMessages[0]).toContain(approvedSkill.description);
      expect(initialMessages[0]).toContain(approvedSkill.content);
      expect(initialMessages[0]).toContain(eligibleExperience.description);
      expect(initialMessages[0]).toContain(eligibleExperience.content);
      expect(initialMessages[0]).not.toContain(pendingSkill.content);
      expect(initialMessages[0]).not.toContain(negativeExperience.content);
      expect(initialMessages[0]).not.toContain(lowConfidenceExperience.content);

      const prompt = JSON.parse(driver.prompts[0]!.prompt) as {
        task_instruction: string;
        skills: Array<{ id: string; description: string; content: string }>;
        experiences: Array<{ id: string; description: string; content: string }>;
      };
      expect(prompt.skills.map((item) => item.content)).toEqual([
        approvedSkill.content,
        llmSkillContext,
      ]);
      expect(prompt.experiences.map((item) => item.content)).toEqual([
        eligibleExperience.content,
        llmExperienceContext,
      ]);
      expect(prompt.skills[0]).toEqual({
        id: approvedSkill.id,
        description: approvedSkill.description,
        content: approvedSkill.content,
      });
      expect(prompt.experiences[0]).toEqual({
        id: eligibleExperience.id,
        description: eligibleExperience.description,
        content: eligibleExperience.content,
      });

      expect(result.diagnostics).toMatchObject({ retrieval: { experiences: 1, skills: 1 } });
      const persisted = JSON.parse(
        await fs.readFile(path.join(root, `${result.context_pack_ref}.json`), 'utf-8'),
      );
      expect(persisted).toMatchObject({
        agent_id: roleId,
        memory_buffer_ref: `${roleId}:1`,
      });
      expect(persisted.retrieval).toEqual({
        skills: [storedApprovedSkill],
        experiences: [storedEligibleExperience],
      });
      expect(persisted.driver_context).toEqual({
        task_instruction: 'Execute through B runtime.',
        skills: [storedApprovedSkill],
        experiences: [storedEligibleExperience],
      });
      expect(persisted.driver_invocation_context).toEqual(prompt);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('releases role and workspace queues when cancellation wins against retrieval', async () => {
    const roleId = 'retrieval_cancel_role';
    const repository = new BlockingOnceRetrievalRepository();
    await repository.initializeAgent({ role_id: roleId, name: roleId });
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(
      driver,
      new InMemoryBufferRepository(),
      invokeDriverLlm(),
      repository,
    );
    const controller = new AbortController();

    const cancelled = facade.runAgent(
      request('task_cancel_retrieval', roleId, '/tmp/newide-cancel-retrieval'),
      { signal: controller.signal },
    );
    await repository.firstSearchStarted;
    let cancellationState: 'pending' | 'resolved' | 'rejected' = 'pending';
    let cancellationError: unknown;
    const cancellationObserved = cancelled.then(
      () => {
        cancellationState = 'resolved';
      },
      (error: unknown) => {
        cancellationState = 'rejected';
        cancellationError = error;
      },
    );
    controller.abort(new Error('Cancel blocked retrieval'));
    const followUp = facade.runAgent(
      request('task_after_retrieval_cancel', roleId, '/tmp/newide-cancel-retrieval'),
    );
    try {
      await vi.waitFor(() => expect(cancellationState).toBe('rejected'), { timeout: 1_000 });
      expect(cancellationError).toMatchObject({ message: 'Cancel blocked retrieval' });
      await vi.waitFor(() => expect(driver.prompts).toHaveLength(1), { timeout: 1_000 });
      await expect(followUp).resolves.toMatchObject({
        status: 'completed',
        memory_buffer_ref: `${roleId}:1`,
      });
    } finally {
      repository.continueFirstSearch();
      await Promise.allSettled([cancellationObserved, followUp]);
    }
  });

  it('preserves the original C instruction when B delegates a narrower subtask', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(
      driver,
      new InMemoryBufferRepository(),
      delegatedInstructionLlm('Only inspect the target.'),
    );

    await facade.runAgent(request('task_original_instruction', 'proposer_a'));

    const prompt = JSON.parse(driver.prompts[0]!.prompt) as {
      task_instruction: string;
      experiences: Array<{ id: string; content: string }>;
    };
    expect(prompt.task_instruction).toBe('Execute through B runtime.');
    expect(prompt.experiences).toContainEqual({
      id: 'b_delegation',
      description: 'B runtime delegation guidance',
      content: 'Only inspect the target.',
    });
  });

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['interrupted', 'interrupted'],
  ] as const)('maps %s driver results to %s agent results', async (driverStatus, agentStatus) => {
    const { facade } = createFacade(new CapturingDriver(driverStatus));

    const result = await facade.runAgent(request('task_status', 'reviewer'));

    expect(result.status).toBe(agentStatus);
    expect(result.diagnostics).toMatchObject({ driver_status: driverStatus });
    if (driverStatus === 'failed') {
      expect(result.diagnostics).toMatchObject({ driver_error_code: 'MOCK_FAILED' });
    }
  });

  it('retries one artifact-free retryable transport failure', async () => {
    const driver = new RetryableOnceDriver();
    const { facade } = createFacade(driver);

    const result = await facade.runAgent(request('task_retry', 'proposer_a'));

    expect(driver.prompts).toHaveLength(2);
    expect(result).toMatchObject({
      status: 'completed',
      diagnostics: { driver_attempts: 2 },
    });
  });

  it('does not retry an artifact-free retryable business failure', async () => {
    const driver = new RetryableOnceDriver('RETRYABLE_VALIDATION');
    const { facade } = createFacade(driver);

    const result = await facade.runAgent(request('task_no_business_retry', 'proposer_a'));

    expect(driver.prompts).toHaveLength(1);
    expect(result).toMatchObject({ status: 'failed', diagnostics: { driver_attempts: 1 } });
  });

  it('keeps role memory isolated while reusing each role runtime', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(driver);

    const proposerFirst = await facade.runAgent(request('task_p1', 'proposer'));
    const reviewer = await facade.runAgent(request('task_r1', 'reviewer'));
    const proposerSecond = await facade.runAgent(request('task_p2', 'proposer'));

    expect(proposerFirst.memory_buffer_ref).toBe('proposer:1');
    expect(reviewer.memory_buffer_ref).toBe('reviewer:1');
    expect(proposerSecond.memory_buffer_ref).toBe('proposer:2');
  });

  it('serializes executions for the same role outside the B runtime', async () => {
    const driver = new ConcurrentDriver();
    const { facade } = createFacade(driver);

    await Promise.all([
      facade.runAgent(request('task_serial_1', 'proposer')),
      facade.runAgent(request('task_serial_2', 'proposer')),
    ]);

    expect(driver.maxActive).toBe(1);
  });

  it('cleans settled role and workspace queues without deleting a newer queued entry', async () => {
    const driver = new ControlledDriver();
    const { facade } = createFacade(driver);
    const workspace = '/tmp/newide-queue-cleanup';
    const queues = Reflect.get(facade, 'executionQueues') as Map<string, Promise<void>>;

    const first = facade.runAgent(request('task_queue_cleanup_1', 'proposer', workspace));
    const second = facade.runAgent(request('task_queue_cleanup_2', 'proposer', workspace));
    try {
      await vi.waitFor(() => expect(driver.prompts).toHaveLength(1));
      expect(queues.size).toBe(2);
      driver.releaseNext();
      await vi.waitFor(() => expect(driver.prompts).toHaveLength(2));
      expect(queues.size).toBe(2);
      driver.releaseNext();
      await Promise.all([first, second]);
      await vi.waitFor(() => expect(queues.size).toBe(0));
    } finally {
      driver.finishAll();
      await Promise.allSettled([first, second]);
    }
  });

  it('keeps concurrent role invocations associated with their own task and run', async () => {
    const driver = new ConcurrentDriver();
    const { facade } = createFacade(driver);

    await Promise.all([
      facade.runAgent(request('task_parallel_a', 'proposer_a')),
      facade.runAgent(request('task_parallel_b', 'proposer_b')),
    ]);

    expect(driver.maxActive).toBe(2);
    expect(
      driver.prompts
        .map((prompt) => ({ task_id: prompt.task_id, run_id: prompt.run_id }))
        .sort((left, right) => left.task_id.localeCompare(right.task_id)),
    ).toEqual([
      { task_id: 'task_parallel_a', run_id: 'run_task_parallel_a' },
      { task_id: 'task_parallel_b', run_id: 'run_task_parallel_b' },
    ]);
  });

  it('serializes different roles that target the same workspace', async () => {
    const driver = new ConcurrentDriver();
    const { facade } = createFacade(driver);
    const workspace = '/tmp/newide-shared-workspace';

    await Promise.all([
      facade.runAgent(request('task_shared_a', 'proposer', workspace)),
      facade.runAgent(request('task_shared_b', 'reviewer', workspace)),
    ]);

    expect(driver.maxActive).toBe(1);
  });

  it('reuses one logical role and buffer sequence across different workspaces', async () => {
    const driver = new ConcurrentDriver();
    const repository = new InMemoryRepository();
    const { facade } = createFacade(
      driver,
      new InMemoryBufferRepository(),
      invokeDriverLlm(),
      repository,
    );

    const [first, second] = await Promise.all([
      facade.runAgent(request('task_workspace_a', 'proposer', '/tmp/newide-workspace-a')),
      facade.runAgent(request('task_workspace_b', 'proposer', '/tmp/newide-workspace-b')),
    ]);

    expect(driver.maxActive).toBe(1);
    expect(first).toMatchObject({ agent_id: 'proposer', memory_buffer_ref: 'proposer:1' });
    expect(second).toMatchObject({ agent_id: 'proposer', memory_buffer_ref: 'proposer:2' });
    expect(await repository.listAgentIds()).toEqual(['proposer']);
    expect(driver.prompts.map((prompt) => prompt.workspace_path).sort()).toEqual([
      '/tmp/newide-workspace-a',
      '/tmp/newide-workspace-b',
    ]);
  });

  it('returns a failed result when B completes without invoking the driver', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(driver, new InMemoryBufferRepository(), noDriverLlm());

    const result = await facade.runAgent(request('task_no_driver', 'reviewer'));

    expect(driver.prompts).toHaveLength(0);
    expect(result).toMatchObject({
      role_id: 'reviewer',
      status: 'failed',
      artifact_refs: [],
      diagnostics: {
        dispatch_status: 'no_driver_invocation',
        driver_error_code: 'B_NO_DRIVER_INVOCATION',
      },
    });
  });

  it('rejects a pre-aborted execution without calling the driver or writing a buffer', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('already cancelled', 'AbortError'));
    const driver = new CapturingDriver('succeeded');
    const { facade, buffer } = createFacade(driver);

    await expect(
      facade.runAgent(request('pre_abort', 'proposer_a'), { signal: controller.signal }),
    ).rejects.toThrow('already cancelled');
    expect(driver.prompts).toHaveLength(0);
    await expect(buffer.getBufferMeta('proposer_a')).rejects.toThrow('Buffer store not found');
  });

  it('interrupts the real driver when the execution signal is aborted', async () => {
    const controller = new AbortController();
    const driver = new MockDriver();
    driver.sendPrompt = vi.fn(() => new Promise<DriverRunResult>(() => undefined));
    const interrupt = vi.spyOn(driver, 'interrupt');
    const { facade, buffer } = createFacade(driver);

    const running = facade.runAgent(request('task_cancel', 'proposer_a'), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(driver.sendPrompt).toHaveBeenCalledTimes(1));
    controller.abort(new Error('Cancel B runtime execution'));

    await expect(running).rejects.toThrow('Cancel B runtime execution');
    expect(interrupt).toHaveBeenCalledWith('Cancel B runtime execution', 'run_task_cancel');
    expect((await buffer.getBufferMeta('proposer_a')).total_processed).toBe(0);
  });

  it('recovers a cancelled role by rebuilding the app-owned manager instance', async () => {
    const roleId = 'canonical_recovery_role';
    const repository = new CountingManagerLoadRepository();
    const driver = new AbortOnceDriver();
    const { facade } = createFacade(
      driver,
      new InMemoryBufferRepository(),
      invokeDriverLlm(),
      repository,
    );
    const controller = new AbortController();

    const cancelled = facade.runAgent(request('task_cancel_canonical', roleId), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(driver.prompts).toHaveLength(1));
    controller.abort(new Error('Cancel canonical role'));
    await expect(cancelled).rejects.toThrow('Cancel canonical role');

    const claims = await facade.collectCompetitionClaims({
      task_id: 'task_claim_after_cancel',
      spec: 'Confirm the recovered role can participate.',
    });
    expect(claims.claims).toEqual([
      expect.objectContaining({ role_id: roleId, decision: 'participate' }),
    ]);
    await expect(facade.runAgent(request('task_run_after_cancel', roleId))).resolves.toMatchObject({
      status: 'completed',
      agent_id: roleId,
      memory_buffer_ref: `${roleId}:1`,
    });
    expect(repository.managerLoadCount).toBe(2);
  });

  it('continues a queued role execution after the active execution is aborted', async () => {
    const controller = new AbortController();
    const driver = new AbortOnceDriver();
    const { facade } = createFacade(
      driver,
      new InMemoryBufferRepository(),
      invokeDriverLlm(),
      new FailOnceOnReloadRepository(),
    );

    const cancelled = facade.runAgent(request('task_cancel_once', 'proposer_a'), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(driver.prompts).toHaveLength(1));
    const queued = facade.runAgent(request('task_after_cancel', 'proposer_a'));
    controller.abort(new Error('Cancel first role execution'));

    await expect(cancelled).rejects.toThrow('Cancel first role execution');
    await expect(queued).resolves.toMatchObject({
      status: 'completed',
    });
    expect(driver.prompts).toHaveLength(2);
  });

  it('stops while B waits for the post-driver LLM response', async () => {
    const controller = new AbortController();
    const llm = new BlockingPostDriverLlm();
    const { facade } = createFacade(
      new CapturingDriver('succeeded'),
      new InMemoryBufferRepository(),
      llm,
    );

    const running = facade.runAgent(request('cancel_post_driver_llm', 'proposer_a'), {
      signal: controller.signal,
    });
    await llm.postDriverCallStarted;
    controller.abort(new Error('Cancel post-driver LLM'));

    await expect(running).rejects.toThrow('Cancel post-driver LLM');
  });

  it('invokes the driver only once when B requests duplicate calls', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(driver, new InMemoryBufferRepository(), twoDriverCallsLlm());

    const result = await facade.runAgent(request('duplicate_driver', 'proposer_a'));

    expect(result.status).toBe('completed');
    expect(driver.prompts).toHaveLength(1);
  });

  it('rejects an aborted queued execution without waiting for the active role execution', async () => {
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const driver = new MockDriver();
    driver.sendPrompt = vi.fn(() => new Promise<DriverRunResult>(() => undefined));
    const { facade } = createFacade(driver);

    const active = facade.runAgent(request('active_role_task', 'proposer_a'), {
      signal: activeController.signal,
    });
    await vi.waitFor(() => expect(driver.sendPrompt).toHaveBeenCalledTimes(1));
    const queued = facade.runAgent(request('queued_role_task', 'proposer_a'), {
      signal: queuedController.signal,
    });
    queuedController.abort(new Error('Cancel queued task'));

    await expect(queued).rejects.toThrow('Cancel queued task');
    activeController.abort(new Error('Clean up active task'));
    await expect(active).rejects.toThrow('Clean up active task');
  });

  it('does not retroactively cancel after the driver has completed', async () => {
    const controller = new AbortController();
    const buffer = new DelayedBufferRepository();
    const { facade } = createFacade(new CapturingDriver('succeeded'), buffer);

    const running = facade.runAgent(request('late_abort', 'proposer_a'), {
      signal: controller.signal,
    });
    await buffer.saveStarted;
    controller.abort(new Error('Too late to cancel the completed driver'));
    buffer.continueSave();

    await expect(running).resolves.toMatchObject({ status: 'completed' });
    expect(await buffer.getBufferMeta('proposer_a')).toMatchObject({
      pending_count: 1,
      total_processed: 0,
    });
  });
});

function createFacade(
  driver: DriverRuntimeHandle,
  buffer: InMemoryBufferRepository = new InMemoryBufferRepository(),
  llm: ToolCallingClient = invokeDriverLlm(),
  repository: InMemoryRepository = new InMemoryRepository(),
  memoryMaintenance?: BMemoryMaintenancePort,
) {
  return {
    facade: new DriverRuntimeAgentExecutionFacade({
      driver,
      repository,
      bufferRepository: buffer,
      llm,
      ...(memoryMaintenance ? { memoryMaintenance } : {}),
    }),
    buffer,
  };
}

class FailOnceOnReloadRepository extends InMemoryRepository {
  private reloadCalls = 0;

  override async ensureAgent(role_id: string): Promise<void> {
    this.reloadCalls += 1;
    if (this.reloadCalls === 1) throw new Error('Transient repository reload failure');
    return super.ensureAgent(role_id);
  }
}

class CountingManagerLoadRepository extends InMemoryRepository {
  managerLoadCount = 0;

  override async listAgentIds(): Promise<string[]> {
    this.managerLoadCount += 1;
    return super.listAgentIds();
  }
}

class BlockingOnceRetrievalRepository extends InMemoryRepository {
  private searchCalls = 0;
  private firstSearchStartedResolve!: () => void;
  private continueFirstSearchResolve!: () => void;
  readonly firstSearchStarted = new Promise<void>((resolve) => {
    this.firstSearchStartedResolve = resolve;
  });
  private readonly firstSearchContinues = new Promise<void>((resolve) => {
    this.continueFirstSearchResolve = resolve;
  });

  continueFirstSearch(): void {
    this.continueFirstSearchResolve();
  }

  override async searchSkills(
    ...args: Parameters<InMemoryRepository['searchSkills']>
  ): ReturnType<InMemoryRepository['searchSkills']> {
    this.searchCalls += 1;
    if (this.searchCalls === 1) {
      this.firstSearchStartedResolve();
      await this.firstSearchContinues;
    }
    return super.searchSkills(...args);
  }
}

function invokeDriverLlm(): ToolCallingClient {
  let toolCallSequence = 0;
  return {
    async completeWithTools(input) {
      const lastMessage = input.messages.at(-1);
      if (lastMessage?.role === 'tool') {
        return { content: 'Task completed. [done]', tool_calls: undefined };
      }
      const userMessage = [...input.messages].reverse().find((message) => message.role === 'user');
      toolCallSequence += 1;
      return {
        content: null,
        tool_calls: [
          {
            id: `tool_call_${String(toolCallSequence)}`,
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

function invokeDriverWithContextLlm(
  context: { skills: string[]; experiences: string[] },
  initialMessages: string[],
): ToolCallingClient {
  let calls = 0;
  return {
    async completeWithTools(input) {
      calls += 1;
      if (calls > 1) return { content: 'Task completed. [done]', tool_calls: undefined };
      initialMessages.push(
        input.messages.find((message) => message.role === 'user')?.content ?? '',
      );
      return {
        content: null,
        tool_calls: [
          {
            id: 'tool_call_with_context',
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({
                instruction: 'Execute through B runtime.',
                context,
              }),
            },
          },
        ],
      };
    },
  };
}

function noDriverLlm(): ToolCallingClient {
  return {
    async completeWithTools() {
      return { content: 'Task completed without delegation. [done]', tool_calls: undefined };
    },
  };
}

function delegatedInstructionLlm(instruction: string): ToolCallingClient {
  let calls = 0;
  return {
    async completeWithTools() {
      calls += 1;
      if (calls > 1) return { content: 'Task completed. [done]', tool_calls: undefined };
      return {
        content: null,
        tool_calls: [
          {
            id: 'delegated_instruction',
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({ instruction }),
            },
          },
        ],
      };
    },
  };
}

class BlockingPostDriverLlm implements ToolCallingClient {
  private calls = 0;
  private postDriverCallStartedResolve!: () => void;
  readonly postDriverCallStarted = new Promise<void>((resolve) => {
    this.postDriverCallStartedResolve = resolve;
  });

  async completeWithTools() {
    this.calls += 1;
    if (this.calls === 1) {
      return driverToolCalls('post_driver_call');
    }
    this.postDriverCallStartedResolve();
    return new Promise<never>(() => undefined);
  }
}

function twoDriverCallsLlm(): ToolCallingClient {
  let calls = 0;
  return {
    async completeWithTools() {
      calls += 1;
      if (calls > 1) return { content: 'Task completed. [done]', tool_calls: undefined };
      return driverToolCalls('first_driver_call', 'second_driver_call');
    },
  };
}

function driverToolCalls(...ids: string[]) {
  return {
    content: null,
    tool_calls: ids.map((id) => ({
      id,
      type: 'function' as const,
      function: {
        name: 'invoke_driver',
        arguments: JSON.stringify({ instruction: `Execute ${id}.` }),
      },
    })),
  };
}

class DelayedBufferRepository extends InMemoryBufferRepository {
  private saveStartedResolve!: () => void;
  private continueSaveResolve!: () => void;
  readonly saveStarted = new Promise<void>((resolve) => {
    this.saveStartedResolve = resolve;
  });
  private readonly saveContinues = new Promise<void>((resolve) => {
    this.continueSaveResolve = resolve;
  });

  continueSave(): void {
    this.continueSaveResolve();
  }

  override async saveBufferSnapshot(
    ...args: Parameters<InMemoryBufferRepository['saveBufferSnapshot']>
  ): ReturnType<InMemoryBufferRepository['saveBufferSnapshot']> {
    this.saveStartedResolve();
    await this.saveContinues;
    return super.saveBufferSnapshot(...args);
  }
}

function request(taskId: string, roleId: string, workspacePath?: string) {
  return {
    task_id: taskId,
    run_id: `run_${taskId}`,
    role_id: roleId,
    instruction: 'Execute through B runtime.',
    input_artifact_refs: [],
    context_policy: 'default',
    ...(workspacePath ? { workspace_path: workspacePath } : {}),
    session_id: 'session_existing',
    schema_version: SCHEMA_VERSION,
  };
}

class CapturingDriver implements DriverRuntimeHandle {
  readonly driver_id = 'driver_001';
  readonly session_id = 'session_001';
  readonly capabilities: DriverCapabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: false,
    supports_permission_events: false,
  };
  readonly prompts: DriverPrompt[] = [];
  private readonly eventListeners = new Set<DriverStreamEventListener>();

  constructor(private readonly status: DriverRunResult['status']) {}

  async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    for (const listener of this.eventListeners) {
      listener({
        schema_version: 'driver-event.v1',
        event_type: 'agent_message_chunk',
        task_id: input.task_id,
        run_id: input.run_id,
        payload: { text: 'working' },
      });
    }
    return driverResult(this, this.status, input.session_id);
  }

  subscribeToEvents(listener: DriverStreamEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async interrupt(_reason: string): Promise<void> {}

  async collectTranscript(): Promise<ArtifactRef> {
    return createArtifact('artifact_transcript_001', 'transcript');
  }
}

class AbortOnceDriver extends CapturingDriver {
  constructor() {
    super('succeeded');
  }

  override async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    if (this.prompts.length === 1) {
      return new Promise<DriverRunResult>(() => undefined);
    }
    return driverResult(this, 'succeeded', input.session_id);
  }
}

class ConcurrentDriver extends CapturingDriver {
  active = 0;
  maxActive = 0;

  constructor() {
    super('succeeded');
  }

  override async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.active -= 1;
    return driverResult(this, 'succeeded', input.session_id);
  }
}

class ControlledDriver extends CapturingDriver {
  private readonly releases: Array<() => void> = [];
  private releaseImmediately = false;

  constructor() {
    super('succeeded');
  }

  override async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    if (!this.releaseImmediately) {
      await new Promise<void>((resolve) => this.releases.push(resolve));
    }
    return driverResult(this, 'succeeded', input.session_id);
  }

  releaseNext(): void {
    this.releases.shift()?.();
  }

  finishAll(): void {
    this.releaseImmediately = true;
    for (const release of this.releases.splice(0)) release();
  }
}

class RetryableOnceDriver extends CapturingDriver {
  constructor(private readonly errorCode = 'EXTERNAL_DRIVER_TRANSPORT_ERROR') {
    super('succeeded');
  }

  override async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    if (this.prompts.length > 1) return driverResult(this, 'succeeded', input.session_id);
    return {
      ...driverResult(this, 'failed', input.session_id),
      error: {
        code: this.errorCode,
        message: 'Transient transport failure.',
        retryable: true,
      },
    };
  }
}

function driverResult(
  driver: DriverRuntimeHandle,
  status: DriverRunResult['status'],
  sessionId?: string,
): DriverRunResult {
  return {
    driver_run_result_id: 'driver_result_001',
    session_id: sessionId ?? driver.session_id,
    status,
    response: status === 'succeeded' ? 'Agent completed the requested change.' : '',
    artifacts: status === 'succeeded' ? [createArtifact('artifact_output_001')] : [],
    transcript_ref: createArtifact('artifact_transcript_001', 'transcript'),
    tool_events: [
      {
        tool_event_id: 'tool_event_001',
        tool_name: 'edit',
        status: 'completed',
        summary: 'Updated the requested file.',
        created_at: '2026-07-07T00:00:00.000Z',
        schema_version: SCHEMA_VERSION,
      },
    ],
    diagnostics: {
      driver_id: driver.driver_id,
      duration_ms: 25,
      notes: ['captured'],
    },
    ...(status === 'failed'
      ? {
          error: {
            code: 'MOCK_FAILED',
            message: 'Mock driver failed.',
            retryable: false,
          },
        }
      : {}),
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function createArtifact(artifactId: string, type: ArtifactRef['type'] = 'patch'): ArtifactRef {
  return {
    artifact_id: artifactId,
    type,
    uri: `artifact://${type}/${artifactId}`,
    producer_id: 'driver_001',
    task_id: 'task_001',
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function createMemorySkill(roleId: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Runtime skill',
    description_embedding: [],
    content: 'Use the runtime skill.',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['runtime'],
    promoted_at: now,
    agent_id: roleId,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function createMemoryExperience(
  roleId: string,
  overrides: Partial<ExperienceRecord> = {},
): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Runtime experience',
    description_embedding: [],
    content: 'Use the runtime experience.',
    confidence: 0.8,
    tags: ['runtime'],
    agent_id: roleId,
    confidence_history: [{ value: 0.8, updated_at: now, reason: 'seed' }],
    referenced_count: 0,
    source_task_id: 'task_seed',
    source_driver: 'seed',
    type: 'positive',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}
