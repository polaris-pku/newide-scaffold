/**
 * 向量工具函数
 *
 * 提供余弦相似度计算等纯数学运算，
 * 供查询/检索模块使用，不属于 EmbeddingProvider 的职责。
 */
import { cosineSimilarity as aiCosineSimilarity } from 'ai';

/**
 * 计算两个向量的余弦相似度。
 * 自动处理维度不匹配：pad 或 truncate 到较长向量的维度。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const maxDim = Math.max(a.length, b.length);
  const left = padOrTruncate(a, maxDim);
  const right = padOrTruncate(b, maxDim);
  return aiCosineSimilarity(left, right);
}

function padOrTruncate(vector: number[], dimensions: number): number[] {
  if (vector.length === dimensions) return vector;
  if (vector.length > dimensions) return vector.slice(0, dimensions);
  return [...vector, ...new Array<number>(dimensions - vector.length).fill(0)];
}
