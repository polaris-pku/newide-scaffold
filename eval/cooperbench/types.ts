export type CooperBenchSetting = 'solo' | 'coop';

export type CooperBenchPredictionMode = 'stub' | 'oracle' | 'real';

export type CooperBenchPatchSource =
  | 'stub'
  | 'oracle'
  | 'patch_file'
  | 'agent_patch_files'
  | 'harness_import';

export interface CooperBenchCaseRef {
  repo: string;
  task_id: number;
  features: [number, number];
}

export interface CooperBenchCaseIdParts extends CooperBenchCaseRef {
  case_id: string;
}

export interface CooperBenchDatasetSubset {
  subset_id: string;
  description: string;
  source_dataset_version: string;
  selection_rule: string;
  environment_notes: string[];
  default_setting: CooperBenchSetting;
  case_ids: string[];
}

export interface CooperBenchManifest {
  dataset_version: string;
  /** Relative to scaffold root, or absolute. Default sibling ../CooperBench/dataset */
  dataset_dir: string;
  /** Relative to scaffold root, or absolute. Default sibling ../CooperBench */
  cooperbench_root: string;
  default_subset: string;
  subsets: Record<string, string>;
  default_setting: CooperBenchSetting;
  default_model_name: string;
}

export interface CooperBenchPrediction {
  case_id: string;
  setting: CooperBenchSetting;
  model_name_or_path: string;
  /** solo: single patch; coop: unused (patches live in agent1/agent2). */
  model_patch?: string;
  agent1_patch?: string;
  agent2_patch?: string;
}

export interface CooperBenchEvalJson {
  repo: string;
  task_id: number;
  features: number[];
  setting: CooperBenchSetting | string;
  both_passed?: boolean;
  error?: string | null;
  feature1?: { passed?: boolean; test_output?: string };
  feature2?: { passed?: boolean; test_output?: string };
  merge?: { status?: string; strategy?: string } | null;
  apply_status?: string;
  evaluated_at?: string;
  /** Optional paired solo outcome for coordination_deficit. */
  solo_both_passed?: boolean;
}

export type CooperBenchHarnessReport = Record<string, CooperBenchEvalJson>;

export interface CooperBenchRunMeta {
  run_id: string;
  case_id: string;
  setting: CooperBenchSetting;
  prediction_mode: CooperBenchPredictionMode;
  prediction_semantics: string;
  model_name: string;
  dataset_dir: string;
  dataset_subset?: string;
  dataset_manifest_path: string;
  patch_source: CooperBenchPatchSource;
  cooperbench_logs_dir: string;
  cooperbench_run_name: string;
  started_at: string;
}

export interface CooperBenchSummary {
  run_id: string;
  case_ids: string[];
  setting: CooperBenchSetting;
  prediction_mode: CooperBenchPredictionMode;
  prediction_semantics: string;
  model_name: string;
  telemetry_path: string;
  predictions_path: string;
  dataset_manifest_path: string;
  patch_source: CooperBenchPatchSource;
  dataset_subset?: string;
  harness_report_path?: string;
  both_passed_count: number;
  both_failed_count: number;
  coordination_deficit_sum: number;
  telemetry_event_types: string[];
  completed_at: string;
}
