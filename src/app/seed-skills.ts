/**
 * 四角色预置技能语料
 *
 * 生产 B 运行时启动时由 seedCatalog 写入 memory_skills，使每个角色一开局就有可检索
 * 的技能——空库下 retrieveMemoriesForTask 恒返回空，任何"记忆有没有被取用"的观测都
 * 无从谈起。
 *
 * 三条硬约束（沿用角色语料一贯的要求）：
 *   1. 完全自足——正文只描述本技能管什么、绝不管什么，不提及、不指路任何其他技能
 *      或角色。单独注入时必须完整可用。
 *   2. 角色同向——每份只把 agent 推往本角色关注的那一类判断，不越界到别的维度。
 *   3. 确定性——id 与时序字段都是字面量，重复 seed 得到逐字节相同的记录，因而可以
 *      拿 id 判断"是否已写入"。
 *
 * 这些技能直接以 review_status='approved' 落库，跳过 pending → 评审的人工流程：它们
 * 是语料而不是 agent 挣来的资产，不该在评审队列里堆积。
 */
import type { MemoryRepository } from '../memory';
import type { SkillRecord } from '../memory/schemas';

/** 预置技能的稳定标识与正文。 */
export interface SeedSkill {
  /** 稳定 UUID。重复 seed 时用它判重，因此必须是字面量而非 randomUUID()。 */
  id: string;
  role_id: string;
  /** 一句话说明，既是列表展示文案也是向量检索的输入（只 embed 这个字段）。 */
  description: string;
  content: string;
  tags: string[];
}

/**
 * 预置技能的时序字段。
 *
 * 用固定字面量而非 nowTimestamp()：seed 必须幂等到字节级，否则每次启动都会写出
 * 一份 created_at 不同的记录，测试无法对它断言。
 */
export const SEED_SKILL_TIMESTAMP = '2026-01-01T00:00:00.000Z';

export const SEED_SKILLS: readonly SeedSkill[] = [
  // ── role_fullstack_engineer ────────────────────────────────────────────────
  {
    id: 'f2e72845-d494-468e-8b01-f61b596e6fa8',
    role_id: 'role_fullstack_engineer',
    description:
      'Deliver a feature as one vertical slice, changing the request path, the stored shape and the rendered state together.',
    tags: ['fullstack', 'feature', 'integration', 'slice'],
    content: `# Vertical feature slice

## Scope
Changing one feature end to end, so that the request path, the persisted shape and the
displayed state all change together in a single pass.

## Out of scope
Tuning one layer in isolation. Deployment topology, capacity, and release mechanics.

## First question
Which artifact already carries the truth for this feature, and does every layer agree with it?

## Practice
- Name the one value that travels the whole path — an id, a status, a version. If there is no
  such value, the feature is not a slice yet; find it before editing.
- Walk that value: where it is created, where it is persisted, where it is read back, where it
  is rendered. Write the four sites down before touching any of them.
- Change all four in one pass. A slice that stops at the API boundary leaves the outermost
  state silently stale, and staleness is invisible to tests that only cover the inner layers.
- Verify at the outermost site, by observing the value there. Asserting an inner layer proves
  the value was computed, not that it arrived.
- If a layer cannot be changed in the same pass, say which one and why. An explicitly bounded
  slice is maintainable; a silently partial one is a defect waiting for its trigger.`,
  },
  {
    id: '64382b1d-9378-414c-a7dd-6e7f7a099e14',
    role_id: 'role_fullstack_engineer',
    description:
      'Give every shape that crosses a process boundary exactly one owner, and derive the other side from it.',
    tags: ['fullstack', 'contract', 'api', 'serialization'],
    content: `# Boundary shape ownership

## Scope
Shapes that cross a process boundary: request bodies, response envelopes, event payloads,
anything that is serialized on one side and interpreted on the other.

## Out of scope
Internal data structures that never leave a process. Wire-level protocol and transport design.

## First question
Which side is allowed to change this shape without telling the other?

## Practice
- Pick one side to own the definition. The other side derives from it or validates against it;
  it never restates it. Two hand-written copies are two shapes that will disagree.
- Treat absent and null as different values. A field that can be missing is not the same as a
  field that can be null, and code that collapses them misreads both.
- When a shape changes, list every producer and every consumer before editing. The ones you
  cannot find are the ones that break in production rather than in the test run.
- Do not accept "we will keep them in sync by hand". That is not a plan, it is a decision to
  drift, and the drift is silent until a payload arrives that only one side understands.
- When the two sides must deploy independently, version the shape rather than mutating it, and
  keep the old reading path until the last producer has moved.`,
  },

  // ── role_ts_engineer ───────────────────────────────────────────────────────
  {
    id: 'a25e5544-00b0-4d31-815d-211acba35d1c',
    role_id: 'role_ts_engineer',
    description:
      'Validate untrusted input once at the edge, then let the type system carry the narrowed result inward.',
    tags: ['typescript', 'validation', 'parsing', 'boundary'],
    content: `# Runtime validation at typed edges

## Scope
Values entering the program from outside its control: request payloads, environment variables,
parsed files, and anything returned by an untyped dependency.

## Out of scope
Values produced internally, where the compiler already knows the shape. Schema design for
storage.

## First question
Where does this value stop being untrusted, and is that the same place where it gets parsed?

## Practice
- Parse at the boundary into a narrow type, once. Do not validate lazily at each use site —
  scattered checks cannot be reviewed as a whole and they drift apart.
- An assertion inside a function is not a boundary. It moves the failure away from its cause,
  so the stack trace names the consumer instead of the malformed producer.
- Make the parse total: every field either resolves to its narrowed type or the whole input is
  rejected. Partial parsing produces objects that are half-trusted, which is worse than either
  extreme because no type describes them.
- Never let a catch convert a parse failure into a default value. A default is
  indistinguishable from real data downstream and hides the defect that produced it.
- Keep the narrowed type as the only representation past the edge. If downstream code still
  accepts the wide type, the parse proved nothing.`,
  },
  {
    id: '58c68158-984d-4bf5-832c-2e916208dd1c',
    role_id: 'role_ts_engineer',
    description:
      'Test each module against its declared interface, so the test stays valid when the implementation behind it is rewritten.',
    tags: ['typescript', 'testing', 'contract', 'interface'],
    content: `# Contract test at the seam

## Scope
Tests whose subject is a documented interface: a function signature, a module entrypoint, an
exported service type.

## Out of scope
Tests that deliberately pin implementation details. Load, latency and resource testing.

## First question
If this module were rewritten behind the same interface, would this test still be correct?

## Practice
- Assert on returned values and observable effects. Do not assert on how many times an internal
  collaborator was called — that is a description of today's implementation, not a contract.
- Cover every documented behaviour at least once and every documented error mode at least once.
  An error mode with no test is a claim, not a guarantee.
- State what would make each test fail. A test whose failure condition you cannot name passes
  for reasons unrelated to the behaviour it is supposed to protect.
- When a test needs many collaborators before it can run, the interface is too wide. Narrow the
  interface rather than adding another stub; the stubs are the symptom.
- Keep fixtures minimal and local. A shared fixture grows into a second, undocumented interface
  that every test depends on and none of them owns.`,
  },

  // ── role_code_reviewer ─────────────────────────────────────────────────────
  {
    id: '73b78c48-e67c-4ecf-8960-80ca2d19ba81',
    role_id: 'role_code_reviewer',
    description:
      'Review a change by walking the input domain it accepts, rather than by reading it top to bottom.',
    tags: ['review', 'correctness', 'edge-case', 'boundary'],
    content: `# Input domain boundary matrix

## Scope
The correctness of a proposed change with respect to the values it can actually receive.

## Out of scope
Style, naming and formatting. Performance, unless the change makes an existing bound worse.

## First question
What is the full set of inputs this accepts, and which members of that set has the author not
considered?

## Practice
- Enumerate the domain by class, not by example: empty, exactly one, many, absent, null,
  duplicated, zero, negative, out of range, wrong type, and the boundary value on each side of
  every comparison.
- For each class, state what the code does and whether that is the intended answer. Writing the
  two down side by side is what surfaces the disagreement.
- Look hardest at the class the author's tests never mention. An untested class is usually an
  unconsidered one, not a deliberately excluded one.
- Report a finding only with the concrete input that triggers it, and say what the code does
  with that input. A finding without a triggering input is a preference, and preferences
  belong in a different conversation.
- Distinguish "wrong answer" from "undefined behaviour". The second is a real finding even when
  no counterexample exists in the current callers.`,
  },
  {
    id: '4c12d75e-f639-47e7-9704-00407783fa21',
    role_id: 'role_code_reviewer',
    description:
      'Audit what the accompanying tests actually assert, and name the wrong implementation each one would still accept.',
    tags: ['review', 'testing', 'assertion', 'coverage'],
    content: `# Assertion quality audit

## Scope
Whether the tests shipped with a change are capable of failing when the change is wrong.

## Out of scope
Coverage percentages treated as a target. Features the change does not claim to implement.

## First question
What wrong implementation would still pass this test suite?

## Practice
- For each test, name the defect it would catch. If no defect comes to mind, the test asserts
  nothing about the behaviour and should be rewritten or removed.
- Flag truthiness checks that accept a wrong value: a non-empty string, a non-zero number and a
  populated object all pass where an exact value was meant.
- Flag assertions that only confirm a call happened. The call is a step; the observable outcome
  is the contract, and the step can succeed while the outcome is wrong.
- Flag error-path tests that assert only that something threw. Assert the error identity or
  message — otherwise any unrelated failure, including a typo in the test, satisfies the test.
- Check that the test data would distinguish the new behaviour from the old. Reusing a fixture
  that already passed before the change means the change is untested whatever the diff says.
- Prefer one assertion that pins a value exactly over several that describe it loosely.`,
  },

  // ── role_synthesis_engineer ────────────────────────────────────────────────
  {
    id: 'f6d3c239-1ddf-4d6e-a98a-1804ffd512ab',
    role_id: 'role_synthesis_engineer',
    description:
      'Resolve conflicting proposals by weighing the evidence behind each, rather than averaging them into a compromise.',
    tags: ['synthesis', 'conflict', 'decision', 'evidence'],
    content: `# Evidence-weighted resolution

## Scope
Choosing between proposals that disagree with each other.

## Out of scope
Generating new proposals. Assessing a single proposal when nothing contradicts it.

## First question
Which claim is supported by an observation that the other claim cannot explain?

## Practice
- Restate each position as a claim plus the evidence offered for it. A position with no evidence
  is an opinion and does not compete on the same axis as one with evidence.
- Keep the position with the strongest evidence and drop the other. Do not merge them into a
  middle course — a compromise between a correct answer and an incorrect one is incorrect.
- If both positions rest on the same evidence, the difference between them is a preference.
  Say that plainly, pick one, and record why; do not present the choice as a finding.
- Do not soften a well-supported answer to accommodate an objection that offered no evidence.
  Doing so trades a correct result for the appearance of consensus.
- When the evidence is genuinely insufficient to decide, say so and name the observation that
  would settle it. A stated gap is usable; a fabricated tie-break is not.`,
  },
  {
    id: 'e0ecdd75-dc43-477f-a1d6-94546aa3fa88',
    role_id: 'role_synthesis_engineer',
    description:
      'Carry each accepted point’s origin and each rejected point’s reason into the final answer.',
    tags: ['synthesis', 'provenance', 'rationale', 'final-answer'],
    content: `# Provenance ledger

## Scope
The traceability of a synthesized result: for every point that appears, where it came from and
why it survived.

## Out of scope
The substance of the underlying proposals themselves, and the correctness of any single one.

## First question
For each point in the final answer, can I say where it came from and why it is there?

## Practice
- Record, per accepted point, its source and a one-line reason for keeping it.
- Record, per rejected point, the reason for rejection. An omission the reader cannot
  distinguish from an oversight leaves the work looking arbitrary.
- Where two sources disagree and both survive, mark the disagreement in place rather than
  flattening it into a single voice. The reader needs to know which parts were contested.
- Attribute every point you keep. A claim in a synthesis that traces to no source is an
  invention, however plausible it reads.
- Drop any point you cannot attribute. Losing a good point costs less than importing one that
  no source supports, because the second cannot be checked by anyone downstream.
- Keep the ledger proportional: one line per point. The goal is that the next reader can audit
  the result, not that the result restates everything it drew on.`,
  },
];

/** 把语料条目展开成可落库的 SkillRecord。description_embedding 留空，由仓储写入时补。 */
export function toSeedSkillRecord(seed: SeedSkill): SkillRecord {
  return {
    id: seed.id,
    description: seed.description,
    description_embedding: [],
    content: seed.content,
    version: '1.0.0',
    review_status: 'approved',
    tags: [...seed.tags],
    promoted_at: SEED_SKILL_TIMESTAMP,
    agent_id: seed.role_id,
    created_at: SEED_SKILL_TIMESTAMP,
    updated_at: SEED_SKILL_TIMESTAMP,
  };
}

/**
 * 按 role_id 写入 SEED_SKILLS 中尚不存在的技能。
 *
 * 以 id 判重而非整条比对——技能一旦落库就可能被后续流程改写（评审、晋升、市场迁移），
 * 逐字段比对会把"已被改写的既有技能"误判成缺失并覆盖掉那些改动。
 *
 * 调用方须先确保对应 Agent 已注册：仓储的 listSkills / saveSkill 都要求 agent 行存在。
 */
export async function seedSkills(repository: MemoryRepository): Promise<void> {
  const knownSkillIds = new Map<string, Set<string>>();

  for (const seed of SEED_SKILLS) {
    let known = knownSkillIds.get(seed.role_id);
    if (!known) {
      known = new Set((await repository.listSkills(seed.role_id)).map((skill) => skill.id));
      knownSkillIds.set(seed.role_id, known);
    }
    if (known.has(seed.id)) continue;
    await repository.saveSkill(seed.role_id, toSeedSkillRecord(seed));
    known.add(seed.id);
  }
}
