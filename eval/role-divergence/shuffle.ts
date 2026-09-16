/**
 * shuffle — 实验三的确定性匿名顺序
 *
 * 审者不得知道被审 plan 的作者是谁；25 格的**执行顺序**也不能与角色相关，否则位置
 * 效应会被误读成角色差异。顺序由 `instance_id` 播种的 PRNG 决定，重跑完全可复现。
 * 作者映射**只写进证据**，从不进入 prompt、文件名或工作区。
 */
import type { CorpusRole } from '../../src/memory';

/** FNV-1a 32 位，把种子字符串压成 PRNG 初始状态 */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32：小而稳的确定性 PRNG */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates，随机源由 seed 决定 —— 同 seed 同结果 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const random = mulberry32(hashSeed(seed));
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [output[index], output[swap]] = [output[swap]!, output[index]!];
  }
  return output;
}

export interface ReviewPair {
  reviewer: CorpusRole;
  author: CorpusRole;
}

/**
 * 实验三的全交叉矩阵（审者 × 作者），按种子打乱执行顺序。
 * 每对都被审且只被审一次；作者身份不进 prompt。
 */
export function buildReviewCells(
  instanceId: string,
  roles: readonly CorpusRole[],
): ReviewPair[] {
  const pairs: ReviewPair[] = [];
  for (const reviewer of roles) {
    for (const author of roles) {
      pairs.push({ reviewer, author });
    }
  }
  return seededShuffle(pairs, `role-divergence:${instanceId}`);
}
