/**
 * 在飞状态点测试。
 *
 * 核心断言只有一句：**调用进行中**能读到状态，结束后读不到。这正是 `agent.llm_round`
 * 那种「事后 span」做不到的事——span 只能告诉你刚才是多久，说不出此刻在等什么。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginAgentActivity,
  DEFAULT_AGENT_ACTIVITY_STALE_MS,
  endAgentActivity,
  getAgentActivity,
  isAgentActivityStale,
  listAgentActivities,
  resetAgentActivities,
  withAgentActivity,
} from '../../src/telemetry';

afterEach(() => {
  resetAgentActivities();
});

/** 一个可由用例手动放行的门，用来把工作卡在「进行中」。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('agent activity', () => {
  it('exposes the state while the work is in flight and clears it afterwards', async () => {
    const gate = deferred();
    let observedDuringFlight: string[] = [];

    const inFlight = withAgentActivity(
      { run_id: 'run_1', role_id: 'role_a', kind: 'awaiting_llm', round: 0 },
      async () => {
        observedDuringFlight = listAgentActivities('run_1').map((a) => a.kind);
        await gate.promise;
        return 'done';
      },
    );

    // 工作还没结束：状态必须已经在。
    expect(observedDuringFlight).toEqual(['awaiting_llm']);
    expect(getAgentActivity('run_1', 'role_a')).toMatchObject({ kind: 'awaiting_llm', round: 0 });

    gate.resolve();
    await expect(inFlight).resolves.toBe('done');
    // 结束即清空——不清就会让面板永远停在「思考中」。
    expect(listAgentActivities('run_1')).toEqual([]);
  });

  it('clears the state even when the work throws, and rethrows', async () => {
    await expect(
      withAgentActivity({ run_id: 'run_1', role_id: 'role_a', kind: 'invoking_driver' }, async () => {
        throw new Error('driver exploded');
      }),
    ).rejects.toThrow('driver exploded');

    expect(listAgentActivities('run_1')).toEqual([]);
  });

  it('records nothing when there is no run_id instead of inventing a key', () => {
    beginAgentActivity({ run_id: undefined, role_id: 'role_a', kind: 'awaiting_llm' });
    expect(listAgentActivities()).toEqual([]);
    // 结束时也不该抛。
    expect(() => endAgentActivity({ run_id: undefined, role_id: 'role_a' })).not.toThrow();
  });

  it('keeps concurrent council seats apart by role', () => {
    // 按 run_id 索引会让并发席位互相覆盖，只剩最后一个角色能被看见。
    beginAgentActivity({ run_id: 'run_1', role_id: 'role_a', kind: 'awaiting_llm' });
    beginAgentActivity({ run_id: 'run_1', role_id: 'role_b', kind: 'invoking_driver' });

    const activities = listAgentActivities('run_1');
    expect(activities).toHaveLength(2);
    expect(activities.map((a) => `${a.role_id}:${a.kind}`).sort()).toEqual([
      'role_a:awaiting_llm',
      'role_b:invoking_driver',
    ]);
  });

  it('does not let one run see another run’s state', () => {
    beginAgentActivity({ run_id: 'run_1', role_id: 'role_a', kind: 'awaiting_llm' });
    beginAgentActivity({ run_id: 'run_2', role_id: 'role_a', kind: 'invoking_driver' });

    expect(listAgentActivities('run_1')).toHaveLength(1);
    expect(listAgentActivities('run_2')).toHaveLength(1);
    // 同一个 role 在两个 run 里是不同的键。
    expect(getAgentActivity('run_1', 'role_a')?.kind).toBe('awaiting_llm');
    expect(getAgentActivity('run_2', 'role_a')?.kind).toBe('invoking_driver');
  });

  it('does not collide when ids contain separator-ish characters', () => {
    // 用 NUL 拼键就是为了这个：`:` / `/` 都可能出现在 id 里。
    beginAgentActivity({ run_id: 'run:1', role_id: 'a', kind: 'awaiting_llm' });
    beginAgentActivity({ run_id: 'run', role_id: '1:a', kind: 'invoking_driver' });

    expect(listAgentActivities()).toHaveLength(2);
    expect(getAgentActivity('run:1', 'a')?.kind).toBe('awaiting_llm');
    expect(getAgentActivity('run', '1:a')?.kind).toBe('invoking_driver');
  });

  it('hands out copies so a reader cannot mutate the registry', () => {
    beginAgentActivity({ run_id: 'run_1', role_id: 'role_a', kind: 'awaiting_llm' });
    const [first] = listAgentActivities('run_1');
    first!.kind = 'invoking_driver';

    expect(getAgentActivity('run_1', 'role_a')?.kind).toBe('awaiting_llm');
  });

  it('reports staleness instead of silently clearing it', () => {
    const since = '2026-10-03T00:00:00.000Z';
    const base = { since };
    expect(isAgentActivityStale(base, new Date('2026-10-03T00:00:30.000Z'))).toBe(false);
    expect(
      isAgentActivityStale(
        base,
        new Date('2026-10-03T00:00:30.000Z'),
        DEFAULT_AGENT_ACTIVITY_STALE_MS,
      ),
    ).toBe(false);
    expect(isAgentActivityStale(base, new Date('2026-10-03T00:01:01.000Z'))).toBe(true);
    // 时间戳不可解析时按陈旧处理：宁可显示「无进展」，也不要假装它在动。
    expect(isAgentActivityStale({ since: 'not-a-date' })).toBe(true);
  });

  it('overwrites the same key so the state always reflects the latest phase', () => {
    beginAgentActivity({ run_id: 'run_1', role_id: 'role_a', kind: 'awaiting_llm' });
    beginAgentActivity({ run_id: 'run_1', role_id: 'role_a', kind: 'invoking_driver' });

    expect(listAgentActivities('run_1')).toHaveLength(1);
    expect(getAgentActivity('run_1', 'role_a')?.kind).toBe('invoking_driver');
  });

  it('records the entry timestamp for the reader', () => {
    const now = vi.fn(() => '2026-10-03T00:00:00.000Z');
    beginAgentActivity({ run_id: 'run_1', role_id: 'role_a', kind: 'awaiting_llm' }, now);
    expect(now).toHaveBeenCalledTimes(1);
    expect(getAgentActivity('run_1', 'role_a')?.since).toBe('2026-10-03T00:00:00.000Z');
  });
});
