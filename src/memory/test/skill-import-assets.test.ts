/**
 * skill-import-assets — 预计算向量资产驱动的 skill-import 行为守卫
 *
 * 覆盖「不能自动向量化」的核心约束：提供资产时按 slug 填表并校验 sha256，
 * 命中 → 复用资产向量（embed 不被调用）；缺失 / 过期 → 实际导入抛错、
 * dry-run 只报告不抛错；未提供资产 → 退回现场 embed（由 provider 完成）。
 * 用内存仓储 + 记录调用次数的 provider，证明资产路径下仓储不现场算。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import { importSkillCorpus } from '../seeds/skill-import';
import {
  buildBaselineManifest,
  type SkillEmbeddingsManifest,
} from '../seeds/skill-corpus';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.resolve(HERE, '..', '..', '..', 'skills');

/** 记录 embed 调用次数并返回确定性标记向量的 provider */
class CountingEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  calls = 0;
  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }
  async embed(_text: string): Promise<number[]> {
    this.calls += 1;
    return new Array<number>(this.dimensions).fill(0);
  }
}

/** 确定性标记向量：第 index 位为 1（index < dims），其余 0 */
function markerVector(index: number, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[index % dimensions] = 1;
  return vector;
}

async function buildAsset(): Promise<SkillEmbeddingsManifest> {
  const baseline = await buildBaselineManifest(CORPUS_ROOT);
  return {
    schema: 'newide-skill-embeddings/v1',
    model: 'text-embedding-v3',
    provider: 'openai',
    base_url: 'https://example.invalid/compatible-mode/v1',
    dimensions: 1024,
    created_at: '2026-09-08T00:00:00.000Z',
    embed_input: 'description',
    skills: baseline.skills.map((entry, index) => ({
      slug: entry.slug,
      role: entry.role,
      id: entry.id,
      sha256: entry.sha256,
      vector: markerVector(index, 1024),
    })),
  };
}

describe('skill-import embedding asset path', () => {
  it('资产匹配：全部复用资产向量，embed 一次都不被调用', async () => {
    const asset = await buildAsset();
    const provider = new CountingEmbeddingProvider(asset.dimensions);
    const repository = new InMemoryRepository(provider);
    const report = await importSkillCorpus(repository, {
      rootDir: CORPUS_ROOT,
      embeddings: asset,
    });

    expect(report.embedding_asset).toEqual({
      reuse: 60,
      stale: 0,
      absent: 0,
      stale_slugs: [],
    });
    // 录入途中 embed 未被调用过（即时 initializeAgent 的种子为空，但 save 不该 embed）
    expect(provider.calls).toBe(0);
    // 落库后每条技能向量 = 资产向量（而非现场算）
    const assetById = new Map(asset.skills.map((entry) => [entry.id, entry]));
    for (const roleId of await repository.listAgentIds()) {
      for (const skill of await repository.listSkills(roleId)) {
        expect(skill.description_embedding).toEqual(assetById.get(skill.id)!.vector);
      }
    }
  });

  it('资产 sha256 过期 + 实际导入：抛错，不写入任何记录', async () => {
    const asset = await buildAsset();
    asset.skills[0] = { ...asset.skills[0]!, sha256: 'f'.repeat(64) };
    const provider = new CountingEmbeddingProvider(asset.dimensions);
    const repository = new InMemoryRepository(provider);
    await expect(
      importSkillCorpus(repository, { rootDir: CORPUS_ROOT, embeddings: asset }),
    ).rejects.toThrow(/Re-run `pnpm skills:embed`/);
    expect(await repository.listAgentIds()).toHaveLength(0);
    expect(provider.calls).toBe(0);
  });

  it('资产 sha256 过期 + dry-run：报告将报错条数，不抛错', async () => {
    const asset = await buildAsset();
    asset.skills[1] = { ...asset.skills[1]!, sha256: 'e'.repeat(64) };
    const repository = new InMemoryRepository(new CountingEmbeddingProvider(asset.dimensions));
    const report = await importSkillCorpus(repository, {
      rootDir: CORPUS_ROOT,
      dryRun: true,
      embeddings: asset,
    });
    expect(report.embedding_asset?.reuse).toBe(59);
    expect(report.embedding_asset?.stale).toBe(1);
    expect(report.embedding_asset?.stale_slugs).toHaveLength(1);
  });

  it('未提供资产：退回现场 embed（provider 被调用，向量为 provider 输出）', async () => {
    const provider = new CountingEmbeddingProvider(8);
    const repository = new InMemoryRepository(provider);
    const report = await importSkillCorpus(repository, { rootDir: CORPUS_ROOT });

    expect(report.activity_total).toBe(60);
    expect(report.embedding_asset).toBeUndefined();
    expect(provider.calls).toBeGreaterThan(0);
    // 全部落库技能向量来自 provider（8 维零向量）
    for (const roleId of await repository.listAgentIds()) {
      for (const skill of await repository.listSkills(roleId)) {
        expect(skill.description_embedding).toEqual(new Array<number>(8).fill(0));
      }
    }
  });
});