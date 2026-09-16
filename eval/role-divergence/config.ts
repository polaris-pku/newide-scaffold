/**
 * config — 角色分歧实验的路径解析与固定控制变量
 *
 * 控制变量分两处落位：
 * - 本目录 `experiment.example.json`（可被 ROLE_DIVERGENCE_CONFIG 覆盖）：数据集子集、
 *   记忆消融档、**检索策略期望值**、模型标签；
 * - 环境变量：driver 与嵌入的凭据与目标模型、PGlite 数据目录。
 *
 * 检索策略（top-K / 相似度门槛 / 条目上限）由生产 facade 内部固定，本实验**改不动**，
 * 只能记录并断言。断言存在的意义：一旦生产默认值漂移，实验的「检索策略固定」这一
 * 控制前提即失效，必须当场失败而不是静默出一个不可比的格子。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getEvalRoot, getScaffoldRoot } from '../paths';
import type { ExpectedRetrievalPolicy } from './types';

export const CONFIG_ENV = 'ROLE_DIVERGENCE_CONFIG';
export const RESULT_ROOT_ENV = 'ROLE_DIVERGENCE_ROOT';
export const SKILLS_DIR_ENV = 'NEWIDE_SKILLS_DIR';
export const PGLITE_DIR_ENV = 'NEWIDE_B_PGLITE_DATA_DIR';
export const DRIVER_RUNNER_DIR_ENV = 'ACP_DRIVER_RUNNER_DIR';
export const DRIVER_ENV_FILE_ENV = 'ACP_DRIVER_ENV_FILE';

/** 记忆消融档：记下并断言，防止误跑成 B0（记忆关闭）而实验静默失效 */
export type MemoryAblationSetting = 'B2';

interface RawExperimentConfig {
  experiment_id?: string;
  model_label?: string;
  dataset_subset?: string;
  memory_ablation?: string;
  expected_retrieval_policy?: Partial<ExpectedRetrievalPolicy>;
}

export interface ExperimentConfig {
  experiment_id: string;
  model_label: string;
  dataset_subset: string;
  memory_ablation: MemoryAblationSetting;
  expected_retrieval_policy: ExpectedRetrievalPolicy;
  scaffold_root: string;
  skills_dir: string;
  result_root: string;
  pglite_dir: string;
  driver_runner_dir: string;
  driver_env_file: string;
  driver_runner_path: string;
  config_path: string;
}

const DEFAULT_RETRIEVAL_POLICY: ExpectedRetrievalPolicy = {
  recall_top_k: 20,
  min_embedding_similarity: 0.5,
  min_confidence: 0.2,
  max_memory_items: 5,
  min_tag_overlap: 1,
};

export function resolveExperimentConfig(env: NodeJS.ProcessEnv = process.env): ExperimentConfig {
  const scaffoldRoot = getScaffoldRoot();
  const configPath =
    env[CONFIG_ENV]?.trim() ??
    path.join(getEvalRoot(), 'role-divergence', 'experiment.example.json');
  const raw = readJsonFile<RawExperimentConfig>(configPath) ?? {};

  const ablation = raw.memory_ablation?.trim() ?? 'B2';
  if (ablation !== 'B2') {
    throw new Error(
      `Role divergence requires memory_ablation "B2" (skills on); got "${ablation}". ` +
        'B0/B1 would disable the manipulated variable and silently invalidate the experiment.',
    );
  }

  const resultRoot = path.resolve(
    env[RESULT_ROOT_ENV]?.trim() || path.join(scaffoldRoot, '..', 'role-divergence-runs'),
  );
  const driverRunnerDir = path.resolve(
    env[DRIVER_RUNNER_DIR_ENV]?.trim() || path.join(scaffoldRoot, '..', 'acp-client-prototype'),
  );

  return {
    experiment_id: raw.experiment_id?.trim() || 'role-divergence',
    model_label: raw.model_label?.trim() || 'configured-by-environment',
    dataset_subset: raw.dataset_subset?.trim() || 'v0-dask-3-prctx',
    memory_ablation: ablation,
    expected_retrieval_policy: { ...DEFAULT_RETRIEVAL_POLICY, ...raw.expected_retrieval_policy },
    scaffold_root: scaffoldRoot,
    skills_dir: path.resolve(env[SKILLS_DIR_ENV]?.trim() || path.join(scaffoldRoot, 'skills')),
    result_root: resultRoot,
    pglite_dir: path.resolve(env[PGLITE_DIR_ENV]?.trim() || path.join(resultRoot, 'pglite')),
    driver_runner_dir: driverRunnerDir,
    driver_env_file: path.resolve(
      env[DRIVER_ENV_FILE_ENV]?.trim() || path.join(driverRunnerDir, '.env'),
    ),
    driver_runner_path: path.join(driverRunnerDir, 'dist', 'src', 'driver', 'contract-runner.js'),
    config_path: configPath,
  };
}

/** 断言生产检索策略与期望一致；不一致即实验控制失效，当场失败 */
export function assertRetrievalPolicy(
  actual: ExpectedRetrievalPolicy,
  expected: ExpectedRetrievalPolicy,
): void {
  const drift = (Object.keys(expected) as Array<keyof ExpectedRetrievalPolicy>).filter(
    (key) => actual[key] !== expected[key],
  );
  if (drift.length > 0) {
    const detail = drift
      .map((key) => `${key}: expected ${String(expected[key])}, got ${String(actual[key])}`)
      .join('; ');
    throw new Error(
      `Retrieval policy drift breaks the fixed-retrieval control: ${detail}. ` +
        'Update experiment.example.json only if the experiment is intentionally re-baselined.',
    );
  }
}

/** 从环境推断本次跑的模型标签，仅用于证据记录（不参与路由） */
export function resolveModelLabel(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.ANTHROPIC_MODEL?.trim() ||
    env.NEWIDE_AGENT_LLM_MODEL?.trim() ||
    env.DEEPSEEK_MODEL?.trim() ||
    'unset'
  );
}

export function requireDriverRunner(config: ExperimentConfig): void {
  if (!existsSync(config.driver_runner_path)) {
    throw new Error(
      `ACP Driver build is missing: ${config.driver_runner_path}. ` +
        'Build the driver runner (ACP_DRIVER_RUNNER_DIR) before running experiment stages.',
    );
  }
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
