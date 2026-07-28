import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runIntegrationV0Flow,
  type IntegrationV0Options,
  type IntegrationV0Result,
} from '../../src/coordinator/integration-v0-flow';
import {
  MockDriver,
  type DriverRuntimeHandle,
  type DriverPrompt,
  type DriverRunResult,
} from '../../src/driver';
import { SCHEMA_VERSION, createId, type ArtifactRef } from '../../src/core';
import type { CouncilProvider, CouncilRoundInput } from '../../src/council';
import type {
  AgentExecutionFacade,
  AgentExecutionRequest,
} from '../../src/protocol/agent-execution';
import type { HookResult } from '../../src/hook';
import type {
  MaterializationInput,
  MaterializationResult,
} from '../../src/coordinator/worktree-materializer';
import { SelectAgentHandler } from '../../src/coordinator/handlers/select-agent-handler';
import type { AgentProjection } from '../../src/market';

describe('runIntegrationV0Flow', () => {
  const createdRunDirs = new Set<string>();
  const createdWorktreeDirs = new Set<string>();
  const createdWorkspaceDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...createdRunDirs, ...createdWorktreeDirs, ...createdWorkspaceDirs].map((dir) =>
        fs.rm(dir, { recursive: true, force: true }),
      ),
    );
    createdRunDirs.clear();
    createdWorktreeDirs.clear();
    createdWorkspaceDirs.clear();
  });

  it('reports real task and run ids before driver completion', async () => {
    let releaseDriver: (() => void) | undefined;
    const driverBarrier = new Promise<void>((resolve) => {
      releaseDriver = resolve;
    });
    class BlockingDriver extends MockDriver {
      override async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
        await driverBarrier;
        return super.sendPrompt(input);
      }
    }

    let resolveIdentity: ((identity: { run_id: string; task_id: string }) => void) | undefined;
    const identityPromise = new Promise<{ run_id: string; task_id: string }>((resolve) => {
      resolveIdentity = resolve;
    });
    const flowPromise = runIntegrationV0Flow({
      driver: new BlockingDriver(),
      onRunCreated: (identity) => resolveIdentity?.(identity),
    });

    const identity = await identityPromise;
    expect(identity.run_id).toMatch(/^run_/);
    expect(identity.task_id).toMatch(/^task_/);
    releaseDriver?.();
    const result = await flowPromise;
    createdRunDirs.add(`.newide/runs/${result.run_id}`);
    createdWorktreeDirs.add(result.materialization_result.worktree_path);
    expect(identity).toEqual({ run_id: result.run_id, task_id: result.task_id });
  });

  it('creates a new run under an existing durable task identity', async () => {
    const eventTypes: string[] = [];
    const result = await runFlow({
      taskId: 'task_existing',
      taskRequest: {
        spec: 'Run Council for the existing task',
        completion_criteria: ['Council produces a final artifact'],
      },
      onEvent: (event) => eventTypes.push(event.event_type),
    });

    expect(result.task_id).toBe('task_existing');
    expect(result.frontend_snapshot.task.task_id).toBe('task_existing');
    expect(result.timeline[0]?.name).toBe('TaskAttached');
    expect(eventTypes).not.toContain('task.created');
  });

  it('should run complete flow with MockDriver and single_agent mode', async () => {
    const result = await runFlow();

    expect(result.run_id).toBeDefined();
    expect(result.task_id).toBeDefined();
    expect(result.summary.mode).toBe('single_agent');
    expect(result.summary.status).toBe('completed');

    // Verify mailbox events in timeline
    const timelineNames = result.timeline.map((t) => t.name);
    expect(timelineNames).toContain('MailboxMessageSent (task.assigned)');
    expect(timelineNames).toContain('MailboxMessageSent (driver.requested)');
    expect(timelineNames).toContain('MailboxMessageSent (driver.completed)');
    expect(timelineNames).toContain('MailboxMessageAcked (driver.requested)');
    expect(timelineNames.indexOf('MailboxMessageAcked (driver.requested)')).toBeLessThan(
      timelineNames.indexOf('DriverRunResult'),
    );

    expect(result.mailbox_thread.map((message) => message.type)).toEqual([
      'task.assigned',
      'driver.requested',
      'driver.completed',
    ]);

    const driverRequested = result.mailbox_thread.find(
      (message) => message.type === 'driver.requested',
    );
    expect(driverRequested).toBeDefined();
    if (!driverRequested) {
      throw new Error('driver.requested mailbox message was not found');
    }
    expect(driverRequested.requires_ack).toBe(true);
    expect(driverRequested.deadline_seconds).toBe(300);

    const driverRequestedDelivery = result.mailbox_deliveries.find(
      (delivery) => delivery.message_id === driverRequested.message_id,
    );
    expect(driverRequestedDelivery).toBeDefined();
    if (!driverRequestedDelivery) {
      throw new Error('driver.requested mailbox delivery was not found');
    }
    expect(driverRequestedDelivery.status).toBe('acked');
    expect(driverRequestedDelivery.ack_at).toBeDefined();
  });

  it('publishes task.completed only after the final delivery boundary', async () => {
    const events: string[] = [];
    const result = await runFlow({ onEvent: (event) => events.push(event.event_type) });

    expect(events.filter((event) => event === 'task.completed')).toHaveLength(1);
    expect(events).toContain('agent.primary_completed');
    expect(events.indexOf('agent.primary_completed')).toBeLessThan(
      events.indexOf('task.completed'),
    );
    expect(events.indexOf('task.completed')).toBeLessThan(events.indexOf('run.completed'));
    expect(result.summary.status).toBe('completed');
  });

  it('creates the runtime task from the supplied task definition', async () => {
    const result = await runFlow({
      taskRequest: {
        spec: 'Implement the task-first RPC surface',
        role_id: 'role_backend_engineer',
        risk_level: 'medium',
        affected_paths: ['src/app/**', 'src/protocol/**'],
        completion_criteria: ['TaskSnapshot is queryable through JSON-RPC'],
        budget: { max_tool_calls: 20 },
      },
    });

    expect(result.frontend_snapshot.task).toMatchObject({
      spec: 'Implement the task-first RPC surface',
      role_id: 'role_backend_engineer',
      risk_level: 'medium',
      affected_paths: ['src/app/**', 'src/protocol/**'],
      completion_criteria: ['TaskSnapshot is queryable through JSON-RPC'],
      budget: { max_tool_calls: 20 },
    });
  });

  it('reports a structured GATE_DENIED failure', async () => {
    const result = await runFlow({ hookEngine: fakeHookEngine('deny') });

    expect(result.summary.failure).toMatchObject({
      code: 'GATE_DENIED',
      message: 'Gate deny-gate denied the run',
      details: {
        phase: 'gate',
        gate_results: [
          { gate_id: 'deny-gate', decision: 'deny', reason: 'policy rejected the artifact' },
        ],
      },
    });
    expect(result.summary.status).toBe('failed');
  });

  it('reports a gate that was not evaluated as GATE_BLOCKED', async () => {
    const result = await runFlow({
      hookEngine: {
        handleEvent: async () => ({
          hook_point: 'task.completed',
          matched: false,
          gate_requests: [],
          gate_results: [],
          final_decision: 'allow',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        }),
      },
    });

    expect(result.summary.failure).toEqual({
      code: 'GATE_BLOCKED',
      message: 'Required gates were not evaluated',
      details: { phase: 'gate', gate_phase: 'pre_selection', gate_results: [] },
    });
  });

  it('labels a missing pre-council gate with the council phase', async () => {
    const result = await runFlow({
      enableCouncil: true,
      hookEngine: {
        handleEvent: async (event) => ({
          hook_point: event.event_type,
          matched: false,
          gate_requests: [],
          gate_results: [],
          final_decision: 'allow',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        }),
      },
    });

    expect(result.summary.failure).toMatchObject({
      code: 'GATE_BLOCKED',
      details: { gate_phase: 'pre_council' },
    });
  });

  it.each([
    ['failed', 'MATERIALIZATION_FAILED'],
    ['partial', 'MATERIALIZATION_PARTIAL'],
  ] as const)('reports %s materialization as %s', async (status, code) => {
    const failure = { artifact_id: 'artifact_1', reason: `${status} write` };
    const result = await runFlow({ materializer: fakeMaterializer(status, [failure]) });

    expect(result.summary.failure).toMatchObject({
      code,
      details: {
        phase: 'materialization',
        status,
        failures: [failure],
      },
    });
  });

  it('converts a thrown materializer error into a durable MATERIALIZATION_FAILED result', async () => {
    const result = await runFlow({
      materializer: {
        materialize: async () => {
          throw new Error('secret filesystem details');
        },
      },
    });

    expect(result.summary.failure).toMatchObject({
      code: 'MATERIALIZATION_FAILED',
      message: 'Worktree materialization failed',
      details: {
        phase: 'materialization',
        status: 'failed',
        files_written: [],
        failures: [{ reason: 'Materializer failed' }],
      },
    });
    expect(result.timeline.map((item) => item.name)).toContain('RunFailed');
    await expect(
      fs.readFile(`.newide/runs/${result.run_id}/checkpoint.json`, 'utf-8'),
    ).resolves.toBeTruthy();
  });

  it('should run with council mode when enabled', async () => {
    const result = await runFlow({ enableCouncil: true });
    const councilDecisionPath = `.newide/runs/${result.run_id}/council/decision.json`;
    const councilProposalsPath = `.newide/runs/${result.run_id}/council/proposals.json`;
    const councilReviewsPath = `.newide/runs/${result.run_id}/council/reviews.json`;
    const councilOutputPath = `.newide/runs/${result.run_id}/council/output.json`;

    expect(result.summary.mode).toBe('council');
    expect(result.summary.status).toBe('completed');
    expect(result.selection_result.council_decision).toMatchObject({
      run_id: result.run_id,
      task_id: result.task_id,
      decision_mode: 'advisory',
      verdict: 'select',
      selected_artifact_refs: result.selection_result.selected_artifacts.map(
        (artifact) => artifact.artifact_id,
      ),
      can_create_merge_authorization: false,
    });
    expect(result.selection_result.metadata).toMatchObject({
      decision_mode: 'advisory',
      verdict: 'select',
      can_create_merge_authorization: false,
    });

    const timelineNames = result.timeline.map((t) => t.name);
    expect(timelineNames).toContain('CouncilDecision');
    expect(timelineNames.indexOf('CouncilDecision')).toBeLessThan(
      timelineNames.indexOf('ArtifactSelected'),
    );

    await expect(readJson(councilDecisionPath)).resolves.toMatchObject({
      decision_id: result.selection_result.council_decision?.decision_id,
      decision_mode: 'advisory',
      verdict: 'select',
      selected_artifact_refs: result.selection_result.selected_artifacts.map(
        (artifact) => artifact.artifact_id,
      ),
      can_create_merge_authorization: false,
    });

    await expect(readJson(`.newide/runs/${result.run_id}/result.json`)).resolves.toMatchObject({
      council_decision_path: councilDecisionPath,
      council_proposals_path: councilProposalsPath,
      council_reviews_path: councilReviewsPath,
      council_output_path: councilOutputPath,
      council_verdict: 'select',
      council_decision_mode: 'advisory',
    });
    await expect(readJson(councilProposalsPath)).resolves.toEqual(
      result.selection_result.council_run_result?.proposals,
    );
    await expect(readJson(councilReviewsPath)).resolves.toEqual(
      result.selection_result.council_run_result?.reviews,
    );
    await expect(readJson(councilOutputPath)).resolves.toEqual(
      result.selection_result.council_run_result?.output,
    );

    await expect(
      readJson(`.newide/runs/${result.run_id}/frontend-snapshot.json`),
    ).resolves.toMatchObject({
      council: {
        decision_path: councilDecisionPath,
        proposals_path: councilProposalsPath,
        reviews_path: councilReviewsPath,
        output_path: councilOutputPath,
        decision_id: result.selection_result.council_decision?.decision_id,
        decision_mode: 'advisory',
        verdict: 'select',
        selected_artifact_refs: result.selection_result.selected_artifacts.map(
          (artifact) => artifact.artifact_id,
        ),
        can_create_merge_authorization: false,
        proposals: result.selection_result.council_run_result?.proposals,
        reviews: result.selection_result.council_run_result?.reviews,
        output: result.selection_result.council_run_result?.output,
        reason: result.selection_result.council_decision?.reason,
        evidence_refs: result.selection_result.council_decision?.evidence_refs,
        risk_signals: result.selection_result.council_run_result?.proposals.flatMap(
          (proposal) => proposal.known_risks,
        ),
      },
    });

    const eventLog = await readJson(`.newide/runs/${result.run_id}/event-log.json`);
    const eventTypes = eventLog.map((event: { event_type?: string }) => event.event_type);
    expect(eventTypes.indexOf('council.started')).toBeLessThan(
      eventTypes.indexOf('council.decision'),
    );
    expect(eventTypes.indexOf('council.decision')).toBeLessThan(
      eventTypes.indexOf('council.completed'),
    );
    expect(eventLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'council.started',
          subject_id: result.run_id,
          run_id: result.run_id,
          task_id: result.task_id,
          payload: expect.objectContaining({
            trigger: 'user_choice',
            decision_mode: 'advisory',
            candidate_artifact_refs: result.driver_result.artifacts.map(
              (artifact) => artifact.artifact_id,
            ),
          }),
        }),
        expect.objectContaining({
          event_type: 'council.decision',
          subject_id: result.selection_result.council_decision?.decision_id,
          run_id: result.run_id,
          task_id: result.task_id,
          payload: expect.objectContaining({
            verdict: 'select',
            can_create_merge_authorization: false,
            termination_reason: 'select',
            current_round_count: 1,
            decision_packet_ref: result.selection_result.council_decision?.decision_id,
          }),
        }),
        expect.objectContaining({
          event_type: 'council.completed',
          subject_id: result.selection_result.council_run_result?.council_run_id,
          run_id: result.run_id,
          task_id: result.task_id,
          payload: expect.objectContaining({
            decision_id: result.selection_result.council_decision?.decision_id,
            verdict: 'select',
            selected_artifact_refs: result.selection_result.selected_artifacts.map(
              (artifact) => artifact.artifact_id,
            ),
            total_rounds: 1,
          }),
        }),
      ]),
    );
  });

  it('should use an injected council provider in council mode', async () => {
    const seenInputs: CouncilRoundInput[] = [];
    const injectedCouncilProvider: CouncilProvider = {
      async runCouncilRound(input) {
        seenInputs.push(input);
        const selectedProposal = input.proposals[0];
        const selectedArtifactRefs = selectedProposal?.artifact_refs.slice(0, 1) ?? [];

        return {
          council_run_id: 'council_run_injected',
          ...(input.run_id ? { run_id: input.run_id } : {}),
          task_id: input.task_id,
          proposals: input.proposals,
          reviews: [],
          decision: {
            decision_id: 'council_decision_injected',
            ...(input.run_id ? { run_id: input.run_id } : {}),
            task_id: input.task_id,
            ...(selectedProposal ? { selected_proposal_id: selectedProposal.proposal_id } : {}),
            decision_mode: input.decision_mode,
            selected_artifact_refs: selectedArtifactRefs,
            verdict: selectedArtifactRefs.length > 0 ? 'select' : 'needs_human',
            reason: 'Injected council provider selected the first artifact.',
            evidence_refs: input.evidence_pack ? [input.evidence_pack.evidence_pack_id] : [],
            can_create_merge_authorization: false,
            created_at: new Date().toISOString(),
            schema_version: SCHEMA_VERSION,
          },
          generated_artifact_refs: [],
          selected_artifact_refs: selectedArtifactRefs,
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        };
      },
    };

    const result = await runFlow({
      enableCouncil: true,
      councilProvider: injectedCouncilProvider,
    });

    expect(seenInputs).toHaveLength(1);
    expect(seenInputs[0]).toMatchObject({
      run_id: result.run_id,
      task_id: result.task_id,
      decision_mode: 'advisory',
    });
    expect(seenInputs[0]?.proposals[0]?.artifact_refs).toEqual(
      result.driver_result.artifacts.map((artifact) => artifact.artifact_id),
    );
    expect(seenInputs[0]?.evidence_pack).toMatchObject({
      task_id: result.task_id,
      artifact_refs: result.driver_result.artifacts.map((artifact) => artifact.artifact_id),
    });
    expect(result.selection_result.council_decision).toMatchObject({
      decision_id: 'council_decision_injected',
      selected_artifact_refs: [result.driver_result.artifacts[0]?.artifact_id],
      reason: 'Injected council provider selected the first artifact.',
    });
    expect(result.summary.council_decision_id).toBe('council_decision_injected');
    await expect(readJson(`.newide/runs/${result.run_id}/result.json`)).resolves.toMatchObject({
      council_decision_mode: 'advisory',
      council_verdict: 'select',
    });
  });

  it('blocks council-selected artifacts when the post-council gate denies', async () => {
    const hookPoints: string[] = [];
    const worktreeRoot = path.join('.newide', 'worktrees', `post-gate-deny-${createId('test')}`);
    const hookEngine = {
      handleEvent: async (event: { event_type: string }): Promise<HookResult> => {
        hookPoints.push(event.event_type);
        const decision = hookPoints.length === 1 ? 'allow' : 'deny';
        return gateHookResult(event.event_type, decision, `gate-${hookPoints.length}`);
      },
    };
    const materialize = vi.fn(fakeMaterializer('completed', []).materialize);

    const result = await runFlow({
      enableCouncil: true,
      hookEngine,
      materializer: { materialize },
      worktreePath: worktreeRoot,
    });

    expect(hookPoints).toEqual(['task.completed', 'council.completed']);
    expect(result.selection_result.selected_artifacts.length).toBeGreaterThan(0);
    expect(materialize).not.toHaveBeenCalled();
    expect(result.materialization_result.files_written).toEqual([]);
    expect(result.materialization_result.failures).toEqual([
      expect.objectContaining({ reason: 'Post-council gate did not allow materialization' }),
    ]);
    await expect(fs.access(path.join(worktreeRoot, result.task_id))).rejects.toThrow();
    expect(result.summary.failure).toMatchObject({
      code: 'GATE_DENIED',
      details: { phase: 'gate', gate_phase: 'post_council' },
    });

    const eventLog = (await readJson(`.newide/runs/${result.run_id}/event-log.json`)) as Array<{
      event_type: string;
      payload: Record<string, unknown>;
    }>;
    const eventTypes = eventLog.map((event) => event.event_type);
    expect(eventTypes.filter((type) => type === 'gate.result')).toHaveLength(2);
    expect(eventTypes.indexOf('council.completed')).toBeLessThan(
      eventTypes.indexOf('artifact.selected'),
    );
    expect(eventTypes.indexOf('artifact.selected')).toBeLessThan(
      eventTypes.lastIndexOf('gate.result'),
    );
    expect(eventTypes.lastIndexOf('gate.result')).toBeLessThan(
      eventTypes.indexOf('worktree.materialized'),
    );
    expect(
      eventLog.filter((event) => event.event_type === 'gate.result').at(-1)?.payload,
    ).toMatchObject({
      phase: 'post_council',
      decision: 'deny',
      reason: 'deny at council.completed',
      target_state: 'blocked',
      required_actions: ['fix-policy'],
    });
    expect(
      eventLog.find((event) => event.event_type === 'worktree.materialized')?.payload,
    ).toMatchObject({ skipped: true, files_written: 0 });
  });

  it('rewrites duplicate post gate result ids without misclassifying a pre deny', async () => {
    let invocation = 0;
    const hookEngine = {
      handleEvent: async (event: { event_type: string }): Promise<HookResult> => {
        invocation += 1;
        return gateHookResult(event.event_type, invocation === 1 ? 'deny' : 'allow', 'duplicate');
      },
    };
    const materialize = vi.fn(fakeMaterializer('completed', []).materialize);

    const result = await runFlow({
      enableCouncil: true,
      hookEngine,
      materializer: { materialize },
    });

    expect(result.summary.failure).toMatchObject({
      code: 'GATE_DENIED',
      details: { gate_phase: 'pre_council' },
    });
    const eventLog = (await readJson(`.newide/runs/${result.run_id}/event-log.json`)) as Array<{
      event_type: string;
      subject_id: string;
      payload: Record<string, unknown>;
    }>;
    const gateEvents = eventLog.filter((event) => event.event_type === 'gate.result');
    expect(gateEvents.map((event) => event.subject_id)).toHaveLength(2);
    expect(new Set(gateEvents.map((event) => event.subject_id)).size).toBe(2);
    expect(gateEvents[1]?.payload).toMatchObject({
      phase: 'post_council',
      source_gate_result_id: 'gate_result_duplicate',
    });
  });

  it('should persist summary and timeline to .newide/runs/', async () => {
    const result = await runFlow();

    const summaryPath = `.newide/runs/${result.run_id}/summary.json`;
    const timelinePath = `.newide/runs/${result.run_id}/timeline.json`;

    // Verify files exist
    const summaryExists = await fs
      .access(summaryPath)
      .then(() => true)
      .catch(() => false);
    const timelineExists = await fs
      .access(timelinePath)
      .then(() => true)
      .catch(() => false);

    expect(summaryExists).toBe(true);
    expect(timelineExists).toBe(true);

    // Verify summary content
    const summaryContent = await fs.readFile(summaryPath, 'utf-8');
    const summary = JSON.parse(summaryContent);
    expect(summary.run_id).toBe(result.run_id);
    expect(summary.task_id).toBe(result.task_id);
    expect(summary.mode).toBe('single_agent');
    expect(summary.status).toBe('completed');

    // Verify timeline content
    const timelineContent = await fs.readFile(timelinePath, 'utf-8');
    const timeline = JSON.parse(timelineContent);
    expect(Array.isArray(timeline)).toBe(true);
    expect(timeline.length).toBeGreaterThan(0);
  });

  it('should persist a stable run result manifest', async () => {
    const result = await runFlow();

    const resultPath = `.newide/runs/${result.run_id}/result.json`;
    const resultContent = await fs.readFile(resultPath, 'utf-8');
    const manifest = JSON.parse(resultContent);

    expect(manifest).toMatchObject({
      run_id: result.run_id,
      task_id: result.task_id,
      status: result.summary.status,
      mode: result.summary.mode,
      driver_id: result.summary.driver_diagnostics.driver_id,
      artifact_outputs: result.summary.artifact_outputs,
      materialization_status: 'completed',
      changed_files: result.materialization_result.changed_files,
      materialization_failures: [],
      result_path: `.newide/runs/${result.run_id}/result.json`,
      summary_path: `.newide/runs/${result.run_id}/summary.json`,
      timeline_path: `.newide/runs/${result.run_id}/timeline.json`,
      checkpoint_path: `.newide/runs/${result.run_id}/checkpoint.json`,
      message_thread_path: `.newide/runs/${result.run_id}/message-thread.json`,
      event_log_path: `.newide/runs/${result.run_id}/event-log.json`,
      frontend_snapshot_path: `.newide/runs/${result.run_id}/frontend-snapshot.json`,
      schema_version: result.summary.schema_version,
    });
    expect(manifest.created_at).toBeDefined();
    expect(manifest).not.toHaveProperty('council_decision_path');
    expect(manifest).not.toHaveProperty('council_verdict');
    expect(manifest).not.toHaveProperty('council_decision_mode');
    await expect(readJson(manifest.summary_path)).resolves.toMatchObject({
      run_id: result.run_id,
    });
    await expect(readJson(manifest.timeline_path)).resolves.toEqual(expect.any(Array));
    await expect(readJson(manifest.checkpoint_path)).resolves.toMatchObject({
      checkpoint_id: result.summary.checkpoint_id,
    });
    await expect(readJson(manifest.message_thread_path)).resolves.toEqual(result.mailbox_thread);
    await expect(readJson(manifest.event_log_path)).resolves.toEqual(expect.any(Array));
    await expect(readJson(manifest.frontend_snapshot_path)).resolves.toMatchObject({
      snapshot_type: 'coordinator.frontend_run_snapshot.v0',
      run_id: result.run_id,
      task_id: result.task_id,
      current: {
        stage: 'delivery',
        task_status: result.summary.status,
      },
      links: {
        result_path: manifest.result_path,
        event_log_path: manifest.event_log_path,
      },
    });
  });

  it('should materialize artifacts to worktree', async () => {
    const result = await runFlow();

    expect(result.materialization_result.files_written.length).toBeGreaterThan(0);

    // Verify files exist
    for (const file of result.materialization_result.files_written) {
      const exists = await fs
        .access(file)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    }

    // Verify worktree path in summary matches materialization result
    expect(result.summary.worktree_path).toBe(result.materialization_result.worktree_path);
    expect(result.materialization_result).toMatchObject({
      status: 'completed',
      failures: [],
    });
    expect(result.summary).toMatchObject({
      materialization_status: 'completed',
      changed_files: result.materialization_result.changed_files,
      materialization_failures: [],
    });
    const generated = path.join(
      result.materialization_result.worktree_path,
      'generated/mock-driver-output.txt',
    );
    await expect(fs.readFile(generated, 'utf-8')).resolves.toBe(
      `MockDriver completed task ${result.task_id}\n`,
    );
  });

  it('should include materialized artifact outputs in summary', async () => {
    const result = await runFlow();
    const artifact = result.selection_result.selected_artifacts[0]!;

    expect(result.summary.artifact_outputs).toEqual([
      expect.objectContaining({
        artifact_id: artifact.artifact_id,
        type: artifact.type,
        uri: artifact.uri,
        materialized_path: result.materialization_result.files_written[0],
      }),
    ]);
  });

  it('should work with injected driver', async () => {
    const fakeDriver = new MockDriver();
    const result = await runFlow({ driver: fakeDriver });

    expect(result.summary.status).toBe('completed');
    expect(result.driver_result.diagnostics.driver_id).toBe('mock-driver');
  });

  it('should optionally run single agent through AgentExecutionFacade without replacing the default path', async () => {
    const requests: AgentExecutionRequest[] = [];
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input) {
        requests.push(input);
        return {
          agent_run_id: 'agent_run_001',
          agent_id: input.role_id,
          role_id: input.role_id,
          context_pack_ref: 'context_pack_001',
          driver_run_result_id: 'driver_result_from_agent_001',
          artifact_refs: [createArtifact('artifact_from_agent_001')],
          transcript_ref: createArtifact('artifact_transcript_from_agent_001', 'transcript'),
          session_id: 'session_existing',
          response: 'Implemented through the real Agent session.',
          tool_events: [
            {
              tool_event_id: 'tool_event_from_agent_001',
              tool_name: 'edit',
              status: 'completed',
              summary: 'Edited the target file.',
              created_at: new Date().toISOString(),
              schema_version: SCHEMA_VERSION,
            },
          ],
          diagnostics: {
            driver_id: 'agent-driver',
            duration_ms: 42,
          },
          status: 'completed',
          memory_buffer_ref: 'memory_buffer_001',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        };
      },
    };

    const result = await runFlow({
      agentExecutionFacade,
      workspacePath: process.cwd(),
      sessionId: 'session_existing',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      task_id: result.task_id,
      run_id: result.run_id,
      role_id: 'role_ts_engineer',
      instruction: 'Run the integration v0 flow',
      context_policy: 'integration_v0_default',
      workspace_path: process.cwd(),
      session_id: 'session_existing',
    });
    expect(result.agent_execution_result).toMatchObject({
      agent_run_id: 'agent_run_001',
      status: 'completed',
    });
    expect(result.driver_result).toMatchObject({
      driver_run_result_id: 'driver_result_from_agent_001',
      session_id: 'session_existing',
      response: 'Implemented through the real Agent session.',
      tool_events: [expect.objectContaining({ tool_event_id: 'tool_event_from_agent_001' })],
      status: 'succeeded',
      artifacts: [expect.objectContaining({ artifact_id: 'artifact_from_agent_001' })],
      transcript_ref: expect.objectContaining({
        artifact_id: 'artifact_transcript_from_agent_001',
      }),
    });
    expect(result.selection_result.selected_artifacts).toEqual([
      expect.objectContaining({ artifact_id: 'artifact_from_agent_001' }),
    ]);
    expect(result.timeline.map((item) => item.name)).toContain('AgentExecutionCompleted');
    expect(result.summary.status).toBe('completed');

    const eventLog = await readJson(`.newide/runs/${result.run_id}/event-log.json`);
    const eventTypes = eventLog.map((event: { event_type?: string }) => event.event_type);
    expect(eventTypes.indexOf('agent.execution_requested')).toBeLessThan(
      eventTypes.indexOf('agent.execution_completed'),
    );
    expect(eventLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'agent.execution_requested',
          subject_id: result.run_id,
          run_id: result.run_id,
          task_id: result.task_id,
          payload: expect.objectContaining({
            role_id: 'role_ts_engineer',
            context_policy: 'integration_v0_default',
            input_artifact_refs: [],
          }),
        }),
        expect.objectContaining({
          event_type: 'agent.execution_completed',
          subject_id: 'agent_run_001',
          run_id: result.run_id,
          task_id: result.task_id,
        }),
      ]),
    );
  });

  it('dispatches an ordinary task to the persisted AgentMarket winner', async () => {
    const requests: AgentExecutionRequest[] = [];
    const agentExecutionFacade = successfulAgentFacade(requests);
    const selectAgentHandler = new SelectAgentHandler({
      projectionSource: {
        async projectCandidates() {
          return [marketCandidate('role_market_winner')];
        },
      },
      evidenceStore: {
        async persist() {
          return {
            ledger_ref: 'file:///market/ledger.json',
            audit_ref: 'file:///market/audit.json',
          };
        },
      },
      now: () => '2026-07-18T00:00:00.000Z',
    });

    const result = await runFlow({ agentExecutionFacade, selectAgentHandler });

    expect(requests[0]?.role_id).toBe('role_market_winner');
    expect(result.market_selection).toMatchObject({
      winner_agent_id: 'role_market_winner',
      ledger_ref: 'file:///market/ledger.json',
      audit_ref: 'file:///market/audit.json',
    });
    expect(result.summary.market).toMatchObject({
      winner_agent_id: 'role_market_winner',
      ledger_ref: 'file:///market/ledger.json',
      audit_ref: 'file:///market/audit.json',
      seed: result.run_id,
      policy_version: 'market-v0',
    });
    expect(result.timeline.map((item) => item.name)).toContain('MarketSelected');
    const eventLog = (await readJson(`.newide/runs/${result.run_id}/event-log.json`)) as Array<{
      event_type: string;
      payload: Record<string, unknown>;
    }>;
    expect(eventLog).toContainEqual(
      expect.objectContaining({
        event_type: 'market.selected',
        payload: expect.objectContaining({
          winner_agent_id: 'role_market_winner',
          ledger_ref: 'file:///market/ledger.json',
          audit_ref: 'file:///market/audit.json',
        }),
      }),
    );
  });

  it.each([
    ['scheduled', 'memory.maintenance_scheduled'],
    ['running', 'memory.maintenance_running'],
    ['completed', 'memory.maintenance_completed'],
    ['skipped', 'memory.maintenance_skipped'],
    ['failed', 'memory.maintenance_failed'],
  ] as const)('publishes %s B maintenance evidence as %s', async (status, eventType) => {
    const delegate = successfulAgentFacade([]);
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input, options) {
        const result = await delegate.runAgent(input, options);
        return {
          ...result,
          diagnostics: {
            ...result.diagnostics,
            memory_maintenance: {
              maintenance_ref: 'b_maintenance_event_001',
              kind: 'experience_extraction',
              status,
              role_id: input.role_id,
              buffer_seq: 1,
              experiences: [],
              skills: [],
              warnings: [],
            },
          },
        };
      },
    };

    const result = await runFlow({ agentExecutionFacade });
    const eventLog = (await readJson(`.newide/runs/${result.run_id}/event-log.json`)) as Array<{
      event_type?: string;
      subject_id?: string;
    }>;

    expect(eventLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: eventType,
          subject_id: 'b_maintenance_event_001',
        }),
      ]),
    );
  });

  it('completes a successful response-only Agent execution without changed files', async () => {
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input) {
        return {
          agent_run_id: 'agent_run_response_only',
          agent_id: input.role_id,
          role_id: input.role_id,
          context_pack_ref: 'context_pack_response_only',
          driver_run_result_id: 'driver_result_response_only',
          artifact_refs: [],
          transcript_ref: createArtifact('transcript_response_only', 'transcript'),
          session_id: 'session_response_only',
          response: 'The requested behavior is already implemented.',
          tool_events: [],
          diagnostics: { driver_id: 'agent-driver', duration_ms: 12 },
          status: 'completed',
          memory_buffer_ref: 'memory_buffer_response_only',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        };
      },
    };

    const result = await runFlow({ agentExecutionFacade });

    expect(result.summary).toMatchObject({
      status: 'completed',
      outcome: 'completed_response',
      changed_files: [],
    });
    expect(result.driver_result.response).toBe('The requested behavior is already implemented.');
  });

  it('does not count a metadata-only artifact as a successful file delivery', async () => {
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input) {
        return {
          agent_run_id: 'agent_run_metadata_only',
          agent_id: input.role_id,
          role_id: input.role_id,
          context_pack_ref: 'context_pack_metadata_only',
          driver_run_result_id: 'driver_result_metadata_only',
          artifact_refs: [createArtifact('artifact_metadata_only', 'driver_result')],
          transcript_ref: createArtifact('transcript_metadata_only', 'transcript'),
          session_id: 'session_metadata_only',
          response: '',
          tool_events: [],
          diagnostics: { driver_id: 'agent-driver', duration_ms: 12 },
          status: 'completed',
          memory_buffer_ref: 'memory_buffer_metadata_only',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        };
      },
    };

    const result = await runFlow({ agentExecutionFacade });

    expect(result.summary).toMatchObject({
      status: 'failed',
      outcome: 'failed',
      changed_files: [],
      failure: { code: 'ARTIFACT_NOT_SELECTED' },
    });
  });

  it('should include all key timeline events', async () => {
    const result = await runFlow();

    const timelineNames = result.timeline.map((t) => t.name);

    // Core events
    expect(timelineNames).toContain('TaskCreated');
    expect(timelineNames).toContain('RunCreated');

    // Mailbox events
    expect(timelineNames).toContain('MailboxMessageSent (task.assigned)');
    expect(timelineNames).toContain('MailboxMessageSent (driver.requested)');
    expect(timelineNames).toContain('MailboxMessageSent (driver.completed)');
    expect(timelineNames).toContain('MailboxMessageAcked (driver.requested)');

    // Processing events
    expect(timelineNames).toContain('ContextPackBuilt');
    expect(timelineNames).toContain('DriverRunResult');
    expect(timelineNames).toContain('ArtifactSelected');
    expect(timelineNames).toContain('WorktreeMaterialized');
    expect(timelineNames).toContain('RunCompleted');
  });

  it('should create summary with correct structure', async () => {
    const result = await runFlow();

    expect(result.summary).toHaveProperty('run_id');
    expect(result.summary).toHaveProperty('task_id');
    expect(result.summary).toHaveProperty('mode');
    expect(result.summary).toHaveProperty('status');
    expect(result.summary).toHaveProperty('worktree_path');
    expect(result.summary).toHaveProperty('artifacts_materialized');
    expect(result.summary).toHaveProperty('files_written');
    expect(result.summary).toHaveProperty('artifact_outputs');
    expect(result.summary).toHaveProperty('driver_diagnostics');
    expect(result.summary).toHaveProperty('created_at');
    expect(result.summary).toHaveProperty('schema_version');
    expect(result.summary).toHaveProperty('mailbox_message_refs');
    expect(result.summary).toHaveProperty('mailbox_thread_id');
    expect(result.frontend_snapshot).toMatchObject({
      run_id: result.run_id,
      task_id: result.task_id,
      task: {
        status: 'completed',
      },
      current: {
        stage: 'delivery',
        task_status: 'completed',
      },
      mailbox: {
        thread_id: result.summary.mailbox_thread_id,
      },
    });

    expect(result.summary.driver_diagnostics).toHaveProperty('driver_id');
    expect(result.summary.driver_diagnostics).toHaveProperty('duration_ms');

    // Verify mailbox fields
    expect(result.summary.mailbox_message_refs).toBeInstanceOf(Array);
    expect(result.summary.mailbox_message_refs.length).toBe(3); // task.assigned, driver.requested, driver.completed
    expect(result.summary.mailbox_thread_id).toBe(result.run_id);
  });

  it('should support custom driver prompt', async () => {
    const customPrompt = 'Custom integration test prompt';
    const result = await runFlow({ driverPrompt: customPrompt });

    expect(result.summary.status).toBe('completed');
    // Verify the prompt was used (indirectly through successful completion)
    expect(result.timeline.length).toBeGreaterThan(0);
  });

  it('should save checkpoint to .newide/runs/<run_id>/checkpoint.json', async () => {
    const result = await runFlow();

    const checkpointPath = `.newide/runs/${result.run_id}/checkpoint.json`;

    // Verify checkpoint file exists
    const checkpointExists = await fs
      .access(checkpointPath)
      .then(() => true)
      .catch(() => false);
    expect(checkpointExists).toBe(true);

    // Verify checkpoint content
    const checkpointContent = await fs.readFile(checkpointPath, 'utf-8');
    const checkpoint = JSON.parse(checkpointContent);

    expect(checkpoint.checkpoint_id).toBeDefined();
    expect(checkpoint.checkpoint_type).toBe('full');
    expect(checkpoint.task_id).toBe(result.task_id);
    expect(checkpoint.trigger).toBe('manual');
    expect(checkpoint.validity_status).toBe('valid');

    // Verify demo git snapshot fields
    expect(checkpoint.mechanical_snapshot.base_commit).toBe('demo-head');
    expect(checkpoint.mechanical_snapshot.snapshot_commit).toBe('demo-head');
    expect(checkpoint.mechanical_snapshot.branch).toBe('integration-v0-demo');

    // Verify resume_cursor is worktree.materialized
    expect(checkpoint.runtime_state.resume_cursor).toBe('worktree.materialized');
  });

  it('should include checkpoint info in summary', async () => {
    const result = await runFlow();

    expect(result.summary.checkpoint_id).toBeDefined();
    expect(result.summary.checkpoint_path).toBe(`.newide/runs/${result.run_id}/checkpoint.json`);

    // Verify checkpoint_id matches the saved checkpoint
    const checkpointPath = result.summary.checkpoint_path;
    const checkpointContent = await fs.readFile(checkpointPath, 'utf-8');
    const checkpoint = JSON.parse(checkpointContent);

    expect(checkpoint.checkpoint_id).toBe(result.summary.checkpoint_id);
  });

  it('should include CheckpointSaved in timeline', async () => {
    const result = await runFlow();

    const timelineNames = result.timeline.map((t) => t.name);
    expect(timelineNames).toContain('CheckpointSaved');

    // Verify CheckpointSaved comes after WorktreeMaterialized and before RunCompleted
    const checkpointIndex = timelineNames.indexOf('CheckpointSaved');
    const materializeIndex = timelineNames.indexOf('WorktreeMaterialized');
    const completedIndex = timelineNames.indexOf('RunCompleted');

    expect(checkpointIndex).toBeGreaterThan(materializeIndex);
    expect(checkpointIndex).toBeLessThan(completedIndex);

    // Verify CheckpointSaved event has details
    const checkpointEvent = result.timeline.find((t) => t.name === 'CheckpointSaved');
    expect(checkpointEvent).toBeDefined();
    expect(checkpointEvent!.id).toBe(result.summary.checkpoint_id);
  });

  it('should include required checkpoint fields', async () => {
    const result = await runFlow();

    const checkpointPath = `.newide/runs/${result.run_id}/checkpoint.json`;
    const checkpointContent = await fs.readFile(checkpointPath, 'utf-8');
    const checkpoint = JSON.parse(checkpointContent);

    // Verify required fields from Commit 6 spec
    expect(checkpoint.task_id).toBe(result.task_id);
    expect(checkpoint.mechanical_snapshot).toBeDefined();
    expect(checkpoint.mechanical_snapshot.worktree_path).toBe(
      result.materialization_result.worktree_path,
    );
    expect(checkpoint.mechanical_snapshot.modified_files).toEqual(
      result.materialization_result.files_written,
    );
    expect(checkpoint.artifact_refs).toContain(result.driver_result.transcript_ref.artifact_id);
    expect(checkpoint.semantic_handoff).toBeDefined();
    expect(checkpoint.semantic_handoff.done).toContain('worktree materialized');
    expect(checkpoint.runtime_state).toBeDefined();
    expect(checkpoint.runtime_state.resume_cursor).toBe('worktree.materialized');
  });

  it('should mark flow as failed when driver fails', async () => {
    // Create a mock driver that fails
    class FailingMockDriver implements DriverRuntimeHandle {
      readonly driver_id = 'mock-failing-driver';
      readonly session_id = 'failing-session';
      readonly capabilities = {
        supports_acp_extension: false,
        supports_structured_output: false,
        supports_session_load: false,
        supports_tool_events: false,
        supports_permission_events: false,
      };

      async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
        return {
          driver_run_result_id: createId('driver_result'),
          session_id: this.session_id,
          status: 'failed',
          artifacts: [],
          transcript_ref: {
            artifact_id: createId('artifact'),
            type: 'transcript',
            uri: 'artifact://transcript/failing',
            sha256: 'mock-sha256',
            producer_id: this.driver_id,
            task_id: input.task_id,
            created_at: new Date().toISOString(),
            schema_version: SCHEMA_VERSION,
          },
          tool_events: [],
          diagnostics: {
            driver_id: this.driver_id,
            duration_ms: 100,
            notes: ['Driver failed intentionally'],
          },
          error: {
            code: 'MOCK_DRIVER_FAILED',
            message: 'Driver failed intentionally',
            retryable: false,
          },
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        };
      }

      async collectTranscript(taskId = 'task'): Promise<ArtifactRef> {
        return {
          artifact_id: createId('artifact'),
          type: 'transcript',
          uri: 'artifact://transcript/failing',
          sha256: 'mock-sha256',
          producer_id: this.driver_id,
          task_id: taskId,
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        };
      }

      async interrupt(_reason: string): Promise<void> {}

      async close(): Promise<void> {}
    }

    const result = await runFlow({
      driver: new FailingMockDriver(),
    });

    // Verify run failed
    expect(result.summary.status).toBe('failed');
    expect(result.frontend_snapshot.task.status).toBe('failed');
    expect(result.frontend_snapshot.current.task_status).toBe('failed');

    // Verify timeline has RunFailed instead of RunCompleted
    const timelineNames = result.timeline.map((t) => t.name);
    expect(timelineNames).toContain('RunFailed');
    expect(timelineNames).not.toContain('RunCompleted');

    // Verify checkpoint is still valid (checkpoint structure is valid, task failed)
    const checkpointPath = `.newide/runs/${result.run_id}/checkpoint.json`;
    const checkpointContent = await fs.readFile(checkpointPath, 'utf-8');
    const checkpoint = JSON.parse(checkpointContent);

    expect(checkpoint.validity_status).toBe('valid');
    expect(checkpoint.semantic_handoff.done).not.toContain('driver completed');
    expect(checkpoint.semantic_handoff.blocked_on).toContain('driver execution failed');

    const resultPath = `.newide/runs/${result.run_id}/result.json`;
    const manifest = JSON.parse(await fs.readFile(resultPath, 'utf-8'));
    expect(manifest.status).toBe('failed');
    expect(result.result_manifest.status).toBe('failed');
  });

  it('preserves real workspace changes when Agent execution fails after writing files', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-workspace-'));
    createdWorkspaceDirs.add(workspacePath);
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input) {
        await fs.writeFile(path.join(workspacePath, 'index.html'), '<main>Tetris</main>');
        await fs.writeFile(path.join(workspacePath, 'style.css'), 'main { display: grid; }');
        return {
          agent_run_id: 'agent_run_transport_failed_after_write',
          agent_id: input.role_id,
          role_id: input.role_id,
          context_pack_ref: 'context_pack_transport_failed_after_write',
          driver_run_result_id: 'driver_result_transport_failed_after_write',
          artifact_refs: [],
          transcript_ref: createArtifact('transcript_transport_failed_after_write', 'transcript'),
          session_id: 'session_transport_failed_after_write',
          response: '',
          tool_events: [],
          diagnostics: {
            driver_id: 'external-driver',
            duration_ms: 222_000,
            driver_error_code: 'EXTERNAL_DRIVER_TRANSPORT_ERROR',
          },
          status: 'failed',
          memory_buffer_ref: 'memory_buffer_transport_failed_after_write',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        };
      },
    };

    const result = await runFlow({ agentExecutionFacade, workspacePath });

    expect(result.summary).toMatchObject({
      status: 'failed',
      outcome: 'failed',
      changed_files: ['index.html', 'style.css'],
      failure: { code: 'DRIVER_FAILED' },
    });
    expect(result.materialization_result.changed_files).toEqual([]);
    expect(result.frontend_snapshot.delivery_report.changed_files).toEqual([
      'index.html',
      'style.css',
    ]);
    expect(result.result_manifest.changed_files).toEqual(['index.html', 'style.css']);
  });

  it('should use real mailbox send/ack mechanism', async () => {
    const result = await runFlow();

    // Verify mailbox fields exist in summary
    expect(result.summary.mailbox_message_refs).toBeInstanceOf(Array);
    expect(result.summary.mailbox_message_refs.length).toBe(3);
    expect(result.summary.mailbox_thread_id).toBe(result.run_id);

    // Verify timeline contains mailbox events
    const timelineNames = result.timeline.map((t) => t.name);
    expect(timelineNames).toContain('MailboxMessageSent (task.assigned)');
    expect(timelineNames).toContain('MailboxMessageSent (driver.requested)');
    expect(timelineNames).toContain('MailboxMessageSent (driver.completed)');
    expect(timelineNames).toContain('MailboxMessageAcked (driver.requested)');

    // Verify mailbox events appear in correct order
    const taskAssignedIndex = timelineNames.indexOf('MailboxMessageSent (task.assigned)');
    const driverRequestedIndex = timelineNames.indexOf('MailboxMessageSent (driver.requested)');
    const driverCompletedIndex = timelineNames.indexOf('MailboxMessageSent (driver.completed)');
    const driverAckedIndex = timelineNames.indexOf('MailboxMessageAcked (driver.requested)');

    expect(taskAssignedIndex).toBeGreaterThanOrEqual(0);
    expect(driverRequestedIndex).toBeGreaterThan(taskAssignedIndex);
    expect(driverCompletedIndex).toBeGreaterThan(driverRequestedIndex);
    expect(driverAckedIndex).toBeGreaterThan(driverRequestedIndex);
  });

  async function runFlow(options?: IntegrationV0Options): Promise<IntegrationV0Result> {
    const result = await runIntegrationV0Flow(options);
    createdRunDirs.add(`.newide/runs/${result.run_id}`);
    createdWorktreeDirs.add(result.materialization_result.worktree_path);
    return result;
  }
});

function fakeHookEngine(decision: 'deny' | 'allow'): { handleEvent: () => Promise<HookResult> } {
  return {
    handleEvent: async () => ({
      hook_point: 'task.completed',
      matched: true,
      gate_requests: [],
      gate_results: [
        {
          gate_result_id: createId('gate_result'),
          gate_id: decision === 'deny' ? 'deny-gate' : 'allow-gate',
          gate_point: 'task.completed',
          request_id: createId('gate_request'),
          subject_id: 'task_under_review',
          decision,
          reason: decision === 'deny' ? 'policy rejected the artifact' : 'allowed',
          required_actions: decision === 'deny' ? ['fix-policy'] : [],
          target_state: decision === 'deny' ? 'blocked' : 'allowed',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        },
      ],
      final_decision: decision,
      created_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
    }),
  };
}

function gateHookResult(hookPoint: string, decision: 'deny' | 'allow', suffix: string): HookResult {
  return {
    hook_point: hookPoint,
    matched: true,
    gate_requests: [],
    gate_results: [
      {
        gate_result_id: `gate_result_${suffix}`,
        gate_id: `${decision}-gate`,
        gate_point: hookPoint,
        request_id: `gate_request_${suffix}`,
        subject_id: 'task_under_review',
        decision,
        reason: `${decision} at ${hookPoint}`,
        required_actions: decision === 'deny' ? ['fix-policy'] : [],
        target_state: decision === 'deny' ? 'blocked' : 'allowed',
        created_at: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
      },
    ],
    final_decision: decision,
    created_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
  };
}

function fakeMaterializer(
  status: MaterializationResult['status'],
  failures: MaterializationResult['failures'],
): { materialize: (input: MaterializationInput) => Promise<MaterializationResult> } {
  return {
    materialize: async (input) => ({
      materialization_id: createId('materialization'),
      task_id: input.task_id,
      worktree_path: '.newide/worktrees/fake',
      materialized_artifacts: status === 'failed' ? [] : input.artifacts,
      files_written: status === 'failed' ? [] : ['partial.ts'],
      changed_files: status === 'failed' ? [] : ['partial.ts'],
      status,
      failures,
      created_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
    }),
  };
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8'));
}

function createArtifact(artifactId: string, type: ArtifactRef['type'] = 'patch'): ArtifactRef {
  return {
    artifact_id: artifactId,
    type,
    uri: `artifact://${type}/${artifactId}`,
    producer_id: 'agent-driver',
    task_id: 'task_001',
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function successfulAgentFacade(requests: AgentExecutionRequest[]): AgentExecutionFacade {
  return {
    async runAgent(input) {
      requests.push(input);
      return {
        agent_run_id: 'agent_run_market_winner',
        agent_id: input.role_id,
        role_id: input.role_id,
        context_pack_ref: 'context_pack_market_winner',
        driver_run_result_id: 'driver_result_market_winner',
        artifact_refs: [createArtifact('artifact_market_winner')],
        transcript_ref: createArtifact('transcript_market_winner', 'transcript'),
        session_id: 'session_market_winner',
        response: 'Market winner completed the task.',
        tool_events: [],
        diagnostics: { driver_id: 'agent-driver', duration_ms: 10 },
        status: 'completed',
        memory_buffer_ref: 'buffer_market_winner',
        created_at: '2026-07-18T00:00:00.000Z',
        schema_version: SCHEMA_VERSION,
      };
    },
  };
}

function marketCandidate(agentId: string): AgentProjection {
  return {
    agent_id: agentId,
    persona_ref: `persona://${agentId}/v1`,
    persona_keywords: ['backend', 'typescript'],
    skills: [{ name: 'Backend delivery', tags: ['backend', 'typescript'] }],
    experiences: [
      {
        name: 'Backend delivery',
        type: 'positive',
        confidence: 0.9,
        tags: ['backend'],
      },
    ],
    metrics_ref: {
      total_tasks: 10,
      tasks_completed: 10,
      tasks_succeeded: 9,
      skill_count: 1,
      experience_count: 1,
      avg_confidence: 0.9,
    },
    load_state: { active_task_count: 0, days_since_last_task: 1 },
  };
}
