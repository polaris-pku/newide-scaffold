import { describe, expect, it } from 'vitest';
import { InMemoryRunRegistry, RunNotFoundError } from '../../src/app/run-registry';

describe('InMemoryRunRegistry', () => {
  it('tracks running state and monotonically sequenced events', () => {
    let eventNumber = 0;
    const registry = new InMemoryRunRegistry(
      () => '2026-07-11T08:00:00.000Z',
      () => `run_event_${++eventNumber}`,
    );
    registry.create({ run_id: 'run_1', task_id: 'task_1', mode: 'single_agent' });
    const seen: number[] = [];
    registry.subscribe('run_1', (event) => seen.push(event.sequence));

    registry.appendEvent('run_1', 'task.created', { task_id: 'task_1' });
    registry.appendEvent('run_1', 'driver.run_result', { status: 'succeeded' });

    expect(registry.getSnapshot('run_1')).toMatchObject({
      revision: 2,
      run_id: 'run_1',
      task_id: 'task_1',
      status: 'running',
      mode: 'single_agent',
      current: { stage: 'executing', active_node_code: 'N8' },
      events: [
        {
          sequence: 1,
          event_id: 'run_event_1',
          task_id: 'task_1',
          type: 'task.created',
          source: 'coordinator',
          schema_version: 'v0',
        },
        {
          sequence: 2,
          event_id: 'run_event_2',
          task_id: 'task_1',
          type: 'driver.run_result',
          source: 'driver',
          schema_version: 'v0',
        },
      ],
    });
    expect(seen).toEqual([1, 2]);
  });

  it('stores completed snapshots and structured failures', () => {
    const registry = new InMemoryRunRegistry(() => '2026-07-11T08:00:00.000Z');
    registry.create({ run_id: 'run_done', task_id: 'task_done', mode: 'single_agent' });
    registry.complete('run_done', { run: { status: 'completed' }, current: { stage: 'delivery' } });
    registry.create({ run_id: 'run_failed', task_id: 'task_failed', mode: 'council' });
    registry.fail('run_failed', 'DRIVER_FAILED', 'Driver process exited');

    expect(registry.getSnapshot('run_done')).toMatchObject({
      status: 'completed',
      current: { stage: 'delivery', active_node_code: 'N18' },
      snapshot: { run: { status: 'completed' } },
      events: [{ sequence: 1, type: 'run.completed' }],
    });
    expect(registry.getSnapshot('run_failed')).toMatchObject({
      status: 'failed',
      current: { stage: 'intervention', active_node_code: 'N18' },
      error: { code: 'DRIVER_FAILED', message: 'Driver process exited' },
      events: [{ sequence: 1, type: 'run.failed' }],
    });
  });

  it('does not duplicate terminal events already observed from the coordinator', () => {
    const registry = new InMemoryRunRegistry();
    registry.create({ run_id: 'run_done', task_id: 'task_done', mode: 'single_agent' });
    registry.appendEvent('run_done', 'run.completed', { status: 'completed' });

    registry.complete('run_done', {
      run: { status: 'completed' },
      current: { stage: 'delivery' },
    });

    expect(
      registry.getSnapshot('run_done').events.filter((event) => event.type === 'run.completed'),
    ).toHaveLength(1);
  });

  it('rejects unknown run ids', () => {
    const registry = new InMemoryRunRegistry();
    expect(() => registry.getSnapshot('missing')).toThrow(RunNotFoundError);
    expect(() => registry.subscribe('missing', () => undefined)).toThrow(RunNotFoundError);
  });

  it('lists cloned snapshots without exposing mutable registry records', () => {
    const registry = new InMemoryRunRegistry();
    registry.create({ run_id: 'run_1', task_id: 'task_1', mode: 'single_agent' });
    registry.create({ run_id: 'run_2', task_id: 'task_2', mode: 'council' });

    const listed = registry.listSnapshots();
    expect(listed.map((snapshot) => snapshot.run_id)).toEqual(['run_1', 'run_2']);
    listed[0]!.current.active_node_code = 'mutated';

    expect(registry.getSnapshot('run_1').current.active_node_code).toBe('N3');
  });

  it('replays existing events before streaming new subscription events', () => {
    const registry = new InMemoryRunRegistry();
    registry.create({ run_id: 'run_replay', task_id: 'task_replay', mode: 'single_agent' });
    registry.appendEvent('run_replay', 'run.started', {});
    const seen: string[] = [];

    registry.subscribe('run_replay', (event) => seen.push(event.type));
    registry.appendEvent('run_replay', 'run.completed', {});

    expect(seen).toEqual(['run.started', 'run.completed']);
  });

  it('aborts and records a running cancellation exactly once', () => {
    const registry = new InMemoryRunRegistry(() => '2026-07-11T08:00:00.000Z');
    const controller = new AbortController();
    registry.create({
      run_id: 'run_cancelled',
      task_id: 'task_cancelled',
      mode: 'single_agent',
      controller,
    });

    expect(registry.cancel('run_cancelled')).toMatchObject({
      status: 'cancelled',
      current: { stage: 'intervention', active_node_code: 'N18' },
      events: [{ sequence: 1, type: 'run.cancelled' }],
    });
    expect(controller.signal.aborted).toBe(true);
    expect(registry.cancel('run_cancelled').events).toHaveLength(1);
  });
});
