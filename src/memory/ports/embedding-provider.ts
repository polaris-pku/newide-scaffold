/**
 * EmbeddingProvider 端口
 *
 * 文本 → 向量嵌入，供经验/技能语义检索使用。
 * 余弦相似度计算请直接使用 utils/vector 中的 cosineSimilarity 函数。
 */
export interface EmbeddingProvider {
  /** 嵌入向量的维度 */
  readonly dimensions: number;

  /** 将文本编码为向量 */
  embed(text: string): Promise<number[]>;
}
