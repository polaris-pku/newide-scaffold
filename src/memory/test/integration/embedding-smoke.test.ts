/**
 * LiteLLMEmbeddingProvider 基础功能验证
 *
 * 验证项：
 * 1. embed() 能正常返回向量
 * 2. 向量维度正确
 * 3. cosineSimilarity 语义相似度符合预期
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiteLLMClient } from '../../../litellm/contract';
import { LiteLLMEmbeddingProvider } from '../../adapters/litellm-embedding-provider';
import { cosineSimilarity } from '../../utils/vector';

// ──────────────────────────────────────────────
// .env 加载
// ──────────────────────────────────────────────

function loadEnv(): void {
  const envPath = resolve(__dirname, '../../.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv();

// ──────────────────────────────────────────────
// 跳过条件
// ──────────────────────────────────────────────

const hasKey = !!(
  process.env.EMBEDDING_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.DEEPSEEK_API_KEY
);

const suite = hasKey ? describe : describe.skip;

suite('LiteLLMEmbeddingProvider 基础验证', () => {
  const client = new LiteLLMClient().loadConfig();
  const provider = new LiteLLMEmbeddingProvider(client);

  it('embed() 返回正确维度的向量', async () => {
    const input = '你好世界';
    const vector = await provider.embed(input);
    console.log(`\n📝 输入: "${input}"`);
    console.log(`📐 维度: ${vector.length}`);
    console.log(
      `📊 向量(前10维): [${vector
        .slice(0, 10)
        .map((v) => v.toFixed(6))
        .join(', ')}, ...]`,
    );
    console.log(
      `📊 向量(后5维):  [..., ${vector
        .slice(-5)
        .map((v) => v.toFixed(6))
        .join(', ')}]`,
    );
    expect(vector).toBeInstanceOf(Array);
    expect(vector.length).toBe(provider.dimensions);
    expect(vector.every((v) => Number.isFinite(v))).toBe(true);
  }, 30_000);

  it('相同文本的 cosineSimilarity 接近 1', async () => {
    const text = '机器学习是人工智能的子领域';
    const a = await provider.embed(text);
    const b = await provider.embed(text);
    const sim = cosineSimilarity(a, b);
    console.log(`\n📝 输入A: "${text}"`);
    console.log(`📝 输入B: "${text}"`);
    console.log(`📈 cosineSimilarity: ${sim.toFixed(6)}`);
    expect(sim).toBeGreaterThan(0.99);
  }, 30_000);

  it('相似文本的 cosineSimilarity 高于不相关文本', async () => {
    const textA = '今天天气很好';
    const textB = '今天阳光明媚';
    const textC = '量子计算的基本原理';

    const vecA = await provider.embed(textA);
    const vecB = await provider.embed(textB);
    const vecC = await provider.embed(textC);

    const simRelated = cosineSimilarity(vecA, vecB);
    const simUnrelated = cosineSimilarity(vecA, vecC);

    console.log(`\n📝 A: "${textA}"`);
    console.log(`📝 B: "${textB}" (语义相近)`);
    console.log(`📝 C: "${textC}" (语义无关)`);
    console.log(`📈 A↔B cosineSimilarity: ${simRelated.toFixed(6)}`);
    console.log(`📉 A↔C cosineSimilarity: ${simUnrelated.toFixed(6)}`);
    console.log(`✅ 相似 > 无关: ${simRelated > simUnrelated}`);

    expect(simRelated).toBeGreaterThan(simUnrelated);
  }, 60_000);
});
