import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ArtifactRef } from '../../core';
import { artifactTargetPath, readArtifactBytes, sha256 } from '../artifact-content';

export interface DeliverArtifactInput {
  workspace_path: string;
  final_artifact: ArtifactRef;
  expected_sha256: string;
}

export interface DeliverArtifactResult {
  artifact_ref: string;
  relative_path: string;
  file_path: string;
  sha256: string;
  bytes_written: number;
}

export class DeliverArtifactHandler {
  async execute(input: DeliverArtifactInput): Promise<DeliverArtifactResult> {
    const bytes = await readArtifactBytes(input.final_artifact);
    const artifactHash = sha256(bytes);
    if (artifactHash !== input.expected_sha256) {
      throw new Error(
        `Council final artifact SHA256 mismatch: expected ${input.expected_sha256}, got ${artifactHash}`,
      );
    }

    const target = artifactTargetPath(input.workspace_path, input.final_artifact);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    const deliveredHash = sha256(await fs.readFile(target));
    if (deliveredHash !== input.expected_sha256) {
      throw new Error(
        `Workspace file SHA256 mismatch: expected ${input.expected_sha256}, got ${deliveredHash}`,
      );
    }

    return {
      artifact_ref: input.final_artifact.artifact_id,
      relative_path: path.relative(path.resolve(input.workspace_path), target),
      file_path: target,
      sha256: deliveredHash,
      bytes_written: bytes.byteLength,
    };
  }
}
