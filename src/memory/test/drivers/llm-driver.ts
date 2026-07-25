/**
 * LLM Driver — 真实调用 LLM（Claude/GPT 等）的 DriverHandler 实现
 *
 * 支持两种模式：
 * - `api` 模式：通过 @ai-sdk/anthropic SDK 调用 Claude API（需 ANTHROPIC_API_KEY）
 * - `cli` 模式：通过本地 claude 命令调用（无需 API key，适合本地测试）
 *
 * 将 DriverTask.subtask 发给 LLM，要求按 DriverReturnSchema 返回结构化报告。
 * 用于集成测试，替代 mock driver，展示真实的 Agent → Driver 端到端链路。
 *
 * 用法：
 * ```ts
 * import { createLlmDriver } from '../drivers/llm-driver';
 *
 * // CLI 模式（使用本地 claude 命令）
 * const driverTool = new InvokeDriverTool(createLlmDriver({ mode: 'cli' }));
 *
 * // API 模式（需要 ANTHROPIC_API_KEY）
 * const driverTool = new InvokeDriverTool(createLlmDriver({ mode: 'api' }));
 * ```
 */
import { execSync } from 'node:child_process';
import { generateObject } from 'ai';
import { DriverReturnSchema } from '../../schemas';
import type { DriverReturn } from '../../schemas';
import type { DriverHandler, DriverTask } from '../../runtime/tools/invoke-driver-tool';

// ──────────────────────────────────────────────
// Prompt 构建
// ──────────────────────────────────────────────

/**
 * Claude 的输出要求：
 * - 只输出 JSON，不要 markdown 代码块，不要额外文字
 * - 严格匹配 DriverReturnSchema 的字段
 */
const SYSTEM_PROMPT = [
  'You are a Driver Agent that executes sub-tasks for a top-level Agent.',
  'You MUST respond with ONLY a valid JSON object — no markdown, no code fences, no extra text.',
  '',
  'The JSON must match this exact schema:',
  JSON.stringify(DriverReturnSchema._def, null, 2),
].join('\n');

function buildPrompt(task: DriverTask): string {
  const parts: string[] = [
    'Execute the following task and return a structured report as JSON.',
    '',
    '## Task',
    task.instruction,
  ];

  if (task.context?.skills && task.context.skills.length > 0) {
    parts.push('', '## Relevant Skills', ...task.context.skills.map((s) => `- ${s}`));
  }

  if (task.context?.experiences && task.context.experiences.length > 0) {
    parts.push('', '## Relevant Experiences', ...task.context.experiences.map((e) => `- ${e}`));
  }

  return parts.join('\n');
}

// ──────────────────────────────────────────────
// JSON 解析助手
// ──────────────────────────────────────────────

/**
 * 从 Claude CLI 输出中提取 JSON。
 * 处理常见的 markdown 代码块包裹和前后空白。
 */
function extractJson(raw: string): string {
  let trimmed = raw.trim();

  // 去掉 ```json ... ``` 包裹
  const jsonFence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/;
  const match = trimmed.match(jsonFence);
  if (match) {
    trimmed = match[1]!.trim();
  }

  return trimmed;
}

function parseDriverReturn(raw: string): DriverReturn {
  const json = extractJson(raw);
  const parsed = JSON.parse(json);
  return DriverReturnSchema.parse(parsed);
}

// ──────────────────────────────────────────────
// Options & Factory
// ──────────────────────────────────────────────

export interface LlmDriverOptions {
  /** 调用模式：'api' 通过 SDK 调用，'cli' 通过本地 claude 命令（默认 'cli'） */
  mode?: 'api' | 'cli';
  /** API 模式下的 provider（默认 'anthropic'） */
  provider?: 'anthropic' | 'openai';
  /** API 模式下的模型名称（默认 'claude-sonnet-4-20250514'） */
  model?: string;
  /** CLI 模式下的 claude 命令路径（默认 'claude'） */
  cliCommand?: string;
  /**
   * CLI 进程的工作目录。不设置时默认使用系统临时目录，避免 AI driver
   * 生成的文件污染项目根目录。集成测试应传入临时目录并在测试后清理。
   */
  cwd?: string;
}

/**
 * 创建一个调用真实 LLM 的 DriverHandler。
 *
 * 返回的 handler 接收 DriverTask，将 task.instruction 发给 LLM，
 * 要求按 `DriverReturnSchema` 输出结构化 JSON。
 *
 * @example CLI 模式（默认）
 * ```ts
 * const handler = createLlmDriver({ mode: 'cli' });
 * ```
 *
 * @example API 模式
 * ```ts
 * const handler = createLlmDriver({ mode: 'api' });
 * ```
 */
export function createLlmDriver(options?: LlmDriverOptions): DriverHandler {
  const mode = options?.mode ?? 'cli';

  if (mode === 'api') {
    return createApiDriver(options);
  }
  return createCliDriver(options);
}

// ──────────────────────────────────────────────
// API 模式：通过 @ai-sdk/anthropic SDK 调用
// ──────────────────────────────────────────────

function createApiDriver(options?: LlmDriverOptions): DriverHandler {
  const provider = options?.provider ?? 'anthropic';
  const modelName = options?.model ?? 'claude-sonnet-4-20250514';

  return async (task: DriverTask): Promise<DriverReturn> => {
    let model: Parameters<typeof generateObject>[0]['model'];
    switch (provider) {
      case 'anthropic': {
        const { anthropic } = await import('@ai-sdk/anthropic');
        model = anthropic(modelName) as typeof model;
        break;
      }
      case 'openai': {
        const { openai } = await import('@ai-sdk/openai');
        model = openai.chat(modelName) as typeof model;
        break;
      }
      default:
        throw new Error(`LLM Driver: unknown provider "${provider}"`);
    }

    const { object } = await generateObject({
      model,
      schema: DriverReturnSchema,
      messages: [
        { role: 'system' as const, content: SYSTEM_PROMPT },
        { role: 'user' as const, content: buildPrompt(task) },
      ],
    });

    return object as DriverReturn;
  };
}

// ──────────────────────────────────────────────
// CLI 模式：通过本地 claude 命令调用
// ──────────────────────────────────────────────

function createCliDriver(options?: LlmDriverOptions): DriverHandler {
  const cliCommand = options?.cliCommand ?? 'claude';
  const cwd = options?.cwd ?? process.cwd();

  return async (task: DriverTask): Promise<DriverReturn> => {
    const prompt = `${SYSTEM_PROMPT}\n\n${buildPrompt(task)}`;

    try {
      const stdout = execSync(cliCommand, {
        cwd,
        input: prompt,
        encoding: 'utf-8',
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });

      return parseDriverReturn(stdout);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Claude CLI driver failed: ${message}`);
    }
  };
}
