/**
 * MaintenanceRunStore 契约测试（Phase 0）
 *
 * 维护 run 是观测与审计实体：谁来跑、跑了什么、结果如何。三种后端（内存 / 文件 /
 * PGlite+PostgreSQL）必须给出同一套行为，否则「积压与失败看板」在不同部署下说的
 * 不是同一件事。矩阵定义在 test/maintenance-adapters.ts，这里跑三遍同一份用例。
 *
 * 覆盖：
 *
 *   start(worker) --> running --finish--> completed
 *                        |
 *                        +---fail------> failed
 *
 *   1. run_id 唯一；重复开同一次运行是错误
 *   2. 计数按字段合并，缺省字段保持原值（不把「没报」读成「归零」）
 *   3. 终态只写一次：收尾过的 run 不被第二次收尾覆盖，并发收尾只有一个成功
 *   4. 过滤 / 排序 / limit（最近 N 条）
 *   5. 持久化后端重启后 run 还在
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * PGlite 是 WASM 引擎：建库本身要一秒起步。整仓并行跑测试时，这份启动成本会挤进
 * 单测默认的 5s 预算，于是整条腿偶发超时（失败者每次都不一样，正是超时的形状）。
 * 这里给本文件放宽超时——测的是契约语义，不是「PGlite 在负载下多久起来」。
 */
vi.setConfig({ testTimeout: 30_000 });
import {
  RUN_STORE_ADAPTERS,
  resetPgMaintenanceTables,
} from './maintenance-adapters';

const tempDirs: string[] = [];

afterEach(async () => {
  await resetPgMaintenanceTables();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'newide-maintenance-run-'));
  tempDirs.push(root);
  return root;
}

/** 固定起点 + 偏移，取代真实时钟 */
const T0 = '2026-01-01T00:00:00.000Z';
function at(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

describe.each(RUN_STORE_ADAPTERS)('$name — 维护 run 契约', ({ create, reopen, durable }) => {
  it('开一条 running 的 run：字段如实，run_id 重复即报错', async () => {
    const store = await create(await tempRoot());
    const run = await store.start({
      job_type: 'context_delivery',
      worker_id: 'worker_a',
      run_id: 'mr_ctx_1',
      now: at(0),
    });

    expect(run).toMatchObject({
      run_id: 'mr_ctx_1',
      job_type: 'context_delivery',
      status: 'running',
      worker_id: 'worker_a',
      started_at: at(0),
      claimed_count: 0,
      completed_count: 0,
      retried_count: 0,
      dead_letter_count: 0,
      skipped_count: 0,
      failure_count: 0,
    });
    expect(run.finished_at).toBeUndefined();

    // 同一次运行被开两遍是错误，不静默覆盖
    await expect(
      store.start({
        job_type: 'context_delivery',
        worker_id: 'worker_a',
        run_id: 'mr_ctx_1',
        now: at(1),
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('缺省 run_id 由实现生成，且两次开的是两条不同的 run', async () => {
    const store = await create(await tempRoot());
    const first = await store.start({ job_type: 'skill_promotion', worker_id: 'w', now: at(0) });
    const second = await store.start({ job_type: 'skill_promotion', worker_id: 'w', now: at(0) });
    expect(first.run_id).not.toBe(second.run_id);
    expect(await store.list({ job_type: 'skill_promotion' })).toHaveLength(2);
  });

  it('finish 收成 completed：计数按字段合并，没报的字段保持原值', async () => {
    const store = await create(await tempRoot());
    await store.start({
      job_type: 'context_delivery',
      worker_id: 'w',
      run_id: 'mr_finish',
      now: at(0),
    });

    const finished = await store.finish('mr_finish', {
      claimed_count: 4,
      completed_count: 3,
      retried_count: 1,
      now: at(5_000),
    });

    expect(finished).toMatchObject({
      status: 'completed',
      started_at: at(0),
      finished_at: at(5_000),
      claimed_count: 4,
      completed_count: 3,
      retried_count: 1,
      // 本次没报的出口保持「没有」，而不是被当成 0 写进去——两者含义不同
      dead_letter_count: 0,
      skipped_count: 0,
      failure_count: 0,
    });
    await expect(store.get('mr_finish')).resolves.toMatchObject({ status: 'completed' });
  });

  it('fail 收成 failed：保留规范化失败码与原因，计数照样合并', async () => {
    const store = await create(await tempRoot());
    await store.start({
      job_type: 'driver_feedback',
      worker_id: 'w',
      run_id: 'mr_fail',
      now: at(0),
    });

    const failed = await store.fail(
      'mr_fail',
      { code: 'downstream_unavailable', message: 'connection refused' },
      { claimed_count: 2, completed_count: 1, failure_count: 1, now: at(1_000) },
    );

    expect(failed).toMatchObject({
      status: 'failed',
      finished_at: at(1_000),
      claimed_count: 2,
      completed_count: 1,
      failure_count: 1,
      last_error: 'downstream_unavailable: connection refused',
    });
  });

  it('终态只写一次：收尾过的 run 不被第二次收尾覆盖', async () => {
    const store = await create(await tempRoot());
    await store.start({
      job_type: 'persona_evolution',
      worker_id: 'w',
      run_id: 'mr_once',
      now: at(0),
    });

    const first = await store.finish('mr_once', { completed_count: 1, now: at(1_000) });
    expect(first?.status).toBe('completed');

    // 第二次收尾（无论换成哪种终局）都写不进去，先到的结论留着
    await expect(store.fail('mr_once', { code: 'unknown', message: 'late' })).resolves.toBeUndefined();
    await expect(store.finish('mr_once', { completed_count: 99, now: at(2_000) })).resolves.toBeUndefined();
    await expect(store.get('mr_once')).resolves.toMatchObject({
      status: 'completed',
      finished_at: at(1_000),
      completed_count: 1,
    });
  });

  it('并发收尾同一个 run：只有一个写成功', async () => {
    const store = await create(await tempRoot());
    await store.start({
      job_type: 'context_delivery',
      worker_id: 'w',
      run_id: 'mr_race',
      now: at(0),
    });

    const [left, right] = await Promise.all([
      store.finish('mr_race', { completed_count: 1, now: at(1_000) }),
      store.finish('mr_race', { completed_count: 2, now: at(1_000) }),
    ]);

    expect([left, right].filter(Boolean)).toHaveLength(1);
    const stored = await store.get('mr_race');
    expect(stored?.status).toBe('completed');
    // 写进去的是赢家的那份计数，不是两次的叠加
    expect([1, 2]).toContain(stored?.completed_count);
  });

  it('get 找不到时返回 undefined；收尾一条不存在的 run 什么都不做', async () => {
    const store = await create(await tempRoot());
    await expect(store.get('mr_missing')).resolves.toBeUndefined();
    await expect(store.finish('mr_missing', { now: at(0) })).resolves.toBeUndefined();
    await expect(
      store.fail('mr_missing', { code: 'unknown', message: 'nope' }),
    ).resolves.toBeUndefined();
  });

  it('list 按 job_type / status / worker_id 过滤，升序返回且 limit 取最近 N 条', async () => {
    const store = await create(await tempRoot());
    for (const [index, job] of (
      ['context_delivery', 'context_delivery', 'driver_feedback'] as const
    ).entries()) {
      await store.start({
        job_type: job,
        worker_id: index === 2 ? 'worker_b' : 'worker_a',
        run_id: `mr_list_${String(index)}`,
        now: at(index * 1_000),
      });
    }
    await store.finish('mr_list_0', { completed_count: 1, now: at(1_500) });

    expect((await store.list()).map((run) => run.run_id)).toEqual([
      'mr_list_0',
      'mr_list_1',
      'mr_list_2',
    ]);
    expect(await store.list({ job_type: 'driver_feedback' })).toHaveLength(1);
    expect(await store.list({ worker_id: 'worker_a' })).toHaveLength(2);
    expect(await store.list({ status: 'completed' })).toHaveLength(1);
    expect(await store.list({ status: 'running' })).toHaveLength(2);
    // limit 截取的是最近的那几条
    expect((await store.list({ limit: 2 })).map((run) => run.run_id)).toEqual([
      'mr_list_1',
      'mr_list_2',
    ]);
  });

  it('持久化后端：重启后 run 还在，且能继续收尾', async () => {
    const root = await tempRoot();
    const store = await create(root);
    await store.start({
      job_type: 'context_delivery',
      worker_id: 'w',
      run_id: 'mr_restart',
      now: at(0),
    });

    const restarted = await reopen(root, store);
    if (!durable) {
      // 内存实现没有持久层，「重启」只是把同一个实例交回来——它不假装持久化，
      // 因此这里不向它索要「重启后还在」，这正是它不该上生产的理由。
      await expect(restarted.get('mr_restart')).resolves.toMatchObject({
        run_id: 'mr_restart',
      });
      return;
    }
    expect(await restarted.get('mr_restart')).toMatchObject({
      status: 'running',
      started_at: at(0),
    });
    await expect(
      restarted.finish('mr_restart', { completed_count: 1, now: at(1_000) }),
    ).resolves.toMatchObject({ status: 'completed', completed_count: 1 });
  });
});
