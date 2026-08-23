import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ArtifactRef } from '../core';
import { readArtifactContentBytes, sha256 } from '../coordinator/artifact-content';

const MAX_CONTENT_BYTES = 1024 * 1024;

export interface RunArtifactContent {
  run_id: string;
  artifact_id: string;
  type: string;
  media_type: string;
  target_path?: string;
  sha256: string;
  content: string;
  bytes_total: number;
  truncated: boolean;
}

export interface RunArtifactContentReader {
  read(runId: string, artifactId: string): Promise<RunArtifactContent>;
}

export class RunArtifactNotFoundError extends Error {
  constructor(
    readonly runId: string,
    readonly artifactId: string,
  ) {
    super(`Artifact ${artifactId} was not found in Run ${runId}`);
    this.name = 'RunArtifactNotFoundError';
  }
}

export class RunArtifactContentUnavailableError extends Error {
  constructor(
    readonly runId: string,
    readonly artifactId: string,
    readonly reason: string,
  ) {
    super(`Artifact ${artifactId} content is unavailable: ${reason}`);
    this.name = 'RunArtifactContentUnavailableError';
  }
}

export class FileRunArtifactContentReader implements RunArtifactContentReader {
  private readonly runsRoot: string;

  constructor(runsRoot = '.newide/runs') {
    this.runsRoot = path.resolve(runsRoot);
  }

  async read(runId: string, artifactId: string): Promise<RunArtifactContent> {
    assertIdentifier('run_id', runId);
    assertIdentifier('artifact_id', artifactId);
    const statePath = path.join(this.runsRoot, runId, 'production-stage-state.json');
    let state: unknown;
    try {
      state = JSON.parse(await fs.readFile(statePath, 'utf8')) as unknown;
    } catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') {
        throw new RunArtifactNotFoundError(runId, artifactId);
      }
      throw error;
    }
    const artifact = findArtifact(state, artifactId);
    if (!artifact) throw new RunArtifactNotFoundError(runId, artifactId);
    let bytes: Buffer;
    try {
      bytes = await readArtifactContentBytes(artifact);
    } catch (error) {
      throw new RunArtifactContentUnavailableError(
        runId,
        artifactId,
        error instanceof Error ? error.message : String(error),
      );
    }
    const truncated = bytes.byteLength > MAX_CONTENT_BYTES;
    const visible = truncated ? bytes.subarray(0, MAX_CONTENT_BYTES) : bytes;
    return {
      run_id: runId,
      artifact_id: artifact.artifact_id,
      type: artifact.type,
      media_type: artifact.content?.media_type ?? 'text/plain; charset=utf-8',
      ...(artifact.content?.target_path
        ? { target_path: artifact.content.target_path }
        : {}),
      sha256: artifact.sha256 ?? sha256(bytes),
      content: visible.toString('utf8'),
      bytes_total: bytes.byteLength,
      truncated,
    };
  }
}

function findArtifact(value: unknown, artifactId: string): ArtifactRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (isArtifactRef(value) && value.artifact_id === artifactId) return value;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = findArtifact(nested, artifactId);
    if (found) return found;
  }
  return undefined;
}

function isArtifactRef(value: object): value is ArtifactRef {
  const artifactId = Reflect.get(value, 'artifact_id');
  const type = Reflect.get(value, 'type');
  const uri = Reflect.get(value, 'uri');
  const producerId = Reflect.get(value, 'producer_id');
  const createdAt = Reflect.get(value, 'created_at');
  const schemaVersion = Reflect.get(value, 'schema_version');
  return [artifactId, type, uri, producerId, createdAt, schemaVersion].every(
    (item) => typeof item === 'string' && item.length > 0,
  );
}

function assertIdentifier(name: string, value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${name}: ${value}`);
}
