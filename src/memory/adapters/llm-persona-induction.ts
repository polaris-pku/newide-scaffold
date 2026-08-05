/**
 * LlmPersonaInduction — PersonaInductionHandler 的 LLM 增强实现
 *
 * 调用 LLM 将 Agent 的 Experiences / Skills 归纳为 PersonaDef 的四个自由文本字段
 * （summary / skills_overview / experience_coverage / recent_performance），
 * 版本号与 role_id 由归纳流程固定填充，不取 LLM 输出。
 *
 * 处理流程：
 *   1. 构造归纳输入 → 调用 LLM 输出 JSON { summary, skills_overview, experience_coverage, recent_performance }
 *   2. 校验通过 → 填充系统字段（version+1 / generated_at）→ 写入 memory.savePersona
 *   3. 校验失败/异常/空结果 → 降级到 ruleBasedPersonaInduction
 */
import { nowTimestamp } from '../../core';
import type { LlmClient } from '../ports/llm-client';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { PersonaDef } from '../schemas';
import { ruleBasedPersonaInduction, type PersonaInductionInput } from '../services/rule-based-persona-induction';
import { PERSONA_INDUCER_SYSTEM_PROMPT } from '../prompts/persona-inducer';
import type { PersonaEvolutionOutcome } from '../types';

// ═══════════════════════════════════════════
//  LLM response schema
// ═══════════════════════════════════════════

interface LlmPersonaFields {
  summary: string;
  skills_overview: string;
  experience_coverage: string;
  recent_performance: string;
}

function parseLlmResponse(raw: string): LlmPersonaFields {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM response is not a JSON object');
  }

  const summary = parsed.summary;
  const skills_overview = parsed.skills_overview;
  const experience_coverage = parsed.experience_coverage;
  const recent_performance = parsed.recent_performance;

  if (typeof summary !== 'string' || summary.length === 0) {
    throw new Error('LLM response missing or empty summary');
  }
  if (typeof skills_overview !== 'string' || skills_overview.length === 0) {
    throw new Error('LLM response missing or empty skills_overview');
  }
  if (typeof experience_coverage !== 'string' || experience_coverage.length === 0) {
    throw new Error('LLM response missing or empty experience_coverage');
  }
  if (typeof recent_performance !== 'string' || recent_performance.length === 0) {
    throw new Error('LLM response missing or empty recent_performance');
  }

  return { summary, skills_overview, experience_coverage, recent_performance };
}

// ═══════════════════════════════════════════
//  Prompt builder
// ═══════════════════════════════════════════

function buildInductionPrompt(input: PersonaInductionInput): string {
  const sections: string[] = [];

  sections.push(`## Agent role
${input.role_id}

## Current persona
Summary: ${input.currentPersona.summary}`);

  if (input.skills.length > 0) {
    const skillLines = input.skills
      .slice(-10)
      .map((s) => `- ${s.description} [${s.tags.join(', ')}]`)
      .join('\n');
    sections.push(`## Skills (${input.skills.length})
${skillLines}`);
  }

  if (input.experiences.length > 0) {
    const expLines = input.experiences
      .slice(-10)
      .map(
        (e) =>
          `- ${e.type} (confidence ${e.confidence}): ${e.description} [${e.tags.join(', ')}]`,
      )
      .join('\n');
    sections.push(`## Experiences (${input.experiences.length})
${expLines}`);
  }

  return sections.join('\n\n');
}

// ═══════════════════════════════════════════
//  Main inducer
// ═══════════════════════════════════════════

export class LlmPersonaInduction {
  constructor(private readonly llm: LlmClient) {}

  induce = async (
    memory: AgentMemoryScope,
    input: PersonaInductionInput,
  ): Promise<PersonaEvolutionOutcome> => {
    try {
      const userPrompt = buildInductionPrompt(input);

      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: PERSONA_INDUCER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        responseFormat: { type: 'json_object' },
      });

      const parsed = parseLlmResponse(raw);

      const next: PersonaDef = {
        role_id: input.role_id,
        version: input.currentPersona.version + 1,
        summary: parsed.summary,
        skills_overview: parsed.skills_overview,
        experience_coverage: parsed.experience_coverage,
        recent_performance: parsed.recent_performance,
        notes: `Evolved by LlmPersonaInduction from v${input.currentPersona.version}: ${input.skills.length} skills, ${input.experiences.length} experiences.`,
        generated_at: nowTimestamp(),
      };

      await memory.savePersona(next);

      return {
        check: {
          eligible: true,
          auto_approved: true,
          reasons: [
            `Persona re-induced for ${input.role_id} via LLM from ${input.skills.length} skills and ${input.experiences.length} experiences (v${input.currentPersona.version} → v${next.version})`,
          ],
          blocking_rules: [],
        },
        persona: next,
      };
    } catch {
      return ruleBasedPersonaInduction(memory, input);
    }
  };
}
