import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CompositeTelemetrySink,
  JsonlTelemetrySink,
} from '../../src/telemetry/jsonl-telemetry-sink';
import { createTelemetryRecord } from '../../src/telemetry/telemetry-sink';
import { requireTelemetryCatalogEntry } from '../../src/telemetry/event-catalog';

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
