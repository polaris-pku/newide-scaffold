export type MemoryAblation = 'B0' | 'B1' | 'B2' | 'B3';

export type PredictionMode = 'stub' | 'oracle' | 'real';

export type PatchSource = 'stub' | 'oracle' | 'patch_file' | 'worktree_git_diff' | 'harness_import';

export interface EvalDatasetSubset {
  subset_id: string;
  description: string;
  source_dataset_version: string;
  source_jsonl: string;
  selection_rule: string;
  environment_notes: string[];
  instance_ids: string[];
}

export interface EvalManifest {
  dataset_version: string;
  dataset_jsonl: string;
  dataset_hf_dir?: string;
  default_subset?: string;
  /** @deprecated Prefer `subsets` + `default_subset`; kept optional for unit fixtures. */
  smoke_instance_ids?: string[];
  subsets?: Record<string, string>;
  default_model_name: string;
}

export interface SweEvoInstance {
  repo: string;
  instance_id: string;
  base_commit: string;
  patch: string;
  test_patch?: string;
  problem_statement: string;
  FAIL_TO_PASS?: string[];
  PASS_TO_PASS?: string[];
}

export interface SweBenchPrediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

export interface SweBenchInstanceReport {
  patch_is_None?: boolean;
  patch_exists?: boolean;
  patch_successfully_applied?: boolean;
  resolved?: boolean;
  tests_status?: {
    FAIL_TO_PASS?: Record<string, string>;
    PASS_TO_PASS?: Record<string, string>;
  };
}

export type SweBenchHarnessReport = Record<string, SweBenchInstanceReport>;

export interface EvalRunMeta {
  run_id: string;
  instance_id: string;
  repo: string;
  prediction_mode: PredictionMode;
  prediction_semantics: string;
  memory_ablation: MemoryAblation;
  model_name: string;
  dataset_jsonl: string;
  dataset_subset?: string;
  dataset_manifest_path: string;
  patch_source: PatchSource;
  worktree_path?: string;
  backend_summary_path?: string;
  started_at: string;
}

export interface EvalSummary {
  run_id: string;
  instance_ids: string[];
  prediction_mode: PredictionMode;
  prediction_semantics: string;
  memory_ablation: MemoryAblation;
  model_name: string;
  telemetry_path: string;
  predictions_path: string;
  dataset_manifest_path: string;
  patch_source: PatchSource;
  worktree_path?: string;
  backend_summary_path?: string;
  dataset_subset?: string;
  harness_report_path?: string;
  resolved_count: number;
  unresolved_count: number;
  applied_count: number;
  p2p_regression_count: number;
  telemetry_event_types: string[];
  completed_at: string;
}
