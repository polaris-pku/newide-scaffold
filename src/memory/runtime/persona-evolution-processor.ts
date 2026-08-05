/**
 * PersonaEvolutionProcessor — Persona 演化处理器
 *
 * 基于 Agent 已保存的 Experiences / Skills 重新归纳 PersonaDef（version 递增）。
 * 不依赖 buffer；仅基于已有的 ExperienceRecord / SkillRecord / 当前 Persona。
 *
 * 两种调用模式：
 *   - evolveAll()       : 手动模式，直接重新归纳当前 Persona
 *   - checkAndEvolve()  : 自动模式，先评估 PersonaTriggerPolicy，满足条件再归纳
 *
 * 与 SkillPromotionProcessor 同构：策略 + handler 均为构造注入（开放闭合），
 * AgentMemoryScope 按调用传入；本文件不包含任何具体归纳实现。
 */
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { PersonaTriggerPolicy } from '../ports/persona-trigger-policy';
import type { PersonaEvolutionOutcome } from '../types';
import type { PersonaInductionInput } from '../services/rule-based-persona-induction';

export type PersonaInductionHandler = (
  memory: AgentMemoryScope,
  input: PersonaInductionInput,
) => Promise<PersonaEvolutionOutcome>;

export class PersonaEvolutionProcessor {
  constructor(
    private readonly policy: PersonaTriggerPolicy,
    private readonly induce: PersonaInductionHandler,
  ) {}

  /**
   * 手动模式：直接重新归纳当前 Persona。
   *
   * @returns 演化结果列表（Persona 为单实体，最多一个元素）；无数据时为空数组
   */
  async evolveAll(memory: AgentMemoryScope): Promise<PersonaEvolutionOutcome[]> {
    return this.evolveOne(memory);
  }

  /**
   * 自动模式：先评估 PersonaTriggerPolicy，满足条件才归纳。
   *
   * 演化输入基于"自上次归纳后新增"的增量计算（created_at > persona.generated_at），
   * 无需额外存储历史基线。
   *
   * @returns 演化结果列表；未触发时返回空数组
   */
  async checkAndEvolve(memory: AgentMemoryScope): Promise<PersonaEvolutionOutcome[]> {
    const [current, experiences, skills] = await Promise.all([
      memory.getPersona(),
      memory.listExperiences(),
      memory.listSkills(),
    ]);

    const lastInductionAt = new Date(current.generated_at);
    const skillGrowthCount = skills.filter(
      (s) => new Date(s.created_at).getTime() > lastInductionAt.getTime(),
    ).length;
    const newExperienceCount = experiences.filter(
      (e) => new Date(e.created_at).getTime() > lastInductionAt.getTime(),
    ).length;

    if (
      !this.policy.shouldEvolve({
        role_id: memory.role_id,
        skill_growth_count: skillGrowthCount,
        new_experience_count: newExperienceCount,
        last_induction_at: lastInductionAt,
      })
    ) {
      return [];
    }

    return this.evolveOne(memory);
  }

  /**
   * 重新归纳单次 Persona：读取当前 Persona / 经验 / 技能，调用 handler 完成归纳与写入。
   */
  private async evolveOne(memory: AgentMemoryScope): Promise<PersonaEvolutionOutcome[]> {
    const [current, experiences, skills] = await Promise.all([
      memory.getPersona(),
      memory.listExperiences(),
      memory.listSkills(),
    ]);

    const outcome = await this.induce(memory, {
      role_id: memory.role_id,
      currentPersona: current,
      experiences,
      skills,
    });

    return [outcome];
  }
}
