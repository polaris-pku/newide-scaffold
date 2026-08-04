import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  nowTimestamp,
  type ArtifactRef,
  type Event,
} from '../../src/core';
import { completionCriterionId } from '../../src/coordinator/completion-criteria-evaluator';
import { createProductionStageExecutors } from '../../src/app/production-stage-executors';
import type { AgentExecutionRequest } from '../../src/protocol/agent-execution';

describe('production stage executors', () => {
  it('connects real selection, Agent, Gate, manifest and idempotent Deliver boundaries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-production-stages-'));
    const workspace = path.join(root, 'workspace');
    const criterion = 'output.txt is delivered';
    let receivedAgentRequest: AgentExecutionRequest | undefined;
    const emittedEvents: Event[] = [];
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
        runAgent: async (request) => {
          receivedAgentRequest = request;
          return {
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
          };
        },
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
      memory_ablation: 'B0' as const,
      on_event: (event: Event) => emittedEvents.push(event),
    };

    const selected = await executors.select_agent.execute({
      ...common,
      cursor_input: { cursor: 'select_agent', seed: 'run_1', candidate_ids: [] },
    });
    const executed = await executors.execute_agent.execute({
      ...common,
      cursor_input: { cursor: 'execute_agent', winner_agent_id: selected.winner_agent_id },
    });
    expect(receivedAgentRequest).toMatchObject({ memory_ablation: 'B0' });
    expect(
      emittedEvents.find((event) => event.event_type === 'memory.context_pack_built')?.payload,
    ).toMatchObject({ ablation: 'B0' });
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
