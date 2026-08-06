/**
 * DefaultPersonaTriggerPolicy — PersonaTriggerPolicy 默认实现
 *
 * 三层触发门控（对应 Spec §4.4 中无需漂移-嵌入即可计算的子集）：
 *   1. 技能增长门控：skill_growth_count >= minSkillDelta（能力方向扩展/收窄）
 *   2. 定期门控：距上次归纳 >= periodicIntervalMs 且有新经验（常规更新）
 *   3. 强制刷新门控：距上次归纳 >= forcedRefreshMs（即使无新经验也刷新"近期表现"）
 *
 * 任一条件满足即触发演化。
 *
 * Future work（Spec §4.4 其余门控，当前无前置能力）：
 * - 经验分布漂移门控（新经验 tags 分布与现有 Persona 的余弦相似度 < 0.6）：
 *   需要 drift-embedding 能力，暂无实现
 * - 技能收缩门控（Skills 减少 >= 2）：需要历史技能基线，version 覆盖策略不保留历史
 */
import type { PersonaTriggerPolicy } from '../ports/persona-trigger-policy';

export class DefaultPersonaTriggerPolicy implements PersonaTriggerPolicy {
  constructor(
    private readonly minSkillDelta = 3,
    private readonly periodicIntervalMs = 7 * 24 * 60 * 60 * 1000,
    private readonly forcedRefreshMs = 30 * 24 * 60 * 60 * 1000,
  ) {}

  shouldEvolve(input: {
    role_id: string;
    skill_growth_count: number;
    new_experience_count: number;
    last_induction_at: Date | null;
  }): boolean {
    // 1. 技能增长门控
    if (input.skill_growth_count >= this.minSkillDelta) {
      return true;
    }

    // 2. 定期门控：距上次归纳 >= 周期 且 有新经验
    if (
      input.last_induction_at !== null &&
      input.new_experience_count > 0 &&
      Date.now() - input.last_induction_at.getTime() >= this.periodicIntervalMs
    ) {
      return true;
    }

    // 3. 强制刷新门控
    if (
      input.last_induction_at !== null &&
      Date.now() - input.last_induction_at.getTime() >= this.forcedRefreshMs
    ) {
      return true;
    }

    return false;
  }
}
