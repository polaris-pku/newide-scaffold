import type { MemoryAblation, PatchSource, PredictionMode } from './types';

const PREDICTION_MODES = ['stub', 'oracle', 'real'] as const;
const MEMORY_ABLATIONS = ['B0', 'B1', 'B2', 'B3'] as const;

export function parsePredictionMode(value: string | undefined): PredictionMode {
  const mode = value ?? 'stub';
  if ((PREDICTION_MODES as readonly string[]).includes(mode)) {
    return mode as PredictionMode;
  }
  throw new Error(`Invalid --mode "${mode}". Expected one of: ${PREDICTION_MODES.join(', ')}`);
}

export function parseMemoryAblation(value: string | undefined): MemoryAblation {
  const ablation = value ?? 'B2';
  if ((MEMORY_ABLATIONS as readonly string[]).includes(ablation)) {
    return ablation as MemoryAblation;
  }
  throw new Error(
    `Invalid --ablation "${ablation}". Expected one of: ${MEMORY_ABLATIONS.join(', ')}`,
  );
}

export function describePredictionMode(mode: PredictionMode, patchSource?: PatchSource): string {
  if (mode === 'stub') {
    return 'deterministic_stub_baseline';
  }
  if (mode === 'real') {
    return patchSource === 'worktree_git_diff'
      ? 'worktree_git_diff_collected'
      : 'caller_supplied_model_patch';
  }
  return 'oracle_gold_patch_replay';
}
