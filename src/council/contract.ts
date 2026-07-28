import type {
  ArtifactId,
  ArtifactRef,
  RunId,
  SchemaVersion,
  TaskBudget,
  TaskId,
  Timestamp,
} from '../core';
import type { DriverStreamEventListener } from '../driver/contract';

export type CouncilDecisionMode =
  | 'advisory'
  | 'evidence_only'
  | 'delegated_decision'
  | 'human_review_required';

export type CouncilTrigger = 'user_choice' | 'agent_escalate' | 'gate_defer' | 'manual';

export interface ProposalClaim {
  claim_id: string;
  type: 'design_decision' | 'code_change' | 'risk' | 'test_result' | 'assumption';
  statement: string;
  evidence_refs: string[];
  risk_level?: 'low' | 'medium' | 'high' | 'critical';
}

export interface Proposal {
  proposal_id: string;
  run_id?: RunId;
  task_id: TaskId;
  agent_id?: string;
  artifact_refs: ArtifactId[];
  summary: string;
  claims?: ProposalClaim[];
  affected_paths: string[];
  assumptions: string[];
  known_risks: string[];
  completion_evidence: string[];
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface Review {
  review_id: string;
  proposal_id: string;
  reviewer_id: string;
  verdict: 'approve' | 'reject' | 'needs_revision';
  reason: string;
  unmet_criteria?: string[];
  evidence_refs?: string[];
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface CouncilResult {
  quality: 'verified' | 'best_effort';
  final_artifact_ref: ArtifactId;
  final_artifact_sha256: string;
  warnings: string[];
  unmet_criteria: string[];
  verification_refs: string[];
  decision_record_ref: string;
}

export interface EvidencePack {
  evidence_pack_id: string;
  task_id: TaskId;
  context_pack_ref?: string;
  artifact_refs: ArtifactId[];
  gate_result_refs: string[];
  summary: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface ProposalComparisonSummary {
  comparison_id: string;
  task_id: TaskId;
  proposal_ids: string[];
  selected_proposal_id?: string;
  verdict: 'select' | 'needs_human' | 'request_revision' | 'reject';
  reason: string;
  evidence_refs: string[];
  risk_signals: string[];
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface CouncilDecision {
  decision_id: string;
  run_id?: RunId;
  task_id: TaskId;
  decision_mode: CouncilDecisionMode;
  selected_proposal_id?: string;
  selected_artifact_refs: ArtifactId[];
  verdict: 'select' | 'needs_human' | 'request_revision' | 'reject';
  reason: string;
  evidence_refs: string[];
  comparison_ref?: string;
  authorization_ref?: string;
  can_create_merge_authorization: boolean;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface CouncilSynthesis {
  synthesis_id: string;
  run_id?: RunId;
  task_id: TaskId;
  synthesizer_id: string;
  input_proposal_ids: string[];
  input_review_ids: string[];
  artifact_refs: ArtifactId[];
  summary: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface CouncilOutput {
  output_id: string;
  run_id?: RunId;
  task_id: TaskId;
  status: 'selected' | 'needs_human' | 'request_revision' | 'rejected';
  decision_ref: string;
  selected_artifact_refs: ArtifactId[];
  generated_artifact_refs: ArtifactRef[];
  required_next_actions: string[];
  blocked_by: string[];
  can_create_merge_authorization: boolean;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface CouncilRunResult {
  council_run_id: string;
  run_id?: RunId;
  task_id: TaskId;
  proposals: Proposal[];
  reviews: Review[];
  synthesis?: CouncilSynthesis;
  decision: CouncilDecision;
  output?: CouncilOutput;
  generated_artifact_refs: ArtifactRef[];
  selected_artifact_refs: ArtifactId[];
  result?: CouncilResult;
  diagnostic_refs?: string[];
  comparison_refs?: string[];
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface CouncilRunRequest {
  run_id?: RunId;
  task_id: TaskId;
  trigger: CouncilTrigger;
  decision_mode: CouncilDecisionMode;
  question: string;
  workspace_path?: string;
  candidate_artifacts?: ArtifactRef[];
  context_pack_ref?: string;
  participant_profile_refs?: string[];
  proposals: Proposal[];
  reviews?: Review[];
  evidence_pack?: EvidencePack;
  human_authorization_ref?: string;
  auto_advance_allowed?: boolean;
  budget?: TaskBudget;
  max_rounds?: number;
  quorum?: {
    min_proposals?: number;
    min_reviews?: number;
  };
  deadline_at?: Timestamp;
  schema_version: SchemaVersion;
}

export type CouncilRoundInput = CouncilRunRequest;

export interface CouncilLifecycleEvent {
  type:
    | 'council.proposal.completed'
    | 'council.review.completed'
    | 'council.synthesis.completed'
    | 'council.failed';
  payload: Record<string, unknown>;
}

export interface CouncilExecutionOptions {
  signal?: AbortSignal;
  onDriverEvent?: DriverStreamEventListener;
  onLifecycleEvent?: (event: CouncilLifecycleEvent) => void | Promise<void>;
}

export interface CouncilProvider {
  runCouncilRound(
    input: CouncilRoundInput,
    options?: CouncilExecutionOptions,
  ): Promise<CouncilRunResult>;
}

export async function runCouncilRound(
  provider: CouncilProvider,
  input: CouncilRoundInput,
  options?: CouncilExecutionOptions,
): Promise<CouncilRunResult> {
  return provider.runCouncilRound(input, options);
}
