/**
 * Persona Evolution Job（Phase 4-C）测试
 *
 * 覆盖「一次演化运行」这件事：批量 claim、逐条隔离、run 记录与收尾、批大小与墙钟上限、
 * 优雅停止、启动恢复、dry-run、策略版本断言，以及这条通道最要害的几条语义——**同一份输入
 * 重复运行不产生第二个版本**、**父版本冲突不覆盖**、**凭据失效什么都不写**、**重试与死信的
 * 边界**。断言一律落在**持久化之后的状态**上（库里 Persona 的版本号与正文、演化标记写了
 * 什么、run 记录写了什么），而不是「某个函数被调用过」——后者在存储语义出错时照样通过。
 *
 * 判定本身（选候选、快照与 hash、幂等键、计划、判定契约、失败分类）是 4-A 的验收面，已在
 * persona-evolution.test.ts 里钉住；持久化的 claim/条件写/租约是 4-B 的验收面，已在
 * persona-evolution-state.test.ts 里由双后端契约钉住。这里只在需要看「整批的账」时经过它们，
 * 不重复那些断言。
 *
 * 同一份外壳契约跑两个后端（InMemoryRepository 与 PGlite 上的 PgMemoryRepository），run
 * store 在数据库那条腿上也换成真实实现——测试替身掩盖生产差异是契约里最贵的一类事故。
 * 时间全部由注入的 clock 提供，因此退避、租约过期与墙钟上限都不依赖真实时钟。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PGlite 是 WASM 引擎：建库本身要一秒起步。整仓并行跑测试时，这份启动成本会挤进单测默认
 * 的 5s 预算，于是那条腿偶发超时。这里放宽超时——测的是外壳语义，不是 PGlite 多久起来。
 */
vi.setConfig({ testTimeout: 30_000 });

import { ZodError } from 'zod';
import { nowTimestamp } from '../../core';
import {
  DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION,
  DefaultPersonaEvolutionStrategy,
} from '../adapters/default-persona-evolution-strategy';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { InMemoryMaintenanceRunStore } from '../adapters/in-memory-maintenance-run-store';
import { FileMaintenanceRunStore } from '../adapters/file-maintenance-run-store';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { PgMemoryRepository } from '../adapters/pg-memory-repository';
import { createPGlitePool } from '../adapters/pglite-pool';

/** 实体侧（经验 / 技能 / Persona）的进程内 PGlite 池，跨用例共享、文件收尾时关掉 */
let sharedPgMemoryPool: Awaited<ReturnType<typeof createPGlitePool>> | undefined;
async function pgMemoryPool(): Promise<Awaited<ReturnType<typeof createPGlitePool>>> {
  sharedPgMemoryPool ??= await createPGlitePool();
  return sharedPgMemoryPool;
}

/**
 * run 记录落在文件上：队列与审计按设计走文件，不占数据库；「重启」= 新实例指向同一目录。
 */
let runStoreRootDir: string | undefined;
function runStoreRoot(): string {
  runStoreRootDir ??= mkdtempSync(join(tmpdir(), 'newide-maintenance-runs-'));
  return runStoreRootDir;
}
import { ensurePgMemorySchema } from '../adapters/pg-memory-schema';
import { DefaultPersonaEvolutionJob } from '../runtime/persona-evolution-job';
import {
  AUTO_APPROVAL_REVIEWER,
  classifyPersonaEvolutionFailure,
} from '../services/persona-evolution-executor';
import {
  DEFAULT_DELIVERY_LEASE_MS,
  DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY,
  addMilliseconds,
} from '../services/delivery-lifecycle';
import {
  PERSONA_EVOLUTION_DECISION_CONTRACT_CODE,
  PersonaEvolutionDecisionContractError,
} from '../services/persona-evolution-decision';
import type { MaintenanceRunStore } from '../ports/maintenance-run-store';
import type { MemoryRepository } from '../ports/memory-repository';
import type {
  PersonaEvolutionApprovalMode,
  PersonaEvolutionDecision,
  PersonaEvolutionEvaluationInput,
  PersonaEvolutionStrategy,
} from '../ports/persona-evolution-strategy';
import type { PersonaEvolutionJobOptions } from '../ports/persona-evolution-job';
import {
  buildPersonaEvolutionSnapshot,
  personaEvolutionBatchSnapshotDigest,
  personaEvolutionInputSnapshotHash,
} from '../services/persona-evolution-candidates';
import type { ExperiencePromotion, ExperienceRecord, SkillRecord } from '../schemas';
import type { SqlPool } from '../ports/sql-pool';

const START = '2026-10-11T12:00:00.000Z';
/** 缺省策略的退避上限：失败之后要跨过它才能被重新 claim（上限之内一定够） */
const RETRY_ESCAPE_MS = DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY.max_delay_ms;

// ════════════════════════════════════════════════════════
//  时钟、样例数据与替身
// ════════════════════════════════════════════════════════

interface TestClock {
  now(): string;
  /** 前进若干毫秒——退避窗口、租约过期与墙钟上限都靠它跨过去 */
  advance(ms: number): void;
}

function testClock(start = START): TestClock {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current = new Date(Date.parse(current) + ms).toISOString();
    },
  };
}

function makeSkill(role_id: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = nowTimestamp();
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
    reviewed_by: 'system:auto-approval',
    reviewed_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeExperience(role_id: string, overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Prefer explicit contracts over implicit conventions.',
    description_embedding: [0.1, 0.2, 0.3],
    content: 'full experience content body',
    confidence: 0.9,
    tags: ['contracts'],
    agent_id: role_id,
    confidence_history: [{ value: 0.9, updated_at: now, reason: 'seed' }],
    referenced_count: 1,
    source_task_id: 'task_seed',
    source_driver: 'mock-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** 落一条已批准技能；返回落库后的记录（id 与入参一致） */
async function seedSkill(
  repository: MemoryRepository,
  role_id: string,
  overrides: Partial<SkillRecord> = {},
): Promise<SkillRecord> {
  const skill = makeSkill(role_id, overrides);
  const saved = await repository.saveSkillIfAbsent(role_id, skill);
  return saved.skill;
}

async function seedExperience(
  repository: MemoryRepository,
  role_id: string,
  overrides: Partial<ExperienceRecord> = {},
): Promise<ExperienceRecord> {
  const experience = makeExperience(role_id, overrides);
  await repository.saveExperience(role_id, experience);
  return experience;
}

/**
 * 经验上的晋升标记（`experience.promotion`）——用来构造「已落定 / 未落定」的各种形状。
 *
 * 缺省是「已出结论且已落定」：这类经验参与演化（结论已定，读到的是稳定事实）。要造一个被
 * 排除的形状只需要覆盖 `status` / `outcome`，过滤规则本身在 4-A 的表里、不在这里重复。
 */
function promotionMarker(overrides: Partial<ExperiencePromotion> = {}): ExperiencePromotion {
  return {
    status: 'processed',
    outcome: 'promoted',
    attempt_count: 1,
    created_at: START,
    updated_at: START,
    ...overrides,
  };
}

/**
 * 包一层策略：观察它看到了什么，或让它抛错／返回非法判定。
 *
 * 与 promotion 的同类替身同一个用途——被包的策略仍是**真正的那一个**，因此判定语义不会被
 * 测试替身改掉；这里只改「它是第几次被问、问它的时候库里的状态是什么」。
 */
function hookedStrategy(
  base: PersonaEvolutionStrategy,
  hooks: {
    before?: (input: PersonaEvolutionEvaluationInput) => Promise<void>;
    onEvaluate?: (input: PersonaEvolutionEvaluationInput) => void;
  } = {},
): PersonaEvolutionStrategy {
  return {
    version: base.version,
    config: base.config,
    async evaluate(input) {
      await hooks.before?.(input);
      hooks.onEvaluate?.(input);
      return base.evaluate(input);
    },
  };
}

/** 前 `fail_times` 次抛错的策略（缺省永远抛）；用于重试与死信的边界 */
function failingStrategy(
  base: PersonaEvolutionStrategy,
  fail_times = Number.POSITIVE_INFINITY,
  error: () => unknown = () => new Error('model endpoint unreachable'),
): PersonaEvolutionStrategy {
  let failures = 0;
  return {
    version: base.version,
    config: base.config,
    async evaluate(input) {
      if (failures < fail_times) {
        failures += 1;
        throw error();
      }
      return base.evaluate(input);
    },
  };
}

/**
 * 交回一份非法判定的策略：**结论与审核模式配不上对**。
 *
 * 刻意只翻 `verdict`、不动 `approval`：`approval` 与本次运行相等时契约校验才走到配对那一步，
 * 于是落下来的 violation 是 `verdict_approval`（而不是「审核模式与运行对不上」的 `approval`）
 * ——那正是「字段各自合法、合起来自相矛盾」这一类策略缺陷。
 */
function mispairedVerdictStrategy(base: PersonaEvolutionStrategy): PersonaEvolutionStrategy {
  return {
    version: base.version,
    config: base.config,
    async evaluate(input) {
      const decision = await base.evaluate(input);
      const flipped: PersonaEvolutionDecision = {
        ...decision,
        verdict: decision.verdict === 'eligible' ? 'pending_review' : 'eligible',
        blocking_rules: [],
      };
      return flipped;
    },
  };
}

async function personaVersion(repository: MemoryRepository, role_id: string): Promise<number> {
  return (await repository.getPersona(role_id)).version;
}

/**
 * claim 读不动存储的 repository 替身——外壳自己失败那条路径的唯一入口。
 *
 * 与晋升测试里的同类替身同一个形状：只换 `claimNextPersonaEvolutionCandidate` 一个方法，
 * 其余照常透传，因此「外壳炸了」与「候选处理得怎么样」是两件分得开的事。
 */
function createFailOnClaimRepository(inner: MemoryRepository): MemoryRepository {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'claimNextPersonaEvolutionCandidate') {
        return async () => {
          throw Object.assign(new Error('database is temporarily unavailable'), {
            code: 'ECONNRESET',
          });
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

// ════════════════════════════════════════════════════════
//  同一份外壳契约，两个后端各跑一遍
// ════════════════════════════════════════════════════════

interface JobStoreCase {
  name: string;
  create: () => Promise<{ repository: MemoryRepository; runStore: MaintenanceRunStore }>;
  /**
   * 重启：一整套新的维护组件指向**同一份存储**。
   *
   * 与 maintenance-adapters.ts 的 `DeliveryAdapterCase.reopen` 同一套约定——内存实现没有
   * 持久层，只能原样返回上一个句柄。这正是它不该被当成生产存储的原因，矩阵里如实体现，
   * 而不是假装重启过；真正的跨进程持久性由 Pg 那条腿钉住。
   */
  reopen: (previous: {
    repository: MemoryRepository;
    runStore: MaintenanceRunStore;
  }) => Promise<{ repository: MemoryRepository; runStore: MaintenanceRunStore }>;
}

function runPersonaEvolutionJobSuite(storeCase: JobStoreCase): void {
  describe(`persona evolution job — ${storeCase.name}`, () => {
    let repository: MemoryRepository;
    let runStore: MaintenanceRunStore;
    let clock: TestClock;
    let role_id: string;
    /** 本后端的那一套维护组件（重启用例拿它换一整套新的句柄） */
    let stores: { repository: MemoryRepository; runStore: MaintenanceRunStore };

    /** 自动批准是显式开关（缺省策略是人工审核），多数用例要的正是「判定合格就写出新版本」 */
    const autoApprove = new DefaultPersonaEvolutionStrategy({ approval: 'auto_approve' });

    beforeAll(async () => {
      stores = await storeCase.create();
      repository = stores.repository;
      runStore = stores.runStore;
    });

    beforeEach(async () => {
      clock = testClock();
      role_id = `role_persona_job_${randomUUID()}`;
      await repository.initializeAgent({ role_id, name: 'Persona Job Agent' });
    });

    function job(
      overrides: Partial<PersonaEvolutionJobOptions> = {},
    ): DefaultPersonaEvolutionJob {
      return new DefaultPersonaEvolutionJob({
        repository,
        runStore,
        strategy: autoApprove,
        worker_id: 'worker-1',
        role_id,
        now: clock.now,
        ...overrides,
      });
    }

    /**
     * 不限定 role 的 job：扫过整个名册。
     *
     * 单独一个构造口而不是 `job({ role_id: undefined })`——后者要显式写一个 undefined，
     * 与 `exactOptionalPropertyTypes` 下的可选字段语义相冲；「不传这个字段」才是它的意思。
     */
    function fleetJob(
      overrides: Partial<Omit<PersonaEvolutionJobOptions, 'role_id'>> = {},
    ): DefaultPersonaEvolutionJob {
      return new DefaultPersonaEvolutionJob({
        repository,
        runStore,
        strategy: autoApprove,
        worker_id: 'worker-1',
        now: clock.now,
        ...overrides,
      });
    }

    async function marker() {
      return repository.getPersonaEvolutionMarker(role_id);
    }

    // ── 正常路径 ────────────────────────────────────────

    it('输入过滤在存储这一层生效：不合格的技能与经验根本不进快照', async () => {
      // 合格的两类：已批准且未被取代的技能；从未评估过、以及「已出结论但不合格」的经验
      await seedSkill(repository, role_id);
      await seedExperience(repository, role_id);
      await seedExperience(repository, role_id, { promotion: promotionMarker({ outcome: 'promoted' }) });
      await seedExperience(repository, role_id, {
        type: 'negative',
        promotion: promotionMarker({ outcome: 'rejected' }),
      });
      // 被排除的六种：等人工审核的技能、已被取代的技能、别人正在处理的、上一次失败退回队列的、
      // 死信的，以及「结论是待审核」的经验（还没被批准）
      await seedSkill(repository, role_id, { review_status: 'pending' });
      await seedSkill(repository, role_id, { market_status: 'superseded' });
      await seedExperience(repository, role_id, { promotion: promotionMarker({ status: 'processing' }) });
      await seedExperience(repository, role_id, { promotion: promotionMarker({ status: 'pending' }) });
      await seedExperience(repository, role_id, {
        promotion: promotionMarker({ status: 'dead_letter', attempt_count: 5 }),
      });
      await seedExperience(repository, role_id, {
        promotion: promotionMarker({ outcome: 'pending_review' }),
      });

      const result = await job().run({ batchSize: 5 });
      expect(result.outcomes[0]?.status).toBe('evolved');

      // 判定拿到的就是那一份：一技能、三经验（未评估 / 已晋升 / 已拒绝）
      const persona = await repository.getPersona(role_id);
      expect(persona.skills_overview).toContain('1 skills promoted');
      expect(persona.experience_coverage).toContain('3 experiences (2 positive / 1 negative)');

      // 记在标记上的 hash 必须等于「按同一份过滤规则从库里现算」的那一个：过滤规则只有一处
      // 定义，判据与幂等键才不会各说各话
      const recomputed = personaEvolutionInputSnapshotHash(
        buildPersonaEvolutionSnapshot({
          role_id,
          skills: await repository.listSkills(role_id),
          experiences: await repository.listExperiences(role_id),
        }),
      );
      expect((await marker())?.input_snapshot_hash).toBe(recomputed);

      // 再塞两条**不合格**的输入：hash 不该动，因此也不该多出一版 Persona
      await seedSkill(repository, role_id, { review_status: 'pending' });
      await seedExperience(repository, role_id, {
        promotion: promotionMarker({ status: 'dead_letter', attempt_count: 5 }),
      });

      const again = await job().run({ batchSize: 5 });
      expect(again.stop_reason).toBe('no_work');
      expect(again.outcomes).toEqual([]);
      expect(await personaVersion(repository, role_id)).toBe(2);
      expect((await marker())?.input_snapshot_hash).toBe(recomputed);
    });

    it('两个 worker 并发跑同一个角色：只有一方 claim 到，Persona 只前进一版', async () => {
      await seedSkill(repository, role_id);

      const [left, right] = await Promise.all([
        job({ worker_id: 'worker-left' }).run({ batchSize: 5 }),
        job({ worker_id: 'worker-right' }).run({ batchSize: 5 }),
      ]);

      const sides = [left, right];
      const claimed = sides.filter((side) => side.counts.claimed_count === 1);
      const idle = sides.filter((side) => side.counts.claimed_count === 0);
      expect(claimed).toHaveLength(1);
      expect(idle).toHaveLength(1);
      expect(claimed[0]?.outcomes[0]?.status).toBe('evolved');
      // 落空的那一方是「没轮到我们」：不报失败、不重投、不进死信
      expect(idle[0]?.stop_reason).toBe('no_work');
      expect(idle[0]?.counts).toMatchObject({
        retried_count: 0,
        dead_letter_count: 0,
        failure_count: 0,
      });

      expect(await personaVersion(repository, role_id)).toBe(2);
      // 只 claim 过一次：没有第二次投递，也没有被别人接管
      expect((await marker())?.attempt_count).toBe(1);
    });

    it('正常演化一条：Persona 版本 +1、标记落定、run 计数与停止原因都对', async () => {
      await seedSkill(repository, role_id);
      await seedExperience(repository, role_id);

      const result = await job().run({ batchSize: 5 });

      expect(result.stop_reason).toBe('no_work');
      expect(result.dry_run).toBe(false);
      expect(result.approval).toBe('auto_approve');
      expect(result.strategy_version).toBe(DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION);
      expect(result.worker_failure).toBeUndefined();
      expect(result.restored_count).toBe(0);
      expect(result.counts).toMatchObject({
        claimed_count: 1,
        completed_count: 1,
        retried_count: 0,
        dead_letter_count: 0,
        skipped_count: 0,
        failure_count: 0,
      });

      const outcome = result.outcomes[0]!;
      expect(outcome.status).toBe('evolved');
      expect(outcome.role_id).toBe(role_id);
      expect(outcome.attempt_count).toBe(1);
      expect(outcome.run_id).toBe(result.run.run_id);
      expect(outcome.parent_version).toBe(1);
      expect(outcome.persona_version).toBe(2);
      expect(outcome.failure).toBeUndefined();
      expect(outcome.decision?.verdict).toBe('eligible');
      expect(outcome.input_snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(outcome.warnings).toEqual([]);

      // 库里的 Persona 真的换了版本，正文来自判定给的那五段
      const persona = await repository.getPersona(role_id);
      expect(persona.version).toBe(2);
      expect(persona.skills_overview).toContain('1 skills promoted. Focus tags: contracts. Latest: ');
      expect(persona.experience_coverage).toContain('1 experiences (1 positive / 0 negative)');

      // 标记把「这一版是谁、依据什么、哪一次运行跑出来的」全记下来了
      const stored = await marker();
      expect(stored).toMatchObject({
        status: 'processed',
        outcome: 'evolved',
        attempt_count: 1,
        parent_version: 1,
        persona_version: 2,
        strategy_version: DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION,
        input_snapshot_hash: outcome.input_snapshot_hash,
        source_run_id: result.run.run_id,
        reviewed_by: AUTO_APPROVAL_REVIEWER,
        evaluated_at: START,
      });
      expect(stored?.change_summary).toContain('Persona v1 → v2');
      // 终态不再有人持有：token 与租约都清掉了
      expect(stored?.claim_token).toBeUndefined();
      expect(stored?.lease_expires_at).toBeUndefined();

      expect(result.run).toMatchObject({
        job_type: 'persona_evolution',
        status: 'completed',
        worker_id: 'worker-1',
        claimed_count: 1,
        completed_count: 1,
      });
    });

    it('没有可演化的输入：记一条 rejected 结论，不写 Persona、不平白推进版本号', async () => {
      const result = await job().run({ batchSize: 5 });

      expect(result.stop_reason).toBe('no_work');
      // 判定不合格是**结论**不是故障：进完成数，不进死信
      expect(result.counts).toMatchObject({
        claimed_count: 1,
        completed_count: 1,
        failure_count: 0,
        dead_letter_count: 0,
      });
      const outcome = result.outcomes[0]!;
      expect(outcome.status).toBe('rejected');
      expect(outcome.decision?.blocking_rules).toEqual(['no_approved_input']);
      expect(outcome.persona_version).toBeUndefined();

      expect(await personaVersion(repository, role_id)).toBe(1);
      expect(await marker()).toMatchObject({
        status: 'processed',
        outcome: 'rejected',
        parent_version: 1,
      });
      expect((await marker())?.persona_version).toBeUndefined();
    });

    it('人工审核模式：判定合格也只记 pending_review，Persona 一个字节都不动', async () => {
      await seedSkill(repository, role_id);

      const manual = new DefaultPersonaEvolutionStrategy({ approval: 'manual_review' });
      const result = await job({ strategy: manual, approval: 'manual_review' }).run({
        batchSize: 5,
      });

      expect(result.approval).toBe('manual_review');
      expect(result.outcomes[0]?.status).toBe('pending_review');
      expect(result.outcomes[0]?.decision?.verdict).toBe('pending_review');
      expect(result.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });

      expect(await personaVersion(repository, role_id)).toBe(1);
      const stored = await marker();
      expect(stored).toMatchObject({ status: 'processed', outcome: 'pending_review' });
      expect(stored?.persona_version).toBeUndefined();
      expect(stored?.reviewed_by).toBeUndefined();
    });

    it('人工审核判过的角色，放宽成自动批准之后被接起来并写出新版本', async () => {
      await seedSkill(repository, role_id);
      const manual = new DefaultPersonaEvolutionStrategy({ approval: 'manual_review' });
      await job({ strategy: manual, approval: 'manual_review' }).run({ batchSize: 5 });
      expect(await personaVersion(repository, role_id)).toBe(1);

      // 同一次输入、同一版判据，只是这次运行被授权自动批准：计划先重置再 claim，
      // 因此判定会照常被问一次，然后写下 v2
      const result = await job().run({ batchSize: 5 });

      expect(result.outcomes[0]?.status).toBe('evolved');
      expect(await personaVersion(repository, role_id)).toBe(2);
      expect(await marker()).toMatchObject({ outcome: 'evolved', persona_version: 2 });
    });

    // ── 幂等：同一份输入不产生第二个版本 ─────────────────

    it('同一份输入重复运行：第二次没有活，版本号不再前进（幂等命中）', async () => {
      await seedSkill(repository, role_id);
      const first = await job().run({ batchSize: 5 });
      expect(first.outcomes[0]?.status).toBe('evolved');
      const hash = first.outcomes[0]?.input_snapshot_hash;

      const second = await job().run({ batchSize: 5 });

      expect(second.stop_reason).toBe('no_work');
      expect(second.outcomes).toEqual([]);
      // 「什么都没做」的运行不留下数字：六个计数全 0
      expect(second.counts).toMatchObject({
        claimed_count: 0,
        completed_count: 0,
        retried_count: 0,
        dead_letter_count: 0,
        skipped_count: 0,
        failure_count: 0,
      });
      expect(await personaVersion(repository, role_id)).toBe(2);
      // 标记也没被改写：还是第一次那条结论
      expect(await marker()).toMatchObject({
        outcome: 'evolved',
        persona_version: 2,
        input_snapshot_hash: hash,
      });
    });

    it('策略版本变了、输入没变：允许重评，但**不产出新版本**（判据是 no_new_input）', async () => {
      await seedSkill(repository, role_id);
      await job().run({ batchSize: 5 });
      expect(await personaVersion(repository, role_id)).toBe(2);

      // 同一份输入、同一套判定逻辑，只是判据的版本号变了
      const v2 = new DefaultPersonaEvolutionStrategy({
        version: 'persona-threshold.v2',
        approval: 'auto_approve',
      });
      const second = await job({ strategy: v2 }).run({ batchSize: 5 });

      expect(second.strategy_version).toBe('persona-threshold.v2');
      expect(second.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });
      const outcome = second.outcomes[0]!;
      expect(outcome.status).toBe('rejected');
      // 这一条钉住 `last_evolution` 的接线：缺了它，判定看不到上一次的输入快照，只能靠
      // 「正文没变」兜住——版本一样不会多写，但审计里记的挡板会变成 persona_unchanged，
      // 读起来是另一件事
      expect(outcome.decision?.blocking_rules).toEqual(['no_new_input']);
      expect(await personaVersion(repository, role_id)).toBe(2);
      expect(await marker()).toMatchObject({
        outcome: 'rejected',
        strategy_version: 'persona-threshold.v2',
      });

      // 判据换过一次就收敛：第三次运行按「这份输入在当前判据下已经判过」跳过，不每轮重问
      const third = await job({ strategy: v2 }).run({ batchSize: 5 });
      expect(third.stop_reason).toBe('no_work');
      expect(third.outcomes).toEqual([]);
    });

    it('输入变了：同一条角色被重新评估并写出下一个版本', async () => {
      await seedSkill(repository, role_id);
      await job().run({ batchSize: 5 });
      expect(await personaVersion(repository, role_id)).toBe(2);

      await seedSkill(repository, role_id, { description: 'Always close the loop with a test.' });
      const second = await job().run({ batchSize: 5 });

      expect(second.outcomes[0]?.status).toBe('evolved');
      expect(second.outcomes[0]?.parent_version).toBe(2);
      expect(second.outcomes[0]?.persona_version).toBe(3);
      const persona = await repository.getPersona(role_id);
      expect(persona.version).toBe(3);
      expect(persona.skills_overview).toContain('2 skills promoted');
      expect(await marker()).toMatchObject({
        outcome: 'evolved',
        parent_version: 2,
        persona_version: 3,
      });
    });

    // ── dry-run ─────────────────────────────────────────

    it('dry-run：照常算快照与判定，但不 claim、不写 Persona，run 上一个数字都没有', async () => {
      await seedSkill(repository, role_id);

      const result = await job().run({ batchSize: 5, dryRun: true });

      expect(result.dry_run).toBe(true);
      expect(result.stop_reason).toBe('no_work');
      expect(result.counts).toMatchObject({
        claimed_count: 0,
        completed_count: 0,
        retried_count: 0,
        dead_letter_count: 0,
        skipped_count: 0,
        failure_count: 0,
      });
      const outcome = result.outcomes[0]!;
      // 投影：真跑一次会演化出 v2，但此刻什么都没发生
      expect(outcome.status).toBe('evolved');
      expect(outcome.decision?.verdict).toBe('eligible');
      expect(outcome.persona_version).toBeUndefined();
      expect(outcome.attempt_count).toBe(0);
      expect(outcome.warnings.some((line) => line.startsWith('Dry run:'))).toBe(true);

      expect(await personaVersion(repository, role_id)).toBe(1);
      // 连初始标记都没落下：演练不做任何写
      expect(await marker()).toBeUndefined();

      // 演练之后真跑一次，结果与投影一致
      const real = await job().run({ batchSize: 5 });
      expect(real.outcomes[0]?.status).toBe('evolved');
      expect(real.outcomes[0]?.input_snapshot_hash).toBe(outcome.input_snapshot_hash);
      expect(await personaVersion(repository, role_id)).toBe(2);
    });

    it('dry-run 报得出「本来会跳过」以及为什么（真跑只能报「这次没活」）', async () => {
      await seedSkill(repository, role_id);
      await job().run({ batchSize: 5 });

      const result = await job().run({ batchSize: 5, dryRun: true });

      const outcome = result.outcomes[0]!;
      expect(outcome.status).toBe('skipped');
      expect(outcome.skip_reason).toBe('already_evolved_for_snapshot');
      expect(outcome.attempt_count).toBe(1);
      expect(outcome.failure).toBeUndefined();
      expect(result.counts.skipped_count).toBe(0);
    });

    // ── 上限与停止 ──────────────────────────────────────

    it('批大小上限：到量即停，剩下的留给下一次', async () => {
      // 候选是「角色」，所以这条上限只能拿多个角色来验。**不限制 role_id** 的运行会扫过整个
      // 名册（内存里还有本文件前面用例留下的角色），因此这里只断言与「轮到谁」无关的性质：
      // 到量即停、一次只 claim 到量、余下的由下一次运行接走
      await repository.initializeAgent({ role_id: 'role_persona_batch_1', name: 'Batch 1' });
      await repository.initializeAgent({ role_id: 'role_persona_batch_2', name: 'Batch 2' });
      await seedSkill(repository, 'role_persona_batch_1');
      await seedSkill(repository, 'role_persona_batch_2');

      const first = await fleetJob({ batch_size: 1 }).run();

      expect(first.stop_reason).toBe('batch_size');
      expect(first.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });
      expect(first.outcomes).toHaveLength(1);

      // 上限松开之后必须还有活：说明第一次确实停在上限上，而不是碰巧没有候选
      const second = await fleetJob().run({ batchSize: 50 });
      expect(second.counts.claimed_count).toBeGreaterThanOrEqual(1);
      expect(second.stop_reason).toBe('no_work');
      expect(await personaVersion(repository, 'role_persona_batch_1')).toBe(2);
      expect(await personaVersion(repository, 'role_persona_batch_2')).toBe(2);
    });

    it('墙钟上限：到点就不再 claim 新的', async () => {
      await seedSkill(repository, role_id);

      const result = await job().run({ batchSize: 5, maxDurationMs: 0 });

      expect(result.stop_reason).toBe('max_duration');
      expect(result.counts.claimed_count).toBe(0);
      expect(result.outcomes).toEqual([]);
      expect(await personaVersion(repository, role_id)).toBe(1);
    });

    it('优雅停止：信号置位后不再 claim，run 照样收尾', async () => {
      await seedSkill(repository, role_id);
      const controller = new AbortController();
      controller.abort();

      const result = await job().run({ batchSize: 5, signal: controller.signal });

      expect(result.stop_reason).toBe('aborted');
      expect(result.counts.claimed_count).toBe(0);
      expect(result.run.status).toBe('completed');
      expect(await personaVersion(repository, role_id)).toBe(1);
    });

    it('run 审计：每次运行一条，dry-run 也留痕（计数全 0），两次运行不共用一个 run_id', async () => {
      await seedSkill(repository, role_id);
      const before = await runStore.list({ job_type: 'persona_evolution' });

      const dry = await job().run({ batchSize: 5, dryRun: true });
      const real = await job().run({ batchSize: 5 });

      expect(real.run.run_id).not.toBe(dry.run.run_id);
      const runs = await runStore.list({ job_type: 'persona_evolution' });
      expect(runs.map((item) => item.run_id)).toEqual(
        expect.arrayContaining([
          ...before.map((item) => item.run_id),
          dry.run.run_id,
          real.run.run_id,
        ]),
      );

      // 演练的运行照样可审计，但**一个数字都没有**：一次什么都没写的运行不该在吞吐指标里
      // 留下痕迹，否则把各 run 的 completed_count 加起来的人会数到并没有发生的演化
      expect(await runStore.get(dry.run.run_id)).toMatchObject({
        job_type: 'persona_evolution',
        status: 'completed',
        worker_id: 'worker-1',
        claimed_count: 0,
        completed_count: 0,
        retried_count: 0,
        dead_letter_count: 0,
        skipped_count: 0,
        failure_count: 0,
      });
      expect((await runStore.get(dry.run.run_id))?.last_error).toBeUndefined();
      // 同一条 job 跑第二次：写入的还是那一条候选，计数如实落在第二条 run 上
      expect((await runStore.get(real.run.run_id))?.completed_count).toBe(1);

      // 演练的审计也留着，只是标着它是**投影**：一次没写任何东西的运行，读口必须一眼看得出来
      expect((await runStore.get(dry.run.run_id))?.audit).toMatchObject({
        strategy_version: DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION,
        approval: 'auto_approve',
        dry_run: true,
      });
      expect((await runStore.get(real.run.run_id))?.audit?.dry_run).toBe(false);
    });

    it('run 审计：策略版本、输入快照 digest 与逐候选 hash 都落在 run 上', async () => {
      await seedSkill(repository, role_id);

      const first = await job().run({ batchSize: 5 });
      const firstAudit = (await runStore.get(first.run.run_id))?.audit;
      expect(firstAudit).toMatchObject({
        strategy_version: DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION,
        approval: 'auto_approve',
        dry_run: false,
        parent_conflict_count: 0,
        input_snapshot: { candidate_count: 1, counts: { skills: 1, experiences: 0 } },
        parent_version_range: { min: 1, max: 1 },
      });
      expect(firstAudit?.candidates).toHaveLength(1);
      const firstCandidate = firstAudit?.candidates?.[0];
      expect(firstCandidate).toMatchObject({
        candidate_id: role_id,
        parent_version: 1,
        result_version: 2,
        outcome: 'evolved',
        input_counts: { skills: 1, experiences: 0 },
        parent_conflict_count: 0,
      });
      const firstHash = firstCandidate?.input_snapshot_hash;
      expect(firstHash).toMatch(/^[0-9a-f]{64}$/);
      expect(firstAudit?.input_snapshot?.digest).toBe(
        personaEvolutionBatchSnapshotDigest([firstHash!]),
      );

      // 再演化一次：输入变了，role 上的标记被新的一版覆盖——而第一条 run 记下的那份输入标识
      // 必须原样留着。这正是「run_id 事后能自证当时依据哪份输入」的落点，也是本阶段要修的那件
      // 事：这些事实此前只活在会被下一次运行覆盖的标记上
      await seedSkill(repository, role_id);
      const second = await job().run({ batchSize: 5 });
      expect(await personaVersion(repository, role_id)).toBe(3);
      expect((await marker())?.input_snapshot_hash).not.toBe(firstHash);

      const reread = (await runStore.get(first.run.run_id))?.audit;
      expect(reread?.candidates?.[0]?.input_snapshot_hash).toBe(firstHash);
      expect(reread?.input_snapshot?.digest).toBe(firstAudit?.input_snapshot?.digest);
      expect(reread?.candidates?.[0]?.input_counts).toEqual({ skills: 1, experiences: 0 });
      // 第二条 run 记的是另一份输入：两次运行的 digest 不相同（批量摘要不是常量）
      const secondAudit = (await runStore.get(second.run.run_id))?.audit;
      expect(secondAudit?.input_snapshot?.digest).not.toBe(firstAudit?.input_snapshot?.digest);
      expect(secondAudit?.candidates?.[0]?.result_version).toBe(3);
    });

    it('多个候选的 snapshot hash 不丢失：一次跨角色的运行把逐候选摘要都记下来', async () => {
      const peer = `role_persona_batch_${randomUUID()}`;
      await repository.initializeAgent({ role_id: peer, name: 'Batch Peer' });
      await seedSkill(repository, role_id);
      await seedSkill(repository, peer);
      await seedExperience(repository, peer);

      // 跨角色跑一次：批量运行下「这一次依据的是哪份输入」只能是一个集合
      const result = await fleetJob().run({ batchSize: 50 });
      const audit = (await runStore.get(result.run.run_id))?.audit;

      // 审计与逐条结果一一对应：有一条结果就有一条摘要，没有丢行
      expect(audit?.candidates).toHaveLength(result.outcomes.length);
      expect(audit?.input_snapshot?.candidate_count).toBe(result.outcomes.length);

      // digest 覆盖的正是这一组逐候选 hash（同一个函数、同一份输入）
      const hashes = (audit?.candidates ?? []).map((item) => item.input_snapshot_hash ?? '');
      expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
      expect(audit?.input_snapshot?.digest).toBe(personaEvolutionBatchSnapshotDigest(hashes));

      // 本用例刚造出来的两个角色都在里面，各自的 hash 不同——两条不同的输入没有被拍成一条
      const mine = (audit?.candidates ?? []).filter(
        (item) => item.candidate_id === role_id || item.candidate_id === peer,
      );
      expect(mine.map((item) => item.outcome)).toEqual(['evolved', 'evolved']);
      expect(new Set(mine.map((item) => item.input_snapshot_hash)).size).toBe(2);
      expect(mine.map((item) => item.input_counts)).toEqual(
        expect.arrayContaining([
          { skills: 1, experiences: 0 },
          { skills: 1, experiences: 1 },
        ]),
      );
    });

    it('外壳自己失败：run 记 failed，审计照样落在上面', async () => {
      await seedSkill(repository, role_id);

      const result = await job({ repository: createFailOnClaimRepository(repository) }).run({
        batchSize: 5,
      });

      expect(result.stop_reason).toBe('worker_error');
      expect(result.run.status).toBe('failed');

      // 一个候选都没处理完的 run 同样说得清自己按哪一版判据跑：策略版本在**开跑时**就写下了，
      // 收尾只是把逐候选的账补上——那条 run 永远不会收尾时（进程被杀）留下的就是这一份
      const stored = await runStore.get(result.run.run_id);
      expect(stored?.audit).toMatchObject({
        strategy_version: DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION,
        approval: 'auto_approve',
        dry_run: false,
        input_snapshot: { candidate_count: 0 },
      });
      expect(stored?.last_error).toContain('downstream_unavailable');
      // 没有候选就没有逐候选摘要：缺席，而不是一条空行或一个假条目
      expect(stored?.audit?.candidates).toBeUndefined();
    });

    // ── 恢复与 fencing ──────────────────────────────────

    it('启动恢复：上一个进程留下的过期租约被放回队列，并由新实例接着做完', async () => {
      await seedSkill(repository, role_id);
      const stranded = await repository.claimNextPersonaEvolutionCandidate({
        owner: 'worker-crashed',
        now: clock.now(),
        lease_ms: DEFAULT_DELIVERY_LEASE_MS,
        strategy_version: DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION,
        approval: 'auto_approve',
        role_id,
      });
      expect(stranded?.marker.status).toBe('processing');

      // 重启：换一整套句柄指向同一份存储（内存实现只能返回上一份，如实体现）
      const revived = await storeCase.reopen(stores);
      clock.advance(DEFAULT_DELIVERY_LEASE_MS + 1_000);
      const restarted = new DefaultPersonaEvolutionJob({
        repository: revived.repository,
        runStore: revived.runStore,
        strategy: autoApprove,
        worker_id: 'worker-after-restart',
        role_id,
        now: clock.now,
      });

      const result = await restarted.run({ batchSize: 5 });

      expect(result.restored_count).toBe(1);
      expect(result.outcomes[0]?.status).toBe('evolved');
      expect(result.outcomes[0]?.attempt_count).toBe(2);
      expect(await personaVersion(repository, role_id)).toBe(2);

      // 旧持有者手里的凭据再也写不进去：接管之后的 token 是新的
      const stale = await repository.completePersonaEvolution({
        role_id,
        claim_token: stranded!.claim_token,
        owner: 'worker-crashed',
        parent_version: 1,
        outcome: 'rejected',
        strategy_version: DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION,
        input_snapshot_hash: stranded!.input_snapshot_hash,
        source_run_id: 'run_stale',
        reasons: ['stale worker'],
        now: clock.now(),
      });
      expect(stale).toEqual({ kind: 'claim_lost' });
      expect(await personaVersion(repository, role_id)).toBe(2);
    });

    // ── 失败、重试与死信 ────────────────────────────────

    it('可重试失败：退避回队列，跨过退避窗口后重投并成功', async () => {
      await seedSkill(repository, role_id);
      const flaky = failingStrategy(autoApprove, 1);

      const first = await job({ strategy: flaky }).run({ batchSize: 5 });

      const outcome = first.outcomes[0]!;
      expect(outcome.status).toBe('retried');
      expect(outcome.failure?.code).toBe('model_error');
      expect(outcome.failure?.retryable).toBe(true);
      expect(first.counts).toMatchObject({ claimed_count: 1, retried_count: 1, completed_count: 0 });
      expect(await personaVersion(repository, role_id)).toBe(1);

      const stored = await marker();
      expect(stored).toMatchObject({ status: 'pending', attempt_count: 1 });
      expect(stored?.next_retry_at).toBe(addMilliseconds(START, DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY.base_delay_ms));
      expect(stored?.last_error).toContain('model endpoint unreachable');

      // 退避窗口没到：claim 不到，这次没活（不轮询、不 sleep）
      const tooEarly = await job({ strategy: flaky }).run({ batchSize: 5 });
      expect(tooEarly.stop_reason).toBe('no_work');
      expect(tooEarly.counts.claimed_count).toBe(0);

      clock.advance(RETRY_ESCAPE_MS);
      const second = await job({ strategy: flaky }).run({ batchSize: 5 });

      expect(second.outcomes[0]?.status).toBe('evolved');
      expect(second.outcomes[0]?.attempt_count).toBe(2);
      expect(await personaVersion(repository, role_id)).toBe(2);
    });

    it('用满投递次数进死信：自动路径不再重投，人工放回之后才能重新处理', async () => {
      await seedSkill(repository, role_id);
      const alwaysFails = failingStrategy(autoApprove);
      const deadJob = job({ strategy: alwaysFails });

      let last;
      for (let attempt = 1; attempt <= DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY.max_attempts; attempt += 1) {
        last = await deadJob.run({ batchSize: 5 });
        if ((await marker())?.status !== 'dead_letter') clock.advance(RETRY_ESCAPE_MS);
      }
      expect(last?.outcomes[0]?.status).toBe('dead_letter');
      expect(await marker()).toMatchObject({
        status: 'dead_letter',
        attempt_count: DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY.max_attempts,
      });
      expect(await personaVersion(repository, role_id)).toBe(1);

      // 自动路径不再碰它
      clock.advance(RETRY_ESCAPE_MS);
      const afterDead = await deadJob.run({ batchSize: 5 });
      expect(afterDead.stop_reason).toBe('no_work');
      expect(afterDead.counts.claimed_count).toBe(0);

      // 人工放回：清零投递次数（「再试一次」就是再给满额机会）
      const revived = await repository.retryDeadLetterPersonaEvolution({
        role_id,
        now: clock.now(),
      });
      expect(revived).toMatchObject({ status: 'pending', attempt_count: 0 });

      const healed = await job().run({ batchSize: 5 });
      expect(healed.outcomes[0]?.status).toBe('evolved');
      expect(await personaVersion(repository, role_id)).toBe(2);
    });

    it('判定违反契约：不可重试，落死信且不改动 Persona', async () => {
      await seedSkill(repository, role_id);

      const result = await job({ strategy: mispairedVerdictStrategy(autoApprove) }).run({
        batchSize: 5,
      });

      const outcome = result.outcomes[0]!;
      expect(outcome.status).toBe('dead_letter');
      expect(outcome.failure?.code).toBe('payload_unreadable');
      expect(outcome.failure?.retryable).toBe(false);
      expect(outcome.failure?.message).toContain('verdict_approval');
      expect(result.counts).toMatchObject({ claimed_count: 1, dead_letter_count: 1, completed_count: 0 });
      expect(await personaVersion(repository, role_id)).toBe(1);
      // 死信只写了失败痕迹：结论一栏还是缺席（显式写 undefined 在断言里等于「要求键存在」，
      // 而两个后端都会把它省掉——Pg 的 JSONB 丢 undefined 键，内存实现干脆没有这个键）
      expect(await marker()).toMatchObject({ status: 'dead_letter', attempt_count: 1 });
      expect((await marker())?.outcome).toBeUndefined();
    });

    it('父版本冲突：期间别人改了 Persona，这次判定作废退回队列，绝不覆盖', async () => {
      await seedSkill(repository, role_id);
      const interferer = 'A human edited this persona while the job was deciding.';
      // 判定期间（claim 之后、写回之前）有人改了 Persona——前端 PATCH 或旧的归纳入口都会
      // 造成这个形状。判定器不参与这件事，它只是让这个窗口真的发生
      const racing = hookedStrategy(autoApprove, {
        before: async () => {
          await repository.savePersona(role_id, {
            ...(await repository.getPersona(role_id)),
            version: 7,
            summary: interferer,
          });
        },
      });

      const result = await job({ strategy: racing }).run({ batchSize: 5 });

      const outcome = result.outcomes[0]!;
      expect(outcome.status).toBe('retried');
      expect(outcome.failure?.code).toBe('storage_error');
      expect(outcome.failure?.retryable).toBe(true);
      expect(outcome.failure?.message).toContain('v7');
      expect(result.counts).toMatchObject({ claimed_count: 1, retried_count: 1, completed_count: 0 });

      // run 审计按**失败情形**计数，而不是按失败码：冲突与「存储抖了一下」共享
      // `storage_error`，只有情形分得开「有人抢先改了 Persona」这件可自愈的事
      const audit = (await runStore.get(result.run.run_id))?.audit;
      expect(audit?.parent_conflict_count).toBe(1);
      expect(audit?.candidates?.[0]).toMatchObject({
        candidate_id: role_id,
        outcome: 'retried',
        parent_conflict_count: 1,
      });
      // 冲突的那一条什么都没写：审计里也不该出现一个「写下的版本」
      expect(audit?.candidates?.[0]?.result_version).toBeUndefined();

      // 别人写下的那一版完好无损：父版本冲突的落点就是「不覆盖」
      const persona = await repository.getPersona(role_id);
      expect(persona.version).toBe(7);
      expect(persona.summary).toBe(interferer);
      // 标记退回队列，带着失败原因等下一次
      expect(await marker()).toMatchObject({ status: 'pending', attempt_count: 1 });
    });

    it('一条角色失败不阻塞同批：另一个角色照常演化', async () => {
      const failing_role = `role_persona_isolated_a_${randomUUID()}`;
      const healthy_role = `role_persona_isolated_b_${randomUUID()}`;
      await repository.initializeAgent({ role_id: failing_role, name: 'Failing' });
      await repository.initializeAgent({ role_id: healthy_role, name: 'Healthy' });
      await seedSkill(repository, failing_role);
      await seedSkill(repository, healthy_role);

      // 只让第一个角色炸：其余照常
      const selective: PersonaEvolutionStrategy = {
        version: autoApprove.version,
        config: autoApprove.config,
        async evaluate(input) {
          if (input.role_id === failing_role) throw new Error('boom');
          return autoApprove.evaluate(input);
        },
      };

      const result = await fleetJob({ strategy: selective }).run({ batchSize: 50 });

      const failed = result.outcomes.find((item) => item.role_id === failing_role);
      const healthy = result.outcomes.find((item) => item.role_id === healthy_role);
      expect(failed?.status).toBe('retried');
      expect(healthy?.status).toBe('evolved');
      expect(result.counts.completed_count).toBeGreaterThanOrEqual(1);
      expect(await personaVersion(repository, healthy_role)).toBe(2);
      expect(await personaVersion(repository, failing_role)).toBe(1);
    });

    // ── 运行选项的断言 ──────────────────────────────────

    it('运行选项里声明的策略版本与实际注入的不一致：拒绝启动，且不开 run', async () => {
      const before = await runStore.list({ job_type: 'persona_evolution' });

      await expect(job().run({ strategy_version: 'persona-threshold.v999' })).rejects.toThrow(
        /declared strategy version/,
      );

      const after = await runStore.list({ job_type: 'persona_evolution' });
      // 审计里不该多出一条「配置写的是 v999」的运行
      expect(after).toHaveLength(before.length);
    });

    it('运行选项里的审核模式不合法：拒绝启动，而不是静默按人工审核空跑', async () => {
      await expect(
        job().run({ approval: 'yolo' as PersonaEvolutionApprovalMode }),
      ).rejects.toThrow(/Unknown persona evolution approval mode/);
    });
  });
}

// ════════════════════════════════════════════════════════
//  两个后端
// ════════════════════════════════════════════════════════

runPersonaEvolutionJobSuite({
  name: 'InMemoryRepository + InMemoryMaintenanceRunStore',
  create: async () => ({
    repository: new InMemoryRepository(),
    runStore: new InMemoryMaintenanceRunStore(),
  }),
  // 内存实现没有持久层：换句柄只能返回上一份存储（它不假装自己重启过）
  reopen: async (previous) => previous,
});

describe('persona evolution job — PgMemoryRepository (PGlite) + FileMaintenanceRunStore', () => {
  let pool: SqlPool;

  beforeAll(async () => {
    pool = await pgMemoryPool();
    await ensurePgMemorySchema(pool, new HashEmbeddingProvider().dimensions);
  });

  afterAll(async () => {
    await sharedPgMemoryPool?.end();
    sharedPgMemoryPool = undefined;
    if (runStoreRootDir) {
      rmSync(runStoreRootDir, { recursive: true, force: true });
      runStoreRootDir = undefined;
    }
  });

  runPersonaEvolutionJobSuite({
    name: 'PgMemoryRepository (PGlite)',
    create: async () => ({
      repository: new PgMemoryRepository({
        pool,
        embedding: new HashEmbeddingProvider(),
        autoMigrate: false,
      }),
      runStore: new FileMaintenanceRunStore({ root: runStoreRoot() }),
    }),
    // 重启：新的 repository 与 run store 实例指向同一个库，内存里什么都没继承下来
    reopen: async () => ({
      repository: new PgMemoryRepository({
        pool,
        embedding: new HashEmbeddingProvider(),
        autoMigrate: false,
      }),
      runStore: new FileMaintenanceRunStore({ root: runStoreRoot() }),
    }),
  });
});

/**
 * 这条腿的两件事只在真存储上看：run 记录真的落盘，且重启（新的 job 实例）之后
 * 还能从库里把候选接着跑完。InMemory 后端不假装自己持久化，这两条因此不放进共享契约。
 */
describe('persona evolution job — 数据库上的 run 与重启', () => {
  const embedding = new HashEmbeddingProvider();
  let pool: SqlPool;

  beforeAll(async () => {
    pool = await pgMemoryPool();
    await ensurePgMemorySchema(pool, embedding.dimensions);
  });

  afterEach(async () => {
    // 这条 describe 要一个**干净的名册**：候选是角色，而库里残留的角色会被「不限定 role」
    // 的运行扫到，于是「一次只 claim 一个」这类断言就取决于前面用例留下了谁
    await pool.query('TRUNCATE memory_agents CASCADE');
  });

  afterAll(async () => {
    await sharedPgMemoryPool?.end();
    sharedPgMemoryPool = undefined;
    if (runStoreRootDir) {
      rmSync(runStoreRootDir, { recursive: true, force: true });
      runStoreRootDir = undefined;
    }
  });

  function pgRepository(): MemoryRepository {
    return new PgMemoryRepository({ pool, embedding, autoMigrate: false });
  }

  function pgJob(repository: MemoryRepository, role_id: string | undefined, now: () => string) {
    return new DefaultPersonaEvolutionJob({
      repository,
      runStore: new FileMaintenanceRunStore({ root: runStoreRoot() }),
      strategy: new DefaultPersonaEvolutionStrategy({ approval: 'auto_approve' }),
      worker_id: 'worker-db',
      ...(role_id !== undefined ? { role_id } : {}),
      now,
    });
  }

  it('run 记录落在数据库上，重启之后照样查得到', async () => {
    const repository = pgRepository();
    const role_id = `role_persona_job_db_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'Persona Job DB Agent' });
    await seedSkill(repository, role_id);

    const result = await pgJob(repository, role_id, () => START).run({ batchSize: 5 });

    // 换一个进程（新的 store 实例）读同一份库
    const revived = await new FileMaintenanceRunStore({ root: runStoreRoot() }).get(result.run.run_id);
    expect(revived).toMatchObject({
      job_type: 'persona_evolution',
      status: 'completed',
      worker_id: 'worker-db',
      claimed_count: 1,
      completed_count: 1,
    });
  });

  it('重启：新实例接着处理上一个进程没跑完的那一批', async () => {
    const repository = pgRepository();
    const first_role = `role_persona_job_restart_a_${randomUUID()}`;
    const second_role = `role_persona_job_restart_b_${randomUUID()}`;
    await repository.initializeAgent({ role_id: first_role, name: 'Restart A' });
    await repository.initializeAgent({ role_id: second_role, name: 'Restart B' });
    await seedSkill(repository, first_role);
    await seedSkill(repository, second_role);

    const first = await pgJob(repository, undefined, () => START).run({ batchSize: 1 });
    expect(first.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });
    const firstRoleDone = first.outcomes[0]!.role_id;

    // 新实例、同一份库：先把过期租约恢复一遍（这一次没有过期的），再把剩下的处理掉
    const second = await pgJob(pgRepository(), undefined, () => START).run({ batchSize: 5 });

    expect(second.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });
    expect(second.outcomes[0]?.role_id).toBe(
      firstRoleDone === first_role ? second_role : first_role,
    );
    expect(await repository.getPersona(first_role)).toMatchObject({ version: 2 });
    expect(await repository.getPersona(second_role)).toMatchObject({ version: 2 });
  });
});

// ════════════════════════════════════════════════════════
//  失败分类：层与码的对应关系只定一次
// ════════════════════════════════════════════════════════

describe('classifyPersonaEvolutionFailure — 判定层与存储层分得开', () => {
  it('判定违反契约 → malformed_decision，不可重试（同一次判定重投多少次都是同一份）', () => {
    const error = new PersonaEvolutionDecisionContractError('bad decision', {
      violation: 'verdict',
      expected: 'eligible | pending_review | rejected',
      actual: 'typo',
      role_id: 'role_x',
    });
    const classified = classifyPersonaEvolutionFailure(error, 'judgement');

    expect(classified).toMatchObject({ code: 'payload_unreadable', retryable: false });
    // 稳定标识也在错误对象上：跨进程聚合这一族失败时读它，不读 message
    expect((error as { contract_code?: string }).contract_code).toBe(
      PERSONA_EVOLUTION_DECISION_CONTRACT_CODE,
    );
  });

  it('判定层抛出且通用分类说可重试 → model_failure，可重试（这条通道里会抛的判定多半在调模型）', () => {
    expect(classifyPersonaEvolutionFailure(new Error('socket hang up'), 'judgement')).toMatchObject({
      code: 'model_error',
      retryable: true,
    });
    // 连接类 errno 走的是通用分类，结论仍是「可重试 → 模型层」
    const timeout = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(classifyPersonaEvolutionFailure(timeout, 'judgement')).toMatchObject({
      code: 'model_error',
      retryable: true,
    });
  });

  it('判定层抛出且通用分类说不可重试 → policy_failure，不可重试（策略在声明「这份输入我不判」）', () => {
    expect(classifyPersonaEvolutionFailure(new ZodError([]), 'judgement')).toMatchObject({
      code: 'policy_rejected',
      retryable: false,
    });
  });

  it('存储层抛出：可重试的读成 storage_failure，不可重试的沿用通用分类（权限/路径是确定的配置错）', () => {
    expect(classifyPersonaEvolutionFailure(new Error('deadlock detected'), 'storage')).toMatchObject({
      code: 'storage_error',
      retryable: true,
    });
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(classifyPersonaEvolutionFailure(denied, 'storage')).toMatchObject({
      code: 'storage_error',
      retryable: false,
    });
  });

  it('归属 Agent 不在了：前缀与外部键冲突都读成 missing_input，不白占重试名额', () => {
    const removed = classifyPersonaEvolutionFailure(new Error('Agent not found: role_x'), 'storage');
    expect(removed).toMatchObject({ code: 'delivery_missing', retryable: false });

    const foreignKey = Object.assign(new Error('insert violates constraint'), { code: '23503' });
    expect(classifyPersonaEvolutionFailure(foreignKey, 'storage')).toMatchObject({
      code: 'delivery_missing',
      retryable: false,
    });
  });
});
