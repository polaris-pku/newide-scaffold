/**
 * ================================================
 * LiteLLM Client — Public Contract
 * ================================================
 *
 * This is the **single import surface** for upper layers to use
 * lightweight LLM calls within the scaffold.
 *
 * All upper-layer LLM needs (agent consolidation, council deliberation,
 * orchestrator planning, prompt gates, etc.) go through this module.
 *
 * ## Quick start
 *
 * ```ts
 * import { LiteLLMClient, type LiteLLMMessage } from './litellm/contract';
 *
 * const llm = new LiteLLMClient();
 * llm.loadConfig();
 *
 * const resp = await llm.complete({
 *   task: 'classify-intent',
 *   messages: [
 *     { role: 'system', content: 'Classify user intent.' },
 *     { role: 'user', content: 'I need help with OAuth.' },
 *   ],
 * });
 * ```
 */

// ═══════════════════════════════════════════════════════════
// Interface Definitions (the contract)
// ═══════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────
// Core Identifiers
// ──────────────────────────────────────────────────────────

/** LiteLLM task type — drives model selection and routing */
export type LiteLLMTaskType = string;

/** Provider identifier — used for auto-selection */
export type Provider = 'openai' | 'anthropic' | 'google' | 'azure' | 'ollama' | string;

/** Model identifier — opaque to upper layers */
export type ModelId = string;

/** Method name for routing */
export type MethodName = string;

// ──────────────────────────────────────────────────────────
// Chat Messages (OpenAI-compatible format)
// ──────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * A single chat completion message.
 * Named `LiteLLMMessage` to distinguish from the project-level
 * `Message` type (agent-to-agent protocol messages).
 */
export interface LiteLLMMessage {
  role: MessageRole;
  content: string;
  /** Optional name for tool messages */
  name?: string;
  /** Tool call ID for tool response messages */
  tool_call_id?: string;
}

// ──────────────────────────────────────────────────────────
// Tools (OpenAI-compatible function calling)
// ──────────────────────────────────────────────────────────

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** Tool handler — receives parsed arguments, returns string result */
export type ToolHandler = (args: Record<string, unknown>) => Promise<string> | string;

// ──────────────────────────────────────────────────────────
// Structured Output (JSON Schema)
// ──────────────────────────────────────────────────────────

export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

// ──────────────────────────────────────────────────────────
// Embedding Request / Response
// ──────────────────────────────────────────────────────────

export interface EmbeddingRequest {
  /** LiteLLM task type — ModelPool resolves to model(s) */
  task: LiteLLMTaskType;
  /** Single string or batch of strings to embed */
  input: string | string[];
}

export interface EmbeddingResponse {
  /** The actual model that served this request */
  model: ModelId;
  /** Embedding vectors — one per input */
  embeddings: number[][];
  /** Token usage */
  usage: TokenUsage;
}

// ──────────────────────────────────────────────────────────
// Completion Request / Response
// ──────────────────────────────────────────────────────────

export interface CompletionRequest {
  /** LiteLLM task type — ModelPool resolves to model(s) */
  task: LiteLLMTaskType;
  /** Conversation messages */
  messages: LiteLLMMessage[];
  /** Available tools for function calling */
  tools?: Tool[] | undefined;
  /** Tool choice override — "auto", "none", "required", or a specific function */
  toolChoice?:
    | 'auto'
    | 'none'
    | 'required'
    | { type: 'function'; function: { name: string } }
    | undefined;
  /** Temperature (0-2) */
  temperature?: number;
  /** Max tokens to generate */
  maxTokens?: number;
  /** Structured output JSON schema */
  responseFormat?: JsonSchema | undefined;
  /** Request timeout override (ms) */
  timeoutMs?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal | undefined;
}

export interface CompletionResponse {
  id: string;
  /** The actual model that served this request */
  model: ModelId;
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ──────────────────────────────────────────────────────────
// Streaming
// ──────────────────────────────────────────────────────────

export interface StreamChunk {
  id: string;
  model: ModelId;
  delta: {
    content?: string | undefined;
    toolCalls?: ToolCall[] | undefined;
  };
  finishReason?: string | undefined;
}

// ──────────────────────────────────────────────────────────
// Model Configuration
// ──────────────────────────────────────────────────────────

/** A single model entry in the pool with priority ordering */
export interface ModelEntry {
  /** Model identifier, e.g. "gpt-4o-mini", "claude-sonnet-4-20250514" */
  model: string;
  /** Provider for SDK selection: "openai", "anthropic", "google" */
  provider: Provider;
  /** Priority order — lower = tried first */
  order: number;
  /** Whether this entry is enabled */
  enabled?: boolean;
  /** Max tokens this model supports */
  maxContextTokens?: number;
  /** Cost per 1K tokens (for reference) */
  costPer1kTokens?: number;
}

/** Model selection strategy */
export type ModelSelectionStrategy =
  /** Use order field: try order=1 first, fallback to order=2 */
  | 'order'
  /** Automatically pick based on API_KEY availability */
  | 'auto'
  /** Use the cheapest available model */
  | 'cheapest'
  /** Use the fastest available model (latency-based) */
  | 'fastest'
  /** Explicit model override (dev only) */
  | { type: 'explicit'; model: string };

/** Reusable model profile — tasks can reference it by name instead of listing models */
export interface ModelProfile {
  /** Available model entries */
  models: ModelEntry[];
  /** Selection strategy — defaults to 'order' */
  strategy?: ModelSelectionStrategy;
  /** Default timeout in ms */
  timeoutMs?: number;
  /** Default max retries */
  maxRetries?: number;
  /** Default temperature */
  temperature?: number;
  /** Default max tokens */
  maxTokens?: number;
}

/** Per-task model configuration */
export interface LiteLLMTaskConfig {
  /** Task type identifier */
  task: LiteLLMTaskType;
  /** Reference a named profile (from YAML `profiles` section) instead of listing models inline */
  profile?: string;
  /** Available model entries — optional if `profile` is set */
  models?: ModelEntry[];
  /** Selection strategy — overrides profile's strategy if set */
  strategy?: ModelSelectionStrategy;
  /** Request timeout in ms — overrides global default */
  timeoutMs?: number;
  /** Max retry attempts for this task — overrides global default */
  maxRetries?: number;
  /** Temperature — overrides global default */
  temperature?: number;
  /** Max tokens — overrides global default */
  maxTokens?: number;
}

// ──────────────────────────────────────────────────────────
// LiteLLM Client Configuration
// ──────────────────────────────────────────────────────────

export interface LiteLLMClientConfig {
  /** LiteLLM Proxy base URL */
  baseUrl: string;
  /** LiteLLM Proxy API key — if omitted, reads from LITELLM_API_KEY env */
  apiKey?: string;
  /** Global default timeout in ms */
  defaultTimeoutMs: number;
  /** Global default max retries */
  defaultMaxRetries: number;
  /** Global default retry delay in ms */
  defaultRetryDelayMs: number;
  /** Per-task model configurations */
  taskConfigs: LiteLLMTaskConfig[];
  /** Enable debug logging */
  debug: boolean;
}

/** Runtime options passed to the LiteLLM client constructor */
export interface LiteLLMClientOptions {
  /** Override base URL */
  baseUrl?: string;
  /** Override API key */
  apiKey?: string;
  /** Inject custom fetch (for testing) */
  fetch?: typeof fetch;
  /** Inject custom method handlers */
  methods?: MethodHandler[];
  /** Inject custom tools */
  tools?: Record<string, ToolHandler>;
}

// ──────────────────────────────────────────────────────────
// Method Routing
// ──────────────────────────────────────────────────────────

/** Unified method interface — all callable methods implement this */
export interface MethodHandler {
  /** Method name for routing */
  readonly name: MethodName;
  /** Method description */
  readonly description: string;
  /** Task type this method uses for model selection */
  readonly task: LiteLLMTaskType;
  /** Execute the method */
  execute(
    context: MethodContext,
    params: Record<string, unknown>,
  ): Promise<MethodResult> | MethodResult;
}

/** Context passed to method execution */
export interface MethodContext {
  /** Send a completion request to the LLM */
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  /** Stream a completion */
  stream(request: CompletionRequest): AsyncGenerator<StreamChunk>;
  /** Get structured output */
  structured<T>(request: CompletionRequest & { responseFormat: JsonSchema }): Promise<T>;
  /** Complete with tool auto-execution */
  completeWithTools(
    request: CompletionRequest,
    tools: Record<string, ToolHandler>,
    maxRounds?: number,
  ): Promise<CompletionResponse>;
  /** Access tool registry */
  tools: Record<string, ToolHandler>;
  /** Access memory (injected by scaffold) */
  memory?: unknown;
}

/** Result returned by a method */
export interface MethodResult {
  /** Result content */
  content: string;
  /** Structured data (if applicable) */
  data?: Record<string, unknown> | undefined;
  /** Token usage */
  usage?: TokenUsage | undefined;
  /** Metadata */
  metadata?: Record<string, unknown> | undefined;
}

// ═══════════════════════════════════════════════════════════
// Class Re-exports (implementations of the contract)
// ═══════════════════════════════════════════════════════════

// ── Client ──
export { LiteLLMClient } from './client';

// ── Model subsystem ──
export { ModelPool } from './model-pool';
export {
  ModelRouter,
  NoModelAvailableError,
  detectAvailableProviders,
  isProviderAvailable,
  autoSelectModels,
} from './model-router';
export { ModelConfigManager } from './model-config';

// ── Method subsystem ──
export { MethodRouter } from './methods/method-router';
export { MethodRegistry } from './methods/method-registry';
export { BaseMethod } from './methods/method-interface';

// ── Tool subsystem ──
export { ToolRegistry } from './tools/tool-registry';
export {
  BaseTool,
  createTool,
  objectParam,
  stringParam,
  numberParam,
  enumParam,
} from './tools/tool-interface';
// Memory tools are owned by the memory module (src/memory/litellm-memory-tools.ts)

// ── Config ──
export { loadLitellmConfig } from './config-loader';

// Configure models in config/ directory (one .yaml file per method)
