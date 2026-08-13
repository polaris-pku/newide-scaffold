import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, nowTimestamp, type ArtifactRef } from '../../src/core';
import { completionCriterionId } from '../../src/coordinator/completion-criteria-evaluator';
import { createProductionStageExecutors } from '../../src/app/production-stage-executors';
import {
  AgentBoardCouncilParticipantResolver,
  createCouncilStrategyProvider,
  SynthesisAgentCouncilProvider,
} from '../../src/council';
import type { AgentExecutionRequest, AgentExecutionResult } from '../../src/protocol/agent-execution';
import type { AgentBoardListItem, AgentBoardQuery } from '../../src/memory';

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

  it('enables plan_first end to end: fixed seats propose, synthesize a plan, primary implements it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-plan-first-e2e-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const councilRoot = path.join(root, 'council');
    const requests: AgentExecutionRequest[] = [];
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input) {
        requests.push(input);
        return planFirstScriptedResponse(input);
      },
    };
    const resolver = new AgentBoardCouncilParticipantResolver({
      boardQuery: boardQuery([
        boardAgent('role_primary'),
        boardAgent('role_deputy'),
        boardAgent('role_reviewer'),
        boardAgent('role_synthesizer'),
      ]),
      allowedAgentIds: ['role_primary', 'role_deputy', 'role_reviewer', 'role_synthesizer'],
      seatAssignments: {
        proposer0: 'role_primary',
        proposer1: 'role_deputy',
        reviewer: 'role_reviewer',
        synthesizer: 'role_synthesizer',
      },
    });
    const councilProvider = createCouncilStrategyProvider(
      new SynthesisAgentCouncilProvider({
        agentExecutionFacade,
        councilRoot,
        participantResolver: resolver,
      }),
      'plan_first',
    );
    const executors = createProductionStageExecutors({
      selectAgentHandler: {
        execute: async (input) => ({
          winner_agent_id: 'role_primary',
          winner_bid_id: 'bid_e2e',
          ledger_ref: 'file:///market/ledger.json',
          audit_ref: 'file:///market/audit.json',
          ledger: {
            ledger_id: 'ledger_e2e',
            task_id: input.task_id,
            seed: input.seed,
            policy_version: 'market-v0',
            bids: [],
            winner_bid_id: 'bid_e2e',
            winner_agent_id: 'role_primary',
            created_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          },
          audit: {
            audit_id: 'audit_e2e',
            task_id: input.task_id,
            winner_agent_id: 'role_primary',
            winner_bid_id: 'bid_e2e',
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
      agentExecutionFacade,
      councilProvider,
      gateExecutor: { execute: async () => ({ hook_point: 'task.completed', matched: false, gate_results: [] }) },
      bootstrapAgentIds: ['role_primary', 'role_deputy', 'role_reviewer', 'role_synthesizer'],
      auctionEnabled: false,
      primaryAgentId: 'role_primary',
      runsRoot: path.join(root, 'runs'),
      councilRoot,
      worktreesRoot: path.join(root, 'worktrees'),
    });
    const common = {
      task_id: 'task_plan_e2e',
      run_id: 'run_plan_e2e',
      mode: 'council' as const,
      task_request: { spec: 'implement result.ts', completion_criteria: [] },
      workspace_path: workspace,
    };

    const selected = await executors.select_agent.execute({
      ...common,
      cursor_input: { cursor: 'select_agent', seed: 'run_plan_e2e', candidate_ids: [] },
    });
    const executed = await executors.execute_agent.execute({
      ...common,
      cursor_input: { cursor: 'execute_agent', winner_agent_id: selected.winner_agent_id },
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

    // Plan mode is enabled: primary first writes a Plan artifact, then implements it.
    expect(requests[0]).toMatchObject({
      role_id: 'role_primary',
      context_policy: 'council_primary_plan',
    });
    expect(requests[0]?.instruction).toContain('council-plan.md');
    // Council produced the fixed seats and concrete Plan artifacts.
    const state = JSON.parse(
      await readFile(path.join(root, 'runs', 'run_plan_e2e', 'production-stage-state.json'), 'utf8'),
    ) as {
      selection: {
        council_run_result: {
          participants: Array<{ seat: string; agent_id: string }>;
          proposals: Array<{ artifact_refs: string[] }>;
          synthesis?: { artifact_refs: string[] };
          plan_execution?: {
            executor_role_id: string;
            session_id: string;
            final_plan_artifact_refs: string[];
            implementation_artifact_refs: string[];
          };
          selected_artifact_refs: string[];
        };
      };
    };
    const councilResult = state.selection.council_run_result;
    expect(councilResult.participants.map(({ seat, agent_id }) => [seat, agent_id])).toEqual([
      ['proposer', 'role_primary'],
      ['proposer', 'role_deputy'],
      ['reviewer', 'role_reviewer'],
      ['synthesizer', 'role_synthesizer'],
    ]);
    expect(councilResult.proposals.length).toBeGreaterThanOrEqual(2);
    expect(councilResult.synthesis?.artifact_refs).toHaveLength(1);
    expect(requests.find((request) => request.context_policy === 'council_synthesizer')?.instruction)
      .toContain('final-plan.md');
    // The primary implemented the final Plan through its original Session.
    const implementation = requests.find(
      (request) => request.context_policy === 'council_plan_execution',
    );
    expect(implementation).toMatchObject({
      role_id: 'role_primary',
      session_id: 'session_primary',
      input_artifact_refs: councilResult.synthesis?.artifact_refs,
    });
    expect(council.artifact_refs).toEqual(['artifact_role_primary_council_plan_execution']);
    expect(councilResult.plan_execution).toMatchObject({
      executor_role_id: 'role_primary',
      session_id: 'session_primary',
      final_plan_artifact_refs: councilResult.synthesis?.artifact_refs,
      implementation_artifact_refs: councilResult.selected_artifact_refs,
    });
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

  it('pins the primary Agent as the sole candidate when the auction is disabled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-no-auction-stages-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const requestedCandidateIds: string[][] = [];
    const executors = createProductionStageExecutors({
      selectAgentHandler: {
        execute: async (input) => {
          requestedCandidateIds.push(input.bootstrap_agent_ids);
          return {
            winner_agent_id: input.bootstrap_agent_ids[0] ?? 'role_primary',
            winner_bid_id: 'bid_no_auction',
            ledger_ref: 'file:///market/ledger.json',
            audit_ref: 'file:///market/audit.json',
            ledger: {
              ledger_id: 'ledger_no_auction',
              task_id: input.task_id,
              seed: input.seed,
              policy_version: 'market-v0',
              bids: [],
              winner_bid_id: 'bid_no_auction',
              winner_agent_id: input.bootstrap_agent_ids[0] ?? 'role_primary',
              created_at: nowTimestamp(),
              schema_version: SCHEMA_VERSION,
            },
            audit: {
              audit_id: 'audit_no_auction',
              task_id: input.task_id,
              winner_agent_id: input.bootstrap_agent_ids[0] ?? 'role_primary',
              winner_bid_id: 'bid_no_auction',
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
          };
        },
      },
      agentExecutionFacade: {
        runAgent: async () => {
          throw new Error('Agent execution is not expected in this test');
        },
      },
      councilProvider: {
        runCouncilRound: async () => {
          throw new Error('Council is not expected in this test');
        },
      },
      gateExecutor: {
        execute: async () => ({ hook_point: 'task.completed', matched: false, gate_results: [] }),
      },
      bootstrapAgentIds: ['role_fullstack_engineer', 'role_ts_engineer'],
      auctionEnabled: false,
      primaryAgentId: 'role_primary',
      runsRoot: path.join(root, 'runs'),
      councilRoot: path.join(root, 'council'),
      worktreesRoot: path.join(root, 'worktrees'),
    });

    const selected = await executors.select_agent.execute({
      task_id: 'task_no_auction',
      run_id: 'run_no_auction',
      mode: 'council',
      task_request: { spec: 'implement', completion_criteria: [] },
      workspace_path: workspace,
      cursor_input: { cursor: 'select_agent', seed: 'run_no_auction', candidate_ids: [] },
    });

    expect(requestedCandidateIds).toEqual([['role_primary']]);
    expect(selected.winner_agent_id).toBe('role_primary');
  });

  it('rejects an auction-disabled select without a primaryAgentId', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-no-auction-missing-primary-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const executors = createProductionStageExecutors({
      selectAgentHandler: {
        execute: async (input) => ({
          winner_agent_id: input.bootstrap_agent_ids[0] ?? 'role_primary',
          winner_bid_id: 'bid',
          ledger_ref: 'file:///market/ledger.json',
          audit_ref: 'file:///market/audit.json',
          ledger: {
            ledger_id: 'ledger',
            task_id: input.task_id,
            seed: input.seed,
            policy_version: 'market-v0',
            bids: [],
            winner_bid_id: 'bid',
            winner_agent_id: input.bootstrap_agent_ids[0] ?? 'role_primary',
            created_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          },
          audit: {
            audit_id: 'audit',
            task_id: input.task_id,
            winner_agent_id: input.bootstrap_agent_ids[0] ?? 'role_primary',
            winner_bid_id: 'bid',
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
        runAgent: async () => {
          throw new Error('Agent execution is not expected in this test');
        },
      },
      councilProvider: {
        runCouncilRound: async () => {
          throw new Error('Council is not expected in this test');
        },
      },
      gateExecutor: {
        execute: async () => ({ hook_point: 'task.completed', matched: false, gate_results: [] }),
      },
      bootstrapAgentIds: ['role_fullstack_engineer'],
      auctionEnabled: false,
      runsRoot: path.join(root, 'runs'),
      councilRoot: path.join(root, 'council'),
      worktreesRoot: path.join(root, 'worktrees'),
    });

    await expect(
      executors.select_agent.execute({
        task_id: 'task_no_primary',
        run_id: 'run_no_primary',
        mode: 'council',
        task_request: { spec: 'implement', completion_criteria: [] },
        workspace_path: workspace,
        cursor_input: {
          cursor: 'select_agent',
          seed: 'run_no_primary',
          candidate_ids: [],
        },
      }),
    ).rejects.toThrow('no primaryAgentId');
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

function boardAgent(roleId: string): AgentBoardListItem {
  return {
    role_id: roleId,
    name: roleId,
    status: 'active',
    tags: ['market_eligible'],
    skill_count: 0,
    experience_count: 0,
    persona_summary: roleId,
  };
}

function boardQuery(agents: AgentBoardListItem[]): AgentBoardQuery {
  return {
    async listAgents() {
      return agents;
    },
    async getAgent() {
      throw new Error('not used');
    },
    async listSkills() {
      throw new Error('not used');
    },
    async listExperiences() {
      throw new Error('not used');
    },
  };
}

/**
 * Scripted plan_first facade: primary writes a Plan, council proposers write
 * Plans, reviewer returns structured reviews, synthesizer writes final-plan.md,
 * and primary's second run implements src/result.ts.
 */
function planFirstScriptedResponse(input: AgentExecutionRequest): AgentExecutionResult {
  const targetPath = planFirstTargetPath(input);
  const artifact: ArtifactRef = targetPath
    ? {
        artifact_id: `artifact_${input.role_id}_${input.context_policy}`,
        type: 'file',
        producer_id: input.role_id,
        content: {
          kind: 'text',
          content_ref: `data:text/plain;charset=utf-8,${encodeURIComponent(`output for ${input.role_id}\n`)}`,
          target_path: targetPath,
        },
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      }
    : {
        artifact_id: `artifact_${input.role_id}_${input.context_policy}`,
        type: 'patch',
        producer_id: input.role_id,
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      };
  const response =
    input.context_policy === 'council_reviewer'
      ? [
          'Reviews:',
          '```json',
          JSON.stringify({
            reviews: (input.instruction.match(/proposal_[a-z0-9-]+/g) ?? []).map(
              (proposalId) => ({
                proposal_id: proposalId,
                verdict: 'approve',
                reason: 'Plan is actionable.',
                unmet_criteria: [],
                evidence_refs: [],
              }),
            ),
          }),
          '```',
          '<<<DRIVER_RETURN>>>',
        ].join('\n')
      : `${input.role_id} completed`;
  return {
    agent_run_id: `agent_run_${input.role_id}_${input.context_policy}`,
    agent_id: input.role_id,
    role_id: input.role_id,
    context_pack_ref: `context_pack_${input.role_id}`,
    driver_run_result_id: `driver_result_${input.role_id}`,
    artifact_refs: [artifact],
    transcript_ref: transcriptArtifact(`transcript_${input.role_id}_${input.context_policy}`),
    session_id: input.session_id ?? 'session_primary',
    response,
    tool_events: [],
    diagnostics: { driver_id: 'acp-external' },
    status: 'completed',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function planFirstTargetPath(input: AgentExecutionRequest): string | undefined {
  if (input.context_policy === 'council_plan_execution') return 'src/result.ts';
  if (input.context_policy === 'council_primary_plan') return 'council-plan.md';
  if (input.council_seat === 'proposer') return 'council-plan.md';
  if (input.council_seat === 'reviewer') return undefined;
  if (input.council_seat === 'synthesizer') return 'final-plan.md';
  return undefined;
}
