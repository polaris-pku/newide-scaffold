import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactRef } from '../core';

export function isMaterializableFileArtifact(artifact: ArtifactRef): boolean {
  return Boolean(
    artifact.content &&
      (artifact.content.kind === 'text' || artifact.content.kind === 'file') &&
      artifact.content.target_path,
  );
}

export async function readArtifactBytes(artifact: ArtifactRef): Promise<Buffer> {
  const content = artifact.content;
  if (!content || (content.kind !== 'text' && content.kind !== 'file')) {
    throw new Error(`Artifact ${artifact.artifact_id} is not a materializable file artifact`);
  }
  if (content.content_ref.startsWith('data:')) {
    const comma = content.content_ref.indexOf(',');
    if (comma < 0) throw new Error(`Artifact ${artifact.artifact_id} has an invalid data reference`);
    const metadata = content.content_ref.slice(5, comma);
    const encoded = content.content_ref.slice(comma + 1);
    return metadata.endsWith(';base64')
      ? Buffer.from(encoded, 'base64')
      : Buffer.from(decodeURIComponent(encoded), 'utf-8');
  }
  const source = content.content_ref.startsWith('file:')
    ? fileURLToPath(content.content_ref)
    : content.content_ref;
  return fs.readFile(source);
}

export function artifactTargetPath(root: string, artifact: ArtifactRef): string {
  const targetPath = artifact.content?.target_path;
  if (!targetPath) throw new Error(`Artifact ${artifact.artifact_id} has no target_path`);
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, targetPath);
  if (target === absoluteRoot || !target.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`Artifact target escapes workspace: ${targetPath}`);
  }
  return target;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
