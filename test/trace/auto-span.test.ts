import { describe, expect, it } from 'vitest';
import { AutoSpan, withSpan } from '../../src/trace/auto-span';
import { InMemoryTraceStore } from '../../src/trace/trace-store';

describe('AutoSpan', () => {
  it('emits a start record and a closed end record with duration', () => {
    const store = new InMemoryTraceStore();
    let now = 1_000;
    const span = new AutoSpan(store, {
      kind: 'driver.run',
      run_id: 'run_1',
      task_id: 'task_1',
      agent_id: 'agent_a',
      summary: 'dispatch',
      now: () => now,
    });
    now = 2_500;
    const end = span.close('ok', 'succeeded');

    const records = store.list();
    expect(records).toHaveLength(2);
    expect(records[0]!.phase).toBe('start');
    expect(records[1]!.phase).toBe('end');
    expect(records[1]!.span_id).toBe(records[0]!.span_id);
    expect(end.duration_ms).toBe(1500);
    expect(end.status).toBe('ok');
    expect(end.summary).toBe('succeeded');
    expect(end.agent_id).toBe('agent_a');
  });

  it('throws when closed twice', () => {
    const store = new InMemoryTraceStore();
    const span = new AutoSpan(store, { kind: 'gate.eval' });
    span.close();
    expect(() => span.close()).toThrow(/already closed/);
  });

  it('withSpan closes ok on success', async () => {
    const store = new InMemoryTraceStore();
    const result = await withSpan(store, { kind: 'task.run' }, async () => 'value');
    expect(result).toBe('value');
    expect(store.list().map((entry) => entry.status)).toEqual([undefined, 'ok']);
  });

  it('withSpan closes error and rethrows on failure', async () => {
    const store = new InMemoryTraceStore();
    await expect(
      withSpan(store, { kind: 'driver.run' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(store.list()[1]!.status).toBe('error');
  });
});
