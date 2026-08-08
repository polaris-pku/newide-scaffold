/**
 * PersonaTriggerPolicy 端口
 *
 * 决定何时对 Agent 重新归纳 Persona（Persona 演化）。
 * 与 PromotionTriggerPolicy 同构：由 Processor 计算输入，策略只做纯判断。
 *
 * 演化触发条件（由各实现定义，Spec §4.4）：
 * - 技能增长门控：自上次归纳后新增技能数 >= 阈值（能力方向扩展）
 * - 定期门控：距上次归纳 >= 周期且产生新经验（常规更新）
 * - 强制刷新门控：距上次归纳 >= 上限（即使无新经验也刷新"近期表现"）
 */
export interface PersonaTriggerPolicy {
  /** 判断当前是否应触发 Persona 演化 */
  shouldEvolve(input: {
    /** 目标 Agent ID */
    role_id: string;
    /** 自上次归纳后新增的技能数（基于 created_at 过滤） */
    skill_growth_count: number;
    /** 自上次归纳后新增的经验数 */
    new_experience_count: number;
    /** 最近一次归纳时间（当前 persona.generated_at，null 表示从未演化） */
    last_induction_at: Date | null;
  }): boolean;
}
