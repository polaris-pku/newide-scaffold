/**
 * Persona 版本历史与回滚的契约测试（Phase 4 修复 B）
 *
 * 覆盖 `MemoryRepository` 上那组**产物面**的语义：每一版 Persona 的正文留下来、按版本号读得回、
 * 当前版本那一行与当前 Persona 一致、回滚是「再写一版」而不是「擦掉一版」。断言一律落在
 * **持久化之后的状态**上（历史里的行、当前 Persona 的版本号、标记有没有被动过），而不是
 * 「某个函数被调用过」——后者在存储语义出错时照样通过。
 *
 * 第二条修复 B 轮次加的是**历史不可变**，测试的重点因此落在「拒绝之后什么都没变」上：同一个
 * `(role_id, persona_version)` 第二次来只有两种结局——同一笔写的重放（幂等，什么都不改）与
 * 冲突（拒绝，当前 Persona、Handle 与历史一起停在原处）。三条写入路径（手工 `savePersona`、
 * 演化落地、回滚）都要过这一关，因此三类用例各写一遍。此外还钉了三件容易只在一侧成立的事：
 * 版本号只能往前、身份（`role_id` / 版本号）必须自洽、以及**深拷贝边界**——调用方在方法返回
 * 后改自己手里那份对象，改不动仓储里的状态。
 *
 * 同一份契约跑两个后端（InMemoryRepository 与 PGlite 上的 PgMemoryRepository）。两条腿的共性
 * 到此为止：**跨进程**那一层（同一份库上两个 repository 实例、没有进程内 role 临界区可用）与
 * **迁移 / 脏数据**那一层（为 Phase B 之前落库的老 Agent 补 `baseline` 行、用裸 SQL 造出
 * 「这一版号已经被占」与「列与载荷各说各话」这两种坏状态）只能由 Pg 那条腿验——内存实现既
 * 没有第二个进程，也没有「老数据」可言，它必须"诚实"。这与 Phase 3/4 把「重启」与「跨实例
 * 并发」放在 Pg 那条腿上是同一条理由。
 *
 * 时间全部由注入的 `now` 提供：租约、回滚的新版本号与历史行的 `created_at` 都不依赖真实时钟。
 * 唯一的例外是 `savePersona`——端口签名里没有 `now`（那是既有契约，本阶段不改），那一行记的是
 * 写入时刻，因此对它的断言只要求「是个 ISO 时刻」。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION } from '../adapters/default-persona-evolution-strategy';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { PgMemoryRepository } from '../adapters/pg-memory-repository';
import { ensurePgMemorySchema } from '../adapters/pg-memory-schema';
import { createPGlitePool } from '../adapters/pglite-pool';
import { buildEvolvedPersona } from '../services/persona-evolution-decision';
import { addMilliseconds } from '../services/delivery-lifecycle';
import type {
  ClaimedPersonaEvolutionCandidate,
  MemoryRepository,
  PersonaEvolutionClaimRequest,
} from '../ports/memory-repository';
import type { PersonaEvolutionPersonaDraft } from '../ports/persona-evolution-strategy';
import type { SqlPool } from '../ports/sql-pool';
import type { ExperienceRecord, PersonaDef, SkillRecord } from '../schemas';

const NOW = '2026-10-11T12:00:00.000Z';
const LEASE_MS = 60_000;
const STRATEGY_VERSION = DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION;

// ═══════════════════════════════════════════
//  样例数据
// ═══════════════════════════════════════════

function makeSkill(role_id: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: randomUUID(),
    description: 'Prefer explicit contracts over implicit conventions.',
    description_embedding: [0.1, 0.2, 0.3],
    content: 'full skill content body',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['contracts'],
    promoted_at: NOW,
    agent_id: role_id,
    market_status: 'available',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeExperience(
  role_id: string,
  overrides: Partial<ExperienceRecord> = {},
): ExperienceRecord {
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
function draft(overrides: Partial<PersonaEvolutionPersonaDraft> = {}): PersonaEvolutionPersonaDraft {
  return {
    summary: 'A careful contract-first engineer.',
    skills_overview: '3 skills promoted.',
    experience_coverage: '5 experiences.',
    recent_performance: 'Steady.',
    notes: 'Evolved by the persona evolution job.',
    ...overrides,
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
//  同一份契约，两个后端各跑一遍
// ═══════════════════════════════════════════

function runPersonaVersionHistoryContract(
  label: string,
  createRepository: () => Promise<MemoryRepository>,
): void {
  describe(`persona version history contract — ${label}`, () => {
    let repository: MemoryRepository;
    let role_id: string;

    beforeAll(async () => {
      repository = await createRepository();
    });

    beforeEach(async () => {
      role_id = `role_persona_version_${randomUUID()}`;
      await repository.initializeAgent({ role_id, name: 'Persona Version Agent' });
    });

    async function seedInputs(options: { skills?: number } = {}) {
      for (let index = 0; index < (options.skills ?? 1); index += 1) {
        await repository.saveSkill(
          role_id,
          makeSkill(role_id, { created_at: addMilliseconds(NOW, index * 1_000) }),
        );
      }
      await repository.saveExperience(role_id, makeExperience(role_id));
    }

    async function claim(overrides: Partial<PersonaEvolutionClaimRequest> = {}) {
      return repository.claimNextPersonaEvolutionCandidate(
        claimRequest(role_id, overrides.owner ?? 'worker-1', overrides),
      );
    }

    /** claim 一条候选并按 `evolved` 落下去（正文由判定给出） */
    async function evolve(options: { now?: string; change_summary?: string } = {}) {
      const candidate = (await claim())!;
      const now = options.now ?? NOW;
      const parentVersion = candidate.persona.version;
      const result = await repository.completePersonaEvolution({
        role_id,
        claim_token: candidate.claim_token,
        owner: ownerOf(candidate),
        parent_version: parentVersion,
        outcome: 'evolved',
        strategy_version: STRATEGY_VERSION,
        input_snapshot_hash: candidate.input_snapshot_hash,
        source_run_id: 'run_history_1',
        reasons: ['Candidate qualifies.'],
        change_summary: options.change_summary ?? `Persona v${String(parentVersion)} evolved.`,
        reviewed_by: 'system:auto-approval',
        persona: buildEvolvedPersona({
          role_id,
          draft: draft({
            summary: `Evolved summary v${String(parentVersion + 1)}.`,
            notes: `Evolved from v${String(parentVersion)}.`,
          }),
          parent_version: parentVersion,
          now,
        }),
        now,
      });
      expect(result.kind).toBe('applied');
      return candidate;
    }

    async function versions() {
      return repository.listPersonaVersions(role_id);
    }

    async function versionNumbers() {
      return (await versions()).map((record) => record.persona_version);
    }

    /**
     * 一份手工写入用的正文：内容由参数决定，版本号由调用方给。
     *
     * `generated_at` 钉在常量 `NOW` 上，因此「同一份正文写两次」在两腿上都真的是同一份——
     * 拿真实时钟盖章的话，两次写下的 `generated_at` 不同，判等的就不是同一笔写了。
     *
     * 版本号刻意不在函数里推导（不做「当前 +1」）：这些用例要写的正是**版本号本身**这件事
     * ——往回写、跳着写、同一个号写两次——版本号因此必须由用例显式指定。
     */
    function body(version: number, overrides: Partial<PersonaDef> = {}): PersonaDef {
      return {
        role_id,
        version,
        summary: `Hand written v${String(version)}.`,
        skills_overview: 'x',
        experience_coverage: 'x',
        recent_performance: 'x',
        notes: 'x',
        generated_at: NOW,
        ...overrides,
      };
    }

    // ── 建 Agent 就有第 1 版 ─────────────────────────────────────

    it('建 Agent 就有第 1 版：种子那一行在历史里，读到的当前版本就是它', async () => {
      const history = await versions();
      expect(history).toHaveLength(1);

      const seed = history[0]!;
      expect(seed.persona_version).toBe(1);
      expect(seed.source).toBe('seed');
      // 种子版本的来历就是「建这个 Agent 时生成的」：没有父版本可谈，不编
      expect(seed.parent_version).toBeUndefined();
      expect(seed.source_run_id).toBeUndefined();
      expect(seed.rollback_from_version).toBeUndefined();

      const persona = await repository.getPersona(role_id);
      expect(seed.persona).toEqual(persona);
      // `created_at` 取正文自己的 generated_at，而不是「登记它的那一刻」
      expect(seed.created_at).toBe(persona.generated_at);

      const current = await repository.getCurrentPersonaVersion(role_id);
      expect(current?.persona_version).toBe(1);
      expect(current?.persona).toEqual(persona);
    });

    // ── 演化的产物 ───────────────────────────────────────────────

    it('演化落下一版：正文、标记与历史在同一次写里对齐，溯源字段一个不少', async () => {
      await seedInputs();
      const candidate = await evolve({ change_summary: 'Persona v1 → v2 from 1 skill.' });

      const persona = await repository.getPersona(role_id);
      const marker = await repository.getPersonaEvolutionMarker(role_id);
      expect(persona.version).toBe(2);
      expect(marker?.persona_version).toBe(2);

      const history = await versions();
      expect(history.map((record) => record.persona_version)).toEqual([1, 2]);

      const evolved = history[1]!;
      expect(evolved.source).toBe('evolution');
      expect(evolved.parent_version).toBe(1);
      expect(evolved.source_run_id).toBe('run_history_1');
      expect(evolved.strategy_version).toBe(STRATEGY_VERSION);
      expect(evolved.input_snapshot_hash).toBe(candidate.input_snapshot_hash);
      expect(evolved.change_summary).toBe('Persona v1 → v2 from 1 skill.');
      expect(evolved.reviewed_by).toBe('system:auto-approval');
      expect(evolved.created_at).toBe(NOW);
      // 逐字就是判定交回来的那一份正文（历史不是「另写一份摘要」，是完整正文）
      expect(evolved.persona).toEqual(persona);

      // 不变量：标记记下的那一版，历史里一定有（两者出自同一笔写）
      expect(history.some((record) => record.persona_version === marker?.persona_version)).toBe(true);
    });

    it('演化两次：每一版各占一行，父版本串成一条链（v1 的正文原样还在）', async () => {
      await seedInputs({ skills: 1 });
      await evolve();
      // 换一份输入才会再演化一次（同一份快照已经判过）
      await repository.saveSkill(role_id, makeSkill(role_id, { created_at: addMilliseconds(NOW, 5_000) }));
      await evolve({ now: addMilliseconds(NOW, 10_000) });

      const history = await versions();
      expect(history.map((record) => record.persona_version)).toEqual([1, 2, 3]);
      expect(history.map((record) => record.parent_version)).toEqual([undefined, 1, 2]);
      expect(history[0]!.persona.summary).toBe(`Seed persona for ${role_id}`);
      expect(history[1]!.persona.summary).toBe('Evolved summary v2.');
      expect(history[2]!.persona.summary).toBe('Evolved summary v3.');
    });

    it('只写标记的那两个出口不追加历史：人工审核与判定不合格都只动标记', async () => {
      for (const outcome of ['pending_review', 'rejected'] as const) {
        const isolatedRole = `role_persona_version_marker_${outcome}_${randomUUID()}`;
        await repository.initializeAgent({ role_id: isolatedRole, name: 'Marker Only Agent' });
        await repository.saveSkill(isolatedRole, makeSkill(isolatedRole));
        const candidate = (await repository.claimNextPersonaEvolutionCandidate(
          claimRequest(isolatedRole, 'worker-marker'),
        ))!;
        const settled = await repository.completePersonaEvolution({
          role_id: isolatedRole,
          claim_token: candidate.claim_token,
          owner: ownerOf(candidate),
          parent_version: candidate.persona.version,
          outcome,
          strategy_version: STRATEGY_VERSION,
          input_snapshot_hash: candidate.input_snapshot_hash,
          source_run_id: 'run_marker_only',
          reasons: ['Recorded without writing a persona.'],
          now: NOW,
        });

        expect(settled.kind).toBe('applied');
        // 这两条出口**不写 Persona**，因此也就没有新的一版可登记
        expect((await repository.getPersona(isolatedRole)).version).toBe(1);
        expect(await repository.listPersonaVersions(isolatedRole)).toHaveLength(1);
      }
    });

    it('父版本冲突时一个字节都不写：历史不多不少，也没有半截行', async () => {
      await seedInputs();
      const candidate = (await claim())!;

      // 期间前端 PATCH 把 Persona 推了一版：这次判定已经过期
      await repository.savePersona(role_id, {
        ...(await repository.getPersona(role_id)),
        version: 2,
        summary: 'Patched by a human.',
      });

      const settled = await repository.completePersonaEvolution({
        role_id,
        claim_token: candidate.claim_token,
        owner: ownerOf(candidate),
        parent_version: 1,
        outcome: 'evolved',
        strategy_version: STRATEGY_VERSION,
        input_snapshot_hash: candidate.input_snapshot_hash,
        source_run_id: 'run_conflict',
        reasons: ['Stale judgement.'],
        persona: buildEvolvedPersona({
          role_id,
          draft: draft(),
          parent_version: 1,
          now: NOW,
        }),
        now: NOW,
      });

      expect(settled.kind).toBe('parent_conflict');
      // 历史里只有种子那一行与 PATCH 那一行；这次冲突没有留下任何痕迹
      const history = await versions();
      expect(history.map((record) => record.persona_version)).toEqual([1, 2]);
      expect(history[1]!.source).toBe('manual');
      expect((await repository.getPersona(role_id)).summary).toBe('Patched by a human.');
    });

    // ── 手动写入（前端 PATCH / 按需重生成） ───────────────────────

    it('savePersona 写新的版本号：那一行跟着正文走，父版本记下被取代的那一版', async () => {
      const base = await repository.getPersona(role_id);
      await repository.savePersona(role_id, { ...base, version: 2, summary: 'Patched once.' });

      const history = await versions();
      expect(history.map((record) => record.persona_version)).toEqual([1, 2]);
      expect(history[1]!.source).toBe('manual');
      expect(history[1]!.parent_version).toBe(1);
      expect(history[1]!.persona.summary).toBe('Patched once.');
      expect(history[1]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // 当前版本那一行与当前 Persona 始终一致——这是回滚与审计依赖的那条不变量
      expect(history[1]!.persona).toEqual(await repository.getPersona(role_id));
      // 旧那一版原样还在：换正文换的是**新版本号**那一行，不是就地改写
      expect(history[0]!.persona.summary).toBe(`Seed persona for ${role_id}`);
    });

    // ── 历史不可变：同一个版本号只能落一次 ───────────────────────
    //
    // 这三条把「不可变」拆成三个可分别观察的结论：重放不报错也不改东西、冲突报错且什么都不改、
    // 版本号不许往回走。第三条是前两条的地基——回滚写下的是「当前版本 + 1」，只有版本号单调
    // 才能保证那个号一定是新的。

    it('同一版本重复写入相同记录是幂等的：不报错，历史一行不多不少、那一行一字不改', async () => {
      const handedIn = body(2, { summary: 'Hand written v2.' });
      await repository.savePersona(role_id, handedIn);
      const before = await versions();

      // 逐字相同的第二次写入（正文与来历都一样，只有「写的那一刻」不同）必须成功
      await repository.savePersona(role_id, { ...handedIn });

      // `toEqual` 是全字段比较，`created_at` 也在内：那一行是**原来那一行**，没有被重写
      expect(await versions()).toEqual(before);
      expect((await repository.getPersona(role_id)).version).toBe(2);
    });

    it('同一版本写入不同 Persona 被拒绝：当前 Persona、Handle 与历史一起停在原处', async () => {
      await repository.savePersona(role_id, body(2, { summary: 'The one that won.' }));
      const persona_before = await repository.getPersona(role_id);
      const agent_before = await repository.getAgent(role_id);
      const history_before = await versions();

      await expect(
        repository.savePersona(role_id, body(2, { summary: 'The one that lost.' })),
      ).rejects.toThrow(/append-only/);

      // 一个字节都没写：当前版本、聚合根快照、历史三者都还是冲突之前那一份
      expect(await repository.getPersona(role_id)).toEqual(persona_before);
      expect(await repository.getAgent(role_id)).toEqual(agent_before);
      expect(await versions()).toEqual(history_before);
      expect(history_before[1]!.persona.summary).toBe('The one that won.');
    });

    it('版本号只能往前：往一个历史里没有的旧号写被拒绝，历史与当前版本都不动', async () => {
      // 先造一个空档（v1 → v4）：2、3 从来没被写过，因此这不是「同一版本重写」而是「往回写」
      await repository.savePersona(role_id, body(4, { summary: 'Jumped to v4.' }));
      expect(await versionNumbers()).toEqual([1, 4]);

      await expect(repository.savePersona(role_id, body(3))).rejects.toThrow(/must advance/);

      expect(await versionNumbers()).toEqual([1, 4]);
      expect((await repository.getPersona(role_id)).version).toBe(4);
    });

    it('role_id 不一致被拒绝：不能让 A 保存 B 的 Persona', async () => {
      const before = await versions();

      await expect(
        repository.savePersona(role_id, body(2, { role_id: 'role_someone_else' })),
      ).rejects.toThrow(/Persona role_id mismatch: expected .*got role_someone_else/);

      expect(await versions()).toEqual(before);
      expect((await repository.getPersona(role_id)).version).toBe(1);
    });

    // ── 历史不可变：演化与回滚也只在末尾追加 ─────────────────────

    it('演化追加而不改写：新一版落下之后，旧版本的正文与那一行的来历逐字段还在', async () => {
      await seedInputs({ skills: 1 });
      await evolve();
      const v1 = await repository.getPersonaVersion(role_id, 1);
      const v2 = await repository.getPersonaVersion(role_id, 2);

      // 换一份输入才会再演化一次（同一份快照已经判过）
      await repository.saveSkill(role_id, makeSkill(role_id, { created_at: addMilliseconds(NOW, 5_000) }));
      await evolve({ now: addMilliseconds(NOW, 10_000) });

      expect(await versionNumbers()).toEqual([1, 2, 3]);
      expect(await repository.getPersonaVersion(role_id, 1)).toEqual(v1);
      expect(await repository.getPersonaVersion(role_id, 2)).toEqual(v2);
    });

    it('回滚追加而不改写：已经落下的每一行逐字段没变，新一版是追加出来的', async () => {
      await seedInputs({ skills: 1 });
      await evolve();
      const before = await versions();

      await repository.rollbackPersona({
        role_id,
        target_version: 1,
        expected_current_version: 2,
        now: addMilliseconds(NOW, 30_000),
      });

      const after = await versions();
      expect(after.map((record) => record.persona_version)).toEqual([1, 2, 3]);
      // `toEqual` 是全字段比较：正文、来历与 `created_at` 都没被动过
      expect(after.slice(0, 2)).toEqual(before);
    });

    // ── 深拷贝边界 ───────────────────────────────────────────────
    //
    // 内存后端里「历史」就是一批对象，不拷贝就等于把仓储状态借给调用方随手改（Pg 那条腿每次
    // 读都过一次 JSON 反序列化，天然没有这个耦合）。因此边界两侧都验：**传进来那一份**与
    // **交回去那一份**，方法返回之后改它们都改不动仓储。

    it('深拷贝边界：改读回来的每一份都改不动仓储（历史 / 当前 Persona / Handle / 回滚的返回）', async () => {
      await seedInputs();
      await evolve();

      // 读回来的历史行：连嵌套的 persona 一起改
      const record = (await repository.getPersonaVersion(role_id, 2))!;
      record.persona.summary = 'mutated through the history read';
      record.persona.notes = 'mutated through the history read';
      record.change_summary = 'mutated through the history read';
      expect((await repository.getPersonaVersion(role_id, 2))!.persona.summary).toBe(
        'Evolved summary v2.',
      );

      // 读回来的当前 Persona 与聚合根快照（Handle 内嵌 persona）
      const persona = await repository.getPersona(role_id);
      persona.summary = 'mutated through getPersona';
      expect((await repository.getPersona(role_id)).summary).toBe('Evolved summary v2.');
      const agent = await repository.getAgent(role_id);
      agent.persona.summary = 'mutated through getAgent';
      expect((await repository.getAgent(role_id)).persona.summary).toBe('Evolved summary v2.');

      // 交回去的回滚结果：persona 与 record 两份都是副本
      const rolled = await repository.rollbackPersona({
        role_id,
        target_version: 1,
        expected_current_version: 2,
        now: addMilliseconds(NOW, 1_000),
      });
      expect(rolled.kind).toBe('applied');
      if (rolled.kind !== 'applied') return;
      rolled.persona.summary = 'mutated after the rollback';
      rolled.record.persona.summary = 'mutated after the rollback';
      rolled.record.change_summary = 'mutated after the rollback';
      expect((await repository.getPersona(role_id)).summary).toBe(`Seed persona for ${role_id}`);
      expect((await repository.getCurrentPersonaVersion(role_id))!.change_summary).toContain(
        'rolled back to v1',
      );
      expect((await repository.getAgent(role_id)).persona.summary).toBe(
        `Seed persona for ${role_id}`,
      );
    });

    it('深拷贝边界：改传进去的那一份、改演化交回来的那一份，都改不动仓储', async () => {
      await seedInputs({ skills: 1 });
      const candidate = (await claim())!;
      const handedIn = buildEvolvedPersona({
        role_id,
        draft: draft({ summary: 'Evolved summary v2.' }),
        parent_version: 1,
        now: NOW,
      });
      const result = await repository.completePersonaEvolution({
        role_id,
        claim_token: candidate.claim_token,
        owner: ownerOf(candidate),
        parent_version: 1,
        outcome: 'evolved',
        strategy_version: STRATEGY_VERSION,
        input_snapshot_hash: candidate.input_snapshot_hash,
        source_run_id: 'run_deep_copy',
        reasons: ['qualifies'],
        persona: handedIn,
        now: NOW,
      });
      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') return;

      // 写入方手里那一份、判定交回来的那一份，返回之后都改不动仓储
      handedIn.summary = 'mutated after the write';
      handedIn.notes = 'mutated after the write';
      result.persona!.summary = 'mutated after the evolution';
      expect((await repository.getPersona(role_id)).summary).toBe('Evolved summary v2.');
      expect((await repository.getAgent(role_id)).persona.summary).toBe('Evolved summary v2.');
      expect((await repository.getPersonaVersion(role_id, 2))!.persona.summary).toBe(
        'Evolved summary v2.',
      );

      // 手工写入那一份同理
      const patched = body(3, { summary: 'Handed in.' });
      await repository.savePersona(role_id, patched);
      patched.summary = 'mutated after the write';
      patched.notes = 'mutated after the write';
      expect((await repository.getPersona(role_id)).summary).toBe('Handed in.');
      expect((await repository.getAgent(role_id)).persona.summary).toBe('Handed in.');
      expect((await repository.getPersonaVersion(role_id, 3))!.persona.summary).toBe('Handed in.');
    });

    // ── 回滚 ─────────────────────────────────────────────────────

    it('回滚：正文抄自目标版本，版本号是新的，父子关系与原因都记在那一行', async () => {
      await seedInputs({ skills: 1 });
      const seedSummary = (await repository.getPersona(role_id)).summary;
      await evolve();
      await repository.saveSkill(role_id, makeSkill(role_id, { created_at: addMilliseconds(NOW, 5_000) }));
      await evolve({ now: addMilliseconds(NOW, 10_000) });
      expect((await repository.getPersona(role_id)).version).toBe(3);

      const applied = await repository.rollbackPersona({
        role_id,
        target_version: 1,
        expected_current_version: 3,
        reason: 'The evolution made the persona worse.',
        reviewed_by: 'operator-1',
        now: addMilliseconds(NOW, 20_000),
      });

      expect(applied.kind).toBe('applied');
      if (applied.kind !== 'applied') return;
      // 新版本号：不回退到 1，也不复用 3
      expect(applied.persona.version).toBe(4);
      expect(applied.persona.summary).toBe(seedSummary);
      expect(applied.record.source).toBe('rollback');
      expect(applied.record.parent_version).toBe(3);
      expect(applied.record.rollback_from_version).toBe(1);
      expect(applied.record.reviewed_by).toBe('operator-1');
      expect(applied.record.created_at).toBe(addMilliseconds(NOW, 20_000));
      expect(applied.record.change_summary).toContain('rolled back to v1');
      expect(applied.record.change_summary).toContain('The evolution made the persona worse.');

      // 当前 Persona 就是这个新版本，而且它**不等于**任何一版被覆盖掉的正文（版本号与时刻是新的）
      const persona = await repository.getPersona(role_id);
      expect(persona.version).toBe(4);
      expect(persona.summary).toBe(seedSummary);
      expect(await repository.getCurrentPersonaVersion(role_id)).toEqual(applied.record);
    });

    it('回滚不改写旧历史：目标版本那一行原样还在，版本号只增不减', async () => {
      await seedInputs();
      await evolve();
      const before = await repository.getPersonaVersion(role_id, 2);
      const beforeSeed = await repository.getPersonaVersion(role_id, 1);

      await repository.rollbackPersona({
        role_id,
        target_version: 1,
        expected_current_version: 2,
        now: addMilliseconds(NOW, 30_000),
      });

      expect(await versionNumbers()).toEqual([1, 2, 3]);
      expect(await repository.getPersonaVersion(role_id, 2)).toEqual(before);
      expect(await repository.getPersonaVersion(role_id, 1)).toEqual(beforeSeed);
      // 这一版的正文正是第 1 版正文的副本（版本号与生成时刻属于新的一版）
      const rolled = await repository.getPersonaVersion(role_id, 3);
      expect(rolled?.persona.summary).toBe(beforeSeed?.persona.summary);
      expect(rolled?.persona.notes).toBe(beforeSeed?.persona.notes);
      expect(rolled?.persona.version).toBe(3);
      expect(rolled?.persona.generated_at).toBe(addMilliseconds(NOW, 30_000));
    });

    it('回滚到不存在的版本：target_missing，什么都不写', async () => {
      await seedInputs();
      await evolve();

      const missing = await repository.rollbackPersona({
        role_id,
        target_version: 99,
        expected_current_version: 2,
        now: NOW,
      });

      expect(missing).toEqual({ kind: 'target_missing', target_version: 99 });
      expect(await versionNumbers()).toEqual([1, 2]);
      expect((await repository.getPersona(role_id)).version).toBe(2);
    });

    it('期望的当前版本对不上：version_conflict，一个字节都不写', async () => {
      await seedInputs();
      await evolve();

      const stale = await repository.rollbackPersona({
        role_id,
        target_version: 1,
        // 调用方手里那份是「当前是第 1 版」时读的，现在已经第 2 版了
        expected_current_version: 1,
        now: NOW,
      });

      expect(stale).toEqual({
        kind: 'version_conflict',
        expected_version: 1,
        current_version: 2,
      });
      expect(await versionNumbers()).toEqual([1, 2]);
      expect((await repository.getPersona(role_id)).version).toBe(2);
    });

    it('并发回滚（同一个期望版本）：一个赢，一个拿到明确的冲突', async () => {
      await seedInputs();
      await evolve();

      const [left, right] = await Promise.all([
        repository.rollbackPersona({
          role_id,
          target_version: 1,
          expected_current_version: 2,
          reason: 'left',
          now: NOW,
        }),
        repository.rollbackPersona({
          role_id,
          target_version: 1,
          expected_current_version: 2,
          reason: 'right',
          now: NOW,
        }),
      ]);

      const winners = [left, right].filter((result) => result.kind === 'applied');
      const losers = [left, right].filter((result) => result.kind === 'version_conflict');
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      // 输的那个必须知道自己输了（而不是悄悄再写一版），且报出的当前版本就是赢家写下的那一版
      expect(losers[0]).toEqual({
        kind: 'version_conflict',
        expected_version: 2,
        current_version: 3,
      });
      // 只追加了一行：赢家那一版
      expect(await versionNumbers()).toEqual([1, 2, 3]);
      expect((await repository.getPersona(role_id)).version).toBe(3);
    });

    it('回滚之后旧 worker 的演化写不进去：父版本条件立刻过期，历史不被污染', async () => {
      await seedInputs();
      // 一个 worker 拿着 v1 的判定（claim 到手，还没写回）
      const candidate = (await claim())!;

      // 期间运维回滚到第 1 版——等价于「当前版本又往前推了一版」
      const rolled = await repository.rollbackPersona({
        role_id,
        target_version: 1,
        expected_current_version: 1,
        now: addMilliseconds(NOW, 1_000),
      });
      expect(rolled.kind).toBe('applied');

      const stale = await repository.completePersonaEvolution({
        role_id,
        claim_token: candidate.claim_token,
        owner: ownerOf(candidate),
        parent_version: 1,
        outcome: 'evolved',
        strategy_version: STRATEGY_VERSION,
        input_snapshot_hash: candidate.input_snapshot_hash,
        source_run_id: 'run_stale',
        reasons: ['Judged before the rollback.'],
        persona: buildEvolvedPersona({
          role_id,
          draft: draft(),
          parent_version: 1,
          now: NOW,
        }),
        now: addMilliseconds(NOW, 2_000),
      });

      expect(stale.kind).toBe('parent_conflict');
      // 那一版没有被写下去，历史里只有「种子 + 回滚出来的那一版」
      expect(await versionNumbers()).toEqual([1, 2]);
      expect((await repository.getPersona(role_id)).version).toBe(2);
    });

    it('回滚不碰演化标记：下一次演化不会把刚回滚掉的那一版原样写回来', async () => {
      await seedInputs();
      await evolve();
      const markerBefore = await repository.getPersonaEvolutionMarker(role_id);

      await repository.rollbackPersona({
        role_id,
        target_version: 1,
        expected_current_version: 2,
        now: addMilliseconds(NOW, 1_000),
      });

      // 标记一字未动：去重键（输入快照 + 策略版本）仍然成立
      expect(await repository.getPersonaEvolutionMarker(role_id)).toEqual(markerBefore);
      // 因此下一次跑演化对这个角色**没有活**——回滚才是真的回滚，不会被下一次运行撤销。
      // 想要那一版回来，得让输入或策略版本变化（那时它是一条新的判定，不是重放旧的）
      expect(await claim()).toBeUndefined();
      expect(await versionNumbers()).toEqual([1, 2, 3]);
    });

    // ── 读端口 ───────────────────────────────────────────────────

    it('读端口：按版本取一行、limit 取最近 N 条（仍按版本号升序）', async () => {
      await seedInputs({ skills: 1 });
      await evolve();
      await repository.saveSkill(role_id, makeSkill(role_id, { created_at: addMilliseconds(NOW, 5_000) }));
      await evolve({ now: addMilliseconds(NOW, 10_000) });

      expect((await repository.getPersonaVersion(role_id, 2))?.source).toBe('evolution');
      expect(await repository.getPersonaVersion(role_id, 42)).toBeUndefined();

      expect((await repository.listPersonaVersions(role_id, { limit: 2 })).map((r) => r.persona_version))
        .toEqual([2, 3]);
      expect(await repository.listPersonaVersions(role_id, { limit: 0 })).toEqual([]);
      await expect(
        repository.listPersonaVersions(role_id, { limit: -1 }),
      ).rejects.toThrow(/non-negative integer/);
    });

    it('角色不存在：三个读端口都抛错（与 getPersona 一致），不当成「它没有历史」', async () => {
      const missing = `role_absent_${randomUUID()}`;
      await expect(repository.listPersonaVersions(missing)).rejects.toThrow(/Agent not found/);
      await expect(repository.getPersonaVersion(missing, 1)).rejects.toThrow(/Agent not found/);
      await expect(repository.getCurrentPersonaVersion(missing)).rejects.toThrow(/Agent not found/);
      await expect(
        repository.rollbackPersona({
          role_id: missing,
          target_version: 1,
          expected_current_version: 1,
          now: NOW,
        }),
      ).rejects.toThrow(/Agent not found/);
    });

    it('读回来的历史不是库里那一份的别名：改它不影响下一次读', async () => {
      await seedInputs();
      await evolve();

      const first = (await repository.getPersonaVersion(role_id, 2))!;
      first.persona.summary = 'mutated by the caller';
      first.change_summary = 'mutated by the caller';

      const second = (await repository.getPersonaVersion(role_id, 2))!;
      expect(second.persona.summary).toBe('Evolved summary v2.');
      expect(second.change_summary).toBe('Persona v1 evolved.');

      // 写下去的那一份也一样：调用方手里那份之后被改，历史不该跟着动
      const passedIn: PersonaDef = {
        role_id,
        version: 5,
        summary: 'Handed in.',
        skills_overview: 'x',
        experience_coverage: 'x',
        recent_performance: 'x',
        notes: 'x',
        generated_at: NOW,
      };
      await repository.savePersona(role_id, passedIn);
      passedIn.summary = 'mutated after the write';
      expect((await repository.getPersonaVersion(role_id, 5))?.persona.summary).toBe('Handed in.');
    });
  });
}

runPersonaVersionHistoryContract('InMemoryRepository', async () => new InMemoryRepository());

describe('persona version history — PgMemoryRepository on embedded PGlite', () => {
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

  runPersonaVersionHistoryContract(
    'PgMemoryRepository (PGlite)',
    async () => new PgMemoryRepository({ pool, embedding, autoMigrate: false }),
  );

  /**
   * 跨进程那一条腿：同一份库上**两个 repository 实例**。
   *
   * 上一条契约里两个调用共用同一个实例，因此 `withRoleLock` 那层进程内串行也在起作用；这里
   * 刻意绕开它——两个实例各有一条 role 队列，谁也管不着谁，于是「只有一个赢」只能由条件写的
   * 谓词兑现。这正是生产上两个进程同时回滚同一个角色时的形状，也是内存实现**没有**的东西
   * （它没有第二个进程可言），因此只放在这条腿上。
   */
  it('跨实例并发回滚：只有一条条件写成功，另一个拿到明确的冲突', async () => {
    const role_id = `role_persona_version_race_${randomUUID()}`;
    const first = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    const second = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    await first.initializeAgent({ role_id, name: 'Race Agent' });
    await first.saveSkill(role_id, makeSkill(role_id));
    const claimed = (await first.claimNextPersonaEvolutionCandidate(
      claimRequest(role_id, 'worker-race'),
    ))!;
    await first.completePersonaEvolution({
      role_id,
      claim_token: claimed.claim_token,
      owner: ownerOf(claimed),
      parent_version: 1,
      outcome: 'evolved',
      strategy_version: STRATEGY_VERSION,
      input_snapshot_hash: claimed.input_snapshot_hash,
      source_run_id: 'run_race',
      reasons: ['qualifies'],
      persona: buildEvolvedPersona({ role_id, draft: draft(), parent_version: 1, now: NOW }),
      now: NOW,
    });

    const [left, right] = await Promise.all([
      first.rollbackPersona({
        role_id,
        target_version: 1,
        expected_current_version: 2,
        reason: 'left',
        now: NOW,
      }),
      second.rollbackPersona({
        role_id,
        target_version: 1,
        expected_current_version: 2,
        reason: 'right',
        now: NOW,
      }),
    ]);

    expect([left, right].filter((result) => result.kind === 'applied')).toHaveLength(1);
    expect([left, right].filter((result) => result.kind === 'version_conflict')).toHaveLength(1);
    const history = await first.listPersonaVersions(role_id);
    expect(history.map((record) => record.persona_version)).toEqual([1, 2, 3]);
    expect((await second.getPersona(role_id)).version).toBe(3);
  });

  it('重启：新的实例读得回上一实例写下的每一版（历史是持久化状态，不是进程内缓存）', async () => {
    const role_id = `role_persona_version_restart_${randomUUID()}`;
    const before = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    await before.initializeAgent({ role_id, name: 'Restart Agent' });
    await before.saveSkill(role_id, makeSkill(role_id));
    const claimed = (await before.claimNextPersonaEvolutionCandidate(
      claimRequest(role_id, 'worker-restart'),
    ))!;
    await before.completePersonaEvolution({
      role_id,
      claim_token: claimed.claim_token,
      owner: ownerOf(claimed),
      parent_version: 1,
      outcome: 'evolved',
      strategy_version: STRATEGY_VERSION,
      input_snapshot_hash: claimed.input_snapshot_hash,
      source_run_id: 'run_restart',
      reasons: ['qualifies'],
      change_summary: 'Persona v1 → v2 before the restart.',
      persona: buildEvolvedPersona({ role_id, draft: draft(), parent_version: 1, now: NOW }),
      now: NOW,
    });
    await before.rollbackPersona({
      role_id,
      target_version: 1,
      expected_current_version: 2,
      reason: 'rollback before the restart',
      now: addMilliseconds(NOW, 1_000),
    });

    // 重启：新的实例（内存里什么都没继承）从库里读回三版
    const after = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    const history = await after.listPersonaVersions(role_id);
    expect(history.map((record) => record.persona_version)).toEqual([1, 2, 3]);
    expect(history.map((record) => record.source)).toEqual(['seed', 'evolution', 'rollback']);
    expect(history[1]!.change_summary).toBe('Persona v1 → v2 before the restart.');
    expect(history[2]!.rollback_from_version).toBe(1);
    expect((await after.getCurrentPersonaVersion(role_id))?.persona).toEqual(
      await after.getPersona(role_id),
    );
    // 重启之后照样能继续回滚：条件写读的是库里的当前版本
    const rolled = await after.rollbackPersona({
      role_id,
      target_version: 2,
      expected_current_version: 3,
      now: addMilliseconds(NOW, 2_000),
    });
    expect(rolled.kind).toBe('applied');
    expect((await after.getPersona(role_id)).version).toBe(4);
  });

  /**
   * 迁移那一条腿：Phase B 之前落库的 Agent 没有历史行，旧正文已经补不回来，能如实登记的只有
   * 「迁移这一刻的当前版本」。这里用「删掉历史行再跑一次迁移」来复现那个形态——它同时是修复
   * 步骤（缺行会被补上），因此同一个用例顺手验了两件事。
   */
  it('迁移为老 Agent 补一行 baseline：来源如实写「来历不明」，不改写已有历史', async () => {
    const repository = new PgMemoryRepository({ pool, embedding, autoMigrate: false });

    // 「Phase B 之前落库」的形态：Agent 在库里，历史表里一行都没有（那时还没有这张表）。
    // 用「建好之后把这些行删掉」复现——注册表本身没有历史，这个 Agent 因此与老 Agent 同形。
    const legacy_role = `role_persona_version_legacy_${randomUUID()}`;
    await repository.initializeAgent({ role_id: legacy_role, name: 'Legacy Agent' });
    await pool.query('DELETE FROM memory_persona_versions WHERE role_id = $1', [legacy_role]);

    // 另一个走完整流程的角色：它的历史由演化写就，迁移必须**一行都不动**
    const modern_role = `role_persona_version_modern_${randomUUID()}`;
    await repository.initializeAgent({ role_id: modern_role, name: 'Modern Agent' });
    await repository.saveSkill(modern_role, makeSkill(modern_role));
    const claimed = (await repository.claimNextPersonaEvolutionCandidate(
      claimRequest(modern_role, 'worker-legacy'),
    ))!;
    await repository.completePersonaEvolution({
      role_id: modern_role,
      claim_token: claimed.claim_token,
      owner: ownerOf(claimed),
      parent_version: 1,
      outcome: 'evolved',
      strategy_version: STRATEGY_VERSION,
      input_snapshot_hash: claimed.input_snapshot_hash,
      source_run_id: 'run_legacy',
      reasons: ['qualifies'],
      change_summary: 'Persona v1 → v2 (evolution).',
      persona: buildEvolvedPersona({ role_id: modern_role, draft: draft(), parent_version: 1, now: NOW }),
      now: NOW,
    });

    // 再跑一次迁移（幂等）
    await ensurePgMemorySchema(pool, embedding.dimensions);

    // 老 Agent：补上**当前**版本那一行，来源自称来历不明（父版本 / run / 策略版本都缺席，不编）
    const baselineHistory = await repository.listPersonaVersions(legacy_role);
    expect(baselineHistory).toHaveLength(1);
    const baseline = baselineHistory[0]!;
    expect(baseline.source).toBe('baseline');
    expect(baseline.persona_version).toBe(1);
    // 列与载荷里的版本号同源（都由正文派生），不会各说各话
    expect(baseline.persona_version).toBe(baseline.persona.version);
    expect(baseline.persona.role_id).toBe(legacy_role);
    expect(baseline.parent_version).toBeUndefined();
    expect(baseline.source_run_id).toBeUndefined();
    expect(baseline.strategy_version).toBeUndefined();
    expect(baseline.rollback_from_version).toBeUndefined();
    // created_at 取正文自己的 generated_at，而不是「迁移那一刻」
    expect(baseline.created_at).toBe(baseline.persona.generated_at);
    // 「当前版本在历史里有一行」这条不变量在补完之后成立
    expect((await repository.getCurrentPersonaVersion(legacy_role))?.persona_version).toBe(1);

    // 走完整流程的那个角色：迁移是 DO NOTHING，既有历史一行没被改写
    const modernHistory = await repository.listPersonaVersions(modern_role);
    expect(modernHistory.map((record) => record.persona_version)).toEqual([1, 2]);
    expect(modernHistory.map((record) => record.source)).toEqual(['seed', 'evolution']);
    expect(modernHistory[1]!.change_summary).toBe('Persona v1 → v2 (evolution).');
    expect(modernHistory[1]!.parent_version).toBe(1);
  });

  /**
   * 不可变的另一条腿：**这一版号已经被占**与**历史行的列与载荷各说各话**这两种状态。
   *
   * 内存实现里这两件事都造不出来（没有裸 SQL，也没有第二个写入方），而它们恰恰是「历史
   * append-only」真正要挡的东西——正常路径上写入一律落在「当前版本 + 1」，撞车只可能来自
   * 跨进程的并发，或者库里已经躺着一行坏数据。这里的裸 SQL 是**造状态**，不是替代被测代码：
   * 被判的还是 `savePersona` / `completePersonaEvolution` / `rollbackPersona` / 三个读口本身。
   */
  async function occupyVersion(
    repository: PgMemoryRepository,
    role_id: string,
    version: number,
    summary: string,
  ): Promise<void> {
    const persona = {
      ...(await repository.getPersona(role_id)),
      version,
      summary,
      generated_at: NOW,
    };
    await pool.query(
      `INSERT INTO memory_persona_versions (role_id, persona_version, payload)
       VALUES ($1, $2, $3::jsonb)`,
      [
        role_id,
        version,
        JSON.stringify({
          role_id,
          persona_version: version,
          persona,
          source: 'manual',
          created_at: NOW,
        }),
      ],
    );
  }

  it('跨实例并发写同一个版本号：只有一个成功，输的拿到明确的冲突，历史与当前版本仍一致', async () => {
    const role_id = `role_persona_version_write_race_${randomUUID()}`;
    const first = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    const second = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    await first.initializeAgent({ role_id, name: 'Write Race Agent' });
    const base = await first.getPersona(role_id);

    // 两个实例各写一份内容不同的 v2：没有进程内 role 队列保护（两个实例各一条），因此
    // 「最多一个成功」只能由历史表的主键兑现
    const outcomes = await Promise.allSettled([
      first.savePersona(role_id, { ...base, version: 2, summary: 'Written by the first.' }),
      second.savePersona(role_id, { ...base, version: 2, summary: 'Written by the second.' }),
    ]);

    const summaries = ['Written by the first.', 'Written by the second.'];
    const settled = outcomes.map((outcome, index) => ({ outcome, summary: summaries[index]! }));
    const winners = settled.filter(({ outcome }) => outcome.status === 'fulfilled');
    const losers = settled.filter(({ outcome }) => outcome.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // 输的那个必须**明确地**知道自己撞上了不可变的历史，而不是悄悄再写一版
    expect(String((losers[0]!.outcome as PromiseRejectedResult).reason)).toMatch(/append-only/);

    // 不产生半写：历史两行、当前版本 v2，落进去的是**赢家**那一份，输家那一份一个字都不在，
    // 而且「当前版本那一行」就是当前 Persona
    const history = await first.listPersonaVersions(role_id);
    expect(history.map((record) => record.persona_version)).toEqual([1, 2]);
    const persona = await first.getPersona(role_id);
    expect(persona.version).toBe(2);
    expect(persona.summary).toBe(winners[0]!.summary);
    expect(history[1]!.persona).toEqual(persona);
    expect(await second.getPersona(role_id)).toEqual(persona);
  });

  it('这一版号已经被占时演化不覆盖：抛错，Persona、标记与那一行历史都停在原处', async () => {
    const repository = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    const role_id = `role_persona_version_occupied_evolution_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'Occupied Evolution Agent' });
    await repository.saveSkill(role_id, makeSkill(role_id));
    const candidate = (await repository.claimNextPersonaEvolutionCandidate(
      claimRequest(role_id, 'worker-occupied'),
    ))!;

    // 判定期间（claim 之后、写回之前）这一版号已经被别人占了——跨进程的另一次写入，或者
    // 库里本来就有的一行坏数据。判定的父版本条件仍然成立（当前还是 v1），因此挡下这一笔的
    // 只能是「历史不可变」
    await occupyVersion(repository, role_id, 2, 'Someone else wrote v2.');

    await expect(
      repository.completePersonaEvolution({
        role_id,
        claim_token: candidate.claim_token,
        owner: ownerOf(candidate),
        parent_version: 1,
        outcome: 'evolved',
        strategy_version: STRATEGY_VERSION,
        input_snapshot_hash: candidate.input_snapshot_hash,
        source_run_id: 'run_occupied',
        reasons: ['qualifies'],
        persona: buildEvolvedPersona({ role_id, draft: draft(), parent_version: 1, now: NOW }),
        now: NOW,
      }),
    ).rejects.toThrow(/append-only/);

    // 一个字节都没写：当前 Persona 还是 v1、标记还在 processing（租约到期后能重来）、
    // 那一行别人写下的历史也没被换成我们这一版
    expect((await repository.getPersona(role_id)).version).toBe(1);
    expect(await repository.getPersonaEvolutionMarker(role_id)).toMatchObject({
      status: 'processing',
      claim_token: candidate.claim_token,
    });
    const history = await repository.listPersonaVersions(role_id);
    expect(history.map((record) => record.persona_version)).toEqual([1, 2]);
    expect(history[1]!.persona.summary).toBe('Someone else wrote v2.');
  });

  it('这一版号已经被占时回滚不覆盖：拒绝而不是改写，当前版本与历史都没动', async () => {
    const repository = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    const role_id = `role_persona_version_occupied_rollback_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'Occupied Rollback Agent' });
    await repository.savePersona(role_id, {
      ...(await repository.getPersona(role_id)),
      version: 2,
      summary: 'Patched by a human.',
    });
    // 回滚要写的是「当前版本 + 1」= v3，而它已经被占了
    await occupyVersion(repository, role_id, 3, 'Someone else wrote v3.');

    await expect(
      repository.rollbackPersona({
        role_id,
        target_version: 1,
        expected_current_version: 2,
        reason: 'should not overwrite v3',
        now: NOW,
      }),
    ).rejects.toThrow(/append-only/);

    expect((await repository.getPersona(role_id)).version).toBe(2);
    expect((await repository.getPersona(role_id)).summary).toBe('Patched by a human.');
    const history = await repository.listPersonaVersions(role_id);
    expect(history.map((record) => record.persona_version)).toEqual([1, 2, 3]);
    expect(history[2]!.persona.summary).toBe('Someone else wrote v3.');
  });

  it('历史行的列与载荷身份不一致时，读口当场报错（不把别人那一版当成本角色的历史）', async () => {
    const repository = new PgMemoryRepository({ pool, embedding, autoMigrate: false });
    const role_id = `role_persona_version_identity_${randomUUID()}`;
    const other_role = `role_persona_version_identity_other_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'Identity Agent' });

    // 列说这一行是 role_id 的 v2，载荷里却是**别人**的正文：这种行读出来会给调用方一份错的
    // 正文，而且看起来完全正常（载荷自己内部是自洽的，只有列与它各说各话）
    await pool.query(
      `INSERT INTO memory_persona_versions (role_id, persona_version, payload)
       VALUES ($1, 2, $2::jsonb)`,
      [
        role_id,
        JSON.stringify({
          role_id: other_role,
          persona_version: 2,
          persona: {
            ...(await repository.getPersona(role_id)),
            role_id: other_role,
            version: 2,
          },
          source: 'manual',
          created_at: NOW,
        }),
      ],
    );

    await expect(repository.getPersonaVersion(role_id, 2)).rejects.toThrow(
      /row identity mismatch/,
    );
    await expect(repository.listPersonaVersions(role_id)).rejects.toThrow(
      /row identity mismatch/,
    );
  });
});
