/**
 * MemoryDeliveryRepository 适配器测试（工作包 B）
 *
 * 文件与内存两个实现必须给出同一套语义——否则测试替身会掩盖生产行为差异：
 *
 *   1. 同键提交只留第一条（幂等），且不覆盖已有内容与状态
 *   2. 过滤与跨 role 列举
 *   3. deleteAgent 清干净
 *   4. 文件实现跨实例存活（重启后交付项还在），损坏记录不阻断列举
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FileMemoryDeliveryRepository } from '../adapters/file-memory-delivery';
import { InMemoryMemoryDeliveryRepository } from '../adapters/in-memory-memory-delivery';
import {
  buildContextDeliveryItem,
  buildDriverUsageFeedbackRecords,
} from '../services/context-delivery';
import type { MemoryDeliveryRepository } from '../ports/memory-delivery';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'newide-delivery-store-'));
  tempDirs.push(root);
  return root;
}

interface AdapterCase {
  name: string;
  create: (root: string) => MemoryDeliveryRepository;
  /** 重启（新实例指向同一份存储）；内存实现没有这一层，用同一实例顶替 */
  reopen: (root: string, previous: MemoryDeliveryRepository) => MemoryDeliveryRepository;
}

const ADAPTERS: AdapterCase[] = [
  {
    name: 'FileMemoryDeliveryRepository',
    create: (root) => new FileMemoryDeliveryRepository({ agentStateRoot: root }),
    reopen: (root) => new FileMemoryDeliveryRepository({ agentStateRoot: root }),
  },
  {
    name: 'InMemoryMemoryDeliveryRepository',
    create: () => new InMemoryMemoryDeliveryRepository(),
    reopen: (_root, previous) => previous,
  },
];

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

describe.each(ADAPTERS)('$name', ({ create, reopen }) => {
  it('同键提交只留第一条，且不覆盖已有内容', async () => {
    const root = await tempRoot();
    const store = create(root);
    await store.ensureAgent('role_a');

    const first = deliveryFor('role_a', 'task_1');
    const submitted = await store.submitContextDelivery(first);
    expect(submitted.created).toBe(true);

    const again = await store.submitContextDelivery(first);
    expect(again.created).toBe(false);
    // 键相同 → id 相同 → 只有一条记录
    expect(again.item.delivery_id).toBe(first.delivery_id);
    expect(await store.listContextDeliveries({ role_id: 'role_a' })).toHaveLength(1);
  });

  it('按 role / task / status 过滤，并支持跨 role 列举', async () => {
    const root = await tempRoot();
    const store = create(root);
    await store.ensureAgent('role_a');
    await store.ensureAgent('role_b');

    // 交付键含 buffer_seq：同一 role 内两次交付必须落在不同的 seq 上
    await store.submitContextDelivery(deliveryFor('role_a', 'task_1', 1));
    await store.submitContextDelivery(deliveryFor('role_a', 'task_2', 2));
    await store.submitContextDelivery(deliveryFor('role_b', 'task_3', 1));

    expect(await store.listContextDeliveries()).toHaveLength(3);
    expect(await store.listContextDeliveries({ role_id: 'role_a' })).toHaveLength(2);
    expect(await store.listContextDeliveries({ task_id: 'task_3' })).toHaveLength(1);
    expect(await store.listContextDeliveries({ status: 'pending' })).toHaveLength(3);
    expect(await store.listContextDeliveries({ status: 'processed' })).toHaveLength(0);
  });

  it('反馈 outbox：同键幂等，可按 experience_id 过滤', async () => {
    const root = await tempRoot();
    const store = create(root);
    await store.ensureAgent('role_a');

    const record = feedbackFor('role_a', 'task_1', 'exp_1');
    expect((await store.submitDriverFeedback(record)).created).toBe(true);
    const again = await store.submitDriverFeedback(record);
    expect(again.created).toBe(false);
    expect(again.item.effectiveness).toBe(record.effectiveness);

    await store.submitDriverFeedback(feedbackFor('role_a', 'task_1', 'exp_2'));
    expect(await store.listDriverFeedback({ role_id: 'role_a' })).toHaveLength(2);
    expect(await store.listDriverFeedback({ experience_id: 'exp_2' })).toHaveLength(1);
  });

  it('deleteAgent 清干净该 role 的交付存储', async () => {
    const root = await tempRoot();
    const store = create(root);
    await store.ensureAgent('role_a');
    await store.submitContextDelivery(deliveryFor('role_a', 'task_1'));
    await store.submitDriverFeedback(feedbackFor('role_a', 'task_1', 'exp_1'));

    await store.deleteAgent('role_a');

    expect(await store.listContextDeliveries()).toHaveLength(0);
    expect(await store.listDriverFeedback()).toHaveLength(0);
  });

  it('文件实现：交付项跨实例存活，且落盘路径可预期', async () => {
    const root = await tempRoot();
    const store = create(root);
    await store.ensureAgent('role_a');
    const item = deliveryFor('role_a', 'task_1');
    await store.submitContextDelivery(item);

    const reopened = reopen(root, store);
    const found = await reopened.getContextDelivery('role_a', item.delivery_id);
    expect(found).toMatchObject({
      delivery_key: item.delivery_key,
      memory_buffer_ref: 'role_a:1',
      context_snapshot_ref: '1',
    });
  });

  it('文件实现：损坏记录不阻断列举', async () => {
    const root = await tempRoot();
    const store = create(root);
    if (!(store instanceof FileMemoryDeliveryRepository)) return;
    await store.ensureAgent('role_a');
    const item = deliveryFor('role_a', 'task_1');
    await store.submitContextDelivery(item);

    const path0 = join(root, 'role_a', 'delivery', 'context', `${item.delivery_id}.json`);
    await writeFile(path0, '{ not json', 'utf8');

    // 坏记录被跳过，而不是让整次列举报错
    expect(await store.listContextDeliveries({ role_id: 'role_a' })).toHaveLength(0);
  });

  it('文件实现：交付项真的写在 role 目录树下（与 buffer 同层）', async () => {
    const root = await tempRoot();
    const store = create(root);
    if (!(store instanceof FileMemoryDeliveryRepository)) return;
    await store.ensureAgent('role_a');
    const item = deliveryFor('role_a', 'task_1');
    await store.submitContextDelivery(item);

    const raw = await readFile(
      join(root, 'role_a', 'delivery', 'context', `${item.delivery_id}.json`),
      'utf8',
    );
    expect(JSON.parse(raw)).toMatchObject({ delivery_id: item.delivery_id, status: 'pending' });
  });
});

describe('FileMemoryDeliveryRepository（下游已推进的状态）', () => {
  it('上游重放不会把下游已经推进的交付项拽回 pending', async () => {
    const root = await tempRoot();
    const store = new FileMemoryDeliveryRepository({ agentStateRoot: root });
    await store.ensureAgent('role_a');

    const first = deliveryFor('role_a', 'task_1');
    await store.submitContextDelivery(first);

    // 模拟下游把这条推进到 processed：同一 id 就地改写
    const advanced = { ...first, status: 'processed' as const };
    await writeFile(
      join(root, 'role_a', 'delivery', 'context', `${first.delivery_id}.json`),
      `${JSON.stringify(advanced, null, 2)}\n`,
      'utf8',
    );

    const replayed = await store.submitContextDelivery(first);
    expect(replayed.created).toBe(false);
    expect(replayed.item.status).toBe('processed');
  });
});

/**
 * 首次提交的跨进程竞态。
 *
 * 两个实例就是两个进程：同进程的串行链不共享，「谁先发布」只能由文件系统裁决。
 * 这里真正要证明的是三件事——磁盘上最终只有一条记录；两个调用都**成功**返回
 * （不允许出现「记录已经落盘、调用却因为临时文件冲突而失败」）；输的那个读回
 * 赢家写下的内容，而不是把自己那份当成结果。
 */
describe('FileMemoryDeliveryRepository（首次提交竞态）', () => {
  it('两个进程同时首次提交同一条交付：一个创建、一个读回同一条', async () => {
    const root = await tempRoot();
    const first = new FileMemoryDeliveryRepository({ agentStateRoot: root });
    const second = new FileMemoryDeliveryRepository({ agentStateRoot: root });
    await first.ensureAgent('role_race');

    const item = deliveryFor('role_race', 'task_race');
    // 两份内容只有时间戳不同：调用方各自的 created_at 就是「它是不是赢家」的指纹
    const contender = { ...item, created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z' };
    const [a, b] = await Promise.all([
      first.submitContextDelivery(item),
      second.submitContextDelivery(contender),
    ]);

    expect([a.created, b.created].sort()).toEqual([false, true]);
    const stored = await first.getContextDelivery('role_race', item.delivery_id);
    expect(stored).toMatchObject({ delivery_key: item.delivery_key, status: 'pending' });
    // 两个调用看到的都是磁盘上那一份；输家没有坚持自己那份时间戳
    expect(a.item.created_at).toBe(stored!.created_at);
    expect(b.item.created_at).toBe(stored!.created_at);

    // 目标目录只有一条记录，也没有残留的临时文件
    const entries = await readdir(join(root, 'role_race', 'delivery', 'context'));
    expect(entries).toEqual([`${item.delivery_id}.json`]);
  });

  it('两个进程同时首次提交同一条反馈：一个创建、一个读回同一条', async () => {
    const root = await tempRoot();
    const first = new FileMemoryDeliveryRepository({ agentStateRoot: root });
    const second = new FileMemoryDeliveryRepository({ agentStateRoot: root });
    await first.ensureAgent('role_race');

    const record = feedbackFor('role_race', 'task_race', 'exp_race');
    const contender = {
      ...record,
      observed_at: '2020-01-01T00:00:00.000Z',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };
    const [a, b] = await Promise.all([
      first.submitDriverFeedback(record),
      second.submitDriverFeedback(contender),
    ]);

    expect([a.created, b.created].sort()).toEqual([false, true]);
    const stored = await first.getDriverFeedback('role_race', record.feedback_id);
    expect(stored).toMatchObject({ feedback_key: record.feedback_key, status: 'pending' });
    expect(a.item.created_at).toBe(stored!.created_at);
    expect(b.item.created_at).toBe(stored!.created_at);

    const entries = await readdir(join(root, 'role_race', 'delivery', 'feedback'));
    expect(entries).toEqual([`${record.feedback_id}.json`]);
  });

  it('多个进程并发首次提交同一个键：恰好一个创建，其余全部读回', async () => {
    const root = await tempRoot();
    const stores = Array.from(
      { length: 5 },
      () => new FileMemoryDeliveryRepository({ agentStateRoot: root }),
    );
    await stores[0]!.ensureAgent('role_swarm');

    const items = Array.from({ length: stores.length }, (_unused, index) => ({
      ...deliveryFor('role_swarm', 'task_swarm'),
      created_at: `2020-01-0${String(index + 1)}T00:00:00.000Z`,
      updated_at: `2020-01-0${String(index + 1)}T00:00:00.000Z`,
    }));
    const results = await Promise.all(
      stores.map(async (store, index) => store.submitContextDelivery(items[index]!)),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    const stored = await stores[0]!.getContextDelivery('role_swarm', items[0]!.delivery_id);
    for (const result of results) {
      expect(result.item.created_at).toBe(stored!.created_at);
    }
    const entries = await readdir(join(root, 'role_swarm', 'delivery', 'context'));
    expect(entries).toEqual([`${items[0]!.delivery_id}.json`]);
  });
});