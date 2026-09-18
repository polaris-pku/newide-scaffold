import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CompositeTelemetrySink,
  FileRunTelemetryJsonlSink,
  JsonlTelemetrySink,
  createTelemetryRecord,
  requireTelemetryCatalogEntry,
} from '../../src/telemetry';

describe('JsonlTelemetrySink', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends telemetry records as jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-jsonl-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'nested', 'telemetry.jsonl');
    const sink = new JsonlTelemetrySink(filePath);
    const record = createTelemetryRecord(
      {
        event_type: 'harness.swe_evo_evaluated',
        subject_id: 'instance_1',
        payload: { resolved: true },
      },
      requireTelemetryCatalogEntry('harness.swe_evo_evaluated'),
    );

    sink.emit(record);

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event_type: 'harness.swe_evo_evaluated',
      subject_id: 'instance_1',
    });
  });

  it('forwards records through CompositeTelemetrySink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'f-eval-composite-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'telemetry.jsonl');
    const records: string[] = [];
    const sink = new CompositeTelemetrySink([
      new JsonlTelemetrySink(filePath),
      {
        emit(record) {
          records.push(record.event_type);
        },
      },
    ]);
    const record = createTelemetryRecord(
      {
        event_type: 'harness.swe_evo_evaluated',
        subject_id: 'instance_1',
        payload: {},
      },
      requireTelemetryCatalogEntry('harness.swe_evo_evaluated'),
    );

    return sink.emit(record).then(() => {
      expect(records).toEqual(['harness.swe_evo_evaluated']);
      expect(readFileSync(filePath, 'utf-8')).toContain('harness.swe_evo_evaluated');
    });
  });
});

describe('FileRunTelemetryJsonlSink', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'newide-run-telemetry-'));
    tempDirs.push(dir);
    return dir;
  }

  /** 真实生产记录类型：run 归属来自 ledger，payload 自由。 */
  function usageRecord(runId?: string) {
    return createTelemetryRecord(
      {
        event_type: 'proxy.llm_usage_recorded',
        subject_id: 'usage_1',
        ...(runId ? { run_id: runId } : {}),
        payload: { input_tokens: 12, output_tokens: 3 },
      },
      requireTelemetryCatalogEntry('proxy.llm_usage_recorded'),
    );
  }

  function readLines(filePath: string): Array<Record<string, unknown>> {
    return readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('routes each record into its own run directory', () => {
    const root = createRoot();
    const sink = new FileRunTelemetryJsonlSink(root);

    sink.emit(usageRecord('run_a'));
    sink.emit(usageRecord('run_a'));
    sink.emit(usageRecord('run_b'));

    // 按 run 分目录是这类 sink 与 JsonlTelemetrySink 的唯一区别，所以两件事都要守：
    // 文件落在 <root>/<run_id>/ 下，且不同 run 的记录不串文件。
    expect(readLines(join(root, 'run_a', 'telemetry.jsonl'))).toHaveLength(2);
    const runB = readLines(join(root, 'run_b', 'telemetry.jsonl'));
    expect(runB).toHaveLength(1);
    expect(runB[0]).toMatchObject({
      event_type: 'proxy.llm_usage_recorded',
      run_id: 'run_b',
      payload: { input_tokens: 12, output_tokens: 3 },
    });
  });

  it('drops records without a run id instead of guessing a directory', () => {
    const root = createRoot();

    new FileRunTelemetryJsonlSink(root).emit(usageRecord());

    expect(existsSync(join(root, 'undefined'))).toBe(false);
    expect(existsSync(join(root, 'telemetry.jsonl'))).toBe(false);
  });

  it('keeps the run alive when the run directory cannot be created', () => {
    const root = createRoot();
    // 用文件占住 <root>/<run_id>，让 mkdir 必失败。
    writeFileSync(join(root, 'run_blocked'), 'not a directory');

    const sink = new FileRunTelemetryJsonlSink(root);
    expect(() => sink.emit(usageRecord('run_blocked'))).not.toThrow();
    // 同一个 run 不再重试：观测写不进去不该反复拖慢被测的 run。
    expect(() => sink.emit(usageRecord('run_blocked'))).not.toThrow();
  });
});
