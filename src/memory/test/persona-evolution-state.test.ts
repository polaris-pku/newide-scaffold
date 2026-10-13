/**
 * Persona Evolution 持久化状态、claim 与原子写的契约测试（Phase 4-B）
 *
 * 覆盖 `MemoryRepository` 上那组演化状态的**语义**：候选 claim（owner / token / 租约）、
 * 结论落地（含 `evolved` 的**条件写**）、失败退避与死信、租约回收、人工重试、以及「读到的
 * 输入」与「写下的租约」来自同一次读。断言一律落在**持久化之后的状态**上（库里的 Persona
 * 版本、标记上的结论与凭据、snapshot hash），而不是「某个函数被调用过」——后者在存储语义
 * 出错时照样通过。
 *
 * 同一份契约跑两个后端（InMemoryRepository 与 PGlite 上的 PgMemoryRepository）。两条腿的
 * 共性到此为止：**跨进程**那一层（同一份库上两个 repository 实例、没有进程内 role 临界区
 * 可用）只能由 Pg 那条腿验，因为内存实现根本没有第二个进程可言——它必须"诚实"，见文件末尾
 * 的说明。这与 Phase 3 把「重启」放在 Pg 那条腿上是同一条理由。
 *
 * 时间全部由注入的 `now` 提供：退避、租约过期与接管都不依赖真实时钟。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION } from '../adapters/default-persona-evolution-strategy';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { PgMemoryRepository } from '../adapters/pg-memory-repository';
import { ensurePgMemorySchema } from '../adapters/pg-memory-schema';
import { createPGlitePool } from '../adapters/pglite-pool';
import {
  buildPersonaEvolutionSnapshot,
  personaEvolutionInputSnapshotHash,
} from '../services/persona-evolution-candidates';
import {
  buildEvolvedPersona,
  personaEvolutionSettlement,
} from '../services/persona-evolution-decision';
import { addMilliseconds } from '../services/delivery-lifecycle';
import type {
  ClaimedPersonaEvolutionCandidate,
  MemoryRepository,
  PersonaEvolutionClaimRequest,
} from '../ports/memory-repository';
import type { PersonaEvolutionPersonaDraft } from '../ports/persona-evolution-strategy';
import type { SqlPool } from '../ports/sql-pool';
import type {
  ExperiencePromotion,
  ExperienceRecord,
  PersonaDef,
  SkillRecord,
} from '../schemas';

const NOW = '2026-10-11T12:00:00.000Z';
const LEASE_MS = 60_000;
const STRATEGY_VERSION = DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION;
/** 死信边界不等真实时间：把预算压到 2 次、退避为 0 */
const TIGHT_POLICY = { max_attempts: 2, base_delay_ms: 0, max_delay_ms: 0 };

// ═══════════════════════════════════════════
//  样例数据
// ═══════════════════════════════════════════

function makeSkill(role_id: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = NOW;
  return {
    id: randomUUID(),
    description: 'Prefer explicit contracts over implicit conventions.',
    description_embedding: [0.1, 0.2, 0.3],
    content: 'full skill content body',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['contracts'],
    promoted_at: now,
    agent_id: role_id,
    market_status: 'available',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeExperience(role_id: string, overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    id: randomUUID(),
    description: 'Prefer explicit contracts over implicit conventions.',
    description_embedding: [0.1, 0.2, 0.3],
    content: 'full experience content body',
    confidence: 0.9,
    tags: ['contracts'],
    agent_id: role_id,
    confidence_history: [{ value: 0.9, updated_at: NOW, reason: 'seed' }],
    referenced_count: 1,
    source_task_id: 'task_seed',
    source_driver: 'mock-driver',
    type: 'positive',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/** 一份固定正文：断言「写下去的就是判定交回来的那一份」 */
function draft(): PersonaEvolutionPersonaDraft {
  return {
    summary: 'A careful contract-first engineer.',
    skills_overview: '3 skills promoted.',
    experience_coverage: '5 experiences.',
    recent_performance: 'Steady.',
    notes: 'Evolved by the persona evolution job.',
  };
}

/** claim 之后的持有者（claim 成功时必然有；取它做交叉核对，真正的 fencing 是 token） */
function ownerOf(candidate: ClaimedPersonaEvolutionCandidate): string {
  const owner = candidate.marker.claim_owner;
  if (owner === undefined) throw new Error('a claimed candidate must carry its claim owner');
  return owner;
}

function claimRequest(
  role_id: string,
  owner = 'worker-1',
  overrides: Partial<PersonaEvolutionClaimRequest> = {},
): PersonaEvolutionClaimRequest {
  return {
    owner,
    now: NOW,
    lease_ms: LEASE_MS,
    strategy_version: STRATEGY_VERSION,
    approval: 'auto_approve',
    role_id,
    ...overrides,
  };
}

// ═══════════════════════════════════════════
//  同一份状态契约，两个后端各跑一遍
// ═══════════════════════════════════════════

function runPersonaEvolutionStateContract(
  label: string,
  createRepository: () => Promise<MemoryRepository>,
): void {
  describe(`persona evolution state contract — ${label}`, () => {
    let repository: MemoryRepository;
    let role_id: string;

    beforeAll(async () => {
      repository = await createRepository();
    });

    beforeEach(async () => {
      role_id = `role_persona_evo_${randomUUID()}`;
      await repository.initializeAgent({ role_id, name: 'Persona Evolution Agent' });
    });

    /** 播一批参与演化的输入（默认一条已批准技能 + 一条已落定经验） */
    async function seedInputs(options: { skills?: number; experiences?: number } = {}) {
      const skills: SkillRecord[] = [];
      for (let index = 0; index < (options.skills ?? 1); index += 1) {
        const skill = makeSkill(role_id, { created_at: addMilliseconds(NOW, index * 1_000) });
        await repository.saveSkill(role_id, skill);
        skills.push(skill);
      }
      const experiences: ExperienceRecord[] = [];
      for (let index = 0; index < (options.experiences ?? 1); index += 1) {
        const experience = makeExperience(role_id, {
          created_at: addMilliseconds(NOW, index * 1_000),
        });
        await repository.saveExperience(role_id, experience);
        experiences.push(experience);
      }
      return { skills, experiences };
    }

    async function claim(overrides: Partial<PersonaEvolutionClaimRequest> = {}) {
      return repository.claimNextPersonaEvolutionCandidate(
        claimRequest(role_id, overrides.owner ?? 'worker-1', overrides),
      );
    }

    /** 把一条 claim 到的候选按 `evolved` 落下去（正文由判定给出） */
    async function settleEvolved(
      candidate: ClaimedPersonaEvolutionCandidate,
      overrides: {
        now?: string;
        strategy_version?: string;
        source_run_id?: string;
        parent_version?: number;
        persona?: PersonaDef;
      } = {},
    ) {
      const parentVersion = overrides.parent_version ?? candidate.persona.version;
      return repository.completePersonaEvolution({
        role_id: candidate.role_id,
        claim_token: candidate.claim_token,
        owner: ownerOf(candidate),
        parent_version: parentVersion,
        outcome: 'evolved',
        strategy_version: overrides.strategy_version ?? STRATEGY_VERSION,
        input_snapshot_hash: candidate.input_snapshot_hash,
        source_run_id: overrides.source_run_id ?? 'run_seed_1',
        reasons: ['Candidate qualifies.'],
        change_summary: `Persona v${String(parentVersion)} → v${String(parentVersion + 1)}`,
        reviewed_by: 'system:auto-approval',
        persona:
          overrides.persona ??
          buildEvolvedPersona({
            role_id: candidate.role_id,
            draft: draft(),
            parent_version: parentVersion,
            now: overrides.now ?? NOW,
          }),
        now: overrides.now ?? NOW,
      });
    }

    async function marker() {
      return repository.getPersonaEvolutionMarker(role_id);
    }

    it('未演化过的角色是候选：claim 之后标记进 processing，并带上 token、租约与那次读到的输入', async () => {
      const { skills, experiences } = await seedInputs();

      const claimed = await claim();
      expect(claimed).toBeDefined();
      const candidate = claimed!;

      expect(candidate.marker.status).toBe('processing');
      expect(candidate.marker.claim_owner).toBe('worker-1');
      expect(candidate.marker.claim_token).toBeDefined();
      expect(candidate.marker.lease_expires_at).toBe(addMilliseconds(NOW, LEASE_MS));
      expect(candidate.attempt_count).toBe(1);
      // 父版本来自那次读到的 Persona（种子是 v1）
      expect(candidate.persona.version).toBe(1);
      expect(candidate.marker.parent_version).toBeUndefined();

      // 候选里带的快照就是判定能读到的全部输入
      expect(candidate.snapshot.role_id).toBe(role_id);
      expect(candidate.snapshot.skills.map((item) => item.id)).toEqual(skills.map((item) => item.id));
      expect(candidate.snapshot.experiences.map((item) => item.id)).toEqual(
        experiences.map((item) => item.id),
      );

      // hash 就是这份快照的 hash —— 适配器没有另外算一份
      expect(candidate.input_snapshot_hash).toBe(
        personaEvolutionInputSnapshotHash(candidate.snapshot),
      );
      expect(candidate.input_snapshot_hash).toMatch(/^[0-9a-f]{64}$/);

      // 标记确实持久化了（不是只活在返回值里）
      expect(await marker()).toMatchObject({ status: 'processing', claim_owner: 'worker-1' });
    });

    it('只有已批准技能与已落定的经验进快照；被挡下的那些不参与也不进 hash', async () => {
      const approved = makeSkill(role_id);
      const pending = makeSkill(role_id, { review_status: 'pending' });
      const settled = makeExperience(role_id);
      const inFlight = makeExperience(role_id, {
        promotion: promotionMarker('processing'),
      });
      await repository.saveSkill(role_id, approved);
      await repository.saveSkill(role_id, pending);
      await repository.saveExperience(role_id, settled);
      await repository.saveExperience(role_id, inFlight);

      const candidate = (await claim())!;

      expect(candidate.snapshot.skills.map((item) => item.id)).toEqual([approved.id]);
      expect(candidate.snapshot.experiences.map((item) => item.id)).toEqual([settled.id]);
      // 与「库里本来只有这两条」算出同一个 hash：被挡下的东西对判定完全不可见
      const clean = buildPersonaEvolutionSnapshot({
        role_id,
        skills: [approved],
        experiences: [settled],
      });
      expect(candidate.input_snapshot_hash).toBe(personaEvolutionInputSnapshotHash(clean));
    });

    it('自动批准：条件写落下新 Persona 版本，标记记全来源（run / 策略版本 / 快照 / 批准者）', async () => {
      await seedInputs();
      const candidate = (await claim())!;

      const result = await settleEvolved(candidate);
      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('expected applied');

      // Persona 真的推进了一版，正文就是判定交回来的那一份
      const persona = await repository.getPersona(role_id);
      expect(persona.version).toBe(2);
      expect(persona.summary).toBe(draft().summary);
      expect(persona.notes).toBe(draft().notes);
      // 聚合根内嵌的快照同源：两个读口给出两个版本号就是漂移
      expect((await repository.getAgent(role_id)).persona.version).toBe(2);

      const stored = await marker();
      expect(stored).toMatchObject({
        status: 'processed',
        outcome: 'evolved',
        parent_version: 1,
        persona_version: 2,
        strategy_version: STRATEGY_VERSION,
        input_snapshot_hash: candidate.input_snapshot_hash,
        source_run_id: 'run_seed_1',
        reviewed_by: 'system:auto-approval',
        attempt_count: 1,
      });
      expect(stored?.change_summary).toContain('v1 → v2');
      expect(stored?.reasons).toEqual(['Candidate qualifies.']);
      // 终态清掉凭据：它们是活着的凭据，终态不再有人持有
      expect(stored?.claim_token).toBeUndefined();
      expect(stored?.lease_expires_at).toBeUndefined();
    });

    it('人工审核：只写标记，不写 Persona；同一个策略版本下不会反复重评', async () => {
      await seedInputs();
      const candidate = (await claim({ approval: 'manual_review' }))!;

      const result = await repository.completePersonaEvolution({
        role_id,
        claim_token: candidate.claim_token,
        owner: ownerOf(candidate),
        parent_version: candidate.persona.version,
        outcome: 'pending_review',
        strategy_version: STRATEGY_VERSION,
        input_snapshot_hash: candidate.input_snapshot_hash,
        source_run_id: 'run_seed_1',
        reasons: ['Candidate qualifies but the run is in manual_review mode.'],
        now: NOW,
      });

      expect(result.kind).toBe('applied');
      expect((await repository.getPersona(role_id)).version).toBe(1);
      const stored = await marker();
      expect(stored).toMatchObject({ outcome: 'pending_review', status: 'processed' });
      // 没有写出版本，因此标记上也不该留一个 persona_version 的第二说法
      expect(stored?.persona_version).toBeUndefined();
      expect(stored?.reviewed_by).toBeUndefined();

      // 同一份输入、同一版判据、仍是人工审核 → 不重评
      await expect(claim({ approval: 'manual_review' })).resolves.toBeUndefined();
      // 放宽成自动批准 → 这条等到了放行，可以重新评估
      await expect(claim({ approval: 'auto_approve' })).resolves.toBeDefined();
    });

    it('判定不合格：只写标记（带理由），不写 Persona', async () => {
      await seedInputs();
      const candidate = (await claim())!;

      const result = await repository.completePersonaEvolution({
        role_id,
        claim_token: candidate.claim_token,
        owner: ownerOf(candidate),
        parent_version: candidate.persona.version,
        outcome: 'rejected',
        strategy_version: STRATEGY_VERSION,
        input_snapshot_hash: candidate.input_snapshot_hash,
        source_run_id: 'run_seed_1',
        reasons: ['No new input since the last evolution.'],
        now: NOW,
      });

      expect(result.kind).toBe('applied');
      expect((await repository.getPersona(role_id)).version).toBe(1);
      const stored = await marker();
      expect(stored).toMatchObject({ status: 'processed', outcome: 'rejected' });
      // 「没有写出版本」这件事两腿读出来都是 undefined，但**落盘形态不同**：内存实现留着
      // 一个值是 undefined 的键，Pg 的 JSONB 会把它整条删掉（JSON.stringify 丢弃 undefined）。
      // 因此这里单列一条断言，而不是塞进 toMatchObject —— 后者要求键存在，会把这条无害的
      // 序列化差异读成语义差异。
      expect(stored?.persona_version).toBeUndefined();
    });

    it('幂等：同一份输入重复执行只有一个版本，第二次直接没有候选', async () => {
      const { skills } = await seedInputs();
      const first = (await claim())!;
      expect((await settleEvolved(first)).kind).toBe('applied');

      // 输入没变、判据没变 → 这条候选不该再被 claim 到
      await expect(claim()).resolves.toBeUndefined();

      const persona = await repository.getPersona(role_id);
      expect(persona.version).toBe(2);
      expect(await repository.listSkills(role_id)).toHaveLength(skills.length);
      // 标记还是那一条，没有被第二次演化改写
      expect(await marker()).toMatchObject({ persona_version: 2, outcome: 'evolved' });
    });

    it('输入变了（新增一条已批准技能）：重新评估并再推进一版', async () => {
      await seedInputs();
      const first = (await claim())!;
      expect((await settleEvolved(first)).kind).toBe('applied');

      await repository.saveSkill(role_id, makeSkill(role_id, { description: 'A brand new skill.' }));

      const second = await claim();
      expect(second).toBeDefined();
      expect(second!.input_snapshot_hash).not.toBe(first.input_snapshot_hash);
      expect(second!.persona.version).toBe(2);

      expect((await settleEvolved(second!)).kind).toBe('applied');
      expect((await repository.getPersona(role_id)).version).toBe(3);
    });

    it('策略版本变了：同一份输入被重新评估（允许重评，产不产新版本由策略回答）', async () => {
      await seedInputs();
      const first = (await claim())!;
      expect((await settleEvolved(first)).kind).toBe('applied');

      const second = await claim({ strategy_version: 'persona-threshold.v2' });
      expect(second).toBeDefined();
      expect(second!.input_snapshot_hash).toBe(first.input_snapshot_hash);
      expect(second!.marker.strategy_version).toBeUndefined();
    });

    it('父版本冲突：判定过期时不覆盖新版本，也不留下半截状态', async () => {
      await seedInputs();
      const candidate = (await claim())!;

      // 判定读到的父版本是 v1；在写回之前，Persona 被别人推进到 v2（前端 PATCH 或并发演化）
      const patched: PersonaDef = {
        ...(await repository.getPersona(role_id)),
        version: 2,
        summary: 'Patched by a human.',
      };
      await repository.savePersona(role_id, patched);

      const result = await settleEvolved(candidate, { parent_version: 1 });
      expect(result).toEqual({
        kind: 'parent_conflict',
        expected_parent_version: 1,
        current_version: 2,
      });

      // 新版本没有被覆盖，标记也没有被改写成终态（重投还能重新判一次）
      const persona = await repository.getPersona(role_id);
      expect(persona.version).toBe(2);
      expect(persona.summary).toBe('Patched by a human.');
      expect(await marker()).toMatchObject({ status: 'processing' });

      // 重投：租约过期后被回收，按新的父版本写回，落在 v3
      const later = addMilliseconds(NOW, LEASE_MS);
      const restored = await repository.restoreExpiredPersonaEvolutionClaims({
        role_id,
        now: later,
      });
      expect(restored).toHaveLength(1);

      const reclaimed = (await claim({ now: later }))!;
      expect(reclaimed.persona.version).toBe(2);
      const second = await settleEvolved(reclaimed, { now: later });
      expect(second.kind).toBe('applied');
      expect((await repository.getPersona(role_id)).version).toBe(3);
      expect((await marker())?.parent_version).toBe(2);
    });

    it('版本号只能由父版本推出：跳版本 / 换角色 / 缺正文一律拒绝，不写任何东西', async () => {
      await seedInputs();
      const candidate = (await claim())!;
      const base = {
        role_id,
        claim_token: candidate.claim_token,
        parent_version: 1,
        outcome: 'evolved' as const,
        strategy_version: STRATEGY_VERSION,
        input_snapshot_hash: candidate.input_snapshot_hash,
        source_run_id: 'run_seed_1',
        reasons: ['ok'],
        now: NOW,
      };

      await expect(
        repository.completePersonaEvolution({
          ...base,
          persona: buildEvolvedPersona({ role_id, draft: draft(), parent_version: 9, now: NOW }),
        }),
      ).rejects.toThrow(/requires persona version 2/);

      // 角色对不上与版本号对不上共用同一句话术（`assertPersonaRoleId`），两条腿逐字相同
      await expect(
        repository.completePersonaEvolution({
          ...base,
          persona: buildEvolvedPersona({
            role_id: 'role_someone_else',
            draft: draft(),
            parent_version: 1,
            now: NOW,
          }),
        }),
      ).rejects.toThrow(/Persona role_id mismatch: expected .*got role_someone_else/);

      await expect(repository.completePersonaEvolution(base)).rejects.toThrow(/requires a persona/);

      // 三次都只抛错：Persona 与标记一个字节都没动
      expect((await repository.getPersona(role_id)).version).toBe(1);
      expect(await marker()).toMatchObject({ status: 'processing', claim_token: candidate.claim_token });
    });

    it('两个 worker 并发 claim 同一角色：只有一个拿到', async () => {
      await seedInputs();

      const [left, right] = await Promise.all([claim({ owner: 'worker-a' }), claim({ owner: 'worker-b' })]);

      const winners = [left, right].filter((item) => item !== undefined);
      expect(winners).toHaveLength(1);
      const winner = winners[0]!;
      // 输的那次没有写任何东西：持有者与 token 都还是赢家的
      const stored = await marker();
      expect(stored?.claim_owner).toBe(winner.marker.claim_owner);
      expect(stored?.claim_token).toBe(winner.claim_token);
    });

    it('租约过期后可以被接管；旧凭据从此写不进任何东西', async () => {
      await seedInputs();
      const stranded = (await claim({ owner: 'worker-crashed' }))!;

      // 租约还在：回收什么都不做
      await expect(
        repository.restoreExpiredPersonaEvolutionClaims({
          role_id,
          now: addMilliseconds(NOW, 1_000),
        }),
      ).resolves.toHaveLength(0);

      const expiredAt = addMilliseconds(NOW, LEASE_MS);
      const restored = await repository.restoreExpiredPersonaEvolutionClaims({
        role_id,
        now: expiredAt,
      });
      expect(restored).toHaveLength(1);
      expect(restored[0]?.role_id).toBe(role_id);
      expect(restored[0]?.marker.status).toBe('pending');
      expect(restored[0]?.marker.claim_token).toBeUndefined();
      // 次数保留：这是同一条演化流的第二次投递，不是新的
      expect(restored[0]?.marker.attempt_count).toBe(1);

      // 新 worker 接管
      const takeover = (await claim({ owner: 'worker-takeover', now: expiredAt }))!;
      expect(takeover.attempt_count).toBe(2);

      // 旧 worker 拿着 claim 那一刻的凭据回来落结论：一次都不能成功
      const stale = await settleEvolved(stranded, { now: expiredAt });
      expect(stale.kind).toBe('claim_lost');

      // 新 worker 的持有完好无损
      expect(await marker()).toMatchObject({
        status: 'processing',
        claim_owner: 'worker-takeover',
        claim_token: takeover.claim_token,
      });

      const applied = await settleEvolved(takeover, { now: expiredAt });
      expect(applied.kind).toBe('applied');
      expect((await repository.getPersona(role_id)).version).toBe(2);
    });

    it('同一份 claim_token 只能用一次：落完结论之后重复落不再生效', async () => {
      await seedInputs();
      const candidate = (await claim())!;
      expect((await settleEvolved(candidate)).kind).toBe('applied');

      const again = await settleEvolved(candidate, {
        persona: buildEvolvedPersona({ role_id, draft: draft(), parent_version: 1, now: NOW }),
      });
      expect(again.kind).toBe('claim_lost');
      expect((await repository.getPersona(role_id)).version).toBe(2);
    });

    it('可重试失败退避回队列，跨过退避窗口后被重投；不可重试失败直接进死信', async () => {
      await seedInputs();
      const candidate = (await claim())!;

      const retried = await repository.failPersonaEvolution({
        role_id,
        claim_token: candidate.claim_token,
        owner: ownerOf(candidate),
        error: 'model_error: upstream timeout',
        retryable: true,
        now: NOW,
      });
      expect(retried).toMatchObject({ status: 'pending', attempt_count: 1 });
      expect(retried?.last_error).toContain('upstream timeout');
      expect(retried?.next_retry_at).toBeDefined();

      // 退避窗口没到：claim 不到，这一次「没活」
      await expect(claim()).resolves.toBeUndefined();
      // 跨过窗口就能重投
      const reclaimed = await claim({ now: retried!.next_retry_at! });
      expect(reclaimed).toBeDefined();

      const dead = await repository.failPersonaEvolution({
        role_id,
        claim_token: reclaimed!.claim_token,
        owner: ownerOf(reclaimed!),
        error: 'payload_unreadable: malformed decision',
        retryable: false,
        now: NOW,
      });
      expect(dead).toMatchObject({ status: 'dead_letter', attempt_count: 2 });
      // 死信只由人工放回：自动路径连着跑几次都不会碰它
      await expect(claim()).resolves.toBeUndefined();
      expect((await repository.getPersona(role_id)).version).toBe(1);
    });

    it('用满投递次数之后即使可重试也进死信；人工重试把死信放回队列并清零次数', async () => {
      await seedInputs();

      let current = (await claim({ now: NOW }))!;
      const failed = await repository.failPersonaEvolution({
        role_id,
        claim_token: current.claim_token,
        owner: ownerOf(current),
        error: 'storage_error: connection reset',
        retryable: true,
        now: NOW,
        policy: TIGHT_POLICY,
      });
      expect(failed).toMatchObject({ status: 'pending', attempt_count: 1 });

      current = (await claim({ now: NOW }))!;
      const exhausted = await repository.failPersonaEvolution({
        role_id,
        claim_token: current.claim_token,
        owner: ownerOf(current),
        error: 'storage_error: connection reset',
        retryable: true,
        now: NOW,
        policy: TIGHT_POLICY,
      });
      expect(exhausted).toMatchObject({ status: 'dead_letter', attempt_count: 2 });

      const revived = await repository.retryDeadLetterPersonaEvolution({ role_id, now: NOW });
      expect(revived).toMatchObject({ status: 'pending', attempt_count: 0 });
      expect(revived?.last_error).toBeUndefined();
      // 放回队列之后可以被重新 claim
      await expect(claim({ now: NOW })).resolves.toBeDefined();
    });

    it('非死信的记录不接受人工重试', async () => {
      await seedInputs();
      const candidate = (await claim())!;
      await expect(repository.retryDeadLetterPersonaEvolution({ role_id, now: NOW })).resolves.toBeUndefined();
      expect(await marker()).toMatchObject({ status: 'processing', claim_token: candidate.claim_token });
    });

    it('没有输入的角色照样被 claim 到：判定为空输入给出 rejected，且之后不再重评', async () => {
      // 种子角色没有任何技能与经验。这条通道不替判定做决定——「没有输入」由策略回答，
      // 因此它会先被 claim 一次、记下结论，然后按「同一份输入 + 同一版判据」跳过。
      const candidate = (await claim())!;
      expect(candidate.snapshot.skills).toHaveLength(0);
      expect(candidate.snapshot.experiences).toHaveLength(0);

      const result = await repository.completePersonaEvolution({
        role_id,
        claim_token: candidate.claim_token,
        owner: ownerOf(candidate),
        parent_version: candidate.persona.version,
        outcome: 'rejected',
        strategy_version: STRATEGY_VERSION,
        input_snapshot_hash: candidate.input_snapshot_hash,
        source_run_id: 'run_seed_1',
        reasons: ['No approved skills and no eligible experiences to evolve from.'],
        now: NOW,
      });
      expect(result.kind).toBe('applied');
      expect((await repository.getPersona(role_id)).version).toBe(1);
      await expect(claim()).resolves.toBeUndefined();
    });

    it('状态是派生的：标记缺席即未评估，租约过期即「可以被接管」', async () => {
      expect(await marker()).toBeUndefined();

      await seedInputs();
      const candidate = (await claim())!;
      // 读回来的是**持久层的事实**，不是一个内存里的副本
      const stored = await marker();
      expect(stored?.claim_token).toBe(candidate.claim_token);

      // 标记的形态与落盘的那一份逐字相同（两条腿各自的序列化都不该改动语义）
      expect(stored).toEqual(candidate.marker);

      // 回收之后凭据消失、状态回到待投递
      const restored = await repository.restoreExpiredPersonaEvolutionClaims({
        role_id,
        now: addMilliseconds(NOW, LEASE_MS),
      });
      expect(restored[0]?.marker).toEqual({
        ...candidate.marker,
        status: 'pending',
        claim_token: undefined,
        lease_expires_at: undefined,
        next_retry_at: undefined,
        last_error: 'Claim lease expired without completion.',
        updated_at: addMilliseconds(NOW, LEASE_MS),
      });
    });

    it('settlement 摊进标记的那组审计字段由服务层给：两条腿写出来的逐个相同', async () => {
      await seedInputs();
      const candidate = (await claim())!;
      const request = {
        role_id,
        claim_token: candidate.claim_token,
        owner: ownerOf(candidate),
        parent_version: 1,
        outcome: 'rejected' as const,
        strategy_version: STRATEGY_VERSION,
        input_snapshot_hash: candidate.input_snapshot_hash,
        source_run_id: 'run_audit',
        reasons: ['no_new_input'],
        change_summary: 'nothing to write',
        reviewed_by: 'system:auto-approval',
        now: NOW,
      };
      const expected = personaEvolutionSettlement(candidate.marker, request);

      await repository.completePersonaEvolution(request);
      const stored = await marker();

      // 除状态机那几列（凭据被清、committed 时刻由实现填）之外，审计字段逐个对上
      expect(stored).toMatchObject({
        outcome: expected.outcome,
        parent_version: expected.parent_version,
        strategy_version: expected.strategy_version,
        input_snapshot_hash: expected.input_snapshot_hash,
        source_run_id: expected.source_run_id,
        evaluated_at: expected.evaluated_at,
        reasons: expected.reasons,
        change_summary: expected.change_summary,
        reviewed_by: expected.reviewed_by,
      });
      // 非 evolved 的结论不记版本号。单列一条：JSONB 会把值为 undefined 的键删掉，
      // 塞进 toMatchObject 就成了「要求键存在」，两腿的落盘形态差异会被读成语义差异。
      expect(stored?.persona_version).toBe(expected.persona_version);
    });
  });
}

/** 一条经验的晋升标记（输入过滤读它） */
function promotionMarker(
  status: ExperiencePromotion['status'],
  overrides: Partial<ExperiencePromotion> = {},
): ExperiencePromotion {
  return {
    status,
    attempt_count: status === 'pending' ? 0 : 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

runPersonaEvolutionStateContract('InMemoryRepository', async () => new InMemoryRepository());

describe('persona evolution state contract — PgMemoryRepository on embedded PGlite', () => {
  const embedding = new HashEmbeddingProvider();
  let pool: SqlPool;

  beforeAll(async () => {
    pool = await createPGlitePool();
    await ensurePgMemorySchema(pool, embedding.dimensions);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS memory_persona_versions');
      await pool.query('DROP TABLE IF EXISTS memory_experiences');
      await pool.query('DROP TABLE IF EXISTS memory_skills');
      await pool.query('DROP TABLE IF EXISTS memory_agents');
      await pool.end();
    }
  });

  runPersonaEvolutionStateContract(
    'PgMemoryRepository (PGlite)',
    async () => new PgMemoryRepository({ pool, embedding, autoMigrate: false }),
  );

  /**
   * 跨进程那一条腿：同一份库上**两个 repository 实例**。
   *
   * 上一条契约里两个 worker 共用同一个实例，因此 `withRoleLock` 那层进程内串行也在起作用；
   * 这里刻意绕开它——两个实例各有一条 role 队列，谁也管不着谁，于是「只有一个拿到」只能由
   * 条件写的谓词兑现。这正是生产上两个进程抢同一个角色时的形状，也是内存实现**没有**的东西
   * （它没有第二个进程可言），因此只放在这条腿上。
   */
  it('跨实例并发 claim 同一角色：只有一条条件写成功（不靠进程内队列）', async () => {
    const role_id = `role_persona_evo_race_${randomUUID()}`;
    const first = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    const second = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    await first.initializeAgent({ role_id, name: 'Race Agent' });
    await first.saveSkill(role_id, makeSkill(role_id));

    const [left, right] = await Promise.all([
      first.claimNextPersonaEvolutionCandidate(claimRequest(role_id, 'worker-left')),
      second.claimNextPersonaEvolutionCandidate(claimRequest(role_id, 'worker-right')),
    ]);

    const winners = [left, right].filter((item) => item !== undefined);
    expect(winners).toHaveLength(1);
    const stored = await first.getPersonaEvolutionMarker(role_id);
    expect(stored?.claim_owner).toBe(winners[0]!.marker.claim_owner);
    expect(stored?.claim_token).toBe(winners[0]!.claim_token);
  });

  it('重启：新的 repository 实例接着处理上一个实例留下的候选', async () => {
    const role_id = `role_persona_evo_restart_${randomUUID()}`;
    const before = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    await before.initializeAgent({ role_id, name: 'Restart Agent' });
    await before.saveSkill(role_id, makeSkill(role_id));

    // 上一个进程 claim 之后崩了：标记停在 processing，凭据落在它手里
    const stranded = (await before.claimNextPersonaEvolutionCandidate(
      claimRequest(role_id, 'worker-crashed'),
    ))!;
    expect(stranded.marker.status).toBe('processing');

    // 重启：新的实例（内存里什么都没继承）读出同一条候选
    const after = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    const stored = await after.getPersonaEvolutionMarker(role_id);
    expect(stored?.claim_token).toBe(stranded.claim_token);
    expect(stored?.claim_owner).toBe('worker-crashed');

    // 租约过期后新实例能把它收回来继续处理
    const expiredAt = addMilliseconds(NOW, LEASE_MS);
    const restored = await after.restoreExpiredPersonaEvolutionClaims({ role_id, now: expiredAt });
    expect(restored).toHaveLength(1);
    expect(restored[0]?.marker.status).toBe('pending');

    const reclaimed = (await after.claimNextPersonaEvolutionCandidate(
      claimRequest(role_id, 'worker-after-restart', { now: expiredAt }),
    ))!;
    expect(reclaimed.attempt_count).toBe(2);

    // 旧实例手里的凭据再也写不进去——跨进程 fencing 的落点
    const stale = await before.completePersonaEvolution({
      role_id,
      claim_token: stranded.claim_token,
      owner: 'worker-crashed',
      parent_version: stranded.persona.version,
      outcome: 'evolved',
      strategy_version: STRATEGY_VERSION,
      input_snapshot_hash: stranded.input_snapshot_hash,
      source_run_id: 'run_stale',
      reasons: ['qualifies'],
      persona: buildEvolvedPersona({
        role_id,
        draft: draft(),
        parent_version: stranded.persona.version,
        now: expiredAt,
      }),
      now: expiredAt,
    });
    expect(stale.kind).toBe('claim_lost');
    expect((await after.getPersona(role_id)).version).toBe(1);
  });
});
