/**
 * RuleBasedSkillPromotion — SkillPromotionHandler 的规则版实现
 *
 * 基于经验置信度决定是否将经验晋升为 Skill，替代 MockSkillPromotion 的 scenario 分支。
 *
 * 晋升规则（Spec §4.3）：
 *   1. 仅晋升正经验（type === 'positive'）
 *   2. 置信度严格大于阈值（默认 0.95，可用 options.confidenceThreshold 覆盖——
 *      全自动化测评无人评分时经验置信度难以达标，降阈值是测评侧开关）
 *   3. 尚未被晋升（!promoted_to）
 *   4. 晋升后 SkillRecord.review_status 为 'pending'（需人工审核；测评自动批准走
 *      B 服务 autoApprovePromotedSkills 或 maintenance runner 的 promotion.autoApprove）
 *   5. 原 experience 的 promoted_to 指向新 skill.id
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { ExperienceRecord } from '../schemas';
import type { AgentTaskRequest } from '../agent-types';
import type { PromotionOutcome } from '../types';

export const PROMOTION_CONFIDENCE_THRESHOLD = 0.95;

/** 规则版晋升的选项：confidenceThreshold 覆盖默认 0.95 门槛（全自动化测评用） */
export interface RuleBasedPromotionOptions {
  confidenceThreshold?: number;
}

export async function ruleBasedSkillPromotion(
  memory: AgentMemoryScope,
  _task: AgentTaskRequest,
  experiences: ExperienceRecord[],
  options: RuleBasedPromotionOptions = {},
): Promise<PromotionOutcome> {
  const threshold = options.confidenceThreshold ?? PROMOTION_CONFIDENCE_THRESHOLD;
  const candidate = experiences.find(
    (e) => e.type === 'positive' && e.confidence > threshold && !e.promoted_to,
  );

  if (!candidate) {
    const reasons: string[] = [];
    if (experiences.length === 0) {
      reasons.push('No experiences to evaluate');
    } else {
      const positives = experiences.filter((e) => e.type === 'positive');
      if (positives.length === 0) {
        reasons.push('No positive experiences in batch');
      } else {
        const eligible = positives.filter(
          (e) => e.confidence > threshold && !e.promoted_to,
        );
        if (eligible.length === 0) {
          const alreadyPromoted = positives.filter((e) => e.promoted_to);
          const lowConfidence = positives.filter(
            (e) => e.confidence <= threshold && !e.promoted_to,
          );
          if (alreadyPromoted.length > 0) {
            reasons.push(`${alreadyPromoted.length} positive experience(s) already promoted`);
          }
          if (lowConfidence.length > 0) {
            reasons.push(
              `${lowConfidence.length} positive experience(s) below confidence threshold (${threshold})`,
            );
          }
        }
      }
    }

    return {
      check: {
        eligible: false,
        auto_approved: false,
        reasons: [],
        blocking_rules: reasons,
      },
    };
  }

  const now = nowTimestamp();
  const skillId = randomUUID();

  const skill = {
    id: skillId,
    description: candidate.description,
    description_embedding: candidate.description_embedding,
    content: candidate.content,
    version: '1.0.0',
    review_status: 'pending' as const,
    tags: [...candidate.tags],
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
        `Experience "${candidate.description}" promoted with confidence ${candidate.confidence}`,
      ],
      blocking_rules: [],
    },
    skill,
  };
}
