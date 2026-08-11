import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, nowTimestamp, type ArtifactRef } from '../../src/core';
import { completionCriterionId } from '../../src/coordinator/completion-criteria-evaluator';
import { createProductionStageExecutors } from '../../src/app/production-stage-executors';

describe('production stage executors', () => {
  it('executes the selected final Council Plan through the original primary Session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-plan-first-stages-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const primaryPlan = fileArtifact('artifact_primary_plan', 'council-plan.md', '# Primary plan');
    const finalPlan = fileArtifact('artifact_final_plan', 'final-plan.md', '# Final plan');
    const implementation = fileArtifact('artifact_implementation', 'src/result.ts', 'export {};');
    const requests: Array<{ role_id: string; session_id?: string; workspace_path?: string; context_policy: string; input_artifact_refs: string[] }> = [];
    let executionCount = 0;
    const councilProvider = {
      strategyName: 'plan_first',
      async runCouncilRound() {
        return {
          council_run_id: 'council_run_1',
          run_id: 'run_plan',
          task_id: 'task_plan',
          proposals: [],
          reviews: [],
          synthesis: {
            synthesis_id: 'synthesis_1',
            run_id: 'run_plan',
            task_id: 'task_plan',
            synthesizer_id: 'role_architect',
            input_proposal_ids: [],
            input_review_ids: [],
            artifact_refs: [finalPlan.artifact_id],
            summary: 'final plan',
            created_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          },
          decision: {
            decision_id: 'decision_1',
            run_id: 'run_plan',
            task_id: 'task_plan',
            decision_mode: 'advisory' as const,
            selected_artifact_refs: [finalPlan.artifact_id],
            verdict: 'select' as const,
            reason: 'selected final plan',
            evidence_refs: ['synthesis_1'],
            can_create_merge_authorization: false,
            created_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          },
          generated_artifact_refs: [finalPlan],
          selected_artifact_refs: [finalPlan.artifact_id],
          created_at: nowTimestamp(),
          schema_version: SCHEMA_VERSION,
        };
      },
    };
    const executors = createProductionStageExecutors({
      selectAgentHandler: {
        execute: async (input) => ({
          winner_agent_id: 'role_primary',
          winner_bid_id: 'bid_plan',
          ledger_ref: 'file:///market/ledger.json',
          audit_ref: 'file:///market/audit.json',
          ledger: {
            ledger_id: 'ledger_plan',
            task_id: input.task_id,
            seed: input.seed,
            policy_version: 'market-v0',
            bids: [],
            winner_bid_id: 'bid_plan',
            winner_agent_id: 'role_primary',
            created_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          },
          audit: {
            audit_id: 'audit_plan',
            task_id: input.task_id,
            winner_agent_id: 'role_primary',
            winner_bid_id: 'bid_plan',
            entries: [],
            created_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          },
          market_task: {
            task_id: input.task_id,
            task_description: input.task_description,
            requirement_profile: {
              persona_keywords: [],
              preferred_skill_tags: [],
              preferred_experience_tags: [],
            },
            context: { urgency: 0.5, exploration_level: 0.3 },
          },
        }),
      },
      agentExecutionFacade: {
        async runAgent(input) {
          requests.push(input);
          executionCount += 1;
          const artifact = executionCount === 1 ? primaryPlan : implementation;
          return {
            agent_run_id: `agent_run_${String(executionCount)}`,
            agent_id: 'role_primary',
            role_id: 'role_primary',
            context_pack_ref: `context_pack_${String(executionCount)}`,
            driver_run_result_id: `driver_result_${String(executionCount)}`,
            artifact_refs: [artifact],
            transcript_ref: transcriptArtifact(`transcript_${String(executionCount)}`),
            session_id: 'session_primary',
            response: executionCount === 1 ? 'plan ready' : 'implementation complete',
            tool_events: [],
            diagnostics: { driver_id: 'acp-external' },
            status: 'completed',
            created_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          };
        },
      },
      councilProvider,
      gateExecutor: { execute: async () => ({ hook_point: 'task.completed', matched: false, gate_results: [] }) },
      bootstrapAgentIds: ['role_primary'],
      runsRoot: path.join(root, 'runs'),
      councilRoot: path.join(root, 'council'),
      worktreesRoot: path.join(root, 'worktrees'),
    });
    const common = {
      task_id: 'task_plan',
      run_id: 'run_plan',
      mode: 'council' as const,
      task_request: { spec: 'implement result.ts', completion_criteria: [] },
      workspace_path: workspace,
    };

    const executed = await executors.execute_agent.execute({
      ...common,
      cursor_input: { cursor: 'execute_agent', winner_agent_id: 'role_primary' },
    });
    const council = await executors.council.execute({
      ...common,
      session_id: executed.session_id,
      cursor_input: {
        cursor: 'council',
        trigger: 'explicit_mode',
        candidate_manifest_ref: executed.changeset_ref,
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      role_id: 'role_primary',
      context_policy: 'council_primary_plan',
    });
    expect(requests[0]?.instruction).toContain('council-plan.md');
    expect(requests[1]).toMatchObject({
      role_id: 'role_primary',
      session_id: 'session_primary',
      context_policy: 'council_plan_execution',
      input_artifact_refs: [finalPlan.artifact_id],
      workspace_path: requests[0]?.workspace_path,
    });
    expect(council.artifact_refs).toEqual([implementation.artifact_id]);
    const state = JSON.parse(
      await readFile(path.join(root, 'runs', 'run_plan', 'production-stage-state.json'), 'utf8'),
    ) as { selection: { council_run_result: { plan_execution: unknown; selected_artifact_refs: string[] } } };
    expect(state.selection.council_run_result.plan_execution).toMatchObject({
      executor_role_id: 'role_primary',
      session_id: 'session_primary',
      final_plan_artifact_refs: [finalPlan.artifact_id],
      implementation_artifact_refs: [implementation.artifact_id],
    });
    expect(state.selection.council_run_result.selected_artifact_refs).toEqual([
      implementation.artifact_id,
    ]);
  });

  it('connects real selection, Agent, Gate, manifest and idempotent Deliver boundaries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-production-stages-'));
    const workspace = path.join(root, 'workspace');
    const criterion = 'output.txt is delivered';
    const artifact: ArtifactRef = {
      artifact_id: 'artifact_output',
      type: 'file',
      producer_id: 'role_ts_engineer',
      content: {
        kind: 'text',
        content_ref: 'data:text/plain;charset=utf-8,production%20output',
        target_path: 'output.txt',
      },
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
    const executors = createProductionStageExecutors({
      selectAgentHandler: {
        execute: async (input) => ({
          winner_agent_id: 'role_ts_engineer',
          winner_bid_id: 'bid_1',
          ledger_ref: 'file:///market/ledger.json',
          audit_ref: 'file:///market/audit.json',
          ledger: {
            ledger_id: 'ledger_1',
            task_id: input.task_id,
            seed: input.seed,
            policy_version: 'market-v0',
            bids: [],
            winner_bid_id: 'bid_1',
            winner_agent_id: 'role_ts_engineer',
            created_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          },
          audit: {
            audit_id: 'audit_1',
            task_id: input.task_id,
            winner_agent_id: 'role_ts_engineer',
            winner_bid_id: 'bid_1',
            entries: [],
            created_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          },
          market_task: {
            task_id: input.task_id,
            task_description: input.task_description,
            requirement_profile: {
              persona_keywords: [],
              preferred_skill_tags: [],
              preferred_experience_tags: [],
            },
            context: { urgency: 0.5, exploration_level: 0.3 },
          },
        }),
      },
      agentExecutionFacade: {
        runAgent: async () => ({
          agent_run_id: 'agent_run_1',
          agent_id: 'role_ts_engineer',
          role_id: 'role_ts_engineer',
          context_pack_ref: 'context_pack_1',
          driver_run_result_id: 'driver_result_1',
          artifact_refs: [artifact],
          transcript_ref: {
            artifact_id: 'transcript_1',
            type: 'transcript',
            producer_id: 'role_ts_engineer',
            created_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          },
          session_id: 'session_1',
          response: 'done',
          tool_events: [],
          diagnostics: { driver_id: 'acp-external' },
          status: 'completed',
          created_at: nowTimestamp(),
          schema_version: SCHEMA_VERSION,
        }),
      },
      councilProvider: {
        runCouncilRound: async () => {
          throw new Error('Council is not expected in single-agent mode');
        },
      },
      gateExecutor: {
        execute: async (_input) => ({
          hook_point: 'task.completed',
          matched: true,
          gate_results: [
            {
              gate_result_id: 'gate_result_1',
              gate_id: 'acceptance',
              gate_point: 'task.completed',
              request_id: 'gate_request_1',
              subject_id: completionCriterionId(criterion, 0),
              subject_type: 'completion_criterion',
              decision: 'allow',
              reason: 'verified',
              required_actions: [],
              audit_ref: path.join(root, 'gate-audit.json'),
              target_state: 'reviewing',
              created_at: nowTimestamp(),
              schema_version: SCHEMA_VERSION,
            },
          ],
        }),
      },
      bootstrapAgentIds: ['role_ts_engineer'],
      runsRoot: path.join(root, 'runs'),
      councilRoot: path.join(root, 'council'),
      worktreesRoot: path.join(root, 'worktrees'),
    });
    const taskRequest = {
      spec: 'create output.txt',
      completion_criteria: [criterion],
    };
    const common = {
      task_id: 'task_1',
      run_id: 'run_1',
      mode: 'single_agent' as const,
      task_request: taskRequest,
      workspace_path: workspace,
    };

    const selected = await executors.select_agent.execute({
      ...common,
      cursor_input: { cursor: 'select_agent', seed: 'run_1', candidate_ids: [] },
    });
    const executed = await executors.execute_agent.execute({
      ...common,
      cursor_input: { cursor: 'execute_agent', winner_agent_id: selected.winner_agent_id },
    });
    const gated = await executors.gate.execute({
      ...common,
      cursor_input: {
        cursor: 'gate',
        subject_ref: executed.changeset_ref,
        phase: 'post_primary',
        changeset_ref: executed.changeset_ref,
        expected_sha256: executed.expected_sha256,
      },
    });
    expect(gated.status).toBe('allowed');
    // Gate resolves selection.manifest_ref (file URL) back to a native path.
    // On Windows, URL.pathname("/D:/...") must not become "D:\D:\...".
    const manifestPath = path.join(root, 'runs', 'run_1', 'changeset-manifest.json');
    await access(manifestPath);
    expect(pathToFileURL(manifestPath).href).toBe(executed.changeset_ref);
    const delivered = await executors.deliver.execute({
      ...common,
      cursor_input: {
        cursor: 'deliver',
        changeset_ref: executed.changeset_ref,
        expected_sha256: executed.expected_sha256,
      },
    });
    const replayed = await executors.deliver.execute({
      ...common,
      cursor_input: {
        cursor: 'deliver',
        changeset_ref: executed.changeset_ref,
        expected_sha256: executed.expected_sha256,
      },
    });

    expect(await readFile(path.join(workspace, 'output.txt'), 'utf8')).toBe(
      'production output',
    );
    expect(delivered.final_output).toEqual(replayed.final_output);
    expect(delivered.evidence).toMatchObject({
      idempotency_key: expect.stringMatching(/^deliver:/),
      run_outcome: { status: 'verified' },
    });
  });
});

function fileArtifact(artifactId: string, targetPath: string, content: string): ArtifactRef {
  return {
    artifact_id: artifactId,
    type: 'file',
    producer_id: 'role_primary',
    content: {
      kind: 'text',
      content_ref: `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`,
      target_path: targetPath,
    },
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function transcriptArtifact(artifactId: string): ArtifactRef {
  return {
    artifact_id: artifactId,
    type: 'transcript',
    producer_id: 'role_primary',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}
