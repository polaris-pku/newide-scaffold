/**
 * `activity` 投影测试。
 *
 * 除了映射本身，这里守两件容易出错的事：
 * 1. **没有在飞状态时返回 `undefined`**，让 `activity` 整个字段缺席——不给 `idle`。
 *    进程活着但不在状态点里，与「状态点漏了」从这一份数据上分不出来。
 * 2. **投影输出必须真的能被协议 schema 解析**。投影与 schema 在两个模块里，最容易发生的
 *    漂移就是这边加了个字段、那边没跟上——用一个 parse 把两边钉在一起。
 */
import { describe, expect, it } from 'vitest';
import { projectRunActivity } from '../../src/app/run-activity-projection';
import { runActivitySchema } from '../../src/protocol/run-snapshot';
import type { AgentActivity } from '../../src/telemetry';

function activity(overrides: Partial<AgentActivity> & { role_id: string }): AgentActivity {
  return {
    run_id: 'run_1',
    kind: 'awaiting_llm',
    since: '2026-10-03T00:00:00.000Z',
    seq: 1,
    ...overrides,
  };
}

describe('projectRunActivity', () => {
  it('maps the telemetry kinds onto the display states', () => {
    const projected = projectRunActivity([
      activity({ role_id: 'role_a', kind: 'awaiting_llm' }),
      activity({ role_id: 'role_b', kind: 'invoking_driver', tool_name: 'invoke_driver', seq: 2 }),
    ]);

    expect(projected).toMatchObject({
      subject: 'agent',
      agents: [
        { role_id: 'role_a', state: 'thinking', seq: 1 },
        { role_id: 'role_b', state: 'delegating', tool_name: 'invoke_driver', seq: 2 },
      ],
    });
  });

  it('omits the whole field when nothing is in flight, instead of claiming idle', () => {
    expect(projectRunActivity([])).toBeUndefined();
  });

  it('keeps every concurrent council seat instead of collapsing to one', () => {
    const projected = projectRunActivity([
      activity({ role_id: 'role_c', seq: 3 }),
      activity({ role_id: 'role_a', seq: 1 }),
      activity({ role_id: 'role_b', seq: 2 }),
    ]);

    // 顺带断言顺序稳定：并发席位的写入顺序是调度产物，直接透传会让快照不可比。
    expect(projected?.agents.map((entry) => entry.role_id)).toEqual([
      'role_a',
      'role_b',
      'role_c',
    ]);
  });

  it('is deterministic regardless of input order', () => {
    const a = activity({ role_id: 'role_a' });
    const b = activity({ role_id: 'role_b' });
    expect(projectRunActivity([a, b])).toEqual(projectRunActivity([b, a]));
  });

  it('marks a state as stale once it has been sitting there too long', () => {
    const projected = projectRunActivity([activity({ role_id: 'role_a' })], {
      now: new Date('2026-10-03T00:00:05.000Z'),
    });
    expect(projected?.agents[0]?.stale).toBe(false);

    const later = projectRunActivity([activity({ role_id: 'role_a' })], {
      now: new Date('2026-10-03T00:00:05.000Z'),
      staleAfterMs: 1_000,
    });
    expect(later?.agents[0]?.stale).toBe(true);
  });

  it('leaves round and tool_name absent when the state point did not know them', () => {
    const projected = projectRunActivity([activity({ role_id: 'role_a' })]);
    expect(projected?.agents[0]).not.toHaveProperty('round');
    expect(projected?.agents[0]).not.toHaveProperty('tool_name');
  });

  it('carries the round when the state point had one', () => {
    const projected = projectRunActivity([activity({ role_id: 'role_a', round: 0 })]);
    expect(projected?.agents[0]?.round).toBe(0);
  });

  it('produces output the protocol schema accepts (drift guard)', () => {
    const projected = projectRunActivity(
      [
        activity({ role_id: 'role_a', round: 0 }),
        activity({ role_id: 'role_b', kind: 'invoking_driver', tool_name: 'invoke_driver', seq: 2 }),
      ],
      { now: new Date('2026-10-03T00:00:00.000Z') },
    );

    // 投影与 schema 分居两个模块，用一次 parse 把两边钉在一起。
    expect(runActivitySchema.parse(projected)).toEqual(projected);
  });

  it('rejects a state the contract does not declare (no producer, no enum value)', () => {
    expect(
      runActivitySchema.safeParse({
        subject: 'agent',
        agents: [{ role_id: 'role_a', state: 'idle', since: 'T', seq: 1, stale: false }],
      }).success,
    ).toBe(false);
  });
});

describe('projectRunActivity —— driver 半边挂进对应席位', () => {
  it('attaches the driver state to the seat that is driving it', () => {
    const projected = projectRunActivity(
      [
        activity({ role_id: 'role_a', kind: 'invoking_driver', tool_name: 'invoke_driver' }),
        activity({ role_id: 'role_b', kind: 'awaiting_llm', seq: 2 }),
      ],
      {
        now: new Date('2026-10-03T00:00:10.000Z'),
        driver_events: [
          driverEvent('driver.turn_started', 'role_a', '2026-10-03T00:00:00.000Z'),
          driverEvent('driver.tool_started', 'role_a', '2026-10-03T00:00:05.000Z', {
            tool_call_id: 'tc_1',
            tool_name: 'Edit',
            kind: 'edit',
            title: 'Edit src/a.ts',
          }),
        ],
      },
    );

    expect(projected?.agents[0]).toMatchObject({
      role_id: 'role_a',
      state: 'delegating',
      driver: {
        state: 'tool_running',
        since: '2026-10-03T00:00:05.000Z',
        last_event_at: '2026-10-03T00:00:05.000Z',
        stale: false,
        tool_call_id: 'tc_1',
        tool_name: 'Edit',
        tool_kind: 'edit',
        tool_title: 'Edit src/a.ts',
      },
    });
    // 没在驱动 driver 的席位不该凭空多出一个 driver 字段。
    expect(projected?.agents[1]).not.toHaveProperty('driver');
  });

  it('omits the driver half without a live event stream, but keeps the agent half', () => {
    const projected = projectRunActivity([
      activity({ role_id: 'role_a', kind: 'invoking_driver', tool_name: 'invoke_driver' }),
    ]);

    expect(projected?.agents[0]?.state).toBe('delegating');
    expect(projected?.agents[0]).not.toHaveProperty('driver');
  });

  it('clears the driver half as soon as the seat goes back to thinking (§4.2 父子一致性)', () => {
    const driverEvents = [
      driverEvent('driver.turn_started', 'role_a', '2026-10-03T00:00:00.000Z'),
      driverEvent('driver.tool_started', 'role_a', '2026-10-03T00:00:05.000Z', {
        tool_call_id: 'tc_1',
        tool_name: 'Edit',
      }),
    ];
    const now = new Date('2026-10-03T00:00:10.000Z');

    // 委派中：driver 半边在。
    const delegating = projectRunActivity(
      [activity({ role_id: 'role_a', kind: 'invoking_driver', tool_name: 'invoke_driver' })],
      { now, driver_events: driverEvents },
    );
    expect(delegating?.agents[0]?.driver).toMatchObject({ tool_name: 'Edit' });

    // 同一批事件、同一个席位，只是 agent 回到自主思考：必须整组消失，
    // 而不是把上一次的工具名残留在「思考中」旁边。
    const thinking = projectRunActivity([activity({ role_id: 'role_a', kind: 'awaiting_llm' })], {
      now,
      driver_events: driverEvents,
    });
    expect(thinking?.agents[0]?.state).toBe('thinking');
    expect(thinking?.agents[0]).not.toHaveProperty('driver');
  });

  it('ignores driver events for a seat that has no in-flight state point', () => {
    const projected = projectRunActivity([activity({ role_id: 'role_a' })], {
      driver_events: [driverEvent('driver.turn_started', 'role_ghost', '2026-10-03T00:00:01.000Z')],
    });

    expect(projected?.agents).toHaveLength(1);
    expect(projected?.agents[0]).not.toHaveProperty('driver');
  });

  it('produces a driver half the protocol schema accepts (drift guard)', () => {
    const projected = projectRunActivity(
      [activity({ role_id: 'role_a', kind: 'invoking_driver', tool_name: 'invoke_driver' })],
      {
        now: new Date('2026-10-03T00:00:10.000Z'),
        driver_events: [
          driverEvent('driver.turn_started', 'role_a', '2026-10-03T00:00:00.000Z'),
          driverEvent('driver.tool_progress', 'role_a', '2026-10-03T00:00:09.000Z', {
            tool_call_id: 'tc_1',
            status: 'in_progress',
          }),
        ],
      },
    );

    expect(runActivitySchema.parse(projected)).toEqual(projected);
  });
});

function driverEvent(
  type: string,
  roleId: string,
  createdAt: string,
  payload: Record<string, unknown> = {},
): { type: string; payload: Record<string, unknown>; created_at: string } {
  return { type, payload: { role_id: roleId, ...payload }, created_at: createdAt };
}
