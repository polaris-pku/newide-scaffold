import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import type { AppRunSnapshot } from '../../src/app/run-registry';

const tempDirs: string[] = [];

describe('FileRunTerminalOutputWriter', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes queryable failed result, timeline, and frontend snapshot', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const writer = new FileRunTerminalOutputWriter(runsRoot);
    const snapshot = failedSnapshot();

    const evidence = await writer.finalize(snapshot);

    const runDir = path.join(runsRoot, 'run_failed');
    await expect(readJson(path.join(runDir, 'result.json'))).resolves.toMatchObject({
      run_id: 'run_failed',
      task_id: 'task_failed',
      status: 'failed',
      errors: [{ code: 'RUNNER_FAILED', message: 'driver exited' }],
      audit_path: path.join(runDir, 'audit.jsonl'),
    });
    await expect(readJson(path.join(runDir, 'timeline.json'))).resolves.toEqual(snapshot.events);
    await expect(readJson(path.join(runDir, 'frontend-snapshot.json'))).resolves.toMatchObject({
      schema_version: 'v0',
      run_id: 'run_failed',
      task_id: 'task_failed',
      status: 'failed',
      timeline: snapshot.events,
      agent_runs: [],
      artifacts: [],
      gates: [],
      errors: [{ code: 'RUNNER_FAILED', message: 'driver exited' }],
      final_output: { status: 'failed', artifact_refs: [], files_written: [] },
    });
    await expect(readJson(path.join(runDir, 'frontend-snapshot.json'))).resolves.not.toHaveProperty(
      'revision',
    );
    const snapshotBytes = await readFile(path.join(runDir, 'frontend-snapshot.json'));
    expect(evidence).toEqual({
      artifact_ref: expect.stringMatching(/^file:/),
      sha256: createHash('sha256').update(snapshotBytes).digest('hex'),
    });
  });

  it('does not overwrite richer integration outputs', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const runDir = path.join(runsRoot, 'run_failed');
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'result.json'), '{"rich":true}', 'utf-8');

    await new FileRunTerminalOutputWriter(runsRoot).finalize(failedSnapshot());

    await expect(readJson(path.join(runDir, 'result.json'))).resolves.toEqual({ rich: true });
  });

  it('replaces a completed legacy frontend snapshot without replacing its result manifest', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const runDir = path.join(runsRoot, 'run_failed');
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'result.json'), '{"rich":true}', 'utf-8');
    await writeFile(path.join(runDir, 'frontend-snapshot.json'), '{"legacy":true}', 'utf-8');
    const { error: _error, ...withoutError } = failedSnapshot();

    await new FileRunTerminalOutputWriter(runsRoot).finalize({
      ...withoutError,
      status: 'completed',
      current: { stage: 'delivery', active_node_code: 'N18' },
    });

    await expect(readJson(path.join(runDir, 'result.json'))).resolves.toEqual({ rich: true });
    await expect(readJson(path.join(runDir, 'frontend-snapshot.json'))).resolves.toMatchObject({
      status: 'completed',
      timeline: withoutError.events,
      errors: [],
      final_output: { status: 'completed' },
    });
  });
});

function failedSnapshot(): AppRunSnapshot {
  return {
    schema_version: 'v0',
    revision: 1,
    run_id: 'run_failed',
    task_id: 'task_failed',
    status: 'failed',
    mode: 'single_agent',
    current: { stage: 'intervention', active_node_code: 'N18' },
    events: [
      {
        event_id: 'run_event_1',
        sequence: 1,
        run_id: 'run_failed',
        task_id: 'task_failed',
        type: 'run.failed',
        source: 'coordinator',
        created_at: '2026-07-11T08:00:00.000Z',
        payload: { code: 'RUNNER_FAILED' },
        schema_version: 'v0',
      },
    ],
    error: { code: 'RUNNER_FAILED', message: 'driver exited' },
  };
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}
