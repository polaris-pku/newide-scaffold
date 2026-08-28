/**
 * SkillPromotionProcessor — 技能晋升处理器
 *
 * 扫描 Agent 已保存的未晋升经验，检查 eligibility 后晋升为 Skill。
 * 不依赖 buffer；仅基于已有的 ExperienceRecord。
 *
 * 两种调用模式：
 *   - promoteAll()      : 手动模式，晋升所有符合条件的经验
 *   - checkAndPromote() : 自动模式，先评估 PromotionTriggerPolicy，满足条件再晋升
 */
import { randomUUID } from 'node:crypto';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { PromotionTriggerPolicy } from '../ports/promotion-trigger-policy';
import type { ExperienceRecord } from '../schemas';
import type { AgentTaskRequest } from '../agent-types';
import type { PromotionOutcome } from '../types';
import {
  PROMOTION_CONFIDENCE_THRESHOLD,
  type RuleBasedPromotionOptions,
} from '../services/skill-promotion';

export type SkillPromotionHandler = (
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  experiences: ExperienceRecord[],
  /** 晋升选项透传（如 confidenceThreshold）；不支持选项的 handler 可忽略 */
  options?: RuleBasedPromotionOptions,
) => Promise<PromotionOutcome>;

/** 高置信度门槛（用于 PromotionTriggerPolicy 的 has_high_confidence 判断） */
const HIGH_CONFIDENCE_THRESHOLD = 0.98;

export class SkillPromotionProcessor {
  private readonly confidenceThreshold: number;

  constructor(
    private readonly policy: PromotionTriggerPolicy,
    private readonly promote: SkillPromotionHandler,
    options: { confidenceThreshold?: number } = {},
  ) {
    this.confidenceThreshold = options.confidenceThreshold ?? PROMOTION_CONFIDENCE_THRESHOLD;
  }

  /**
   * 手动模式：晋升所有符合条件的经验。
   *
   * 筛选条件（与 Spec §4.3 一致，阈值可用构造选项覆盖）：
   *   - type === 'positive'
   *   - confidence > 阈值（默认 0.95）
   *   - promoted_to === undefined
   */
  async promoteAll(memory: AgentMemoryScope): Promise<PromotionOutcome[]> {
    const eligible = await this.findEligibleExperiences(memory);
    if (eligible.length === 0) {
      return [];
    }

    const results: PromotionOutcome[] = [];
    for (const experience of eligible) {
      const outcome = await this.promoteOne(memory, experience);
      results.push(outcome);
    }

    return results;
  }

  /**
   * 自动模式：先评估 PromotionTriggerPolicy，满足条件才晋升。
   *
   * @returns 晋升结果列表；未触发时返回空数组
   */
  async checkAndPromote(memory: AgentMemoryScope): Promise<PromotionOutcome[]> {
    const allExperiences = await memory.listExperiences();
    const eligible = this.filterEligible(allExperiences);

    if (eligible.length === 0) {
      return [];
    }

    const hasHighConfidence = eligible.some((e) => e.confidence > HIGH_CONFIDENCE_THRESHOLD);
    const lastPromotionAt = await this.getLastPromotionAt(memory);

    if (
      !this.policy.shouldPromote({
        role_id: memory.role_id,
        eligible_count: eligible.length,
        has_high_confidence: hasHighConfidence,
        last_promotion_at: lastPromotionAt,
      })
    ) {
      return [];
    }

    // 触发晋升
    const results: PromotionOutcome[] = [];
    for (const experience of eligible) {
      const outcome = await this.promoteOne(memory, experience);
      results.push(outcome);
    }

    return results;
  }

  /**
   * 晋升单条经验：调用 promote handler → saveSkill → updateExperience。
   * 处理器自身过滤与 handler 判定共用同一阈值（通过 options 透传），
   * 避免 filter 放行后 handler 按默认 0.95 复查而拒绝。
   */
  private async promoteOne(
    memory: AgentMemoryScope,
    experience: ExperienceRecord,
  ): Promise<PromotionOutcome> {
    const dummyTask = {
      spec: 'skill-promotion',
      task_id: `promotion-${randomUUID()}`,
      call_id: `promotion-${randomUUID()}`,
      source_driver: 'promotion-processor',
    };

    const outcome = await this.promote(memory, dummyTask, [experience], {
      confidenceThreshold: this.confidenceThreshold,
    });
    return outcome;
  }

  /**
   * 查找所有符合条件的经验（未晋升、正经验、高置信度）。
   */
  private async findEligibleExperiences(memory: AgentMemoryScope): Promise<ExperienceRecord[]> {
    const all = await memory.listExperiences();
    return this.filterEligible(all);
  }

  private filterEligible(experiences: ExperienceRecord[]): ExperienceRecord[] {
    return experiences.filter(
      (e) =>
        e.type === 'positive' &&
        e.confidence > this.confidenceThreshold &&
        e.promoted_to === undefined,
    );
  }

  /**
   * 获取最近一次晋升时间（从已有技能的 promoted_at 中取最大值）。
   */
  private async getLastPromotionAt(memory: AgentMemoryScope): Promise<Date | null> {
    const skills = await memory.listSkills();
    if (skills.length === 0) {
      return null;
    }

    const latest = skills.reduce<Date | null>((latest, skill) => {
      const promotedAt = new Date(skill.promoted_at);
      return latest === null || promotedAt > latest ? promotedAt : latest;
    }, null);

    return latest;
  }
}
