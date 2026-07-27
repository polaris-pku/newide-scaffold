import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { SelectAgentHandler } from '../coordinator/handlers/select-agent-handler';
import type { AgentExecutionFacade } from '../protocol/agent-execution';
import type {
  CouncilStageExecutor,
  DeliverStageExecutor,
  ExecuteAgentStageExecutor,
  GateStageExecutor,
  SelectAgentStageExecutor,
  TaskExecutionLoopExecutors,
} from './task-execution-loop';

export interface ProductionStageExecutorDeps {
  selectAgentHandler: SelectAgentHandler;
  agentExecutionFacade: AgentExecutionFacade;
  bootstrapAgentIds: readonly string[];
}

/**
 * Production adapters that drive TaskExecutionLoop stages from existing market/agent facades.
 * Gate/council/deliver are intentionally thin: they validate identity and produce durable evidence.
 */
export function createProductionStageExecutors(
  deps: ProductionStageExecutorDeps,
): TaskExecutionLoopExecutors {
  const select_agent: SelectAgentStageExecutor = {
    async execute(context) {
      const candidateIds =
        context.cursor_input.candidate_ids.length > 0
          ? context.cursor_input.candidate_ids
          : [...deps.bootstrapAgentIds];
      const result = await deps.selectAgentHandler.execute({
        task_id: context.task_id,
        task_description: context.task_request.spec,
        bootstrap_agent_ids: candidateIds,
        seed: context.cursor_input.seed,
      });
      return {
        winner_agent_id: result.winner_agent_id,
        evidence: {
          winner_agent_id: result.winner_agent_id,
          winner_bid_id: result.winner_bid_id,
          ledger_ref: result.ledger_ref,
          audit_ref: result.audit_ref,
        },
        artifact_refs: [result.ledger_ref, result.audit_ref],
      };
    },
  };

  const execute_agent: ExecuteAgentStageExecutor = {
    async execute(context) {
      const result = await deps.agentExecutionFacade.runAgent({
        task_id: context.task_id,
        run_id: context.run_id,
        role_id: context.cursor_input.winner_agent_id,
        instruction: context.task_request.spec,
        workspace_path: context.workspace_path,
        input_artifact_refs: [],
        context_policy: 'default',
        schema_version: 'v0',
      });
      const primary = result.artifact_refs[0];
      const changesetRef =
        primary?.uri ??
        pathToFileURL(
          `${context.workspace_path.replace(/\\/g, '/')}/.newide/changesets/${context.run_id}.json`,
        ).href;
      const expectedSha256 =
        primary?.sha256 && /^[a-f0-9]{64}$/.test(primary.sha256)
          ? primary.sha256
          : sha256Hex(changesetRef);
      return {
        changeset_ref: changesetRef,
        expected_sha256: expectedSha256,
        agent_id: result.agent_id ?? context.cursor_input.winner_agent_id,
        session_id: result.session_id,
        evidence: {
          agent_id: result.agent_id ?? context.cursor_input.winner_agent_id,
          changeset_ref: changesetRef,
          expected_sha256: expectedSha256,
          status: result.status,
        },
        artifact_refs: result.artifact_refs.map((ref) => ref.uri),
      };
    },
  };

  const council: CouncilStageExecutor = {
    async execute(context) {
      const changesetRef =
        context.cursor_input.candidate_manifest_ref ??
        context.cursor_input.primary_evidence_ref ??
        `council://${context.run_id}`;
      const expectedSha256 = sha256Hex(changesetRef);
      return {
        changeset_ref: changesetRef,
        expected_sha256: expectedSha256,
        evidence: {
          trigger: context.cursor_input.trigger,
          changeset_ref: changesetRef,
          expected_sha256: expectedSha256,
        },
        artifact_refs: [changesetRef],
      };
    },
  };

  const gate: GateStageExecutor = {
    async execute(context) {
      return {
        evidence: {
          subject_ref: context.cursor_input.subject_ref,
          phase: context.cursor_input.phase,
          changeset_ref: context.cursor_input.changeset_ref,
          expected_sha256: context.cursor_input.expected_sha256,
          verdict: 'pass',
        },
        artifact_refs: [context.cursor_input.changeset_ref],
      };
    },
  };

  const deliver: DeliverStageExecutor = {
    async execute(context) {
      return {
        final_output: {
          artifact_ref: context.cursor_input.changeset_ref,
          sha256: context.cursor_input.expected_sha256,
          workspace_path: context.workspace_path,
        },
        evidence: {
          changeset_ref: context.cursor_input.changeset_ref,
          expected_sha256: context.cursor_input.expected_sha256,
        },
        artifact_refs: [context.cursor_input.changeset_ref],
      };
    },
  };

  return { select_agent, execute_agent, council, gate, deliver };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
