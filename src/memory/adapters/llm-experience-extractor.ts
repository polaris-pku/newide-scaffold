/**
 * LlmExperienceExtractor — ExperienceExtractor 的 LLM 实现
 *
 * 调用 LlmClient 从 BufferSnapshot + AgentContextSnapshot 中提取结构化经验，
 * 替代 RuleBasedExperienceExtractor 的纯规则拼接。
 *
 * 提取流程：
 *   1. 组装 prompt（基于 Spec §4.2.3 提取原则）
 *   2. 调用 LLM，要求 JSON 输出
 *   3. Zod 校验返回内容
 *   4. 校验通过 → 映射为 ExperienceRecord[]
 *   5. 校验失败/调用异常 → 降级到 RuleBasedExperienceExtractor
 *
 * 注意空数组语义：LLM 返回 `experiences: []` 表示「本次任务没有满足准入判据的经验」，
 * 是合法结果，直接返回空列表。它**不**触发降级——规则版提取器会把决策与假设原文
 * 重新拼成流水账，正是提取提示词要过滤掉的东西。只有解析失败或调用异常才降级。
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import type { LlmClient } from '../ports/llm-client';
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
import { RuleBasedExperienceExtractor } from './rule-based-experience-extractor';
import { EXTRACTOR_SYSTEM_PROMPT } from '../prompts/experience-extractor';
import {
  gradeLearningInput,
  sourceDriversLabel,
  type LearningInputGrade,
} from '../services/learning-input-grade';

// ═══════════════════════════════════════════
//  LLM response schema
// ═══════════════════════════════════════════

interface LlmExperienceItem {
  description: string;
  content: string;
  type: 'positive' | 'negative';
  confidence: number;
  tags: string[];
}

interface LlmExtractionResponse {
  experiences: LlmExperienceItem[];
}

function parseLlmResponse(raw: string): LlmExtractionResponse {
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM response is not a JSON object');
  }

  const { experiences } = parsed as Record<string, unknown>;
  if (!Array.isArray(experiences)) {
    throw new Error('LLM response missing experiences array');
  }

  for (const [i, exp] of experiences.entries()) {
    if (!exp || typeof exp !== 'object') {
      throw new Error(`Experience #${i} is not an object`);
    }

    const e = exp as Record<string, unknown>;

    if (typeof e.description !== 'string' || e.description.length === 0) {
      throw new Error(`Experience #${i} missing or invalid description`);
    }
    if (typeof e.content !== 'string' || e.content.length === 0) {
      throw new Error(`Experience #${i} missing or invalid content`);
    }
    if (e.type !== 'positive' && e.type !== 'negative') {
      throw new Error(`Experience #${i} type must be 'positive' or 'negative'`);
    }
    if (typeof e.confidence !== 'number' || e.confidence < 0 || e.confidence > 1) {
      throw new Error(`Experience #${i} confidence must be a number in [0, 1]`);
    }
    if (!Array.isArray(e.tags)) {
      throw new Error(`Experience #${i} tags must be an array`);
    }
  }

  return { experiences: experiences as LlmExperienceItem[] };
}

// ═══════════════════════════════════════════
//  Prompt builder
// ═══════════════════════════════════════════

function buildExtractionPrompt(dr: DriverReturn, agentContext?: AgentContextSnapshot): string {  const sections: string[] = [];

  sections.push(`## Driver Report (what was done)
  Summary: ${dr.summary}

  Decisions:
  ${dr.decisions.map((d) => `  - [${d.point}] chose "${d.chosen}" (reason: ${d.reason})`).join('\n') || '  (none)'}

  Blockers:
  ${dr.blockers.map((b) => `  - "${b.blocker}" resolved=${b.resolved} (attempts: ${b.attempts.join(', ')})`).join('\n') || '  (none)'}

  Assumptions:
  ${dr.assumptions.map((a) => `  - "${a.assumption}" (risk: ${a.risk_if_wrong})`).join('\n') || '  (none)'}

  Referenced Experiences:
  ${
    dr.referenced_experiences
      .map((r) => `  - ${r.experience_id}: applied=${r.applied}, effectiveness=${r.effectiveness}`)
      .join('\n') || '  (none)'
  }`);

  // 清理后的上下文是成对的另一半：thinking 说「为什么这么选」，planning 说「打算怎么走」。
  // 两个都给药，提取器才可能归纳出「什么情境下该先做什么」这类可迁移的规律——
  // 只看 Driver 报告，拿到的永远是已经发生的事的转述。
  if (agentContext && (agentContext.thinking_trace || agentContext.planning_trace)) {
    const lines: string[] = [];
    if (agentContext.thinking_trace) lines.push(`Thinking: ${agentContext.thinking_trace}`);
    if (agentContext.planning_trace) lines.push(`Planning: ${agentContext.planning_trace}`);
    sections.push(`## Agent Context (why it was done)\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}

// Prompt 已移至 prompts/experience-extractor.ts

/**
 * v2 学习输入的提取提示词：执行事实、Role 反思、结束状态与来源分级分开陈述。
 *
 * 关键约束写进提示词也写进后处理（置信度按来源上限截断）：Role 的 `passed` 陈述与
 * driver 自述都只是 dependent 输入，没有宿主观察证据时不能当成「已验证通过」。结束状态
 * 是结构化的 `role_reflection.status`（blocked/failed 表示任务未完成），不是从摘要文本猜的。
 */
function buildV2ExtractionPrompt(
  snapshot: BufferSnapshotV2,
  grade: LearningInputGrade,
): string {
  const reflection = snapshot.role_reflection;
  const dispatchLines =
    grade.dispatches.map(
      (dispatch) =>
        `  - ${dispatch.dispatch_id} [${dispatch.kind}] status=${dispatch.status}` +
        ` host_observed_passed=${String(dispatch.checks.host_observed_passed)}` +
        ` host_observed_failed=${String(dispatch.checks.host_observed_failed)}` +
        ` driver_reported=${String(dispatch.checks.driver_reported)}` +
        ` missing=${String(dispatch.checks.missing)}` +
        ` evidence=${dispatch.evidence_ref ? 'yes' : 'no'}`,
    ) || [];
  return [
    '## Execution facts (host-observed evidence summary, not a driver report)',
    dispatchLines.length > 0 ? dispatchLines.join('\n') : '  (zero-dispatch task)',
    `Journal prefix: ${snapshot.journal_ref.path} lines=${String(snapshot.journal_ref.lines)} sha256=${snapshot.journal_ref.sha256}`,
    `Evidence verification: ${grade.evidence_verified ? 'verified (journal/evidence refs matched)' : 'NOT verified — treat the counts above as Buffer-declared material only'}`,
    '',
    '## Role end status (structured, from the accepted finish; not inferred from prose)',
    `status=${grade.status ?? 'unknown (missing; do not assume completed)'}`,
    ...(grade.status !== undefined && grade.status !== 'completed'
      ? [
          `The task did not complete (${grade.status}). Do not present the failure statement as a successful outcome.`,
          'You may still extract a positive practice only from verified execution facts.',
        ]
      : []),
    '',
    '## Role reflection (dependent — the role said this, it is not independent evidence)',
    `Summary: ${reflection.summary}`,
    `Reflection: ${reflection.reflection || '(none)'}`,
    `Unresolved: ${reflection.unresolved.join('; ') || '(none)'}`,
    `Verification claims: ${
      reflection.verification
        .map(
          (claim) =>
            `${claim.outcome}: ${claim.requirement}` +
            (claim.dispatch_ids.length > 0 ? ` [dispatches: ${claim.dispatch_ids.join(', ')}]` : ''),
        )
        .join(' | ') || '(none)'
    }`,
    `Memory used (dependent): ${
      reflection.memory_used.map((entry) => `${entry.kind}:${entry.id}`).join(', ') || '(none)'
    }`,
    '',
    '## Source grading',
    `level=${grade.level}; positive-experience confidence must not exceed ${String(grade.confidence_cap)}.`,
    'Never claim that tests/builds passed unless host_observed_passed > 0 for a dispatch whose evidence was verified.',
  ].join('\n');
}

/** v2 候选经验：置信度以来源分级上限截断，置信度历史记录截断原因。 */
function toV2ExperienceRecords(
  items: LlmExperienceItem[],
  snapshot: BufferSnapshotV2,
  grade: LearningInputGrade,
): CandidateExperience[] {
  const now = nowTimestamp();
  const source_driver = sourceDriversLabel(snapshot);
  return items.map((item) => {
    const capped = Math.min(item.confidence, grade.confidence_cap);
    return {
      id: randomUUID(),
      description: item.description,
      description_embedding: [0.1, 0.2, 0.3],
      content: item.content,
      confidence: capped,
      tags: item.tags,
      linked_negative_exp: undefined,
      promoted_to: undefined,
      assumptions: undefined,
      confidence_history: [
        {
          value: capped,
          updated_at: now,
          reason:
            capped < item.confidence
              ? `llm extraction (v2, ${grade.level}; capped from ${String(item.confidence)})`
              : `llm extraction (v2, ${grade.level})`,
        },
      ],
      referenced_count: 0,
      last_referenced_at: undefined,
      source_task_id: snapshot.source_task_id,
      source_driver,
      source_user_rating: snapshot.user_rating,
      type: item.type,
      created_at: now,
      updated_at: now,
    };
  });
}

// ═══════════════════════════════════════════
//  Experience mapper
// ═══════════════════════════════════════════

function toExperienceRecords(
  items: LlmExperienceItem[],
  snapshot: BufferSnapshot,
): CandidateExperience[] {
  const now = nowTimestamp();

  return items.map((item) => ({
    id: randomUUID(),
    description: item.description,
    description_embedding: [0.1, 0.2, 0.3],
    content: item.content,
    confidence: item.confidence,
    tags: item.tags,
    // 归属不在这里定，这里也**不产出**归属字段：一条 Buffer 属于哪个 Agent 只有
    // memory.role_id 说得准，提取器拿不到它（无上下文快照时连 agentContext 都没有）。
    // 填一个占位值就会让直接使用提取器的维护系统把经验挂错人；**更不要拿
    // source_task_id 顶替**——那是任务溯源字段，不是归属。agent_id 由
    // persistExtractedExperiences 按 memory.role_id 统一补齐。
    linked_negative_exp: undefined,
    promoted_to: undefined,
    assumptions: undefined,
    confidence_history: [{ value: item.confidence, updated_at: now, reason: 'llm extraction' }],
    referenced_count: 0,
    last_referenced_at: undefined,
    source_task_id: snapshot.source_task_id,
    source_driver: snapshot.source_driver,
    source_user_rating: undefined,
    type: item.type,
    created_at: now,
    updated_at: now,
  }));
}

// ═══════════════════════════════════════════
//  Main extractor
// ═══════════════════════════════════════════

export class LlmExperienceExtractor implements ExperienceExtractor {
  private readonly fallback: RuleBasedExperienceExtractor;
  private readonly evidence: LearningEvidenceVerifier | undefined;

  constructor(
    private readonly llm: LlmClient,
    options: { evidence?: LearningEvidenceVerifier } = {},
  ) {
    this.fallback = new RuleBasedExperienceExtractor(
      options.evidence !== undefined ? { evidence: options.evidence } : {},
    );
    this.evidence = options.evidence;
  }

  async extract(
    snapshot: BufferSnapshotLike,
    agentContext?: AgentContextSnapshot,
  ): Promise<ExtractionOutput> {
    try {
      if (isBufferSnapshotV2(snapshot)) {
        return await this.extractV2(snapshot);
      }
      const userPrompt = buildExtractionPrompt(snapshot.driver_return, agentContext);

      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: EXTRACTOR_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        responseFormat: { type: 'json_object' },
      });

      const parsed = parseLlmResponse(raw);

      const experiences = toExperienceRecords(parsed.experiences, snapshot);

      return {
        experiences,
        result: {
          experiences_created: experiences.filter((e) => e.type === 'positive').length,
          experiences_updated: 0,
          negative_experiences: experiences.filter((e) => e.type === 'negative').length,
          skills_promoted: 0,
        },
      };
    } catch (error) {
      // 降级必须留痕：真实 run 里出现过 3 个角色中 2 个静默降级、
      // 维护记录 warnings 为空，事后无从判断降级原因。
      const fallback = await this.fallback.extract(snapshot, agentContext);
      return {
        ...fallback,
        warnings: [
          ...(fallback.warnings ?? []),
          `LLM extraction failed; fell back to rule-based: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }
  }

  /** v2 分支：先做受控证据核验，提示词按真实结束状态与来源分级，返回置信度再次按上限截断。 */
  private async extractV2(snapshot: BufferSnapshotV2): Promise<ExtractionOutput> {
    const verification = this.evidence ? await this.evidence.verify(snapshot) : undefined;
    const grade = gradeLearningInput(snapshot, verification);
    const raw = await this.llm.complete({
      messages: [
        { role: 'system', content: EXTRACTOR_SYSTEM_PROMPT },
        { role: 'user', content: buildV2ExtractionPrompt(snapshot, grade) },
      ],
      responseFormat: { type: 'json_object' },
    });

    const parsed = parseLlmResponse(raw);
    const experiences = toV2ExperienceRecords(parsed.experiences, snapshot, grade);
    const warnings = [...grade.warnings];
    return {
      experiences,
      result: {
        experiences_created: experiences.filter((e) => e.type === 'positive').length,
        experiences_updated: 0,
        negative_experiences: experiences.filter((e) => e.type === 'negative').length,
        skills_promoted: 0,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}
