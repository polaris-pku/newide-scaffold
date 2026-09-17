import type { CheckpointId, RunId, TaskId } from '../core';
import type { TelemetryEmission } from './telemetry-sink';

export interface SweEvoEvaluationTelemetryInput {
  instance_id: string;
  instance_seq: number;
  resolved: boolean;
  fix_rate?: number;
  f2p?: Record<string, unknown>;
  applied: boolean;
  p2p_regression: boolean;
  memory_ablation?: 'B0' | 'B1' | 'B2' | 'B3';
  task_id?: TaskId;
  run_id?: RunId;
}

export interface CooperBenchEvaluationTelemetryInput {
  case_id: string;
  both_passed: boolean;
  coordination_deficit: number;
  failure_taxonomy: string[];
  task_id?: TaskId;
  run_id?: RunId;
}

export interface ProxyUsageTelemetryInput {
  case_id: string;
  input_tokens: number;
  output_tokens: number;
  /**
   * cache token 是 Claude 计费的实打实一部分，但早期只留在 ledger entry 上、
   * 没进 emission，于是按 telemetry 流算总量的人会系统性偏小。
   */
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  model?: string;
  scaffold_variant?: 'air_emulator' | 'zcode_router' | 'full_system' | string;
  temperature?: number;
  seed?: number;
  /** 归属维度，取值见 llm-usage-attribution。 */
  stage_cursor?: string;
  role_id?: string;
  agent_id?: string;
  tool_name?: string;
  round?: number;
  task_id?: TaskId;
  run_id?: RunId;
}

export interface SweBenchVerifiedEvaluationTelemetryInput {
  case_id: string;
  exit_code: number;
  fail_to_pass_status: string;
  pass_to_pass_status: string;
  passed: boolean;
  scaffold_variant: 'air_emulator' | 'zcode_router' | 'full_system' | string;
  case_tier: 'easy' | 'medium' | 'hard' | string;
  task_id?: TaskId;
  run_id?: RunId;
  bench_harness?: string;
  council_topology?: string;
  council_context?: string;
  council_judge_source?: string;
  council_anonymize?: string;
}

export interface TestbedRegressionTelemetryInput {
  case_id: string;
  pass_to_pass_regressed: boolean;
  regressed_tests: string[];
  task_id?: TaskId;
  run_id?: RunId;
}

export interface AgentCrashTelemetryInput {
  task_id: TaskId;
  run_id?: RunId;
  kill_at: string;
  progress_pct: number;
  tool_call_count: number;
  had_checkpoint: boolean;
  kill_at_status: string;
  checkpoint_id_at_kill?: CheckpointId;
}

export interface ColdRestartTelemetryInput {
  task_id: TaskId;
  run_id?: RunId;
  summary_token_count: number;
  summary_fields: string[];
}

export function buildSweEvoEvaluationTelemetry(
  input: SweEvoEvaluationTelemetryInput,
): TelemetryEmission {
  return {
    event_type: 'harness.swe_evo_evaluated',
    subject_id: input.instance_id,
    subject_type: 'swe_evo_instance',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      instance_id: input.instance_id,
      instance_seq: input.instance_seq,
      resolved: input.resolved,
      ...(input.fix_rate !== undefined ? { fix_rate: input.fix_rate } : {}),
      ...(input.f2p ? { f2p: input.f2p } : {}),
      applied: input.applied,
      p2p_regression: input.p2p_regression,
      ...(input.memory_ablation ? { memory_ablation: input.memory_ablation } : {}),
    },
    source: { kind: 'harness', object_type: 'SWE-EVO evaluate' },
  };
}

export function buildCooperBenchEvaluationTelemetry(
  input: CooperBenchEvaluationTelemetryInput,
): TelemetryEmission {
  return {
    event_type: 'harness.cooperbench_evaluated',
    subject_id: input.case_id,
    subject_type: 'cooperbench_case',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      case_id: input.case_id,
      both_passed: input.both_passed,
      coordination_deficit: input.coordination_deficit,
      failure_taxonomy: input.failure_taxonomy,
    },
    source: { kind: 'harness', object_type: 'CooperBench evaluate' },
  };
}

export function buildProxyUsageTelemetry(input: ProxyUsageTelemetryInput): TelemetryEmission {
  return {
    event_type: 'proxy.llm_usage_recorded',
    subject_id: input.case_id,
    subject_type: 'llm_call',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      case_id: input.case_id,
      input_tokens: input.input_tokens,
      output_tokens: input.output_tokens,
      ...(input.cache_creation_input_tokens !== undefined
        ? { cache_creation_input_tokens: input.cache_creation_input_tokens }
        : {}),
      ...(input.cache_read_input_tokens !== undefined
        ? { cache_read_input_tokens: input.cache_read_input_tokens }
        : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.scaffold_variant ? { scaffold_variant: input.scaffold_variant } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(input.stage_cursor ? { stage_cursor: input.stage_cursor } : {}),
      ...(input.role_id ? { role_id: input.role_id } : {}),
      ...(input.agent_id ? { agent_id: input.agent_id } : {}),
      ...(input.tool_name ? { tool_name: input.tool_name } : {}),
      ...(input.round !== undefined ? { round: input.round } : {}),
    },
    source: { kind: 'proxy', object_type: 'LLM call' },
  };
}

export function buildSweBenchVerifiedEvaluationTelemetry(
  input: SweBenchVerifiedEvaluationTelemetryInput,
): TelemetryEmission {
  return {
    event_type: 'harness.swe_bench_verified_evaluated',
    subject_id: input.case_id,
    subject_type: 'swe_bench_verified_case',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      case_id: input.case_id,
      exit_code: input.exit_code,
      fail_to_pass_status: input.fail_to_pass_status,
      pass_to_pass_status: input.pass_to_pass_status,
      passed: input.passed,
      scaffold_variant: input.scaffold_variant,
      case_tier: input.case_tier,
      ...(input.bench_harness ? { 'bench.harness': input.bench_harness } : {}),
      ...(input.council_topology ? { 'council.topology': input.council_topology } : {}),
      ...(input.council_context ? { 'council.context': input.council_context } : {}),
      ...(input.council_judge_source ? { 'council.judge_source': input.council_judge_source } : {}),
      ...(input.council_anonymize ? { 'council.anonymize': input.council_anonymize } : {}),
    },
    source: { kind: 'harness', object_type: 'SWE-bench Verified evaluate' },
  };
}

export function buildTestbedRegressionTelemetry(
  input: TestbedRegressionTelemetryInput,
): TelemetryEmission {
  return {
    event_type: 'harness.testbed_regression_checked',
    subject_id: input.case_id,
    subject_type: 'swe_bench_verified_case',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      case_id: input.case_id,
      pass_to_pass_regressed: input.pass_to_pass_regressed,
      regressed_tests: input.regressed_tests,
    },
    source: { kind: 'harness', object_type: 'Testbed regression check' },
  };
}

export function buildAgentCrashTelemetry(input: AgentCrashTelemetryInput): TelemetryEmission {
  return {
    event_type: 'eval.agent_crash',
    subject_id: input.task_id,
    subject_type: 'task',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    payload: {
      kill_at: input.kill_at,
      progress_pct: input.progress_pct,
      tool_call_count: input.tool_call_count,
      had_checkpoint: input.had_checkpoint,
      kill_at_status: input.kill_at_status,
      ...(input.checkpoint_id_at_kill
        ? { checkpoint_id_at_kill: input.checkpoint_id_at_kill }
        : {}),
    },
    source: { kind: 'harness', object_type: 'P2 perturbation controller' },
  };
}

export function buildColdRestartTelemetry(input: ColdRestartTelemetryInput): TelemetryEmission {
  return {
    event_type: 'eval.cold_restart',
    subject_id: input.task_id,
    subject_type: 'task',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    payload: {
      summary_token_count: input.summary_token_count,
      summary_fields: input.summary_fields,
    },
    source: { kind: 'harness', object_type: 'P2 cold restart baseline' },
  };
}
