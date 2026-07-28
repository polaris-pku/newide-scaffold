import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TaskResumeCursor } from './coordination-state-store';

export interface RunStageEvidenceInput {
  run_id: string;
  stage: TaskResumeCursor;
  evidence: Record<string, unknown>;
}

export interface RunStageEvidenceReference {
  uri: string;
  sha256: string;
}

export interface RunStageEvidence extends RunStageEvidenceReference {
  evidence: Record<string, unknown>;
}

export interface RunEvidenceStore {
  writeStage(input: RunStageEvidenceInput): Promise<RunStageEvidenceReference>;
  writeFailure(input: RunStageEvidenceInput): Promise<RunStageEvidenceReference>;
  readStage(
    input: Pick<RunStageEvidenceInput, 'run_id' | 'stage'>,
  ): Promise<RunStageEvidence | undefined>;
  readFailure(
    input: Pick<RunStageEvidenceInput, 'run_id' | 'stage'>,
  ): Promise<RunStageEvidence | undefined>;
}

export interface FileRunEvidenceStoreOptions {
  /** Root corresponding to `.newide/runs`. */
  root: string;
}

export class FileRunEvidenceStore implements RunEvidenceStore {
  private readonly root: string;

  constructor(options: FileRunEvidenceStoreOptions) {
    this.root = path.resolve(options.root);
  }

  async writeStage(input: RunStageEvidenceInput): Promise<RunStageEvidenceReference> {
    return this.writeEvidence(input, 'result');
  }

  async writeFailure(input: RunStageEvidenceInput): Promise<RunStageEvidenceReference> {
    return this.writeEvidence(input, 'failure');
  }

  async readStage(
    input: Pick<RunStageEvidenceInput, 'run_id' | 'stage'>,
  ): Promise<RunStageEvidence | undefined> {
    return this.readEvidence(input, 'result');
  }

  async readFailure(
    input: Pick<RunStageEvidenceInput, 'run_id' | 'stage'>,
  ): Promise<RunStageEvidence | undefined> {
    return this.readEvidence(input, 'failure');
  }

  private async writeEvidence(
    input: RunStageEvidenceInput,
    kind: 'result' | 'failure',
  ): Promise<RunStageEvidenceReference> {
    const target = this.stagePath(input.run_id, input.stage, kind);
    const serialized = JSON.stringify(input.evidence, null, 2);
    if (serialized === undefined) throw new Error('Stage evidence must be JSON serializable');
    const bytes = Buffer.from(`${serialized}\n`, 'utf8');
    await fs.mkdir(path.dirname(target), { recursive: true });

    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }

    return { uri: pathToFileURL(target).href, sha256: hash(bytes) };
  }

  private async readEvidence(
    input: Pick<RunStageEvidenceInput, 'run_id' | 'stage'>,
    kind: 'result' | 'failure',
  ): Promise<RunStageEvidence | undefined> {
    const target = this.stagePath(input.run_id, input.stage, kind);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(target);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }

    return {
      evidence: JSON.parse(bytes.toString('utf8')) as Record<string, unknown>,
      uri: pathToFileURL(target).href,
      sha256: hash(bytes),
    };
  }

  private stagePath(
    runId: string,
    stage: TaskResumeCursor,
    kind: 'result' | 'failure',
  ): string {
    assertPathSegment(runId, 'run_id');
    assertPathSegment(stage, 'stage');
    const suffix = kind === 'failure' ? '.failure' : '';
    return path.join(this.root, runId, 'stages', `${stage}${suffix}.json`);
  }
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertPathSegment(value: string, label: string): void {
  if (!value || value === '.' || value === '..' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${label} path segment: ${value}`);
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
