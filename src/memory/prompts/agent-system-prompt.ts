/**
 * 顶层 Agent 系统提示构建器
 *
 * 从 AgentMemoryScope 读取 Persona，动态组装顶层 Agent
 * 在 tool-calling 模式下的系统提示词。
 *
 * 注意：技能（Skills）和指标（Metrics）不载入顶层 Agent 上下文。
 * Agent 按需通过 query_memory 检索相关技能和经验，
 * 在调用 invoke_driver 时一并丢给 Driver 使用。
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
    'Your skills and past experience are not listed here. Retrieve what the task needs with query_memory.',
    '',
    '## Available Tools',
    ...toolDefinitions.map((def) => `- ${def.function.name}: ${def.function.description}`),
    '',
    '## Behavior Rules',
    '- Pass retrieved skills and experiences as context when calling invoke_driver.',
    '- Use invoke_driver to dispatch concrete sub-tasks to the Driver Agent.',
    '- Keep track of what the driver returns and use it to inform next steps.',
    '- When the task is complete, summarize the result clearly and include "[done]".',
  ];

  return sections.join('\n');
}
