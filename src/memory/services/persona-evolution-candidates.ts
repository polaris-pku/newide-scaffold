/**
 * persona-evolution-candidates — 谁参与演化、输入快照是什么、这次该不该动（Phase 4-A）
 *
 * 这是 Persona Evolution Job 的「选人与取材」规则：一个角色能不能被演化、这次该做什么
 * （直接 claim / 先重置再 claim / 先从过期租约里回收再 claim / 跳过），以及**判定能看到的
 * 那份输入**长什么样。纯函数、无 IO —— 规则写在这里一次，Phase 4-B 的两个适配器与
 * Phase 4-C 的执行内核都调它，因此「什么算候选」「什么算同一份输入」不可能在实现之间漂移。
 *
 * 三件事在这里定死，后面所有阶段都依赖它们：
 *
 * 1. **输入过滤**（`isApprovedSkill` / `isEligibleExperience`）：只能读已批准或已生效的技能，
 *    以及晋升状态已经落定的经验。`pending_review`（还没人放行）、`processing`（别人正在改
 *    它）、`dead_letter`（已知处理不了）、投递过又回到队列（未完成的晋升结果）一律排除：
 *    它们要么不是「已批准」，要么会让「输入没有变化」这句话失去意义。
 * 2. **快照与 hash**：快照是**判定唯一能读到的输入**（见 ports/persona-evolution-strategy.ts），
 *    因此 hash 覆盖的正是这份快照的全部内容，且只由内容决定——数组按 `id` 升序，存储返回
 *    顺序不参与。同内容必然同 hash，不同内容必然不同 hash，这是幂等键的地基。
 * 3. **幂等键与「要不要重评」**：`(role_id, input_snapshot_hash, strategy_version)` 决定
 *    这条候选是不是已经按同一份输入、同一版判据处理过。**`parent_version` 不在幂等键里**，
 *    它是写回的前置条件——把它塞进键会让「演化出一版新 Persona」本身改变键，于是每一次
 *    重跑都必然产出一个新版本，正好是幂等要防的那件事（详见 `planPersonaEvolutionCandidate`
 *    的注释）。
 * 4. **上一次结论的读法**（`personaEvolutionLastRun`）：判定能看到的「历史」只有标记上的那
 *    一条结论，且必须在重评**重置标记之前**读出来（Phase 4-C 的 claim 与演练路径都调它）。
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY,
  isDeliveryClaimExpired,
  isDeliveryDue,
  type DeliveryRetryPolicy,
} from './delivery-lifecycle';
import { averageConfidence } from './usage-feedback';
import type {
  PersonaEvolutionFeedbackSummary,
  PersonaEvolutionInputSnapshot,
  PersonaEvolutionSkillSnapshot,
  PersonaEvolutionExperienceSnapshot,
  PersonaEvolutionApprovalMode,
  PersonaEvolutionLastRun,
} from '../ports/persona-evolution-strategy';
import type {
  ExperienceRecord,
  PersonaEvolutionMarker,
  SkillRecord,
} from '../schemas';

// ═══════════════════════════════════════════
//  输入过滤
// ═══════════════════════════════════════════

/**
 * 这条技能能不能进输入：**已批准**且**没有被取代**。
 *
 * 判据刻意与技能检索的资格过滤逐字一致（`review_status === 'approved'` 且
 * `market_status !== 'superseded'`，见 ports/memory-repository.ts 的 MarketSearchOptions）——
 * 「一条技能算不算这个 Agent 的能力」在这个模块里只该有一个答案，两个地方各写一套判据，
 * 迟早会出现「检索得到的技能不在 Persona 覆盖里」这种自相矛盾。
 *
 * `retired_unique` **保留**：那是市场层面的独占标记（不再对外提供），不代表这个 Agent 不再
 * 拥有这份能力，而 Persona 描述的是后者。`approved` 之外的两种（`pending` 等人工、`rejected`
 * 已被拒）是被这道门挡下的主要对象。
 */
export function isApprovedSkill(skill: SkillRecord): boolean {
  return skill.review_status === 'approved' && skill.market_status !== 'superseded';
}

/**
 * 这条经验能不能进输入。
 *
 * 从未评估过（`promotion === undefined`）**可以**：那是 Phase 3 之前落库的老数据与常态，
 * 它没有「未完成的晋升结果」可言。除此之外只有晋升状态**已经落定**的经验才参与：
 *
 * | 晋升标记 | 参与？ | 为什么 |
 * | --- | --- | --- |
 * | 缺席（从未评估） | 是 | 没有在途结论，读到的是稳定事实 |
 * | `processing` | 否 | 别人正在改它——读到的是一份会变的中间态 |
 * | `pending` 且投递过 | 否 | 上一次失败后回到队列，结论还没落定 |
 * | `dead_letter` | 否 | 已知处理不了，读它只是在读一条坏记录 |
 * | `processed` + `outcome='pending_review'` | 否 | **还没被批准**：等人工放行的结论不许进输入 |
 * | `processed` + `outcome='promoted'` | 是 | 已批准且已落定 |
 * | `processed` + `outcome='rejected'` | 是 | 结论已落定；「不适合晋升为技能」是关于**晋升**的判断，不是「这条经验无效」 |
 * | `processed` 但没有结论 | 是 | 结论缺席（旧数据 / 被手工改过）读作已落定，与 `planPromotionCandidate` 同一条兜底 |
 *
 * 最后一格（`rejected` 参与）是**刻意的**，也是这份规则里唯一需要解释的判断：Phase 4 的
 * 排除清单点名的是 `pending_review`、`dead_letter`、`processing` 与未完成的晋升结果，
 * 而 `rejected` 不在其中——它是一条已经出结论、不会再变的事实，Persona 本来就同时描述
 * 正经验与负经验（规则版归纳就在统计 `positive / negative` 两类）。真要让被拒的经验也
 * 退出输入，改的是这一行，而不是散在各处的调用方。
 */
export function isEligibleExperience(experience: ExperienceRecord): boolean {
  const marker = experience.promotion;
  if (!marker) return true;
  switch (marker.status) {
    case 'processing':
      return false;
    case 'dead_letter':
      return false;
    case 'pending':
      // 投递过一次就说明「上一次失败了、结论还没落定」；从未投递过（次数 0）只是还没轮到
      return marker.attempt_count === 0;
    case 'processed':
      return marker.outcome !== 'pending_review';
  }
}

/** 参与演化的技能，按 `id` 升序（顺序是快照的一部分，见文件头） */
export function selectApprovedSkills(skills: SkillRecord[]): SkillRecord[] {
  return skills.filter(isApprovedSkill).sort(compareRecordsById);
}

/** 参与演化的经验，按 `id` 升序 */
export function selectEligibleExperiences(experiences: ExperienceRecord[]): ExperienceRecord[] {
  return experiences.filter(isEligibleExperience).sort(compareRecordsById);
}

/** 排序：先按 `created_at`（先来的先算），同刻按 `id` —— 确定性来自这里，不来自存储返回顺序 */
export function compareRecordsById(
  left: { id: string; created_at: string },
  right: { id: string; created_at: string },
): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1;
  return left.id.localeCompare(right.id);
}

// ═══════════════════════════════════════════
//  输入快照与 hash
// ═══════════════════════════════════════════

/**
 * 构造输入快照 —— **判定唯一能读到的输入**。
 *
 * 过滤在这里做一次（`isApprovedSkill` / `isEligibleExperience`），因此调用方不必先筛后传：
 * 只要把角色名下的原始列表交进来，拿到的就是「这次演化允许依据的那些事实」。这也让
 * 「输入过滤」这件事只有一个入口，观测面（例如 run 审计里的输入规模）与判定看到的东西
 * 不可能对不上。
 *
 * 刻意收窄字段：只保留判定会读的那些（描述、正文、标签、状态、时刻）。多留一个不会被读的
 * 字段，只会让「内容没变」被误判成「输入变了」而白白多产出一个版本。
 */
export function buildPersonaEvolutionSnapshot(input: {
  role_id: string;
  skills: SkillRecord[];
  experiences: ExperienceRecord[];
  feedback?: PersonaEvolutionFeedbackSummaryInput | undefined;
}): PersonaEvolutionInputSnapshot {
  const approvedSkills = selectApprovedSkills(input.skills);
  const eligibleExperiences = selectEligibleExperiences(input.experiences);
  // 缺省由**参与演化的那些经验**自己推导反馈聚合：反馈的证据（`confidence_history` 里带
  // `feedback_id` 的条目）本来就落在经验上，因此这份聚合是快照内容的一个纯函数，判定能看到的
  // 就是它能依据的全部。传进来的那一份优先（测试与脚本要构造确定的输入时用得上）。
  //
  // 注意喂进去的是**裁剪之前**的经验记录：快照条目刻意不带 `confidence_history`（那是整条
  // 历史，不是判定的输入），而反馈痕迹只在那份历史里。
  const feedback = input.feedback ?? personaEvolutionFeedbackSummary(eligibleExperiences);
  return {
    role_id: input.role_id,
    skills: approvedSkills.map(toSkillSnapshot).sort(compareSnapshotEntries),
    experiences: eligibleExperiences.map(toExperienceSnapshot).sort(compareSnapshotEntries),
    ...(feedback !== undefined ? { feedback: { ...feedback } } : {}),
  };
}

/**
 * 从**参与演化的经验**上推导反馈聚合；没有任何反馈痕迹时返回 undefined。
 *
 * 证据来自 `confidence_history`：反馈回写路径会给每一条变更记一个 `feedback_id`（见
 * schemas.ts 的 ConfidenceHistoryEntrySchema），而没有 `feedback_id` 的条目是种子数据、
 * 手工调整或反馈回写之前的旧记录，都不算「一条反馈被归并过」。
 *
 * 三处刻意的选择：
 *
 * 1. **没有痕迹就是缺席，不是 0**。缺席与「归并过 0 条」是两件不同的事，前者意味着「这个
 *    角色还没有任何反馈证据」，策略要么不设反馈门槛、要么显式拒绝（`feedback_unavailable`）
 *    ——两者都不该是「用一个 0 分把它判掉」。
 * 2. **按 `feedback_id` 去重**：同一条反馈可能被应用到多条经验上，而这里答的是「有多少条
 *    反馈已经被归并进来」，重复计数会让同一个证据的影响随经验条数放大。
 * 3. **平均置信度按同一批经验现算**，而不是读 `AgentMetrics.avg_confidence`：后者是全量经验的
 *    聚合，与快照里这一批不是同一个总体。用后者会让「策略依据的反馈质量」被一批它看不到的
 *    经验左右——同一个 hash 下判定却随不可见数据变化，幂等键就失去了意义。
 */
export function personaEvolutionFeedbackSummary(
  experiences: readonly {
    confidence: number;
    confidence_history: readonly { feedback_id?: string | undefined; updated_at: string }[];
  }[],
): PersonaEvolutionFeedbackSummary | undefined {
  const latestByFeedback = new Map<string, string>();
  for (const experience of experiences) {
    for (const entry of experience.confidence_history) {
      if (entry.feedback_id === undefined) continue;
      const current = latestByFeedback.get(entry.feedback_id);
      if (current === undefined || entry.updated_at > current) {
        latestByFeedback.set(entry.feedback_id, entry.updated_at);
      }
    }
  }
  if (latestByFeedback.size === 0) return undefined;

  const lastFeedbackAt = [...latestByFeedback.values()].sort().at(-1);
  return {
    applied_feedback_count: latestByFeedback.size,
    average_confidence: averageConfidence(experiences),
    ...(lastFeedbackAt !== undefined ? { last_feedback_at: lastFeedbackAt } : {}),
  };
}

/** 反馈聚合的输入形态（与端口上的类型同形；单独写一遍是为了不把可选字段的默认值带进来） */
export interface PersonaEvolutionFeedbackSummaryInput {
  applied_feedback_count: number;
  average_confidence: number;
  last_feedback_at?: string | undefined;
}

function toSkillSnapshot(skill: SkillRecord): PersonaEvolutionSkillSnapshot {
  return {
    id: skill.id,
    description: skill.description,
    content: skill.content,
    tags: [...skill.tags],
    review_status: skill.review_status,
    ...(skill.market_status !== undefined ? { market_status: skill.market_status } : {}),
    updated_at: skill.updated_at,
  };
}

function toExperienceSnapshot(experience: ExperienceRecord): PersonaEvolutionExperienceSnapshot {
  return {
    id: experience.id,
    description: experience.description,
    content: experience.content,
    tags: [...experience.tags],
    type: experience.type,
    confidence: experience.confidence,
    updated_at: experience.updated_at,
  };
}

function compareSnapshotEntries(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

/**
 * 快照的 hash —— **只由内容决定**。
 *
 * 喂进 hash 的是一份**手工拼出来的规范串**，不是 `JSON.stringify(snapshot)`：后者的键顺序
 * 取决于对象字面量的书写顺序（今天恰好稳定，但那是实现的偶然），而这份串的每一段都由这里
 * 的代码显式定序，于是「同内容必然同 hash」是被保证的而不是被观察到的。字段之间用不可打印
 * 分隔符隔开，避免拼接歧义（`["ab","c"]` 与 `["a","bc"]` 必须不同）。
 *
 * 数组在这里再排一次序，是**防御性**的而不是多余的：快照的构造顺序已经排过，但只要有人
 * 手工拼一份快照（测试、脚本）传进来，这一层仍然保证顺序不影响结果。
 */
export function personaEvolutionInputSnapshotHash(
  snapshot: PersonaEvolutionInputSnapshot,
): string {
  const parts: string[] = ['persona-evolution.v1', snapshot.role_id];

  const skills = [...snapshot.skills].sort(compareSnapshotEntries);
  parts.push(`skills:${String(skills.length)}`);
  for (const skill of skills) {
    parts.push(
      [
        skill.id,
        skill.review_status,
        skill.market_status ?? '',
        skill.description,
        skill.content,
        [...skill.tags].sort().join(','),
        skill.updated_at,
      ].join('\u001f'),
    );
  }

  const experiences = [...snapshot.experiences].sort(compareSnapshotEntries);
  parts.push(`experiences:${String(experiences.length)}`);
  for (const experience of experiences) {
    parts.push(
      [
        experience.id,
        experience.type,
        String(experience.confidence),
        experience.description,
        experience.content,
        [...experience.tags].sort().join(','),
        experience.updated_at,
      ].join('\u001f'),
    );
  }

  const feedback = snapshot.feedback;
  // 反馈缺席与「反馈是 0 条」是两件不同的事，因此缺席写一个显式标记，而不是写 0
  parts.push(
    feedback === undefined
      ? 'feedback:absent'
      : ['feedback', String(feedback.applied_feedback_count), String(feedback.average_confidence), feedback.last_feedback_at ?? ''].join('\u001f'),
  );

  return createHash('sha256').update(parts.join('\u001e'), 'utf8').digest('hex');
}

/**
 * 批量 run 的输入快照 digest —— 把本次处理过的**逐候选 hash** 聚合成一个稳定摘要。
 *
 * 单候选那条链路的输入标识就是它自己的快照 hash（记在演化标记上）；而一次运行处理的是一个
 * **候选集合**，「这次运行依据的是哪份输入」因此需要一个集合级的标识。缺了它，run 审计只剩
 * 逐候选的行，想回答「两次运行的输入是不是同一批」得先把两组 hash 各自排序再逐条比。
 *
 * 三条约定，与单候选的 hash 同源：
 *
 * 1. **只由内容决定，与顺序无关**：喂进来的 hash 先排序再拼串，因此同一个候选集合无论以什么
 *    顺序被处理，digest 都一样（处理顺序是调度的偶然，不是输入的一部分）。
 * 2. **条数进摘要**：`['a','bc']` 与 `['ab','c']` 这类拼接歧义由分隔符挡住，条数则是给
 *    「同一批内容、只是重复出现」一个显式的区分位——同一个候选出现两次与只出现一次的 digest
 *    不同，那两件事本来也不是同一份输入。
 * 3. **空集合没有 digest**：一个候选都没处理时返回 `undefined`，让它与「处理了候选、摘要恰好
 *    是某个值」在读口上分得开。审计里那条「候选数为 0」说的才是这件事。
 */
export function personaEvolutionBatchSnapshotDigest(
  hashes: readonly string[],
): string | undefined {
  const sorted = [...hashes].sort();
  if (sorted.length === 0) return undefined;
  return createHash('sha256')
    .update(['persona-evolution-batch.v1', String(sorted.length), ...sorted].join('\u001e'), 'utf8')
    .digest('hex');
}

/**
 * 幂等键：`(role_id, input_snapshot_hash, strategy_version)`。
 *
 * 它就是「同一条演化流已经按这份输入、这版判据处理过」这句话的身份。计划 §11 建议的键里
 * 还提到 `parent Persona version`，这里**刻意不放进去**——理由是一旦放进去，这个键就无法
 * 再用来判重：
 *
 * - 演化成功后父版本从 v1 变成 v2。若键含父版本，同一个键不可能再出现，于是下一次运行
 *   看到的是「新键」→ 再演化一版 v3 → 永不停歇。这正是「相同输入快照重复执行不得产生
 *   重复 Persona 版本」要防的事。
 * - 真正的用途分工是：`(role_id, snapshot_hash, strategy_version)` 判**要不要做这件事**；
 *   `parent_version` 判**做的时候能不能写**（条件更新的前置条件，见 Phase 4-B / Phase 4-C）。
 *   两者都不可少，但混成一把键就两个都做不好。
 *
 * 因此父版本记录在标记上（`PersonaEvolutionMarker.parent_version`），既不参与判重，
 * 也不会因此被丢掉——排查时照样看得到「这一版是从哪一版来的」。
 */
export function personaEvolutionIdempotencyKey(input: {
  role_id: string;
  input_snapshot_hash: string;
  strategy_version: string;
}): string {
  return `persona-evolution:${input.role_id}:${input.input_snapshot_hash}:${input.strategy_version}`;
}

// ═══════════════════════════════════════════
//  计划：这次该不该动这条候选
// ═══════════════════════════════════════════

/** 判定「这次不动这条角色」的理由（机器可读，用于聚合「候选都卡在哪」） */
export type PersonaEvolutionSkipReason =
  /** 同一份输入、同一版判据已经演化过（幂等命中） */
  | 'already_evolved_for_snapshot'
  /** 同一份输入、同一版判据下已经判过，结论是不合格 */
  | 'evaluated_under_current_strategy'
  /** 判为待审核，而本次运行还是人工审核模式 */
  | 'waiting_for_manual_review'
  /** 死信：只由人工重试放回 */
  | 'dead_letter'
  /** 正被别的 worker 持有（lease 未过期） */
  | 'in_flight'
  /** 还在退避窗口里 */
  | 'not_due'
  /** 投递次数已用满（正常路径下应已进死信，这里兜底） */
  | 'attempts_exhausted';

/**
 * 一条候选该做什么。
 *
 * 三种「要动它」的形状分开，是为了让适配器明确知道在 claim 之前还得先写什么——三者的
 * 写回内容不同，混成一个布尔会丢掉「为什么需要重置」这条信息。（与晋升同一套形状。）
 */
export type PersonaEvolutionCandidatePlan =
  /** 现在就能 claim（含从未演化过、需要先落一个初始标记的情况） */
  | { kind: 'claim'; marker: PersonaEvolutionMarker }
  /** 先按新判据把标记重置为待评估，再 claim（换了输入、换了策略版本、或人工审核转自动批准） */
  | { kind: 'reevaluate_then_claim'; marker: PersonaEvolutionMarker }
  /** 先按租约过期回收（`expireDeliveryClaimRecord`），再 claim */
  | { kind: 'expire_then_claim' }
  /** 本次不动它 */
  | { kind: 'skip'; reason: PersonaEvolutionSkipReason };

/** 选候选与判「该不该动」需要的上下文 */
export interface PersonaEvolutionCandidateInput {
  /** 参考时刻（注入时钟的结果） */
  now: string;
  /** 当前生效的策略版本：决定判过的候选要不要重评 */
  strategy_version: string;
  /** 本次运行的审核模式：决定 pending_review 要不要被自动批准接起来 */
  approval: PersonaEvolutionApprovalMode;
  /** 本次算出来的输入快照 hash：与标记上记的那个比对，就是幂等判据 */
  input_snapshot_hash: string;
  /** 重试预算；缺省用 DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY */
  policy?: DeliveryRetryPolicy;
}

/**
 * 产出一条候选的处理计划。
 *
 * 判定顺序即「哪条判据更根本」的顺序，每一步都挡一类具体的事：
 *
 * 1. 从未演化过（标记缺席）→ 直接 claim，并在 claim 时落一个初始标记。
 * 2. 死信 → 跳过：只由人工 `retryDeadLetterEvolution` 放回，自动路径不再重投。
 * 3. 处理中 → 租约没过期就是「别人正在做」，过期则先回收再 claim（回收本身可能用满次数
 *    进死信，那时随后的 claim 自然拿不到它）。
 * 4. 待投递 → 还没到退避时刻就是「这次没活」；用满次数则是兜底（正常路径下已经进死信）。
 * 5. 已出结论 → 分三种：
 *    - 结论是 `pending_review`：它等的就是一次自动批准的运行。**本次是 `auto_approve` 就
 *      重新评估并放行**（否则「先记下来等批准」永远等不到批准）；仍是人工审核模式则跳过，
 *      哪怕输入变了也不重评——人工审核模式下重评只会再产出一份 pending_review，白烧一次
 *      模型调用，而下一次自动批准的运行本来就会拿最新输入重算。
 *    - 输入快照与策略版本**都没变**：幂等命中。`evolved` 报 `already_evolved_for_snapshot`，
 *      `rejected` 报 `evaluated_under_current_strategy`——两者都不重评，理由同一条：这一次
 *      运行不会得出结论以外的东西。
 *    - 其余（输入变了，或策略版本变了）→ 重新评估。**输入变化必须触发重评**是这条通道
 *      存在的意义；策略版本变化触发重评则与晋升同义：判据变了，旧结论不再代表现在的判断。
 *
 * 不抛错：任何读不懂的组合（例如 `processed` 却没有 `input_snapshot_hash` 的旧数据）都归到
 * 「重评一次」——搁着不动的代价是这条角色永远不再被考虑，而那比多评一次贵得多。
 */
export function planPersonaEvolutionCandidate(
  marker: PersonaEvolutionMarker | undefined,
  input: PersonaEvolutionCandidateInput,
): PersonaEvolutionCandidatePlan {
  const policy = input.policy ?? DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY;

  if (!marker) {
    return { kind: 'claim', marker: initialPersonaEvolutionMarker(input.now) };
  }

  switch (marker.status) {
    case 'dead_letter':
      return { kind: 'skip', reason: 'dead_letter' };

    case 'processing':
      return isDeliveryClaimExpired(marker, input.now)
        ? { kind: 'expire_then_claim' }
        : { kind: 'skip', reason: 'in_flight' };

    case 'pending':
      if (marker.attempt_count >= policy.max_attempts) {
        return { kind: 'skip', reason: 'attempts_exhausted' };
      }
      return isDeliveryDue(marker, input.now)
        ? { kind: 'claim', marker }
        : { kind: 'skip', reason: 'not_due' };

    case 'processed': {
      if (marker.outcome === 'pending_review') {
        return input.approval === 'auto_approve'
          ? {
              kind: 'reevaluate_then_claim',
              marker: reevaluatePersonaEvolutionMarker(marker, input.now),
            }
          : { kind: 'skip', reason: 'waiting_for_manual_review' };
      }
      const sameInput = marker.input_snapshot_hash === input.input_snapshot_hash;
      const sameStrategy = marker.strategy_version === input.strategy_version;
      if (sameInput && sameStrategy) {
        return {
          kind: 'skip',
          reason:
            marker.outcome === 'evolved'
              ? 'already_evolved_for_snapshot'
              : 'evaluated_under_current_strategy',
        };
      }
      return {
        kind: 'reevaluate_then_claim',
        marker: reevaluatePersonaEvolutionMarker(marker, input.now),
      };
    }
  }
}

// ═══════════════════════════════════════════
//  标记的两个基准形态
// ═══════════════════════════════════════════

/** 从未演化过的角色在第一次 claim 时落下的初始标记 */
export function initialPersonaEvolutionMarker(now: string): PersonaEvolutionMarker {
  return { status: 'pending', attempt_count: 0, created_at: now, updated_at: now };
}

/**
 * 把一条已出结论的标记重置为「待评估」。
 *
 * 重置的是**判定**（结论、父版本、写下的版本、策略版本、输入快照、理由、变更摘要、批准者）
 * 与**投递痕迹**（次数、持有的 token、退避、上次错误）：换了一份输入或一版判据之后的第一
 * 次评估应当和从没评过一样，不该继承上一次的退避。`created_at` 保留——那是这条标记的来历，
 * 不是结论。
 *
 * 注意这里**不动 Persona 本身**：重置的是「要不要再判一次」，已经写进库的版本不会被回滚。
 * 「旧版本不能被破坏」是这条通道的硬约束。
 */
export function reevaluatePersonaEvolutionMarker(
  current: PersonaEvolutionMarker,
  now: string,
): PersonaEvolutionMarker {
  return {
    ...current,
    status: 'pending',
    attempt_count: 0,
    claimed_at: undefined,
    claim_owner: undefined,
    claim_token: undefined,
    lease_expires_at: undefined,
    next_retry_at: undefined,
    last_error: undefined,
    outcome: undefined,
    parent_version: undefined,
    persona_version: undefined,
    strategy_version: undefined,
    input_snapshot_hash: undefined,
    source_run_id: undefined,
    evaluated_at: undefined,
    reasons: undefined,
    change_summary: undefined,
    reviewed_by: undefined,
    updated_at: now,
  };
}

/**
 * 把标记上的**上一次结论**读成判定能看的那份历史（`PersonaEvolutionLastRun`）。
 *
 * 判定的输入里有一格是「上一次演化留下了什么」，它回答的是「这份输入是不是已经按这套判据
 * 演化过了」——缺了它，默认策略的 `no_new_input` 就永远判不出来，于是「策略版本变了、输入
 * 没变」会一路走到正文比较，靠 `persona_unchanged` 兜住。两条路都不会多写一个版本，但审计
 * 里记下的挡板规则从「输入没变」变成「正文没变」，读起来是两件不同的事。
 *
 * 两个使用场景，读的都是**计划执行之前**的那份标记：
 *
 * - 适配器 claim 时把它挂到候选上（`ClaimedPersonaEvolutionCandidate.last_evolution`）——
 *   重评路径会先把标记重置（`reevaluatePersonaEvolutionMarker` 清掉结论字段），claim 之后
 *   的标记上已经没有这份历史了，所以必须在重置**之前**读出来；
 * - 演练路径直接拿读到的标记算（那条路径不 claim，标记本来就没被动过）。
 *
 * 判据只有一条：**出过结论才有历史**。processing / 退回队列 / 死信都不带结论，它们答的是
 * 「这条流走到哪了」，不是「上一次判的是什么」；把 `last_error` 之类的失败痕迹当成历史喂给
 * 判定，等于让一次失败的投递看起来像一次判定。
 */
export function personaEvolutionLastRun(
  marker: PersonaEvolutionMarker | undefined,
): PersonaEvolutionLastRun | undefined {
  if (marker?.outcome === undefined) return undefined;
  return {
    outcome: marker.outcome,
    input_snapshot_hash: marker.input_snapshot_hash,
    strategy_version: marker.strategy_version,
    persona_version: marker.persona_version,
    evaluated_at: marker.evaluated_at,
  };
}

// ═══════════════════════════════════════════
//  观测：状态是派生的
// ═══════════════════════════════════════════

/**
 * 计划 §11 要求表达的那组语义（未评估 / 处理中 / 待审核 / 已拒绝 / 已演化 / 可重试 / 死信）
 * 在存储上的落点，收成一个词。
 *
 * 与晋升同一个理由：状态是**派生**的（由生命周期 + 结论两列算出来），不是又一个要维护的
 * 字段——真存一份状态，就有两个真相来源可以对不上。
 */
export type PersonaEvolutionStateLabel =
  | 'unevaluated'
  | 'processing'
  | 'retryable'
  | 'dead_letter'
  | 'evolved'
  | 'pending_review'
  | 'rejected';

export function personaEvolutionStateLabel(
  marker: PersonaEvolutionMarker | undefined,
): PersonaEvolutionStateLabel {
  if (!marker) return 'unevaluated';
  switch (marker.status) {
    case 'processing':
      return 'processing';
    case 'dead_letter':
      return 'dead_letter';
    case 'pending':
      // 投递过又回到队列 = 上一次失败了，等退避到期
      return marker.attempt_count > 0 ? 'retryable' : 'unevaluated';
    case 'processed':
      return marker.outcome ?? 'unevaluated';
  }
}
