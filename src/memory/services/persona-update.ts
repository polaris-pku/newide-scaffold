/**
 * PersonaUpdate — Persona 手动更新与按需重生成服务
 *
 * 对应方案书 M3（局限 1.3 / L6）：为前端提供
 *   - mergePersonaPatch：PATCH 语义合并 Persona 自由文本字段并 version+1（读-改-写）
 *   - regeneratePersona：基于当前 skills / experiences 按需重新归纳
 *     （LLM 版 LlmPersonaInduction，失败自动降级规则版 ruleBasedPersonaInduction）
 *
 * 与 memory-writer 同模式：纯函数式，repository / buffer 直接注入；归纳器以
 * PersonaInducer 注入，便于测试注入确定性实现。
 */
import { nowTimestamp } from '../../core';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { BufferRepository } from '../ports/buffer-repository';
import type { MemoryRepository } from '../ports/memory-repository';
import type { PersonaDef } from '../schemas';
import type { PersonaInductionInput } from './rule-based-persona-induction';
import type { PersonaEvolutionOutcome } from '../types';

/** Persona 自由文本字段 PATCH 补丁（未提供的字段保持不变） */
export interface PersonaPatch {
  summary?: string;
  skills_overview?: string;
  experience_coverage?: string;
  recent_performance?: string;
  notes?: string;
}

/** 归纳器：输入只读数据，通过 memory.savePersona 写回新 Persona */
export type PersonaInducer = (
  memory: AgentMemoryScope,
  input: PersonaInductionInput,
) => Promise<PersonaEvolutionOutcome>;

/**
 * PATCH 更新 Persona：读当前 → 合并补丁 → version+1 → savePersona。
 * generated_at 刷新；返回更新后的 PersonaDef。
 */
export async function mergePersonaPatch(
  repository: MemoryRepository,
  role_id: string,
  patch: PersonaPatch,
): Promise<PersonaDef> {
  const current = await repository.getPersona(role_id);
  const next: PersonaDef = {
    ...current,
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    ...(patch.skills_overview !== undefined ? { skills_overview: patch.skills_overview } : {}),
    ...(patch.experience_coverage !== undefined
      ? { experience_coverage: patch.experience_coverage }
      : {}),
    ...(patch.recent_performance !== undefined
      ? { recent_performance: patch.recent_performance }
      : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    version: current.version + 1,
    generated_at: nowTimestamp(),
  };
  await repository.savePersona(role_id, next);
  return next;
}

/**
 * 按需重新生成 Persona：读取当前 Persona + experiences + skills，委托注入的
 * 归纳器写回新 Persona（LLM 归纳失败自动降级规则版，见 LlmPersonaInduction）。
 */
export async function regeneratePersona(
  repository: MemoryRepository,
  bufferRepository: BufferRepository,
  role_id: string,
  inducer: PersonaInducer,
): Promise<PersonaDef> {
  const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
  const [currentPersona, experiences, skills] = await Promise.all([
    repository.getPersona(role_id),
    repository.listExperiences(role_id),
    repository.listSkills(role_id),
  ]);
  const outcome = await inducer(memory, {
    role_id,
    currentPersona,
    experiences,
    skills,
  });
  if (!outcome.persona) {
    throw new Error(`Persona regeneration produced no persona for ${role_id}`);
  }
  return outcome.persona;
}
