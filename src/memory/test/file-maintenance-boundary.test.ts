/**
 * File 后端的维护边界（Phase 3-D-B）
 *
 * 这个文件只回答一件事：**File 适配器今天能承载维护通道的哪一半，不能承载哪一半**。
 * 断言落在两处可核对的地方——实例上究竟有没有这个能力、落盘结果究竟是什么形态——因此
 * 它既是验证也是记录：边界一旦变了（有人实现了 FileMemoryRepository），这里会先红，
 * 而不是让文档继续过期。
 *
 * 三件事实：
 *
 * 1. **File 能承载的是审计/队列那半边。** 三个 File 适配器各自实现自己的端口
 *    （BufferRepository / MemoryDeliveryRepository / MaintenanceRunStore），在维护通道里的
 *    语义已由适配器矩阵逐条钉住（`file-buffer-repository.test.ts`、`memory-delivery-claim.test.ts`、
 *    `memory-delivery-store.test.ts`、`maintenance-run-store.test.ts`）。那些用例不在这里重复；
 *    这里只把与晋升直接相邻的两条（run 记录如实落盘、损坏记录不装成一条 run）在**晋升这个
 *    用法**下再钉一遍。
 * 2. **File 不能承载的是经验与技能那半边。** Skill Promotion 的每一步——扫候选、claim 一条、
 *    结论落地、Skill 幂等写入——都长在 `MemoryRepository` 端口上，而**没有任何 File 适配器
 *    实现那个端口**。所以今天不存在「File 后端的 Skill Promotion」，缺的是一个
 *    `FileMemoryRepository`，不是缺一条接线。把 FileBufferRepository 或 FileMaintenanceRunStore
 *    当成完整晋升存储是错的：前者是 Buffer 存储，后者是 run 审计存储。
 * 3. **边界必须"响"**。装配错了不能退化成一类看起来健康的空跑——一次把 File 适配器接进
 *    `DefaultSkillPromotionJob` 的运行会如实收成 `worker_error` / `run.status='failed'`，
 *    而不是 `no_work`。这与「缺的那一半没有静默替身」是同一件事。
 *
 * 本文件**不**实现 FileMemoryRepository，也不改任何适配器：那是需要单独批准的接口层工作。
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileBufferRepository } from '../adapters/file-buffer-repository';
import { FileMaintenanceRunStore } from '../adapters/file-maintenance-run-store';
import { FileMemoryDeliveryRepository } from '../adapters/file-memory-delivery';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { DefaultPromotionStrategy } from '../adapters/default-promotion-strategy';
import { DefaultSkillPromotionJob } from '../runtime/skill-promotion-job';
import { buildContextDeliveryItem } from '../services/context-delivery';
import type { MemoryRepository } from '../ports/memory-repository';

const START = '2026-10-11T12:00:00.000Z';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'newide-file-boundary-'));
  tempDirs.push(root);
  return root;
}

/**
 * 晋升用到的 `MemoryRepository` 能力，逐条取自端口。
 *
 * `satisfies` 是关键：写错一个名字（端口上根本没有这个方法）这里先编译不过，测试不会因为
 * 拼错而变成一条永远为真的断言。下面还会拿同一份清单去核对真正的实现**确实有**它们——
 * 否则「File 没有」这件事可能只是因为清单本身是空的。
 */
const PROMOTION_REPOSITORY_METHODS = [
  // 候选与 claim
  'listPromotionCandidates',
  'claimNextPromotionCandidate',
  // 结论落地与失败落盘
  'completePromotion',
  'failPromotion',
  'restoreExpiredPromotionClaims',
  'retryDeadLetterPromotion',
  // 经验与技能本身
  'saveExperience',
  'listExperiences',
  'saveSkillIfAbsent',
  'listSkills',
] as const satisfies ReadonlyArray<keyof MemoryRepository>;

describe('File 后端与 Skill Promotion 的边界', () => {
  it('能承载的那一半：skill_promotion 的 run 记录如实落盘，换个实例读得回来，且不留临时文件', async () => {
    const root = await tempRoot();
    const store = new FileMaintenanceRunStore({ root });

    const run = await store.start({
      job_type: 'skill_promotion',
      worker_id: 'worker-file',
      run_id: 'run_file_boundary',
      now: START,
    });
    const finished = await store.finish(run.run_id, {
      claimed_count: 3,
      completed_count: 1,
      retried_count: 1,
      dead_letter_count: 1,
      now: START,
    });

    expect(finished).toMatchObject({
      job_type: 'skill_promotion',
      status: 'completed',
      worker_id: 'worker-file',
      claimed_count: 3,
      completed_count: 1,
      retried_count: 1,
      dead_letter_count: 1,
      skipped_count: 0,
      failure_count: 0,
    });

    // 落盘形态：一条 run 一个文件。写路径是「唯一临时文件 + rename」，因此收尾之后目录里
    // 只该剩下那条完整记录——残留的 .tmp 会说明「原子替换」这一半没有成立
    expect(await readdir(root)).toEqual(['run_file_boundary.json']);

    // 换一个实例（新的进程）读同一份目录：审计记录来自磁盘，不来自内存
    const revived = new FileMaintenanceRunStore({ root });
    expect(await revived.get(run.run_id)).toEqual(finished);
    expect(await revived.list({ job_type: 'skill_promotion' })).toHaveLength(1);
  });

  it('损坏的 run 文件不阻断列举，也不会被读成一条 run', async () => {
    const root = await tempRoot();
    const store = new FileMaintenanceRunStore({ root });
    const run = await store.start({
      job_type: 'skill_promotion',
      worker_id: 'worker-file',
      run_id: 'run_healthy',
      now: START,
    });

    // 半截 JSON / 形状对不上的记录：都被当成「读不出这条 run」。判据与交付适配器一致——
    // 一条坏记录不该让整次列举（也就是整个后台的观测面）不可用
    await writeFile(join(root, 'run_truncated.json'), '{"run_id":"run_truncated",', 'utf8');
    await writeFile(join(root, 'run_misshapen.json'), '{"job_type":"skill_promotion"}', 'utf8');

    const listed = await store.list({ job_type: 'skill_promotion' });
    expect(listed.map((item) => item.run_id)).toEqual([run.run_id]);
    // 按 id 直接读同一条也是 undefined：诊断面不会把坏记录伪装成「没有这条 run」
    expect(await store.get('run_truncated')).toBeUndefined();
    expect(await store.get('run_misshapen')).toBeUndefined();
  });

  it('三个 File 适配器都不提供晋升所需的 MemoryRepository 能力', async () => {
    const root = await tempRoot();
    const fileAdapters = {
      FileBufferRepository: new FileBufferRepository({ agentStateRoot: root }),
      FileMemoryDeliveryRepository: new FileMemoryDeliveryRepository({ agentStateRoot: root }),
      FileMaintenanceRunStore: new FileMaintenanceRunStore({ root }),
    };

    // 清单不是空的：真正的实现必须有这些能力，否则下面的断言测的是「一个不存在的清单」
    const realRepository = new InMemoryRepository();
    for (const method of PROMOTION_REPOSITORY_METHODS) {
      expect(typeof realRepository[method], `InMemoryRepository.${method}`).toBe('function');
    }

    for (const [name, adapter] of Object.entries(fileAdapters)) {
      for (const method of PROMOTION_REPOSITORY_METHODS) {
        expect(
          (adapter as unknown as Record<string, unknown>)[method],
          `${name}.${method}`,
        ).toBeUndefined();
      }
    }
  });

  it('把 File 适配器接进晋升 job：类型层就不成立，运行起来也如实收成失败的 run', async () => {
    const root = await tempRoot();
    const bufferRepository = new FileBufferRepository({ agentStateRoot: root });
    const runStore = new FileMaintenanceRunStore({ root });

    const job = new DefaultSkillPromotionJob({
      // @ts-expect-error FileBufferRepository 不是 MemoryRepository——晋升要的读写面它一条都没有
      repository: bufferRepository,
      runStore,
      strategy: new DefaultPromotionStrategy({ approval: 'auto_approve' }),
      worker_id: 'worker-file',
      now: () => START,
    });

    // 运行时必须「响」：缺的那一半没有静默替身，因此这次运行不能退化成 `no_work`。
    // 一次看起来健康的空跑会让人以为「File 后端也能晋升，只是眼下没有候选」
    const result = await job.run({ batchSize: 5 });

    expect(result.stop_reason).toBe('worker_error');
    expect(result.counts.claimed_count).toBe(0);
    expect(result.outcomes).toHaveLength(0);
    expect(result.run.status).toBe('failed');
    expect(result.worker_failure).toBeDefined();
    const workerFailure = result.worker_failure!;
    // 失败本身也是可审计的：run 记录落在同一份 File 存储上，原因写在 last_error 里
    expect(result.run.last_error).toContain(workerFailure.code);
    expect(await runStore.get(result.run.run_id)).toMatchObject({ status: 'failed' });
  });

  it('边界不在"File 不能做维护"：交付通道在 File 上照常走完一次 claim 与收尾', async () => {
    const root = await tempRoot();
    const delivery = new FileMemoryDeliveryRepository({ agentStateRoot: root });
    await delivery.ensureAgent('role_file_boundary');
    const item = buildContextDeliveryItem({
      role_id: 'role_file_boundary',
      task_id: 'task_file_boundary',
      buffer_seq: 1,
      source_driver: 'driver_file_boundary',
    });
    await delivery.submitContextDelivery(item);

    const claimed = await delivery.claimNextDelivery({
      channel: 'context',
      owner: 'worker-file',
      now: START,
    });
    // ClaimedDelivery 是三条通道的联合：断言拿到的是 context 那一条，顺便收窄类型
    expect(claimed?.channel).toBe('context');
    if (claimed?.channel !== 'context') throw new Error('expected a context delivery claim');
    expect(claimed.item.delivery_id).toBe(item.delivery_id);

    const completed = await delivery.completeDelivery({
      channel: 'context',
      role_id: 'role_file_boundary',
      id: item.delivery_id,
      claim_token: claimed.item.claim_token!,
      owner: 'worker-file',
      now: START,
    });
    // 走完了 pending → processing → processed：这条通道一次都不需要 MemoryRepository
    expect(completed?.item.status).toBe('processed');
  });
});
