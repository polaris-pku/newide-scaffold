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

  /**
   * 断线重连的水位。
   *
   * 过去 `run.subscribe` 没有水位，重连只能全量重放 + 靠 `event_id` 去重——
   * 对一个长 run 意味着把所有历史事件（含 driver chunk 洪流）重发一遍。
   */
  it('resumes a subscription from a sequence watermark', () => {
    const registry = new InMemoryRunRegistry();
    registry.create({ run_id: 'run_resume', task_id: 'task_resume', mode: 'single_agent' });
    registry.appendEvent('run_resume', 'run.started', {});
    registry.appendEvent('run_resume', 'handler.started', {
      cursor: 'select_agent',
      invocation_id: 'invocation_1',
    });
    const seen: number[] = [];

    registry.subscribe('run_resume', (event) => seen.push(event.sequence), {
      after_sequence: 1,
    });
    registry.appendEvent('run_resume', 'run.completed', {});

    // 只补 1 之后的事件，再续流；已经收到过的不重复投递。
    expect(seen).toEqual([2, 3]);
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

  /**
   * 存活期 stage 必须随 `handler.*` 事件推进。
   *
   * 过去 `appendEvent` 只更新 `active_node_code`，`current.stage` 自 create 起就不动了，
   * 于是同一个 run 在 registry（落盘 frontend-snapshot.json）与持久投影（run.getSnapshot）
   * 两条路径上给出的 stage 不一致。这几条断言把两条路径的一致性钉住。
   */
  it('advances the live stage from handler events', () => {
    const registry = new InMemoryRunRegistry(() => '2026-07-11T08:00:00.000Z');
    registry.create({ run_id: 'run_stage', task_id: 'task_stage', mode: 'single_agent' });

    expect(registry.getSnapshot('run_stage').current).toEqual({
      stage: 'executing',
      active_node_code: 'N3',
      cursor: 'select_agent',
    });

    registry.appendEvent('run_stage', 'handler.started', {
      cursor: 'execute_agent',
      invocation_id: 'invocation_execute_agent_1',
    });

    expect(registry.getSnapshot('run_stage').current).toEqual({
      stage: 'executing',
      active_node_code: 'N8',
      cursor: 'execute_agent',
      invocation_id: 'invocation_execute_agent_1',
      stage_started_at: '2026-07-11T08:00:00.000Z',
    });

    registry.appendEvent('run_stage', 'handler.completed', {
      cursor: 'execute_agent',
      invocation_id: 'invocation_execute_agent_1',
      next_cursor: 'gate',
    });

    // 游标推进即表示没有调用在跑：invocation 必须被摘掉，而不是留着上一次的值。
    expect(registry.getSnapshot('run_stage').current).toEqual({
      stage: 'delivery',
      active_node_code: 'N13',
      cursor: 'gate',
    });
  });

  it('starts council runs at the select_agent cursor rather than guessing from mode', () => {
    // council 模式也是先走 select_agent 进市场选品，council 是后面从 execute_agent 进的。
    // 按 mode 直接给 'council' 会让存活期与持久投影在 t=0 就不一致。
    const registry = new InMemoryRunRegistry();
    registry.create({ run_id: 'run_council', task_id: 'task_council', mode: 'council' });

    expect(registry.getSnapshot('run_council').current).toMatchObject({
      stage: 'executing',
      active_node_code: 'N3',
      cursor: 'select_agent',
    });
  });

  it('ignores malformed cursor payloads instead of throwing', () => {
    // 读路径宽容：一条脏载荷不该把存活 run 的注册表打挂。
    const registry = new InMemoryRunRegistry();
    registry.create({ run_id: 'run_dirty', task_id: 'task_dirty', mode: 'single_agent' });
    registry.appendEvent('run_dirty', 'handler.started', {
      cursor: 'not_a_cursor',
      invocation_id: '',
    });

    expect(registry.getSnapshot('run_dirty').current).toMatchObject({
      stage: 'executing',
      active_node_code: 'N3',
      cursor: 'select_agent',
    });
  });
});
