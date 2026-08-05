/**
 * ruleBasedPersonaInduction — PersonaInductionHandler 的规则版实现
 *
 * 基于 Agent 已保存的 Experiences / Skills 启发式重写 PersonaDef 的四个自由文本字段：
 *   - summary            角色定位摘要（复用当前 persona 定位 + 技能/经验规模）
 *   - skills_overview    技能覆盖（按 tags 聚合，保留来源技能描述要点）
 *   - experience_coverage 经验覆盖（按描述聚合，标注正/负经验与置信度范围）
 *   - recent_performance 近期表现（复用当前 persona 的近期表现，避免规则版编造）
 *   - notes              演化来源说明（触发方式与数据规模）
 *
 * 版本号固定为 currentPersona.version + 1，绝不依赖外部输入或 LLM 输出；
 * 写入通过 AgentMemoryScope.savePersona() 完成（镜像 ruleBasedSkillPromotion 内部 saveSkill）。
 */
import { nowTimestamp } from '../../core';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { ExperienceRecord, PersonaDef, SkillRecord } from '../schemas';
import type { PersonaEvolutionOutcome } from '../types';

/** 归纳输入：processor 只读数据后传入 */
export interface PersonaInductionInput {
  role_id: string;
  currentPersona: PersonaDef;
  experiences: ExperienceRecord[];
  skills: SkillRecord[];
}

/** 取标签集合中最高频的若干标签 */
function topTags(
  records: Array<{ tags: string[] }>,
  limit: number,
): string[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const tag of record.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}

/** 生成技能覆盖概述：优先高频 tags，否则给出技能描述要点 */
function buildSkillsOverview(skills: SkillRecord[]): string {
  if (skills.length === 0) {
    return 'No skills yet.';
  }
  const tags = topTags(skills, 5);
  const scope = tags.length > 0 ? `Focus tags: ${tags.join(', ')}.` : 'Generalist.';
  return `${skills.length} skills promoted. ${scope} Latest: ${skills
    .slice(-3)
    .map((s) => s.description)
    .join('; ')}.`;
}

/** 生成经验覆盖概述：统计正/负经验与置信度范围，附带高频标签 */
function buildExperienceCoverage(experiences: ExperienceRecord[]): string {
  if (experiences.length === 0) {
    return 'No experiences yet.';
  }
  const positive = experiences.filter((e) => e.type === 'positive').length;
  const negative = experiences.length - positive;
  const confidences = experiences.map((e) => e.confidence);
  const maxConfidence = Math.max(...confidences).toFixed(2);
  const tags = topTags(experiences, 5);
  const tagLine = tags.length > 0 ? ` Common tags: ${tags.join(', ')}.` : '';
  return `${experiences.length} experiences (${positive} positive / ${negative} negative), max confidence ${maxConfidence}.${tagLine}`;
}

/**
 * 规则版 Persona 归纳：启发式重写四个自由文本字段并写入新 Persona。
 *
 * @param memory 绑定了 role_id 的记忆作用域（写入通过 memory.savePersona）
 * @param input  只读输入：当前 Persona、经验、技能
 */
export async function ruleBasedPersonaInduction(
  memory: AgentMemoryScope,
  input: PersonaInductionInput,
): Promise<PersonaEvolutionOutcome> {
  const { role_id, currentPersona, experiences, skills } = input;

  const next: PersonaDef = {
    role_id,
    version: currentPersona.version + 1,
    summary: currentPersona.summary,
    skills_overview: buildSkillsOverview(skills),
    experience_coverage: buildExperienceCoverage(experiences),
    recent_performance: currentPersona.recent_performance,
    notes: `Evolved by ruleBasedPersonaInduction from v${currentPersona.version}: ${skills.length} skills, ${experiences.length} experiences.`,
    generated_at: nowTimestamp(),
  };

  await memory.savePersona(next);

  return {
    check: {
      eligible: true,
      auto_approved: true,
      reasons: [
        `Persona re-induced for ${role_id} from ${skills.length} skills and ${experiences.length} experiences (v${currentPersona.version} → v${next.version})`,
      ],
      blocking_rules: [],
    },
    persona: next,
  };
}
