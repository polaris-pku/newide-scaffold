/**
 * ================================================
 * LiteLLM Client — Main Entry Point
 * ================================================
 * Orchestrates: ModelPool, MethodRouter, ToolRegistry.
 *
 * Powered by Vercel AI SDK — in-process, no external proxy.
 *
 * Usage:
 *   const client = new LiteLLMClient();
 *   client.loadConfig();
 *   const resp = await client.complete({ task: 'classify-intent', messages });
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateText,
  streamText,
  generateObject,
  jsonSchema,
  embed,
  type EmbeddingModel,
  type ModelMessage,
} from 'ai';
import { ModelPool } from './model-pool';
import { MethodRouter } from './methods/method-router';
import { ToolRegistry } from './tools/tool-registry';
import { loadLitellmConfig } from './config-loader';

import type {
  LiteLLMClientConfig,
  LiteLLMClientOptions,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  StreamChunk,
  JsonSchema,
  ToolHandler,
  MethodContext,
  MethodHandler,
  LiteLLMMessage,
  ToolCall,
  Tool,
} from './contract';

// ═══════════════════════════════════════════════════════════
// Message / Tool conversion helpers
// ═══════════════════════════════════════════════════════════

function toAiMessages(messages: LiteLLMMessage[]): ModelMessage[] {
  return messages.map((m) => ({
    role: m.role as 'system' | 'user' | 'assistant' | 'tool',
    content: m.content,
    ...(m.name ? { name: m.name } : {}),
    ...(m.tool_call_id ? { toolCallId: m.tool_call_id } : {}),
  })) as ModelMessage[];
}

function toAiTools(
  schemas: Tool[],
  handlers: Record<string, ToolHandler>,
): Record<string, unknown> {
  const tools: Record<string, unknown> = {};
  for (const t of schemas) {
    const name = t.function.name;
    const handler = handlers[name];
    if (handler) {
      tools[name] = {
        description: t.function.description,
        inputSchema: jsonSchema(t.function.parameters as Record<string, unknown>),
        execute: handler,
      };
    }
  }
  return tools;
}

function fromAiToolCalls(toolCalls: unknown[]): ToolCall[] {
  return toolCalls.map((tc: unknown) => {
    const t = tc as { toolCallId: string; toolName: string; input?: unknown; args?: unknown };
    const raw = t.input ?? t.args;
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

// ═══════════════════════════════════════════════════════════
// Env file loader (lightweight — no dotenv dependency)
// ═══════════════════════════════════════════════════════════

function loadEnvFiles(configDir?: string): void {
  const candidates: string[] = [];

  // 1) Working directory .env
  candidates.push('.env');

  // 2) src/memory/.env (relative from config dir default)
  if (!configDir) {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = resolve(moduleDir, '..', '..');
    candidates.push(resolve(projectRoot, 'src', 'memory', '.env'));
    candidates.push(resolve(projectRoot, '.env.local'));
  }

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        // Don't overwrite already-set env vars
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch {
      // skip unreadable files
    }
  }
}

// ═══════════════════════════════════════════════════════════
// LiteLLM Client
// ═══════════════════════════════════════════════════════════

type ProviderFactory = (modelId: string) => unknown;

export class LiteLLMClient {
  readonly modelPool: ModelPool;
  readonly methods: MethodRouter;
  readonly tools: ToolRegistry;

  /** Embedding vector dimensions — from EMBEDDING_DIMENSIONS env var, default 1536 */
  readonly dimensions: number;

  /** Instance-level provider registry — no cross-instance pollution. */
  private readonly providers = new Map<string, ProviderFactory>();

  private readonly config: LiteLLMClientConfig;

  constructor(options: LiteLLMClientOptions = {}) {
    this.config = {
      baseUrl: '',
      defaultTimeoutMs: 30_000,
      defaultMaxRetries: 3,
      defaultRetryDelayMs: 1_000,
      taskConfigs: [],
      debug: false,
    };

    this.dimensions = parseInt(process.env.EMBEDDING_DIMENSIONS ?? '1536', 10);

    this.modelPool = new ModelPool({
      defaultTimeoutMs: this.config.defaultTimeoutMs,
      defaultMaxRetries: this.config.defaultMaxRetries,
      defaultTemperature: 0.3,
      defaultMaxTokens: 2000,
    });
    this.tools = new ToolRegistry();
    this.methods = new MethodRouter(() => this.createMethodContext());

    if (options.methods) {
      for (const m of options.methods) this.registerMethod(m);
    }
    if (options.tools) {
      for (const [name, handler] of Object.entries(options.tools)) {
        this.tools.registerAdHoc(name, `Tool ${name}`, { type: 'object' }, handler);
      }
    }
  }

  // ═════════════════════════════════════════════════════════
  // Provider resolution (instance-level, lazy-loaded)
  // ═════════════════════════════════════════════════════════

  /**
   * Register a custom AI SDK provider on this client instance.
   *
   * Built-in providers (openai, anthropic) are lazy-loaded on first use
   * via dynamic import() — no static SDK dependency until needed.
   */
  registerProvider(name: string, factory: ProviderFactory): this {
    this.providers.set(name, factory);
    return this;
  }

  private async resolveProvider(provider: string): Promise<ProviderFactory> {
    const cached = this.providers.get(provider);
    if (cached) return cached;

    // Built-in providers: lazy-load via dynamic import()
    let factory: ProviderFactory;
    switch (provider) {
      case 'openai': {
        const { openai } = await import('@ai-sdk/openai');
        factory = (id) => openai(id);
        break;
      }
      case 'anthropic': {
        const { anthropic } = await import('@ai-sdk/anthropic');
        factory = (id) => anthropic(id);
        break;
      }
      default:
        throw new Error(
          `Unknown provider "${provider}". ` +
            `Available built-in: openai, anthropic. ` +
            `Register a custom provider with client.registerProvider(name, factory).`,
        );
    }
    this.providers.set(provider, factory);
    return factory;
  }

  private async resolveModel(provider: string, modelId: string) {
    const factory = await this.resolveProvider(provider);
    return factory(modelId);
  }

  private readonly embeddingProviders = new Map<string, EmbeddingModel>();

  /**
   * Resolve a provider for embedding models.
   *
   * Separate from resolveProvider because the same provider (e.g. openai)
   * uses a different interface for embeddings: `openai.embedding(id)` vs `openai(id)`.
   */
  private async resolveEmbeddingProvider(
    provider: string,
    modelId: string,
  ): Promise<EmbeddingModel> {
    const cacheKey = `embed:${provider}:${modelId}`;
    const cached = this.embeddingProviders.get(cacheKey);
    if (cached) return cached;

    switch (provider) {
      case 'openai': {
        const embeddingApiKey = process.env.EMBEDDING_API_KEY;
        const embeddingBaseURL = process.env.EMBEDDING_BASE_URL;
        const { createOpenAI } = await import('@ai-sdk/openai');
        const instance = createOpenAI({
          ...(embeddingApiKey ? { apiKey: embeddingApiKey } : {}),
          ...(embeddingBaseURL ? { baseURL: embeddingBaseURL } : {}),
        });
        const embeddingModel = instance.embedding(modelId);
        this.embeddingProviders.set(cacheKey, embeddingModel);
        return embeddingModel;
      }
      default:
        throw new Error(
          `No embedding provider for "${provider}". ` +
            `Only "openai" is supported for embeddings.`,
        );
    }
  }

  // ═════════════════════════════════════════════════════════
  // Public API: Direct Completion
  // ═════════════════════════════════════════════════════════

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const resolved = this.modelPool.resolve(request.task);
    const model = await this.resolveModel(resolved.provider, resolved.model);
    const messages = toAiMessages(request.messages);

    const params: Record<string, unknown> = {
      model,
      messages,
      temperature: request.temperature ?? resolved.temperature,
      maxOutputTokens: request.maxTokens ?? resolved.maxTokens,
    };

    if (request.tools?.length) {
      params.tools = toAiTools(request.tools, this.tools.getAllHandlers());
    }

    const result = await generateText(params as Parameters<typeof generateText>[0]);

    return {
      id: (result as { response?: { id?: string } }).response?.id ?? '',
      model: resolved.model,
      content: result.text,
      toolCalls: fromAiToolCalls(result.toolCalls as unknown[]),
      usage: {
        prompt_tokens: result.usage?.inputTokens ?? 0,
        completion_tokens: result.usage?.outputTokens ?? 0,
        total_tokens: result.usage?.totalTokens ?? 0,
      },
      finishReason: result.finishReason,
    };
  }

  async completeWithTools(
    request: CompletionRequest,
    toolHandlers?: Record<string, ToolHandler>,
    maxRounds = 10,
  ): Promise<CompletionResponse> {
    const resolved = this.modelPool.resolve(request.task);
    const model = await this.resolveModel(resolved.provider, resolved.model);
    const messages = toAiMessages(request.messages);

    const schemas = request.tools ?? this.tools.getAllSchemas();
    const handlers = toolHandlers ?? this.tools.getAllHandlers();

    if (schemas.length === 0 && maxRounds > 1) {
      throw new Error('completeWithTools requires tools when maxRounds > 1');
    }

    const params: Record<string, unknown> = {
      model,
      messages,
      tools: toAiTools(schemas, handlers),
      temperature: request.temperature ?? resolved.temperature,
      maxOutputTokens: request.maxTokens ?? resolved.maxTokens,
      maxSteps: maxRounds,
    };

    const result = await generateText(params as Parameters<typeof generateText>[0]);

    if (this.config.debug && (result as { steps?: unknown[] }).steps?.length) {
      console.log(`[LiteLLMClient] Tool rounds: ${(result as { steps: unknown[] }).steps.length}`);
    }

    return {
      id: (result as { response?: { id?: string } }).response?.id ?? '',
      model: resolved.model,
      content: result.text,
      toolCalls: fromAiToolCalls(result.toolCalls as unknown[]),
      usage: {
        prompt_tokens: result.usage?.inputTokens ?? 0,
        completion_tokens: result.usage?.outputTokens ?? 0,
        total_tokens: result.usage?.totalTokens ?? 0,
      },
      finishReason: result.finishReason,
    };
  }

  async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk> {
    const resolved = this.modelPool.resolve(request.task);
    const model = await this.resolveModel(resolved.provider, resolved.model);
    const messages = toAiMessages(request.messages);

    const params: Record<string, unknown> = {
      model,
      messages,
      temperature: request.temperature ?? resolved.temperature,
      maxOutputTokens: request.maxTokens ?? resolved.maxTokens,
    };

    const result = streamText(params as Parameters<typeof streamText>[0]);
    const responseId = ((await result.response) as { id?: string })?.id ?? '';

    for await (const part of result.fullStream) {
      const p = part as { type: string; textDelta?: string; finishReason?: string };
      if (p.type === 'text-delta') {
        yield { id: responseId, model: resolved.model, delta: { content: p.textDelta } };
      } else if (p.type === 'finish') {
        yield { id: responseId, model: resolved.model, delta: {}, finishReason: p.finishReason };
      }
    }
  }

  async structured<T = unknown>(
    request: CompletionRequest & { responseFormat: JsonSchema },
  ): Promise<T> {
    const resolved = this.modelPool.resolve(request.task);
    const model = await this.resolveModel(resolved.provider, resolved.model);
    const messages = toAiMessages(request.messages);
    const schema = request.responseFormat;

    const params: Record<string, unknown> = {
      model,
      schema: jsonSchema(schema.schema as Record<string, unknown>),
      messages,
      temperature: request.temperature ?? resolved.temperature,
      maxOutputTokens: request.maxTokens ?? resolved.maxTokens,
    };

    const result = await generateObject(params as Parameters<typeof generateObject>[0]);
    return (result as { object: T }).object;
  }

  // ═════════════════════════════════════════════════════════
  // Public API: Embedding
  // ═════════════════════════════════════════════════════════

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const resolved = this.modelPool.resolve(request.task);
    const model = await this.resolveEmbeddingProvider(resolved.provider, resolved.model);
    const inputs = typeof request.input === 'string' ? [request.input] : request.input;

    // When batch > 1, call sequentially (AI SDK embed() is single-input)
    const allEmbeddings: number[][] = [];
    let totalTokens = 0;

    for (const text of inputs) {
      const result = await embed({
        model,
        value: text,
      });
      allEmbeddings.push(result.embedding as number[]);
      totalTokens += result.usage?.tokens ?? 0;
    }

    return {
      model: resolved.model,
      embeddings: allEmbeddings,
      usage: { prompt_tokens: totalTokens, completion_tokens: 0, total_tokens: totalTokens },
    };
  }

  // ═════════════════════════════════════════════════════════
  // Public API: Setup
  // ═════════════════════════════════════════════════════════

  loadConfig(dirPath?: string): this {
    loadEnvFiles(dirPath);
    const { tasks } = loadLitellmConfig(dirPath);
    this.modelPool.withConfigs(tasks);
    return this;
  }

  /**
   * Register a method handler.
   *
   * If config has been loaded, validates that the method's task name
   * has a matching config entry — catches typos at registration time.
   */
  registerMethod(method: MethodHandler): this {
    const loadedTasks = this.modelPool.config.getTasks();
    if (loadedTasks.length > 0 && !this.modelPool.canHandle(method.task)) {
      throw new Error(
        `Method "${method.name}" references task "${method.task}" ` +
          `which has no config entry. ` +
          `Loaded tasks: [${loadedTasks.join(', ')}]. ` +
          `Add a config/<task>.yaml file for "${method.task}".`,
      );
    }
    this.methods.registry.register(method);
    return this;
  }

  // ═════════════════════════════════════════════════════════
  // Private
  // ═════════════════════════════════════════════════════════

  private createMethodContext(): MethodContext {
    return {
      complete: (req) => this.complete(req),
      stream: (req) => this.stream(req),
      structured: (req) => this.structured(req),
      completeWithTools: (req, tools, rounds) => this.completeWithTools(req, tools, rounds),
      tools: this.tools.getAllHandlers(),
    };
  }
}
