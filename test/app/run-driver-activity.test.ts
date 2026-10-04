/**
 * driver 在飞状态的折叠测试。
 *
 * 这里守的是「折出来的到底是什么」，五件事最容易错：
 * 1. **按 `role_id` 归属**——council 并发席位不能互相覆盖，没有 `role_id` 的事件不猜归属；
 * 2. **状态与活性分开**——`since` 是状态起点，`last_event_at` 含 chunk；片段一直在流就算
 *    活着，哪怕在同一个工具上待了很久；
 * 3. **turn 收尾不是状态**——`turn_completed` / `turn_failed` 让状态消失，而不是变成某个
 *    「空闲」值；
 * 4. **`disconnected` 是状态**（实测它是异常而不是正常收尾），且不被后续 phase/chunk 冲掉；
 * 5. **部分更新要叠加**——`tool_progress` 不能把 `tool_started` 带出来的名字冲掉，但换了
 *    工具就不能把上一个工具的名字带过来。
 */
import { describe, expect, it } from 'vitest';
import { projectDriverActivityByRole } from '../../src/app/run-driver-activity';

const T0 = '2026-10-03T00:00:00.000Z';

function event(
  type: string,
  at: string,
  payload: Record<string, unknown> = {},
  /** 传 `null` 表示**没有** `role_id`（不能用 `undefined`：那会触发默认值）。 */
  roleId: string | null = 'role_a',
): { type: string; payload: Record<string, unknown>; created_at: string } {
  return {
    type,
    payload: { ...(roleId === null ? {} : { role_id: roleId }), ...payload },
    created_at: at,
  };
}

function fold(
  events: Parameters<typeof projectDriverActivityByRole>[0],
  now = new Date(T0),
): ReturnType<typeof projectDriverActivityByRole> {
  return projectDriverActivityByRole(events, { now, staleAfterMs: 60_000 });
}

describe('projectDriverActivityByRole', () => {
  it('folds a started turn into turn_running', () => {
    expect(fold([event('driver.turn_started', T0)]).get('role_a')).toMatchObject({
      state: 'turn_running',
      since: T0,
      last_event_at: T0,
      stale: false,
    });
  });

  it('folds a started tool into tool_running with only the identity fields', () => {
    const entry = fold([
      event('driver.turn_started', T0),
      event('driver.tool_started', '2026-10-03T00:00:05.000Z', {
        tool_call_id: 'tc_1',
        tool_name: 'Edit',
        kind: 'edit',
        title: 'Edit src/a.ts',
        // 这些都不该出现在契约里：面板要的是「在干什么」，不是「在写什么」。
        raw_input: { path: 'src/a.ts' },
        raw_output: { ok: true },
        content: [{ type: 'diff' }],
        locations: [{ path: 'src/a.ts' }],
      }),
    ]).get('role_a');

    expect(entry).toEqual({
      state: 'tool_running',
      since: '2026-10-03T00:00:05.000Z',
      last_event_at: '2026-10-03T00:00:05.000Z',
      stale: false,
      tool_call_id: 'tc_1',
      tool_name: 'Edit',
      tool_kind: 'edit',
      tool_title: 'Edit src/a.ts',
    });
  });

  it('merges a partial tool update instead of losing the identity from tool_started', () => {
    const entry = fold([
      event('driver.tool_started', T0, { tool_call_id: 'tc_1', tool_name: 'Edit', kind: 'edit' }),
      event('driver.tool_progress', '2026-10-03T00:00:03.000Z', {
        tool_call_id: 'tc_1',
        status: 'in_progress',
      }),
    ]).get('role_a');

    expect(entry).toMatchObject({
      state: 'tool_running',
      since: '2026-10-03T00:00:03.000Z',
      tool_call_id: 'tc_1',
      tool_name: 'Edit',
      tool_kind: 'edit',
    });
    // `status` 不是白名单字段，不该漏进契约。
    expect(entry).not.toHaveProperty('status');
  });

  it('drops the previous tool identity when a different tool starts', () => {
    const entry = fold([
      event('driver.tool_started', T0, { tool_call_id: 'tc_1', tool_name: 'Edit', title: 'Edit a' }),
      event('driver.tool_started', '2026-10-03T00:00:04.000Z', {
        tool_call_id: 'tc_2',
        tool_name: 'Bash',
      }),
    ]).get('role_a');

    expect(entry).toMatchObject({ state: 'tool_running', tool_call_id: 'tc_2', tool_name: 'Bash' });
    expect(entry).not.toHaveProperty('tool_title');
  });

  it('goes back to turn_running when the tool finishes', () => {
    const entry = fold([
      event('driver.turn_started', T0),
      event('driver.tool_started', '2026-10-03T00:00:05.000Z', { tool_call_id: 'tc_1' }),
      event('driver.tool_completed', '2026-10-03T00:00:09.000Z', { tool_call_id: 'tc_1' }),
    ]).get('role_a');

    expect(entry).toMatchObject({ state: 'turn_running', since: '2026-10-03T00:00:09.000Z' });
    expect(entry).not.toHaveProperty('tool_call_id');
  });

  it('does not invent a turn when a tool finishes with no turn open', () => {
    expect(fold([event('driver.tool_completed', T0, { tool_call_id: 'tc_1' })]).size).toBe(0);
  });

  it('ends the state on turn completion (the outcome lives in the event stream, not here)', () => {
    for (const terminal of ['driver.turn_completed', 'driver.turn_failed']) {
      const folded = fold([event('driver.turn_started', T0), event(terminal, '2026-10-03T00:01:00.000Z')]);
      expect(folded.size).toBe(0);
    }
  });

  it('reports disconnect as a state of its own', () => {
    expect(fold([event('driver.disconnected', T0, { code: 1 }) ]).get('role_a')).toMatchObject({
      state: 'disconnected',
      since: T0,
    });
  });

  it('keeps disconnect until a real turn starts again (phases and chunks are only liveness)', () => {
    const entry = fold([
      event('driver.disconnected', T0),
      event('driver.phase', '2026-10-03T00:00:30.000Z', { phase: 'session', boundary: 'started' }),
    ]).get('role_a');

    expect(entry).toMatchObject({
      state: 'disconnected',
      since: T0,
      last_event_at: '2026-10-03T00:00:30.000Z',
    });

    const restarted = fold([
      event('driver.disconnected', T0),
      event('driver.phase', '2026-10-03T00:00:30.000Z', { phase: 'session' }),
      event('driver.turn_started', '2026-10-03T00:00:31.000Z'),
    ]).get('role_a');
    expect(restarted).toMatchObject({ state: 'turn_running', since: '2026-10-03T00:00:31.000Z' });
  });

  it('treats chunks as liveness so a long tool call is not reported stale while it streams', () => {
    const entry = fold([
      event('driver.turn_started', T0),
      event('driver.tool_started', '2026-10-03T00:00:01.000Z', { tool_call_id: 'tc_1' }),
      event('driver.agent_thought_chunk', '2026-10-03T00:02:20.000Z', { content: 'x' }),
    ]).get('role_a');

    // 状态还是两分二十秒前那个工具，但 driver 一直在流片段 → 不算陈旧。
    expect(entry).toMatchObject({
      state: 'tool_running',
      since: '2026-10-03T00:00:01.000Z',
      last_event_at: '2026-10-03T00:02:20.000Z',
      stale: false,
    });
  });

  it('marks the state stale off last_event_at, not off since', () => {
    const entry = fold(
      [
        event('driver.turn_started', T0),
        event('driver.tool_started', '2026-10-03T00:00:01.000Z', { tool_call_id: 'tc_1' }),
        event('driver.usage_updated', '2026-10-03T00:05:00.000Z', { used: 1, size: 2 }),
      ],
      // 距最后一条事件 90s > 60s 阈值；但距 `since`(00:00:01) 更远也一样，
      // 所以这个用例真正钉的是下面那条「片段在流就不算陈旧」。
      new Date('2026-10-03T00:06:30.000Z'),
    ).get('role_a');

    expect(entry).toMatchObject({ stale: true, last_event_at: '2026-10-03T00:05:00.000Z' });
  });

  it('keeps concurrent seats apart instead of collapsing to the last writer', () => {
    const folded = fold([
      event('driver.turn_started', T0, {}, 'role_a'),
      event('driver.turn_started', T0, {}, 'role_b'),
      event('driver.tool_started', '2026-10-03T00:00:05.000Z', { tool_name: 'Bash' }, 'role_b'),
    ]);

    expect([...folded.keys()].sort()).toEqual(['role_a', 'role_b']);
    expect(folded.get('role_a')?.state).toBe('turn_running');
    expect(folded.get('role_b')).toMatchObject({ state: 'tool_running', tool_name: 'Bash' });
  });

  it('does not attribute an event with no role_id to any seat', () => {
    expect(fold([event('driver.turn_started', T0, {}, null)]).size).toBe(0);
  });

  it('ignores non-driver events entirely', () => {
    const folded = fold([
      event('handler.started', T0, { cursor: 'execute_agent' }),
      event('proxy.llm_usage_recorded', '2026-10-03T00:00:02.000Z', { input_tokens: 1 }),
    ]);

    expect(folded.size).toBe(0);
  });

  it('does not create a state out of liveness alone', () => {
    expect(fold([event('driver.agent_message_chunk', T0, { content: 'x' })]).size).toBe(0);
  });
});
