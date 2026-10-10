/**
 * 交付 claim / lease / 重试测试（工作包 C）
 *
 * 两条通道（context / feedback）共用一套状态机，三个适配器（内存 / 文件 /
 * PGlite+PostgreSQL）也必须给出同一套行为——否则测试替身会掩盖生产差异。所以整个
 * 套件按适配器参数化跑三遍，矩阵定义在 test/maintenance-adapters.ts。
 *
 * 覆盖的状态转移：
 *
 *   pending --claim--> processing --complete--> processed
 *                        |  |
 *         fail(retryable) |  | lease 过期
 *                        v  v
 *               pending(next_retry_at) 或 dead_letter --人工 retry--> pending
 *
 * 时间全部由 `now` 显式注入，退避与 lease 的断言不依赖真实时钟。
 * 文件适配器额外覆盖锁文件：冲突时不重复投递、陈旧锁可被接管、崩溃留下的
 * processing 能被启动恢复认领回队列。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * PGlite 是 WASM 引擎：建库本身要一秒起步。整仓并行跑测试时，这份启动成本会挤进
 * 单测默认的 5s 预算，于是整条腿偶发超时（失败者每次都不一样，正是超时的形状）。
 * 这里给本文件放宽超时——测的是契约语义，不是「PGlite 在负载下多久起来」。
 */
vi.setConfig({ testTimeout: 30_000 });
import { FileMemoryDeliveryRepository } from '../adapters/file-memory-delivery';
import {
  buildContextDeliveryItem,
  buildDriverUsageFeedbackRecords,
} from '../services/context-delivery';
import type {
  ClaimedContextDelivery,
  ClaimedDelivery,
  ClaimedDriverFeedback,
  MemoryDeliveryRepository,
} from '../ports/memory-delivery';
import {
  DELIVERY_ADAPTERS,
  insertLegacyContextDeliveryRow,
  resetPgMaintenanceTables,
} from './maintenance-adapters';

const tempDirs: string[] = [];

afterEach(async () => {
  await resetPgMaintenanceTables();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'newide-delivery-claim-'));
  tempDirs.push(root);
  return root;
}

/** 固定起点 + 偏移，取代真实时钟 */
const T0 = '2026-01-01T00:00:00.000Z';
function at(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}
const LEASE = 60_000;

const ROLE = 'role_claim';

function deliveryFor(roleId: string, taskId: string, seq = 1) {
  return buildContextDeliveryItem({
    role_id: roleId,
    task_id: taskId,
    buffer_seq: seq,
    source_driver: 'acp-external',
    context_snapshot_ref: String(seq),
  });
}

function feedbackFor(roleId: string, taskId: string, experienceId: string) {
  const [record] = buildDriverUsageFeedbackRecords({
    role_id: roleId,
    task_id: taskId,
    references: [
      { experience_id: experienceId, applied: true, effectiveness: 'fully_effective', note: 'ok' },
    ],
  });
  return record!;
}

/** 断言并收窄成 context 通道（claim 的判别式断言在各用例里长得一样，抽出来） */
function asContext(claimed: ClaimedDelivery | undefined): ClaimedContextDelivery {
  expect(claimed?.channel).toBe('context');
  return claimed as ClaimedContextDelivery;
}

async function seed(store: MemoryDeliveryRepository, taskId = 'task_1'): Promise<string> {
  await store.ensureAgent(ROLE);
  const item = deliveryFor(ROLE, taskId);
  await store.submitContextDelivery(item);
  return item.delivery_id;
}

function claimOne(
  store: MemoryDeliveryRepository,
  id: string,
  owner: string,
  nowMs: number,
): Promise<ClaimedDelivery | undefined> {
  return store.claimDelivery({
    channel: 'context',
    role_id: ROLE,
    id,
    owner,
    lease_ms: LEASE,
    now: at(nowMs),
  });
}

describe.each(DELIVERY_ADAPTERS)('$name — 交付状态机', ({ create }) => {
  it('两个消费者同时 claim 同一条：只有一个拿到', async () => {
    const store = await create(await tempRoot());
    const id = await seed(store);

    const [first, second] = await Promise.all([
      claimOne(store, id, 'consumer_a', 0),
      claimOne(store, id, 'consumer_b', 0),
    ]);

    const winners = [first, second].filter((claimed) => claimed !== undefined);
    expect(winners).toHaveLength(1);
    expect(asContext(winners[0]).item.status).toBe('processing');
    // 输的那个什么都没写：持有者仍是赢家
    expect(asContext(winners[0]).item.claim_owner).toMatch(/^consumer_[ab]$/);
    expect(asContext(winners[0]).item.attempt_count).toBe(1);
  });

  it('claimNext 只投递一次，且跳过还没到退避时刻的记录', async () => {
    const store = await create(await tempRoot());
    const id = await seed(store);

    const [first, second] = await Promise.all([
      store.claimNextDelivery({ channel: 'context', owner: 'c1', lease_ms: LEASE, now: at(0) }),
      store.claimNextDelivery({ channel: 'context', owner: 'c2', lease_ms: LEASE, now: at(0) }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    // 可重试失败 → 退避窗口内不再被投递
    const failed = asContext(
      await store.failDelivery({
        channel: 'context',
        role_id: ROLE,
        id,
        owner: asContext(first ?? second).item.claim_owner,
        error: 'downstream unavailable',
        retryable: true,
        now: at(0),
      }),
    ).item;
    expect(failed).toMatchObject({ status: 'pending', attempt_count: 1 });
    expect(failed.next_retry_at).toBe(at(1000));

    expect(
      await store.claimNextDelivery({ channel: 'context', owner: 'c3', lease_ms: LEASE, now: at(500) }),
    ).toBeUndefined();
    // 到点即可再次投递
    const retried = asContext(
      await store.claimNextDelivery({ channel: 'context', owner: 'c3', lease_ms: LEASE, now: at(1000) }),
    );
    expect(retried.item).toMatchObject({ status: 'processing', attempt_count: 2 });
  });

  it('lease 过期后回到可投递队列（崩溃恢复），期间不动还活着的 lease', async () => {
    const store = await create(await tempRoot());
    const id = await seed(store);
    asContext(await claimOne(store, id, 'consumer_a', 0));

    // lease 还没到期：恢复流程必须放过它
    expect(
      await store.restoreExpiredDeliveryClaims({ channel: 'context', now: at(59_999) }),
    ).toHaveLength(0);

    const restored = await store.restoreExpiredDeliveryClaims({
      channel: 'context',
      now: at(60_000),
    });
    expect(restored).toHaveLength(1);
    const recovered = asContext(restored[0]).item;
    expect(recovered).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      // 上一次是谁拿着它留着当审计线索；真正表示「现在有人持有」的 lease 已清掉
      claim_owner: 'consumer_a',
      last_error: 'Claim lease expired without completion.',
    });
    expect(recovered.lease_expires_at).toBeUndefined();
    expect(recovered.next_retry_at).toBeUndefined();

    // 过期恢复不套退避：立刻就能被下一个消费者取走
    const reclaimed = asContext(await claimOne(store, id, 'consumer_b', 60_000));
    expect(reclaimed.item).toMatchObject({ status: 'processing', attempt_count: 2 });
  });

  it('连续可重试失败达到上限后进 dead_letter，保留原因与次数', async () => {
    const store = await create(await tempRoot());
    const id = await seed(store);

    let nowMs = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = asContext(await claimOne(store, id, 'consumer', nowMs));
      expect(claimed.item.attempt_count).toBe(attempt);
      const failed = asContext(
        await store.failDelivery({
          channel: 'context',
          role_id: ROLE,
          id,
          owner: 'consumer',
          error: `downstream failed ${String(attempt)}`,
          retryable: true,
          now: at(nowMs),
        }),
      ).item;
      if (attempt < 3) {
        expect(failed.status).toBe('pending');
        nowMs = Date.parse(failed.next_retry_at!) - Date.parse(T0);
      } else {
        expect(failed).toMatchObject({
          status: 'dead_letter',
          attempt_count: 3,
          last_error: 'downstream failed 3',
        });
        expect(failed.next_retry_at).toBeUndefined();
      }
    }

    // 死信不再被投递
    expect(
      await store.claimNextDelivery({
        channel: 'context',
        owner: 'consumer',
        lease_ms: LEASE,
        now: at(nowMs + 10_000_000),
      }),
    ).toBeUndefined();
  });

  it('不可重试的失败直接进 dead_letter，不消耗剩余次数', async () => {
    const store = await create(await tempRoot());
    const id = await seed(store);
    asContext(await claimOne(store, id, 'consumer', 0));

    const failed = asContext(
      await store.failDelivery({
        channel: 'context',
        role_id: ROLE,
        id,
        owner: 'consumer',
        error: 'schema cannot be parsed',
        retryable: false,
        now: at(1_000),
      }),
    ).item;
    expect(failed).toMatchObject({ status: 'dead_letter', attempt_count: 1 });
    expect(failed.last_error).toBe('schema cannot be parsed');
  });

  it('complete 是终止态：不再被投递，也不能再失败或重试', async () => {
    const store = await create(await tempRoot());
    const id = await seed(store);
    asContext(await claimOne(store, id, 'consumer', 0));

    const done = asContext(
      await store.completeDelivery({
        channel: 'context',
        role_id: ROLE,
        id,
        owner: 'consumer',
        processor_version: 'downstream-1.2',
        now: at(1_000),
      }),
    ).item;
    expect(done).toMatchObject({
      status: 'processed',
      attempt_count: 1,
      claim_owner: 'consumer',
      processor_version: 'downstream-1.2',
    });
    expect(done.lease_expires_at).toBeUndefined();

    expect(await claimOne(store, id, 'other', 2_000)).toBeUndefined();
    expect(
      await store.failDelivery({
        channel: 'context',
        role_id: ROLE,
        id,
        error: 'too late',
        retryable: true,
        now: at(2_000),
      }),
    ).toBeUndefined();
    expect(await store.retryDeadLetterDelivery({ channel: 'context', role_id: ROLE, id })).toBeUndefined();
  });

  it('只有持有者能续租与完成，且过期后不再续租', async () => {
    const store = await create(await tempRoot());
    const id = await seed(store);
    asContext(await claimOne(store, id, 'consumer_a', 0));

    expect(
      await store.renewDeliveryClaim({
        channel: 'context',
        role_id: ROLE,
        id,
        owner: 'consumer_b',
        lease_ms: LEASE,
        now: at(1_000),
      }),
    ).toBeUndefined();
    expect(
      await store.completeDelivery({
        channel: 'context',
        role_id: ROLE,
        id,
        owner: 'consumer_b',
        now: at(1_000),
      }),
    ).toBeUndefined();

    const renewed = asContext(
      await store.renewDeliveryClaim({
        channel: 'context',
        role_id: ROLE,
        id,
        owner: 'consumer_a',
        lease_ms: LEASE,
        now: at(30_000),
      }),
    ).item;
    expect(renewed.lease_expires_at).toBe(at(90_000));

    // lease 过期后原持有者不再是持有者，续租必须失败（否则会出现两个消费者同时在写）
    expect(
      await store.renewDeliveryClaim({
        channel: 'context',
        role_id: ROLE,
        id,
        owner: 'consumer_a',
        lease_ms: LEASE,
        now: at(90_000),
      }),
    ).toBeUndefined();
  });

  it('人工 retry 把 dead_letter 放回 pending 并清零次数', async () => {
    const store = await create(await tempRoot());
    const id = await seed(store);
    asContext(await claimOne(store, id, 'consumer', 0));
    asContext(
      await store.failDelivery({
        channel: 'context',
        role_id: ROLE,
        id,
        owner: 'consumer',
        error: 'permanent',
        retryable: false,
        now: at(1_000),
      }),
    );

    const revived = asContext(
      await store.retryDeadLetterDelivery({ channel: 'context', role_id: ROLE, id, now: at(2_000) }),
    ).item;
    expect(revived).toMatchObject({ status: 'pending', attempt_count: 0 });
    expect(revived.last_error).toBeUndefined();

    const reclaimed = asContext(await claimOne(store, id, 'consumer_b', 2_000));
    expect(reclaimed.item.attempt_count).toBe(1);
  });

  it('feedback outbox 走同一套状态机', async () => {
    const store = await create(await tempRoot());
    await store.ensureAgent(ROLE);
    const record = feedbackFor(ROLE, 'task_1', 'exp_1');
    await store.submitDriverFeedback(record);

    const claimed = await store.claimDelivery({
      channel: 'feedback',
      role_id: ROLE,
      id: record.feedback_id,
      owner: 'merger',
      lease_ms: LEASE,
      now: at(0),
    });
    expect(claimed?.channel).toBe('feedback');
    expect((claimed as ClaimedDriverFeedback).item).toMatchObject({
      status: 'processing',
      attempt_count: 1,
    });

    const done = await store.completeDelivery({
      channel: 'feedback',
      role_id: ROLE,
      id: record.feedback_id,
      owner: 'merger',
      now: at(1_000),
    });
    expect(done?.channel).toBe('feedback');
    expect((done as ClaimedDriverFeedback).item.status).toBe('processed');

    // 两条通道互不串味：feedback 的 claim 不会碰到 context 的记录
    expect(await store.listRetryableDeliveries({ now: at(2_000) })).toHaveLength(0);
  });

  it('下游已推进的状态不会被上游重放拽回去', async () => {
    const store = await create(await tempRoot());
    const item = deliveryFor(ROLE, 'task_1');
    await store.ensureAgent(ROLE);
    await store.submitContextDelivery(item);
    asContext(await claimOne(store, item.delivery_id, 'consumer', 0));
    await store.completeDelivery({
      channel: 'context',
      role_id: ROLE,
      id: item.delivery_id,
      owner: 'consumer',
      now: at(1_000),
    });

    const replayed = await store.submitContextDelivery(item);
    expect(replayed.created).toBe(false);
    expect(replayed.item).toMatchObject({ status: 'processed', attempt_count: 1 });
  });

  it('listRetryableDeliveries 只给得到期的那部分', async () => {
    const store = await create(await tempRoot());
    await store.ensureAgent(ROLE);
    await store.submitContextDelivery(deliveryFor(ROLE, 'task_1', 1));
    await store.submitContextDelivery(deliveryFor(ROLE, 'task_2', 2));

    expect(await store.listRetryableDeliveries({ channel: 'context', now: at(0) })).toHaveLength(2);

    const first = asContext(
      await store.claimNextDelivery({ channel: 'context', owner: 'c', lease_ms: LEASE, now: at(0) }),
    ).item;
    await store.failDelivery({
      channel: 'context',
      role_id: ROLE,
      id: first.delivery_id,
      owner: 'c',
      error: 'temporary',
      retryable: true,
      now: at(0),
    });

    const due = await store.listRetryableDeliveries({ channel: 'context', now: at(0) });
    expect(due).toHaveLength(1);
    expect((due[0] as ClaimedContextDelivery).item.delivery_id).not.toBe(first.delivery_id);
  });
});

describe('FileMemoryDeliveryRepository — 锁文件与崩溃', () => {
  async function openStore(root: string): Promise<FileMemoryDeliveryRepository> {
    return new FileMemoryDeliveryRepository({ agentStateRoot: root });
  }

  function recordPath(root: string, id: string): string {
    return join(root, ROLE, 'delivery', 'context', `${id}.json`);
  }

  it('锁被别的进程持有时不重复投递；释放后可正常 claim', async () => {
    const root = await tempRoot();
    const store = await openStore(root);
    const id = await seed(store);

    // 另一个实例（模拟另一进程）先占住这把锁
    const other = new FileMemoryDeliveryRepository({ agentStateRoot: root });
    const lockPath = `${recordPath(root, id)}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'other-process', acquired_at: new Date().toISOString() }),
      'utf8',
    );

    expect(await claimOne(store, id, 'consumer', 0)).toBeUndefined();
    // 记录本身没被改动：还是 pending、attempt_count 仍是 0
    const untouched = await store.getContextDelivery(ROLE, id);
    expect(untouched).toMatchObject({ status: 'pending', attempt_count: 0 });

    // 另一个实例同样是这个仓库类型，别把它当孤儿
    void other;
    await rm(lockPath, { force: true });
    expect(asContext(await claimOne(store, id, 'consumer', 0)).item.status).toBe('processing');
  });

  it('陈旧的锁文件可被接管（持有者崩在锁上不能永久挡路）', async () => {
    const root = await tempRoot();
    // TTL 设成 1ms，让刚写下的锁立刻算陈旧
    const store = new FileMemoryDeliveryRepository({ agentStateRoot: root, lock_ttl_ms: 1 });
    const id = await seed(store);
    const lockPath = `${recordPath(root, id)}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'dead-process', acquired_at: new Date(Date.now() - 60_000).toISOString() }),
      'utf8',
    );

    expect(asContext(await claimOne(store, id, 'consumer', 0)).item.status).toBe('processing');
    // 接管之后由新持有者释放，磁盘上不留锁
    await expect(readFile(lockPath, 'utf8')).rejects.toThrow();
  });

  it('读不懂的锁文件按陈旧处理（一把坏锁不该永久挡住所有人）', async () => {
    const root = await tempRoot();
    const store = await openStore(root);
    const id = await seed(store);
    const lockPath = `${recordPath(root, id)}.lock`;
    await writeFile(lockPath, 'not json at all', 'utf8');

    expect(asContext(await claimOne(store, id, 'consumer', 0)).item.status).toBe('processing');
  });

  it('崩溃点：claim 之后、complete 之前进程消失 → 重启恢复后只交付一次', async () => {
    const root = await tempRoot();
    const crashed = await openStore(root);
    const id = await seed(crashed);
    const claimed = asContext(await claimOne(crashed, id, 'consumer_a', 0));
    expect(claimed.item.status).toBe('processing');

    // 进程在这里消失：磁盘上留着 processing + lease，没有任何人持有它
    const onDisk = JSON.parse(await readFile(recordPath(root, id), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(onDisk).toMatchObject({
      status: 'processing',
      attempt_count: 1,
      claim_owner: 'consumer_a',
    });

    // 重启后的实例做启动恢复：过期 lease 回到队列
    const restarted = await openStore(root);
    const restored = await restarted.restoreExpiredDeliveryClaims({ now: at(LEASE) });
    expect(restored).toHaveLength(1);
    expect(asContext(restored[0]).item).toMatchObject({ status: 'pending', attempt_count: 1 });

    const resumed = asContext(await claimOne(restarted, id, 'consumer_b', LEASE));
    await restarted.completeDelivery({
      channel: 'context',
      role_id: ROLE,
      id,
      owner: 'consumer_b',
      now: at(LEASE + 1_000),
    });

    // 全程只有一条交付记录，最终状态是 processed
    const all = await restarted.listContextDeliveries({ role_id: ROLE });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'processed', attempt_count: 2 });
    void resumed;
  });
});

describe('PgMemoryDeliveryRepository（重启恢复与迁移）', () => {
  /** 同一份进程内数据库上换一个适配器实例 = 换了进程、存储没变 */
  const pg = DELIVERY_ADAPTERS.find((adapter) =>
    adapter.name.startsWith('PgMemoryDeliveryRepository'),
  )!;

  it('重启后 pending / 过期 processing / dead_letter 三种记录都还在，且按各自语义恢复', async () => {
    const first = await pg.create('');
    const pending = deliveryFor(ROLE, 'task_pending', 1);
    const expired = deliveryFor(ROLE, 'task_expired', 2);
    const dead = deliveryFor(ROLE, 'task_dead', 3);
    await first.ensureAgent(ROLE);
    await first.submitContextDelivery(pending);
    await first.submitContextDelivery(expired);
    await first.submitContextDelivery(dead);

    // 一条被 claim 后进程消失（lease 留在库里，没人再续）
    asContext(await claimOne(first, expired.delivery_id, 'consumer_gone', 0));
    // 一条按不可重试失败进死信
    asContext(await claimOne(first, dead.delivery_id, 'consumer', 0));
    await first.failDelivery({
      channel: 'context',
      role_id: ROLE,
      id: dead.delivery_id,
      owner: 'consumer',
      error: 'schema cannot be parsed',
      retryable: false,
      now: at(1_000),
    });

    // 重启：新实例、同一份存储
    const restarted = await pg.reopen('', first);

    // 三种记录都读得到，状态如实
    expect(await restarted.getContextDelivery(ROLE, pending.delivery_id)).toMatchObject({
      status: 'pending',
      attempt_count: 0,
    });
    expect(await restarted.getContextDelivery(ROLE, expired.delivery_id)).toMatchObject({
      status: 'processing',
      claim_owner: 'consumer_gone',
    });
    expect(await restarted.getContextDelivery(ROLE, dead.delivery_id)).toMatchObject({
      status: 'dead_letter',
      last_error: 'schema cannot be parsed',
    });

    // 启动恢复把过期 lease 放回队列；死信与 pending 都不受影响
    const restored = await restarted.restoreExpiredDeliveryClaims({ now: at(LEASE) });
    expect(restored).toHaveLength(1);
    expect(asContext(restored[0]).item.delivery_id).toBe(expired.delivery_id);
    expect(await restarted.getContextDelivery(ROLE, dead.delivery_id)).toMatchObject({
      status: 'dead_letter',
    });

    // 恢复后的那条能被下一个消费者取走，全程只有三条记录
    const resumed = asContext(await claimOne(restarted, expired.delivery_id, 'consumer_b', LEASE));
    expect(resumed.item).toMatchObject({ status: 'processing', attempt_count: 2 });
    expect(await restarted.listContextDeliveries({ role_id: ROLE })).toHaveLength(3);
  });

  it('旧记录（工作包 B 落盘的形状）缺 attempt_count 等字段时按默认值读入并可投递', async () => {
    const store = await pg.create('');
    const legacy = deliveryFor(ROLE, 'task_legacy', 1);
    await store.ensureAgent(ROLE);
    // 工作包 C 之前的落盘形状：状态机字段一个都没有，只有 status 与时间戳
    await insertLegacyContextDeliveryRow(legacy);

    expect(await store.getContextDelivery(ROLE, legacy.delivery_id)).toMatchObject({
      status: 'pending',
      // 缺省的 attempt_count 就是它的真实语义：还没投递过。不必写迁移脚本
      attempt_count: 0,
    });
    const claimed = asContext(await claimOne(store, legacy.delivery_id, 'consumer', 0));
    expect(claimed.item).toMatchObject({ status: 'processing', attempt_count: 1 });
  });
});
