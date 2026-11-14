/**
 * RuleBasedExperienceExtractor — ExperienceExtractor 的规则版实现
 *
 * 从 BufferSnapshot.driver_return 的 decisions、assumptions、blockers 等字段
 * 按规则提取真实经验（v1）；从 v2 学习输入的执行事实、Role 反思与来源分级
 * 按规则提取（见 extractFromV2）。
 *
 * 提取规则（v1）：
 *   1. 正经验（positive）：从 decisions + assumptions 拼装 content
 *   2. 负经验（negative）：逐个未解决 blocker 生成独立负经验
 *   3. 兜底：若以上均无，产出一条最小正经验（tag: auto-generated）
 *
 * 置信度计算（v1）：基于 referenced_experiences.effectiveness 加权平均，
 *   再扣除未解决 blocker 惩罚（每个 -0.1），最终 clamp 到 [0.1, 0.95]。
 *
 * v2 不伪造六字段：经验来自真实派工记录与 Role 反思；置信度以
 * services/learning-input-grade 的来源分级为上限（host_observed / role_declared / missing）。
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import type { ExperienceExtractor } from '../ports/experience-extractor';
import type { LearningEvidenceVerifier } from '../ports/learning-evidence-verifier';
import {
  isBufferSnapshotV2,
  type AgentContextSnapshot,
  type BufferSnapshot,
  type BufferSnapshotLike,
  type BufferSnapshotV2,
  type DriverReturn,
} from '../schemas';
import type { CandidateExperience, ExtractionOutput } from '../types';
import {
  dispatchHasHostObservedPass,
  gradeLearningInput,
  negativeConfidenceCap,
  sourceDriversLabel,
  type LearningInputGrade,
} from '../services/learning-input-grade';

// ═══════════════════════════════════════════
//  Confidence helpers
// ═══════════════════════════════════════════

const effectivenessScore: Record<string, number> = {
  fully_effective: 0.97,
  partially_effective: 0.6,
  ineffective: 0.2,
  not_applicable: 0.5,
};

function computeConfidence(dr: DriverReturn): number {
  const refs = dr.referenced_experiences;
  if (refs.length === 0) return 0.5;

  const avg =
    refs.reduce((sum, r) => sum + (effectivenessScore[r.effectiveness] ?? 0.5), 0) / refs.length;
  const unresolvedPenalty = dr.blockers.filter((b) => !b.resolved).length * 0.1;
  return Math.max(0.1, Math.min(1.0, avg - unresolvedPenalty));
}

// ═══════════════════════════════════════════
//  Tag extraction
// ═══════════════════════════════════════════

function extractTags(dr: DriverReturn): string[] {
  const tags = new Set<string>();
  for (const d of dr.decisions) tags.add(d.point);
  for (const a of dr.assumptions) tags.add(a.assumption);
  return [...tags];
}

// ═══════════════════════════════════════════
//  Content builders
// ═══════════════════════════════════════════

function buildPositiveContent(
  dr: DriverReturn,
  agentContext?: AgentContextSnapshot,
): string | null {
  const sections: string[] = [];

  if (dr.decisions.length > 0) {
    const lines = dr.decisions.map(
      (d) => `  [${d.point}] chose "${d.chosen}" (options: ${d.options.join(', ')}) — ${d.reason}`,
    );
    sections.push(`Decisions:\n${lines.join('\n')}`);
  }

  if (dr.assumptions.length > 0) {
    const lines = dr.assumptions.map(
      (a) => `  ${a.assumption} — risk if wrong: ${a.risk_if_wrong}`,
    );
    sections.push(`Assumptions:\n${lines.join('\n')}`);
  }

  if (agentContext?.thinking_trace) {
    sections.push(`Thinking trace:\n  ${agentContext.thinking_trace}`);
  }

  if (sections.length === 0) return null;
  return sections.join('\n\n');
}

function buildExperience(opts: {
  snapshot: BufferSnapshot;
  agentContext?: AgentContextSnapshot;
  now: string;
  content: string;
  description: string;
  type: 'positive' | 'negative';
  confidence: number;
  tags: string[];
}): CandidateExperience {
  return {
    id: randomUUID(),
    description: opts.description,
    description_embedding: [0.1, 0.2, 0.3],
    content: opts.content,
    confidence: opts.confidence,
    tags: opts.tags,
    // 归属不在这里定，这里也**不产出**归属字段：一条 Buffer 属于哪个 Agent 只有
    // memory.role_id 说得准，提取器拿不到它（无上下文快照时连 agentContext 都没有）。
    // 填一个占位值就会让直接使用提取器的维护系统把经验挂错人；**更不要拿
    // source_task_id 顶替**——那是任务溯源字段，不是归属。agent_id 由
    // persistExtractedExperiences 按 memory.role_id 统一补齐。
    linked_negative_exp: undefined,
    promoted_to: undefined,
    assumptions: undefined,
    confidence_history: [
      { value: opts.confidence, updated_at: opts.now, reason: 'rule-based extraction' },
    ],
    referenced_count: 0,
    last_referenced_at: undefined,
    source_task_id: opts.snapshot.source_task_id,
    source_driver: opts.snapshot.source_driver,
    source_user_rating: undefined,
    type: opts.type,
    created_at: opts.now,
    updated_at: opts.now,
  };
}

// ═══════════════════════════════════════════
//  Main extractor
// ═══════════════════════════════════════════

export class RuleBasedExperienceExtractor implements ExperienceExtractor {
  /** 证据核验端口：缺省 = 未接线，v2 输入按「未核验」降级并留诊断（不默认信任 Buffer 计数）。 */
  private readonly evidence: LearningEvidenceVerifier | undefined;

  constructor(options: { evidence?: LearningEvidenceVerifier } = {}) {
    this.evidence = options.evidence;
  }

  async extract(
    snapshot: BufferSnapshotLike,
    agentContext?: AgentContextSnapshot,
  ): Promise<ExtractionOutput> {
    // 版本判别先于一切字段读取：v2 没有 driver_return，按 v1 读会拿到 undefined。
    if (isBufferSnapshotV2(snapshot)) return extractFromV2(snapshot, this.evidence);
    const dr = snapshot.driver_return;
    const now = nowTimestamp();
    const experiences: CandidateExperience[] = [];

    // 1. positive: decisions + assumptions
    const positiveContent = buildPositiveContent(dr, agentContext);
    if (positiveContent) {
      experiences.push(
        buildExperience({
          snapshot,
          now,
          content: positiveContent,
          description: dr.summary || `Task ${snapshot.task_id} result`,
          type: 'positive',
          confidence: computeConfidence(dr),
          tags: extractTags(dr),
          ...(agentContext != null ? { agentContext } : {}),
        }),
      );
    }

    // 2. negative: unresolved blockers
    for (const blocker of dr.blockers.filter((b) => !b.resolved)) {
      experiences.push(
        buildExperience({
          snapshot,
          now,
          content: [
            `Blocker: ${blocker.blocker}`,
            `Attempts: ${blocker.attempts.join(', ')}`,
            `Resolution: ${blocker.resolution || 'unresolved'}`,
          ].join('\n'),
          description: `Blocker encountered: ${blocker.blocker}`,
          type: 'negative',
          confidence: 0.6,
          tags: [...extractTags(dr), 'blocker'],
          ...(agentContext != null ? { agentContext } : {}),
        }),
      );
    }

    // 3. fallback: minimal positive
    if (experiences.length === 0) {
      experiences.push(
        buildExperience({
          snapshot,
          now,
          content: `Task completed: ${snapshot.task_description}`,
          description: dr.summary || `Task ${snapshot.task_id} completed`,
          type: 'positive',
          confidence: 0.5,
          tags: ['auto-generated'],
          ...(agentContext != null ? { agentContext } : {}),
        }),
      );
    }

    return {
      experiences,
      result: {
        experiences_created: experiences.filter((e) => e.type === 'positive').length,
        experiences_updated: 0,
        negative_experiences: experiences.filter((e) => e.type === 'negative').length,
        skills_promoted: 0,
      },
    };
  }
}

// ═══════════════════════════════════════════
//  v2 学习输入提取（执行事实 + Role 反思，不依赖六字段报告）
// ═══════════════════════════════════════════

/**
 * v2 经验的内容：执行事实、Role 反思、Journal 引用与记忆使用都如实列出。
 *
 * `includeRoleReflection=false` 用于「非 completed 结局但确有宿主核验通过的子结果」：
 * 那种正经验只能来自执行事实，不能把 Role 的失败陈述（summary/reflection）打包成成功做法。
 * 执行摘要用分级结果里的 `dispatches`——证据核验通过时那是从 Journal/evidence 重建的。
 */
function buildV2Content(
  snapshot: BufferSnapshotV2,
  grade: LearningInputGrade,
  options: { includeRoleReflection: boolean },
): string {
  const lines: string[] = [];
  if (grade.dispatches.length > 0) {
    lines.push('Execution facts:');
    for (const dispatch of grade.dispatches) {
      lines.push(
        `  - ${dispatch.dispatch_id} [${dispatch.kind}] status=${dispatch.status}` +
          ` checks: host_observed_passed=${String(dispatch.checks.host_observed_passed)},` +
          ` host_observed_failed=${String(dispatch.checks.host_observed_failed)},` +
          ` driver_reported=${String(dispatch.checks.driver_reported)},` +
          ` missing=${String(dispatch.checks.missing)}`,
      );
    }
  } else {
    lines.push('Execution facts: no dispatch (zero-dispatch task)');
  }
  lines.push(
    grade.evidence_verified
      ? 'Evidence verification: Buffer journal/evidence prefix and dispatch refs verified.'
      : 'Evidence verification: FAILED/degraded — the check counts above are Buffer-declared ' +
          'and are not treated as host-observed facts.',
  );
  const reflection = snapshot.role_reflection;
  const status = grade.status;
  lines.push(`Role end status: ${status ?? 'unknown (not recorded, not assumed completed)'}`);
  if (options.includeRoleReflection) {
    lines.push(`Role summary: ${reflection.summary}`);
    if (reflection.reflection.length > 0) lines.push(`Role reflection: ${reflection.reflection}`);
    if (reflection.unresolved.length > 0) {
      lines.push(`Unresolved: ${reflection.unresolved.join('; ')}`);
    }
  }
  lines.push(
    `Journal prefix: ${snapshot.journal_ref.path} lines=${String(snapshot.journal_ref.lines)} ` +
      `sha256=${snapshot.journal_ref.sha256}`,
  );
  const memoryUsed = reflection.memory_used;
  if (memoryUsed.length > 0) {
    lines.push(
      `Memory used (dependent): ${memoryUsed
        .map((entry) => `${entry.kind}:${entry.id} via ${entry.via}`)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}

/** v2 候选经验（归属仍由持久化层按 role_id 补齐）。 */
function buildV2Experience(input: {
  snapshot: BufferSnapshotV2;
  now: string;
  content: string;
  description: string;
  type: 'positive' | 'negative';
  confidence: number;
  tags: string[];
  reason: string;
}): CandidateExperience {
  return {
    id: randomUUID(),
    description: input.description,
    description_embedding: [0.1, 0.2, 0.3],
    content: input.content,
    confidence: input.confidence,
    tags: input.tags,
    linked_negative_exp: undefined,
    promoted_to: undefined,
    assumptions: undefined,
    confidence_history: [
      { value: input.confidence, updated_at: input.now, reason: input.reason },
    ],
    referenced_count: 0,
    last_referenced_at: undefined,
    source_task_id: input.snapshot.source_task_id,
    // 零派工没有 driver：空串表示「没有来源 driver」，不虚构一个身份。
    source_driver: sourceDriversLabel(input.snapshot),
    source_user_rating: input.snapshot.user_rating,
    type: input.type,
    created_at: input.now,
    updated_at: input.now,
  };
}

/**
 * v2 提取：
 * - 正经验只来自**可解释的事实**：completed 结局的「执行事实 + Role 反思」，或非 completed
 *   结局里**经证据核验的宿主通过检查**（只写执行事实证明的有效做法，不把失败陈述包装成成功）；
 * - blocked/failed 结局本身一定产出负经验（结构化结束状态 + Role 的如实陈述）；
 * - 失败/未确定派工、未解决项与未通过陈述继续产出负经验；
 * - 没有可提炼内容时返回空结果，不为了「有产出」编一条兜底正经验。
 */
async function extractFromV2(
  snapshot: BufferSnapshotV2,
  verifier: LearningEvidenceVerifier | undefined,
): Promise<ExtractionOutput> {
  const verification = verifier ? await verifier.verify(snapshot) : undefined;
  const grade = gradeLearningInput(snapshot, verification);
  const now = nowTimestamp();
  const experiences: CandidateExperience[] = [];
  const tags = [
    'role_autonomy',
    ...new Set(grade.dispatches.map((dispatch) => dispatch.kind)),
  ];
  const summary = snapshot.role_reflection.summary.trim();
  const status = grade.status;
  const completed = status === 'completed';
  const verifiedPass =
    grade.evidence_verified && grade.dispatches.some(dispatchHasHostObservedPass);

  if (completed && (summary.length > 0 || snapshot.role_reflection.reflection.trim().length > 0)) {
    experiences.push(
      buildV2Experience({
        snapshot,
        now,
        content: buildV2Content(snapshot, grade, { includeRoleReflection: true }),
        description: summary || `Task ${snapshot.task_id} role reflection`,
        type: 'positive',
        confidence: grade.confidence_cap,
        tags,
        reason: `rule-based extraction (v2, ${grade.level})`,
      }),
    );
  } else if (!completed && verifiedPass) {
    // 非成功结局里确有宿主核验通过的子结果：只把这部分事实作为正经验，不夹带 Role 的失败陈述。
    experiences.push(
      buildV2Experience({
        snapshot,
        now,
        content: buildV2Content(snapshot, grade, { includeRoleReflection: false }),
        description: `Verified dispatch facts from a ${status ?? 'unknown-outcome'} run`,
        type: 'positive',
        confidence: grade.confidence_cap,
        tags: [...tags, 'verified_execution_facts'],
        reason: `rule-based extraction (v2, ${grade.level}, non-completed run)`,
      }),
    );
  }

  // 结构化结束状态：blocked/failed 是权威的失败事实，不能只因为摘要非空就消失。
  if (status === 'blocked' || status === 'failed') {
    experiences.push(
      buildV2Experience({
        snapshot,
        now,
        content: [
          `Role end status: ${status}`,
          `Role summary: ${summary || '(none)'}`,
          `Role reflection: ${snapshot.role_reflection.reflection || '(none)'}`,
          ...(snapshot.role_reflection.unresolved.length > 0
            ? [`Unresolved: ${snapshot.role_reflection.unresolved.join('; ')}`]
            : []),
        ].join('\n'),
        description: `Role finished ${status}: ${summary || `task ${snapshot.task_id}`}`,
        type: 'negative',
        confidence: negativeConfidenceCap(),
        tags: [...tags, `role_end_${status}`],
        reason: 'rule-based extraction (v2 negative, role end status)',
      }),
    );
  }

  const failedDispatches = grade.dispatches.filter((dispatch) =>
    ['failed', 'unknown', 'cancelled', 'interrupted'].includes(dispatch.status),
  );
  if (failedDispatches.length > 0) {
    experiences.push(
      buildV2Experience({
        snapshot,
        now,
        content: [
          'Non-successful dispatches:',
          ...failedDispatches.map(
            (dispatch) =>
              `  - ${dispatch.dispatch_id} [${dispatch.kind}] status=${dispatch.status}`,
          ),
          `Role reflection: ${snapshot.role_reflection.reflection || '(none)'}`,
        ].join('\n'),
        description: `Dispatch did not succeed: ${failedDispatches
          .map((dispatch) => `${dispatch.dispatch_id}(${dispatch.status})`)
          .join(', ')}`,
        type: 'negative',
        confidence: negativeConfidenceCap(),
        tags: [...tags, 'dispatch_not_succeeded'],
        reason: 'rule-based extraction (v2 negative)',
      }),
    );
  }

  const failedClaims = snapshot.role_reflection.verification.filter(
    (claim) => claim.outcome !== 'passed',
  );
  if (snapshot.role_reflection.unresolved.length > 0 || failedClaims.length > 0) {
    experiences.push(
      buildV2Experience({
        snapshot,
        now,
        content: [
          ...(snapshot.role_reflection.unresolved.length > 0
            ? ['Unresolved:', ...snapshot.role_reflection.unresolved.map((item) => `  - ${item}`)]
            : []),
          ...failedClaims.map(
            (claim) =>
              `  - [${claim.outcome}] ${claim.requirement}${claim.note ? ` (${claim.note})` : ''}`,
          ),
        ].join('\n'),
        description: 'Task requirements left unresolved or unverified',
        type: 'negative',
        confidence: Math.min(0.4, grade.confidence_cap + 0.1),
        tags: [...tags, 'unresolved_requirement'],
        reason: 'rule-based extraction (v2 negative, role-declared)',
      }),
    );
  }

  return {
    experiences,
    result: {
      experiences_created: experiences.filter((e) => e.type === 'positive').length,
      experiences_updated: 0,
      negative_experiences: experiences.filter((e) => e.type === 'negative').length,
      skills_promoted: 0,
    },
    ...(grade.warnings.length > 0 ? { warnings: [...grade.warnings] } : {}),
  };
}
