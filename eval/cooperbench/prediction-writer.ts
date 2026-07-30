import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readGoldFeaturePatch } from './cases';
import type {
  CooperBenchCaseIdParts,
  CooperBenchPrediction,
  CooperBenchPredictionMode,
  CooperBenchSetting,
} from './types';

const STUB_PATCH = [
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  ' # cooperbench',
  '+<!-- newide-scaffold cooperbench stub -->',
  '',
].join('\n');

export function describeCooperBenchPredictionMode(
  mode: CooperBenchPredictionMode,
  patchSource: string,
): string {
  if (mode === 'stub') {
    return 'deterministic_stub_baseline';
  }
  if (mode === 'oracle') {
    return 'oracle_gold_feature_patch_replay';
  }
  return `real_${patchSource}`;
}

export function buildCooperBenchPrediction(input: {
  parts: CooperBenchCaseIdParts;
  setting: CooperBenchSetting;
  modelName: string;
  mode: CooperBenchPredictionMode;
  datasetDir: string;
  realSoloPatch?: string;
  realAgent1Patch?: string;
  realAgent2Patch?: string;
}): CooperBenchPrediction {
  const { parts, setting, modelName, mode, datasetDir } = input;
  const base = {
    case_id: parts.case_id,
    setting,
    model_name_or_path: modelName,
  };

  if (mode === 'stub') {
    if (setting === 'solo') {
      return { ...base, model_patch: STUB_PATCH };
    }
    return {
      ...base,
      agent1_patch: STUB_PATCH,
      agent2_patch: STUB_PATCH,
    };
  }

  if (mode === 'oracle') {
    const [f1, f2] = parts.features;
    const gold1 = readGoldFeaturePatch(datasetDir, parts.repo, parts.task_id, f1);
    const gold2 = readGoldFeaturePatch(datasetDir, parts.repo, parts.task_id, f2);
    if (setting === 'solo') {
      // Solo oracle: concatenate gold feature patches (best-effort gold replay).
      return { ...base, model_patch: `${gold1.trimEnd()}\n${gold2.trimEnd()}\n` };
    }
    return {
      ...base,
      agent1_patch: gold1,
      agent2_patch: gold2,
    };
  }

  if (setting === 'solo') {
    if (!input.realSoloPatch?.trim()) {
      throw new Error(
        'Prediction mode "real" with setting solo requires --patch-file (solo.patch content).',
      );
    }
    return { ...base, model_patch: input.realSoloPatch };
  }

  if (!input.realAgent1Patch?.trim() || !input.realAgent2Patch?.trim()) {
    throw new Error(
      'Prediction mode "real" with setting coop requires --agent1-patch and --agent2-patch.',
    );
  }
  return {
    ...base,
    agent1_patch: input.realAgent1Patch,
    agent2_patch: input.realAgent2Patch,
  };
}

export function writeCooperBenchPredictionsJsonl(
  path: string,
  predictions: CooperBenchPrediction[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = predictions.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(path, body.length > 0 ? `${body}\n` : '', 'utf-8');
}
