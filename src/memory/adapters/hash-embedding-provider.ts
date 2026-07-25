/**
 * HashEmbeddingProvider — EmbeddingProvider 的确定性 MVP 实现
 *
 * 将文本哈希为固定维度向量，供语义相似度筛选与测试使用。
 * 生产环境可替换为真实模型适配器（OpenAI 等）。
 */
import type { EmbeddingProvider } from '../ports/embedding-provider';

const DEFAULT_DIMENSIONS = 32;

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(dimensions = DEFAULT_DIMENSIONS) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    return textToVector(text, this.dimensions);
  }
}

/** 模块默认实例，供 memory-retrieval 使用 */
export const defaultHashEmbeddingProvider = new HashEmbeddingProvider();

function textToVector(text: string, dimensions: number): number[] {
  const normalized = text.trim().toLowerCase();
  const values = new Array<number>(dimensions).fill(0);

  for (const word of normalized.split(/[^a-z0-9]+/i).filter(Boolean)) {
    let hash = 2166136261;
    for (let index = 0; index < word.length; index += 1) {
      hash ^= word.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = Math.abs(hash) % dimensions;
    values[bucket] = (values[bucket] ?? 0) + 1 + word.length * 0.01;
  }

  return normalizeVector(values);
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}
