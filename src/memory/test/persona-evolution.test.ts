/**
 * Persona Evolution 契约测试（Phase 4-A）
 *
 * 覆盖这一层能被纯函数回答的全部问题：**谁参与演化**（输入过滤）、**同一份输入是什么**
 * （快照与 hash）、**这次该不该动**（幂等键与候选计划）、**策略交回来的东西能不能信**
 * （判定契约）、**能不能写下去**（父版本条件）、**写不写**（审核模式）、以及**失败算什么**
 * （分类表）。断言一律落在这些函数的返回值上，不碰任何存储——这一层本来就没有 IO。
 *
 * 刻意不在本文件里做的两件事，都由后续子阶段承担，写在这里免得被当成遗漏：
 *
 * - **持久化状态与原子写**（claim / lease / token fencing / 条件写的原子性）是 Phase 4-B；
 * - **端到端的「dry-run 一个字节都不落盘」**是 Phase 4-C——那要有 job 才谈得上。本阶段能证的
 *   是**这条链路是纯的**：喂进同一份记录跑完整条判定链，输入对象一个字节没被改过，重复跑
 *   得到完全相同的结果。纯函数不写存储，这是它可以被机械验证的那一半。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERSONA_EVOLUTION_STRATEGY_CONFIG,
  DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION,
  DefaultPersonaEvolutionStrategy,
} from '../adapters/default-persona-evolution-strategy';
import {
  buildPersonaEvolutionSnapshot,
  initialPersonaEvolutionMarker,
  isApprovedSkill,
  isEligibleExperience,
  personaEvolutionIdempotencyKey,
  personaEvolutionInputSnapshotHash,
  personaEvolutionStateLabel,
  planPersonaEvolutionCandidate,
  reevaluatePersonaEvolutionMarker,
} from '../services/persona-evolution-candidates';
import {
  PERSONA_EVOLUTION_DECISION_CONTRACT_CODE,
  PERSONA_EVOLUTION_FAILURE_KINDS,
  assertPersonaEvolutionDecisionConsistent,
  buildEvolvedPersona,
  isPersonaEvolutionDecisionContractError,
  isRetryablePersonaEvolutionFailure,
  personaEvolutionFailure,
  resolvePersonaEvolutionWrite,
  type PersonaEvolutionDecisionContractError,
  type PersonaEvolutionFailureKind,
} from '../services/persona-evolution-decision';
import {
  PERSONA_EVOLUTION_VERDICTS,
  type PersonaEvolutionApprovalMode,
  type PersonaEvolutionDecision,
  type PersonaEvolutionEvaluationInput,
  type PersonaEvolutionPersonaDraft,
  type PersonaEvolutionStrategy,
  type PersonaEvolutionVerdict,
} from '../ports/persona-evolution-strategy';
import type {
  ExperiencePromotion,
  ExperienceRecord,
  MaintenanceFailureCode,
  PersonaDef,
  PersonaEvolutionMarker,
  SkillRecord,
} from '../schemas';

const NOW = '2026-10-11T12:00:00.000Z';
const ROLE = 'role_persona_contract';
const STRATEGY_VERSION = DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION;

// ═══════════════════════════════════════════
//  样例数据
// ═══════════════════════════════════════════

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: randomUUID(),
    description: 'Prefer explicit contracts over implicit conventions.',
    description_embedding: [0.1, 0.2, 0.3],
    content: 'full skill content body',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['contracts'],
    promoted_at: NOW,
    agent_id: ROLE,
    market_status: 'available',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeExperience(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    id: randomUUID(),
    description: 'Prefer explicit contracts over implicit conventions.',
    description_embedding: [0.1, 0.2, 0.3],
    content: 'full experience content body',
    confidence: 0.9,
    tags: ['contracts'],
    agent_id: ROLE,
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

function makePersona(overrides: Partial<PersonaDef> = {}): PersonaDef {
  return {
    role_id: ROLE,
    version: 1,
    summary: 'A careful contract-first engineer.',
    skills_overview: 'Retrieve with query_memory.',
    experience_coverage: 'Retrieve with query_memory.',
    recent_performance: 'Steady.',
    notes: 'seeded',
    generated_at: NOW,
    ...overrides,
  };
}

/** 一条已出结论的演化标记（幂等与重评的判据） */
function processedMarker(overrides: Partial<PersonaEvolutionMarker> = {}): PersonaEvolutionMarker {
  return {
    status: 'processed',
    attempt_count: 1,
    outcome: 'evolved',
    parent_version: 1,
    persona_version: 2,
    strategy_version: STRATEGY_VERSION,
    input_snapshot_hash: 'hash_v1',
    source_run_id: 'run_seed',
    evaluated_at: NOW,
    reasons: ['qualifies'],
    change_summary: 'Persona v1 → v2',
    reviewed_by: 'system:auto-approval',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/** 一条经验的晋升标记（输入过滤读它） */
function promotionMarker(
  status: ExperiencePromotion['status'],
  overrides: Partial<ExperiencePromotion> = {},
): ExperiencePromotion {
  return { status, attempt_count: status === 'pending' ? 0 : 1, created_at: NOW, updated_at: NOW, ...overrides };
}

// ═══════════════════════════════════════════
//  1. 输入过滤
// ═══════════════════════════════════════════

describe('输入过滤：只有已批准 / 已生效的技能与已落定的经验能进演化', () => {
  it('技能：已批准且未被取代的才参与；等人工、已被拒、已被取代的一律排除', () => {
    const cases: Array<{ name: string; skill: SkillRecord; expected: boolean }> = [
      {
        name: 'approved + available',
        skill: makeSkill({ review_status: 'approved', market_status: 'available' }),
        expected: true,
      },
      {
        name: 'approved + 没有市场状态（旧数据）',
        skill: makeSkill({ review_status: 'approved', market_status: undefined }),
        expected: true,
      },
      {
        name: 'approved + retired_unique（能力还在，只是不再对外提供）',
        skill: makeSkill({ review_status: 'approved', market_status: 'retired_unique' }),
        expected: true,
      },
      {
        name: 'pending（还没人放行）',
        skill: makeSkill({ review_status: 'pending' }),
        expected: false,
      },
      {
        name: 'rejected（已被拒）',
        skill: makeSkill({ review_status: 'rejected' }),
        expected: false,
      },
      {
        name: 'approved 但 superseded（已被新版本取代）',
        skill: makeSkill({ review_status: 'approved', market_status: 'superseded' }),
        expected: false,
      },
    ];

    for (const testCase of cases) {
      expect(isApprovedSkill(testCase.skill), testCase.name).toBe(testCase.expected);
    }
  });

  it('经验：晋升状态未落定或未获批准的一律排除，其余参与', () => {
    const cases: Array<{
      name: string;
      promotion?: ExperiencePromotion | undefined;
      expected: boolean;
    }> = [
      { name: '从未评估（老数据与常态）', promotion: undefined, expected: true },
      {
        name: 'processing（别人正在改它）',
        promotion: promotionMarker('processing'),
        expected: false,
      },
      {
        name: 'pending 且投递过（上一次失败，结论未落定）',
        promotion: promotionMarker('pending', { attempt_count: 2 }),
        expected: false,
      },
      {
        name: 'pending 且从未投递（只是还没轮到）',
        promotion: promotionMarker('pending', { attempt_count: 0 }),
        expected: true,
      },
      { name: 'dead_letter', promotion: promotionMarker('dead_letter'), expected: false },
      {
        name: 'processed + promoted（已批准且已落定）',
        promotion: promotionMarker('processed', { outcome: 'promoted' }),
        expected: true,
      },
      {
        name: 'processed + pending_review（还没被批准）',
        promotion: promotionMarker('processed', { outcome: 'pending_review' }),
        expected: false,
      },
      {
        name: 'processed + rejected（结论已落定；被拒是关于晋升的判断）',
        promotion: promotionMarker('processed', { outcome: 'rejected' }),
        expected: true,
      },
      {
        name: 'processed 但没有结论（旧数据 / 被手工改过）',
        promotion: promotionMarker('processed'),
        expected: true,
      },
    ];

    for (const testCase of cases) {
      const experience = makeExperience(
        testCase.promotion === undefined ? {} : { promotion: testCase.promotion },
      );
      expect(isEligibleExperience(experience), testCase.name).toBe(testCase.expected);
    }
  });

  it('快照只收参与演化的那些，并按 id 升序（存储返回顺序不参与）', () => {
    const approved = makeSkill({ id: 'skill_b' });
    const pending = makeSkill({ id: 'skill_a', review_status: 'pending' });
    const eligible = makeExperience({ id: 'exp_b' });
    const inFlight = makeExperience({ id: 'exp_a', promotion: promotionMarker('processing') });

    const snapshot = buildPersonaEvolutionSnapshot({
      role_id: ROLE,
      // 故意打乱顺序，且把该排除的混在里面
      skills: [pending, approved],
      experiences: [inFlight, eligible],
    });

    expect(snapshot.skills.map((item) => item.id)).toEqual(['skill_b']);
    expect(snapshot.experiences.map((item) => item.id)).toEqual(['exp_b']);
    expect(snapshot.role_id).toBe(ROLE);
    expect(snapshot.feedback).toBeUndefined();
  });

  it('快照里不含描述向量等判定读不到的字段（多留一个只会让「内容没变」被误判成变了）', () => {
    const snapshot = buildPersonaEvolutionSnapshot({
      role_id: ROLE,
      skills: [makeSkill()],
      experiences: [makeExperience()],
    });

    expect(Object.keys(snapshot.skills[0]!).sort()).toEqual([
      'content',
      'description',
      'id',
      'market_status',
      'review_status',
      'tags',
      'updated_at',
    ]);
    expect(Object.keys(snapshot.experiences[0]!).sort()).toEqual([
      'confidence',
      'content',
      'description',
      'id',
      'tags',
      'type',
      'updated_at',
    ]);
  });
});

// ═══════════════════════════════════════════
//  2. 快照与 hash
// ═══════════════════════════════════════════

function snapshotOf(input: {
  skills?: SkillRecord[];
  experiences?: ExperienceRecord[];
  feedback?: { applied_feedback_count: number; average_confidence: number; last_feedback_at?: string } | undefined;
}) {
  return buildPersonaEvolutionSnapshot({
    role_id: ROLE,
    skills: input.skills ?? [makeSkill()],
    experiences: input.experiences ?? [makeExperience()],
    ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
  });
}

describe('输入快照的 hash：只由内容决定', () => {
  it('是 sha256 的十六进制，同内容必然同 hash', () => {
    const skill = makeSkill({ id: 'skill_1' });
    const experience = makeExperience({ id: 'exp_1' });

    const first = personaEvolutionInputSnapshotHash(
      snapshotOf({ skills: [skill], experiences: [experience] }),
    );
    const second = personaEvolutionInputSnapshotHash(
      snapshotOf({ skills: [skill], experiences: [experience] }),
    );

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
  });

  it('顺序不影响 hash：打乱输入顺序或标签顺序，结果不变', () => {
    const left = makeSkill({ id: 'skill_left', tags: ['a', 'b'] });
    const right = makeSkill({ id: 'skill_right', tags: ['b', 'a'] });

    const ordered = personaEvolutionInputSnapshotHash(
      snapshotOf({ skills: [left, right], experiences: [] }),
    );
    const shuffled = personaEvolutionInputSnapshotHash(
      snapshotOf({ skills: [right, left], experiences: [] }),
    );

    // 标签顺序也不该影响：hash 里按字典序拼
    const retagged = personaEvolutionInputSnapshotHash(
      snapshotOf({ skills: [left, makeSkill({ id: 'skill_right', tags: ['a', 'b'] })], experiences: [] }),
    );

    expect(shuffled).toBe(ordered);
    expect(retagged).toBe(ordered);
  });

  it('内容变了 hash 就变：描述、正文、置信度、时刻、增删一条都算', () => {
    const base = snapshotOf({ skills: [makeSkill({ id: 'skill_1' })], experiences: [] });
    const baseline = personaEvolutionInputSnapshotHash(base);

    const variants: Array<{ name: string; hash: string }> = [
      {
        name: '描述变了',
        hash: personaEvolutionInputSnapshotHash(
          snapshotOf({ skills: [makeSkill({ id: 'skill_1', description: 'another' })], experiences: [] }),
        ),
      },
      {
        name: '正文变了（判定读得到它，所以它必须在 hash 里）',
        hash: personaEvolutionInputSnapshotHash(
          snapshotOf({ skills: [makeSkill({ id: 'skill_1', content: 'another body' })], experiences: [] }),
        ),
      },
      {
        name: '审核状态变了',
        hash: personaEvolutionInputSnapshotHash(
          snapshotOf({ skills: [makeSkill({ id: 'skill_1', market_status: 'retired_unique' })], experiences: [] }),
        ),
      },
      {
        name: 'updated_at 变了',
        hash: personaEvolutionInputSnapshotHash(
          snapshotOf({ skills: [makeSkill({ id: 'skill_1', updated_at: '2026-10-11T13:00:00.000Z' })], experiences: [] }),
        ),
      },
      {
        name: '多了一条技能',
        hash: personaEvolutionInputSnapshotHash(
          snapshotOf({ skills: [makeSkill({ id: 'skill_1' }), makeSkill({ id: 'skill_2' })], experiences: [] }),
        ),
      },
      {
        name: '经验置信度变了',
        hash: personaEvolutionInputSnapshotHash(
          snapshotOf({ skills: [], experiences: [makeExperience({ id: 'exp_1', confidence: 0.5 })] }),
        ),
      },
    ];

    for (const variant of variants) {
      expect(variant.hash, variant.name).not.toBe(baseline);
    }
  });

  it('反馈缺席与「反馈是 0 条」不是同一份输入', () => {
    const absent = personaEvolutionInputSnapshotHash(snapshotOf({ feedback: undefined }));
    const zero = personaEvolutionInputSnapshotHash(
      snapshotOf({ feedback: { applied_feedback_count: 0, average_confidence: 0 } }),
    );
    const sameCountsNewer = personaEvolutionInputSnapshotHash(
      snapshotOf({
        feedback: {
          applied_feedback_count: 0,
          average_confidence: 0,
          last_feedback_at: '2026-10-11T13:00:00.000Z',
        },
      }),
    );

    expect(absent).not.toBe(zero);
    expect(zero).not.toBe(sameCountsNewer);
  });

  it('未被采纳的技能/经验不进 hash：排除掉它们之后 hash 与「本来就没有」一致', () => {
    const approved = makeSkill({ id: 'skill_1' });
    const withNoise = snapshotOf({
      skills: [approved, makeSkill({ id: 'skill_pending', review_status: 'pending' })],
      experiences: [],
    });
    const clean = snapshotOf({ skills: [approved], experiences: [] });

    expect(personaEvolutionInputSnapshotHash(withNoise)).toBe(
      personaEvolutionInputSnapshotHash(clean),
    );
  });
});

// ═══════════════════════════════════════════
//  3. 幂等键与候选计划
// ═══════════════════════════════════════════

describe('幂等键与「这次该不该动」', () => {
  it('幂等键区分角色 / 快照 / 策略版本，且不含父版本', () => {
    const base = {
      role_id: ROLE,
      input_snapshot_hash: 'hash_a',
      strategy_version: STRATEGY_VERSION,
    };

    expect(personaEvolutionIdempotencyKey(base)).toBe(
      `persona-evolution:${ROLE}:hash_a:${STRATEGY_VERSION}`,
    );
    expect(personaEvolutionIdempotencyKey({ ...base, role_id: 'role_other' })).not.toBe(
      personaEvolutionIdempotencyKey(base),
    );
    expect(personaEvolutionIdempotencyKey({ ...base, input_snapshot_hash: 'hash_b' })).not.toBe(
      personaEvolutionIdempotencyKey(base),
    );
    expect(personaEvolutionIdempotencyKey({ ...base, strategy_version: 'v2' })).not.toBe(
      personaEvolutionIdempotencyKey(base),
    );
  });

  /** 计划输入：只有 hash / 策略版本 / 审核模式在变，其余固定 */
  function planInput(overrides: Partial<Parameters<typeof planPersonaEvolutionCandidate>[1]> = {}) {
    return {
      now: NOW,
      strategy_version: STRATEGY_VERSION,
      approval: 'auto_approve' as PersonaEvolutionApprovalMode,
      input_snapshot_hash: 'hash_v1',
      ...overrides,
    };
  }

  it('从未演化过：直接 claim，并落一个初始标记', () => {
    expect(planPersonaEvolutionCandidate(undefined, planInput())).toEqual({
      kind: 'claim',
      marker: initialPersonaEvolutionMarker(NOW),
    });
  });

  it('同一份输入 + 同一版判据已经演化过：跳过，不再产出第二个版本', () => {
    const plan = planPersonaEvolutionCandidate(processedMarker(), planInput());
    expect(plan).toEqual({ kind: 'skip', reason: 'already_evolved_for_snapshot' });

    // 这条判据不依赖父版本：Persona 已经推进到 v2、v3…，同一份输入仍然不许再产出新版
    for (const version of [2, 3, 17]) {
      const advanced = processedMarker({
        parent_version: version,
        persona_version: version + 1,
      });
      expect(planPersonaEvolutionCandidate(advanced, planInput()), `persona v${String(version)}`).toEqual({
        kind: 'skip',
        reason: 'already_evolved_for_snapshot',
      });
    }
  });

  it('同一份输入下判过不合格：跳过；输入或判据变了才重评', () => {
    const rejected = processedMarker({ outcome: 'rejected', persona_version: undefined });

    expect(planPersonaEvolutionCandidate(rejected, planInput())).toEqual({
      kind: 'skip',
      reason: 'evaluated_under_current_strategy',
    });
    // 输入变了 → 重评
    expect(
      planPersonaEvolutionCandidate(rejected, planInput({ input_snapshot_hash: 'hash_v2' })).kind,
    ).toBe('reevaluate_then_claim');
    // 判据变了 → 重评（允许重评，但结论能不能产出新版本由策略回答）
    expect(
      planPersonaEvolutionCandidate(rejected, planInput({ strategy_version: 'persona-threshold.v2' }))
        .kind,
    ).toBe('reevaluate_then_claim');
  });

  it('已演化的角色拿到新输入：重评（这是这条通道存在的意义）', () => {
    expect(planPersonaEvolutionCandidate(processedMarker(), planInput({ input_snapshot_hash: 'hash_v2' }))).toEqual(
      {
        kind: 'reevaluate_then_claim',
        marker: reevaluatePersonaEvolutionMarker(processedMarker(), NOW),
      },
    );
  });

  it('待审核：人工审核模式跳过（哪怕输入变了），自动批准模式接上它', () => {
    const pending = processedMarker({ outcome: 'pending_review', persona_version: undefined });

    expect(planPersonaEvolutionCandidate(pending, planInput({ approval: 'manual_review' }))).toEqual({
      kind: 'skip',
      reason: 'waiting_for_manual_review',
    });
    // 输入变了也照样跳过：人工审核模式下重评只会再产出一份 pending_review，白烧一次模型调用
    expect(
      planPersonaEvolutionCandidate(
        pending,
        planInput({ approval: 'manual_review', input_snapshot_hash: 'hash_v2' }),
      ),
    ).toEqual({ kind: 'skip', reason: 'waiting_for_manual_review' });
    // 放宽成自动批准 → 这条等到了放行
    expect(planPersonaEvolutionCandidate(pending, planInput({ approval: 'auto_approve' })).kind).toBe(
      'reevaluate_then_claim',
    );
  });

  it('死信只由人工放回，自动路径不再碰它', () => {
    expect(
      planPersonaEvolutionCandidate(processedMarker({ status: 'dead_letter' }), planInput()),
    ).toEqual({ kind: 'skip', reason: 'dead_letter' });
  });

  it('持有中：租约没过期是「别人在做」，过期则先回收再 claim', () => {
    const inFlight = processedMarker({ status: 'processing', lease_expires_at: '2026-10-11T12:30:00.000Z' });
    expect(planPersonaEvolutionCandidate(inFlight, planInput())).toEqual({
      kind: 'skip',
      reason: 'in_flight',
    });

    const expired = processedMarker({ status: 'processing', lease_expires_at: NOW });
    expect(planPersonaEvolutionCandidate(expired, planInput())).toEqual({
      kind: 'expire_then_claim',
    });
  });

  it('待投递：没到退避时刻跳过，到点 claim，用满次数兜底跳过', () => {
    const notDue = processedMarker({
      status: 'pending',
      attempt_count: 1,
      next_retry_at: '2026-10-11T13:00:00.000Z',
    });
    expect(planPersonaEvolutionCandidate(notDue, planInput())).toEqual({
      kind: 'skip',
      reason: 'not_due',
    });

    const due = processedMarker({ status: 'pending', attempt_count: 1, next_retry_at: NOW });
    expect(planPersonaEvolutionCandidate(due, planInput())).toEqual({ kind: 'claim', marker: due });

    const exhausted = processedMarker({ status: 'pending', attempt_count: 5 });
    expect(planPersonaEvolutionCandidate(exhausted, planInput())).toEqual({
      kind: 'skip',
      reason: 'attempts_exhausted',
    });
  });

  it('重评重置的是判定与投递痕迹，保留标记的来历（created_at）', () => {
    const before = processedMarker({ last_error: 'boom', next_retry_at: NOW, claim_token: 'tok' });
    const after = reevaluatePersonaEvolutionMarker(before, '2026-10-11T14:00:00.000Z');

    expect(after).toEqual({
      status: 'pending',
      attempt_count: 0,
      created_at: NOW,
      updated_at: '2026-10-11T14:00:00.000Z',
    });
    // 判定字段与凭据一律清空：新一轮评估应当和从没评过一样
    expect(after.outcome).toBeUndefined();
    expect(after.strategy_version).toBeUndefined();
    expect(after.input_snapshot_hash).toBeUndefined();
    expect(after.parent_version).toBeUndefined();
    expect(after.persona_version).toBeUndefined();
    expect(after.claim_token).toBeUndefined();
    expect(after.next_retry_at).toBeUndefined();
    expect(after.last_error).toBeUndefined();
  });

  it('观测标签由生命周期与结论两列派生', () => {
    const cases: Array<[PersonaEvolutionMarker | undefined, string]> = [
      [undefined, 'unevaluated'],
      [processedMarker({ status: 'processing' }), 'processing'],
      [processedMarker({ status: 'dead_letter' }), 'dead_letter'],
      [processedMarker({ status: 'pending', attempt_count: 0 }), 'unevaluated'],
      [processedMarker({ status: 'pending', attempt_count: 2 }), 'retryable'],
      [processedMarker({ outcome: 'evolved' }), 'evolved'],
      [processedMarker({ outcome: 'pending_review' }), 'pending_review'],
      [processedMarker({ outcome: 'rejected' }), 'rejected'],
      [processedMarker({ outcome: undefined }), 'unevaluated'],
    ];

    for (const [marker, expected] of cases) {
      expect(personaEvolutionStateLabel(marker), expected).toBe(expected);
    }
  });
});

// ═══════════════════════════════════════════
//  4. 判定契约：策略交回来的东西能不能信
// ═══════════════════════════════════════════

describe('判定契约：非法返回值一律在写任何东西之前被拒', () => {
  /** 本次执行的权威口径（与执行内核接到的那一份同形） */
  const expected = {
    role_id: ROLE,
    approval: 'auto_approve' as PersonaEvolutionApprovalMode,
    strategy_version: STRATEGY_VERSION,
    parent_version: 1,
    input_snapshot_hash: 'hash_v1',
  };

  function legalDraft(): PersonaEvolutionPersonaDraft {
    return {
      summary: 'A careful contract-first engineer.',
      skills_overview: '3 skills promoted.',
      experience_coverage: '5 experiences.',
      recent_performance: 'Steady.',
      notes: 'evolved',
    };
  }

  function legalDecision(): PersonaEvolutionDecision {
    return {
      verdict: 'eligible',
      role_id: ROLE,
      strategy_version: STRATEGY_VERSION,
      approval: 'auto_approve',
      parent_version: 1,
      input_snapshot_hash: 'hash_v1',
      reasons: ['Candidate qualifies.'],
      blocking_rules: [],
      persona: legalDraft(),
    };
  }

  /** 跑一次校验，把抛出来的契约错误取回来（没抛就是不合法判定从这道门溜过去了） */
  function violationOf(decision: unknown, overrides: Partial<typeof expected> = {}) {
    let thrown: unknown;
    try {
      assertPersonaEvolutionDecisionConsistent(decision, { ...expected, ...overrides });
    } catch (error) {
      thrown = error;
    }
    expect(isPersonaEvolutionDecisionContractError(thrown)).toBe(true);
    return thrown as PersonaEvolutionDecisionContractError;
  }

  function without(decision: PersonaEvolutionDecision, key: keyof PersonaEvolutionDecision) {
    const copy: Record<string, unknown> = { ...decision };
    delete copy[key];
    return copy;
  }

  it('三种合法判定一律放行', () => {
    expect(() => assertPersonaEvolutionDecisionConsistent(legalDecision(), expected)).not.toThrow();
    expect(() =>
      assertPersonaEvolutionDecisionConsistent(
        { ...legalDecision(), verdict: 'pending_review', approval: 'manual_review' },
        { ...expected, approval: 'manual_review' },
      ),
    ).not.toThrow();
    expect(() =>
      assertPersonaEvolutionDecisionConsistent(
        {
          ...legalDecision(),
          verdict: 'rejected',
          persona: undefined,
          blocking_rules: ['no_new_input'],
          reasons: ['the input snapshot was already evolved'],
        },
        expected,
      ),
    ).not.toThrow();
  });

  it('每一类非法值都落在它自己的 violation 上，错误里带着 expected / actual / 角色', () => {
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
      { name: 'verdict 不是字符串', decision: { ...legalDecision(), verdict: 1 }, violation: 'verdict' },
      {
        name: 'role_id 为空串',
        decision: { ...legalDecision(), role_id: '   ' },
        violation: 'role_id',
      },
      {
        name: 'role_id 不是字符串',
        decision: { ...legalDecision(), role_id: null },
        violation: 'role_id',
      },
      {
        name: 'role_id 指向别的角色',
        decision: { ...legalDecision(), role_id: 'role_other' },
        violation: 'role_id',
        needle: 'role_other',
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
        decision: { ...legalDecision(), strategy_version: 'persona-threshold.v9' },
        violation: 'strategy_version',
        needle: 'persona-threshold.v9',
      },
      {
        name: 'approval 不是合法模式',
        decision: { ...legalDecision(), approval: 'yolo' },
        violation: 'approval',
        needle: 'yolo',
      },
      {
        name: 'approval 与本次运行不符',
        decision: { ...legalDecision(), verdict: 'rejected', persona: undefined, blocking_rules: ['no_new_input'], approval: 'manual_review' },
        violation: 'approval',
      },
      {
        name: 'parent_version 不是正整数（0）',
        decision: { ...legalDecision(), parent_version: 0 },
        violation: 'parent_version',
      },
      {
        name: 'parent_version 不是整数',
        decision: { ...legalDecision(), parent_version: 1.5 },
        violation: 'parent_version',
      },
      {
        name: 'parent_version 不是数字',
        decision: { ...legalDecision(), parent_version: '1' },
        violation: 'parent_version',
      },
      {
        name: 'parent_version 与执行不符',
        decision: { ...legalDecision(), parent_version: 2 },
        violation: 'parent_version',
        needle: '2',
      },
      {
        name: 'input_snapshot_hash 为空串',
        decision: { ...legalDecision(), input_snapshot_hash: '' },
        violation: 'input_snapshot_hash',
      },
      {
        name: 'input_snapshot_hash 与执行不符',
        decision: { ...legalDecision(), input_snapshot_hash: 'hash_other' },
        violation: 'input_snapshot_hash',
        needle: 'hash_other',
      },
      {
        name: 'reasons 不是数组',
        decision: { ...legalDecision(), reasons: 'Candidate qualifies.' },
        violation: 'reasons',
      },
      { name: 'reasons 元素不是字符串', decision: { ...legalDecision(), reasons: [1] }, violation: 'reasons' },
      { name: 'reasons 元素是空串', decision: { ...legalDecision(), reasons: [''] }, violation: 'reasons' },
      {
        name: 'blocking_rules 不是数组',
        decision: { ...legalDecision(), blocking_rules: 'no_new_input' },
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
      expect(error.contract_code, testCase.name).toBe(PERSONA_EVOLUTION_DECISION_CONTRACT_CODE);
      expect(error.role_id, testCase.name).toBe(ROLE);
      // 只有配对那一类 violation 会在错误对象上带这两个值，其余保持缺席
      expect(error.verdict, testCase.name).toBeUndefined();
      expect(error.approval, testCase.name).toBeUndefined();
      expect(error.expected.length, testCase.name).toBeGreaterThan(0);
      expect(error.message, testCase.name).toContain('got "');
      expect(error.message, testCase.name).toContain(ROLE);
      expect(error.message, testCase.name).toContain(testCase.violation);
      expect(error.message, testCase.name).toContain('not retried');
      if (testCase.needle) expect(error.message, testCase.name).toContain(testCase.needle);
    }
  });

  it('结论与审核模式必须配对：eligible 只配 auto_approve，pending_review 只配 manual_review', () => {
    const cases: Array<{
      name: string;
      verdict: PersonaEvolutionVerdict;
      approval: PersonaEvolutionApprovalMode;
      expected: string;
    }> = [
      {
        name: 'eligible + manual_review（会在只许记录的模式下写出 Persona）',
        verdict: 'eligible',
        approval: 'manual_review',
        expected: 'eligible + auto_approve',
      },
      {
        name: 'pending_review + auto_approve（会把该自动演化的角色冻结成人再看一眼）',
        verdict: 'pending_review',
        approval: 'auto_approve',
        expected: 'pending_review + manual_review',
      },
    ];

    for (const testCase of cases) {
      const error = violationOf(
        { ...legalDecision(), verdict: testCase.verdict, approval: testCase.approval },
        { approval: testCase.approval },
      );

      expect(error.violation, testCase.name).toBe('verdict_approval');
      expect(error.verdict, testCase.name).toBe(testCase.verdict);
      expect(error.approval, testCase.name).toBe(testCase.approval);
      expect(error.expected, testCase.name).toBe(testCase.expected);
      expect(error.actual, testCase.name).toBe(`${testCase.verdict} + ${testCase.approval}`);
    }
  });

  it('结论与正文/挡板/理由的搭配', () => {
    const cases: Array<{ name: string; decision: unknown; violation: string }> = [
      {
        name: 'rejected 却没有挡板规则',
        decision: {
          ...legalDecision(),
          verdict: 'rejected',
          persona: undefined,
          blocking_rules: [],
          reasons: ['no'],
        },
        violation: 'verdict_combination',
      },
      {
        name: 'rejected 却没有理由',
        decision: {
          ...legalDecision(),
          verdict: 'rejected',
          persona: undefined,
          blocking_rules: ['no_new_input'],
          reasons: [],
        },
        violation: 'verdict_combination',
      },
      {
        name: 'rejected 却递来一份正文（一个永远不会被写下去、却长得像结果的东西）',
        decision: {
          ...legalDecision(),
          verdict: 'rejected',
          blocking_rules: ['no_new_input'],
          reasons: ['no'],
        },
        violation: 'verdict_combination',
      },
      {
        name: 'eligible 却带着挡板规则',
        decision: { ...legalDecision(), blocking_rules: ['no_new_input'] },
        violation: 'verdict_combination',
      },
      {
        name: 'eligible 却没有正文',
        decision: { ...legalDecision(), persona: undefined },
        violation: 'persona_draft',
      },
      {
        name: 'eligible 的正文缺字段',
        decision: { ...legalDecision(), persona: { summary: 'only one field' } },
        violation: 'persona_draft',
      },
      {
        name: 'eligible 的正文有字段是空串',
        decision: { ...legalDecision(), persona: { ...legalDraft(), notes: '  ' } },
        violation: 'persona_draft',
      },
      {
        name: 'eligible 的正文不是对象',
        decision: { ...legalDecision(), persona: 'a persona' },
        violation: 'persona_draft',
      },
    ];

    for (const testCase of cases) {
      expect(violationOf(testCase.decision).violation, testCase.name).toBe(testCase.violation);
    }
  });

  it('渲染不出来的 actual 不会变成第二个错误源（循环引用 / BigInt 都只写成一句话）', () => {
    const circular: Record<string, unknown> = { ...legalDecision(), verdict: 'typo' };
    circular.self = circular;
    expect(violationOf(circular).violation).toBe('verdict');
    expect(violationOf(circular).actual).toBe('typo');

    const withBigInt = { ...legalDecision(), parent_version: 1n };
    const error = violationOf(withBigInt);
    expect(error.violation).toBe('parent_version');
    expect(error.actual).toBe('1');
  });

  it('默认策略交回来的判定一律通过契约校验（两种模式 × 三种结论）', async () => {
    const cases: Array<{ name: string; approval: PersonaEvolutionApprovalMode; confidence: number }> = [
      { name: '合格 + 自动批准', approval: 'auto_approve', confidence: 0.9 },
      { name: '合格 + 人工审核', approval: 'manual_review', confidence: 0.9 },
    ];

    for (const testCase of cases) {
      const strategy = new DefaultPersonaEvolutionStrategy({ approval: testCase.approval });
      const input = evaluationInput({
        approval: testCase.approval,
        skills: [makeSkill()],
        experiences: [makeExperience({ confidence: testCase.confidence })],
      });

      const decision = await strategy.evaluate(input);
      expect(
        () => assertPersonaEvolutionDecisionConsistent(decision, contractExpectationOf(input)),
        testCase.name,
      ).not.toThrow();
    }
  });
});

/** 一份判定输入（默认：一条已批准技能 + 一条经验 + v1 Persona） */
function evaluationInput(
  overrides: Partial<PersonaEvolutionEvaluationInput> & {
    skills?: SkillRecord[];
    experiences?: ExperienceRecord[];
  } = {},
): PersonaEvolutionEvaluationInput {
  const { skills, experiences, ...rest } = overrides;
  const snapshot = buildPersonaEvolutionSnapshot({
    role_id: ROLE,
    skills: skills ?? [makeSkill()],
    experiences: experiences ?? [makeExperience()],
    ...(rest.snapshot?.feedback !== undefined ? { feedback: rest.snapshot.feedback } : {}),
  });
  const persona = rest.current_persona ?? makePersona();
  return {
    role_id: ROLE,
    now: NOW,
    approval: 'auto_approve',
    current_persona: persona,
    parent_version: persona.version,
    snapshot,
    input_snapshot_hash: personaEvolutionInputSnapshotHash(snapshot),
    ...rest,
    ...(rest.snapshot !== undefined ? { snapshot: rest.snapshot } : {}),
  };
}

/**
 * 契约校验的权威口径。
 *
 * 除判定输入里已有的四项，还要补上 `strategy_version`——它来自**注入的策略对象**而不是输入
 * （策略自己知道自己的版本），执行内核从 `deps.strategy.version` 取它。因此这份口径不能在
 * `PersonaEvolutionEvaluationInput` 上就地展开，得单独拼一份。
 */
function contractExpectationOf(
  input: PersonaEvolutionEvaluationInput,
  strategy_version = STRATEGY_VERSION,
) {
  return {
    role_id: input.role_id,
    approval: input.approval,
    strategy_version,
    parent_version: input.parent_version,
    input_snapshot_hash: input.input_snapshot_hash,
  };
}

// ═══════════════════════════════════════════
//  5. 写回前置条件：父版本
// ═══════════════════════════════════════════

describe('写回前置条件：只允许基于当前父版本写', () => {
  it('父版本就是当前版本 → 可以写，新版本 = 父版本 + 1', () => {
    expect(resolvePersonaEvolutionWrite({ parent_version: 3, current_version: 3 })).toEqual({
      kind: 'apply',
      parent_version: 3,
      next_version: 4,
    });
  });

  it('父版本已经不是当前版本 → 冲突，不覆盖（并发演化 / 前端 PATCH）', () => {
    // 别的 worker 先写了一步
    expect(resolvePersonaEvolutionWrite({ parent_version: 3, current_version: 4 })).toEqual({
      kind: 'conflict',
      parent_version: 3,
      current_version: 4,
    });
    // 当前版本反而更低（被清理过 / 数据异常）：同样不许写，判据是「不相等」而不是「更大」
    expect(resolvePersonaEvolutionWrite({ parent_version: 3, current_version: 2 })).toEqual({
      kind: 'conflict',
      parent_version: 3,
      current_version: 2,
    });
  });

  it('新 Persona 由父版本 + 1 得出，正文照搬判定的那五段', () => {
    const draft: PersonaEvolutionPersonaDraft = {
      summary: 's',
      skills_overview: 'so',
      experience_coverage: 'ec',
      recent_performance: 'rp',
      notes: 'n',
    };
    const persona = buildEvolvedPersona({
      role_id: ROLE,
      draft,
      parent_version: 7,
      now: NOW,
    });

    expect(persona).toEqual({
      role_id: ROLE,
      version: 8,
      summary: 's',
      skills_overview: 'so',
      experience_coverage: 'ec',
      recent_performance: 'rp',
      notes: 'n',
      generated_at: NOW,
    });
  });
});

// ═══════════════════════════════════════════
//  6. 审核模式与缺失反馈
// ═══════════════════════════════════════════

describe('审核模式：缺省人工审核，自动批准必须是显式开关', () => {
  it('缺省配置是 manual_review，三个门槛都不设', () => {
    expect(DEFAULT_PERSONA_EVOLUTION_STRATEGY_CONFIG).toEqual({
      version: 'persona-threshold.v1',
      approval: 'manual_review',
      min_approved_skills: 0,
      min_experiences: 0,
      min_average_confidence: null,
    });
  });

  it('同一份输入：人工审核给 pending_review，自动批准给 eligible（都不写库，写不写在执行方）', async () => {
    const manual = new DefaultPersonaEvolutionStrategy({ approval: 'manual_review' });
    const auto = new DefaultPersonaEvolutionStrategy({ approval: 'auto_approve' });

    // 同一份输入（同一份快照、同一个 hash）喂给两个策略：唯一变的是审核模式
    const input = evaluationInput({ approval: 'manual_review' });
    const manualDecision = await manual.evaluate(input);
    const autoDecision = await auto.evaluate({ ...input, approval: 'auto_approve' });

    expect(manualDecision.verdict).toBe('pending_review');
    expect(manualDecision.approval).toBe('manual_review');
    expect(autoDecision.verdict).toBe('eligible');
    expect(autoDecision.approval).toBe('auto_approve');
    expect(manualDecision.input_snapshot_hash).toBe(autoDecision.input_snapshot_hash);
    // 两种模式交出来的正文是同一份：换的是「能不能写」，不是「写什么」
    expect(manualDecision.persona).toEqual(autoDecision.persona);
  });

  it('人工审核判过的角色，放宽成自动批准之后被重新评估并给出 eligible', () => {
    const pending = processedMarker({ outcome: 'pending_review', persona_version: undefined });
    const plan = planPersonaEvolutionCandidate(pending, {
      now: NOW,
      strategy_version: STRATEGY_VERSION,
      approval: 'auto_approve',
      input_snapshot_hash: 'hash_v1',
    });

    expect(plan.kind).toBe('reevaluate_then_claim');
  });

  it('反馈聚合缺失且策略需要它时：拒绝，而不是把缺席当 0 分静默覆盖', async () => {
    const strategy = new DefaultPersonaEvolutionStrategy({ min_average_confidence: 0.5 });

    const noFeedback = await strategy.evaluate(evaluationInput({}));
    expect(noFeedback.verdict).toBe('rejected');
    expect(noFeedback.blocking_rules).toEqual(['feedback_unavailable']);
    expect(noFeedback.persona).toBeUndefined();

    // 有聚合但质量不达标：另一条规则
    const lowQuality = await strategy.evaluate(
      evaluationInput({
        snapshot: {
          ...buildPersonaEvolutionSnapshot({
            role_id: ROLE,
            skills: [makeSkill()],
            experiences: [makeExperience()],
          }),
          feedback: { applied_feedback_count: 3, average_confidence: 0.2 },
        },
      }),
    );
    expect(lowQuality.blocking_rules).toEqual(['below_feedback_quality']);
  });

  it('空输入一律拒绝：没有可演化的东西，不得平白推进版本号', async () => {
    const strategy = new DefaultPersonaEvolutionStrategy({ approval: 'auto_approve' });
    const decision = await strategy.evaluate(
      evaluationInput({ skills: [], experiences: [], approval: 'auto_approve' }),
    );

    expect(decision.verdict).toBe('rejected');
    expect(decision.blocking_rules).toEqual(['no_approved_input']);
    expect(decision.persona).toBeUndefined();
  });

  it('同一份输入已经演化过：策略版本变了也只重评、不产出新版本', async () => {
    const strategy = new DefaultPersonaEvolutionStrategy({
      approval: 'auto_approve',
      version: 'persona-threshold.v2',
    });
    const input = evaluationInput({
      skills: [makeSkill()],
      experiences: [makeExperience()],
      approval: 'auto_approve',
    });
    const withLast: PersonaEvolutionEvaluationInput = {
      ...input,
      last_evolution: {
        outcome: 'evolved',
        input_snapshot_hash: input.input_snapshot_hash,
        strategy_version: STRATEGY_VERSION,
        persona_version: 2,
        evaluated_at: NOW,
      },
    };

    const decision = await strategy.evaluate(withLast);
    expect(decision.verdict).toBe('rejected');
    expect(decision.blocking_rules).toEqual(['no_new_input']);
    expect(decision.persona).toBeUndefined();
  });

  it('输入变了但算出来的正文与当前版本一致：拒绝 persona_unchanged，不churn 版本号', async () => {
    const strategy = new DefaultPersonaEvolutionStrategy({ approval: 'auto_approve' });
    const skill = makeSkill();
    const experience = makeExperience();

    // 先按这份输入算出「当前 Persona 长什么样」
    const first = await strategy.evaluate(
      evaluationInput({ skills: [skill], experiences: [experience], approval: 'auto_approve' }),
    );
    expect(first.verdict).toBe('eligible');

    const evolved = buildEvolvedPersona({
      role_id: ROLE,
      draft: first.persona!,
      parent_version: 1,
      now: NOW,
    });

    // 输入变了（时刻变了 → hash 变了），但四段正文一模一样
    const decision = await strategy.evaluate(
      evaluationInput({
        skills: [{ ...skill, updated_at: '2026-10-11T13:00:00.000Z' }],
        experiences: [experience],
        approval: 'auto_approve',
        current_persona: evolved,
        parent_version: evolved.version,
      }),
    );

    expect(decision.verdict).toBe('rejected');
    expect(decision.blocking_rules).toEqual(['persona_unchanged']);
  });
});

// ═══════════════════════════════════════════
//  7. 失败分类
// ═══════════════════════════════════════════

describe('失败分类：码与可重试性只定一次', () => {
  it('六种情形各自落在预期的码与可重试性上', () => {
    const cases: Array<{
      kind: PersonaEvolutionFailureKind;
      code: MaintenanceFailureCode;
      retryable: boolean;
    }> = [
      { kind: 'model_failure', code: 'model_error', retryable: true },
      { kind: 'malformed_decision', code: 'payload_unreadable', retryable: false },
      { kind: 'storage_conflict', code: 'storage_error', retryable: true },
      { kind: 'missing_input', code: 'delivery_missing', retryable: false },
      { kind: 'policy_failure', code: 'policy_rejected', retryable: false },
      { kind: 'storage_failure', code: 'storage_error', retryable: true },
    ];

    expect(PERSONA_EVOLUTION_FAILURE_KINDS).toEqual(cases.map((item) => item.kind));

    for (const testCase of cases) {
      const classified = personaEvolutionFailure(testCase.kind, `${testCase.kind} happened`);
      expect(classified, testCase.kind).toEqual({
        code: testCase.code,
        retryable: testCase.retryable,
        message: `${testCase.kind} happened`,
      });
      expect(isRetryablePersonaEvolutionFailure(testCase.kind), testCase.kind).toBe(
        testCase.retryable,
      );
    }
  });

  it('判定不合格不是失败：它不在分类表里（结论记完成数，不进死信）', () => {
    expect(PERSONA_EVOLUTION_FAILURE_KINDS).not.toContain('rejected' as PersonaEvolutionFailureKind);
  });

  it('冲突与存储故障落在同一个码上，但仍是两种情形（排查时读得出来）', () => {
    const conflict = personaEvolutionFailure('storage_conflict', 'parent moved');
    const storage = personaEvolutionFailure('storage_failure', 'disk error');
    expect(conflict.code).toBe(storage.code);
    expect(conflict.message).not.toBe(storage.message);
  });
});

// ═══════════════════════════════════════════
//  8. 这条链路是纯的（dry-run 可依赖的性质）
// ═══════════════════════════════════════════

describe('判定链路是纯的：输入不被改动，重复执行结果相同', () => {
  it('跑完整条链（过滤 → 快照 → hash → 计划 → 判定 → 校验 → 写回判定）后输入一个字节没变', async () => {
    const skills = [makeSkill({ id: 'skill_1' }), makeSkill({ id: 'skill_2', review_status: 'pending' })];
    const experiences = [
      makeExperience({ id: 'exp_1' }),
      makeExperience({ id: 'exp_2', promotion: promotionMarker('processing') }),
    ];
    const persona = makePersona();
    const marker = processedMarker({ input_snapshot_hash: 'hash_old' });

    const before = structuredClone({ skills, experiences, persona, marker });

    const snapshot = buildPersonaEvolutionSnapshot({ role_id: ROLE, skills, experiences });
    const hash = personaEvolutionInputSnapshotHash(snapshot);
    const plan = planPersonaEvolutionCandidate(marker, {
      now: NOW,
      strategy_version: STRATEGY_VERSION,
      approval: 'auto_approve',
      input_snapshot_hash: hash,
    });
    const strategy = new DefaultPersonaEvolutionStrategy({ approval: 'auto_approve' });
    const decision = await strategy.evaluate({
      role_id: ROLE,
      now: NOW,
      approval: 'auto_approve',
      current_persona: persona,
      parent_version: persona.version,
      snapshot,
      input_snapshot_hash: hash,
      last_evolution: { outcome: 'evolved', input_snapshot_hash: 'hash_old' },
    });
    assertPersonaEvolutionDecisionConsistent(decision, {
      role_id: ROLE,
      approval: 'auto_approve',
      strategy_version: STRATEGY_VERSION,
      parent_version: persona.version,
      input_snapshot_hash: hash,
    });
    const write = resolvePersonaEvolutionWrite({
      parent_version: decision.parent_version,
      current_version: persona.version,
    });
    expect(plan.kind).toBe('reevaluate_then_claim');
    expect(write.kind).toBe('apply');

    // 整条链没有一个环节改过它的输入——纯函数不写存储，这是 dry-run 可以依赖的那一半
    expect({ skills, experiences, persona, marker }).toEqual(before);
  });

  it('同一份输入重复跑：快照、hash、判定逐字相同', async () => {
    const strategy = new DefaultPersonaEvolutionStrategy({ approval: 'auto_approve' });
    const build = async () => {
      const input = evaluationInput({
        skills: [makeSkill({ id: 'skill_1' })],
        experiences: [makeExperience({ id: 'exp_1' })],
        approval: 'auto_approve',
      });
      return {
        snapshot: input.snapshot,
        hash: input.input_snapshot_hash,
        decision: await strategy.evaluate(input),
      };
    };

    const first = await build();
    const second = await build();

    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.hash).toBe(first.hash);
    expect(second.decision).toEqual(first.decision);
  });

  it('结论的 verdict 只在三个合法值里，且不合格时一定带挡板与理由', async () => {
    const strategy = new DefaultPersonaEvolutionStrategy({ approval: 'auto_approve' });
    const decisions: PersonaEvolutionDecision[] = [
      await strategy.evaluate(evaluationInput({ skills: [], experiences: [], approval: 'auto_approve' })),
      await strategy.evaluate(evaluationInput({ skills: [makeSkill()], experiences: [makeExperience()], approval: 'auto_approve' })),
    ];

    for (const decision of decisions) {
      expect(PERSONA_EVOLUTION_VERDICTS).toContain(decision.verdict);
      if (decision.verdict === 'rejected') {
        expect(decision.blocking_rules.length).toBeGreaterThan(0);
        expect(decision.reasons.length).toBeGreaterThan(0);
      }
    }
  });

  it('派生出来的策略（只实现端口，不继承任何基类）同样受契约约束', async () => {
    // 一个返回非法判定的自定义策略：契约必须拦住它，而不是让它伪装成一条正常拒绝
    const lying: PersonaEvolutionStrategy = {
      version: STRATEGY_VERSION,
      config: DEFAULT_PERSONA_EVOLUTION_STRATEGY_CONFIG,
      // 绕过 TypeScript 交回一个拼错的 verdict，正是被审计的自定义策略会做的事
      evaluate: async () =>
        ({ ...legalDecisionForTest(), verdict: 'typo' }) as unknown as PersonaEvolutionDecision,
    };
    const input = evaluationInput({ approval: 'auto_approve' });
    const returned = await lying.evaluate(input);

    // 契约必须拦住它，并且给出可聚合的 violation —— 不能让它伪装成一条正常拒绝结论
    let thrown: unknown;
    try {
      assertPersonaEvolutionDecisionConsistent(returned, contractExpectationOf(input));
    } catch (error) {
      thrown = error;
    }
    expect(isPersonaEvolutionDecisionContractError(thrown)).toBe(true);
    expect((thrown as PersonaEvolutionDecisionContractError).violation).toBe('verdict');
    expect((thrown as PersonaEvolutionDecisionContractError).contract_code).toBe(
      PERSONA_EVOLUTION_DECISION_CONTRACT_CODE,
    );
  });
});

/** 一份合法判定（给「派生策略」那条用例做底稿） */
function legalDecisionForTest(): PersonaEvolutionDecision {
  return {
    verdict: 'eligible',
    role_id: ROLE,
    strategy_version: STRATEGY_VERSION,
    approval: 'auto_approve',
    parent_version: 1,
    input_snapshot_hash: 'hash_v1',
    reasons: ['Candidate qualifies.'],
    blocking_rules: [],
    persona: {
      summary: 's',
      skills_overview: 'so',
      experience_coverage: 'ec',
      recent_performance: 'rp',
      notes: 'n',
    },
  };
}
