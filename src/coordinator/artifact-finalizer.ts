import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type ArtifactRef,
  type RunId,
  type TaskId,
} from '../core';
import type { DriverRunResult } from '../driver';
import type { GateResult } from '../gate';
import {
  MockCouncil,
  type CouncilDecision,
  type CouncilResult,
  type CouncilLifecycleEvent,
  type CouncilProvider,
  type CouncilRunResult,
  type EvidencePack,
} from '../council';
import { buildCouncilProposalFromDriverResult } from '../council/proposal-adapter';
import type { AutonomousCouncilHandler } from './handlers/autonomous-council-handler';
import type { DriverStreamEventListener } from '../driver/contract';

export type SelectionMode = 'single_agent' | 'council';

export interface ArtifactSelectionResult {
  selection_id: string;
  run_id: RunId;
  task_id: TaskId;
  mode: SelectionMode;
  selected_artifacts: ArtifactRef[];
  reason: string;
  metadata: Record<string, unknown>;
  council_decision?: CouncilDecision;
  council_run_result?: CouncilRunResult;
  council_result?: CouncilResult;
  created_at: string;
  schema_version: string;
}

export interface ArtifactSelectionInput {
  run_id: RunId;
  task_id: TaskId;
  driver_result: DriverRunResult;
  gate_results: GateResult[];
  evidence_pack?: EvidencePack;
  question?: string;
  workspace_path?: string;
}

export interface ArtifactSelectionExecutionOptions {
  signal?: AbortSignal;
  onDriverEvent?: DriverStreamEventListener;
  onCouncilLifecycleEvent?: (event: CouncilLifecycleEvent) => void | Promise<void>;
}

export interface ArtifactSelectorOptions {
  mode: SelectionMode;
  councilProvider?: CouncilProvider;
  councilHandler?: AutonomousCouncilHandler;
}

/**
 * ArtifactSelector: Unified artifact selection for single-agent and council modes.
 *
 * - single_agent mode: directly selects the first artifact from driver result if gates allow
 * - council mode: delegates to CouncilProvider, currently also selects first artifact via MockCouncil
 *
 * Both modes return the same ArtifactSelectionResult structure.
 */
export class ArtifactSelector {
  private readonly options: ArtifactSelectorOptions;

  constructor(options: ArtifactSelectorOptions) {
    this.options = options;
  }

  async selectArtifacts(
    input: ArtifactSelectionInput,
    execution?: ArtifactSelectionExecutionOptions,
  ): Promise<ArtifactSelectionResult> {
    if (this.options.mode === 'single_agent') {
      return this.selectSingleAgent(input);
    } else {
      return this.selectViaCouncil(input, execution);
    }
  }

  private async selectSingleAgent(input: ArtifactSelectionInput): Promise<ArtifactSelectionResult> {
    const firstArtifact = input.driver_result.artifacts[0];
    const allGatesAllow = input.gate_results.every((g) => g.decision === 'allow');
    const succeeded = input.driver_result.status === 'succeeded';

    const selected =
      succeeded && allGatesAllow && firstArtifact !== undefined ? [firstArtifact] : [];

    return {
      selection_id: createId('selection'),
      run_id: input.run_id,
      task_id: input.task_id,
      mode: 'single_agent',
      selected_artifacts: selected,
      reason:
        selected.length > 0
          ? 'Single agent: direct selection of driver output after gate validation'
          : 'Single agent: no artifact selected (driver failed or gates blocked)',
      metadata: {
        driver_run_result_id: input.driver_result.driver_run_result_id,
        driver_status: input.driver_result.status,
        gates_passed: allGatesAllow,
      },
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  private async selectViaCouncil(
    input: ArtifactSelectionInput,
    execution?: ArtifactSelectionExecutionOptions,
  ): Promise<ArtifactSelectionResult> {
    if (!this.options.councilProvider) {
      throw new Error('councilProvider is required when mode is "council"');
    }

    if (!input.evidence_pack) {
      throw new Error('evidence_pack is required when mode is "council"');
    }

    const proposal = buildCouncilProposalFromDriverResult({
      run_id: input.run_id,
      task_id: input.task_id,
      driver_result: input.driver_result,
      gate_results: input.gate_results,
    });

    const councilRequest = {
        run_id: input.run_id,
        task_id: input.task_id,
        trigger: 'user_choice' as const,
        decision_mode: 'advisory' as const,
        question: input.question ?? 'Select the best driver output artifact for v0 integration.',
        ...(input.workspace_path ? { workspace_path: input.workspace_path } : {}),
        candidate_artifacts: [...input.driver_result.artifacts],
        proposals: [proposal],
        evidence_pack: input.evidence_pack,
        schema_version: SCHEMA_VERSION,
      };
    const councilOptions = execution
        ? {
            ...(execution.signal ? { signal: execution.signal } : {}),
            ...(execution.onDriverEvent ? { onDriverEvent: execution.onDriverEvent } : {}),
            ...(execution.onCouncilLifecycleEvent
              ? { onLifecycleEvent: execution.onCouncilLifecycleEvent }
              : {}),
          }
        : undefined;
    const autonomousExecution = this.options.councilHandler
      ? await this.options.councilHandler.execute(councilRequest, councilOptions)
      : undefined;
    const councilRunResult = autonomousExecution
      ? autonomousExecution.council_run_result
      : await this.options.councilProvider.runCouncilRound(councilRequest, councilOptions);
    const councilDecision = councilRunResult.decision;

    // Convert council verdict to selection
    const selectedArtifactIds = new Set(
      autonomousExecution
        ? [autonomousExecution.final_artifact.artifact_id]
        : councilDecision.selected_artifact_refs,
    );
    const selectableArtifacts = [
      ...input.driver_result.artifacts,
      ...councilRunResult.generated_artifact_refs,
    ];
    const selected =
      autonomousExecution || councilDecision.verdict === 'select'
        ? selectableArtifacts.filter((artifact) => selectedArtifactIds.has(artifact.artifact_id))
        : [];

    return {
      selection_id: createId('selection'),
      run_id: input.run_id,
      task_id: input.task_id,
      mode: 'council',
      selected_artifacts: selected,
      reason: councilDecision.reason,
      metadata: {
        council_decision_id: councilDecision.decision_id,
        decision_mode: councilDecision.decision_mode,
        proposal_id: proposal.proposal_id,
        verdict: councilDecision.verdict,
        selected_proposal_id: councilDecision.selected_proposal_id,
        selected_artifact_refs: councilDecision.selected_artifact_refs,
        generated_artifact_refs: councilRunResult.generated_artifact_refs.map(
          (artifact) => artifact.artifact_id,
        ),
        comparison_ref: councilDecision.comparison_ref,
        can_create_merge_authorization: councilDecision.can_create_merge_authorization,
      },
      council_decision: councilDecision,
      council_run_result: councilRunResult,
      ...(autonomousExecution ? { council_result: autonomousExecution.council_result } : {}),
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }
}

/**
 * Factory function to create an ArtifactSelector with sensible defaults.
 *
 * @param mode - 'single_agent' (default) or 'council'
 * @param councilProvider - optional, defaults to MockCouncil for council mode
 */
export function createArtifactSelector(
  mode: SelectionMode = 'single_agent',
  councilProvider?: CouncilProvider,
): ArtifactSelector {
  const options: ArtifactSelectorOptions = { mode };
  if (mode === 'council') {
    options.councilProvider = councilProvider ?? new MockCouncil();
  }
  return new ArtifactSelector(options);
}
