/**
 * Skill Promotion Job（Phase 3-C）测试
 *
 * 覆盖「一次晋升运行」这件事：批量 claim、逐条隔离、run 记录与收尾、批大小与墙钟上限、
 * 优雅停止、启动恢复、dry-run、策略版本断言，以及多 worker 下不产生重复 Skill。断言一律
 * 落在**持久化之后的状态**上（库里到底有几条 Skill、经验上的晋升标记是什么、run 记录写了
 * 什么），而不是「某个函数被调用过」——后者在存储语义出错时照样通过。
 *
 * 一条候选怎么走完（判定、两段写、失败分类）是 3-B 的验收面，已在 promotion-state.test.ts
 * 里由双后端契约钉住；这里只在需要看「整批的账」时经过它。
 *
 * 同一份外壳契约跑两个后端（InMemoryRepository 与 PGlite 上的 PgMemoryRepository），
 * run store 在那条腿上也换成真实实现（文件后端：队列与审计按设计不占数据库）。
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

import { nowTimestamp } from '../../core';
import {
  DEFAULT_PROMOTION_STRATEGY_VERSION,
  DefaultPromotionStrategy,
} from '../adapters/default-promotion-strategy';
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
import { DefaultSkillPromotionJob } from '../runtime/skill-promotion-job';
import { promotionStateLabel } from '../services/promotion-candidates';
import {
  DEFAULT_DELIVERY_LEASE_MS,
  DEFAULT_PROMOTION_RETRY_POLICY,
  addMilliseconds,
} from '../services/delivery-lifecycle';
import {
  PROMOTION_DECISION_CONTRACT_CODE,
  assertPromotionDecisionConsistent,
  executePromotionCandidate,
  isPromotionDecisionContractError,
  type PromotionDecisionContractError,
} from '../services/promotion-executor';
import type { MaintenanceRunStore } from '../ports/maintenance-run-store';
import type { MemoryRepository } from '../ports/memory-repository';
import type {
  PromotionApprovalMode,
  PromotionDecision,
  PromotionEvaluationInput,
  PromotionStrategy,
  PromotionVerdict,
} from '../ports/promotion-strategy';
import type {
  PromotionCandidateStatus,
  SkillPromotionJobOptions,
} from '../ports/skill-promotion-job';
import type { ExperienceRecord } from '../schemas';
import type { SqlPool } from '../ports/sql-pool';

const START = '2026-10-10T12:00:00.000Z';
/** 缺省策略的退避起点：失败后要跨过它才能被重新 claim */
const RETRY_BASE_DELAY_MS = DEFAULT_PROMOTION_RETRY_POLICY.base_delay_ms;

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

function makeExperience(
  role_id: string,
  overrides: Partial<ExperienceRecord> = {},
): ExperienceRecord {
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

/**
 * 播一批经验并按「先来的先处理」排好序：`created_at` 递增，因此下标 0 是最先被 claim 的
 * 那条。排序靠 `created_at`（不是靠插入顺序）是选候选规则的一部分，测试必须照着它造数据，
 * 否则「同一毫秒的两条谁先」这种偶然会漏进来。
 */
async function seedExperiences(
  repository: MemoryRepository,
  role_id: string,
  count: number,
  overrides: Partial<ExperienceRecord> = {},
): Promise<ExperienceRecord[]> {
  const seeded: ExperienceRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const experience = makeExperience(role_id, {
      created_at: addMilliseconds(START, -60_000 + index * 1_000),
      ...overrides,
    });
    await repository.saveExperience(role_id, experience);
    seeded.push(experience);
  }
  return seeded;
}

/**
 * 在真实策略外面套一层钩子：推进假时钟、置停止位、或第一次调用就抛错。
 *
 * 用它而不是另写一个假策略，是为了让「策略抛错」与「策略正常运行」在同一份判定规则上
 * 发生——否则失败路径测的是替身自己的行为，不是策略真的出错时外壳怎么办。
 */
function hookedStrategy(
  base: DefaultPromotionStrategy,
  hook: (input: PromotionEvaluationInput, call: number) => void,
): PromotionStrategy {
  let calls = 0;
  return {
    version: base.version,
    config: base.config,
    evaluate: async (input) => {
      calls += 1;
      hook(input, calls);
      return base.evaluate(input);
    },
  };
}

/**
 * 让 claim 在第 N 次之后失败：模拟「外壳读不动存储」。
 *
 * 用 Proxy 而不是手写一个转发全部方法的包装类：端口有几十个方法，手写转发要在每个方法上
 * 抄一遍签名，改端口时还得跟着改。两个适配器都是普通类（没有 `#` 私有字段），属性访问走
 * 代理也能正常读到内部状态。
 */
function createFailOnClaimRepository(
  inner: MemoryRepository,
  shouldFail: () => boolean,
): MemoryRepository {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'claimNextPromotionCandidate') {
        return async (request: never) => {
          if (shouldFail()) {
            throw Object.assign(new Error('database is temporarily unavailable'), {
              code: 'ECONNRESET',
            });
          }
          return target.claimNextPromotionCandidate(request);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/** 一次运行声明的默认期望：没有失败、没有跳过 */
const NO_FAILURES = {
  retried_count: 0,
  dead_letter_count: 0,
  skipped_count: 0,
  failure_count: 0,
};

/**
 * 让策略**照常判定**，但把判定里的某一个字段改掉之后再交回来。
 *
 * 契约校验要测的是「策略不老实」这一种故障，而真实的 `DefaultPromotionStrategy` 永远不会
 * 返回一份自相矛盾的判定——所以只能在它外面改字段。刻意用 `base.evaluate` 的**真结论**做底：
 * 这样「返回的判定与本次执行对不上」是唯一被注入的差异，失败一定能归因到契约校验，而不是
 * 归因到某个假策略自己编的结论。
 */
function tamperingStrategy(
  base: DefaultPromotionStrategy,
  tamper: (decision: PromotionDecision, input: PromotionEvaluationInput, call: number) => PromotionDecision,
): PromotionStrategy {
  let calls = 0;
  return {
    version: base.version,
    config: base.config,
    evaluate: async (input) => {
      calls += 1;
      return tamper(await base.evaluate(input), input, calls);
    },
  };
}

/**
 * 自称另一个版本的策略：**整体**换个版本（`version`、`config.version` 与判定自报的那一个
 * 一起换）。
 *
 * 用它构造的是「运行与真跑的策略版本不是同一个」——run 会照着这个版本记审计。
 */
function selfDeclaredVersionStrategy(
  base: DefaultPromotionStrategy,
  version: string,
): PromotionStrategy {
  const config = { ...base.config, version };
  return {
    version,
    config,
    evaluate: async (input) => {
      const decision = await base.evaluate(input);
      return { ...decision, strategy_version: version };
    },
  };
}

/**
 * 无论运行要求什么审核模式，都自称是 `fixed` 的那一个的策略。
 *
 * 这是「策略实现忽略运行选项」这一种配置错：运行让它在自动批准下判定，它却回一份写着
 * manual_review 的结论（反过来也一样）。判定本身自洽，不自洽的是它与本次运行的关系。
 */
function claimingApprovalStrategy(
  base: DefaultPromotionStrategy,
  fixed: 'auto_approve' | 'manual_review',
): PromotionStrategy {
  const config = { ...base.config, approval: fixed };
  return {
    version: config.version,
    config,
    evaluate: async (input) => {
      const decision = await base.evaluate(input);
      return { ...decision, approval: fixed };
    },
  };
}

/**
 * 让策略交回一份**运行时非法**的判定（形状任意，连对象都可以不是）。
 *
 * 与 `tamperingStrategy` 的分工：那个在真结论上改一个字段，交回去的仍然是一份判定——被注入
 * 的差异只有那一处，失败归因干净；这个用来造真策略**不可能**产出的东西：`null`、标量、字段
 * 类型全错、或者一个拼错的 verdict。绕开 TypeScript 正是被审计的自定义策略会做的事，因此
 * 替身也照做——端口声明的是 `PromotionDecision`，这里只能把非法值 `as` 过去。
 *
 * 底稿同样取真结论（合格的那一份），并**原样透出**让用例只改它要改的地方。
 */
function illegalDecisionStrategy(
  base: DefaultPromotionStrategy,
  corrupt: (
    decision: PromotionDecision,
    input: PromotionEvaluationInput,
    call: number,
  ) => unknown,
): PromotionStrategy {
  let calls = 0;
  return {
    version: base.version,
    config: base.config,
    evaluate: async (input) => {
      calls += 1;
      return corrupt(await base.evaluate(input), input, calls) as PromotionDecision;
    },
  };
}

/**
 * 从一份判定里删掉一个字段（造「字段缺席」用）。
 *
 * 与 `{ ...decision, verdict: undefined }` 是两种不同的坏法（后者是键在而值为 undefined），
 * 校验对两者给出同一个结论，这里用「键都不在」这一种。
 */
function without(decision: PromotionDecision, key: keyof PromotionDecision): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...decision };
  delete copy[key];
  return copy;
}

/**
 * 校验器本身的契约：一份非法判定**各自**落在哪一个 violation 上，错误对象上带着哪几个数。
 *
 * 它不碰存储（纯函数），因此不跟着双后端契约跑两遍。放在这里是因为 job 的演练路径与执行内核
 * 用的是同一个函数：两种故障（形状不合法 / 与本次执行对不上）在失败消息里长得很像，必须由
 * violation 稳定地区分开——聚合一个 run 里「策略到底错在哪」时读的是它，不是消息文本。
 */
describe('assertPromotionDecisionConsistent — 运行时判定契约', () => {
  const experience_id = 'exp_contract_1';
  /** 本次执行的权威口径（与执行内核接到的那一份同形） */
  const expected: {
    experience_id: string;
    approval: PromotionApprovalMode;
    strategy_version: string;
  } = {
    experience_id,
    approval: 'auto_approve',
    strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
  };

  /** 一份合法判定的底稿：每个用例只破坏其中一处 */
  function legalDecision(): PromotionDecision {
    return {
      verdict: 'eligible',
      strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
      approval: 'auto_approve',
      reasons: ['Candidate qualifies.'],
      blocking_rules: [],
      experience_id,
    };
  }

  /** 跑一次校验，把抛出来的契约错误取回来（没抛就是不合法判定从这道门溜过去了） */
  function violationOf(decision: unknown, overrides: Partial<typeof expected> = {}) {
    let thrown: unknown;
    try {
      assertPromotionDecisionConsistent(decision, { ...expected, ...overrides });
    } catch (error) {
      thrown = error;
    }
    expect(isPromotionDecisionContractError(thrown)).toBe(true);
    return thrown as PromotionDecisionContractError;
  }

  it('合法判定一律放行（自动批准 / 人工审核 / 拒绝三种结论）', () => {
    expect(() => assertPromotionDecisionConsistent(legalDecision(), expected)).not.toThrow();
    expect(() =>
      assertPromotionDecisionConsistent(
        { ...legalDecision(), verdict: 'pending_review', approval: 'manual_review' },
        { ...expected, approval: 'manual_review' },
      ),
    ).not.toThrow();
    expect(() =>
      assertPromotionDecisionConsistent(
        {
          ...legalDecision(),
          verdict: 'rejected',
          reasons: ['confidence 0.5 does not exceed the threshold.'],
          blocking_rules: ['below_confidence_threshold'],
        },
        expected,
      ),
    ).not.toThrow();
    // rejected 与审核模式无关：两种模式下都是同一个结论，因此两种配对都合法
    expect(() =>
      assertPromotionDecisionConsistent(
        {
          ...legalDecision(),
          verdict: 'rejected',
          approval: 'manual_review',
          reasons: ['confidence 0.5 does not exceed the threshold.'],
          blocking_rules: ['below_confidence_threshold'],
        },
        { ...expected, approval: 'manual_review' },
      ),
    ).not.toThrow();
  });

  it('每一类非法值都落在它自己的 violation 上，错误里带着 expected / actual / 经验 id', () => {
    const cases: Array<{ name: string; decision: unknown; violation: string; needle?: string }> = [
      { name: 'decision 为 null', decision: null, violation: 'decision_shape' },
      { name: 'decision 为 undefined', decision: undefined, violation: 'decision_shape' },
      { name: 'decision 为标量', decision: 'eligible', violation: 'decision_shape' },
      { name: 'decision 为数组', decision: [], violation: 'decision_shape' },
      { name: 'verdict 缺失', decision: without(legalDecision(), 'verdict'), violation: 'verdict' },
      {
        name: 'verdict 是自造的值',
        decision: { ...legalDecision(), verdict: 'typo' },
        violation: 'verdict',
        needle: 'typo',
      },
      {
        name: 'verdict 不是字符串',
        decision: { ...legalDecision(), verdict: 1 },
        violation: 'verdict',
      },
      {
        name: 'strategy_version 为空串',
        decision: { ...legalDecision(), strategy_version: '' },
        violation: 'strategy_version',
      },
      {
        name: 'strategy_version 不是字符串',
        decision: { ...legalDecision(), strategy_version: 7 },
        violation: 'strategy_version',
      },
      {
        name: 'strategy_version 与执行不符',
        decision: { ...legalDecision(), strategy_version: 'promotion-threshold.v9' },
        violation: 'strategy_version',
        needle: 'promotion-threshold.v9',
      },
      {
        name: 'experience_id 为空串',
        decision: { ...legalDecision(), experience_id: '   ' },
        violation: 'experience_id',
      },
      {
        name: 'experience_id 不是字符串',
        decision: { ...legalDecision(), experience_id: null },
        violation: 'experience_id',
      },
      {
        name: 'experience_id 指向别处',
        decision: { ...legalDecision(), experience_id: 'exp_other' },
        violation: 'experience_id',
        needle: 'exp_other',
      },
      {
        name: 'approval 不是合法模式',
        decision: { ...legalDecision(), approval: 'yolo' },
        violation: 'approval',
        needle: 'yolo',
      },
      {
        name: 'approval 与本次运行不符',
        decision: { ...legalDecision(), approval: 'manual_review' },
        violation: 'approval',
      },
      {
        name: 'reasons 不是数组',
        decision: { ...legalDecision(), reasons: 'Candidate qualifies.' },
        violation: 'reasons',
      },
      {
        name: 'reasons 元素不是字符串',
        decision: { ...legalDecision(), reasons: [1] },
        violation: 'reasons',
      },
      {
        name: 'reasons 元素是空串',
        decision: { ...legalDecision(), reasons: [''] },
        violation: 'reasons',
      },
      {
        name: 'blocking_rules 不是数组',
        decision: { ...legalDecision(), blocking_rules: 'already_promoted' },
        violation: 'blocking_rules',
      },
      {
        name: 'blocking_rules 元素不是字符串',
        decision: { ...legalDecision(), blocking_rules: [1] },
        violation: 'blocking_rules',
      },
      {
        name: 'blocking_rules 是未知规则名',
        decision: { ...legalDecision(), blocking_rules: ['looks_suspicious'] },
        violation: 'blocking_rules',
        needle: 'looks_suspicious',
      },
    ];

    for (const testCase of cases) {
      const error = violationOf(testCase.decision);
      expect(error.violation, testCase.name).toBe(testCase.violation);
      expect(error.contract_code, testCase.name).toBe(PROMOTION_DECISION_CONTRACT_CODE);
      // 经验 id 即使判定自身给不出也要能报出来：本次执行被 claim 给了谁，调用方知道
      expect(error.experience_id, testCase.name).toBe(experience_id);
      // 只有配对那一类 violation 会在错误对象上带这两个值，其余保持缺席
      expect(error.verdict, testCase.name).toBeUndefined();
      expect(error.approval, testCase.name).toBeUndefined();
      expect(error.expected.length, testCase.name).toBeGreaterThan(0);
      // actual 有可能是空串（空版本/空经验 id 正是被拒的那一类值），因此这里只要求它被渲染
      // 进消息里；具体值由每个用例的 needle 钉住
      expect(error.message, testCase.name).toContain('got "');
      // 消息里要能读出「哪个字段、该是什么、实际是什么」，以及这是一次配置错而不是抖动
      expect(error.message, testCase.name).toContain(experience_id);
      expect(error.message, testCase.name).toContain(testCase.violation);
      expect(error.message, testCase.name).toContain('not retried');
      if (testCase.needle) expect(error.message, testCase.name).toContain(testCase.needle);
    }
  });

  it('结论组合：rejected 必须给出挡板与理由，合格的两个结论不得带挡板', () => {
    const cases: Array<{ name: string; decision: unknown; approval: PromotionApprovalMode }> = [
      {
        name: 'rejected 却没有挡板规则',
        decision: {
          ...legalDecision(),
          verdict: 'rejected',
          reasons: ['confidence is too low'],
          blocking_rules: [],
        },
        approval: 'auto_approve',
      },
      {
        name: 'rejected 却没有理由',
        decision: {
          ...legalDecision(),
          verdict: 'rejected',
          reasons: [],
          blocking_rules: ['below_confidence_threshold'],
        },
        approval: 'auto_approve',
      },
      {
        name: 'eligible 却带着挡板规则',
        decision: { ...legalDecision(), blocking_rules: ['below_confidence_threshold'] },
        approval: 'auto_approve',
      },
      {
        name: 'pending_review 却带着挡板规则',
        decision: {
          ...legalDecision(),
          verdict: 'pending_review',
          approval: 'manual_review',
          blocking_rules: ['below_confidence_threshold'],
        },
        approval: 'manual_review',
      },
    ];

    for (const testCase of cases) {
      const error = violationOf(testCase.decision, { approval: testCase.approval });
      expect(error.violation, testCase.name).toBe('verdict_combination');
    }
  });

  it('结论与审核模式必须配对：eligible 只配 auto_approve，pending_review 只配 manual_review', () => {
    // 两个字段各自都合法、合起来却在说一件不可能的事。这里把 approval 报成「本次运行的那一个」
    // （因此前面那条与运行对账的检查放行），被拒的唯一理由只剩配对——失败能干净地归因到这一条。
    const cases: Array<{
      name: string;
      verdict: PromotionVerdict;
      approval: PromotionApprovalMode;
      expected: string;
    }> = [
      {
        name: 'eligible + manual_review（会让执行内核在只许记录的模式下写 Skill）',
        verdict: 'eligible',
        approval: 'manual_review',
        expected: 'eligible + auto_approve',
      },
      {
        name: 'pending_review + auto_approve（会把该自动晋升的候选冻结成人再看一眼）',
        verdict: 'pending_review',
        approval: 'auto_approve',
        expected: 'pending_review + manual_review',
      },
    ];

    for (const testCase of cases) {
      const actual = `${testCase.verdict} + ${testCase.approval}`;
      const error = violationOf(
        { ...legalDecision(), verdict: testCase.verdict, approval: testCase.approval },
        { approval: testCase.approval },
      );

      // 稳定标识分两个：配对（verdict_approval）与结论和数组的搭配（verdict_combination）
      // 指向两种修法，聚合时不该混成一句「组合不对」
      expect(error.violation, testCase.name).toBe('verdict_approval');
      expect(error.contract_code, testCase.name).toBe(PROMOTION_DECISION_CONTRACT_CODE);
      expect(error.experience_id, testCase.name).toBe(experience_id);
      // 判定自报的那两个值单独挂在错误对象上：合成一个字符串之后就不好跨 run 计数了
      expect(error.verdict, testCase.name).toBe(testCase.verdict);
      expect(error.approval, testCase.name).toBe(testCase.approval);
      // expected / actual 是给人读的两个组合串（该配哪一对、实际交回来哪一对）
      expect(error.expected, testCase.name).toBe(testCase.expected);
      expect(error.actual, testCase.name).toBe(actual);
      expect(error.message, testCase.name).toContain(testCase.verdict);
      expect(error.message, testCase.name).toContain(testCase.approval);
      expect(error.message, testCase.name).toContain('not retried');
    }
  });

  it('渲染不出来的 actual 不会变成第二个错误源（循环引用 / BigInt 都只写成一句话）', () => {
    const circular: Record<string, unknown> = { ...legalDecision(), verdict: 'typo' };
    circular.self = circular;
    // 一份既循环引用、verdict 又不合法的判定：校验要拒它，而不是在拼消息时炸掉
    expect(violationOf(circular).violation).toBe('verdict');
    expect(violationOf(circular).actual).toBe('typo');

    const withBigInt = { ...legalDecision(), strategy_version: 1n };
    const error = violationOf(withBigInt);
    expect(error.violation).toBe('strategy_version');
    expect(error.actual).toBe('1');
  });
});

interface JobStoreCase {
  name: string;
  create: () => Promise<{ repository: MemoryRepository; runStore: MaintenanceRunStore }>;
}

// ════════════════════════════════════════════════════════
//  同一份外壳契约，两个后端各跑一遍
// ════════════════════════════════════════════════════════

function runSkillPromotionJobSuite(storeCase: JobStoreCase): void {
  describe(`skill promotion job — ${storeCase.name}`, () => {
    let repository: MemoryRepository;
    let runStore: MaintenanceRunStore;
    let clock: TestClock;
    let role_id: string;

    /** 自动批准是显式开关（缺省策略是人工审核），多数用例要的正是「判定合格就晋升」 */
    const autoApprove = new DefaultPromotionStrategy({ approval: 'auto_approve' });

    beforeAll(async () => {
      const created = await storeCase.create();
      repository = created.repository;
      runStore = created.runStore;
    });

    beforeEach(async () => {
      clock = testClock();
      role_id = `role_promotion_job_${randomUUID()}`;
      await repository.initializeAgent({ role_id, name: 'Promotion Job Agent' });
    });

    function job(overrides: Partial<SkillPromotionJobOptions> = {}): DefaultSkillPromotionJob {
      return new DefaultSkillPromotionJob({
        repository,
        runStore,
        strategy: autoApprove,
        worker_id: 'worker-1',
        role_id,
        now: clock.now,
        ...overrides,
      });
    }

    async function storedExperience(id: string): Promise<ExperienceRecord | undefined> {
      return (await repository.listExperiences(role_id)).find((item) => item.id === id);
    }

    it('正常晋升一批：Skill 落库、经验绑定、run 计数与停止原因都对', async () => {
      const experiences = await seedExperiences(repository, role_id, 2);

      const result = await job().run({ batchSize: 5 });

      expect(result.stop_reason).toBe('no_work');
      expect(result.dry_run).toBe(false);
      expect(result.approval).toBe('auto_approve');
      expect(result.strategy_version).toBe(DEFAULT_PROMOTION_STRATEGY_VERSION);
      expect(result.worker_failure).toBeUndefined();

      // 逐条结果按「先来的先处理」排序，每个都带着判定与产出的 skill id
      expect(result.outcomes.map((item) => item.experience_id)).toEqual(
        experiences.map((item) => item.id),
      );
      expect(result.outcomes.map((item) => item.status)).toEqual(['promoted', 'promoted']);
      expect(result.outcomes.map((item) => item.attempt_count)).toEqual([1, 1]);
      expect(result.outcomes.map((item) => item.run_id)).toEqual([
        result.run.run_id,
        result.run.run_id,
      ]);

      expect(result.counts).toMatchObject({
        claimed_count: 2,
        completed_count: 2,
        ...NO_FAILURES,
      });

      const skills = await repository.listSkills(role_id);
      expect(skills).toHaveLength(2);
      for (const experience of experiences) {
        const skill = skills.find((item) => item.promoted_from === experience.id);
        // 自动批准写的是「已生效」的技能，不是先 pending 再补一次 updateSkill
        expect(skill?.review_status).toBe('approved');
        const stored = await storedExperience(experience.id);
        expect(stored?.promoted_to).toBe(skill?.id);
        expect(stored?.promotion?.outcome).toBe('promoted');
        expect(stored?.promotion?.strategy_version).toBe(DEFAULT_PROMOTION_STRATEGY_VERSION);
      }
      // outcomes 里的 skill id 就是库里那一条（同一次写入的两个读口不许各说各话）
      for (const outcome of result.outcomes) {
        const skill = skills.find((item) => item.promoted_from === outcome.experience_id);
        expect(outcome.skill_id).toBe(skill?.id);
      }
    });

    it('run 记录可查：job_type / worker / 计数 / 终止时刻都对得上', async () => {
      await seedExperiences(repository, role_id, 1);

      const result = await job().run({ batchSize: 5 });

      expect(result.run).toMatchObject({
        job_type: 'skill_promotion',
        status: 'completed',
        worker_id: 'worker-1',
        started_at: START,
        claimed_count: 1,
        completed_count: 1,
      });
      expect(result.run.finished_at).toBeDefined();
      // 这一批没有失败：run 上不该留下 last_error
      expect(result.run.last_error).toBeUndefined();

      const runs = await runStore.list({ job_type: 'skill_promotion', worker_id: 'worker-1' });
      const stored = runs.find((item) => item.run_id === result.run.run_id);
      expect(stored).toMatchObject({ status: 'completed', claimed_count: 1, completed_count: 1 });
    });

    it('批大小：到量即停，剩下的留给下一次；没有候选时立刻收工', async () => {
      const experiences = await seedExperiences(repository, role_id, 3);

      // 上限写在 job 配置上（运维口径），本次运行不另给
      const first = await job({ batch_size: 1 }).run();
      expect(first.stop_reason).toBe('batch_size');
      expect(first.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });
      expect(first.outcomes[0]?.experience_id).toBe(experiences[0]?.id);

      const second = await job().run({ batchSize: 10 });
      expect(second.stop_reason).toBe('no_work');
      expect(second.counts).toMatchObject({ claimed_count: 2, completed_count: 2 });
      expect(await repository.listSkills(role_id)).toHaveLength(3);

      // 已晋升的经验不再入选：第三次运行一条都不 claim，也不会攒出第二条技能
      const third = await job().run();
      expect(third.stop_reason).toBe('no_work');
      expect(third.counts).toMatchObject({ claimed_count: 0, ...NO_FAILURES });
      expect(third.outcomes).toHaveLength(0);
      expect(await repository.listSkills(role_id)).toHaveLength(3);
    });

    it('墙钟上限：超时即停，已经处理的那条照常落定', async () => {
      await seedExperiences(repository, role_id, 3);
      // 每条判定推进 5 秒的假时钟：跑完第一条就已经越过 1 秒的上限
      const slow = hookedStrategy(autoApprove, () => clock.advance(5_000));

      const result = await job({ strategy: slow }).run({ batchSize: 10, maxDurationMs: 1_000 });

      expect(result.stop_reason).toBe('max_duration');
      expect(result.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0]?.status).toBe('promoted');
      expect(await repository.listSkills(role_id)).toHaveLength(1);
    });

    it('优雅停止：置位后不再 claim 新的，在途的那条照常跑完', async () => {
      const experiences = await seedExperiences(repository, role_id, 2);
      const controller = new AbortController();
      const aborting = hookedStrategy(autoApprove, () => controller.abort());

      const result = await job({ strategy: aborting }).run({
        batchSize: 10,
        signal: controller.signal,
      });

      expect(result.stop_reason).toBe('aborted');
      expect(result.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });
      expect(result.outcomes).toHaveLength(1);
      // 在途的那条跑完了：Skill 与绑定都在（半途而废只会更慢，回收它的是租约）
      const first = await storedExperience(experiences[0]!.id);
      expect(first?.promoted_to).toBeDefined();
      expect(first?.promotion?.outcome).toBe('promoted');
      // 另一条原样排队：没有被 claim、也没有被判过
      const second = await storedExperience(experiences[1]!.id);
      expect(second?.promotion).toBeUndefined();
      expect(await repository.listSkills(role_id)).toHaveLength(1);
    });

    it('人工审核：只记结论不写 Skill；放宽成自动批准之后同一条被重新评估并晋升', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);

      const reviewed = await job().run({ approval: 'manual_review' });
      expect(reviewed.approval).toBe('manual_review');
      expect(reviewed.outcomes[0]?.status).toBe('pending_review');
      expect(reviewed.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });
      expect(await repository.listSkills(role_id)).toHaveLength(0);
      const pending = await storedExperience(experiences[0]!.id);
      expect(pending?.promotion?.outcome).toBe('pending_review');
      expect(pending?.promoted_to).toBeUndefined();

      // 同一模式再跑：待审核的候选不重复 claim（waiting_for_manual_review）
      const again = await job().run({ approval: 'manual_review' });
      expect(again.counts.claimed_count).toBe(0);
      expect(again.stop_reason).toBe('no_work');

      // 放宽之后被重新评估：这一次真的写出 Skill
      const upgraded = await job().run({ approval: 'auto_approve' });
      expect(upgraded.outcomes.map((item) => item.status)).toEqual(['promoted']);
      expect(upgraded.outcomes[0]?.experience_id).toBe(experiences[0]?.id);
      expect(await repository.listSkills(role_id)).toHaveLength(1);
    });

    it('判定不合格：记 rejected，不写 Skill，同一策略版本下不重评', async () => {
      await seedExperiences(repository, role_id, 1, { confidence: 0.5 });

      const result = await job().run();

      expect(result.outcomes[0]?.status).toBe('rejected');
      expect(result.outcomes[0]?.decision?.blocking_rules).toContain('below_confidence_threshold');
      // 判定不合格不是故障：它落在完成数里，不进重试也不进死信
      expect(result.counts).toMatchObject({
        claimed_count: 1,
        completed_count: 1,
        ...NO_FAILURES,
      });
      expect(await repository.listSkills(role_id)).toHaveLength(0);

      const again = await job().run();
      expect(again.counts.claimed_count).toBe(0);
      expect(again.outcomes).toHaveLength(0);
    });

    it('可重试失败：退避回队列，跨过退避窗口后被重投并晋升', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      const transient = Object.assign(new Error('connection reset by peer'), {
        code: 'ECONNRESET',
      });
      const flaky = hookedStrategy(autoApprove, (_input, call) => {
        if (call === 1) throw transient;
      });
      const flakyJob = job({ strategy: flaky });

      const first = await flakyJob.run();
      expect(first.outcomes[0]?.status).toBe('retried');
      expect(first.outcomes[0]?.failure).toMatchObject({
        code: 'downstream_unavailable',
        retryable: true,
      });
      expect(first.counts).toMatchObject({ claimed_count: 1, retried_count: 1 });
      // 审计没丢：失败码与原因都落在 run 上，也落在经验自己的晋升标记上
      expect(first.run.status).toBe('completed');
      expect(first.run.last_error).toContain('downstream_unavailable');
      const retried = await storedExperience(experiences[0]!.id);
      expect(retried?.promotion?.status).toBe('pending');
      expect(retried?.promotion?.last_error).toContain('connection reset');
      expect(retried?.promotion?.next_retry_at).toBe(
        addMilliseconds(clock.now(), RETRY_BASE_DELAY_MS),
      );
      expect(retried?.promoted_to).toBeUndefined();

      // 退避窗口没到：claim 不到，这一次「没活」
      const tooEarly = await flakyJob.run();
      expect(tooEarly.counts.claimed_count).toBe(0);
      expect(tooEarly.stop_reason).toBe('no_work');

      clock.advance(RETRY_BASE_DELAY_MS);
      const second = await flakyJob.run();
      expect(second.outcomes.map((item) => item.status)).toEqual(['promoted']);
      // 次数保留：这是同一条候选的第二次投递，不是新候选
      expect(second.outcomes[0]?.attempt_count).toBe(2);
      expect(await repository.listSkills(role_id)).toHaveLength(1);
      expect((await storedExperience(experiences[0]!.id))?.promoted_to).toBeDefined();
    });

    it('不可恢复失败进死信，自动路径不再碰它，人工重试之后还能跑通', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      const permanent = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      const broken = hookedStrategy(autoApprove, (_input, call) => {
        if (call === 1) throw permanent;
      });
      const brokenJob = job({ strategy: broken });

      const first = await brokenJob.run();
      expect(first.outcomes[0]?.status).toBe('dead_letter');
      expect(first.counts).toMatchObject({ claimed_count: 1, dead_letter_count: 1 });
      const dead = await storedExperience(experiences[0]!.id);
      expect(dead?.promotion?.status).toBe('dead_letter');
      expect(dead?.promotion?.last_error).toContain('permission denied');

      // 死信只由人工重试放回：自动路径连着跑几次都不会碰它
      const auto = await brokenJob.run();
      expect(auto.counts.claimed_count).toBe(0);

      const revived = await repository.retryDeadLetterPromotion({
        role_id,
        experience_id: experiences[0]!.id,
        now: clock.now(),
      });
      expect(revived?.promotion?.status).toBe('pending');
      expect(revived?.promotion?.attempt_count).toBe(0);

      const second = await brokenJob.run();
      expect(second.outcomes.map((item) => item.status)).toEqual(['promoted']);
      expect(await repository.listSkills(role_id)).toHaveLength(1);
    });

    /** 模拟「上一个 worker claim 走之后崩了」：这条候选停在它的名下，租约由调用方跨过去 */
    async function strandClaim(
      experience_id: string,
      options: { owner?: string; lease_ms?: number } = {},
    ) {
      const claimed = await repository.claimNextPromotionCandidate({
        role_id,
        owner: options.owner ?? 'worker-crashed',
        now: clock.now(),
        lease_ms: options.lease_ms ?? DEFAULT_DELIVERY_LEASE_MS,
        strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
        approval: 'auto_approve',
      });
      expect(claimed?.experience.id).toBe(experience_id);
      return claimed!;
    }

    it('启动恢复：上一个 worker 留下的过期持有被放回队列，并在同一次运行里处理完', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      await strandClaim(experiences[0]!.id);
      // 租约过期：持有者已经算「不见了」
      clock.advance(DEFAULT_DELIVERY_LEASE_MS);

      const result = await job().run({ batchSize: 5 });

      expect(result.restored_count).toBe(1);
      expect(result.outcomes.map((item) => item.experience_id)).toEqual([experiences[0]?.id]);
      expect(result.outcomes[0]?.status).toBe('promoted');
      // 恢复出来的候选是一次新的投递：次数在原来的基础上往前推
      expect(result.outcomes[0]?.attempt_count).toBe(2);
      expect(await repository.listSkills(role_id)).toHaveLength(1);
    });

    it('restoreExpired：只回收过期的持有，未过期的不动，并如实列出回收了什么', async () => {
      const experiences = await seedExperiences(repository, role_id, 2);
      await strandClaim(experiences[0]!.id, { owner: 'worker-crashed' });
      // 第二条的持有仍然活着（租约比这一轮长得多），回收扫描不该碰它
      await strandClaim(experiences[1]!.id, {
        owner: 'worker-alive',
        lease_ms: DEFAULT_DELIVERY_LEASE_MS * 10,
      });
      clock.advance(DEFAULT_DELIVERY_LEASE_MS);

      const restored = await job().restoreExpired({ role_id });

      expect(restored).toEqual({
        count: 1,
        restored: [{ role_id, experience_id: experiences[0]?.id }],
      });
      expect((await storedExperience(experiences[0]!.id))?.promotion?.status).toBe('pending');
      // 未过期的还归它原来的持有者：回收不是「见到 processing 就抢」
      const alive = await storedExperience(experiences[1]!.id);
      expect(alive?.promotion?.status).toBe('processing');
      expect(alive?.promotion?.claim_owner).toBe('worker-alive');
    });

    it('关掉启动恢复：那一次回收扫描不跑，过期持有改由 claim 自己接住', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      await strandClaim(experiences[0]!.id);
      clock.advance(DEFAULT_DELIVERY_LEASE_MS);

      const result = await job().run({ restoreExpired: false });

      // 没有跑那次扫描……
      expect(result.restored_count).toBe(0);
      // ……但候选照样被处理掉了：claim 的 expire_then_claim 自己会回收过期的持有。
      // 关掉恢复不等于这条候选永远卡住，只是少了一次「跑之前先把它们捞回来」的动作。
      expect(result.outcomes.map((item) => item.experience_id)).toEqual([experiences[0]?.id]);
      expect(result.outcomes[0]?.attempt_count).toBe(2);
      expect(result.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });
      expect(await repository.listSkills(role_id)).toHaveLength(1);
    });

    it('两个 worker 并发跑同一批：没有重复 Skill，也没有两条经验绑到同一个 Skill', async () => {
      const experiences = await seedExperiences(repository, role_id, 2);

      const [left, right] = await Promise.all([
        job({ worker_id: 'worker-left' }).run({ batchSize: 10 }),
        job({ worker_id: 'worker-right' }).run({ batchSize: 10 }),
      ]);

      const processed = [...left.outcomes, ...right.outcomes].map((item) => item.experience_id);
      // 同一条候选没有被两个 worker 各处理一次
      expect(new Set(processed).size).toBe(processed.length);
      expect(new Set(processed)).toEqual(new Set(experiences.map((item) => item.id)));
      expect(left.counts.claimed_count + right.counts.claimed_count).toBe(2);
      expect(left.counts.retried_count + right.counts.retried_count).toBe(0);

      const skills = await repository.listSkills(role_id);
      expect(skills).toHaveLength(2);
      const bound = (await repository.listExperiences(role_id)).map((item) => item.promoted_to);
      expect(bound.every((id) => id !== undefined)).toBe(true);
      expect(new Set(bound).size).toBe(2);
    });

    it('dry run：不 claim、不写 Skill、不改状态，结论只作为投影留在 outcomes 里', async () => {
      const experiences = await seedExperiences(repository, role_id, 2);
      const unqualified = makeExperience(role_id, {
        confidence: 0.5,
        created_at: addMilliseconds(START, 60_000),
      });
      await repository.saveExperience(role_id, unqualified);
      const before = await repository.listExperiences(role_id);

      const result = await job().run({ dryRun: true, batchSize: 5 });

      expect(result.dry_run).toBe(true);
      expect(result.stop_reason).toBe('no_work');
      // 一条都没 claim、一个终局都没有：run 上不该留下数字
      expect(result.counts).toMatchObject({ claimed_count: 0, ...NO_FAILURES, completed_count: 0 });
      expect(result.outcomes.map((item) => item.experience_id)).toEqual([
        ...experiences.map((item) => item.id),
        unqualified.id,
      ]);
      // 投影：合格的在自动批准下会晋升，不合格的会被拒
      expect(result.outcomes.map((item) => item.status)).toEqual([
        'promoted',
        'promoted',
        'rejected',
      ]);
      // 每条都标明这是一条投影
      expect(
        result.outcomes.every((item) => item.warnings.some((text) => text.startsWith('Dry run'))),
      ).toBe(true);

      // 什么都没落地：没有 Skill，经验一个字节都没变
      expect(await repository.listSkills(role_id)).toHaveLength(0);
      expect(await repository.listExperiences(role_id)).toEqual(before);

      // 真跑一次照常晋升——演练没有把候选消耗掉，也没有改判据
      const real = await job().run({ batchSize: 5 });
      expect(real.counts).toMatchObject({ claimed_count: 3, completed_count: 3 });
      expect(await repository.listSkills(role_id)).toHaveLength(2);
    });

    it('dry run 连启动恢复都不做（恢复是一次写）', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      await strandClaim(experiences[0]!.id);
      clock.advance(DEFAULT_DELIVERY_LEASE_MS);

      const result = await job().run({ dryRun: true, restoreExpired: true });

      expect(result.restored_count).toBe(0);
      // 过期的持有本来会被真跑一次捞回来：演练之后它还在原地，说明演练没写任何东西
      const stored = await storedExperience(experiences[0]!.id);
      expect(stored?.promotion?.status).toBe('processing');
      expect(stored?.promotion?.claim_owner).toBe('worker-crashed');
    });

    it('声明的策略版本与注入的不一致：拒绝启动，且不留下一条 run', async () => {
      await seedExperiences(repository, role_id, 1);
      const runsBefore = await runStore.list({ job_type: 'skill_promotion' });

      await expect(job().run({ strategy_version: 'promotion-threshold.v99' })).rejects.toThrow(
        /strategy version/,
      );
      // 拒绝发生在开 run 之前：审计里不会出现一条「配置是 v2、按 v1 判」的记录
      expect(await runStore.list({ job_type: 'skill_promotion' })).toHaveLength(runsBefore.length);
      expect(await repository.listSkills(role_id)).toHaveLength(0);

      const result = await job().run({ strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION });
      expect(result.strategy_version).toBe(DEFAULT_PROMOTION_STRATEGY_VERSION);
      expect(result.counts.completed_count).toBe(1);
    });

    it('非法策略返回的判定：不写 Skill、不回写经验、判成不可重试并进死信，错误里带着两个版本', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      const experience = experiences[0]!;
      const claimed = await repository.claimNextPromotionCandidate({
        role_id,
        owner: 'worker-1',
        now: clock.now(),
        lease_ms: DEFAULT_DELIVERY_LEASE_MS,
        strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
        approval: 'auto_approve',
      });
      expect(claimed?.experience.id).toBe(experience.id);
      // claim 之后、判定之前的这一份快照，就是「本次执行一个字节都不该改」的基准
      const before = await storedExperience(experience.id);

      const lying = tamperingStrategy(autoApprove, (decision) => ({
        ...decision,
        strategy_version: 'promotion-threshold.v9',
      }));

      const result = await executePromotionCandidate(
        { repository, strategy: lying, now: clock.now },
        claimed!,
        { approval: 'auto_approve', now: clock.now() },
      );

      expect(result.status).toBe('dead_letter');
      expect(result.failure).toMatchObject({ code: 'payload_unreadable', retryable: false });
      // 错误信息必须能回答「该是哪个版本、实际是哪个版本」
      const reported = result.failure!.message;
      expect(reported).toContain(DEFAULT_PROMOTION_STRATEGY_VERSION);
      expect(reported).toContain('promotion-threshold.v9');
      // 审计同样看得到那条错结论自报的版本（执行器把它留在结果里，人不必去猜）
      expect(result.decision?.strategy_version).toBe('promotion-threshold.v9');

      const stored = await storedExperience(experience.id);
      expect(stored?.promotion?.status).toBe('dead_letter');
      expect(stored?.promotion?.outcome).toBeUndefined();
      expect(stored?.promotion?.strategy_version).toBeUndefined();
      expect(stored?.promoted_to).toBeUndefined();
      expect(stored?.promotion?.next_retry_at).toBeUndefined();
      expect(stored?.promotion?.last_error).toContain('promotion-threshold.v9');
      expect(stored?.promotion?.attempt_count).toBe(before?.promotion?.attempt_count);
      // 没有晋升写入：没有 Skill、经验除晋升标记外与基准一致
      expect(await repository.listSkills(role_id)).toHaveLength(0);
      expect(await repository.listExperiences(role_id)).toEqual([stored]);
    });

    it('策略返回的判定版本与 run 不符：run 记录的仍是注入策略的版本', async () => {
      await seedExperiences(repository, role_id, 1);
      const lying = tamperingStrategy(autoApprove, (decision) => ({
        ...decision,
        strategy_version: 'promotion-threshold.v9',
      }));

      const result = await job({ strategy: lying }).run({ batchSize: 5 });

      // 运行的版本来自注入的策略，与判定自报的那一个无关
      expect(result.strategy_version).toBe(DEFAULT_PROMOTION_STRATEGY_VERSION);
      expect(result.outcomes[0]?.status).toBe('dead_letter');
      expect(result.outcomes[0]?.decision?.strategy_version).toBe('promotion-threshold.v9');
      expect(result.counts).toMatchObject({ claimed_count: 1, dead_letter_count: 1 });
      expect(await repository.listSkills(role_id)).toHaveLength(0);
    });

    it('策略返回别的经验 id：不写任何东西，错误里带着两个经验 id', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      const experience = experiences[0]!;
      const other_id = randomUUID();
      const lying = tamperingStrategy(autoApprove, (decision) => ({
        ...decision,
        experience_id: other_id,
      }));

      const result = await job({ strategy: lying }).run({ batchSize: 5 });

      expect(result.outcomes[0]?.status).toBe('dead_letter');
      expect(result.outcomes[0]?.experience_id).toBe(experience.id);
      expect(result.outcomes[0]?.decision?.experience_id).toBe(other_id);
      const reported = result.outcomes[0]?.failure?.message ?? '';
      expect(reported).toContain(experience.id);
      expect(reported).toContain(other_id);

      const stored = await storedExperience(experience.id);
      expect(stored?.promotion?.status).toBe('dead_letter');
      expect(stored?.promoted_to).toBeUndefined();
      expect(stored?.promotion?.outcome).toBeUndefined();

      // 配置错不该被重试掩盖：它在死信里，自动路径不会再拿它去问一次策略
      const auto = await job({ strategy: lying }).run({ batchSize: 5 });
      expect(auto.counts.claimed_count).toBe(0);
      expect(auto.outcomes).toHaveLength(0);
      expect(await repository.listSkills(role_id)).toHaveLength(0);
    });

    it('人工审核的 run 碰上自称已批准的判定：不写 Skill，也不留下任何结论', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      const claimed = await repository.claimNextPromotionCandidate({
        role_id,
        owner: 'worker-1',
        now: clock.now(),
        lease_ms: DEFAULT_DELIVERY_LEASE_MS,
        strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
        approval: 'manual_review',
      });
      expect(claimed).toBeDefined();
      // 声明自动批准的注入策略：它会给出 eligible，而这次运行明明是人工审核
      const eager = claimingApprovalStrategy(autoApprove, 'auto_approve');

      const result = await executePromotionCandidate(
        { repository, strategy: eager, now: clock.now },
        claimed!,
        { approval: 'manual_review', now: clock.now() },
      );

      expect(result.status).toBe('dead_letter');
      expect(result.failure?.retryable).toBe(false);
      // 错误信息要指出对不上的是审核模式，以及该是哪一个、实际是哪一个
      expect(result.failure?.message).toContain('approval');
      expect(result.failure?.message).toContain('manual_review');
      expect(result.decision?.approval).toBe('auto_approve');
      // 人工审核模式下不得写出 Skill，也不得把这条经验判成任何一种结论
      expect(await repository.listSkills(role_id)).toHaveLength(0);
      const stored = await storedExperience(experiences[0]!.id);
      expect(stored?.promotion?.outcome).toBeUndefined();
      expect(stored?.promoted_to).toBeUndefined();
      expect(stored?.promotion?.status).toBe('dead_letter');
    });

    it('自动批准模式的 run 碰上自称只做人工审核的判定：不把合格候选冻结成 pending_review', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      const claimed = await repository.claimNextPromotionCandidate({
        role_id,
        owner: 'worker-1',
        now: clock.now(),
        lease_ms: DEFAULT_DELIVERY_LEASE_MS,
        strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
        approval: 'auto_approve',
      });
      expect(claimed).toBeDefined();
      const timid = claimingApprovalStrategy(autoApprove, 'manual_review');

      const result = await executePromotionCandidate(
        { repository, strategy: timid, now: clock.now },
        claimed!,
        { approval: 'auto_approve', now: clock.now() },
      );

      expect(result.status).toBe('dead_letter');
      expect(result.failure?.message).toContain('approval');
      expect(result.failure?.message).toContain('auto_approve');
      expect(result.decision?.approval).toBe('manual_review');
      // 合格候选不该被记成待审核——那是另一个结论，人也不能靠它把它放行
      expect(await repository.listSkills(role_id)).toHaveLength(0);
      const stored = await storedExperience(experiences[0]!.id);
      expect(stored?.promotion?.outcome).toBeUndefined();
      expect(stored?.promoted_to).toBeUndefined();
      expect(stored?.promotion?.status).toBe('dead_letter');
    });

    it('判定的结论与审核模式配不上对（eligible + manual_review）：不写 Skill、不写成功结论，进死信', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      const experience = experiences[0]!;
      // 底稿取真结论：人工审核模式下真策略给的是 pending_review，这里只把结论改成 eligible。
      // 「本次运行只被授权记录」这一点没变，变的只有策略自称的那个结论——因此若校验漏了这一格，
      // 执行内核会照 eligible 走晋升分支，在一次无权写 Skill 的运行里把它写出来。
      const lying = illegalDecisionStrategy(autoApprove, (decision) => ({
        ...decision,
        verdict: 'eligible',
      }));

      const result = await job({ strategy: lying }).run({ batchSize: 5, approval: 'manual_review' });

      expect(result.approval).toBe('manual_review');
      expect(result.outcomes[0]?.status).toBe('dead_letter');
      expect(result.outcomes[0]?.failure).toMatchObject({
        code: 'payload_unreadable',
        retryable: false,
      });
      // 判定本身留在审计里：人要看的是策略到底交回了哪一对
      expect(result.outcomes[0]?.decision?.verdict).toBe('eligible');
      expect(result.outcomes[0]?.decision?.approval).toBe('manual_review');
      const reported = result.outcomes[0]?.failure?.message ?? '';
      expect(reported).toContain('verdict_approval');
      expect(reported).toContain('eligible');
      expect(reported).toContain('manual_review');
      // 这一条是死信：既不是完成，也不是重投
      expect(result.counts).toMatchObject({
        claimed_count: 1,
        dead_letter_count: 1,
        completed_count: 0,
        retried_count: 0,
        failure_count: 0,
      });

      // 没有 Skill，也没有任何一种成功结论落到经验上
      expect(await repository.listSkills(role_id)).toHaveLength(0);
      const stored = await storedExperience(experience.id);
      expect(promotionStateLabel(stored!)).toBe('dead_letter');
      expect(stored?.promotion?.outcome).toBeUndefined();
      expect(stored?.promotion?.strategy_version).toBeUndefined();
      expect(stored?.promotion?.skill_id).toBeUndefined();
      expect(stored?.promotion?.next_retry_at).toBeUndefined();
      expect(stored?.promoted_to).toBeUndefined();
      expect(stored?.promotion?.attempt_count).toBe(1);

      // 死信只由人工放回：后续自动运行不会再 claim 它（也就不会反复问同一份错判定）
      const again = await job({ strategy: lying }).run({ batchSize: 5, approval: 'manual_review' });
      expect(again.counts.claimed_count).toBe(0);
      expect(again.outcomes).toHaveLength(0);
      expect(await repository.listSkills(role_id)).toHaveLength(0);
    });

    it('判定的结论与审核模式配不上对（pending_review + auto_approve）：不把合格候选冻结成待审核，进死信', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      // 底稿是真结论（自动批准模式下合格 → eligible），只把结论改成 pending_review：若不拦，
      // 一个本该自动晋升的候选会被记成等人工放行，而这条运行里已经没有任何东西会再放行它
      const lying = illegalDecisionStrategy(autoApprove, (decision) => ({
        ...decision,
        verdict: 'pending_review',
      }));

      const result = await job({ strategy: lying }).run({ batchSize: 5 });

      expect(result.approval).toBe('auto_approve');
      expect(result.outcomes[0]?.status).toBe('dead_letter');
      expect(result.outcomes[0]?.failure).toMatchObject({
        code: 'payload_unreadable',
        retryable: false,
      });
      expect(result.outcomes[0]?.decision?.verdict).toBe('pending_review');
      expect(result.counts).toMatchObject({
        claimed_count: 1,
        dead_letter_count: 1,
        completed_count: 0,
        retried_count: 0,
      });

      expect(await repository.listSkills(role_id)).toHaveLength(0);
      const stored = await storedExperience(experiences[0]!.id);
      // 既不是待审核结论（那会把这条线冻住），也不是已晋升
      expect(stored?.promotion?.outcome).toBeUndefined();
      expect(promotionStateLabel(stored!)).toBe('dead_letter');
      expect(stored?.promoted_to).toBeUndefined();

      const again = await job({ strategy: lying }).run({ batchSize: 5 });
      expect(again.counts.claimed_count).toBe(0);
      expect(again.outcomes).toHaveLength(0);
    });

    it('同一批里配不上对的判定只影响它自己：同批的另一条照常晋升', async () => {
      const experiences = await seedExperiences(repository, role_id, 2);
      const first = experiences[0]!;
      const second = experiences[1]!;
      // 只对第一条交出配不上对的结论（pending_review 落在自动批准模式下），第二条走真结论：
      // 一条配置错不该把同批的候选一起拖下水
      const lying = illegalDecisionStrategy(autoApprove, (decision, input) =>
        input.experience.id === first.id ? { ...decision, verdict: 'pending_review' } : decision,
      );

      const result = await job({ strategy: lying }).run({ batchSize: 5 });

      expect(result.outcomes.map((item) => item.status)).toEqual(['dead_letter', 'promoted']);
      expect(result.counts).toMatchObject({
        claimed_count: 2,
        completed_count: 1,
        dead_letter_count: 1,
        retried_count: 0,
        failure_count: 0,
      });

      const rejected = await storedExperience(first.id);
      expect(promotionStateLabel(rejected!)).toBe('dead_letter');
      expect(rejected?.promoted_to).toBeUndefined();
      expect(rejected?.promotion?.outcome).toBeUndefined();

      const promoted = await storedExperience(second.id);
      expect(promoted?.promotion?.outcome).toBe('promoted');
      const skills = await repository.listSkills(role_id);
      expect(skills).toHaveLength(1);
      expect(promoted?.promoted_to).toBe(skills[0]?.id);
    });

    it('直接调执行内核：配不上对的结论照样被拦住（契约不由外壳代为执行）', async () => {
      const experiences = await seedExperiences(repository, role_id, 2);
      const cases: Array<{
        name: string;
        approval: PromotionApprovalMode;
        verdict: PromotionVerdict;
      }> = [
        { name: 'eligible + manual_review', approval: 'manual_review', verdict: 'eligible' },
        {
          name: 'pending_review + auto_approve',
          approval: 'auto_approve',
          verdict: 'pending_review',
        },
      ];

      for (const [index, testCase] of cases.entries()) {
        const experience = experiences[index]!;
        const claimed = await repository.claimNextPromotionCandidate({
          role_id,
          owner: 'worker-1',
          now: clock.now(),
          lease_ms: DEFAULT_DELIVERY_LEASE_MS,
          strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
          approval: testCase.approval,
        });
        expect(claimed?.experience.id, testCase.name).toBe(experience.id);

        const result = await executePromotionCandidate(
          {
            repository,
            strategy: illegalDecisionStrategy(autoApprove, (decision) => ({
              ...decision,
              verdict: testCase.verdict,
            })),
            now: clock.now,
          },
          claimed!,
          { approval: testCase.approval, now: clock.now() },
        );

        expect(result.status, testCase.name).toBe('dead_letter');
        expect(result.failure, testCase.name).toMatchObject({
          code: 'payload_unreadable',
          retryable: false,
        });
        expect(result.failure?.message, testCase.name).toContain('verdict_approval');
        // 审计里留着策略交回来的那一对
        expect(result.decision?.verdict, testCase.name).toBe(testCase.verdict);
        expect(result.decision?.approval, testCase.name).toBe(testCase.approval);
      }

      expect(await repository.listSkills(role_id)).toHaveLength(0);
      const stored = await repository.listExperiences(role_id);
      expect(stored.every((item) => item.promotion?.status === 'dead_letter')).toBe(true);
      expect(stored.every((item) => item.promotion?.outcome === undefined)).toBe(true);
      expect(stored.every((item) => item.promoted_to === undefined)).toBe(true);
    });

    it('dry run：配不上对的结论记成 failed，不 claim、不落盘、计数全为零', async () => {
      const cases: Array<{
        name: string;
        approval: PromotionApprovalMode;
        verdict: PromotionVerdict;
      }> = [
        { name: 'eligible + manual_review', approval: 'manual_review', verdict: 'eligible' },
        {
          name: 'pending_review + auto_approve',
          approval: 'auto_approve',
          verdict: 'pending_review',
        },
      ];

      for (const testCase of cases) {
        const caseRole = `role_promotion_pairing_dryrun_${randomUUID()}`;
        await repository.initializeAgent({ role_id: caseRole, name: 'Contract Pairing Agent' });
        await seedExperiences(repository, caseRole, 2);
        const before = await repository.listExperiences(caseRole);
        const lying = illegalDecisionStrategy(autoApprove, (decision) => ({
          ...decision,
          verdict: testCase.verdict,
        }));

        const result = await job({ strategy: lying, role_id: caseRole }).run({
          dryRun: true,
          batchSize: 5,
          approval: testCase.approval,
        });

        expect(result.dry_run, testCase.name).toBe(true);
        // 演练里非法配对是 failed：不是 promoted / pending_review / rejected 里的任何一个，
        // 也不是死信（演练不写终态）
        expect(result.outcomes.map((item) => item.status), testCase.name).toEqual([
          'failed',
          'failed',
        ]);
        for (const outcome of result.outcomes) {
          expect(outcome.failure, testCase.name).toMatchObject({
            code: 'payload_unreadable',
            retryable: false,
          });
          expect(outcome.failure?.message, testCase.name).toContain('verdict_approval');
          expect(outcome.decision?.verdict, testCase.name).toBe(testCase.verdict);
          expect(outcome.decision?.approval, testCase.name).toBe(testCase.approval);
          // 诊断信息留在 warning 里：演练的结论是给人读的投影
          const warnings = outcome.warnings.join(' ');
          expect(warnings, testCase.name).toContain('verdict_approval');
          expect(warnings, testCase.name).toContain(testCase.verdict);
          expect(warnings, testCase.name).toContain(testCase.approval);
        }
        // 计数全零：演练没有 claim、没有终局，也没有因为判定非法而多出一次失败
        expect(result.counts, testCase.name).toEqual({
          claimed_count: 0,
          completed_count: 0,
          retried_count: 0,
          dead_letter_count: 0,
          skipped_count: 0,
          failure_count: 0,
        });
        expect(await repository.listSkills(caseRole), testCase.name).toHaveLength(0);
        expect(await repository.listExperiences(caseRole), testCase.name).toEqual(before);
      }
    });

    it('四种合法配对一切照旧：结论、Skill 与经验标记都不变', async () => {
      const cases: Array<{
        name: string;
        approval: PromotionApprovalMode;
        confidence: number;
        expected: PromotionCandidateStatus;
      }> = [
        {
          name: 'eligible + auto_approve',
          approval: 'auto_approve',
          confidence: 0.99,
          expected: 'promoted',
        },
        {
          name: 'pending_review + manual_review',
          approval: 'manual_review',
          confidence: 0.99,
          expected: 'pending_review',
        },
        {
          name: 'rejected + auto_approve',
          approval: 'auto_approve',
          confidence: 0.5,
          expected: 'rejected',
        },
        {
          name: 'rejected + manual_review',
          approval: 'manual_review',
          confidence: 0.5,
          expected: 'rejected',
        },
      ];

      for (const testCase of cases) {
        const caseRole = `role_promotion_pairing_ok_${randomUUID()}`;
        await repository.initializeAgent({ role_id: caseRole, name: 'Legal Pairing Agent' });
        // 置信度决定底稿落在哪一格结论上：判定合格的两种配对与两种被拒的配对都要覆盖
        const [experience] = await seedExperiences(repository, caseRole, 1, {
          confidence: testCase.confidence,
        });

        const result = await job({ strategy: autoApprove, role_id: caseRole }).run({
          batchSize: 5,
          approval: testCase.approval,
        });

        expect(result.outcomes[0]?.status, testCase.name).toBe(testCase.expected);
        expect(result.outcomes[0]?.failure, testCase.name).toBeUndefined();
        expect(result.counts, testCase.name).toMatchObject({
          claimed_count: 1,
          completed_count: 1,
          dead_letter_count: 0,
          retried_count: 0,
          failure_count: 0,
        });

        const skills = await repository.listSkills(caseRole);
        const stored = (await repository.listExperiences(caseRole)).find(
          (item) => item.id === experience?.id,
        );
        expect(stored?.promotion?.outcome, testCase.name).toBe(testCase.expected);
        if (testCase.expected === 'promoted') {
          // 自动批准写出的技能直接就是 approved（没有第二条补批准的路）
          expect(skills, testCase.name).toHaveLength(1);
          expect(skills[0]?.review_status, testCase.name).toBe('approved');
          expect(stored?.promoted_to, testCase.name).toBe(skills[0]?.id);
        } else {
          // 只记结论：没有 Skill，也没有绑定
          expect(skills, testCase.name).toHaveLength(0);
          expect(stored?.promoted_to, testCase.name).toBeUndefined();
        }
      }
    });

    it('注入的策略自称 v9、它返回的判定却标着 v1：拒掉，且 run 记的是注入的 v9', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      // 这个替身整体按 v9 配置（run 会照它记审计），但判定却被标成 v1——经验与会因此记成
      // 两个版本，而版本正是「要不要重评」的判据
      const injected = selfDeclaredVersionStrategy(autoApprove, 'promotion-threshold.v9');
      const mislabeled = tamperingStrategy(injected, (decision) => ({
        ...decision,
        strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
      }));

      const result = await job({ strategy: mislabeled }).run({ batchSize: 5 });

      expect(result.outcomes[0]?.status).toBe('dead_letter');
      expect(result.outcomes[0]?.failure).toMatchObject({
        code: 'payload_unreadable',
        retryable: false,
      });
      // 报错说清「该是哪一个、实际是哪一个」
      const reported = result.outcomes[0]?.failure?.message ?? '';
      expect(reported).toContain('promotion-threshold.v9');
      expect(reported).toContain(DEFAULT_PROMOTION_STRATEGY_VERSION);
      expect(result.outcomes[0]?.decision?.strategy_version).toBe(
        DEFAULT_PROMOTION_STRATEGY_VERSION,
      );
      // run 上记的版本来自注入的策略（v9），不是判定自报的那一个
      expect(result.strategy_version).toBe('promotion-threshold.v9');

      const stored = await storedExperience(experiences[0]!.id);
      expect(stored?.promotion?.status).toBe('dead_letter');
      expect(stored?.promotion?.outcome).toBeUndefined();
      expect(stored?.promotion?.strategy_version).toBeUndefined();
      expect(await repository.listSkills(role_id)).toHaveLength(0);
    });

    it('dry run 撞上不自洽的判定：记成 failed，但不写 Skill、不改经验、run 计数仍为零写入', async () => {
      await seedExperiences(repository, role_id, 1);
      // 判据取**读回来**的那一份（Pg 侧写入时会按 description 重算向量），这样「经验没变」
      // 比的是两次读口之间有没有差别，而不是「种子数据有没有被规范化」
      const before = await repository.listExperiences(role_id);
      const lying = tamperingStrategy(autoApprove, (decision) => ({
        ...decision,
        strategy_version: 'promotion-threshold.v9',
      }));

      const result = await job({ strategy: lying }).run({ dryRun: true, batchSize: 5 });

      expect(result.dry_run).toBe(true);
      expect(result.counts).toMatchObject({ claimed_count: 0, ...NO_FAILURES, completed_count: 0 });
      // 不自洽的判定不得伪装成任何一种结论
      expect(result.outcomes[0]?.status).toBe('failed');
      expect(result.outcomes[0]?.failure).toMatchObject({
        code: 'payload_unreadable',
        retryable: false,
      });
      expect(result.outcomes[0]?.failure?.message).toContain('promotion-threshold.v9');
      expect(result.outcomes[0]?.decision?.strategy_version).toBe('promotion-threshold.v9');
      expect(
        result.outcomes[0]?.warnings.some((text) => text.startsWith('Dry run')),
      ).toBe(true);

      // 演练什么都没写：没有 Skill，经验与跑之前一模一样
      expect(await repository.listSkills(role_id)).toHaveLength(0);
      expect(await repository.listExperiences(role_id)).toEqual(before);
    });

    it('dry run 下三类不自洽都记成 failed，且一个字节都不落盘', async () => {
      await seedExperiences(repository, role_id, 1);
      const before = await repository.listExperiences(role_id);
      const other_id = randomUUID();
      const cases: Array<{ name: string; strategy: PromotionStrategy; needle: string }> = [
        {
          name: '版本',
          strategy: tamperingStrategy(autoApprove, (decision) => ({
            ...decision,
            strategy_version: 'promotion-threshold.v9',
          })),
          needle: 'promotion-threshold.v9',
        },
        {
          name: '经验 id',
          strategy: tamperingStrategy(autoApprove, (decision) => ({
            ...decision,
            experience_id: other_id,
          })),
          needle: other_id,
        },
        {
          name: '审核模式',
          strategy: tamperingStrategy(autoApprove, (decision) => ({
            ...decision,
            approval: 'manual_review',
          })),
          needle: 'manual_review',
        },
      ];

      for (const testCase of cases) {
        const result = await job({ strategy: testCase.strategy }).run({ dryRun: true, batchSize: 5 });

        expect(result.outcomes[0]?.status, testCase.name).toBe('failed');
        expect(result.outcomes[0]?.failure?.message, testCase.name).toContain(testCase.needle);
        expect(result.counts, testCase.name).toMatchObject({
          claimed_count: 0,
          ...NO_FAILURES,
          completed_count: 0,
        });
        expect(await repository.listSkills(role_id), testCase.name).toHaveLength(0);
        expect(await repository.listExperiences(role_id), testCase.name).toEqual(before);
      }
    });

    it('拼错的 verdict：进死信，不会被当成一条 rejected 结论写下去', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      // 底稿是真结论（合格），只把 verdict 换成一个不存在的值——这正是「实现错误会伪装成
      // 正常拒绝」的形状：它既不是 eligible 也不是 pending_review，若不拦就会被当成第三种
      const lying = illegalDecisionStrategy(autoApprove, (decision) => ({
        ...decision,
        verdict: 'typo',
      }));

      const result = await job({ strategy: lying }).run({ batchSize: 5 });

      expect(result.outcomes[0]?.status).toBe('dead_letter');
      expect(result.outcomes[0]?.failure).toMatchObject({
        code: 'payload_unreadable',
        retryable: false,
      });
      // 错误要能回答「哪个字段、该是什么、实际是什么」，而不是一句泛泛的对不上
      expect(result.outcomes[0]?.failure?.message).toContain('verdict');
      expect(result.outcomes[0]?.failure?.message).toContain('typo');
      // 判定本身留在审计里（人要看的是策略到底返回了什么）；类型里没有 'typo' 这个值，
      // 这里读的正是被伪造出来的那一个
      expect(result.outcomes[0]?.decision?.verdict as string | undefined).toBe('typo');
      // 不写 Skill、不写任何成功结论、也不进重试
      expect(result.counts).toMatchObject({
        claimed_count: 1,
        dead_letter_count: 1,
        completed_count: 0,
        retried_count: 0,
        failure_count: 0,
      });
      expect(await repository.listSkills(role_id)).toHaveLength(0);
      const stored = await storedExperience(experiences[0]!.id);
      expect(promotionStateLabel(stored!)).toBe('dead_letter');
      expect(stored?.promoted_to).toBeUndefined();
      expect(stored?.promotion?.outcome).toBeUndefined();
      expect(stored?.promotion?.strategy_version).toBeUndefined();
      expect(stored?.promotion?.next_retry_at).toBeUndefined();

      // 死信只由人工放回：同一份非法判定不会被自动路径反复问一遍
      const again = await job({ strategy: lying }).run({ batchSize: 5 });
      expect(again.counts.claimed_count).toBe(0);
      expect(again.outcomes).toHaveLength(0);
    });

    it('判定结构非法：每一种形状都进死信，不写 Skill、不写成功结论', async () => {
      const cases: Array<{ name: string; corrupt: (decision: PromotionDecision) => unknown }> = [
        { name: 'decision 是 null', corrupt: () => null },
        { name: 'decision 是标量', corrupt: () => 'eligible' },
        { name: 'verdict 缺失', corrupt: (decision) => without(decision, 'verdict') },
        { name: 'verdict 不是字符串', corrupt: (decision) => ({ ...decision, verdict: 1 }) },
        {
          name: 'strategy_version 为空串',
          corrupt: (decision) => ({ ...decision, strategy_version: '' }),
        },
        {
          name: 'strategy_version 不是字符串',
          corrupt: (decision) => ({ ...decision, strategy_version: 7 }),
        },
        { name: 'experience_id 为空串', corrupt: (decision) => ({ ...decision, experience_id: '' }) },
        {
          name: 'experience_id 不是字符串',
          corrupt: (decision) => ({ ...decision, experience_id: null }),
        },
        { name: 'approval 不是合法模式', corrupt: (decision) => ({ ...decision, approval: 'yolo' }) },
        {
          name: 'reasons 不是数组',
          corrupt: (decision) => ({ ...decision, reasons: 'Candidate qualifies.' }),
        },
        { name: 'reasons 元素不是字符串', corrupt: (decision) => ({ ...decision, reasons: [1] }) },
        {
          name: 'blocking_rules 不是数组',
          corrupt: (decision) => ({ ...decision, blocking_rules: 'already_promoted' }),
        },
        {
          name: 'blocking_rules 元素不是字符串',
          corrupt: (decision) => ({ ...decision, blocking_rules: [null] }),
        },
      ];

      for (const testCase of cases) {
        // 每种形状换一条新的候选：上一轮的候选已经进了死信，不该被同一批用例复用
        const caseRole = `role_promotion_contract_${randomUUID()}`;
        await repository.initializeAgent({ role_id: caseRole, name: 'Contract Case Agent' });
        const [experience] = await seedExperiences(repository, caseRole, 1);
        const lying = illegalDecisionStrategy(autoApprove, testCase.corrupt);

        const result = await job({ strategy: lying, role_id: caseRole }).run({ batchSize: 5 });

        expect(result.outcomes[0]?.status, testCase.name).toBe('dead_letter');
        expect(result.outcomes[0]?.failure, testCase.name).toMatchObject({
          code: 'payload_unreadable',
          retryable: false,
        });
        expect(await repository.listSkills(caseRole), testCase.name).toHaveLength(0);
        const stored = (await repository.listExperiences(caseRole)).find(
          (item) => item.id === experience?.id,
        );
        expect(stored?.promotion?.status, testCase.name).toBe('dead_letter');
        expect(stored?.promoted_to, testCase.name).toBeUndefined();
        expect(stored?.promotion?.outcome, testCase.name).toBeUndefined();
        expect(stored?.promotion?.strategy_version, testCase.name).toBeUndefined();
      }
    });

    it('自造的挡板规则名：契约错、进死信，不会当成一条正常的拒绝结论', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      const lying = illegalDecisionStrategy(autoApprove, (decision) => ({
        ...decision,
        verdict: 'rejected',
        blocking_rules: ['looks_suspicious'],
        reasons: ['the strategy does not like it'],
      }));

      const result = await job({ strategy: lying }).run({ batchSize: 5 });

      expect(result.outcomes[0]?.status).toBe('dead_letter');
      expect(result.outcomes[0]?.failure).toMatchObject({
        code: 'payload_unreadable',
        retryable: false,
      });
      // 名字要出现在消息里：排查时要知道是哪一个自造值被拒了
      expect(result.outcomes[0]?.failure?.message).toContain('blocking_rules');
      expect(result.outcomes[0]?.failure?.message).toContain('looks_suspicious');

      expect(await repository.listSkills(role_id)).toHaveLength(0);
      const stored = await storedExperience(experiences[0]!.id);
      expect(stored?.promotion?.status).toBe('dead_letter');
      expect(stored?.promotion?.outcome).toBeUndefined();
      expect(stored?.promoted_to).toBeUndefined();
    });

    it('结论组合不合法：rejected 缺挡板/缺理由、合格却带挡板，一律进死信', async () => {
      const cases: Array<{
        name: string;
        confidence: number;
        approval: PromotionApprovalMode;
        corrupt: (decision: PromotionDecision) => unknown;
      }> = [
        {
          name: 'rejected 却没有挡板规则',
          confidence: 0.5,
          approval: 'auto_approve',
          corrupt: (decision) => ({ ...decision, blocking_rules: [] }),
        },
        {
          name: 'rejected 却没有理由',
          confidence: 0.5,
          approval: 'auto_approve',
          corrupt: (decision) => ({ ...decision, reasons: [] }),
        },
        {
          name: 'eligible 却带着挡板规则',
          confidence: 0.99,
          approval: 'auto_approve',
          corrupt: (decision) => ({
            ...decision,
            blocking_rules: ['below_confidence_threshold'],
          }),
        },
        {
          name: 'pending_review 却带着挡板规则',
          confidence: 0.99,
          approval: 'manual_review',
          corrupt: (decision) => ({
            ...decision,
            blocking_rules: ['below_confidence_threshold'],
          }),
        },
      ];

      for (const testCase of cases) {
        const caseRole = `role_promotion_combo_${randomUUID()}`;
        await repository.initializeAgent({ role_id: caseRole, name: 'Contract Combo Agent' });
        // 底稿必须真的落在那一格结论上（置信度决定真策略给的是 rejected 还是合格），
        // 这样「被注入的差异只有组合」才是唯一能解释失败的原因
        const [experience] = await seedExperiences(repository, caseRole, 1, {
          confidence: testCase.confidence,
        });
        const lying = illegalDecisionStrategy(autoApprove, testCase.corrupt);

        const result = await job({ strategy: lying, role_id: caseRole }).run({
          batchSize: 5,
          approval: testCase.approval,
        });

        expect(result.outcomes[0]?.status, testCase.name).toBe('dead_letter');
        expect(result.outcomes[0]?.failure?.message, testCase.name).toContain('verdict_combination');
        expect(await repository.listSkills(caseRole), testCase.name).toHaveLength(0);
        const stored = (await repository.listExperiences(caseRole)).find(
          (item) => item.id === experience?.id,
        );
        expect(stored?.promotion?.status, testCase.name).toBe('dead_letter');
        expect(stored?.promotion?.outcome, testCase.name).toBeUndefined();
      }
    });

    it('直接调执行内核：同一份非法判定照样被拦住（契约不由外壳代为执行）', async () => {
      const experiences = await seedExperiences(repository, role_id, 3);
      const cases: Array<{ name: string; corrupt: (decision: PromotionDecision) => unknown }> = [
        { name: '拼错的 verdict', corrupt: (decision) => ({ ...decision, verdict: 'typo' }) },
        { name: '不是对象的判定', corrupt: () => null },
        {
          name: '自造的挡板规则名',
          corrupt: (decision) => ({
            ...decision,
            verdict: 'rejected',
            blocking_rules: ['looks_suspicious'],
            reasons: ['the strategy does not like it'],
          }),
        },
      ];

      for (const [index, testCase] of cases.entries()) {
        const experience = experiences[index]!;
        const claimed = await repository.claimNextPromotionCandidate({
          role_id,
          owner: 'worker-1',
          now: clock.now(),
          lease_ms: DEFAULT_DELIVERY_LEASE_MS,
          strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
          approval: 'auto_approve',
        });
        expect(claimed?.experience.id, testCase.name).toBe(experience.id);

        const result = await executePromotionCandidate(
          {
            repository,
            strategy: illegalDecisionStrategy(autoApprove, testCase.corrupt),
            now: clock.now,
          },
          claimed!,
          { approval: 'auto_approve', now: clock.now() },
        );

        expect(result.status, testCase.name).toBe('dead_letter');
        expect(result.failure, testCase.name).toMatchObject({
          code: 'payload_unreadable',
          retryable: false,
        });
      }

      expect(await repository.listSkills(role_id)).toHaveLength(0);
      const stored = await repository.listExperiences(role_id);
      expect(stored.every((item) => item.promotion?.status === 'dead_letter')).toBe(true);
      expect(stored.every((item) => item.promoted_to === undefined)).toBe(true);
    });

    it('dry run：非法判定记成 failed，一个字节都不落盘，计数全为零', async () => {
      const cases: Array<{
        name: string;
        corrupt: (decision: PromotionDecision) => unknown;
        needle: string;
      }> = [
        {
          name: '拼错的 verdict',
          corrupt: (decision) => ({ ...decision, verdict: 'typo' }),
          needle: 'typo',
        },
        {
          name: 'reasons 不是数组',
          corrupt: (decision) => ({ ...decision, reasons: 'Candidate qualifies.' }),
          needle: 'reasons',
        },
        {
          name: '自造的挡板规则名',
          corrupt: (decision) => ({
            ...decision,
            verdict: 'rejected',
            blocking_rules: ['looks_suspicious'],
            reasons: ['the strategy does not like it'],
          }),
          needle: 'looks_suspicious',
        },
      ];

      for (const testCase of cases) {
        const caseRole = `role_promotion_dryrun_${randomUUID()}`;
        await repository.initializeAgent({ role_id: caseRole, name: 'Contract Dry Run Agent' });
        await seedExperiences(repository, caseRole, 2);
        const before = await repository.listExperiences(caseRole);
        const lying = illegalDecisionStrategy(autoApprove, testCase.corrupt);

        const result = await job({ strategy: lying, role_id: caseRole }).run({
          dryRun: true,
          batchSize: 5,
        });

        expect(result.dry_run, testCase.name).toBe(true);
        // 演练里非法判定是 failed：不是任何一种结论，也不是死信（演练不写终态）
        expect(
          result.outcomes.map((item) => item.status),
          testCase.name,
        ).toEqual(['failed', 'failed']);
        for (const outcome of result.outcomes) {
          expect(outcome.failure, testCase.name).toMatchObject({
            code: 'payload_unreadable',
            retryable: false,
          });
          expect(outcome.failure?.message, testCase.name).toContain(testCase.needle);
          // 诊断信息留在 warning 里：演练的结论是给人读的投影
          expect(
            outcome.warnings.some((text) => text.startsWith('Dry run')),
            testCase.name,
          ).toBe(true);
          expect(
            outcome.warnings.some((text) => text.includes(testCase.needle)),
            testCase.name,
          ).toBe(true);
        }
        // 计数全零：演练没有 claim、没有终局，也没有因为判定非法而多出一次失败
        expect(result.counts, testCase.name).toEqual({
          claimed_count: 0,
          completed_count: 0,
          retried_count: 0,
          dead_letter_count: 0,
          skipped_count: 0,
          failure_count: 0,
        });
        expect(await repository.listSkills(caseRole), testCase.name).toHaveLength(0);
        expect(await repository.listExperiences(caseRole), testCase.name).toEqual(before);
      }
    });

    it('合法策略的判定一切照旧：演练的投影与真跑的结果都不变', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      const unqualified = makeExperience(role_id, {
        confidence: 0.5,
        created_at: addMilliseconds(START, 60_000),
      });
      await repository.saveExperience(role_id, unqualified);

      const projection = await job().run({ dryRun: true, batchSize: 5 });
      expect(projection.outcomes.map((item) => item.failure)).toEqual([undefined, undefined]);
      expect(projection.outcomes.map((item) => item.status)).toEqual(['promoted', 'rejected']);
      expect(await repository.listSkills(role_id)).toHaveLength(0);

      const real = await job().run({ batchSize: 5 });
      expect(real.outcomes.map((item) => item.status)).toEqual(['promoted', 'rejected']);
      expect(await repository.listSkills(role_id)).toHaveLength(1);
      const promoted = await storedExperience(experiences[0]!.id);
      expect(promoted?.promotion?.strategy_version).toBe(DEFAULT_PROMOTION_STRATEGY_VERSION);
      expect(promoted?.promotion?.outcome).toBe('promoted');
    });

    it('不可重试的契约错不会被重试掩盖：跨过退避窗口之后依然是死信', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      const lying = tamperingStrategy(autoApprove, (decision) => ({
        ...decision,
        strategy_version: 'promotion-threshold.v9',
      }));

      const first = await job({ strategy: lying }).run({ batchSize: 5 });
      expect(first.outcomes[0]?.status).toBe('dead_letter');

      // 跨过重试预算的整个区间：死信不是「等一会儿再来」，重投不会改变一份错判定的内容
      clock.advance(DEFAULT_PROMOTION_RETRY_POLICY.max_delay_ms);
      const second = await job({ strategy: lying }).run({ batchSize: 5 });

      expect(second.counts.claimed_count).toBe(0);
      expect(second.outcomes).toHaveLength(0);
      const stored = await storedExperience(experiences[0]!.id);
      expect(promotionStateLabel(stored!)).toBe('dead_letter');
      expect(stored?.promotion?.attempt_count).toBe(1);
      expect(await repository.listSkills(role_id)).toHaveLength(0);
    });

    it('契约错在错误对象上带稳定标识，聚合与排查都不必读消息文本', async () => {
      const experiences = await seedExperiences(repository, role_id, 1);
      const experience = experiences[0]!;

      // 对外能拿到的只有规范化失败（分类不保留原始错误对象），所以错误对象本身的形状由这一条
      // 直接钉住：按稳定 code 判别的调用方（跨进程、跨包装层）不必去匹配消息文本。
      let thrown: unknown;
      try {
        assertPromotionDecisionConsistent(
          {
            verdict: 'eligible',
            strategy_version: 'promotion-threshold.v9',
            approval: 'auto_approve',
            reasons: ['Candidate qualifies.'],
            blocking_rules: [],
            experience_id: experience.id,
          },
          {
            experience_id: experience.id,
            approval: 'auto_approve',
            strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
          },
        );
      } catch (error) {
        thrown = error;
      }
      expect(isPromotionDecisionContractError(thrown)).toBe(true);
      expect((thrown as { contract_code?: string }).contract_code).toBe(
        PROMOTION_DECISION_CONTRACT_CODE,
      );
      expect((thrown as { violation?: string }).violation).toBe('strategy_version');
      expect((thrown as { expected?: string }).expected).toBe(DEFAULT_PROMOTION_STRATEGY_VERSION);
      expect((thrown as { actual?: string }).actual).toBe('promotion-threshold.v9');
    });

    it('非法的批量上限被拒绝启动', async () => {
      await expect(job().run({ batchSize: -1 })).rejects.toThrow(/batchSize/);
      await expect(job().run({ maxDurationMs: Number.NaN })).rejects.toThrow(/maxDurationMs/);
    });

    it('外壳自己失败（claim 读不动存储）：run 记 failed，已处理的部分照常留痕', async () => {
      await seedExperiences(repository, role_id, 2);
      let claims = 0;
      const failing = createFailOnClaimRepository(repository, () => {
        claims += 1;
        return claims > 1;
      });

      const result = await job({ repository: failing }).run({ batchSize: 5 });

      expect(result.stop_reason).toBe('worker_error');
      expect(result.worker_failure).toMatchObject({ code: 'downstream_unavailable' });
      expect(result.run.status).toBe('failed');
      expect(result.run.last_error).toContain('downstream_unavailable');
      // 第一条照常处理完了：一条晋升 + 一次外壳失败
      expect(result.counts).toMatchObject({ claimed_count: 1, completed_count: 1, failure_count: 1 });
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0]?.status).toBe('promoted');
      // 第一条的落库结果不受影响，另一条原样排队
      expect(await repository.listSkills(role_id)).toHaveLength(1);
      const stored = await repository.listExperiences(role_id);
      expect(stored.filter((item) => item.promotion === undefined)).toHaveLength(1);
    });
  });
}

runSkillPromotionJobSuite({
  name: 'InMemoryRepository + InMemoryMaintenanceRunStore',
  create: async () => ({
    repository: new InMemoryRepository(),
    runStore: new InMemoryMaintenanceRunStore(),
  }),
});

describe('skill promotion job — PgMemoryRepository (PGlite) + FileMaintenanceRunStore', () => {
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

  runSkillPromotionJobSuite({
    name: 'PgMemoryRepository (PGlite)',
    create: async () => ({
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
describe('skill promotion job — 数据库上的 run 与重启', () => {
  const embedding = new HashEmbeddingProvider();
  let pool: SqlPool;

  beforeAll(async () => {
    pool = await pgMemoryPool();
    await ensurePgMemorySchema(pool, embedding.dimensions);
  });

  afterEach(async () => {
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

  function pgJob(repository: MemoryRepository, role_id: string, now: () => string) {
    return new DefaultSkillPromotionJob({
      repository,
      runStore: new FileMaintenanceRunStore({ root: runStoreRoot() }),
      strategy: new DefaultPromotionStrategy({ approval: 'auto_approve' }),
      worker_id: 'worker-db',
      role_id,
      now,
    });
  }

  it('run 记录落在数据库上，重启之后照样查得到', async () => {
    const repository = pgRepository();
    const role_id = `role_promotion_job_db_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'Promotion Job DB Agent' });
    await seedExperiences(repository, role_id, 1);

    const result = await pgJob(repository, role_id, () => START).run({ batchSize: 5 });

    // 换一个进程（新的 store 实例）读同一份库
    const revived = await new FileMaintenanceRunStore({ root: runStoreRoot() }).get(result.run.run_id);
    expect(revived).toMatchObject({
      job_type: 'skill_promotion',
      status: 'completed',
      worker_id: 'worker-db',
      claimed_count: 1,
      completed_count: 1,
    });
  });

  it('重启：新实例接着处理上一个进程没跑完的那一批', async () => {
    const repository = pgRepository();
    const role_id = `role_promotion_job_restart_${randomUUID()}`;
    await repository.initializeAgent({ role_id, name: 'Promotion Job Restart Agent' });
    const experiences = await seedExperiences(repository, role_id, 2);

    const first = await pgJob(repository, role_id, () => START).run({ batchSize: 1 });
    expect(first.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });

    // 新实例、同一份库：先把过期租约恢复一遍（这一次没有过期的），再把剩下的处理掉
    const second = await pgJob(pgRepository(), role_id, () => START).run({ batchSize: 5 });
    expect(second.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });
    expect(second.outcomes[0]?.experience_id).toBe(experiences[1]?.id);
    expect(await repository.listSkills(role_id)).toHaveLength(2);
  });
});
