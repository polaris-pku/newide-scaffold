/**
 * 顶层 Agent 系统提示构建器
 *
 * 从 AgentMemoryScope 读取 Persona，动态组装顶层 Agent
 * 在 tool-calling 模式下的系统提示词。
 *
 * 注意：技能（Skills）和指标（Metrics）不载入顶层 Agent 上下文。
 * Agent 按需通过 query_memory 检索相关技能和经验；检索到的**原文由宿主自动**
 * 随 invoke_driver 送达 Driver（见 AgentToolConfig.onSkillsRetrieved），所以
 * 提示词要求 Agent **不要**把技能正文贴进工具参数——那样会撞上输出 token 上限，
 * 把工具调用的 JSON 截断成非法 JSON，调用直接失败。
 *
 * 可通过 AgentToolConfig.systemPrompt 传入自定义 prompt 覆盖此构建器。
 */
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { ToolDefinition } from '../runtime/tool';

export async function buildAgentSystemPrompt(
  memory: AgentMemoryScope,
  toolDefinitions: ToolDefinition[],
): Promise<string> {
  const persona = await memory.getPersona();

  const sections: string[] = [
    `You are Agent "${persona.role_id}".`,
    '',
    '## Your Identity',
    `Summary: ${persona.summary}`,
    `Skills Overview: ${persona.skills_overview}`,
    `Experience Coverage: ${persona.experience_coverage}`,
    `Recent Performance: ${persona.recent_performance}`,
    '',
    '## Available Tools',
    ...toolDefinitions.map((def) => `- ${def.function.name}: ${def.function.description}`),
    '',
    '## Behavior Rules',
    '- Use query_memory to retrieve relevant past experiences and skills. Skills are NOT pre-loaded — you must query them when needed.',
    '- Retrieved skills and experiences are delivered to the driver automatically. Do NOT paste their text into the invoke_driver instruction — describe only what the driver should do.',
    '- Use invoke_driver to dispatch concrete sub-tasks to the Driver Agent.',
    '- Keep track of what the driver returns and use it to inform next steps.',
    '- When the task is complete, summarize the result clearly and include "[done]".',
  ];

  return sections.join('\n');
}
