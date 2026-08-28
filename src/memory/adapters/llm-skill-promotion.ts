/**
 * LlmSkillPromotion — SkillPromotionHandler 的 LLM 增强实现
 *
 * 系统逻辑判断 eligibility（type === 'positive' && confidence > 阈值 && !promoted_to，
 * 默认阈值 0.95，构造时可注入 confidenceThreshold 覆盖——全自动化测评降阈值用），
 * 符合条件后调用 LLM 将经验泛化为更通用的 SkillRecord（description / content / tags 由 LLM 改写）。
 *
 * 处理流程：
 *   1. eligibility 检查（与 ruleBasedSkillPromotion 一致）
 *   2. 调用 LLM 输出 JSON { description, content, tags }
 *   3. 校验通过 → 填充系统字段 → 入库
 *   4. 校验失败/异常 → 降级到 ruleBasedSkillPromotion
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import type { LlmClient } from '../ports/llm-client';
import type { ExperienceRecord } from '../schemas';
import type { AgentTaskRequest } from '../agent-types';
import type { PromotionOutcome } from '../types';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import {
  PROMOTION_CONFIDENCE_THRESHOLD,
  ruleBasedSkillPromotion,
  type RuleBasedPromotionOptions,
} from '../services/skill-promotion';
import { PROMOTER_SYSTEM_PROMPT } from '../prompts/skill-promotion';

// ═══════════════════════════════════════════
//  LLM response schema
// ═══════════════════════════════════════════

function parseLlmResponse(raw: string): { description: string; content: string; tags: string[] } {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM response is not a JSON object');
  }

  const description = parsed.description;
  const content = parsed.content;
  const tags = parsed.tags;

  if (typeof description !== 'string' || description.length === 0) {
    throw new Error('LLM response missing or empty description');
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('LLM response missing or empty content');
  }
  if (!Array.isArray(tags)) {
    throw new Error('LLM response tags must be an array');
  }
  if (tags.length > 0 && !tags.every((t: unknown) => typeof t === 'string')) {
    throw new Error('LLM response tags must be an array of strings');
  }

  return { description, content, tags: tags as string[] };
}

// ═══════════════════════════════════════════
//  Prompt builder
// ═══════════════════════════════════════════

function buildPromotionPrompt(candidate: ExperienceRecord): string {
  const sections: string[] = [];

  sections.push(`## Experience to promote

Description: ${candidate.description}
Content: ${candidate.content}
Tags: ${candidate.tags.join(', ')}`);

  if (candidate.linked_negative_exp && candidate.linked_negative_exp.length > 0) {
    sections.push(`Related negative experiences: ${candidate.linked_negative_exp.join(', ')}`);
  }

  return sections.join('\n\n');
}

// Prompt 已移至 prompts/skill-promotion.ts

// ═══════════════════════════════════════════
//  Main promoter
// ═══════════════════════════════════════════

export class LlmSkillPromotion {
  private readonly confidenceThreshold: number;

  constructor(
    private readonly llm: LlmClient,
    options: { confidenceThreshold?: number } = {},
  ) {
    this.confidenceThreshold = options.confidenceThreshold ?? PROMOTION_CONFIDENCE_THRESHOLD;
  }

  promote = async (
    memory: AgentMemoryScope,
    _task: AgentTaskRequest,
    experiences: ExperienceRecord[],
  ): Promise<PromotionOutcome> => {
    const candidate = experiences.find(
      (e) =>
        e.type === 'positive' && e.confidence > this.confidenceThreshold && !e.promoted_to,
    );

    if (!candidate) {
      const fallbackOptions: RuleBasedPromotionOptions = {
        confidenceThreshold: this.confidenceThreshold,
      };
      return ruleBasedSkillPromotion(memory, _task, experiences, fallbackOptions);
    }

    try {
      const userPrompt = buildPromotionPrompt(candidate);

      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: PROMOTER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        responseFormat: { type: 'json_object' },
      });

      const parsed = parseLlmResponse(raw);

      const now = nowTimestamp();
      const skillId = randomUUID();

      const skill = {
        id: skillId,
        description: parsed.description,
        description_embedding: candidate.description_embedding,
        content: parsed.content,
        version: '1.0.0',
        review_status: 'pending' as const,
        tags: parsed.tags,
        promoted_from: candidate.id,
        promoted_at: now,
        agent_id: memory.role_id,
        market_status: 'available' as const,
        created_at: now,
        updated_at: now,
      };

      await memory.saveSkill(skill);
      await memory.updateExperience({ ...candidate, promoted_to: skillId });

      return {
        check: {
          eligible: true,
          auto_approved: false,
          reasons: [
            `Experience "${candidate.description}" promoted via LLM refinement, confidence ${candidate.confidence}`,
          ],
          blocking_rules: [],
        },
        skill,
      };
    } catch {
      const fallbackOptions: RuleBasedPromotionOptions = {
        confidenceThreshold: this.confidenceThreshold,
      };
      return ruleBasedSkillPromotion(memory, _task, experiences, fallbackOptions);
    }
  };
}
