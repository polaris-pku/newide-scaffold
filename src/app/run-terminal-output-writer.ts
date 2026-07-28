/** Writes fallback terminal artifacts when the integration flow cannot finalize itself. */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppRunSnapshot } from './run-registry';
import { projectRunSnapshot } from './run-snapshot-projector';

export interface RunTerminalOutputWriter {
  finalize(snapshot: AppRunSnapshot): Promise<RunTerminalOutputEvidence | void>;
}

export interface RunTerminalOutputEvidence {
  artifact_ref: string;
  sha256: string;
}

export class FileRunTerminalOutputWriter implements RunTerminalOutputWriter {
  constructor(private readonly runsRoot = '.newide/runs') {}

  async finalize(snapshot: AppRunSnapshot): Promise<RunTerminalOutputEvidence | undefined> {
    if (snapshot.status === 'running') return;
    const runDir = path.join(this.runsRoot, snapshot.run_id);
    await fs.mkdir(runDir, { recursive: true });
    const resultPath = path.join(runDir, 'result.json');
    const timelinePath = path.join(runDir, 'timeline.json');
    const frontendSnapshotPath = path.join(runDir, 'frontend-snapshot.json');

    const fallbackWrites =
      snapshot.status === 'completed'
        ? []
        : [
            writeJsonIfMissing(resultPath, {
              run_id: snapshot.run_id,
              task_id: snapshot.task_id,
              status: snapshot.status,
              mode: snapshot.mode,
              errors: snapshot.error ? [snapshot.error] : [],
              result_path: resultPath,
              timeline_path: timelinePath,
              audit_path: path.join(runDir, 'audit.jsonl'),
              frontend_snapshot_path: frontendSnapshotPath,
              schema_version: snapshot.schema_version,
            }),
            writeJsonIfMissing(timelinePath, snapshot.events),
          ];
    const serializedSnapshot = JSON.stringify(projectRunSnapshot(snapshot), null, 2);
    await Promise.all([
      ...fallbackWrites,
      fs.writeFile(frontendSnapshotPath, serializedSnapshot, 'utf-8'),
    ]);
    return {
      artifact_ref: pathToFileURL(path.resolve(frontendSnapshotPath)).href,
      sha256: createHash('sha256').update(serializedSnapshot).digest('hex'),
    };
  }
}

async function writeJsonIfMissing(filePath: string, value: unknown): Promise<void> {
  try {
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    if (isAlreadyExistsError(error)) return;
    throw error;
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
