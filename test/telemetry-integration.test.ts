import { describe, expect, it } from 'vitest';
import { runBasicFlow } from '../src/coordinator/basic-flow';
import { RuntimeOrchestrator } from '../src/coordinator/orchestrator';
import { SCHEMA_VERSION, createId, nowTimestamp } from '../src/core';
import {
  AgentManager,
  InMemoryBufferRepository,
  InMemoryRepository,
  createAgentMemoryScope,
} from '../src/memory';
import {
  InMemoryTelemetrySink,
  createFHarnessTelemetryPort,
  recordMemoryCycleTelemetry,
} from '../src/telemetry';

describe('telemetry integration', () => {
  it('mirrors cataloged coordinator events and checkpoint L3 observations from basic flow', async () => {
    const sink = new InMemoryTelemetrySink();
    await runBasicFlow({ telemetry: sink });

    const eventTypes = sink.list().map((record) => record.event_type);
    expect(eventTypes).toContain('task.created');
    expect(eventTypes).toContain('memory.context_pack_built');
    expect(eventTypes).toContain('driver.run_result');
    expect(eventTypes).toContain('checkpoint.saved');
    expect(eventTypes).toContain('coord.checkpoint_observed');
    expect(eventTypes).toContain('council.decision');

    const taskCreated = sink.list().find((record) => record.event_type === 'task.created');
    expect(taskCreated?.owner).toBe('C-owned-observed');

    const councilDecision = sink.list().find((record) => record.event_type === 'council.decision');
    expect(councilDecision?.owner).toBe('C-owned-observed');
    expect(councilDecision?.payload).toMatchObject({
      selected_proposal_id: expect.any(String),
      verdict: expect.any(String),
    });

    const checkpointObserved = sink
      .list()
      .find((record) => record.event_type === 'coord.checkpoint_observed');
    expect(checkpointObserved?.payload).toMatchObject({
      checkpoint_id: expect.any(String),
      semantic_handoff: expect.any(Object),
    });
  });

  it('records public dispatch-cycle B-owned observations without EventStore events', async () => {
    const sink = new InMemoryTelemetrySink();
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    const manager = await AgentManager.create(repository, bufferRepository, {
      tools: {
        llm: {
          completeWithTools: async () => ({ content: 'Task completed. [done]' }),
        },
        tools: [],
      },
    });
    await manager.createAgent({
      role_id: 'role_telemetry',
      name: 'Telemetry Agent',
      tags: [],
    });
    const memory = createAgentMemoryScope(repository, bufferRepository, 'role_telemetry');
    const result = await manager.dispatchTask('role_telemetry', {
      spec: 'telemetry memory cycle',
      task_id: 'task_telemetry',
      call_id: 'call_telemetry',
      source_driver: 'telemetry-test',
    });
    const cycle = result.cycle;
    await recordMemoryCycleTelemetry(sink, {
      context: {
        task_id: cycle.buffer_snapshot.task_id,
        role_id: result.role_id,
        memory_ablation: 'B2',
      },
      retrieval: cycle.retrieval,
      call_id: 'call_telemetry',
      source_driver: 'telemetry-test',
      driver_return: cycle.buffer_snapshot.driver_return,
      buffer_seq: cycle.buffer_seq,
      extract_result: cycle.extraction.result,
      promotion: cycle.promotion,
      persona: cycle.persona,
      skills_after: await memory.listSkills(),
      experience_count: (await memory.listExperiences()).length,
    });

    const eventTypes = sink.list().map((record) => record.event_type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        'memory.context_pack_built',
        'driver.run_result',
        'buffer.report_received',
        'memory.extraction_triggered',
        'memory.extraction_completed',
        'metrics.updated',
      ]),
    );

    const contextPack = sink
      .list()
      .find((record) => record.event_type === 'memory.context_pack_built');
    expect(contextPack?.payload).toMatchObject({
      ablation: 'B2',
      retrieved_experience_ids: expect.any(Array),
      retrieved_skill_ids: expect.any(Array),
    });

    const metricsUpdated = sink.list().find((record) => record.event_type === 'metrics.updated');
    expect(metricsUpdated?.payload).toMatchObject({
      agent_metrics: {
        role_id: 'role_telemetry',
        token_cost_total: expect.any(Number),
      },
    });
  });

  it('accepts L1 harness records through FHarnessTelemetryPort', async () => {
    const sink = new InMemoryTelemetrySink();
    const port = createFHarnessTelemetryPort(sink);

    await port.recordSweEvoEvaluation({
      instance_id: 'instance_1',
      instance_seq: 1,
      resolved: true,
      applied: true,
      p2p_regression: false,
      memory_ablation: 'B1',
    });

    await port.recordSweBenchVerifiedEvaluation({
      case_id: 'django__django-1234',
      exit_code: 0,
      fail_to_pass_status: 'all_passed',
      pass_to_pass_status: 'all_passed',
      passed: true,
      scaffold_variant: 'full_system',
      case_tier: 'easy',
    });

    await port.recordTestbedRegression({
      case_id: 'django__django-1234',
      pass_to_pass_regressed: false,
      regressed_tests: [],
    });

    await port.recordProxyUsage({
      case_id: 'django__django-1234',
      input_tokens: 500,
      output_tokens: 100,
      scaffold_variant: 'full_system',
      temperature: 0.2,
      seed: 7,
    });

    await port.recordAgentCrash({
      task_id: 'task_1',
      kill_at: 'after_tool_call',
      progress_pct: 42,
      tool_call_count: 3,
      had_checkpoint: true,
      kill_at_status: 'running',
    });

    expect(sink.list().map((record) => record.event_type)).toEqual([
      'harness.swe_evo_evaluated',
      'harness.swe_bench_verified_evaluated',
      'harness.testbed_regression_checked',
      'proxy.llm_usage_recorded',
      'eval.agent_crash',
    ]);
    expect(
      sink
        .list()
        .filter((record) => record.event_type.startsWith('harness.'))
        .every((r) => r.owner === 'F'),
    ).toBe(true);
    expect(
      sink.list().find((r) => r.event_type === 'proxy.llm_usage_recorded')?.payload,
    ).toMatchObject({
      temperature: 0.2,
      seed: 7,
    });
  });

  it('mirrors orchestrator appendEvent for cataloged C events only', () => {
    const sink = new InMemoryTelemetrySink();
    const orchestrator = new RuntimeOrchestrator({ telemetry: sink });

    orchestrator.appendEvent({
      event_type: 'task.started',
      subject_id: 'task_1',
      task_id: 'task_1',
      payload: { source: 'resume' },
    });
    orchestrator.appendEvent({
      event_type: 'internal.debug',
      subject_id: 'debug_1',
      payload: {},
    });

    expect(sink.list()).toHaveLength(1);
    expect(sink.list()[0]).toMatchObject({
      event_type: 'task.started',
      owner: 'C-owned-observed',
      payload: { source: 'resume' },
    });
  });

  it('observes checkpoint fields when saveCheckpoint is called', () => {
    const sink = new InMemoryTelemetrySink();
    const orchestrator = new RuntimeOrchestrator({ telemetry: sink });
    const task = orchestrator.createTask({ spec: 'checkpoint telemetry' });
    const checkpoint = orchestrator.saveCheckpoint({
      checkpoint_id: createId('checkpoint'),
      checkpoint_type: 'full',
      task_id: task.task_id,
      trigger: 'manual',
      mechanical_snapshot: {
        base_commit: 'abc',
        worktree_path: '.',
        branch: 'main',
        modified_files: [],
      },
      semantic_handoff: {
        done: ['step-1'],
        in_progress: [],
        blocked_on: [],
        assumptions: [],
        next_steps: [],
        known_risks: [],
      },
      artifact_refs: [],
      validity_status: 'valid',
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    });

    const records = sink.list();
    expect(records.some((record) => record.event_type === 'checkpoint.saved')).toBe(true);
    expect(records.some((record) => record.event_type === 'coord.checkpoint_observed')).toBe(true);
    expect(
      records.find((record) => record.event_type === 'coord.checkpoint_observed')?.payload,
    ).toMatchObject({
      checkpoint_id: checkpoint.checkpoint_id,
      semantic_handoff: { done: ['step-1'] },
    });
  });
});
