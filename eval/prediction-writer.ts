import { writeFileSync } from 'node:fs';
import type { PredictionMode, SweBenchPrediction, SweEvoInstance } from './types';

const STUB_PATCH = [
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  ' # newide-scaffold eval stub',
  '+<!-- F-direction pipeline stub -->',
  '',
].join('\n');

export function buildPrediction(
  instance: SweEvoInstance,
  modelName: string,
  mode: PredictionMode,
  realPatch?: string,
): SweBenchPrediction {
  let model_patch: string;
  if (mode === 'oracle') {
    model_patch = instance.patch;
  } else if (mode === 'real') {
    if (!realPatch) {
      throw new Error(
        'Prediction mode "real" requires --patch-file or a collected worktree patch.',
      );
    }
    model_patch = realPatch;
  } else {
    model_patch = STUB_PATCH;
  }
  return {
    instance_id: instance.instance_id,
    model_name_or_path: modelName,
    model_patch,
  };
}

export function writePredictionsJsonl(path: string, predictions: SweBenchPrediction[]): void {
  const body = predictions.map((prediction) => JSON.stringify(prediction)).join('\n');
  writeFileSync(path, body.length > 0 ? `${body}\n` : '', 'utf-8');
}
