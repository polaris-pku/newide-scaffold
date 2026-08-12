/**
 * LiteLLMClientAdapter — 将 LiteLLMClient 适配为 LlmClient 接口
 *
 * 实现 LlmClient（complete）：用于上下文清理、经验提取、技能晋升。
 * Tool-calling（Agent dispatch）请使用 LiteLLMToolCallingClient。
 *
 * 自动加载项目根目录的 .env.local（已 gitignore），将其中定义的
 * 环境变量注入 process.env，供 AI SDK provider（如 @ai-sdk/openai）使用。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiteLLMClient } from '../../litellm';
import type { LiteLLMMessage } from '../../litellm';
import type { LlmClient, LlmMessage } from '../ports/llm-client';

function loadEnvFile(filePath: string): void {
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // 文件不存在 → 跳过
  }
}

function loadLocalEnv(): void {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(moduleDir, '..', '..', '..');
  const memoryDir = resolve(moduleDir, '..');

  loadEnvFile(resolve(projectRoot, '.env.local'));
  loadEnvFile(resolve(memoryDir, '.env'));

  if (process.env.LLM_PROVIDER === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = process.env.DEEPSEEK_API_KEY;
    }
    if (!process.env.OPENAI_BASE_URL) {
      process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1';
    }
  }
}

export class LiteLLMClientAdapter implements LlmClient {
  private client: LiteLLMClient;
  private readonly taskName: string;

  constructor(taskName: string = 'memory-query') {
    loadLocalEnv();
    this.client = new LiteLLMClient();
    this.client.registerProvider('openai', async (modelId: string) => {
      const { openai } = await import('@ai-sdk/openai');
      return openai.chat(modelId);
    });
    this.client.loadConfig();
    this.taskName = taskName;
  }

  async complete(input: {
    messages: LlmMessage[];
    responseFormat?: { type: 'json_object' };
  }): Promise<string> {
    const systemParts: string[] = [];
    const nonSystem = input.messages.filter((m) => {
      if (m.role === 'system') {
        systemParts.push(m.content);
        return false;
      }
      return true;
    });
    const merged: LiteLLMMessage[] =
      systemParts.length > 0
        ? ([
            {
              role: 'user',
              content: systemParts.join('\n\n') + '\n\n---\n\n' + (nonSystem[0]?.content ?? ''),
            },
            ...nonSystem.slice(1),
          ] as LiteLLMMessage[])
        : (nonSystem as LiteLLMMessage[]);

    const response = await this.client.complete({
      task: this.taskName,
      messages: merged,
      responseFormat: input.responseFormat
        ? { name: 'response', schema: { type: 'object' }, strict: true }
        : undefined,
    });
    return response.content;
  }
}
