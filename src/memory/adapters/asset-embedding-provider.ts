/**
 * AssetEmbeddingProvider — 离线资产驱动的 EmbeddingProvider
 *
 * 供 seed 导入"零依赖"完成落库：dimensions = 预计算资产维度（如 1024）。
 * 导入路径中所有向量已由 skill-import 从资产填充，仓储
 * withDescriptionEmbedding 见 length === dimensions 即原样写入，不会现场算；
 * 因此 embed() 在正常资产模式下不会被调用。
 *
 * embed() 返回零向量仅用于通过 createProductionBRuntime 的 readiness probe
 * （host-injected provider 也会被 verifyEmbeddingReadiness 调一次）。资产模式
 * 下 importSkillCorpus 对缺失/过期条目会直接抛错，故零向量永远不会写入库中。
 */
import type { EmbeddingProvider } from '../ports/embedding-provider';

export class AssetEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  async embed(_text: string): Promise<number[]> {
    return new Array<number>(this.dimensions).fill(0);
  }
}