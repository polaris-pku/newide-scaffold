/**
 * RuleBasedExperienceExtractor — ExperienceExtractor 的规则版实现
 *
 * 从 BufferSnapshot.driver_return 的 decisions、assumptions、blockers 等字段
 * 按规则提取真实经验。
 *
 * 提取规则：
 *   1. 正经验（positive）：从 decisions + assumptions 拼装 content
 *   2. 负经验（negative）：逐个未解决 blocker 生成独立负经验
 *   3. 兜底：若以上均无，产出一条最小正经验（tag: auto-generated）
 *
 * 置信度计算：基于 referenced_experiences.effectiveness 加权平均，
 *   再扣除未解决 blocker 惩罚（每个 -0.1），最终 clamp 到 [0.1, 0.95]。
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import type { ExperienceExtractor } from '../ports/experience-extractor';
import type { BufferSnapshot, AgentContextSnapshot, DriverReturn } from '../schemas';
import type { CandidateExperience, ExtractionOutput } from '../types';

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
  async extract(
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<ExtractionOutput> {
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
