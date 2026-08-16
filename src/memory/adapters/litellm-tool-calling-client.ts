/**
 * LiteLLMToolCallingClient — 支持 tool-calling 的 LiteLLM 适配器
 *
 * 实现 ToolCallingClient 接口，底层使用：
 * - LiteLLMClient（model pool + config，供模型解析）
 * - Vercel AI SDK 的 generateText（直接调用，不自动执行工具）
 *
 * 与 LiteLLMClientAdapter 的区别：
 * - LiteLLMClientAdapter 实现 LlmClient（简单 complete，用于经验提取等）
 * - LiteLLMToolCallingClient 实现 ToolCallingClient（tool-calling，用于 Agent 循环）
 *
 * 为什么直接调用 generateText 而不是 LiteLLMClient.completeWithTools：
 * - Agent 循环需要 LLM 返回原始 tool_calls，由 Agent 手动执行并反馈结果
 * - LiteLLMClient.completeWithTools 基于 AI SDK，会通过 execute handler 自动执行工具
 * - 直接调用 generateText 不传 execute handler，即可让 SDK 返回原始 tool_calls
 *
 * 用法：
 * ```ts
 * const llm = new LiteLLMToolCallingClient();
 * const result = await llm.completeWithTools({
 *   messages: [...],
 *   tools: [...],
 * });
 * ```
 *
 * 环境变量：
 * - LLM_PROVIDER=deepseek + DEEPSEEK_API_KEY → 自动映射为 openai provider + deepseek base URL
 * - 也支持直接设置 OPENAI_API_KEY / ANTHROPIC_API_KEY
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText, jsonSchema, type LanguageModel } from 'ai';
import { LiteLLMClient } from '../../litellm';
import type { Tool, ToolCall } from '../../litellm';
import type {
  ToolCallingClient,
  ToolCallMessage,
  ToolDefinition,
  ToolCallResult,
} from '../runtime/tool';

// ──────────────────────────────────────────────
// 环境变量加载（与 litellm-client-adapter.ts 共享相同逻辑）
// ──────────────────────────────────────────────

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

// ──────────────────────────────────────────────
// Provider 解析（与 LiteLLMClient 内部逻辑一致）
// ──────────────────────────────────────────────

async function resolveProviderModel(provider: string, modelId: string): Promise<LanguageModel> {
  switch (provider) {
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      // 显式按当前 env 创建 provider：模块级默认 `openai` 实例在模块加载时
      // 读取 OPENAI_BASE_URL，若当时未设置会被钉死在 api.openai.com。
      return createOpenAI({
        ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
        ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
      }).chat(modelId) as LanguageModel;
    }
    case 'anthropic': {
      const { anthropic } = await import('@ai-sdk/anthropic');
      return anthropic(modelId) as LanguageModel;
    }
    default:
      throw new Error(
        `LiteLLMToolCallingClient: unknown provider "${provider}". ` +
          `Supported: openai, anthropic.`,
      );
  }
}

// ──────────────────────────────────────────────
// 类型转换帮助函数
// ──────────────────────────────────────────────

/** ToolDefinition[] → Tool[]（结构完全一致） */
function toLiteLLMTools(defs: ToolDefinition[]): Tool[] {
  return defs.map((d) => ({
    type: 'function' as const,
    function: {
      name: d.function.name,
      description: d.function.description,
      parameters: d.function.parameters,
    },
  }));
}

/** AI SDK 的 toolCalls 转内存模块 ToolCall[] */
function toToolCalls(resultToolCalls: unknown[]): ToolCall[] {
  return resultToolCalls.map((tc: unknown) => {
    const t = tc as { toolCallId: string; toolName: string; args?: unknown; input?: unknown };
    const raw = t.args ?? t.input;
    return {
      id: t.toolCallId,
      type: 'function' as const,
      function: {
        name: t.toolName,
        arguments: typeof raw === 'string' ? raw : JSON.stringify(raw),
      },
    };
  });
}

// ──────────────────────────────────────────────
// LiteLLMToolCallingClient
// ──────────────────────────────────────────────

export interface LiteLLMToolCallingClientOptions {
  /** LiteLLM 任务类型（默认 'memory-query'，对应 config/memory-query.yaml） */
  taskName?: string;
  /** 是否加载环境变量（默认 true，设为 false 可跳过） */
  loadEnv?: boolean;

  /**
   * 模型名称覆盖（如 'deepseek-chat'、'deepseek-reasoner'）。
   * 设此值后忽略 YAML 配置中的 model，但温度/超时等仍从 YAML 读取。
   */
  model?: string;
  /**
   * API Key 覆盖（默认从环境变量读取
   * DEEPSEEK_API_KEY / LLM_PROVIDER=deepseek 或 OPENAI_API_KEY）。
   * 传此值会覆盖 process.env.OPENAI_API_KEY。
   */
  apiKey?: string;
  /**
   * Base URL 覆盖（如 'https://api.deepseek.com'）。
   * 传此值会覆盖 process.env.OPENAI_BASE_URL。
   * LiteLLM 通过 @ai-sdk/openai 调用，SDK 会读 OPENAI_BASE_URL env。
   */
  baseUrl?: string;
}

export class LiteLLMToolCallingClient implements ToolCallingClient {
  private readonly client: LiteLLMClient;
  private readonly taskName: string;
  private readonly modelOverride: string | undefined;

  constructor(options: LiteLLMToolCallingClientOptions = {}) {
    this.taskName = options.taskName ?? 'memory-query';
    this.modelOverride = options.model;

    // 构造参数覆盖环境变量
    if (options.apiKey) {
      process.env.OPENAI_API_KEY = options.apiKey;
    }
    if (options.baseUrl) {
      process.env.OPENAI_BASE_URL = options.baseUrl.replace(/\/+$/, '') + '/v1';
    }

    // 加载环境变量（支持 DEEPSEEK_API_KEY → OPENAI_API_KEY 映射）
    if (options.loadEnv !== false) {
      loadLocalEnv();
    }

    this.client = new LiteLLMClient();
    this.client.registerProvider('openai', async (modelId: string) => {
      const { openai } = await import('@ai-sdk/openai');
      return openai.chat(modelId);
    });
    this.client.loadConfig();
  }

  async completeWithTools(input: {
    messages: ToolCallMessage[];
    tools: ToolDefinition[];
    tool_choice?: 'auto' | 'none';
  }): Promise<ToolCallResult> {
    // 1. 解析模型：
    //    - 传了 modelOverride → 使用 openai provider + 指定 model
    //    - 没传 → 从 LiteLLMClient 的 model pool 按 YAML 配置解析
    let providerName: string;
    let modelId: string;
    let temperature: number;
    let maxTokens: number;

    if (this.modelOverride) {
      providerName = 'openai';
      modelId = this.modelOverride;
      temperature = 0.3;
      maxTokens = 2000;
    } else {
      const resolved = this.client.modelPool.resolve(this.taskName);
      providerName = resolved.provider;
      modelId = resolved.model;
      temperature = resolved.temperature;
      maxTokens = resolved.maxTokens;
    }

    // 2. 解析 provider 得到 AI SDK model 实例
    const model = await resolveProviderModel(providerName, modelId);

    // 3. 转换消息：AI SDK v7 要求 system 消息通过 system 参数传入
    const systemParts: string[] = [];
    const nonSystemMessages = input.messages.filter((m) => {
      if (m.role === 'system') {
        systemParts.push(m.content ?? '');
        return false;
      }
      return true;
    });
    // 构建 assistant tool_call_id → toolName 查找表
    const toolCallNameMap = new Map<string, string>();
    for (const m of nonSystemMessages) {
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          toolCallNameMap.set(tc.id, tc.function.name);
        }
      }
    }

    const aiMessages = nonSystemMessages.map((m) => {
      if (m.role === 'tool') {
        // AI SDK v7 的 ToolResultPart: { type, toolCallId, toolName, output: { type, value } }
        const rawContent = m.content ?? '{}';
        let parsed: unknown = rawContent;
        try {
          parsed = JSON.parse(rawContent);
        } catch {
          /* 保持原样 */
        }
        return {
          role: 'tool' as const,
          content: [
            {
              type: 'tool-result' as const,
              toolCallId: m.tool_call_id ?? '',
              toolName: toolCallNameMap.get(m.tool_call_id ?? '') ?? 'unknown',
              output: { type: 'json' as const, value: parsed },
            },
          ],
        };
      }

      // assistant 消息：tool_calls 必须放入 content 数组（AI SDK v7 格式）
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const content: Record<string, unknown>[] = [];
        if (m.content) {
          content.push({ type: 'text' as const, text: m.content });
        }
        for (const tc of m.tool_calls) {
          let input: unknown = tc.function.arguments;
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            /* keep string */
          }
          content.push({
            type: 'tool-call' as const,
            toolCallId: tc.id,
            toolName: tc.function.name,
            input,
          });
        }
        return { role: 'assistant' as const, content };
      }

      // user 消息
      return { role: m.role, content: m.content ?? '' };
    });

    // 4. 构建工具定义（不传 execute handler → AI SDK 不自动执行）
    const liteTools = toLiteLLMTools(input.tools);
    const tools: Record<string, unknown> = {};
    for (const t of liteTools) {
      tools[t.function.name] = {
        description: t.function.description,
        inputSchema: jsonSchema(t.function.parameters as Record<string, unknown>),
        // 不传 execute → SDK 只返回 tool_calls，不执行
      };
    }

    // 5. 直接调用 AI SDK generateText（不经过 LiteLLMClient.completeWithTools）
    const generateParams: Record<string, unknown> = {
      model,
      ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
      messages: aiMessages,
      temperature,
      maxOutputTokens: maxTokens,
    };
    if (liteTools.length > 0) {
      generateParams.tools = tools;
    }
    const result = await generateText(generateParams as Parameters<typeof generateText>[0]);
    return {
      content: result.text ?? null,
      tool_calls:
        result.toolCalls && result.toolCalls.length > 0
          ? toToolCalls(result.toolCalls as unknown[])
          : undefined,
    };
  }
}
