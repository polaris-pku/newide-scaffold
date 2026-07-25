import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TelemetryRecord, TelemetrySink } from './telemetry-sink';

/**
 * Append-only JSONL sink for F-direction eval runs.
 * Each telemetry record is written as one JSON line.
 */
export class JsonlTelemetrySink implements TelemetrySink {
  private initialized = false;

  constructor(private readonly filePath: string) {}

  emit(record: TelemetryRecord): void {
    this.ensureReady();
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  private ensureReady(): void {
    if (this.initialized) {
      return;
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.initialized = true;
  }
}

/**
 * Fan-out sink that forwards each record to multiple sinks.
 */
export class CompositeTelemetrySink implements TelemetrySink {
  constructor(private readonly sinks: TelemetrySink[]) {}

  async emit(record: TelemetryRecord): Promise<void> {
    for (const sink of this.sinks) {
      await sink.emit(record);
    }
  }
}
