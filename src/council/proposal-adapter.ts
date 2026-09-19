import { SCHEMA_VERSION, createId, nowTimestamp, type RunId, type TaskId } from '../core';
import type { DriverRunResult } from '../driver';
import {
  normalizeDriverReturn,
  parseDriverReturnFromTranscript,
} from '../driver/driver-return-converter';
import type { GateResult } from '../gate';
import type { Proposal } from './contract';

export interface BuildCouncilProposalFromDriverResultInput {
  run_id: RunId;
  task_id: TaskId;
  driver_result: DriverRunResult;
  gate_results: GateResult[];
}

/**
 * 将 driver 产物转换为 Council 可评审的最小 Proposal。
 * 这里只做数据适配，不做 proposal 质量判断或 LLM 提取。
 */
export function buildCouncilProposalFromDriverResult(
  input: BuildCouncilProposalFromDriverResultInput,
): Proposal {
  return {
    proposal_id: createId('proposal'),
    run_id: input.run_id,
    task_id: input.task_id,
    agent_id: input.driver_result.diagnostics.driver_id,
    artifact_refs: input.driver_result.artifacts.map((artifact) => artifact.artifact_id),
    ...proposalReportFields(
      input.driver_result.response,
      input.driver_result.diagnostics.driver_report,
    ),
    affected_paths: input.driver_result.artifacts.flatMap((artifact) =>
      artifact.content?.target_path ? [artifact.content.target_path] : [],
    ),
    completion_evidence: input.gate_results.map((gate) => gate.gate_result_id),
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

/** Map existing report evidence without another model call. */
export function proposalReportFields(
  response: string | undefined,
  reportValue?: unknown,
): Pick<Proposal, 'summary' | 'claims' | 'assumptions' | 'known_risks'> {
  const report =
    (reportValue ? normalizeDriverReturn(reportValue) : null) ??
    parseDriverReturnFromTranscript(response ?? '');
  return {
    summary:
      report?.summary.trim() || response?.trim() || 'Driver output artifacts for council review',
    claims: (report?.decisions ?? []).map((decision) => ({
      claim_id: createId('claim'),
      type: 'design_decision',
      statement: [decision.point, decision.chosen, decision.reason].filter(Boolean).join(': '),
      evidence_refs: [],
    })),
    assumptions: (report?.assumptions ?? []).map((item) => item.assumption),
    known_risks: [
      ...(report?.assumptions ?? []).map((item) => item.risk_if_wrong).filter(Boolean),
      ...(report?.blockers ?? []).filter((item) => !item.resolved).map((item) => item.blocker),
    ],
  };
}
