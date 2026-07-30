import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChangesetManifest, ChangesetManifestEntry } from '../changeset-manifest';
import { artifactTargetPath, readArtifactBytes, sha256 } from '../artifact-content';

export interface DeliverArtifactInput {
  manifest: ChangesetManifest;
}

export interface DeliveredChangesetFile {
  artifact_ref: string;
  relative_path: string;
  file_path: string;
  sha256: string;
  bytes_written: number;
}

export interface DeliverArtifactResult {
  manifest_id: string;
  idempotency_key: string;
  workspace_path: string;
  files: DeliveredChangesetFile[];
  artifact_ref?: string;
  relative_path?: string;
  file_path?: string;
  sha256?: string;
  bytes_written?: number;
}

export class DeliverArtifactHandler {
  async execute(input: DeliverArtifactInput): Promise<DeliverArtifactResult> {
    const workspacePath = input.manifest.paths.user_workspace_path;
    if (!workspacePath) {
      throw new Error('ChangesetManifest has no user workspace delivery target');
    }
    const receipt = await readReceipt(input.manifest.paths.delivery_receipt_path);
    if (receipt) {
      if (receipt.manifest_id !== input.manifest.manifest_id) {
        throw new Error('Delivery receipt belongs to a different ChangesetManifest');
      }
      return receipt;
    }

    const files: DeliveredChangesetFile[] = [];
    for (const entry of input.manifest.entries) {
      const delivered = await deliverEntry(workspacePath, entry);
      if (delivered) files.push(delivered);
    }
    const first = files[0];
    const result: DeliverArtifactResult = {
      manifest_id: input.manifest.manifest_id,
      idempotency_key: `deliver:${input.manifest.manifest_id}`,
      workspace_path: workspacePath,
      files,
      ...(first
        ? {
            artifact_ref: first.artifact_ref,
            relative_path: first.relative_path,
            file_path: first.file_path,
            sha256: first.sha256,
            bytes_written: first.bytes_written,
          }
        : {}),
    };
    await fs.mkdir(path.dirname(input.manifest.paths.delivery_receipt_path), {
      recursive: true,
    });
    await fs.writeFile(
      input.manifest.paths.delivery_receipt_path,
      JSON.stringify(result, null, 2),
      'utf-8',
    );
    return result;
  }
}

async function deliverEntry(
  workspacePath: string,
  entry: ChangesetManifestEntry,
): Promise<DeliveredChangesetFile | undefined> {
  if (entry.delivery_strategy === 'metadata_only' || entry.delivery_strategy === 'apply_patch') {
    return undefined;
  }
  const relativePath = entry.relative_paths[0];
  if (!relativePath) {
    throw new Error(`Changeset entry ${entry.entry_id} has no delivery path`);
  }
  const target = entry.artifact_ref
    ? artifactTargetPath(workspacePath, entry.artifact_ref)
    : safeTargetPath(workspacePath, relativePath);
  let bytesWritten = 0;
  if (entry.delivery_strategy === 'copy_file') {
    if (!entry.artifact_ref) {
      throw new Error(`Changeset entry ${entry.entry_id} has no artifact content`);
    }
    const bytes = await readArtifactBytes(entry.artifact_ref);
    const artifactHash = sha256(bytes);
    if (artifactHash !== entry.sha256) {
      throw new Error(
        `Changeset entry ${entry.entry_id} SHA256 mismatch: expected ${entry.sha256}, got ${artifactHash}`,
      );
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    bytesWritten = bytes.byteLength;
  }
  const deliveredHash = sha256(await fs.readFile(target));
  if (deliveredHash !== entry.sha256) {
    throw new Error(
      `Workspace file SHA256 mismatch: expected ${entry.sha256}, got ${deliveredHash}`,
    );
  }
  return {
    artifact_ref: entry.artifact_id,
    relative_path: path.relative(path.resolve(workspacePath), target),
    file_path: target,
    sha256: deliveredHash,
    bytes_written: bytesWritten,
  };
}

async function readReceipt(filePath: string): Promise<DeliverArtifactResult | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as DeliverArtifactResult;
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? Reflect.get(error, 'code')
        : undefined;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

function safeTargetPath(workspacePath: string, relativePath: string): string {
  const root = path.resolve(workspacePath);
  const target = path.resolve(root, relativePath);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Changeset target escapes workspace: ${relativePath}`);
  }
  return target;
}
