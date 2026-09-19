/**
 * LiteLLMEmbeddingProvider — 真实 Embedding 实现
 *
 * 委托 LiteLLMClient.embed() 完成向量化。
 * 不再自建 AI SDK model 实例，统一走 LiteLLMClient 的 YAML 配置、模型路由与 provider 注册。
 * 每次 embed 都会调 recordProxyLlmUsage 记一笔用量，否则嵌入花费在产物里完全不可见。
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
import { recordProxyLlmUsage } from '../../telemetry';

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
    // 嵌入的 token 也是真实花费，但此前整条链路上没有任何记账点——实测一次真实 run：
    // 内存检索跑了 6 次、`agent.tool.query_memory` span 有 6 个，而 embed span 0 个、
    // 账本 0 条、summary 里也一条都没有。这里补上。
    //
    // 归属维度（stage_cursor / role_id / agent_id / tool_name / round）由
    // recordProxyLlmUsage 从 ALS 作用域自动补全，所以检索发生在哪个环节就记在哪个
    // 环节，不必在这里传。model 记嵌入模型名，好和非嵌入的调用区分开。
    await recordProxyLlmUsage({
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
      model: resp.model,
      source: 'proxy',
    });
    return resp.embeddings[0]!;
  }
}
