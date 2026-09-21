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
import type {
  BufferSnapshot,
  AgentContextSnapshot,
  ExperienceRecord,
  DriverReturn,
} from '../schemas';
import type { ExtractionOutput } from '../types';
import { RuleBasedExperienceExtractor } from './rule-based-experience-extractor';
import { EXTRACTOR_SYSTEM_PROMPT } from '../prompts/experience-extractor';

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

function buildExtractionPrompt(dr: DriverReturn, agentContext?: AgentContextSnapshot): string {
  const sections: string[] = [];

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

  if (agentContext?.thinking_trace) {
    sections.push(`## Agent Context (why it was done)\nThinking: ${agentContext.thinking_trace}`);
  }

  return sections.join('\n\n');
}

// Prompt 已移至 prompts/experience-extractor.ts

// ═══════════════════════════════════════════
//  Experience mapper
// ═══════════════════════════════════════════

function toExperienceRecords(
  items: LlmExperienceItem[],
  snapshot: BufferSnapshot,
  agentContext?: AgentContextSnapshot,
): ExperienceRecord[] {
  const now = nowTimestamp();
  const agent_id = agentContext?.agent_id ?? snapshot.source_task_id;

  return items.map((item) => ({
    id: randomUUID(),
    description: item.description,
    description_embedding: [0.1, 0.2, 0.3],
    content: item.content,
    confidence: item.confidence,
    tags: item.tags,
    agent_id,
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

  constructor(private readonly llm: LlmClient) {
    this.fallback = new RuleBasedExperienceExtractor();
  }

  async extract(
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<ExtractionOutput> {
    try {
      const userPrompt = buildExtractionPrompt(snapshot.driver_return, agentContext);

      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: EXTRACTOR_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        responseFormat: { type: 'json_object' },
      });

      const parsed = parseLlmResponse(raw);

      const experiences = toExperienceRecords(parsed.experiences, snapshot, agentContext);

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
}
