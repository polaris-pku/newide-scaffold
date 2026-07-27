import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core';
import {
  buildRunOutputPaths,
  buildRunResultManifest,
  writeIntegrationRunOutputs,
} from '../../src/coordinator/run-result';

const tempDirs: string[] = [];

describe('run-result output writer', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('should build stable run output paths under the run directory', () => {
    expect(buildRunOutputPaths('run_001')).toEqual({
      run_dir: '.newide/runs/run_001',
      result_path: '.newide/runs/run_001/result.json',
      summary_path: '.newide/runs/run_001/summary.json',
      timeline_path: '.newide/runs/run_001/timeline.json',
      checkpoint_path: '.newide/runs/run_001/checkpoint.json',
      message_thread_path: '.newide/runs/run_001/message-thread.json',
      event_log_path: '.newide/runs/run_001/event-log.json',
      audit_path: '.newide/runs/run_001/audit.jsonl',
      frontend_snapshot_path: '.newide/runs/run_001/frontend-snapshot.json',
    });
  });

  it('should write summary, timeline, checkpoint, and result manifest together', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'run-result-'));
    tempDirs.push(tempDir);

    const outputPaths = buildRunOutputPaths('run_001', tempDir);
    const manifest = buildRunResultManifest({
      run_id: 'run_001',
      task_id: 'task_001',
      status: 'completed',
      run_outcome: {
        status: 'best_effort',
        reason: 'Criterion evidence is unavailable.',
        criteria: [],
        gate_result_refs: [],
        artifact_refs: [],
      },
      completion_evaluation: {
        outcome: {
          status: 'best_effort',
          reason: 'Criterion evidence is unavailable.',
          criteria: [],
          gate_result_refs: [],
          artifact_refs: [],
        },
        artifact_manifest: {
          artifact_refs: [],
          changed_files: [],
          response_available: true,
          has_materializable_artifact: false,
          materialization_status: 'completed',
        },
      },
      mode: 'single_agent',
      driver_id: 'mock-driver',
      artifact_outputs: [],
      changed_files: [],
      materialization_status: 'completed',
      materialization_failures: [],
      result_path: outputPaths.result_path,
      summary_path: outputPaths.summary_path,
      timeline_path: outputPaths.timeline_path,
      checkpoint_path: outputPaths.checkpoint_path,
      message_thread_path: outputPaths.message_thread_path,
      event_log_path: outputPaths.event_log_path,
      audit_path: outputPaths.audit_path,
      frontend_snapshot_path: outputPaths.frontend_snapshot_path,
      created_at: '2026-07-07T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    });

    await writeIntegrationRunOutputs({
      paths: outputPaths,
      summary: { run_id: 'run_001' },
      timeline: [{ name: 'RunCompleted', id: 'event_001' }],
      checkpoint: { checkpoint_id: 'checkpoint_001' },
      message_thread: [{ message_id: 'msg_001', type: 'driver.completed' }],
      event_log: [{ event_id: 'event_001', event_type: 'run.completed' }],
      frontend_snapshot: { run_id: 'run_001', current: { stage: 'delivery' } },
      result_manifest: manifest,
    });

    await expect(readJson(outputPaths.summary_path)).resolves.toEqual({ run_id: 'run_001' });
    await expect(readJson(outputPaths.timeline_path)).resolves.toEqual([
      { name: 'RunCompleted', id: 'event_001' },
    ]);
    await expect(readJson(outputPaths.checkpoint_path)).resolves.toEqual({
      checkpoint_id: 'checkpoint_001',
    });
    await expect(readJson(outputPaths.message_thread_path)).resolves.toEqual([
      { message_id: 'msg_001', type: 'driver.completed' },
    ]);
    await expect(readJson(outputPaths.event_log_path)).resolves.toEqual([
      { event_id: 'event_001', event_type: 'run.completed' },
    ]);
    await expect(readJson(outputPaths.frontend_snapshot_path)).resolves.toEqual({
      run_id: 'run_001',
      current: { stage: 'delivery' },
    });
    await expect(readJson(outputPaths.result_path)).resolves.toMatchObject({
      run_id: 'run_001',
      result_path: outputPaths.result_path,
      summary_path: outputPaths.summary_path,
      timeline_path: outputPaths.timeline_path,
      checkpoint_path: outputPaths.checkpoint_path,
      message_thread_path: outputPaths.message_thread_path,
      event_log_path: outputPaths.event_log_path,
      audit_path: outputPaths.audit_path,
      frontend_snapshot_path: outputPaths.frontend_snapshot_path,
    });
  });
});

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}
