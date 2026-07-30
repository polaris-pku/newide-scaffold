import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureDirName, parseCooperBenchCaseId } from './cases';
import type { CooperBenchPrediction, CooperBenchSetting } from './types';
import { writeJson } from '../run-summary';

export interface MaterializeCooperBenchLogsResult {
  logsRoot: string;
  cooperbenchRunName: string;
  caseLogDirs: Record<string, string>;
}

/**
 * Materialize CooperBench log layout so `cooperbench eval -n <run>` can discover patches:
 *   <logsRoot>/<runName>/<setting>/<repo>/<task_id>/fN_fM/{solo.patch|agentN.patch}
 */
export function materializeCooperBenchLogs(input: {
  logsRoot: string;
  cooperbenchRunName: string;
  setting: CooperBenchSetting;
  predictions: CooperBenchPrediction[];
  modelName: string;
}): MaterializeCooperBenchLogsResult {
  const runRoot = join(input.logsRoot, input.cooperbenchRunName);
  mkdirSync(runRoot, { recursive: true });
  writeJson(join(runRoot, 'config.json'), {
    agent_framework: 'newide-scaffold',
    model: input.modelName,
    setting: input.setting,
    source: 'f-eval-cooperbench',
  });

  const caseLogDirs: Record<string, string> = {};

  for (const prediction of input.predictions) {
    const parts = parseCooperBenchCaseId(prediction.case_id);
    const featureDir = join(
      runRoot,
      input.setting,
      parts.repo,
      String(parts.task_id),
      featureDirName(parts.features),
    );
    mkdirSync(featureDir, { recursive: true });
    caseLogDirs[prediction.case_id] = featureDir;

    writeJson(join(featureDir, 'result.json'), {
      repo: parts.repo,
      task_id: parts.task_id,
      features: parts.features,
      setting: input.setting,
      model_name_or_path: prediction.model_name_or_path,
      status: 'completed',
    });

    if (input.setting === 'solo') {
      writeFileSync(join(featureDir, 'solo.patch'), prediction.model_patch ?? '', 'utf-8');
    } else {
      const [f1, f2] = parts.features;
      writeFileSync(join(featureDir, `agent${f1}.patch`), prediction.agent1_patch ?? '', 'utf-8');
      writeFileSync(join(featureDir, `agent${f2}.patch`), prediction.agent2_patch ?? '', 'utf-8');
    }
  }

  return {
    logsRoot: input.logsRoot,
    cooperbenchRunName: input.cooperbenchRunName,
    caseLogDirs,
  };
}
