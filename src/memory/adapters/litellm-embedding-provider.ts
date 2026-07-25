/**
 * LiteLLMEmbeddingProvider — 真实 Embedding 实现
 *
 * 委托 LiteLLMClient.embed() 完成向量化。
 * 不再自建 AI SDK model 实例，统一走 LiteLLMClient 的 YAML 配置、模型路由与 provider 注册。
 *
 * 用法：
 * ```ts
 * const client = new LiteLLMClient().loadConfig();
 * const embedding = new LiteLLMEmbeddingProvider(client);
 * const vector = await embedding.embed('hello world');
 * ```
 */
import type { LiteLLMClient } from '../../litellm/contract';
import type { EmbeddingProvider } from '../ports/embedding-provider';

// ──────────────────────────────────────────────
// 默认配置
// ──────────────────────────────────────────────

const DEFAULT_DIMENSIONS = 1536;

// ──────────────────────────────────────────────
// LiteLLMEmbeddingProvider
// ──────────────────────────────────────────────

export class LiteLLMEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(
    private readonly client: LiteLLMClient,
    dimensions?: number,
  ) {
    this.dimensions = dimensions ?? client.dimensions ?? DEFAULT_DIMENSIONS;
  }

  async embed(text: string): Promise<number[]> {
    const resp = await this.client.embed({ task: 'embed', input: text });
    return resp.embeddings[0]!;
  }
}
