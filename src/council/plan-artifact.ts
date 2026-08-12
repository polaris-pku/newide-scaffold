import path from 'node:path';
import type { ArtifactRef } from '../core';
import { isMaterializableFileArtifact } from '../coordinator/artifact-content';

const COUNCIL_PLAN_FILE = /(?:^|[-_])(plan|review)\.md$/i;

export function isCouncilPlanArtifact(artifact: ArtifactRef): boolean {
  if (!isMaterializableFileArtifact(artifact)) return false;
  const targetPath = artifact.content?.target_path;
  if (!targetPath) return false;
  return COUNCIL_PLAN_FILE.test(path.posix.basename(targetPath.replaceAll('\\', '/')));
}

export function assertCouncilPlanArtifacts(
  artifacts: readonly ArtifactRef[],
  phase: string,
  options: { required?: boolean } = {},
): ArtifactRef[] {
  const materializable = artifacts.filter(isMaterializableFileArtifact);
  const invalid = materializable.filter((artifact) => !isCouncilPlanArtifact(artifact));
  if (invalid.length > 0) {
    throw new Error(
      `Council ${phase} produced product files during plan-first execution: ${invalid
        .map((artifact) => artifact.content?.target_path ?? artifact.artifact_id)
        .join(', ')}`,
    );
  }
  if (options.required !== false && materializable.length === 0) {
    throw new Error(`Council ${phase} produced no materializable Plan artifact`);
  }
  return materializable;
}
