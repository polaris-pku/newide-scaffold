/**
 * Skill Promotion 的持久化状态契约测试（Phase 3-A）
 *
 * 覆盖 MemoryRepository 上那组晋升状态的**语义**：候选扫描、claim（owner / token / lease）、
 * 结论落地（outcome 与 promoted_to 同一次写入）、失败退避与死信、租约回收、人工重试、
 * 以及旧载荷（没有 promotion 字段）的读入。
 *
 * 同一份契约跑两个后端（InMemory 与 PGlite 上的 PgMemoryRepository）——这是模块的既有约定
 * （见各 ports 的文件注释）：测试替身不得掩盖生产行为差异。**重启**只在 PGlite 那侧验：
 * InMemory 的「重启」就是清空，用它验持久性会把内存的假象当成生产语义。
 *
 * 本阶段刻意不覆盖的：跨后端并发的完整矩阵、晋升写回失败后的重试复用、聚合计数不漂移
 * ——那些是 Phase 3-B/3-D 的验收面。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { PgMemoryRepository } from '../adapters/pg-memory-repository';
import { ensurePgMemorySchema } from '../adapters/pg-memory-schema';
import { createPGlitePool } from '../adapters/pglite-pool';
import { DEFAULT_PROMOTION_STRATEGY_VERSION } from '../adapters/default-promotion-strategy';
import { DEFAULT_PROMOTION_RETRY_POLICY, addMilliseconds } from '../services/delivery-lifecycle';
import { promotionStateLabel } from '../services/promotion-candidates';
import type { MemoryRepository } from '../ports/memory-repository';
import type { SqlPool } from '../ports/sql-pool';
import type { ExperienceRecord } from '../schemas';

const NOW = '2026-10-10T12:00:00.000Z';
const LEASE_MS = 60_000;
const STRATEGY_VERSION = DEFAULT_PROMOTION_STRATEGY_VERSION;

function makeExperience(role_id: string, overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Prefer explicit contracts over implicit conventions.',
    description_embedding: [0.1, 0.2, 0.3],
    content: 'full experience content body',
    confidence: 0.99,
    tags: ['contracts'],
    agent_id: role_id,
    confidence_history: [{ value: 0.99, updated_at: now, reason: 'seed' }],
    referenced_count: 1,
    source_task_id: 'task_seed',
    source_driver: 'mock-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** 一份共用的 claim 参数（每个用例自己给 owner） */
function claimRequest(role_id: string, owner: string, now = NOW) {
  return {
    role_id,
    owner,
    now,
    lease_ms: LEASE_MS,
    strategy_version: STRATEGY_VERSION,
    approval: 'auto_approve' as const,
  };
}

/**
 * 同一份状态契约，两个后端各跑一遍。
 *
 * `createRepository` 每次给一个「新的进程」：InMemory 返回空仓库（它本来就不持久），
 * Pg 那一侧由外部复用同一个 pool，因此数据是真留在库里的。
 */
function runPromotionStateContract(
  label: string,
  createRepository: () => Promise<MemoryRepository>,
): void {
  describe(`promotion state contract — ${label}`, () => {
    let repository: MemoryRepository;
    let role_id: string;

    beforeAll(async () => {
      repository = await createRepository();
    });

    beforeEach(async () => {
      role_id = `role_promotion_${randomUUID()}`;
      await repository.initializeAgent({ role_id, name: 'Promotion Agent' });
    });

    it('未评估的经验是候选，claim 之后变成 processing 并带上 token 与租约', async () => {
      const experience = makeExperience(role_id);
      await repository.saveExperience(role_id, experience);

      const candidates = await repository.listPromotionCandidates({
        role_id,
        now: NOW,
        strategy_version: STRATEGY_VERSION,
        approval: 'auto_approve',
      });
      expect(candidates.map((item) => item.id)).toEqual([experience.id]);

      const claimed = await repository.claimNextPromotionCandidate(claimRequest(role_id, 'worker-1'));
      expect(claimed).toBeDefined();
      expect(claimed!.experience.id).toBe(experience.id);
      expect(claimed!.attempt_count).toBe(1);
      expect(claimed!.claim_token).toMatch(/^claim_/);

      const marker = claimed!.experience.promotion;
      expect(marker?.status).toBe('processing');
      expect(marker?.claim_owner).toBe('worker-1');
      expect(marker?.lease_expires_at).toBe(addMilliseconds(NOW, LEASE_MS));
      expect(promotionStateLabel(claimed!.experience)).toBe('processing');
    });

    it('没有候选时 claim 返回 undefined（不是错误）', async () => {
      await expect(
        repository.claimNextPromotionCandidate(claimRequest(role_id, 'worker-1')),
      ).resolves.toBeUndefined();
    });

    it('已晋升的经验不再被扫成候选', async () => {
      const experience = makeExperience(role_id, {
        promoted_to: randomUUID(),
      });
      await repository.saveExperience(role_id, experience);

      await expect(
        repository.listPromotionCandidates({
          role_id,
          now: NOW,
          strategy_version: STRATEGY_VERSION,
          approval: 'auto_approve',
        }),
      ).resolves.toHaveLength(0);
      await expect(
        repository.claimNextPromotionCandidate(claimRequest(role_id, 'worker-1')),
      ).resolves.toBeUndefined();
    });

    it('两个 worker 并发 claim 同一条候选，只有一个拿到', async () => {
      await repository.saveExperience(role_id, makeExperience(role_id));

      const [left, right] = await Promise.all([
        repository.claimNextPromotionCandidate(claimRequest(role_id, 'worker-a')),
        repository.claimNextPromotionCandidate(claimRequest(role_id, 'worker-b')),
      ]);

      expect([left, right].filter(Boolean)).toHaveLength(1);
      const winner = (left ?? right)!;
      // 输的那次没有写任何东西：持有者与 token 都还是赢家的
      const stored = (await repository.listExperiences(role_id))[0]!;
      expect(stored.promotion?.claim_owner).toBe(winner.experience.promotion?.claim_owner);
      expect(stored.promotion?.claim_token).toBe(winner.claim_token);
    });

    it('结论与 promoted_to 在同一次写入里落定', async () => {
      await repository.saveExperience(role_id, makeExperience(role_id));
      const claimed = (await repository.claimNextPromotionCandidate(claimRequest(role_id, 'w')))!;
      const skillId = randomUUID();

      const settled = await repository.completePromotion({
        role_id,
        experience_id: claimed.experience.id,
        claim_token: claimed.claim_token,
        outcome: 'promoted',
        strategy_version: STRATEGY_VERSION,
        skill_id: skillId,
        reasons: ['qualifies'],
        now: addMilliseconds(NOW, 1_000),
      });

      expect(settled?.promoted_to).toBe(skillId);
      expect(settled?.promotion?.outcome).toBe('promoted');
      expect(settled?.promotion?.skill_id).toBe(skillId);
      expect(settled?.promotion?.strategy_version).toBe(STRATEGY_VERSION);
      // 终态清掉租约与 token：它们是活着的凭据
      expect(settled?.promotion?.claim_token).toBeUndefined();
      expect(settled?.promotion?.lease_expires_at).toBeUndefined();
      expect(promotionStateLabel(settled!)).toBe('promoted');
    });

    it('decision 为 promoted 却不给 skill_id 时直接抛错（不写出半截状态）', async () => {
      await repository.saveExperience(role_id, makeExperience(role_id));
      const claimed = (await repository.claimNextPromotionCandidate(claimRequest(role_id, 'w')))!;

      await expect(
        repository.completePromotion({
          role_id,
          experience_id: claimed.experience.id,
          claim_token: claimed.claim_token,
          outcome: 'promoted',
          strategy_version: STRATEGY_VERSION,
          now: NOW,
        }),
      ).rejects.toThrow(/skill_id/);
    });

    it('token 不匹配的 complete 什么都写不进去', async () => {
      await repository.saveExperience(role_id, makeExperience(role_id));
      const claimed = (await repository.claimNextPromotionCandidate(claimRequest(role_id, 'w')))!;

      await expect(
        repository.completePromotion({
          role_id,
          experience_id: claimed.experience.id,
          claim_token: 'claim_someone_else',
          outcome: 'rejected',
          strategy_version: STRATEGY_VERSION,
          now: NOW,
        }),
      ).resolves.toBeUndefined();

      const stored = (await repository.listExperiences(role_id))[0]!;
      expect(stored.promotion?.status).toBe('processing');
      expect(stored.promotion?.outcome).toBeUndefined();
    });

    it('可重试失败：退避后回到 pending，次数保留，理由留在 last_error', async () => {
      await repository.saveExperience(role_id, makeExperience(role_id));
      const claimed = (await repository.claimNextPromotionCandidate(claimRequest(role_id, 'w')))!;

      const failed = await repository.failPromotion({
        role_id,
        experience_id: claimed.experience.id,
        claim_token: claimed.claim_token,
        error: 'storage_error: connection reset',
        retryable: true,
        now: addMilliseconds(NOW, 1_000),
      });

      const marker = failed?.promotion;
      expect(marker?.status).toBe('pending');
      expect(marker?.attempt_count).toBe(1);
      expect(marker?.last_error).toBe('storage_error: connection reset');
      expect(marker?.next_retry_at).toBe(
        addMilliseconds(addMilliseconds(NOW, 1_000), DEFAULT_PROMOTION_RETRY_POLICY.base_delay_ms),
      );
      expect(marker?.claim_token).toBeUndefined();
      expect(promotionStateLabel(failed!)).toBe('retryable');
    });

    it('不可重试的失败直接进死信', async () => {
      await repository.saveExperience(role_id, makeExperience(role_id));
      const claimed = (await repository.claimNextPromotionCandidate(claimRequest(role_id, 'w')))!;

      const failed = await repository.failPromotion({
        role_id,
        experience_id: claimed.experience.id,
        claim_token: claimed.claim_token,
        error: 'payload_unreadable: bad payload',
        retryable: false,
        now: addMilliseconds(NOW, 1_000),
      });

      expect(failed?.promotion?.status).toBe('dead_letter');
      expect(promotionStateLabel(failed!)).toBe('dead_letter');
    });

    it('用满次数后即使可重试也进死信', async () => {
      await repository.saveExperience(role_id, makeExperience(role_id));

      // 名额压到 1：这一次 claim 就已经用满，同一个失败再判为「可重试」也只剩死信一条路
      const claimed = (await repository.claimNextPromotionCandidate(claimRequest(role_id, 'w')))!;
      const failed = await repository.failPromotion({
        role_id,
        experience_id: claimed.experience.id,
        claim_token: claimed.claim_token,
        error: 'storage_error: boom',
        retryable: true,
        now: addMilliseconds(NOW, 1_000),
        policy: { max_attempts: 1, base_delay_ms: 0, max_delay_ms: 0 },
      });

      expect(failed?.promotion?.status).toBe('dead_letter');
      expect(failed?.promotion?.attempt_count).toBe(1);
    });

    it('人工重试把死信放回队列并清零次数', async () => {
      await repository.saveExperience(role_id, makeExperience(role_id));
      const claimed = (await repository.claimNextPromotionCandidate(claimRequest(role_id, 'w')))!;
      await repository.failPromotion({
        role_id,
        experience_id: claimed.experience.id,
        claim_token: claimed.claim_token,
        error: 'unknown: boom',
        retryable: false,
        now: addMilliseconds(NOW, 1_000),
      });

      const revived = await repository.retryDeadLetterPromotion({
        role_id,
        experience_id: claimed.experience.id,
        now: addMilliseconds(NOW, 2_000),
      });

      expect(revived?.promotion?.status).toBe('pending');
      expect(revived?.promotion?.attempt_count).toBe(0);
      expect(revived?.promotion?.last_error).toBeUndefined();
      // 放回队列之后可以被重新 claim
      await expect(
        repository.claimNextPromotionCandidate(claimRequest(role_id, 'w2', addMilliseconds(NOW, 2_000))),
      ).resolves.toBeDefined();
    });

    it('非死信的记录不接受人工重试', async () => {
      await repository.saveExperience(role_id, makeExperience(role_id));
      const claimed = (await repository.claimNextPromotionCandidate(claimRequest(role_id, 'w')))!;

      await expect(
        repository.retryDeadLetterPromotion({
          role_id,
          experience_id: claimed.experience.id,
          now: NOW,
        }),
      ).resolves.toBeUndefined();
    });

    it('租约过期回收：未过期的动不了，过期的放回队列', async () => {
      await repository.saveExperience(role_id, makeExperience(role_id));
      const claimed = (await repository.claimNextPromotionCandidate(claimRequest(role_id, 'w')))!;

      // 租约还在：回收什么都不做
      await expect(
        repository.restoreExpiredPromotionClaims({ role_id, now: addMilliseconds(NOW, 1_000) }),
      ).resolves.toHaveLength(0);

      const expiredAt = addMilliseconds(NOW, LEASE_MS);
      const restored = await repository.restoreExpiredPromotionClaims({ role_id, now: expiredAt });
      expect(restored).toHaveLength(1);
      expect(restored[0]!.promotion?.status).toBe('pending');
      expect(restored[0]!.promotion?.claim_token).toBeUndefined();

      // 旧持有者拿着旧 token 再也写不进去（fencing 的落点）
      await expect(
        repository.completePromotion({
          role_id,
          experience_id: claimed.experience.id,
          claim_token: claimed.claim_token,
          outcome: 'rejected',
          strategy_version: STRATEGY_VERSION,
          now: expiredAt,
        }),
      ).resolves.toBeUndefined();
    });

    it('旧载荷（没有 promotion 字段）照样读得出来，并成为候选', async () => {
      const experience = makeExperience(role_id);
      await repository.saveExperience(role_id, experience);

      // 写入的那份载荷里没有 promotion 这个键——正是工作包 B 之前落盘经验的形状
      const stored = (await repository.listExperiences(role_id))[0]!;
      expect(stored.promotion).toBeUndefined();
      expect(promotionStateLabel(stored)).toBe('unevaluated');

      await expect(
        repository.claimNextPromotionCandidate(claimRequest(role_id, 'w')),
      ).resolves.toBeDefined();
    });

    it('limit 截取的是排序后的前 N 条', async () => {
      const older = makeExperience(role_id, { created_at: addMilliseconds(NOW, -2 * 86_400_000) });
      const newer = makeExperience(role_id, { created_at: addMilliseconds(NOW, -86_400_000) });
      await repository.saveExperience(role_id, newer);
      await repository.saveExperience(role_id, older);

      const limited = await repository.listPromotionCandidates({
        role_id,
        now: NOW,
        strategy_version: STRATEGY_VERSION,
        approval: 'auto_approve',
        limit: 1,
      });
      expect(limited.map((item) => item.id)).toEqual([older.id]);
    });
  });
}

runPromotionStateContract('InMemoryRepository', async () => new InMemoryRepository());

describe('promotion state contract — PgMemoryRepository on embedded PGlite', () => {
  const embedding = new HashEmbeddingProvider();
  let pool: SqlPool;

  beforeAll(async () => {
    pool = await createPGlitePool();
    await ensurePgMemorySchema(pool, embedding.dimensions);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS memory_experiences');
      await pool.query('DROP TABLE IF EXISTS memory_skills');
      await pool.query('DROP TABLE IF EXISTS memory_agents');
      await pool.end();
    }
  });

  runPromotionStateContract(
    'PgMemoryRepository (PGlite)',
    async () => new PgMemoryRepository({ pool, embedding, autoMigrate: false }),
  );

  it('重启后（同一份库、新的 repository 实例）晋升状态还在', async () => {
    const repository = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    const role_id = `role_promotion_restart_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'Restart Agent' });
    const experience = makeExperience(role_id);
    await repository.saveExperience(role_id, experience);
    const claimed = (await repository.claimNextPromotionCandidate(claimRequest(role_id, 'w')))!;

    // 换一个 repository 实例读同一份库：内存里什么都没留下，状态只能来自持久层
    const revivedRepository = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    const stored = (await revivedRepository.listExperiences(role_id))[0]!;
    expect(stored.promotion?.status).toBe('processing');
    expect(stored.promotion?.claim_token).toBe(claimed.claim_token);

    // 租约过期后新实例能把它收回来继续处理
    const restored = await revivedRepository.restoreExpiredPromotionClaims({
      role_id,
      now: addMilliseconds(NOW, LEASE_MS),
    });
    expect(restored).toHaveLength(1);
    expect(restored[0]!.promotion?.status).toBe('pending');
  });
});
